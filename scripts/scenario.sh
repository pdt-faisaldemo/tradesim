#!/usr/bin/env bash
# Usage: scenario.sh <S1|S2|S3|S4|S5|COMBO> [quick|deep]     (S1R and S4R are accepted as aliases of S1 and S4)
# Performs the fault. Refuses when another scenario is active (state lives in chaos-api); FORCE=1 overrides.
# `mode` is recorded in chaos-api and read by alert-bridge as demo_mode. Undo everything with scripts/reset.sh.
set -uo pipefail
here=$(dirname "$0")
. "$here/lib.sh"

[ $# -ge 1 ] || { echo "usage: $0 <S1|S2|S3|S4|S5|COMBO> [quick|deep]" >&2; exit 2; }
id=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
mode=$(printf '%s' "${2:-quick}" | tr '[:upper:]' '[:lower:]')
case "$id" in S1|S1R|S2|S3|S4|S4R|S5|COMBO) ;; *) die "unknown scenario '$1' (S1|S2|S3|S4|S5|COMBO)" ;; esac
case "$mode" in quick|deep) ;; *) die "mode must be quick or deep" ;; esac
need jq
need curl

BUILD_REF=${BUILD_REF_BASE:-$REPO_URL/compare/main...}
DECOY_DELAY_S=${S2_DECOY_DELAY_S:-60}

# ---- lock: one scenario at a time ----
if state=$(chaos_get /state); then
  active=$(printf '%s' "$state" | jq -r '.scenario // empty')
  if [ -n "$active" ] && [ "${FORCE:-0}" != 1 ]; then
    echo "REFUSED: scenario $active is already active (mode=$(printf '%s' "$state" | jq -r .mode)). Run scripts/reset.sh first (or FORCE=1)." >&2
    exit 3
  fi
else
  case "$id" in
    S3|COMBO) die "chaos-api is not reachable and $id needs it for the feedPaused flag (is k8s/platform/chaos-api.yaml deployed?)" ;;
    *) warn "chaos-api is not reachable: scenario lock and demo_mode are not recorded" ;;
  esac
fi
chaos_post /state "$(jq -nc --arg s "$id" --arg m "$mode" '{scenario: $s, mode: $m}')" >/dev/null || true
log "starting scenario $id mode=$mode"

s1() {
  log "S1: risk v1.0.1 (branch demo/bad-risk-check: inverted buying-power comparison)"
  "$here/deploy.sh" risk v1.0.1 "Refactor buying power check" "${BUILD_REF}demo/bad-risk-check"
}

s2() {
  log "S2: decoy change event on portfolio, then ${DECOY_DELAY_S}s later account DB_MAX_POOL=3"
  "$here/change-event.sh" portfolio "tradesim-portfolio config: update logging format"
  left=$DECOY_DELAY_S
  while [ "$left" -gt 0 ]; do
    log "decoy sent; applying the real change in ${left}s"
    step=$(( left < 15 ? left : 15 ))
    sleep "$step"
    left=$(( left - step ))
  done
  "$here/config.sh" account DB_MAX_POOL=3 "reduce DB connection pool"
}

s3() {
  log "S3: flag feedPaused=true (market-data stops ticking within ~5s; quotes keep being served)"
  chaos_post /flags '{"feedPaused": true}' || die "could not set feedPaused on chaos-api"
  echo
}

s4() {
  log "S4: portfolio v1.0.1 (branch demo/portfolio-leak: ~1MB retained per request, 256Mi limit)"
  "$here/deploy.sh" portfolio v1.0.1 "Cache recent portfolio responses" "${BUILD_REF}demo/portfolio-leak"
}

s5() {
  log "S5: account Deployment env DB_HOST=postgress (typo)"
  old=$($K -n "$NS" get cm tradesim-account-config -o jsonpath='{.data.DB_HOST}' 2>/dev/null || echo postgres)
  kube -n "$NS" set env deploy/account DB_HOST=postgress || die "set env failed"
  kube -n "$NS" rollout status deploy/account --timeout=20s || warn "account did not become ready (expected: CrashLoopBackOff)"
  "$here/change-event.sh" account "tradesim-account env: DB_HOST $old -> postgress (update database host)"
}

case "$id" in
  S1|S1R) s1 ;;
  S2) s2 ;;
  S3) s3 ;;
  S4|S4R) s4 ;;
  S5) s5 ;;
  COMBO) s3; s4 ;;
esac
log "scenario $id active. Reset with scripts/reset.sh"
