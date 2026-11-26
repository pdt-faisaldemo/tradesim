#!/usr/bin/env bash
# Usage: redeploy.sh
# Pulls the repo, applies k8s/base and k8s/platform, and restarts every Deployment in BOTH namespaces (tradesim and
# platform) so new images (imagePullPolicy: Always) are pulled. Follow it with scripts/reset.sh.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
. scripts/lib.sh

log "git pull"
git pull --ff-only || die "git pull failed"

log "sync secrets from ~/.tradesim.env into tradesim and platform"
"$(dirname "$0")/secrets.sh" || warn "secrets were not synced"

log "apply k8s/base and k8s/platform"
# The seed job's spec is immutable once it ran; reset.sh recreates it, so a refusal here is expected and harmless.
kube apply -R -f k8s/base/ || warn "some k8s/base objects were not applied (the seed job is recreated by reset.sh)"
kube apply -R -f k8s/platform/ || warn "some k8s/platform objects were not applied"

for ns in "$NS" platform; do
  log "restarting every Deployment in $ns"
  kube -n "$ns" rollout restart deploy || die "restart in $ns failed"
done
for ns in "$NS" platform; do
  for d in $($K -n "$ns" get deploy -o jsonpath='{.items[*].metadata.name}'); do
    kube -n "$ns" rollout status "deploy/$d" --timeout=120s || warn "$ns/$d did not finish rolling out"
  done
done
log "redeployed. Run scripts/reset.sh next."
