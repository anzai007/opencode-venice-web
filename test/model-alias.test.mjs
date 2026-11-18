import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEFAULT_MODEL, MODELS } from '../src/lib/models.mjs'
import { buildJudgeRequest, toVeniceRequest } from '../src/lib/emulate.mjs'

const oldId = 'deepseek-v4-1-flash-free'
const newId = 'deepseek-v4-1-flash-uncensored'

test('正式模型进入目录并保留网页目录中的输出限制', () => {
  assert.equal(DEFAULT_MODEL, newId)
  assert.equal(MODELS[newId].output, 131072)
  assert.ok(!Object.hasOwn(MODELS, oldId))
})

test('旧别名与正式 ID 均向上游发送正式 ID，且不修改客户端输入', () => {
  for (const id of [oldId, newId]) {
    const body = { model: id, messages: [{ role: 'user', content: 'hello' }] }
    assert.equal(toVeniceRequest(body).request.modelId, newId)
    assert.equal(body.model, id)
    assert.equal(buildJudgeRequest(body, { content: 'done' }, id).modelId, newId)
  }
  assert.throws(() => toVeniceRequest({ model: 'missing', messages: [] }), /unknown model/)
})

test('同步配置迁移当前 Provider 的旧别名，并保留其他默认模型和 Provider', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-model-sync-'))
  const file = path.join(dir, 'opencode.json')
  try {
    writeFileSync(file, JSON.stringify({ model: 'other/selected', small_model: `venice-web/${oldId}`, provider: { other: { name: '保留配置' } } }))
    const result = spawnSync(process.execPath, [new URL('../src/sync.mjs', import.meta.url).pathname, '--config', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(config.model, 'other/selected')
    assert.equal(config.small_model, `venice-web/${newId}`)
    assert.deepEqual(config.provider.other, { name: '保留配置' })
    assert.ok(config.provider['venice-web'].models[newId])
    assert.ok(!config.provider['venice-web'].models[oldId])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
