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

test('GET /minds.html serves standalone HTML and supports ?download=1', async () => {
  await withServer(async (base) => {
    const viewRes = await fetch(`${base}/minds.html`)
    assert.equal(viewRes.status, 200)
    assert.match(viewRes.headers.get('content-type') || '', /text\/html/)
    const html = await viewRes.text()
    assert.match(html, /Venice Minds 浏览器/)
    assert.match(html, /精选 Minds/)

    const dlRes = await fetch(`${base}/minds.html?download=1`)
    assert.equal(dlRes.status, 200)
    assert.match(dlRes.headers.get('content-disposition') || '', /attachment; filename="venice-minds\.html"/)
  })
})

test('GET /v1/minds/featured and /v1/minds/search proxy upstream successfully', async () => {
  await withServer(async (base) => {
    const featRes = await fetch(`${base}/v1/minds/featured`)
    assert.equal(featRes.status, 200)
    assert.equal(featRes.headers.get('access-control-allow-origin'), '*')
    const featJson = await featRes.json()
    assert.ok(Array.isArray(featJson.data))
    assert.ok(featJson.data.length > 0)

    const firstSlug = featJson.data[0].slug
    assert.ok(typeof firstSlug === 'string')

    const searchRes = await fetch(`${base}/v1/minds/search?limit=3`)
    assert.equal(searchRes.status, 200)
    const searchJson = await searchRes.json()
    assert.ok(Array.isArray(searchJson.data))

    const detailRes = await fetch(`${base}/v1/minds/${encodeURIComponent(firstSlug)}`)
    assert.equal(detailRes.status, 200)
    const detailJson = await detailRes.json()
    assert.equal(detailJson.slug, firstSlug)
    assert.ok(typeof detailJson.name === 'string')

    const meRes = await fetch(`${base}/v1/minds/me`)
    assert.equal(meRes.status, 200)
    const meJson = await meRes.json()
    assert.ok(Array.isArray(meJson.data))
  })
})
