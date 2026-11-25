# tradesim
This is the master tradesim repo for demo. See CLAUDE.md for the design and TASKS.md for the build phases.

## Building an image
GitHub -> Actions -> `build-image` -> Run workflow (inputs: `service`, `git_ref`, `tag`).
Pushes `ghcr.io/<owner>/tradesim-<service>:<tag>` (linux/amd64). The tag is also baked in as `VERSION`
(shown in logs and `/metrics`). First push of a new package: set it to Public in the package settings.

Local build (context is the repo root):
`docker build -f services/account/Dockerfile --build-arg VERSION=v1.0.0 -t tradesim-account .`

## P1: deploy account on k3s
```
git clone https://github.com/pdt-faisaldemo/tradesim.git && cd tradesim
KUBECTL="sudo k3s kubectl" scripts/bootstrap.sh
```
`bootstrap.sh` is idempotent: namespaces, `tradesim-secrets` (random `DB_PASSWORD`, created once), ConfigMaps,
Postgres, the seed Job (customer `c-1001`, cash 41870.00) and the account Deployment/Service.

## P2: remaining services (risk, order, portfolio, market-data, gateway)
Images: build all six at `v1.0.0` from `main` (Actions -> `build-image`, once per service), make each package Public, then:
```
git pull
KUBECTL="sudo k3s kubectl" scripts/bootstrap.sh     # re-runs the seed job (adds orders/positions tables), Redis, all services, Ingress
sudo dnf install -y jq
scripts/smoke.sh                                    # BASE=http://localhost by default (Traefik on port 80)
```
Through the gateway (`http://<EC2_IP>/`): `/api/health-summary`, `/api/quotes`, `/api/accounts/c-1001`,
`/api/portfolio/c-1001`, `/api/orders`, `POST /api/orders {"symbol":"NVDA","qty":50}`.

## P4: fault scenarios, scripts, loadgen
Baseline images: `gateway` `v1.0.0-ui5`, every other service `v1.0.0` (also `loadgen` and `chaos-api` `v1.0.0`).
Fault images: `risk:v1.0.1` from `demo/bad-risk-check` (S1) and `portfolio:v1.0.1` from `demo/portfolio-leak` (S4).

Build each with Actions -> `build-image` (inputs `service`, `git_ref`, `tag`):

| service | git_ref | tag |
|---|---|---|
| gateway | main | v1.0.0-ui5 |
| account, market-data, risk, order, portfolio | main | v1.0.0 |
| loadgen, chaos-api | main | v1.0.0 |
| risk | demo/bad-risk-check | v1.0.1 |
| portfolio | demo/portfolio-leak | v1.0.1 |

`chaos-api` here is a minimal flags/state server (P6 grows it into the /ops console). Make new packages Public.

### PagerDuty keys on EC2 (never in the repo)
```
install -m 600 /dev/null ~/.tradesim.env
nano ~/.tradesim.env        # start from scripts/tradesim.env.example; set KUBECTL, PD_* values
```
`scripts/lib.sh` sources `~/.tradesim.env` (override with `TRADESIM_ENV_FILE`). `.env` files are git-ignored.

### Scenarios
```
scripts/scenario.sh <S1|S2|S3|S4|S5|COMBO> [quick|deep]   # refuses if one is already active (FORCE=1 overrides)
scripts/reset.sh                                          # prints ALL HEALTHY
```
S2 sends the decoy change event on portfolio, waits `S2_DECOY_DELAY_S` (default 60), then sets account `DB_MAX_POOL=1` and `DB_POOL_TIMEOUT_MS=300`, each account query then holds its connection 1000ms (only while `DB_MAX_POOL` < 10), and loadgen goes from 5 to 20 customers (account answers 503 `db pool exhausted: 1/1 in use, waited 300ms`; reset restores 50 / 2000 / no hold / 5 customers). `scripts/verify-s2.sh` prints per-service error rates and the pool stats; `scripts/verify-s5.sh` prints the account pod's status, restart count and last log lines.

### Incident panel (gateway UI)
Right panel (incident status) and left panel (Reliability delivered) are fed by `GET /api/incident-panel`; the status
banner and the health dots use the same data, so they always agree. The gateway polls chaos-api `/state` every 2s and,
when `PD_API_TOKEN` and `PD_SERVICE_IDS` are in `tradesim-secrets`, the PagerDuty REST API every 5s; without them (or if
the API fails) it uses health and error-rate signals only.

- A dot is red when `/health` fails or the service's `error_rate_30s` (from `/metrics`) is above 0.2 with 10+ requests.
- The story lives in chaos-api (`/state` -> `story`), so it survives reloads and looks the same in every browser. Phases
  only move forward: idle -> incident (scenario.sh starts it; "Investigating..." until the first unhealthy signal, then
  Detected and the timer start) -> fixing (`scripts/fix.sh`) -> resolved (all services healthy 15s in a row after the
  fix, or the PagerDuty incident resolved). Health never moves it backwards. S4's restart is a partial fix: it stays in
  fixing ("Pod restarted, issue persists"); `scripts/fix.sh S4R` deploys v1.0.2.
- Clear paths (the only way back to idle, both panels disappear): `scripts/reset.sh` (environment too),
  `scripts/clear-story.sh` (story only), or `scripts/scenario.sh <S>` when the story is resolved (auto-clear). A
  scenario still in incident or fixing is refused. Check a scenario end to end with `scripts/verify-story.sh <S>`.
- "Root cause found" shows the `Panel summary:` line of the first incident note starting `SRE Agent:` (max 60 chars,
  cut at a word, with a link to the incident); without that line it shows the scenario's preset text. The left panel
  always uses preset headlines.
- During `reset.sh`, chaos-api `/state` has `resetting: true`: dots grey, banner "Applying scheduled updates. Back in a
  moment.", panel "Applying updates...". reset.sh only restarts Deployments that differ from the baseline.
- S3 shows "Trades at stale prices" (orders filled while the price feed was older than 30s, with their total value)
  instead of "Revenue at risk".

Tunables live in `k8s/base/configmaps/tradesim-gateway-config.yaml`: `REVENUE_AT_RISK_PER_S` (500), `ENGINEER_HOURLY_RATE` (150),
`DEFAULT_ENGINEERS` (1), `TYPICAL_COMPARISON`.
Enable PagerDuty data on EC2:
```
sudo k3s kubectl -n tradesim patch secret tradesim-secrets --type merge \
  -p "{\"stringData\":{\"PD_API_TOKEN\":\"...\",\"PD_SERVICE_IDS\":\"PXXXX,PYYYY\"}}"
sudo k3s kubectl -n tradesim rollout restart deploy/gateway
```
