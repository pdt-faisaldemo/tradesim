#!/usr/bin/env bash
# Usage: fix.sh [scenario]      (default: the scenario of the active story)
# Applies the real remediation for the scenario and moves the panel story to "fixing". The gateway then marks it
# resolved once every service has been healthy for 15 seconds in a row. The Rundeck jobs (P7) call this script.
#   S1    roll back risk (rollout undo)                S1R   deploy risk v1.0.2 (known fix)
#   S2    restore the baseline account config, restart (and loadgen back to 5 customers)
#   S3    clear feedPaused
#   S4    rolling restart of portfolio: the leak returns, so the story stays in fixing ("Pod restarted, issue persists")
#   S4R   deploy portfolio v1.0.2 (known fix)           S5    roll back account (rollout undo)
#   COMBO clear feedPaused + deploy portfolio v1.0.2
# Every fix sends a change event whose summary contains "fix" or "rollback". Run `fix.sh S4R` on an S4 story to apply
# the permanent fix after the restart.
set -uo pipefail
here=$(dirname "$0")
. "$here/lib.sh"
need jq
need curl

state=$(chaos_get /state) || die "chaos-api is not reachable (story state lives there)"
phase=$(printf '%s' "$state" | jq -r '.story.phase // "idle"')
case "$phase" in
  incident|fixing) ;;
  *) die "no scenario to fix: the story is $phase. Start one with scripts/scenario.sh" ;;
esac
id=$(printf '%s' "${1:-$(printf '%s' "$state" | jq -r '.story.scenario')}" | tr '[:lower:]' '[:upper:]')
case "$id" in S1|S1R|S2|S3|S4|S4R|S5|COMBO) ;; *) die "unknown scenario '$id' (S1|S1R|S2|S3|S4|S4R|S5|COMBO)" ;; esac

kind=full
[ "$id" = S4 ] && kind=partial
chaos_post /story/fix "$(jq -nc --arg s "$id" --arg k "$kind" '{scenario: $s, kind: $k}')" >/dev/null || die "could not move the story to fixing"
log "fixing $id (kind=$kind)"

# Prints the value of KEY in a baseline ConfigMap file.
baseline_value() { sed -n "s/^[[:space:]]*$2:[[:space:]]*\"\{0,1\}\([^\"#]*\)\"\{0,1\}[[:space:]]*\$/\1/p" "$1" | head -1; }

undo() { # undo <deployment> "<summary>"
  kube -n "$NS" rollout undo "deploy/$1" || die "rollout undo of $1 failed"
  kube -n "$NS" rollout status "deploy/$1" --timeout=60s || warn "rollout of $1 did not complete in 60s (continuing)"
  "$here/change-event.sh" "$1" "tradesim-$1 rollback: $2"
}

feed_resume() {
  chaos_post /flags '{"feedPaused": false}' >/dev/null || die "could not clear feedPaused on chaos-api"
  "$here/change-event.sh" market-data "tradesim-market-data fix: price feed resumed (feedPaused cleared)"
}

known_fix() { "$here/deploy.sh" "$1" v1.0.2 "fix: $2"; }

case "$id" in
  S1) undo risk "undo risk v1.0.1, back to the previous version (fix for rejected valid orders)" ;;
  S1R) known_fix risk "known fix for the buying power check" ;;
  S2)
    cmf="$here/../k8s/base/configmaps/tradesim-account-config.yaml"
    chaos_post /flags '{"loadCustomers": 5}' >/dev/null || warn "could not set loadgen back to 5 customers"
    "$here/config.sh" account "DB_MAX_POOL=$(baseline_value "$cmf" DB_MAX_POOL)" "DB_POOL_TIMEOUT_MS=$(baseline_value "$cmf" DB_POOL_TIMEOUT_MS)" "fix: restore baseline DB pool config"
    ;;
  S3) feed_resume ;;
  S4)
    kube -n "$NS" rollout restart deploy/portfolio || die "restart failed"
    kube -n "$NS" rollout status deploy/portfolio --timeout=60s || warn "rollout of portfolio did not complete in 60s (continuing)"
    "$here/change-event.sh" portfolio "tradesim-portfolio fix: rolling restart to clear memory (the leak returns until the code fix)"
    ;;
  S4R) known_fix portfolio "known fix for the portfolio memory leak" ;;
  S5) undo account "undo the DB_HOST change (fix for account CrashLoopBackOff)" ;;
  COMBO) feed_resume; known_fix portfolio "known fix for the portfolio memory leak" ;;
esac
log "fix for $id applied. The story resolves after 15s of all services healthy."
