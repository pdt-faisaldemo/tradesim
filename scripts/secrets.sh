#!/usr/bin/env bash
# Usage: secrets.sh
# Copies the settings found in ~/.tradesim.env (or the environment) into Secret tradesim-secrets in BOTH namespaces
# (tradesim and platform). Only keys that are set are written, existing keys such as DB_PASSWORD are left alone.
# Never prints values. redeploy.sh runs this before restarting, so a changed key reaches the pods.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
need jq

keys="PD_ROUTING_KEY PD_API_TOKEN PD_FROM_EMAIL PD_SERVICE_IDS OPS_USER OPS_PASSWORD GHCR_OWNER GITHUB_REPO_URL AWS_REGION"
for v in $(env | sed -n 's/^\(PD_CHANGE_KEY_[A-Z0-9_]*\)=.*/\1/p'); do keys="$keys $v"; done

data='{}'
found=""
for k in $keys; do
  v=${!k:-}
  [ -n "$v" ] || continue
  data=$(jq -c --arg k "$k" --arg v "$v" '. + {($k): $v}' <<<"$data")
  found="$found $k"
done
[ -n "$found" ] || { warn "none of the expected settings are set (looked in $ENV_FILE and the environment)"; exit 0; }

for ns in "$NS" platform; do
  $K get ns "$ns" >/dev/null 2>&1 || { warn "namespace $ns does not exist yet (run scripts/bootstrap.sh)"; continue; }
  $K -n "$ns" get secret tradesim-secrets >/dev/null 2>&1 || $K -n "$ns" create secret generic tradesim-secrets >/dev/null || die "could not create tradesim-secrets in $ns"
  $K -n "$ns" patch secret tradesim-secrets --type merge -p "$(jq -c '{stringData: .}' <<<"$data")" >/dev/null || die "could not patch tradesim-secrets in $ns"
  log "$ns/tradesim-secrets: set$found"
done
