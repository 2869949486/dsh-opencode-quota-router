# dsh-opencode-quota-router

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that spends an OpenCode Go
subscription before the user's DeepSeek account balance, **per model**.

OpenCode meters every model against its own monthly limit (5-hour = 20% of it, weekly = 50%, monthly = 100%),
so an exhausted DeepSeek V4 Pro budget must not drag DeepSeek V4.1 Flash back to the DeepSeek account.

## What it does

- Every routed request prefers the OpenCode Go route (`opencode-go`).
- When one model's allowance runs out, **only that model** falls back to the DeepSeek account; other models keep
  using the plan.
- While anything is falling back, a zero-token `GET /inference/go/v1/usage` probe runs every 30 minutes
  (or at the rolling-window reset) and switches back automatically when the allowance recovers.
- No session reload: both switches happen at step boundaries through the `agent/request` /
  `agent/request-error` waterfalls. Streaming requests and other agents are never interrupted.

Both listeners register with `prepend: true`, because a Cordis waterfall returns the outermost listener's
value; an observer appended later would otherwise shadow the rewrite.

## Routes

| Primary (OpenCode Go) | Fallback (DeepSeek account) |
|---|---|
| `opencode-go/deepseek-v4.1-flash` | `deepseek-account/deepseek-flash` |
| `opencode-go/deepseek-v4-pro` | `deepseek-account/deepseek-v4-pro` |

The bundle also declares the `opencode-go` catalog route (pruned to the models the live endpoint serves) and an
`opencode-free` route for the free models (`beam-free`, `iceman-contributor-free`).

## Install

```sh
dsh plugin --profile <profile> add dsh-opencode-quota-router
```

Then store the OpenCode key through the credentials service (the web Models page does this) under the reference
name `OPENCODE_API_KEY`, or export it in the launching environment.

## Configuration

The bundle patch carries defaults; override the row `opencode-quota-router` in your profile patch:

```yaml
- id: opencode-quota-router
  config:
    usageUrl: https://opencode.ai/inference/go/v1/usage
    apiKeyRef: OPENCODE_API_KEY
    probeIntervalMs: 1800000
    modelQuarantineMs: 1800000
    routes:
      - primary: { provider: opencode-go, model: deepseek-v4.1-flash }
        fallback: { provider: deepseek-account, model: deepseek-flash }
```

Optional fields: `minProbeDelayMs`, `unconfirmedDelayMs`, `modelQuarantineMs`, `statePath`.

## State

`$DSH_HOME/opencode-quota-router.json`:

```json
{ "version": 2, "mode": "primary", "quarantine": {}, "usage": { }, "updatedAt": 0 }
```

- `mode: "fallback"` — plan-wide fallback (bad credential or unattributable failure).
- `quarantine` — one entry per exhausted model; only that model falls back until `until`.

Editing the file is picked up before the next step, so it doubles as a manual override:

```json
{ "version": 2, "mode": "fallback", "until": 1793446953969, "quarantine": {} }
```

## Test

```sh
node test.mjs
```

Exercises routing in both directions, per-model quarantine, quarantine expiry, plan-wide fallback, and the
"transient rate limit is not a quarantine" rule against a fake Cordis context.

## License

MIT
