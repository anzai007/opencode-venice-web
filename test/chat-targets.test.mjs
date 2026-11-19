import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  CharacterChatError,
  buildCharacterSystemPrompt,
  clearCharacterCache,
  extractCharacterMeta,
  getCachedCharacter,
  pickCharacterModel,
  setCachedCharacter,
  toCharacterChatRequest,
  toMindChatRequest,
} from '../src/lib/chat-targets.mjs'
import { DEFAULT_MODEL } from '../src/lib/models.mjs'
import { createServer } from '../src/lib/server.mjs'

async function withServer(fn) {
  const server = http.createServer(createServer())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('pickCharacterModel handles explicit free models, aliases, fallbacks, and errors', () => {
  assert.equal(pickCharacterModel('qwen-3-8-27b', 'zai-org-glm-4.6'), 'qwen-3-8-27b')
  assert.equal(pickCharacterModel('deepseek-v4-1-flash-free', null), DEFAULT_MODEL)
  assert.equal(pickCharacterModel('auto', 'zai-org-glm-4.6'), 'zai-org-glm-4.6')
  assert.equal(pickCharacterModel('', 'some-paid-or-unknown-model'), DEFAULT_MODEL)
  assert.equal(pickCharacterModel(undefined, null), DEFAULT_MODEL)
  assert.throws(
    () => pickCharacterModel('not-a-real-model', 'zai-org-glm-4.6'),
    (err) => err instanceof CharacterChatError && err.status === 400 && /unknown model/.test(err.message),
  )
})

test('extractCharacterMeta strips large photo base64 and caches metadata cleanly', () => {
  clearCharacterCache()
  const meta = extractCharacterMeta({
    id: 'char-1',
    name: 'Test Char',
    slug: 'test-char',
    description: 'A clever detective.',
    modelId: 'zai-org-glm-4.6',
    jsonData: {
      photo: 'data:image/png;base64,' + 'A'.repeat(10000),
      intro: 'Hello, detective.',
      instructions: 'Stay sharp.',
      context: [{ fileName: 'notes.txt', text: 'Clue #1' }],
    },
  })
  assert.equal('photo' in meta, false)
  assert.equal(meta.intro, 'Hello, detective.')
  assert.equal(meta.instructions, 'Stay sharp.')
  setCachedCharacter('char-1', meta)
  assert.deepEqual(getCachedCharacter('char-1'), meta)
  clearCharacterCache()
  assert.equal(getCachedCharacter('char-1'), null)
})

test('toCharacterChatRequest injects intro once and keeps assistant history as plain text', () => {
  const charMeta = {
    id: 'char-1',
    name: 'Sable',
    slug: 'sable',
    description: 'Helpful neighbor.',
    modelId: 'paid-model-x',
    instructions: 'Speak warmly.',
    intro: 'Hey there, need help moving in?',
    context: [{ fileName: 'bio.txt', text: 'Lives next door.' }],
  }

  const prompt = buildCharacterSystemPrompt(charMeta, ['Extra rule'])
  assert.match(prompt, /You are roleplaying as Sable/)
  assert.match(prompt, /Speak warmly\./)
  assert.match(prompt, /\[Context: bio\.txt\]/)
  assert.match(prompt, /Extra rule/)

  // First turn without assistant history injects intro once
  const first = toCharacterChatRequest(charMeta, {
    messages: [{ role: 'user', content: 'Hi Sable!' }],
  })
  assert.equal(first.modelId, DEFAULT_MODEL)
  assert.equal(first.request.messages.length, 2)
  assert.equal(first.request.messages[0].role, 'assistant')
  assert.equal(first.request.messages[0].content[0].text, 'Hey there, need help moving in?')
  assert.equal(first.request.messages[1].role, 'user')

  // Multi-turn with existing assistant message does NOT duplicate intro and does NOT wrap in envelope JSON
  const second = toCharacterChatRequest(charMeta, {
    model: 'zai-org-glm-4.6',
    messages: [
      { role: 'assistant', content: 'Custom opening' },
      { role: 'user', content: 'Where is the coffee shop?' },
    ],
  })
  assert.equal(second.modelId, 'zai-org-glm-4.6')
  assert.equal(second.request.messages.length, 2)
  assert.equal(second.request.messages[0].content[0].text, 'Custom opening')

  // include_intro: false suppresses intro injection
  const noIntro = toCharacterChatRequest(charMeta, {
    include_intro: false,
    messages: [{ role: 'user', content: 'Just answer directly.' }],
  })
  assert.equal(noIntro.request.messages.length, 1)
  assert.equal(noIntro.request.messages[0].role, 'user')
})

test('toMindChatRequest builds remoteMind payload with system prompt prepended and response id', () => {
  const mapped = toMindChatRequest('chef-s-razor-1107', {
    previous_response_id: 'resp_123',
    previous_output_index: 1,
    messages: [
      { role: 'system', content: 'Answer in Chinese.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up' },
    ],
  })
  assert.equal(mapped.route, '/api/inference/chat/agents/chef-s-razor-1107')
  assert.equal(mapped.request.previousResponseId, 'resp_123')
  assert.equal(mapped.request.previousOutputIndex, 1)
  assert.equal(mapped.request.messages.length, 3)
  assert.match(mapped.request.messages[0].content[0].text, /^\[Additional instructions\]\nAnswer in Chinese\./)
  assert.equal(mapped.request.messages[1].content[0].text, 'First answer')
  assert.equal(mapped.request.messages[2].content[0].text, 'Follow-up')
})

test('HTTP validation on /v1/characters/:id/chat and /v1/minds/:slug/chat + UI chat panels', async () => {
  await withServer(async (base) => {
    const badMind = await fetch(`${base}/v1/minds/chef-s-razor-1107/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    assert.equal(badMind.status, 400)
    const badMindJson = await badMind.json()
    assert.match(badMindJson.error.message, /messages must not be empty/)

    setCachedCharacter('cached-char-test', {
      id: 'cached-char-test',
      name: 'Cached',
      slug: 'cached',
      description: '',
      modelId: null,
      instructions: 'Be concise.',
      intro: 'Hello!',
      context: [],
    })
    const badModel = await fetch(`${base}/v1/characters/cached-char-test/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'invalid-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(badModel.status, 400)
    const badModelJson = await badModel.json()
    assert.match(badModelJson.error.message, /unknown model/)
    clearCharacterCache()

    const charHtml = await (await fetch(`${base}/characters.html`)).text()
    assert.match(charHtml, /与角色对话测试/)
    const mindHtml = await (await fetch(`${base}/minds.html`)).text()
    assert.match(mindHtml, /与 Mind 对话测试/)
  })
})
