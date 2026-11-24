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
