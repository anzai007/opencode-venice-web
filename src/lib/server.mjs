/**
 * OpenAI 兼容 HTTP 层：聊天、模型目录、健康检查与图片接口。
 * 推理及普通正文直接转发；工具协议只有先确认最终状态和空工具列表，才增量解码正文。
 * 工具调用、旧格式及修复重试保持完整缓冲与参数校验，SSE 心跳覆盖静默等待。
 */
import { randomUUID } from 'node:crypto'
import { envelopeContentStream, remainingContent } from './envelope-stream.mjs'
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiBase, apiKey, debug, dumpFile, host, judgeEnabled, judgeModel, judgeTimeoutMs, port, providerID } from './config.mjs'
import {
  applyFallback,
  buildJudgeRequest,
  countTokens,
  inspectCalls,
  judgeDecision,
  parseJudgeVerdict,
  parseToolReply,
  preferAnswer,
  serverLoopMessage,
  shouldRetry,
  MAX_IMAGES,
  imageFromBytes,
  imageFromDataUrl,
  sseReader,
  toVeniceRequest,
  withRetryReminder,
} from './emulate.mjs'
import { MODELS } from './models.mjs'
import { debugRaw, log, preview, warn } from './log.mjs'
import { deepStripNulls, repairJsonControlChars } from './sanitize.mjs'
import {
  AGENT_IMAGE_PATH,
  INFERENCE_PATH,
  SignInError,
  fetchCharacterDetail,
  fetchCharacterPhoto,
  fetchCharacters,
  fetchFavoriteMinds,
  fetchFeaturedMinds,
  fetchMindAvatar,
  fetchMindCover,
  fetchMindDetail,
  fetchMindsSearch,
  fetchMyCharacters,
  fetchMyMinds,
  loadSession,
  resetSessionCache,
  transportFor,
  upstreamChat,
} from './venice.mjs'
import {
  ImageRequestError,
  agentRequest,
  editInstruction,
  generationInstruction,
  imageCollector,
  imagesResponse,
  parseCount,
  parseResponseFormat,
  parseSize,
  pickEditModel,
  pickImageModel,
  seedsFor,
} from './imagegen.mjs'

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-api-key',
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CHARACTERS_HTML_PATH = path.join(ROOT_DIR, 'characters.html')
const MINDS_HTML_PATH = path.join(ROOT_DIR, 'minds.html')
const API_DOCS_PATH = path.join(ROOT_DIR, 'docs/API.md')

/** Optional API key enforcement when `VENICE_API_KEY` is configured. */
function isAuthorized(req, url) {
  if (!apiKey) return true
  const auth = req.headers.authorization
  if (auth === `Bearer ${apiKey}`) return true
  if (req.headers['x-api-key'] === apiKey) return true
  if (url.searchParams.get('api_key') === apiKey) return true
  return false
}

/** Renders the API Markdown document into a self-contained dark-mode HTML viewer. */
function renderDocsHtml(markdown) {
  const safeJson = JSON.stringify(markdown).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Venice Web Proxy · 外部接口协议文档</title>
  <style>
    :root {
      --bg: #0d0f14;
      --surface: #151922;
      --surface-2: #1d222e;
      --border: #2a3142;
      --text: #e6eaf2;
      --muted: #8b95ab;
      --accent: #6366f1;
      --accent-hover: #7c7ff6;
      --code-bg: #0a0c10;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.68;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      background: rgba(13, 15, 20, 0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    .nav-links { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); background: #232938; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover { background: var(--accent-hover); }
    main {
      max-width: 980px;
      margin: 28px auto 64px;
      padding: 0 24px;
    }
    article {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px 34px;
    }
    article h1 { font-size: 26px; margin: 0 0 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    article h2 { font-size: 20px; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); color: #c7d2fe; }
    article h3 { font-size: 16px; margin: 22px 0 8px; color: #e2e8f0; }
    article h4 { font-size: 14px; margin: 16px 0 6px; color: #cbd5e1; }
    article p { margin: 10px 0; color: #d5dce9; }
    article ul, article ol { margin: 8px 0 12px; padding-left: 22px; }
    article li { margin: 4px 0; color: #d5dce9; }
    article a { color: #818cf8; text-decoration: none; }
    article a:hover { text-decoration: underline; }
    article hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
    article blockquote {
      margin: 12px 0;
      padding: 10px 14px;
      background: rgba(99, 102, 241, 0.08);
      border-left: 3px solid var(--accent);
      border-radius: 6px;
      color: #cbd5e1;
    }
    article code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.88em;
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 5px;
      color: #a5b4fc;
    }
    .code-wrap { position: relative; margin: 12px 0; }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      font-size: 11px;
      padding: 3px 8px;
      background: var(--surface-2);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
    }
    .copy-btn:hover { color: var(--text); border-color: var(--accent); }
    article pre {
      margin: 0;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      line-height: 1.55;
      color: #d6deeb;
    }
    article pre code { background: none; border: 0; padding: 0; color: inherit; font-size: inherit; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 13px;
      display: block;
      overflow-x: auto;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
      vertical-align: top;
    }
    th { background: var(--surface-2); color: #c7d2fe; font-weight: 600; white-space: nowrap; }
    @media (max-width: 640px) {
      article { padding: 18px 16px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Venice Web Proxy · 外部接口协议文档</h1>
    <div class="nav-links">
      <a class="btn primary" href="/docs/api.md" target="_blank">原始 Markdown (/docs/api.md)</a>
      <a class="btn" href="/docs/api.md?download=1">下载 .md</a>
      <a class="btn" href="/characters.html">角色浏览器</a>
      <a class="btn" href="/minds.html">Minds 浏览器</a>
    </div>
  </header>
  <main><article id="content"></article></main>
  <script>
    const MD = ${safeJson};
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function inlineFmt(s) {
      let out = esc(s);
      const codes = [];
      out = out.replace(/\`([^\`]+)\`/g, (_, c) => { codes.push('<code>' + c + '</code>'); return '\\x00C' + (codes.length - 1) + '\\x00'; });
      out = out.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+|\\\/[^)\\s]*)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      out = out.replace(/\\x00C(\\d+)\\x00/g, (_, i) => codes[Number(i)]);
      return out;
    }
    function renderMd(md) {
      const lines = md.replace(/\\r\\n/g, '\\n').split('\\n');
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith('\`\`\`')) {
          const lang = esc(line.slice(3).trim());
          const buf = [];
          i++;
          while (i < lines.length && !lines[i].startsWith('\`\`\`')) { buf.push(lines[i]); i++; }
          i++;
          out.push('<div class="code-wrap"><button class="copy-btn" onclick="copyCode(this)">复制</button><pre><code class="lang-' + lang + '">' + esc(buf.join('\\n')) + '</code></pre></div>');
          continue;
        }
        if (/^---+$/.test(line.trim())) { out.push('<hr/>'); i++; continue; }
        const h = /^(#{1,4})\\s+(.*)$/.exec(line);
        if (h) { const lvl = h[1].length; out.push('<h' + lvl + '>' + inlineFmt(h[2]) + '</h' + lvl + '>'); i++; continue; }
        if (line.startsWith('>')) {
          const buf = [];
          while (i < lines.length && lines[i].startsWith('>')) { buf.push(lines[i].replace(/^>\\s?/, '')); i++; }
          out.push('<blockquote>' + buf.map(inlineFmt).join('<br/>') + '</blockquote>');
          continue;
        }
        if (line.includes('|') && i + 1 < lines.length && /^\\s*\\|?[\\s:|-]+\\|\\s*$/.test(lines[i + 1])) {
          const splitRow = (r) => r.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(c => c.trim());
          const headers = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
          out.push('<table><thead><tr>' + headers.map(c => '<th>' + inlineFmt(c) + '</th>').join('') + '</tr></thead><tbody>' +
            rows.map(r => '<tr>' + r.map(c => '<td>' + inlineFmt(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
          continue;
        }
        if (/^\\s*[*+-]\\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\\s*[*+-]\\s+/.test(lines[i])) { items.push('<li>' + inlineFmt(lines[i].replace(/^\\s*[*+-]\\s+/, '')) + '</li>'); i++; }
          out.push('<ul>' + items.join('') + '</ul>');
          continue;
        }
        if (/^\\s*\\d+\\.\\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) { items.push('<li>' + inlineFmt(lines[i].replace(/^\\s*\\d+\\.\\s+/, '')) + '</li>'); i++; }
          out.push('<ol>' + items.join('') + '</ol>');
          continue;
        }
        if (line.trim() === '') { i++; continue; }
        const p = [];
        while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('\`\`\`') && !/^(#{1,4})\\s+/.test(lines[i]) && !/^---+$/.test(lines[i].trim()) && !lines[i].startsWith('>') && !/^\\s*[*+-]\\s+/.test(lines[i]) && !/^\\s*\\d+\\.\\s+/.test(lines[i])) {
          p.push(lines[i]);
          i++;
        }
        out.push('<p>' + p.map(inlineFmt).join('<br/>') + '</p>');
      }
      return out.join('\\n');
    }
    function copyCode(btn) {
      const code = btn.nextElementSibling.innerText;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      });
    }
    document.getElementById('content').innerHTML = renderMd(MD);
  </script>
</body>
</html>`
}

const json = (res, status, payload) => {
  res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
const openaiError = (res, status, message, type = 'venice_web_error') =>
  json(res, status, { error: { message, type } })

/** Forwards an upstream JSON (or error) response directly to the local client. */
async function proxyJsonUpstream(res, upstream) {
  const body = await upstream.text()
  res.writeHead(upstream.status, {
    ...CORS_HEADERS,
    'content-type': upstream.headers.get('content-type') || 'application/json',
  })
  res.end(body)
}

/** Handles GET /v1/characters* and /v1/characters/:id/photo routes. */
async function handleCharacters(req, res, url) {
  const pathname = url.pathname
  if (pathname === '/v1/characters' || pathname === '/characters') {
    const query = Object.fromEntries(url.searchParams.entries())
    const upstream = await fetchCharacters(query)
    return await proxyJsonUpstream(res, upstream)
  }
  if (pathname === '/v1/characters/me' || pathname === '/characters/me') {
    const upstream = await fetchMyCharacters()
    return await proxyJsonUpstream(res, upstream)
  }
  const photoMatch = pathname.match(/^\/(?:v1\/)?characters\/([^/]+)\/photo$/)
  if (photoMatch) {
    const id = decodeURIComponent(photoMatch[1])
    const upstream = await fetchCharacterPhoto(id)
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      ...CORS_HEADERS,
      'content-type': upstream.headers.get('content-type') || 'image/png',
      'cache-control': 'public, max-age=3600',
    })
    return res.end(buf)
  }
  const detailMatch = pathname.match(/^\/(?:v1\/)?characters\/([^/]+)$/)
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1])
    const includeJsonData = url.searchParams.get('includeJsonData') !== 'false'
    const upstream = await fetchCharacterDetail(id, { includeJsonData })
    return await proxyJsonUpstream(res, upstream)
  }
  return false
}

/** Handles GET /v1/minds* routes. */
async function handleMinds(req, res, url) {
  const pathname = url.pathname
  if (pathname === '/v1/minds/featured' || pathname === '/minds/featured') {
    const upstream = await fetchFeaturedMinds()
    return await proxyJsonUpstream(res, upstream)
  }
  if (pathname === '/v1/minds/me' || pathname === '/minds/me') {
    const query = Object.fromEntries(url.searchParams.entries())
    const upstream = await fetchMyMinds(query)
    return await proxyJsonUpstream(res, upstream)
  }
  if (pathname === '/v1/minds/favorites' || pathname === '/minds/favorites') {
    const query = Object.fromEntries(url.searchParams.entries())
    const upstream = await fetchFavoriteMinds(query)
    return await proxyJsonUpstream(res, upstream)
  }
  if (pathname === '/v1/minds/search' || pathname === '/minds/search') {
    const query = Object.fromEntries(url.searchParams.entries())
    const upstream = await fetchMindsSearch(query)
    return await proxyJsonUpstream(res, upstream)
  }
  if (pathname === '/v1/minds' || pathname === '/minds') {
    const query = Object.fromEntries(url.searchParams.entries())
    const upstream = await fetchMindsSearch(query)
    return await proxyJsonUpstream(res, upstream)
  }
  const avatarMatch = pathname.match(/^\/(?:v1\/)?minds\/([^/]+)\/avatar$/)
  if (avatarMatch) {
    const slug = decodeURIComponent(avatarMatch[1])
    const hash = url.searchParams.get('h')
    const upstream = await fetchMindAvatar(slug, hash)
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      ...CORS_HEADERS,
      'content-type': upstream.headers.get('content-type') || 'image/webp',
      'cache-control': 'public, max-age=3600',
    })
    return res.end(buf)
  }
  const coverMatch = pathname.match(/^\/(?:v1\/)?minds\/([^/]+)\/cover$/)
  if (coverMatch) {
    const slug = decodeURIComponent(coverMatch[1])
    const hash = url.searchParams.get('h')
    const upstream = await fetchMindCover(slug, hash)
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      ...CORS_HEADERS,
      'content-type': upstream.headers.get('content-type') || 'image/webp',
      'cache-control': 'public, max-age=3600',
    })
    return res.end(buf)
  }
  const detailMatch = pathname.match(/^\/(?:v1\/)?minds\/([^/]+)$/)
  if (detailMatch) {
    const slug = decodeURIComponent(detailMatch[1])
    const upstream = await fetchMindDetail(slug)
    return await proxyJsonUpstream(res, upstream)
  }
  return false
}

/** Largest request body the image routes accept. */
const MAX_IMAGE_BODY = 64 * 1024 * 1024

/** The whole request body, or a 413-shaped error past `limit` bytes. */
async function readRaw(req, limit = Infinity) {
  if (req.readableEnded && req.body !== undefined) {
    const buf = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    if (buf.length > limit) {
      const error = new ImageRequestError(`request body is larger than ${Math.round(limit / 1024 / 1024)} MB`)
      error.status = 413
      throw error
    }
    return buf
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new ImageRequestError(`request body is larger than ${Math.round(limit / 1024 / 1024)} MB`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parseJsonText(raw) {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    // JSON forbids raw control characters inside strings; some clients send a
    // literal 0x00 byte anyway, which makes JSON.parse throw.
    const repaired = repairJsonControlChars(raw)
    if (repaired === raw) throw error
    return JSON.parse(repaired)
  }
}

async function readJson(req) {
  return parseJsonText((await readRaw(req)).toString('utf8'))
}

/** Model catalog in OpenAI shape. */
function modelList() {
  return {
    object: 'list',
    data: Object.entries(MODELS).map(([id, model]) => ({
      id,
      object: 'model',
      owned_by: providerID,
      name: model.name,
      context_length: model.context,
    })),
  }
}

/**
 * 读取上游 SSE 并收集完整状态；streamContent 开启时提前输出协议中已确认的最终正文。
 * 推理始终实时转发。stopServerLoop 在上游原生工具循环超限时停止读取，以便外层修复重试。
 */
export async function* collectStream(upstreamBody, mapping, chunk, { stopServerLoop = false, streamContent = false } = {}) {
  const reader = upstreamBody.getReader()
  const stream = sseReader()
  const state = {
    text: '',
    answer: '',
    reasoning: '',
    terminal: false,
    chunks: [],
    steps: new Set(),
    nativeTools: new Set(),
    serverLoop: false,
    events: {},
    liveContent: '',
  }
  const itemTypes = new Map()
  const contentReader = streamContent && mapping.emulatedTools ? envelopeContentStream() : null

  const apply = (event) => {
    if (event.type === 'error' || event.type === 'response.failed') {
      throw new Error(event.message ?? event.response?.error?.message ?? 'Venice generation failed')
    }
    if (event.type === 'response.output_item.added' && event.item?.type) {
      itemTypes.set(event.output_index, event.item.type)
    }
    // Venice runs its own agent loop inside one response. When the model calls a
    // tool natively instead of through the envelope, Venice tries to run it
    // itself, answers "Tool not found" and lets the model go again - up to ten
    // steps - and none of that reaches the client. After a few rounds the model
    // is convinced its tools are broken and gives up without a result (the
    // "done, but no answer until I ask again" sessions, 2026-11-05). Each step is
    // one `veniceai:tool_call_generation` item; the names it tried are in
    // `detected_tools`.
    if (debug) {
      state.events[event.type] = (state.events[event.type] ?? 0) + 1
      if (event.type === 'response.output_item.done' && /server_function_call/.test(event.item?.type ?? '')) {
        debugRaw(`${mapping.request.modelId} server item ${event.item.type}`, JSON.stringify(event.item).slice(0, 2000))
      }
    }
    if (event.type === 'veniceai:tool_call_generation.in_progress') {
      for (const tool of event.detected_tools ?? []) if (tool?.name) state.nativeTools.add(tool.name)
    }
    if (event.item?.type === 'veniceai:tool_call_generation' && event.item.id) {
      state.steps.add(event.item.id)
      if (stopServerLoop && mapping.emulatedTools && state.steps.size > SERVER_LOOP_STEPS) {
        state.serverLoop = true
        state.terminal = true
        return STOP
      }
    }
    if (event.type === 'response.output_text.delta') {
      const delta = event.delta ?? ''
      if (itemTypes.get(event.output_index) === 'reasoning') {
        state.reasoning += delta
        return chunk({ reasoning_content: delta })
      }
      if (mapping.emulatedTools) {
        state.text += delta
        const visible = contentReader?.feed(delta)
        if (visible) {
          state.liveContent += visible
          return chunk({ content: visible })
        }
      }
      else {
        state.answer += delta
        return chunk({ content: delta })
      }
    }
    if (/^response\.(reasoning_text|reasoning_summary_text)\.delta$/.test(event.type)) {
      state.reasoning += event.delta ?? ''
      return chunk({ reasoning_content: event.delta ?? '' })
    }
    if (event.type === 'response.completed') state.terminal = true
    if (event.type === 'response.incomplete') throw new Error('Venice generation was incomplete')
    return null
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      let stop = false
      for (const event of stream.feed(value, done)) {
        const live = apply(event)
        if (live === STOP) {
          stop = true
          break
        }
        if (live) yield live
      }
      if (done || stop) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return state
}

/** Returned by `apply()` to end the stream early. */
const STOP = Symbol('stop')

/**
 * Venice agent steps allowed in one response before the proxy stops it. One
 * step is a normal reply; a second or third is the model recovering from one
 * native call; past that it is looping on "Tool not found" (measured: every
 * 10-step response gave up without a result).
 */
const SERVER_LOOP_STEPS = 3

/**
 * Asks the judge whether a reply without tool calls may end the turn. Any
 * failure (network, timeout, an unreadable verdict) returns `null`, which keeps
 * the reply: the judge can only add a retry, never block an answer.
 */
async function askJudge(body, message, signal) {
  const model = judgeModel || body.model
  const timeout = AbortSignal.timeout(judgeTimeoutMs)
  try {
    const response = await upstreamChat(
      buildJudgeRequest(body, message, model),
      INFERENCE_PATH,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    )
    if (!response.ok) {
      await response.body?.cancel()
      warn(`  ~ judge: HTTP ${response.status}, keeping the reply`)
      return null
    }
    const collected = collectStream(response.body, { emulatedTools: true }, () => null)
    let step
    do step = await collected.next()
    while (!step.done)
    const verdict = parseJudgeVerdict(step.value.text)
    if (!verdict) warn(`  ~ judge: unreadable verdict ${preview(step.value.text, 80)}, keeping the reply`)
    return verdict
  } catch (error) {
    warn('  ~ judge failed, keeping the reply:', error.message)
    return null
  }
}

/**
 * Yields OpenAI chunks for one request.
 *
 * Reliability: an empty reply, prose instead of the envelope, an envelope that
 * cannot be read, a tool call the agent cannot execute, `status: continue`
 * without a tool call, and a turn the judge says ended too early all get another
 * upstream attempt (free on the web plan). `preferAnswer()` decides whether the
 * retry replaces the first answer, so a retry can never blank out a good reply.
 */
export async function* openaiChunks(body, mapping, upstreamBody, signal) {
  const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null, extra = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })

  yield chunk({ role: 'assistant', content: '' })

  // 显式要求调用工具时不能提前提交无工具答案，仍需保留原有重试机会。
  const requiresTool = body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object')
  let state = yield* collectStream(upstreamBody, mapping, chunk, { stopServerLoop: mapping.emulatedTools, streamContent: body.stream === true && !requiresTool })
  const sentContent = state.liveContent
  let message = null

  if (mapping.emulatedTools) {
    const available = [...mapping.toolNames]
    let attempt = 0
    const read = (text, collected) => {
      // every attempt, not only the one that is kept: discarded retries are where
      // the odd replies hide
      debugRaw(
        `${body.model} attempt ${++attempt} • ${collected.steps.size} venice step(s)` +
          `${collected.nativeTools.size ? ` • native calls ${[...collected.nativeTools].join(',')}` : ''}` +
          `${collected.serverLoop ? ' • stopped' : ''} • ${JSON.stringify(collected.events)}`,
        text,
      )
      if (collected.serverLoop) {
        log(`  ~ venice tool loop stopped after ${collected.steps.size} steps (native calls: ${[...collected.nativeTools].join(', ') || '?'})`)
        return serverLoopMessage()
      }
      const parsed = parseToolReply(text)
      for (const rename of inspectCalls(parsed, mapping.toolSchemas)) log(`  ~ tool name ${rename}`)
      return parsed
    }
    message = read(state.text, state)
    const last = [...(body.messages ?? [])].reverse().find((item) => item.role !== 'system' && item.role !== 'developer')
    let judged = 0
    let formatRetries = 0

    // Up to two extra attempts while the reply is unhelpful. Every trigger is
    // structural (see shouldRetry); a reply that ends the turn right after a tool
    // result is checked by the judge instead. The two budgets are separate: when
    // they were shared, two format retries used everything up and the answer the
    // last retry produced reached the user without the judge ever seeing it
    // (a made-up "the tools all returned Tool not found", 2026-11-05).
    for (;;) {
      // 已展示的合法最终回答不再交给评判器替换，避免用户看到重试答案和重复正文。
      // 工具轮次、空回答及破损协议仍沿用原有修复流程，重试结果保持缓冲直到校验完成。
      if (sentContent && !message.tool_calls && !message.brokenEnvelope && !message.serverLoop && ['done', 'ask'].includes(message.status)) break
      let decision = shouldRetry({ message, lastRole: last?.role, available })
      if (decision.judge) {
        if (!judgeEnabled || judged >= 2) break
        judged++
        const verdict = await askJudge(body, message, signal)
        if (verdict) log(`  ~ judge: ${verdict.verdict}${verdict.reason ? ` (${preview(verdict.reason, 100)})` : ''}`)
        decision = judgeDecision(verdict?.verdict)
      }
      if (!decision.retry) break
      if (!decision.reason.startsWith('judge:') && formatRetries++ >= 2) break

      log(`  ~ ${decision.reason}, retrying...`)
      try {
        // the retry resends the same image parts, so their bytes go along again
        const retryResponse = await upstreamChat(withRetryReminder(mapping.request, decision.reminder), INFERENCE_PATH, signal, mapping.images)
        if (!retryResponse.ok) break
        // the last allowed retry runs to the end, so the turn always gets an answer
        const retryState = yield* collectStream(retryResponse.body, mapping, chunk, {
          stopServerLoop: formatRetries < 2,
        })
        const retryMessage = read(retryState.text, retryState)
        if (preferAnswer(retryMessage, message, { replaceAnswer: decision.replaceAnswer })) {
          state = retryState
          message = retryMessage
          log('  ~ retry improved the reply')
        } else {
          log('  ~ retry did not improve the reply, keeping the first')
          if (decision.reason.startsWith('judge:')) break
        }
      } catch (error) {
        warn('  ~ retry failed:', error.message)
        break
      }
    }

    // Never forward a blank assistant turn: it is invisible in the client.
    applyFallback(message, state.text)
  }

  if (!state.terminal) throw new Error('the Venice stream ended before response.completed')
  for (const buffered of state.chunks) yield buffered

  let finish = 'stop'
  let contentForUsage = state.answer

  if (mapping.emulatedTools) {
    contentForUsage = message.content ?? ''
    const tail = remainingContent(contentForUsage, sentContent)
    if (tail) yield chunk({ content: tail })
    if (message.tool_calls) {
      finish = 'tool_calls'
      log(`  <- tools: ${message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments.slice(0, 80)})`).join(' | ')}`)
      yield chunk({
        tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
      })
    } else {
      log(`  <- no tools${message.status ? ` • status ${message.status}` : ''} • text: ${preview(message.content ?? '', 110)}`)
    }
  }

  const prompt = countTokens(JSON.stringify(body.messages ?? []))
  const completion = countTokens(contentForUsage) + countTokens(state.reasoning)
  yield chunk({}, finish, {
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
}

/** A failed upstream image request, answered with `status`. */
class UpstreamImageError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Runs one agent image request and returns its images. */
async function imageRequest(label, body, files, requestedModel, signal) {
  let upstream
  try {
    upstream = await upstreamChat(body, AGENT_IMAGE_PATH, signal, files)
  } catch (error) {
    throw new UpstreamImageError(error instanceof SignInError || error.signIn ? 401 : 502, error.message)
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    throw new UpstreamImageError(upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 400)}`)
  }
  const collector = imageCollector()
  const reader = upstream.body.getReader()
  const stream = sseReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      for (const event of stream.feed(value, done)) collector.feed(event)
      if (done) break
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw new UpstreamImageError(502, `${label} failed: ${error.message}`)
  }
  const { images, text } = collector.result()
  if (!images.length) {
    throw new UpstreamImageError(502, `${label} failed: Venice returned no image${text.trim() ? ` (agent said: ${preview(text, 200)})` : ''}`)
  }
  for (const image of images) {
    if (image.model && image.model !== requestedModel) warn(`   ~ asked for ${requestedModel}, Venice used ${image.model}`)
    if (image.flags.is_blurred || image.flags.is_content_violation) warn(`   ~ Venice flagged an image: ${JSON.stringify(image.flags)}`)
  }
  return images
}

/**
 * Runs one agent call per image, in parallel, and answers the client. Several
 * images in one call come back identical, so `n` is `n` calls.
 */
async function answerImages(res, label, instructions, files, model, format) {
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  let batches
  try {
    batches = await Promise.all(instructions.map((text) => imageRequest(label, agentRequest(text, files), files, model, abort.signal)))
  } catch (error) {
    abort.abort()
    if (error instanceof UpstreamImageError) return openaiError(res, error.status, error.message)
    throw error
  }
  const images = batches.flat()
  log(`   <- ${images.length} image(s) • ${images.map((image) => `${image.width ?? '?'}x${image.height ?? '?'} ${image.data.length} B`).join(', ')}`)
  return json(res, 200, imagesResponse(images, format))
}

/** A JSON body, with a 400 instead of a 500 when it does not parse. */
function imageJson(raw) {
  try {
    return parseJsonText(raw.toString('utf8'))
  } catch {
    throw new ImageRequestError('the request body is not valid JSON')
  }
}

/** `POST /v1/images/generations` (OpenAI shape) on the free image models. */
async function handleImageGenerations(req, res) {
  const body = imageJson(await readRaw(req, MAX_IMAGE_BODY))
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new ImageRequestError('prompt is required')
  const model = pickImageModel(body.model)
  const n = parseCount(body.n)
  const size = parseSize(body.size)
  const format = parseResponseFormat(body.response_format)
  log(`-> image ${model} • n=${n}${size ? ` • ${size.width}x${size.height}` : ''} • ${preview(body.prompt, 80)}`)
  const instructions = seedsFor(n).map((seed) => generationInstruction({ prompt: body.prompt, model, size, seed }))
  return answerImages(res, 'image generation', instructions, [], model, format)
}

/** The reference images of an edit request, from multipart files or JSON data URLs. */
async function editImages(values) {
  const images = []
  for (const value of values) {
    let image = null
    if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') {
      image = imageFromBytes(value.type, Buffer.from(await value.arrayBuffer()))
      if (!image) throw new ImageRequestError(`image must be PNG, JPEG, WebP or GIF, got ${value.type || 'an untyped file'}`)
    } else {
      const url = typeof value === 'string' ? value : (value?.image_url?.url ?? value?.image_url ?? value?.url)
      image = imageFromDataUrl(url)
      if (!image) {
        throw new ImageRequestError(
          typeof url === 'string' && /^https?:/i.test(url)
            ? 'image URLs are not fetched; send the image as a file or a base64 data URL'
            : 'image must be a file or a base64 data URL of a PNG, JPEG, WebP or GIF',
        )
      }
    }
    if (!images.some((known) => known.mediaId === image.mediaId)) images.push(image)
  }
  if (!images.length) throw new ImageRequestError('image is required')
  if (images.length > MAX_IMAGES) throw new ImageRequestError(`at most ${MAX_IMAGES} images per edit`)
  return images
}

/** `POST /v1/images/edits` (OpenAI shape, multipart or JSON) on the free edit models. */
async function handleImageEdits(req, res) {
  const raw = await readRaw(req, MAX_IMAGE_BODY)
  const type = String(req.headers['content-type'] ?? '')
  let fields
  let values
  if (type.toLowerCase().startsWith('multipart/form-data')) {
    let form
    try {
      form = await new Response(raw, { headers: { 'content-type': type } }).formData()
    } catch {
      throw new ImageRequestError('the multipart body could not be read')
    }
    fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string'))
    values = [...form.getAll('image'), ...form.getAll('image[]')]
    if (form.has('mask')) throw new ImageRequestError('mask is not supported; describe the change in the prompt')
  } else {
    fields = imageJson(raw)
    values = [fields.image, fields.images].flat().filter((value) => value != null)
    if (fields.mask != null) throw new ImageRequestError('mask is not supported; describe the change in the prompt')
  }
  if (typeof fields.prompt !== 'string' || !fields.prompt.trim()) throw new ImageRequestError('prompt is required')
  const model = pickEditModel(fields.model)
  const n = parseCount(fields.n)
  const format = parseResponseFormat(fields.response_format)
  const images = await editImages(values)
  log(`-> edit ${model} • n=${n} • ${images.length} reference(s) • ${preview(fields.prompt, 80)}`)
  const instructions = seedsFor(n).map((seed) => editInstruction({ prompt: fields.prompt, model, seed }))
  return answerImages(res, 'image edit', instructions, images, model, format)
}

async function handleChat(req, res) {
  const body = await readJson(req)
  const mapping = toVeniceRequest(body)

  // Venice rejects null bytes ("String must not contain null bytes", HTTP 400)
  // and a nested leak in the system prompt breaks the whole session, so scrub
  // the outgoing payload. Tool results are the usual source (grep/cat/tail over
  // a binary file).
  const scrubbed = deepStripNulls(mapping.request)
  const scrubbedBody = deepStripNulls(body)
  const nulls = scrubbed + scrubbedBody
  if (nulls) log(`   ~ scrubbed ${nulls} NUL byte(s) before sending upstream`)

  if (dumpFile) {
    try {
      const images = mapping.images.map(({ mediaId, mimeType, data }) => ({ mediaId, mimeType, bytes: data.length }))
      writeFileSync(dumpFile, JSON.stringify({ body, mapping: { ...mapping, images } }, null, 1))
    } catch {
      /* ignore */
    }
  }

  const names = [...mapping.toolNames]
  log(
    `-> ${body.model} • ${body.messages?.length ?? 0} msgs • ${names.length} tools${names.length ? ` [${names.join(',')}]` : ''}${mapping.images.length ? ` • ${mapping.images.length} image(s)` : ''} • stream=${body.stream === true}`,
  )

  const abort = new AbortController()
  req.on('aborted', () => abort.abort())

  let upstream
  try {
    upstream = await upstreamChat(mapping.request, INFERENCE_PATH, abort.signal, mapping.images)
  } catch (error) {
    return openaiError(res, error instanceof SignInError || error.signIn ? 401 : 502, error.message)
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    return openaiError(res, upstream.status, `${apiBase} responded HTTP ${upstream.status}: ${text.slice(0, 400)}`)
  }

  const chunks = openaiChunks(body, mapping, upstream.body, abort.signal)

  // 遵循 OpenAI 默认行为：只有显式启用流式输出时才返回 SSE，兼容未传 stream 的客户端。
  if (body.stream !== true) {
    const message = { role: 'assistant', content: '' }
    let finish = 'stop'
    let usage = null
    for await (const part of chunks) {
      if (part.usage) usage = part.usage
      const choice = part.choices?.[0]
      if (!choice) continue
      if (choice.delta.content) message.content += choice.delta.content
      if (choice.delta.reasoning_content) message.reasoning = (message.reasoning ?? '') + choice.delta.reasoning_content
      if (choice.delta.tool_calls) message.tool_calls = choice.delta.tool_calls.map(({ index, ...call }) => call)
      if (choice.finish_reason) finish = choice.finish_reason
    }
    if (message.tool_calls && !message.content) message.content = null
    if (!message.content && !message.tool_calls) message.content = ''
    return json(res, 200, {
      id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    })
  }

  res.writeHead(200, {
    ...CORS_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  // Emulated tool calls can stay silent for minutes while the reply is parsed
  // and retried; a comment line keeps the client from dropping the connection.
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n')
  }, 15_000)
  const stopKeepalive = () => {
    clearInterval(keepalive)
    req.off('aborted', stopKeepalive)
  }
  req.on('aborted', stopKeepalive)

  try {
    for await (const part of chunks) res.write(`data: ${JSON.stringify(part)}\n\n`)
    res.write('data: [DONE]\n\n')
  } catch (error) {
    warn('stream error:', error.message)
    res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
  } finally {
    stopKeepalive()
  }
  res.end()
}

async function serveHtmlFile(res, filePath, url, downloadName) {
  const html = await readFile(filePath, 'utf8')
  const headers = { ...CORS_HEADERS, 'content-type': 'text/html; charset=utf-8' }
  if (url.searchParams.get('download') === '1') {
    headers['content-disposition'] = `attachment; filename="${downloadName}"`
  }
  res.writeHead(200, headers)
  return res.end(html)
}

export function createServer() {
  return async function handler(req, res) {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    const hostHeader = req.headers.host || 'localhost'
    const baseUrl = `${proto}://${hostHeader}`
    const url = new URL(req.url, baseUrl)
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS)
        return res.end()
      }

      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        const session = await loadSession().catch(() => null)
        return json(res, 200, {
          ok: !!session,
          account: session?.email ?? null,
          provider: providerID,
          models: Object.keys(MODELS).length,
          transport: transportFor(apiBase),
          docs: '/docs',
          apiDocMd: '/docs/api.md',
        })
      }

      if (req.method === 'GET' && (url.pathname === '/docs/api.md' || url.pathname === '/docs/API.md' || url.pathname === '/api.md')) {
        const rawMd = await readFile(API_DOCS_PATH, 'utf8')
        const md = rawMd.replaceAll('{{BASE_URL}}', baseUrl)
        const isDownload = url.searchParams.get('download') === '1'
        res.writeHead(200, {
          ...CORS_HEADERS,
          'content-type': isDownload ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
          'content-disposition': isDownload ? 'attachment; filename="venice-api-protocol.md"' : 'inline; filename="API.md"',
        })
        return res.end(md)
      }

      if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/api')) {
        const rawMd = await readFile(API_DOCS_PATH, 'utf8')
        const md = rawMd.replaceAll('{{BASE_URL}}', baseUrl)
        res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'text/html; charset=utf-8' })
        return res.end(renderDocsHtml(md))
      }

      if (req.method === 'GET' && url.pathname === '/characters.html') {
        return await serveHtmlFile(res, CHARACTERS_HTML_PATH, url, 'venice-characters.html')
      }

      if (req.method === 'GET' && url.pathname === '/minds.html') {
        return await serveHtmlFile(res, MINDS_HTML_PATH, url, 'venice-minds.html')
      }

      if (!isAuthorized(req, url)) {
        return openaiError(res, 401, 'invalid or missing API key', 'authentication_error')
      }

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        return json(res, 200, modelList())
      }

      if (req.method === 'GET' && (url.pathname.startsWith('/v1/characters') || url.pathname.startsWith('/characters'))) {
        const handled = await handleCharacters(req, res, url)
        if (handled !== false) return
      }

      if (req.method === 'GET' && (url.pathname.startsWith('/v1/minds') || url.pathname.startsWith('/minds'))) {
        const handled = await handleMinds(req, res, url)
        if (handled !== false) return
      }

      if (req.method === 'POST' && url.pathname.endsWith('/images/generations')) {
        return await handleImageGenerations(req, res)
      }

      if (req.method === 'POST' && url.pathname.endsWith('/images/edits')) {
        return await handleImageEdits(req, res)
      }

      if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        return await handleChat(req, res)
      }

      if (req.method === 'POST' && url.pathname === '/reload') {
        resetSessionCache()
        const session = await loadSession({ force: true })
        return json(res, 200, { ok: true, account: session.email ?? null })
      }

      openaiError(res, 404, `unknown endpoint: ${req.method} ${url.pathname}`, 'not_found')
    } catch (error) {
      if (error instanceof SignInError) return openaiError(res, 401, error.message)
      if (error instanceof ImageRequestError) return openaiError(res, error.status ?? 400, error.message, 'invalid_request_error')
      warn('request error:', error.stack ?? error.message)
      if (!res.headersSent) openaiError(res, 500, error.message)
      else res.end()
    }
  }
}

export { host, port }
