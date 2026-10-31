/**
 * Local harness for the per-model quota router: a fake Cordis context plus a
 * local usage endpoint, so quarantine, plan-wide fallback, and expiry are
 * exercised without any model tokens.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { apply, isExhausted, nextProbeAt } from './index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let usageMode = 'healthy'
const server = http.createServer((request, response) => {
  if (request.url !== '/usage') return response.writeHead(404).end()
  const exhausted = usageMode === 'exhausted'
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    usage: {
      rolling: { status: exhausted ? 'limited' : 'ok', percent: exhausted ? 100 : 0, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      weekly: { status: 'ok', percent: 0, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
      monthly: { status: 'ok', percent: 0, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
    },
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const usageUrl = `http://127.0.0.1:${server.address().port}/usage`

// pure logic
assert.equal(isExhausted({ rolling: { status: 'ok', percent: 42 } }), false)
assert.equal(isExhausted({ rolling: { status: 'ok', percent: 100 } }), true)
assert.equal(isExhausted({ rolling: { status: 'warning', percent: 80 } }), false)
{
  const now = Date.parse('2026-10-31T12:00:00Z')
  assert.equal(nextProbeAt({ rolling: { resetsAt: new Date(now + 10 * 60_000).toISOString() } }, now, 30 * 60_000), now + 10 * 60_000 + 2000)
  assert.equal(nextProbeAt({ rolling: { resetsAt: new Date(now + 4 * 3_600_000).toISOString() } }, now, 30 * 60_000), now + 30 * 60_000)
}
console.log('pure logic ok')

const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oqr-')), 'state.json')
process.env.OPENCODE_API_KEY = 'oc_sk_test'

const listeners = new Map()
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  get: () => undefined,
  on: (event, listener) => {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
  effect: (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  llm: {
    listProviders: () => [{ id: 'opencode-go' }, { id: 'deepseek-account' }, { id: 'opencode-free' }],
    resolveModelInfo: async (provider, model) => ({
      reasoning: {
        efforts: provider === 'opencode-go'
          ? model.includes('pro') ? [{ id: 'high' }, { id: 'max' }] : [{ id: 'low' }, { id: 'high' }, { id: 'max' }]
          : [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }],
      },
    }),
  },
}
const routes = [
  { primary: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, fallback: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  { primary: { provider: 'opencode-go', model: 'deepseek-v4-pro' }, fallback: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } },
]
apply(ctx, { routes, usageUrl, statePath, probeIntervalMs: 1200, minProbeDelayMs: 1000, unconfirmedDelayMs: 1000, modelQuarantineMs: 2500 })

const ask = listeners.get('agent/request')
const fail = listeners.get('agent/request-error')
// The fake session reports the model the failed attempt used.
let headerModel = 'deepseek-v4-pro'
const agent = { id: 's1', session: { requestHeader: () => ({ config: { provider: 'opencode-go', model: headerModel } }) } }
const call = (config) => ask({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => config)
const crash = (provider, failure) => fail({ agent, turn: 1, step: 1, provider, failure, signal: new AbortController().signal }, async () => undefined)

const flash = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' }
const pro = { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'low' }

await sleep(1800) // startup probe: healthy
assert.equal((await call(flash)).provider, 'opencode-go')
assert.equal((await call(pro)).model, 'deepseek-v4-pro')
console.log('primary routing ok')

// Quarantining Pro must not move Flash.
headerModel = 'deepseek-v4-pro'
assert.deepEqual(await crash('opencode-go', { code: 'QUOTA', status: 429, message: 'usage limit reached' }), { kind: 'retry' })
{
  const flashRouted = await call(flash)
  assert.equal(flashRouted.provider, 'opencode-go', 'Flash keeps the plan while Pro is quarantined')
  const proRouted = await call(pro)
  assert.equal(proRouted.provider, 'deepseek-account')
  assert.equal(proRouted.model, 'deepseek-v4-pro')
}
const stateAfterQuarantine = JSON.parse(fs.readFileSync(statePath, 'utf8'))
assert.equal(Object.keys(stateAfterQuarantine.quarantine).length, 1)
assert.equal(stateAfterQuarantine.mode, 'primary')
console.log('per-model quarantine ok')

// Quarantine expires and Flash never fell back.
await sleep(3200)
{
  const proRouted = await call(pro)
  assert.equal(proRouted.provider, 'opencode-go')
}
console.log('quarantine expiry ok')

// An auth failure is plan-wide.
assert.deepEqual(await crash('opencode-go', { code: 'INVALID_CREDENTIAL', message: 'bad key' }), { kind: 'retry' })
{
  const routed = await call(flash)
  assert.equal(routed.provider, 'deepseek-account')
  const stateNow = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(stateNow.mode, 'fallback')
}
console.log('plan-wide fallback ok')

// Other providers are never claimed.
assert.equal(await crash('deepseek-account', { code: 'QUOTA', message: 'no' }), undefined)
// A plain rate limit with room left is not a quarantine.
usageMode = 'healthy'
await sleep(1500)
assert.equal(await crash('opencode-go', { code: 'RATE_LIMIT', status: 429, message: 'slow down' }), undefined)
console.log('delegation ok')

for (const dispose of disposers) await dispose()
server.close()
console.log('all router checks passed')
