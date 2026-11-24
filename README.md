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
Baseline images: `gateway` `v1.0.0-ui1`, every other service `v1.0.0` (also `loadgen` and `chaos-api` `v1.0.0`).
Fault images: `risk:v1.0.1` from `demo/bad-risk-check` (S1) and `portfolio:v1.0.1` from `demo/portfolio-leak` (S4).

Build each with Actions -> `build-image` (inputs `service`, `git_ref`, `tag`):

| service | git_ref | tag |
|---|---|---|
| gateway | main | v1.0.0-ui1 |
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
S2 sends the decoy change event on portfolio, waits `S2_DECOY_DELAY_S` (default 60), then sets account `DB_MAX_POOL=3`.
