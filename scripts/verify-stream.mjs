import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const base = process.env.STREAM_TEST_BASE ?? 'http://127.0.0.1:3456/v1'
const model = process.env.STREAM_TEST_MODEL ?? 'venice-uncensored-1-2'
const tools = [{ type: 'function', function: {
  name: 'add_numbers', description: 'Add two numbers.',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
} }]

/** 实际读取网络分片并记录正文到达时间，区分真正增量输出与最后集中发送多个 SSE 事件。 */
async function request(messages, { stream = true, toolChoice = 'auto' } = {}) {
  const start = performance.now()
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream, tool_choice: toolChoice }),
    signal: AbortSignal.timeout(180000),
  })
  assert.equal(response.status, 200, `请求失败：${await (response.ok ? Promise.resolve('') : response.text())}`)
  if (!stream) return { json: await response.json() }
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let done = false
  const arrivals = []
  const calls = []
  let finish
  const readLines = () => {
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('data: ')) continue
      if (line === 'data: [DONE]') { done = true; continue }
      const event = JSON.parse(line.slice(6))
      assert.ok(!event.error, JSON.stringify(event.error))
      const choice = event.choices?.[0]
      if (choice?.delta?.content) {
        arrivals.push(performance.now() - start)
        text += choice.delta.content
      }
      for (const call of choice?.delta?.tool_calls ?? []) calls.push(call)
      if (choice?.finish_reason) finish = choice.finish_reason
    }
  }
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true })
    readLines()
  }
  buffer += decoder.decode()
  readLines()
  assert.equal(done, true, '缺少流式结束标志')
  return { text, calls, finish, metrics: {
    model, contentChunks: arrivals.length, firstContentMs: Math.round(arrivals[0] ?? 0),
    lastContentMs: Math.round(arrivals.at(-1) ?? 0), totalMs: Math.round(performance.now() - start),
    visibleDurationMs: Math.round((arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0)), characters: text.length,
  } }
}

const reply = await request([{ role: 'user', content: '这是流式验收。不要调用工具。请直接写20条编号的中文说明，解释实时聊天界面如何处理网络分片，每条约35字。最后另起一行写：验收完成。' }])
assert.equal(reply.finish, 'stop')
assert.ok(reply.text.includes('验收完成'))
assert.ok(reply.metrics.contentChunks > 1, '正文仍然只有一个分片')
assert.ok(reply.metrics.visibleDurationMs > 50, '正文分片集中在结束时到达，没有形成持续输出')
console.log(JSON.stringify({ test: '带工具的增量正文', ok: true, ...reply.metrics }))

// 只执行本地加法，不接触文件、外部消息或业务数据。
const messages = [{ role: 'user', content: '必须先调用 add_numbers 计算17加25，然后根据工具返回值报告结果。' }]
const toolReply = await request(messages, { toolChoice: 'required' })
assert.equal(toolReply.finish, 'tool_calls')
assert.ok(toolReply.calls.length > 0, '模型没有返回工具调用')
const calls = toolReply.calls.map(({ index, ...call }) => call)
messages.push({ role: 'assistant', content: toolReply.text || null, tool_calls: calls })
for (const call of calls) {
  assert.equal(call.function.name, 'add_numbers')
  const args = JSON.parse(call.function.arguments)
  assert.equal(typeof args.a, 'number')
  assert.equal(typeof args.b, 'number')
  messages.push({ role: 'tool', tool_call_id: call.id, content: String(args.a + args.b) })
}
const final = await request(messages)
assert.equal(final.finish, 'stop')
assert.match(final.text, /42/)
console.log(JSON.stringify({ test: '工具调用与结果回传', ok: true, calls: calls.length }))

const plain = await request([{ role: 'user', content: '不要调用工具，用一句中文解释SSE。' }], { stream: false })
assert.ok(plain.json.choices?.[0]?.message?.content)
assert.equal(plain.json.object, 'chat.completion')
console.log(JSON.stringify({ test: '非流式 JSON 兼容', ok: true }))
