/**
 * OpenCode Go quota router with per-model isolation.
 *
 * OpenCode meters every model against its own monthly limit (5-hour = 20% of
 * it, weekly = 50%, monthly = 100%), so an exhausted DeepSeek V4 Pro budget must
 * not drag DeepSeek V4.1 Flash back to the DeepSeek account. This plugin
 * therefore keeps two independent signals:
 *
 * - `quarantine[model]` — one primary model reported exhaustion; only requests
 *   for that model fall back until its window resets.
 * - `mode` — a plan-wide fallback for a bad credential or a failure that cannot
 *   be attributed to one model; every primary model falls back.
 *
 * Both seams act at step boundaries of one agent: `agent/request` rewrites the
 * call config, `agent/request-error` quarantines and retries the failed step in
 * the same turn. Streaming requests and other agents are never interrupted.
 * Both listeners register with `prepend: true`: a Cordis waterfall returns the
 * outermost listener's value, so an observer appended later could otherwise
 * shadow the rewrite.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'opencode-quota-router'

/** Routing needs the provider registry to resolve model metadata. */
export const inject = ['llm']

const DEFAULT_USAGE_URL = 'https://opencode.ai/inference/go/v1/usage'
const DEFAULT_API_KEY_REF = 'OPENCODE_API_KEY'
const DEFAULT_PROBE_INTERVAL_MS = 30 * 60 * 1000
const MIN_PROBE_DELAY_MS = 60 * 1000
const UNCONFIRMED_DELAY_MS = 2 * 60 * 1000
const MODEL_QUARANTINE_MS = 30 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
const EFFORT_CACHE_TTL_MS = 10 * 60 * 1000
const AUTH_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'CLIENT_UPGRADE_REQUIRED',
])
const QUOTA_MESSAGE = /allowance|usage limit|quota|limit reached|exceed/i

function routePair(raw) {
  const primary = raw?.primary
  const fallback = raw?.fallback
  if (typeof primary?.provider !== 'string' || typeof primary?.model !== 'string') return undefined
  if (typeof fallback?.provider !== 'string' || typeof fallback?.model !== 'string') return undefined
  return { primary: { provider: primary.provider, model: primary.model }, fallback: { provider: fallback.provider, model: fallback.model } }
}

function normalize(config) {
  const routes = Array.isArray(config?.routes) ? config.routes.map(routePair).filter((entry) => entry !== undefined) : []
  return {
    routes,
    usageUrl: typeof config?.usageUrl === 'string' && config.usageUrl.length > 0 ? config.usageUrl : DEFAULT_USAGE_URL,
    apiKeyRef: typeof config?.apiKeyRef === 'string' && config.apiKeyRef.length > 0 ? config.apiKeyRef : DEFAULT_API_KEY_REF,
    probeIntervalMs: Number.isFinite(config?.probeIntervalMs) && config.probeIntervalMs >= 1000 ? config.probeIntervalMs : DEFAULT_PROBE_INTERVAL_MS,
    minProbeDelayMs: Number.isFinite(config?.minProbeDelayMs) && config.minProbeDelayMs >= 1000 ? config.minProbeDelayMs : MIN_PROBE_DELAY_MS,
    unconfirmedDelayMs: Number.isFinite(config?.unconfirmedDelayMs) && config.unconfirmedDelayMs >= 1000 ? config.unconfirmedDelayMs : UNCONFIRMED_DELAY_MS,
    modelQuarantineMs: Number.isFinite(config?.modelQuarantineMs) && config.modelQuarantineMs >= 1000 ? config.modelQuarantineMs : MODEL_QUARANTINE_MS,
    statePath: typeof config?.statePath === 'string' && config.statePath.length > 0 ? config.statePath : path.join(dshHome(), 'opencode-quota-router.json'),
  }
}

function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

/** Whether any quota window reports plan-wide exhaustion. */
export function isExhausted(usage) {
  const spent = (window) => {
    if (window === null || typeof window !== 'object') return false
    const percent = typeof window.percent === 'number' ? window.percent : undefined
    if (percent !== undefined && percent >= 100) return true
    const status = typeof window.status === 'string' ? window.status.toLowerCase() : ''
    return /limit|exhaust|block|denied|exceed/.test(status)
  }
  return spent(usage?.rolling) || spent(usage?.weekly) || spent(usage?.monthly)
}

/** When to probe next: the rolling-window reset when it is near, otherwise the fixed interval. */
export function nextProbeAt(usage, now, intervalMs, minDelayMs = MIN_PROBE_DELAY_MS) {
  const ceiling = now + intervalMs
  const reset = Date.parse(usage?.rolling?.resetsAt ?? '')
  if (Number.isFinite(reset) && reset > now) return Math.min(ceiling, Math.max(now + minDelayMs, reset + 2000))
  return ceiling
}

function initialState() {
  return { version: 2, mode: 'primary', reason: 'initial', until: 0, quarantine: {}, usage: null, checkedAt: 0, updatedAt: Date.now() }
}

function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const quarantine = {}
    if (parsed.quarantine !== null && typeof parsed.quarantine === 'object') {
      for (const [model, entry] of Object.entries(parsed.quarantine)) {
        if (entry !== null && typeof entry === 'object' && Number.isFinite(entry.until)) quarantine[model] = { until: entry.until, reason: String(entry.reason ?? 'quota') }
      }
    }
    return {
      version: 2,
      mode: parsed.mode === 'fallback' ? 'fallback' : 'primary',
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'loaded',
      until: Number.isFinite(parsed.until) ? parsed.until : 0,
      quarantine,
      usage: parsed.usage !== null && typeof parsed.usage === 'object' ? parsed.usage : null,
      checkedAt: Number.isFinite(parsed.checkedAt) ? parsed.checkedAt : 0,
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return undefined
  }
}

function mtimeOf(target) {
  try {
    return fs.statSync(target).mtimeMs
  } catch {
    return 0
  }
}

function retarget(config, target, reasoningEffort) {
  const { reasoningEffort: _dropped, ...rest } = config
  return {
    ...rest,
    provider: target.provider,
    model: target.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

export function apply(ctx, config = {}) {
  const cfg = normalize(config)
  if (cfg.routes.length === 0) {
    ctx.logger.warn('opencode-quota-router: no route pairs configured; the plugin stays idle')
    return
  }

  let state = readState(cfg.statePath) ?? initialState()
  let lastMtime = mtimeOf(cfg.statePath)
  let hasKey = true
  let timer
  let bootTimer
  let disposed = false
  const effortCache = new Map()
  const lifetime = new AbortController()

  const log = {
    info: (message) => safeLog(ctx, 'info', message),
    warn: (message) => safeLog(ctx, 'warn', message),
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true })
      const temp = `${cfg.statePath}.${process.pid}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
      fs.renameSync(temp, cfg.statePath)
      lastMtime = mtimeOf(cfg.statePath)
    } catch (error) {
      log.warn(`could not persist quota state to ${cfg.statePath}: ${describeError(error)}`)
    }
  }

  function refreshStateFromDisk() {
    const mtime = mtimeOf(cfg.statePath)
    if (mtime === 0 || mtime === lastMtime) return
    lastMtime = mtime
    const loaded = readState(cfg.statePath)
    if (loaded === undefined) return
    const changed = loaded.mode !== state.mode || loaded.until !== state.until || JSON.stringify(loaded.quarantine) !== JSON.stringify(state.quarantine)
    state = loaded
    if (changed) {
      log.info(`state reloaded from disk: ${state.mode}; quarantined ${Object.keys(state.quarantine).length}`)
      schedule()
    }
  }

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  /** Drop quarantine entries whose window has passed. */
  function expireQuarantine() {
    const now = Date.now()
    let changed = false
    for (const [model, entry] of Object.entries(state.quarantine)) {
      if (entry.until <= now) {
        delete state.quarantine[model]
        changed = true
        log.info(`${model}: quarantine expired; the next request tries OpenCode again`)
      }
    }
    if (changed) {
      state.updatedAt = now
      saveState()
    }
    return changed
  }

  function pendingWork() {
    return state.mode === 'fallback' || Object.keys(state.quarantine).length > 0
  }

  function schedule() {
    clearTimer()
    if (disposed || !pendingWork()) return
    const now = Date.now()
    const expiries = Object.values(state.quarantine).map((entry) => entry.until)
    const next = state.mode === 'fallback' && state.until > 0 ? Math.min(state.until, ...(expiries.length > 0 ? expiries : [state.until])) : expiries.length > 0 ? Math.min(...expiries) : 0
    const target = next > now ? next : now + cfg.minProbeDelayMs
    timer = setTimeout(() => {
      timer = undefined
      void runProbe()
    }, Math.min(Math.max(0, target - now), 2 ** 31 - 1))
    timer.unref?.()
  }

  async function resolveKey() {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(cfg.apiKeyRef)
        if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value
      } catch (error) {
        log.warn(`could not resolve ${cfg.apiKeyRef}: ${describeError(error)}`)
      }
    }
    const ambient = process.env[cfg.apiKeyRef]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  async function probeUsage() {
    const key = await resolveKey()
    if (key === undefined) {
      hasKey = false
      return undefined
    }
    hasKey = true
    try {
      const response = await fetch(cfg.usageUrl, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        log.warn(`usage probe answered HTTP ${response.status}`)
        return undefined
      }
      const usage = (await response.json())?.usage
      return usage !== null && typeof usage === 'object' ? usage : undefined
    } catch (error) {
      log.warn(`usage probe failed: ${describeError(error)}`)
      return undefined
    }
  }

  function recordUsage(usage) {
    state.usage = usage
    state.checkedAt = Date.now()
    state.updatedAt = Date.now()
  }

  async function runProbe() {
    if (disposed) return
    if (expireQuarantine()) return schedule()
    if (state.mode !== 'fallback') return schedule()
    const usage = await probeUsage()
    if (disposed) return
    if (usage !== undefined) recordUsage(usage)
    if (usage !== undefined && !isExhausted(usage)) {
      resume('allowance recovered')
      return
    }
    state.until = usage === undefined ? Date.now() + cfg.probeIntervalMs : nextProbeAt(usage, Date.now(), cfg.probeIntervalMs)
    state.updatedAt = Date.now()
    saveState()
    schedule()
  }

  function planFallback(reason, failure, delayMs) {
    state.mode = 'fallback'
    state.reason = reason
    state.until = Date.now() + Math.max(cfg.minProbeDelayMs, delayMs)
    state.lastFailure = failure === undefined ? state.lastFailure ?? null : { code: String(failure.code ?? 'UNKNOWN'), status: typeof failure.status === 'number' ? failure.status : undefined, message: String(failure.message ?? '').slice(0, 400), at: Date.now() }
    state.updatedAt = Date.now()
    saveState()
    schedule()
    log.warn(`plan-wide fallback to the DeepSeek account (${reason}); next probe in ~${Math.round(Math.max(cfg.minProbeDelayMs, delayMs) / 60000)} min`)
  }

  function quarantineModel(model, reason, untilMs) {
    state.quarantine[model] = { until: untilMs, reason }
    state.updatedAt = Date.now()
    saveState()
    schedule()
    log.warn(`${model} is quarantined (${reason}); only that model falls back until ${new Date(untilMs).toLocaleTimeString()}`)
  }

  function resume(reason) {
    const changed = state.mode !== 'primary' || Object.keys(state.quarantine).length > 0
    state.mode = 'primary'
    state.reason = reason
    state.until = 0
    state.quarantine = {}
    state.updatedAt = Date.now()
    saveState()
    clearTimer()
    if (changed) log.info(`OpenCode Go is usable again (${reason})`)
  }

  function providerRegistered(provider) {
    try {
      return ctx.llm.listProviders().some((entry) => entry.id === provider)
    } catch {
      return false
    }
  }

  async function effortFor(target, requested) {
    if (requested === undefined || requested === null || requested === '') return undefined
    const key = `${target.provider}\u0000${target.model}`
    let efforts = effortCache.get(key)
    if (efforts === undefined) {
      try {
        const info = await ctx.llm.resolveModelInfo(target.provider, target.model)
        efforts = (info?.reasoning?.efforts ?? []).map((effort) => effort.id)
      } catch {
        return undefined
      }
      effortCache.set(key, efforts)
      const eviction = setTimeout(() => effortCache.delete(key), EFFORT_CACHE_TTL_MS)
      eviction.unref?.()
    }
    if (efforts.length === 0) return undefined
    if (efforts.includes(requested)) return requested
    if ((requested === 'off' || requested === 'minimal') && efforts.includes('low')) return 'low'
    if (efforts.includes('high')) return 'high'
    return efforts[efforts.length - 1]
  }

  function matchRoute(config) {
    for (const route of cfg.routes) {
      if (config.provider === route.primary.provider && config.model === route.primary.model) return { route, side: 'primary' }
      if (config.provider === route.fallback.provider && config.model === route.fallback.model) return { route, side: 'fallback' }
    }
    return undefined
  }

  /** Whether this route's primary model must currently fall back. */
  function primaryBlocked(route) {
    if (state.mode === 'fallback') return true
    const entry = state.quarantine[route.primary.model]
    return entry !== undefined && entry.until > Date.now()
  }

  async function route(config) {
    if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return config
    refreshStateFromDisk()
    expireQuarantine()
    const match = matchRoute(config)
    if (match === undefined) return config
    const desired = primaryBlocked(match.route) ? 'fallback' : 'primary'
    if (match.side === desired) return config
    const target = desired === 'primary' ? match.route.primary : match.route.fallback
    if (!providerRegistered(target.provider)) return config
    if (desired === 'primary' && !hasKey) return config
    const reasoningEffort = await effortFor(target, config.reasoningEffort)
    log.info(`route ${match.side} -> ${desired}: ${target.provider}/${target.model}${reasoningEffort === undefined ? '' : ` @ ${reasoningEffort}`}`)
    return retarget(config, target, reasoningEffort)
  }

  /** The model the failed attempt actually used, from the durable request header. */
  function failedModel(payload) {
    try {
      const header = payload?.agent?.session?.requestHeader?.()
      const config = header?.config ?? header?.header?.config
      if (typeof config?.model === 'string' && typeof config?.provider === 'string' && config.provider === cfg.routes.find((route) => route.primary.provider === payload.provider)?.primary.provider) return config.model
      return typeof config?.model === 'string' ? config.model : undefined
    } catch {
      return undefined
    }
  }

  async function recover(payload, next) {
    const failure = payload?.failure
    if (failure === undefined || failure === null) return next()
    const provider = payload.provider
    const routes = cfg.routes.filter((route) => route.primary.provider === provider)
    if (routes.length === 0) return next()
    const code = String(failure.code ?? '').toUpperCase()
    const model = failedModel(payload)

    if (AUTH_CODES.has(code)) {
      planFallback(`OpenCode authentication failed (${code})`, failure, cfg.unconfirmedDelayMs)
      return { kind: 'retry' }
    }

    const hard = code === 'QUOTA' || code === 'ACCOUNT_QUOTA'
    const soft = code === 'RATE_LIMIT' || failure.status === 429
    if (!hard && !soft) return next()

    const usage = await probeUsage()
    if (usage !== undefined) recordUsage(usage)
    const usageExhausted = usage !== undefined && isExhausted(usage)
    const quoted = QUOTA_MESSAGE.test(String(failure.message ?? ''))

    // A transient rate limit with room left belongs to the provider retry policy.
    if (!hard && !usageExhausted && !quoted) return next()

    if (model !== undefined) {
      const delay = usage === undefined ? cfg.modelQuarantineMs : Math.max(cfg.minProbeDelayMs, nextProbeAt(usage, Date.now(), cfg.probeIntervalMs) - Date.now())
      quarantineModel(model, hard ? 'reported quota exhaustion' : 'quota window exhausted', Date.now() + Math.min(delay, cfg.modelQuarantineMs))
      return { kind: 'retry' }
    }

    const delay = usage === undefined ? cfg.unconfirmedDelayMs : nextProbeAt(usage, Date.now(), cfg.probeIntervalMs) - Date.now()
    planFallback(hard ? 'openCode quota exhausted' : 'openCode quota window exhausted', failure, delay)
    return { kind: 'retry' }

  }

  const disposeRoute = ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    try {
      return await route(base)
    } catch (error) {
      log.warn(`could not rewrite the request route: ${describeError(error)}`)
      return base
    }
  }, { prepend: true })

  const disposeRecover = ctx.on('agent/request-error', (payload, next) => {
    if (disposed || lifetime.signal.aborted) return Promise.resolve(undefined)
    return recover(payload, next).catch((error) => {
      log.warn(`request recovery failed: ${describeError(error)}`)
      return next()
    })
  }, { prepend: true })

  ctx.effect(() => () => {
    disposed = true
    disposeRoute()
    disposeRecover()
    clearTimer()
    if (bootTimer !== undefined) clearTimeout(bootTimer)
    lifetime.abort(new Error('opencode-quota-router disposed'))
  }, 'opencode-quota-router: stop routing and probing')

  const quarantined = Object.keys(state.quarantine)
  log.info(`watching ${cfg.routes.length} route(s); mode ${state.mode}; quarantined ${quarantined.length === 0 ? 'none' : quarantined.join(', ')}`)

  schedule()
  bootTimer = setTimeout(() => {
    bootTimer = undefined
    void (async () => {
      if (disposed) return
      if (expireQuarantine()) return schedule()
      const usage = await probeUsage()
      if (disposed) return
      if (usage !== undefined) {
        recordUsage(usage)
        if (isExhausted(usage) && state.mode !== 'primary') {
          planFallback('allowance still exhausted', undefined, nextProbeAt(usage, Date.now(), cfg.probeIntervalMs) - Date.now())
          return
        }
        if (state.mode === 'fallback' && !isExhausted(usage)) {
          resume('allowance available')
          return
        }
      }
      saveState()
      schedule()
    })().catch((error) => log.warn(`startup probe failed: ${describeError(error)}`))
  }, 1500)
  bootTimer.unref?.()
}

function safeLog(ctx, level, message) {
  try {
    ctx.logger[level](`opencode-quota-router: ${message}`)
  } catch {
    /* logging must never break routing */
  }
}

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
