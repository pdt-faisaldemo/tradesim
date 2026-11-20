# TradeSim: PagerDuty incident-response demo

You are building TradeSim, a small online-trading app on Kubernetes (k3s) whose purpose is to FAIL ON PURPOSE so PagerDuty (SRE Agent, SRE Workbench, Rundeck automation), AWS DevOps Agent and Devin can be demonstrated. Correctness of the trading logic matters less than: realistic cascades, clear failure symptoms, clean logs, fast reset.

## Golden rules
- Keep it simple and boring. Node.js 20 + Express, plain JavaScript (no TypeScript, no build step), vanilla JS front end. No frameworks beyond Express, `pg`, `ioredis`.
- One service = one folder, one Dockerfile, one k8s Deployment + Service. Same name everywhere (folder, image, Deployment, Service, log field `service`, PagerDuty service `tradesim-<name>`).
- Every service MUST expose: `GET /health` (200 ok / 503 + reason), `GET /metrics` (JSON, see below), and log one JSON line per request to stdout.
- Every failure mode is switched by an image tag, a ConfigMap value or a flag, and is reversible in seconds by `scripts/reset.sh`.
- Never hard-code secrets. Read them from env (k8s Secrets).
- Build one service end to end first (`account`), then copy its pattern. Reuse `shared/`.
- After each phase: run the phase's acceptance checks and stop. Do not start the next phase unprompted.

## Repository layout
```
services/
  gateway/        # serves UI (public/) + routes /api/*
  order/  risk/  account/  portfolio/  market-data/
platform/
  alert-bridge/   # polls services + k8s, sends PagerDuty alerts
  chaos-api/      # hidden /ops console + scenario/reset endpoints (has kubectl)
  loadgen/        # synthetic customers, constant traffic
shared/           # logger.js, metrics.js, health.js, http.js (copied into each image at build)
k8s/
  base/           # namespace tradesim: deployments, services, configmaps, postgres, redis, seed job
  platform/       # namespace platform: alert-bridge, chaos-api, loadgen, fluent-bit
  automation/     # namespace automation: runner RBAC (Role in tradesim only)
scripts/          # deploy.sh, config.sh, change-event.sh, reset.sh, scenario.sh, bootstrap.sh
rundeck/          # job scripts: diagnose.sh, restart.sh, rollback.sh, restore-config.sh, deploy-known-fix.sh, reset.sh
.github/workflows/build.yml   # workflow_dispatch: inputs service, git_ref, tag -> push ghcr.io/<owner>/tradesim-<service>:<tag>
```

## Services and dependencies
| Service | Port | Calls | Owns | Purpose |
|---|---|---|---|---|
| gateway | 8080 | order, portfolio, market-data, account | - | Serves UI; `/api/*` routes; `/api/health-summary`; `/api/status` |
| order | 8081 | risk, account | orders table | `POST /orders {symbol, qty}` -> risk check -> debit account -> store order |
| risk | 8082 | account | - | `POST /check {customerId, cost}` -> `{approved, reason}` |
| account | 8083 | postgres | accounts table | `GET /accounts/:id`, `POST /accounts/:id/debit`, `POST /accounts/:id/credit` |
| portfolio | 8084 | market-data, account | positions table | `GET /portfolio/:id` positions + live P&L + cash |
| market-data | 8085 | redis | price simulator | `GET /quotes` -> `{asOf, prices}`; ticks every 2s into Redis |

Demo customer id `c-1001`, name Jordan Lee, starting cash 41870.00. About 10 tickers (NVDA, AAPL, MSFT, AMZN, GOOGL, META, TSLA, JPM, V, NFLX) with random-walk prices.

Inter-service calls: `shared/http.js` with a 2s timeout; on downstream failure return 502/503 with `{error, upstream, traceId}` and log it. This is what creates visible cascades. Propagate an `x-trace-id` header.

## Logging and metrics conventions
Log line (one per request and per notable event):
`{"ts","level","service","version","traceId","route","status","latency_ms","msg", ...extra}`
Use clear, greppable messages for failures, e.g. `"db pool exhausted: 3/3 in use, waited 2000ms"`, `"order rejected by risk check cost=9211 buyingPower=41870"`, `"cannot connect to DB_HOST=postgress"`.

`GET /metrics` JSON (rolling 60s window): `{service, version, requests, errors, error_rate, p95_ms, uptime_s, memory_rss_mb, ...service_specific}`. market-data adds `last_tick_age_s`. account adds `db_pool_in_use`, `db_pool_max`.

`/health` returns 503 when the service cannot do its job (DB unreachable, pool saturated for >10s, feed stale >30s).

## Configuration (ConfigMap per service, `tradesim-<name>-config`)
account: `DB_HOST=postgres`, `DB_MAX_POOL=50`, `DB_POOL_TIMEOUT_MS=2000`. Others: upstream URLs, `VERSION`. Baseline copies live in `k8s/base/configmaps/` and are what reset re-applies.

## Fault mechanics (the scenarios)
| ID | Type | Mechanism | Expected symptom |
|---|---|---|---|
| S1 | Code | Image `risk:v1.0.1` built from branch `demo/bad-risk-check`: `return cost > buyingPower` (inverted) | Valid orders rejected "insufficient buying power"; risk/order error-rate alerts |
| S2 | Config | ConfigMap account `DB_MAX_POOL=3` + restart; each account query holds the connection ~300ms (`pg_sleep(0.3)`) so loadgen saturates it. Decoy first: change event on portfolio "update logging format" 60s earlier | account pool exhausted -> risk, order, gateway, portfolio error. Deepest cascade |
| S3 | Silent | Flag `feedPaused=true` (market-data polls chaos-api `GET /flags` every 5s) stops ticks; quotes still served | No errors; prices + "Prices as of" freeze; `last_tick_age_s` grows; freshness alert |
| S4 | Memory leak | Image `portfolio:v1.0.1` from branch `demo/portfolio-leak`: appends ~1MB per request to a module-level array; memory limit 256Mi | Slow, then OOMKilled restarts; restart/OOM alerts |
| S5 | k8s config | Patch account Deployment env `DB_HOST=postgress` (typo) | account CrashLoopBackOff; everything downstream fails; `logs --previous` shows the cause |
| S1R/S4R | Repeat | Same as S1/S4; fixed by "Deploy known fix" to `v1.0.2` (Devin's fix, built later) | Same symptoms |

Images: `v1.0.0` good (main), `v1.0.1` bad (demo branch), `v1.0.2` Devin fix (built after Devin's PR merges). Registry: `ghcr.io/<owner>/tradesim-<service>:<tag>` (public packages).

## Scripts (all idempotent, all print what they do)
- `scripts/change-event.sh <service> "<summary>" [link_url]` -> POST `https://events.pagerduty.com/v2/change/enqueue` with the routing key from env `PD_KEY_<SERVICE>`.
- `scripts/deploy.sh <service> <tag> "<summary>" [commit_url]` -> `kubectl -n tradesim set image deploy/<service> <service>=<image>:<tag>`, wait rollout (60s timeout, non-fatal for S4/S5), send change event.
- `scripts/config.sh <service> KEY=VALUE "<summary>"` -> patch ConfigMap, rollout restart, change event "tradesim-<service> config: KEY old -> new".
- `scripts/scenario.sh <S1|S2|S3|S4|S5|COMBO> [quick|deep]` -> performs the fault (incl. decoy for S2), refuses if another scenario is active (state in chaos-api).
- `scripts/reset.sh` -> flags off; all deployments to v1.0.0 and baseline ConfigMaps/env; rollout status; re-run seed job; resolve open incidents on TradeSim services via PagerDuty REST API (`PD_API_TOKEN`, `PD_FROM_EMAIL`, service ids in `PD_SERVICE_IDS`); print "ALL HEALTHY" when every /health is 200. Target under 60s.

## Platform components
**alert-bridge** (every 15s): for each service fetch `/metrics` and `/health`; read pods in `tradesim` via the k8s API (restartCount, lastState OOMKilled, waiting reason CrashLoopBackOff). Checks and thresholds (env-configurable):
- health failing 2 cycles -> critical
- error_rate > 0.2 with requests >= 10 -> critical
- p95_ms > 2000 -> warning
- market-data last_tick_age_s > 30 -> critical ("price feed stale")
- restart count increased or OOMKilled -> critical
- CrashLoopBackOff -> critical
Send Events API v2 `trigger` with `dedup_key = <service>:<check>`, `source = tradesim-k3s`, `component = <service>`, `custom_details` {check, threshold, value, sample_log (last error line, fetched from the service's `/debug/last-error`), demo_mode (from chaos-api)}. Send `resolve` after 2 healthy cycles. Routing keys from Secret `pagerduty-keys` (`PD_KEY_GATEWAY`, ...). Log every send.

**chaos-api** (namespace platform, ServiceAccount with patch on deployments/configmaps/jobs in tradesim; image includes kubectl + scripts/): 
- `GET /flags`, `GET /state` (active scenario, mode)
- `POST /scenario/:id {mode}` -> runs scripts/scenario.sh
- `POST /reset` -> runs scripts/reset.sh, streams output
- `GET /ops` -> hidden console (basic auth `OPS_USER`/`OPS_PASSWORD`): one big button per scenario with a one-line description, Quick/Deep toggle, COMBO (S3+S4), RESET ALL, live health of every service, active scenario, last script output.

**loadgen**: 5 synthetic customers, each every 2s: get quotes, get portfolio, place a small order. Never stops. This traffic is what makes error rates and the memory leak real.

**fluent-bit** DaemonSet: container logs -> CloudWatch Logs group `/tradesim/containers` (region from env; credentials via the EC2 instance role).

## UI (gateway/public, vanilla JS, light/dark)
Pages: Dashboard (cash, account value, market watch with "Prices as of HH:MM:SS"), Trade (buy form, result message, recent orders), Portfolio (positions, P&L). Every page:
- Service health strip at the bottom: 6 dots from `/api/health-summary` (poll 3s), red when unhealthy.
- Status banner "Trading is degraded. We're working on it." when `/api/status` reports an open TradeSim incident (gateway queries PagerDuty REST API read-only; fall back to health-summary if no token).
- Errors show a friendly message + reference id (traceId), never an endless spinner.

## Rundeck job scripts (rundeck/, run by the PD Automation Runner with kubectl, namespace tradesim only)
- `diagnose.sh <deployment>`: get pods -o wide, describe pod (last 30 lines), logs --tail=100, logs --previous --tail=50 (ignore error), restart counts, recent events. Plain-text output with section headers.
- `restart.sh <deployment>`: rollout restart + rollout status.
- `rollback.sh <deployment>`: rollout undo + rollout status.
- `restore-config.sh <service>`: apply baseline ConfigMap and env, rollout restart.
- `deploy-known-fix.sh <service>`: deploy v1.0.2 via scripts/deploy.sh.
- `reset.sh`: calls scripts/reset.sh.

## Environment / secrets (Secret `tradesim-secrets` in tradesim and platform)
`PD_KEY_<SERVICE>` for gateway, order, risk, account, portfolio, market-data, postgres, redis; `PD_API_TOKEN`; `PD_FROM_EMAIL`; `PD_SERVICE_IDS` (comma list); `OPS_USER`; `OPS_PASSWORD`; `GHCR_OWNER`; `GITHUB_REPO_URL`; `AWS_REGION`.

## Definition of done (whole project)
1. Happy path: buy succeeds, portfolio and prices update, all 6 health dots green.
2. Each of S1-S5 from /ops produces its symptom in the UI within 2 minutes and PagerDuty alerts on the expected services.
3. Every scenario has a working Rundeck remediation.
4. RESET ALL returns to healthy in under 60s and resolves TradeSim incidents.
5. `kubectl -n tradesim get pods` all Running after reset; no manual steps.
