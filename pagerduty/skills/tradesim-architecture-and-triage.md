# TradeSim architecture and triage

Use this when a TradeSim incident arrives. TradeSim is a small online trading app on Kubernetes (namespace `tradesim`).
PagerDuty services are named `tradesim-<name>`; alerts arrive with `component` set to the bare service name.

## Services and dependencies

| Service | Port | Calls | Notes |
|---|---|---|---|
| gateway | 8080 | order, portfolio, market-data, account | serves the UI and `/api/*` |
| order | 8081 | risk, account | `POST /orders`: risk check, debit, store |
| risk | 8082 | account | `POST /check` returns approved or not |
| account | 8083 | postgres | owns balances; everything that moves money depends on it |
| portfolio | 8084 | market-data, account | positions and live P&L |
| market-data | 8085 | redis | price simulator, ticks every 2s |
| postgres, redis | | | datastores |

Every service logs one JSON line per request: `ts, level, service, version, traceId, route, status, latency_ms, msg`.
A failed downstream call returns 502/503 with `{error, upstream, traceId}`, so one traceId can be followed across services.

## Triage order

1. **Find the deepest failing dependency, not the loudest service.** Errors cascade upward: account failing makes risk,
   order, portfolio and gateway fail. If account is unhealthy, start there. If only risk and order alert, look at risk.
2. **Read the alert's `custom_details`**: `check`, `value`, `threshold`, `sample_log` (the last error line of that
   service), `scenario` and `demo_mode`.
3. **Check what changed in the last 30 minutes.** Change events come as `tradesim-<service> deploy ...` and
   `tradesim-<service> config: KEY old -> new`. The newest change on the deepest failing service is the prime suspect.
   A change on a service that is not failing (for example a logging format change on portfolio) is usually a decoy.
4. **Confirm with evidence before acting**: pod status and restart count, `logs --previous` for crash loops, the
   `/metrics` fields (`error_rate`, `p95_ms`, `db_pool_in_use`, `db_pool_max`, `last_tick_age_s`).

## Alert checks you will see

| dedup key | Meaning |
|---|---|
| `<svc>:health` | `/health` failing for 2 cycles (30s) |
| `<svc>:error_rate` | more than 20% errors with at least 10 requests |
| `<svc>:latency` | p95 above 2000ms (warning) |
| `market-data:feed_stale` | no price tick for more than 30s, nothing else errors |
| `<svc>:restarts` | container restarted (OOMKilled is called out) |
| `<svc>:crashloop` | pod in CrashLoopBackOff |

## Silent failures

`market-data:feed_stale` can be the only signal: no errors anywhere, `/health` stays green for the first 30s, quotes are
still served but frozen. Treat stale prices as a trading-integrity problem even though no request fails.
