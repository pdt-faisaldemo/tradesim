#!/usr/bin/env bash
# Usage: config.sh <service> KEY=VALUE [KEY=VALUE ...] "<summary>"
# Patches tradesim-<service>-config, restarts the Deployment, sends change event "tradesim-<service> config: KEY old -> new[, ...]".
set -uo pipefail
. "$(dirname "$0")/lib.sh"

if [ $# -lt 3 ] || [[ "$2" != *=* ]]; then
  echo "usage: $0 <service> KEY=VALUE [KEY=VALUE ...] \"<summary>\"" >&2
  exit 2
fi
service=$1
shift
summary=${*: -1}
set -- "${@:1:$#-1}"
need jq
cm="tradesim-$service-config"

current=$($K -n "$NS" get cm "$cm" -o json) || die "configmap $cm not found in $NS"
patch='{"data":{}}'
changes=""
for pair in "$@"; do
  [[ "$pair" == *=* ]] || die "expected KEY=VALUE, got '$pair'"
  key=${pair%%=*}
  value=${pair#*=}
  old=$(printf '%s' "$current" | jq -r --arg k "$key" '.data[$k] // "(unset)"')
  log "$cm: $key $old -> $value"
  patch=$(printf '%s' "$patch" | jq -c --arg k "$key" --arg v "$value" '.data[$k] = $v')
  changes="${changes:+$changes, }$key $old -> $value"
done
kube -n "$NS" patch cm "$cm" --type merge -p "$patch" || die "patch failed"
kube -n "$NS" rollout restart "deploy/$service" || die "restart failed"
kube -n "$NS" rollout status "deploy/$service" --timeout=60s || warn "rollout of $service did not complete in 60s (continuing)"
"$(dirname "$0")/change-event.sh" "$service" "tradesim-$service config: $changes ($summary)"
