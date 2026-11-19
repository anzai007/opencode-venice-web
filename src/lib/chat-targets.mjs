/**
 * Request builders and lightweight metadata cache for Character Chat and Mind Chat.
 *
 * Unlike OpenCode's `toVeniceRequest()`, Character and Mind conversations send
 * plain `output_text` assistant turns instead of JSON tool-call envelopes.
 */
import { randomUUID } from 'node:crypto'
import { reasoningMode, splitImages, textOf, withImagesLast } from './emulate.mjs'
import { DEFAULT_MODEL, MODELS, resolveModelId } from './models.mjs'

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 200
const characterCache = new Map()

/** Client input error for Character / Mind chat requests (HTTP 400 by default). */
export class CharacterChatError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'CharacterChatError'
    this.status = status
  }
}

/** Extracts lightweight prompt fields from a character detail payload (strips photo base64). */
export function extractCharacterMeta(detail) {
  const jd = detail?.jsonData && typeof detail.jsonData === 'object' ? detail.jsonData : {}
  return {
    id: detail?.id ?? jd.id ?? '',
    name: detail?.name ?? jd.name ?? '',
    slug: detail?.slug ?? '',
    description: detail?.description ?? jd.description ?? '',
    modelId: detail?.modelId ?? jd.textSettings?.model?.id ?? null,
    instructions: jd.instructions ?? '',
    intro: jd.intro ?? detail?.intro ?? '',
    customSystemPrompt: jd.customSystemPrompt ?? '',
    useCustomSystemPrompt: Boolean(jd.useCustomSystemPrompt),
    overrideSystemPrompts: Boolean(jd.overrideSystemPrompts),
    context: Array.isArray(jd.context) ? jd.context : [],
    textSettings: jd.textSettings ?? null,
  }
}

/** Reads cached character metadata if present and not expired. */
export function getCachedCharacter(id) {
  const entry = characterCache.get(id)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    characterCache.delete(id)
    return null
  }
  return entry.meta
}

/** Caches lightweight character metadata with bounded size and 5-minute TTL. */
export function setCachedCharacter(id, meta) {
  if (!id || !meta) return
  if (characterCache.has(id)) characterCache.delete(id)
  while (characterCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = characterCache.keys().next().value
    if (oldest === undefined) break
    characterCache.delete(oldest)
  }
  characterCache.set(id, { meta, expires: Date.now() + CACHE_TTL_MS })
}

/** Clears the in-memory character metadata cache (used on `/reload`). */
export function clearCharacterCache() {
  characterCache.clear()
}

/**
 * Resolves the free web model for a character chat turn. Explicit non-empty
 * requests must match a known free model; otherwise falls back to the
 * character's model only if free, or `DEFAULT_MODEL`.
 */
export function pickCharacterModel(requestedModel, characterModelId) {
  const req = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  if (req && req !== 'auto' && req !== 'default') {
    const resolved = resolveModelId(req)
    if (!Object.hasOwn(MODELS, resolved)) {
      throw new CharacterChatError(`unknown model: ${requestedModel}. Known: ${Object.keys(MODELS).join(', ')}`, 400)
    }
    return resolved
  }
  if (typeof characterModelId === 'string' && characterModelId.trim()) {
    const resolved = resolveModelId(characterModelId.trim())
    if (Object.hasOwn(MODELS, resolved)) return resolved
  }
  return DEFAULT_MODEL
}

/** Assembles the character's system instructions from its profile, context, and caller additions. */
export function buildCharacterSystemPrompt(character, extraInstructions = []) {
  const parts = []
  if (character.useCustomSystemPrompt && typeof character.customSystemPrompt === 'string' && character.customSystemPrompt.trim()) {
    parts.push(character.customSystemPrompt.trim())
  }
  if (!character.overrideSystemPrompts && character.name) {
    parts.push(`You are roleplaying as ${character.name}. Stay in character.`)
  }
  const instructions = typeof character.instructions === 'string' ? character.instructions.trim() : ''
  const description = typeof character.description === 'string' ? character.description.trim() : ''
  if (description && !instructions.includes(description)) {
    parts.push(`Character description:\n${description}`)
  }
  if (instructions) {
    parts.push(instructions)
  }
  if (Array.isArray(character.context) && character.context.length) {
    const snippets = character.context
      .map((item) => {
        const body = String(item?.text ?? item?.parsedText ?? '').trim()
        if (!body) return ''
        return item?.fileName ? `[Context: ${item.fileName}]\n${body}` : body
      })
      .filter(Boolean)
    if (snippets.length) parts.push(snippets.join('\n\n'))
  }
  for (const extra of extraInstructions) {
    const text = typeof extra === 'string' ? extra.trim() : ''
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * Converts OpenAI-shaped messages into plain Venice Responses messages (no JSON
 * envelope wrapping on assistant turns).
 */
export function buildPlainVeniceMessages(rawMessages, { includeSystemInFirstUser = false, intro = '' } = {}) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new CharacterChatError('messages must not be empty', 400)
  }

  const systemTexts = []
  const messages = []
  const newestUser = rawMessages.findLastIndex((message) => message?.role === 'user')
  let images = []

  for (const [index, message] of rawMessages.entries()) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') {
      const sysText = textOf(message.content).trim()
      if (sysText) systemTexts.push(sysText)
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue

    let text = textOf(message.content)
    let userImages = []
    if (index === newestUser) {
      ;({ images: userImages, text } = splitImages(message.content))
      images = userImages
    }

    const parts = [{ type: 'output_text', text, annotations: [] }]
    if (index === newestUser && userImages.length) {
      parts.unshift(...userImages.map((image) => ({ type: 'input_image', media_id: image.mediaId, detail: 'auto' })))
    }
    messages.push({
      id: randomUUID(),
      type: 'message',
      status: 'completed',
      role: message.role,
      content: parts,
    })
  }

  if (!messages.some((message) => message.role === 'user')) {
    throw new CharacterChatError('at least one user message is required', 400)
  }

  if (includeSystemInFirstUser && systemTexts.length) {
    const firstUser = messages.find((message) => message.role === 'user')
    const textPart = firstUser?.content?.find((part) => part.type === 'output_text')
    if (textPart) {
      const prefix = `[Additional instructions]\n${systemTexts.join('\n\n')}\n\n`
      textPart.text = prefix + textPart.text
    }
  }

  if (intro && !messages.some((message) => message.role === 'assistant')) {
    messages.unshift({
      id: randomUUID(),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: intro, annotations: [] }],
    })
  }

  return { messages: withImagesLast(messages), systemTexts, images }
}

/** Builds an upstream `/api/inference/chat/agents/ad-hoc` payload for a Character conversation. */
export function toCharacterChatRequest(character, body = {}) {
  const modelId = pickCharacterModel(body.model, character.modelId || character.textSettings?.model?.id)
  const intro = body.include_intro === false ? '' : (character.intro || '')
  const { messages, systemTexts, images } = buildPlainVeniceMessages(body.messages, {
    includeSystemInFirstUser: false,
    intro,
  })
  const extra = [...systemTexts]
  if (typeof body.system_prompt === 'string' && body.system_prompt.trim()) {
    extra.push(body.system_prompt.trim())
  }
  const instructions = buildCharacterSystemPrompt(character, extra)

  return {
    modelId,
    request: {
      modelId,
      systemPrompt: { instructions },
      messages,
      tools: [],
      clientTools: [],
      ...reasoningMode(body),
    },
    images,
  }
}

/** Builds an upstream `/api/inference/chat/agents/:slug` payload for a remote Mind conversation. */
export function toMindChatRequest(slug, body = {}) {
  if (!slug || typeof slug !== 'string') {
    throw new CharacterChatError('mind slug is required', 400)
  }
  const { messages, images } = buildPlainVeniceMessages(body.messages, {
    includeSystemInFirstUser: true,
  })
  const request = {
    messages,
    clientTools: [],
  }
  if (typeof body.previous_response_id === 'string' && body.previous_response_id.trim()) {
    request.previousResponseId = body.previous_response_id.trim()
  }
  if (Number.isInteger(body.previous_output_index)) {
    request.previousOutputIndex = body.previous_output_index
  }
  return {
    route: `/api/inference/chat/agents/${encodeURIComponent(slug)}`,
    request,
    images,
  }
}
