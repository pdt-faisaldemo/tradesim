#!/usr/bin/env bash
# Usage: reset.sh
# Back to baseline: flags off (feedPaused=false, loadgen 5 customers), story cleared (both UI panels disappear), every Deployment on its baseline
# image (gateway v1.0.0-ui7, the rest v1.0.0) with baseline ConfigMaps (account DB_MAX_POOL=50, DB_POOL_TIMEOUT_MS=2000)
# and no env overrides, database reseeded (c-1001 cash 41870.00 with 10 positions and 10 orders), open incidents on the
# TradeSim services resolved. Prints ALL HEALTHY when every /health is 200.
#
# Only Deployments that differ from the baseline (image, env, ConfigMap) are changed or restarted; everything else keeps
# running, and reseeding the database never restarts a service. chaos-api reports "resetting: true" from the start of
# this script until ALL HEALTHY (the UI greys the health dots and shows "Applying updates" meanwhile).
# Idempotent. Target: under 60s.
set -uo pipefail
here=$(dirname "$0")
cd "$here/.." || exit 1
. scripts/lib.sh
need jq
need curl
started=$SECONDS

finish() { chaos_post /state '{"resetting": false}' >/dev/null 2>&1 || true; }
trap finish EXIT

log "1/6 reset started, flags off, scenario cleared"
chaos_post /state '{"resetting": true}' >/dev/null || warn "chaos-api not reachable: the UI will not show the reset in progress"
if chaos_post /flags '{"feedPaused": false, "loadCustomers": 5}' >/dev/null && chaos_post /story/clear '{}' >/dev/null; then
  log "chaos-api flags and story cleared"
else
  warn "chaos-api not reachable: nothing to clear (market-data defaults to feedPaused=false, loadgen keeps its customer count)"
fi

resolve_alerts "reset"

generation() { $K -n "$NS" get deploy "$1" -o jsonpath='{.metadata.generation}' 2>/dev/null; }
var_of() { echo "${1//-/_}"; }

log "2/6 baseline ConfigMaps, manifests, images, env (only what differs)"
for svc in $SERVICES; do printf -v "gen_before_$(var_of "$svc")" '%s' "$(generation "$svc")"; done
# kubectl apply prints "configured" only for a ConfigMap whose content differs from the baseline.
cm_out=$(kube apply -f k8s/base/configmaps/) || die "applying ConfigMaps failed"
echo "$cm_out"
# Older clusters have account on RollingUpdate; switching to Recreate needs rollingUpdate dropped in the same patch.
if [ "$($K -n "$NS" get deploy account -o jsonpath='{.spec.strategy.type}' 2>/dev/null)" != Recreate ]; then
  $K -n "$NS" patch deploy account -p '{"spec":{"strategy":{"$retainKeys":["type"],"type":"Recreate"}}}' >/dev/null 2>&1 || true
fi
for svc in $SERVICES; do
  kube apply -f "k8s/base/$svc.yaml" || die "applying $svc failed"
  want=$(image_ref "$svc" "$(baseline_tag "$svc")")
  have=$($K -n "$NS" get deploy "$svc" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)
  if [ "$have" != "$want" ]; then
    log "$svc image $have -> $want"
    kube -n "$NS" set image "deploy/$svc" "$svc=$want" || die "set image $svc failed"
  fi
done
# S5: drop the DB_HOST override so the ConfigMap value (postgres) applies again.
if [ -n "$($K -n "$NS" get deploy account -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DB_HOST")].name}' 2>/dev/null)" ]; then
  kube -n "$NS" set env deploy/account DB_HOST- || die "removing DB_HOST override failed"
fi

# A spec change (image, env) already rolls the Deployment out. A changed ConfigMap alone does not, so restart those.
rolled=""
for svc in $SERVICES; do
  before=$(eval "echo \${gen_before_$(var_of "$svc"):-}")
  if [ "$(generation "$svc")" != "$before" ]; then
    log "$svc: rolling out (spec changed)"
    rolled="$rolled $svc"
  elif grep -q "configmap/tradesim-$svc-config configured" <<<"$cm_out"; then
    kube -n "$NS" rollout restart "deploy/$svc" || die "restart $svc failed"
    rolled="$rolled $svc"
  else
    log "$svc: already at baseline, left running"
  fi
done

log "3/6 reseed database (no service restarts)"
kube -n "$NS" delete job seed --ignore-not-found --wait=true || true
kube apply -f k8s/base/seed-job.yaml || die "applying seed job failed"

# Resolves every triggered/acknowledged incident on the TradeSim services. Skipped when the API settings are absent.
resolve_incidents() {
  if [ -z "${PD_API_TOKEN:-}" ] || [ -z "${PD_FROM_EMAIL:-}" ] || [ -z "${PD_SERVICE_IDS:-}" ]; then
    warn "PD_API_TOKEN / PD_FROM_EMAIL / PD_SERVICE_IDS not all set: open incidents were NOT resolved"
    return 0
  fi
  local pd=(-H "Authorization: Token token=$PD_API_TOKEN" -H "Accept: application/vnd.pagerduty+json;version=2")
  local query=(--data-urlencode 'statuses[]=triggered' --data-urlencode 'statuses[]=acknowledged' --data-urlencode 'limit=100')
  local sid total=0 round list ids n
  for sid in ${PD_SERVICE_IDS//,/ }; do query+=(--data-urlencode "service_ids[]=$sid"); done
  for round in 1 2 3 4 5; do
    list=$(curl -sS --max-time 15 -G "${pd[@]}" "${query[@]}" https://api.pagerduty.com/incidents) || { warn "listing incidents failed"; return 0; }
    ids=$(printf '%s' "$list" | jq -c '[.incidents[]? | {id, type: "incident_reference", status: "resolved"}]') || { warn "unexpected incidents response: $(printf '%s' "$list" | head -c 200)"; return 0; }
    n=$(printf '%s' "$ids" | jq length)
    [ "$n" -gt 0 ] || break
    log "resolving $n open incident(s)"
    curl -sS --max-time 15 -o /dev/null -w 'PagerDuty PUT /incidents: HTTP %{http_code}\n' -X PUT "${pd[@]}" \
      -H "From: $PD_FROM_EMAIL" -H 'content-type: application/json' \
      -d "$(jq -nc --argjson i "$ids" '{incidents: $i}')" https://api.pagerduty.com/incidents || { warn "resolve call failed"; return 0; }
    total=$((total + n))
  done
  log "resolved $total incident(s) in total"
}

log "4/6 resolve open incidents"
resolve_incidents

log "5/6 wait for rollouts and the seed job"
for svc in $rolled; do
  kube -n "$NS" rollout status "deploy/$svc" --timeout=60s || warn "$svc rollout did not complete"
done
kube -n "$NS" wait --for=condition=complete job/seed --timeout=60s || die "seed job did not complete"

log "6/6 health check"
deadline=$((SECONDS + 30))
while :; do
  bad=""
  for svc in $SERVICES; do
    url=$(svc_url "$svc")
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${url:+$url/health}" || true)
    [ "$code" = 200 ] || bad="$bad $svc($code)"
  done
  [ -z "$bad" ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 2
done

elapsed=$((SECONDS - started))
if [ -z "$bad" ]; then
  echo "ALL HEALTHY (${elapsed}s)"
  [ "$elapsed" -le 60 ] || warn "reset took ${elapsed}s, target is under 60s"
else
  echo "NOT HEALTHY after ${elapsed}s:$bad" >&2
  exit 1
fi
