#!/usr/bin/env bash
# Usage: config.sh <service> KEY=VALUE "<summary>"
# Patches tradesim-<service>-config, restarts the Deployment, sends change event "tradesim-<service> config: KEY old -> new".
set -uo pipefail
. "$(dirname "$0")/lib.sh"

if [ $# -lt 3 ] || [[ "$2" != *=* ]]; then
  echo "usage: $0 <service> KEY=VALUE \"<summary>\"" >&2
  exit 2
fi
service=$1
key=${2%%=*}
value=${2#*=}
summary=$3
need jq
cm="tradesim-$service-config"

old=$($K -n "$NS" get cm "$cm" -o json | jq -r --arg k "$key" '.data[$k] // "(unset)"') || die "configmap $cm not found in $NS"
log "$cm: $key $old -> $value"
patch=$(jq -nc --arg k "$key" --arg v "$value" '{data: {($k): $v}}')
kube -n "$NS" patch cm "$cm" --type merge -p "$patch" || die "patch failed"
kube -n "$NS" rollout restart "deploy/$service" || die "restart failed"
kube -n "$NS" rollout status "deploy/$service" --timeout=60s || warn "rollout of $service did not complete in 60s (continuing)"
"$(dirname "$0")/change-event.sh" "$service" "tradesim-$service config: $key $old -> $value ($summary)"
