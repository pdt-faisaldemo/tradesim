#!/usr/bin/env bash
# Usage: deploy.sh <service> <tag> "<summary>" [commit_url]
# Sets the service image, waits for the rollout (60s, non-fatal: S4/S5 never settle), sends a change event.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -ge 3 ] || { echo "usage: $0 <service> <tag> \"<summary>\" [commit_url]" >&2; exit 2; }
service=$1
tag=$2
summary=$3
commit_url=${4:-}
image=$(image_ref "$service" "$tag")

old=$($K -n "$NS" get deploy "$service" -o jsonpath='{.spec.template.spec.containers[0].image}') || die "deployment $service not found in $NS"
log "deploying tradesim-$service: $old -> $image"
kube -n "$NS" set image "deploy/$service" "$service=$image" || die "set image failed"
kube -n "$NS" rollout status "deploy/$service" --timeout=60s || warn "rollout of $service did not complete in 60s (continuing)"
"$(dirname "$0")/change-event.sh" "$service" "tradesim-$service deploy $tag: $summary" ${commit_url:+"$commit_url"}
