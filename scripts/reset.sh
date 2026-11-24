#!/usr/bin/env bash
# Usage: reset.sh
# Back to baseline: flags off, scenario cleared, every Deployment on its baseline image (gateway v1.0.0-ui3, the rest
# v1.0.0) with baseline ConfigMaps (account DB_MAX_POOL=50, DB_POOL_TIMEOUT_MS=2000) and no env overrides, database
# reseeded (c-1001 cash 41870.00 with 10 positions and 10 orders), incident panel state cleared (scenario state
# reset + gateway restart), open incidents on the TradeSim services resolved. Prints ALL HEALTHY when every /health is 200.
# Idempotent. Target: under 60s.
set -uo pipefail
here=$(dirname "$0")
cd "$here/.." || exit 1
. scripts/lib.sh
need jq
need curl
started=$SECONDS

declare -A PORTS=([account]=8083 [market-data]=8085 [risk]=8082 [order]=8081 [portfolio]=8084 [gateway]=8080)

log "1/6 flags off, scenario cleared"
if chaos_post /flags '{"feedPaused": false}' >/dev/null && chaos_post /state '{"scenario": null, "mode": null}' >/dev/null; then
  log "chaos-api state cleared"
else
  warn "chaos-api not reachable: nothing to clear (market-data defaults to feedPaused=false without it)"
fi

log "2/6 baseline ConfigMaps, manifests, images, env"
kube apply -f k8s/base/configmaps/ || die "applying ConfigMaps failed"
# Older clusters have account on RollingUpdate; switching to Recreate needs rollingUpdate dropped in the same patch.
$K -n "$NS" patch deploy account -p '{"spec":{"strategy":{"$retainKeys":["type"],"type":"Recreate"}}}' >/dev/null 2>&1 || true
for svc in $SERVICES; do
  kube apply -f "k8s/base/$svc.yaml" || die "applying $svc failed"
  kube -n "$NS" set image "deploy/$svc" "$svc=$(image_ref "$svc" "$(baseline_tag "$svc")")" || die "set image $svc failed"
done
# S5: drop the DB_HOST override so the ConfigMap value (postgres) applies again.
kube -n "$NS" set env deploy/account DB_HOST- || die "removing DB_HOST override failed"
# Restart everything: picks up ConfigMap changes (S2) and clears state (S4 leak, S3 flag).
for svc in $SERVICES; do
  kube -n "$NS" rollout restart "deploy/$svc" || die "restart $svc failed"
done

log "3/6 reseed database"
kube -n "$NS" delete job seed --ignore-not-found --wait=true || true
kube apply -f k8s/base/seed-job.yaml || die "applying seed job failed"
kube -n "$NS" wait --for=condition=complete job/seed --timeout=60s || die "seed job did not complete"

log "4/6 wait for rollouts"
for svc in $SERVICES; do
  kube -n "$NS" rollout status "deploy/$svc" --timeout=60s || warn "$svc rollout did not complete"
done

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

log "5/6 resolve open incidents"
resolve_incidents

# Base URL for a service's /health: in-cluster DNS when IN_CLUSTER=1, otherwise the Service ClusterIP.
health_url() {
  local svc=$1 host
  if [ "${IN_CLUSTER:-0}" = 1 ]; then host="$svc.$NS"; else host=$($K -n "$NS" get svc "$svc" -o jsonpath='{.spec.clusterIP}' 2>/dev/null); fi
  [ -n "$host" ] && echo "http://$host:${PORTS[$svc]}/health"
}

log "6/6 health check"
deadline=$((SECONDS + 30))
while :; do
  bad=""
  for svc in $SERVICES; do
    url=$(health_url "$svc")
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${url:-http://invalid.invalid}" || true)
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
