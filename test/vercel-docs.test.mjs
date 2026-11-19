import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from '../src/lib/server.mjs'
import vercelHandler from '../api/index.mjs'

const execFileAsync = promisify(execFile)

async function withHandler(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('GET /docs/api.md serves inline markdown and supports ?download=1', async () => {
  await withHandler(createServer(), async (base) => {
    const res = await fetch(`${base}/docs/api.md`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/plain; charset=utf-8/)
    assert.match(res.headers.get('content-disposition') || '', /^inline;/)
    const md = await res.text()
    assert.ok(md.includes(base), 'replaces {{BASE_URL}} with current origin')
    assert.ok(md.includes('/v1/chat/completions'))
    assert.ok(md.includes('/v1/images/generations'))
    assert.ok(md.includes('/v1/characters'))
    assert.ok(md.includes('/v1/minds/featured'))

    const dl = await fetch(`${base}/docs/api.md?download=1`)
    assert.equal(dl.status, 200)
    assert.match(dl.headers.get('content-type') || '', /text\/markdown; charset=utf-8/)
    assert.match(dl.headers.get('content-disposition') || '', /attachment; filename="venice-api-protocol\.md"/)
  })
})

test('GET /docs serves rendered HTML documentation viewer', async () => {
  await withHandler(createServer(), async (base) => {
    const res = await fetch(`${base}/docs`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/html; charset=utf-8/)
    const html = await res.text()
    assert.match(html, /Venice Web Proxy/)
    assert.match(html, /\/docs\/api\.md/)
  })
})

test('api/index.mjs default export handles /health with x-forwarded-proto', async () => {
  await withHandler(vercelHandler, async (base) => {
    const res = await fetch(`${base}/health`, {
      headers: { 'x-forwarded-proto': 'https', host: 'example.vercel.app' },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.provider, 'venice-web')
    assert.equal(body.docs, '/docs')
    assert.equal(body.apiDocMd, '/docs/api.md')
  })
})

test('readSession reads VENICE_SESSION_B64 and VENICE_SESSION_JSON in serverless env', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-env-test-'))
  try {
    const fakeSession = {
      client: 'test_client_cookie',
      userAgent: 'TestAgent/1.0',
      email: 'test@example.com',
      uid: 'user_test123',
    }
    const b64 = Buffer.from(JSON.stringify(fakeSession), 'utf8').toString('base64')
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import { readSession } from "./src/lib/venice.mjs"; const s = await readSession(); console.log(JSON.stringify({ email: s.email, client: s.client, hasKey: !!s.envKey }));',
      ],
      {
        cwd: '/Users/azaz/Desktop/code/opencode-venice-web',
        env: {
          ...process.env,
          VERCEL: '1',
          VENICE_WEB_SESSION: path.join(dir, 'session.json'),
          VENICE_SESSION_B64: b64,
        },
      },
    )
    const parsed = JSON.parse(stdout.trim())
    assert.equal(parsed.email, 'test@example.com')
    assert.equal(parsed.client, 'test_client_cookie')
    assert.equal(parsed.hasKey, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('optional VENICE_API_KEY gates API routes while keeping /health and /docs accessible', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import http from 'node:http';
      import assert from 'node:assert/strict';
      import { createServer } from './src/lib/server.mjs';
      const server = http.createServer(createServer());
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      try {
        const h = await fetch(base + '/health');
        const d = await fetch(base + '/docs');
        const unauth = await fetch(base + '/v1/models');
        const bearer = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer secret-123' } });
        const headerKey = await fetch(base + '/v1/models', { headers: { 'x-api-key': 'secret-123' } });
        console.log(JSON.stringify({ h: h.status, d: d.status, unauth: unauth.status, bearer: bearer.status, headerKey: headerKey.status }));
      } finally {
        server.close();
      }
      `,
    ],
    {
      cwd: '/Users/azaz/Desktop/code/opencode-venice-web',
      env: {
        ...process.env,
        VENICE_API_KEY: 'secret-123',
      },
    },
  )
  const statuses = JSON.parse(stdout.trim())
  assert.deepEqual(statuses, { h: 200, d: 200, unauth: 401, bearer: 200, headerKey: 200 })
})
