import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
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

test('CORS preflight returns 204 with allow-origin *', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/characters`, { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })
})

test('GET /characters.html serves standalone HTML and supports ?download=1', async () => {
  await withServer(async (base) => {
    const viewRes = await fetch(`${base}/characters.html`)
    assert.equal(viewRes.status, 200)
    assert.match(viewRes.headers.get('content-type') || '', /text\/html/)
    const html = await viewRes.text()
    assert.match(html, /获取角色列表/)
    assert.match(html, /获取我的角色/)

    const dlRes = await fetch(`${base}/characters.html?download=1`)
    assert.equal(dlRes.status, 200)
    assert.match(dlRes.headers.get('content-disposition') || '', /attachment; filename="venice-characters\.html"/)
  })
})
