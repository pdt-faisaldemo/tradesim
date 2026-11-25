#!/usr/bin/env bash
# Usage: scenario.sh <S1|S2|S3|S4|S5|COMBO> [quick|deep]     (S1R and S4R are accepted as aliases of S1 and S4)
# Performs the fault and starts the panel story (state lives in chaos-api). A resolved story is cleared automatically;
# a story still in incident or fixing is refused (FORCE=1 overrides).
# `mode` is recorded in chaos-api and read by alert-bridge as demo_mode. Fix with scripts/fix.sh, undo everything with scripts/reset.sh.
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

# ---- lock: one story at a time ----
# idle: go. resolved: the previous story is cleared first (environment untouched). incident/fixing: refuse.
if state=$(chaos_get /state); then
  phase=$(printf '%s' "$state" | jq -r '.story.phase // "idle"')
  active=$(printf '%s' "$state" | jq -r '.story.scenario // empty')
  case "$phase" in
    idle) ;;
    resolved)
      log "previous story ($active) is resolved: clearing it before starting $id"
      "$here/clear-story.sh" || die "could not clear the resolved story"
      ;;
    *)
      if [ "${FORCE:-0}" != 1 ]; then
        echo "REFUSED: scenario $active is still $phase. Fix it (scripts/fix.sh), then clear-story.sh, or run scripts/reset.sh (or FORCE=1)." >&2
        exit 3
      fi
      ;;
  esac
else
  case "$id" in
    S3|COMBO) die "chaos-api is not reachable and $id needs it for the feedPaused flag (is k8s/platform/chaos-api.yaml deployed?)" ;;
    *) warn "chaos-api is not reachable: the story and demo_mode are not recorded" ;;
  esac
fi
chaos_post /story/start "$(jq -nc --arg s "$id" --arg m "$mode" --argjson f "$([ "${FORCE:-0}" = 1 ] && echo true || echo false)" '{scenario: $s, mode: $m, force: $f}')" >/dev/null || true
log "starting scenario $id mode=$mode"

s1() {
  log "S1: risk v1.0.1 (branch demo/bad-risk-check: inverted buying-power comparison)"
  "$here/deploy.sh" risk v1.0.1 "Refactor buying power check" "${BUILD_REF}demo/bad-risk-check"
}

s2() {
  log "S2: decoy change event on portfolio, then ${DECOY_DELAY_S}s later account DB_MAX_POOL=1 DB_POOL_TIMEOUT_MS=300 (each query holds its connection 1000ms), loadgen at 20 customers"
  "$here/change-event.sh" portfolio "tradesim-portfolio config: update logging format"
  left=$DECOY_DELAY_S
  while [ "$left" -gt 0 ]; do
    log "decoy sent; applying the real change in ${left}s"
    step=$(( left < 15 ? left : 15 ))
    sleep "$step"
    left=$(( left - step ))
  done
  chaos_post /flags '{"loadCustomers": 20}' >/dev/null || warn "could not raise loadgen to 20 customers (chaos-api unreachable)"
  "$here/config.sh" account DB_MAX_POOL=1 DB_POOL_TIMEOUT_MS=300 "reduce DB connection pool"
}

s3() {
  log "S3: flag feedPaused=true (market-data stops ticking within ~5s; quotes keep being served)"
  chaos_post /flags '{"feedPaused": true}' || die "could not set feedPaused on chaos-api"
  echo
}

s4() {
  log "S4: portfolio v1.0.1 (branch demo/portfolio-leak: ~0.5MB retained per request, latency grows with it, 256Mi limit)"
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
log "scenario $id active. Fix with scripts/fix.sh, or reset with scripts/reset.sh"
