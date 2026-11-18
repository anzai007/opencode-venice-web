import test from 'node:test'
import assert from 'node:assert/strict'
import { envelopeContentStream, remainingContent } from '../src/lib/envelope-stream.mjs'
import { collectStream, openaiChunks } from '../src/lib/server.mjs'
import { toVeniceRequest } from '../src/lib/emulate.mjs'
import { DEFAULT_MODEL } from '../src/lib/models.mjs'

const encode = (type, data = {}) => new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
const header = '{"status":"done","tool_calls":[],"content":"'

test('正文在 JSON 和上游响应结束之前输出', () => {
  const reader = envelopeContentStream()
  assert.equal(reader.feed(header + '第一段'), '第一段')
  assert.equal(reader.feed('，第二段'), '，第二段')
  assert.equal(reader.feed('"}'), '')
})

test('任意分片边界均正确解码中文、引号、反斜杠、换行和表情', () => {
  const answer = '你好 "引号" \\ 路径\n下一行 🚀😀'
  for (const raw of [JSON.stringify({ status: 'done', tool_calls: [], content: answer }), header + '\\u4f60\\u597d\\ud83d\\ude80"}']) {
    const expected = JSON.parse(raw).content.trim()
    for (let width = 1; width <= raw.length; width++) {
      const reader = envelopeContentStream()
      let actual = ''
      for (let at = 0; at < raw.length; at += width) actual += reader.feed(raw.slice(at, at + width))
      assert.equal(actual, expected, `分片宽度 ${width}`)
    }
  }
})

test('前后空白和连续换行与完整正文解析保持一致', () => {
  const reader = envelopeContentStream()
  assert.equal(reader.feed(header + '  '), '')
  assert.equal(reader.feed('a\\n\\n'), 'a')
  assert.equal(reader.feed('\\nb   "}'), '\n\nb')
})

test('允许元数据顺序变化和 JSON 代码围栏', () => {
  assert.equal(envelopeContentStream().feed('```json\n{"tool_calls":[],"status":"ask","content":"请确认"}\n```'), '请确认')
})

test('工具参数、嵌套 content 和工具轮次不提前泄漏', () => {
  for (const raw of [
    '{"status":"continue","tool_calls":[{"name":"write","arguments":{"content":"秘密参数"}}],"content":"准备执行"}',
    '{"status":"done","tool_calls":[{"name":"write","arguments":{}}],"content":"准备执行"}',
    '{"status":"continue","tool_calls":[],"content":"尚未完成"}',
    '{"content":"旧顺序","status":"done","tool_calls":[]}',
    '{"status":"done","content":"缺少工具列表","tool_calls":[]}',
    '普通文字 {"status":"done","tool_calls":[],"content":"不是首个对象"}',
    '{"status":"done","tool_calls":"[]","content":"错误字段类型"}',
  ]) assert.equal(envelopeContentStream().feed(raw), '')
})

test('非法转义停止增量解码，保留已输出前缀等待完整修复', () => {
  const reader = envelopeContentStream()
  assert.equal(reader.feed(header + '已显示\\q后续'), '已显示')
  assert.equal(reader.feed('其他内容"}'), '')
})

test('结束时只补未输出的正文，避免重放；不同修复结果作为补充', () => {
  assert.equal(remainingContent('你好世界', '你好'), '世界')
  assert.equal(remainingContent('你好', '你好'), '')
  assert.equal(remainingContent('新答案', '旧答案'), '\n\n新答案')
  assert.equal(remainingContent('', '已显示'), '')
})

test('SSE 上游尚未完成时已经产生可见正文，并保持推理输出', async () => {
  let controller
  const body = new ReadableStream({ start(c) { controller = c } })
  const generator = collectStream(body, { emulatedTools: true }, delta => delta, { streamContent: true })
  controller.enqueue(encode('response.output_text.delta', { delta: header + '先到的内容' }))
  assert.deepEqual((await generator.next()).value, { content: '先到的内容' })
  controller.enqueue(encode('response.reasoning_text.delta', { delta: '推理' }))
  assert.deepEqual((await generator.next()).value, { reasoning_content: '推理' })
  controller.enqueue(encode('response.output_text.delta', { delta: '后到的内容"}' }))
  assert.deepEqual((await generator.next()).value, { content: '后到的内容' })
  controller.enqueue(encode('response.completed'))
  controller.close()
  const result = await generator.next()
  assert.equal(result.done, true)
  assert.equal(result.value.liveContent, '先到的内容后到的内容')
  assert.equal(result.value.terminal, true)
})

test('完整 OpenAI 流不重复正文，最终回答无需等待重试或评判器', async () => {
  let controller
  const upstream = new ReadableStream({ start(c) { controller = c } })
  const body = { model: DEFAULT_MODEL, stream: true, messages: [{ role: 'user', content: '说一句话' }], tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] }
  const generator = openaiChunks(body, toVeniceRequest(body), upstream)
  const chunks = [(await generator.next()).value]
  controller.enqueue(encode('response.output_text.delta', { delta: header + '实时' }))
  chunks.push((await generator.next()).value)
  assert.equal(chunks.at(-1).choices[0].delta.content, '实时')
  controller.enqueue(encode('response.output_text.delta', { delta: '回答"}' }))
  chunks.push((await generator.next()).value)
  controller.enqueue(encode('response.completed'))
  controller.close()
  for await (const chunk of generator) chunks.push(chunk)
  assert.equal(chunks.map(c => c.choices[0].delta.content ?? '').join(''), '实时回答')
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})

test('非流式输出及合法工具调用继续使用完整校验路径', async () => {
  for (const stream of [false, true]) {
    const body = { model: DEFAULT_MODEL, stream, messages: [{ role: 'user', content: '读取文件' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }] }
    const raw = JSON.stringify({ status: 'continue', tool_calls: [{ name: 'read', arguments: { path: '/tmp/example' } }], content: '读取文件。' })
    const upstream = new ReadableStream({ start(c) { c.enqueue(encode('response.output_text.delta', { delta: raw })); c.enqueue(encode('response.completed')); c.close() } })
    const chunks = []
    for await (const chunk of openaiChunks(body, toVeniceRequest(body), upstream)) chunks.push(chunk)
    assert.equal(chunks.map(c => c.choices[0].delta.content ?? '').join(''), '读取文件。')
    const calls = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? [])
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(calls[0].function.arguments).path, '/tmp/example')
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
  }
})

test('显式要求工具时不提前展示无工具候选答案', async () => {
  let controller
  const upstream = new ReadableStream({ start(c) { controller = c } })
  const body = { model: DEFAULT_MODEL, stream: true, tool_choice: 'required', messages: [{ role: 'user', content: '请确认工具信息' }], tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] }
  const generator = openaiChunks(body, toVeniceRequest(body), upstream)
  await generator.next()
  controller.enqueue(encode('response.output_text.delta', { delta: '{"status":"ask","tool_calls":[],"content":"请确认文件路径"}' }))
  let arrived = false
  const next = generator.next().then(value => { arrived = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(arrived, false)
  controller.enqueue(encode('response.completed'))
  controller.close()
  assert.equal((await next).value.choices[0].delta.content, '请确认文件路径')
  for await (const ignored of generator) void ignored
})
