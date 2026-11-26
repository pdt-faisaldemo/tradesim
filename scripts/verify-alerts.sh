#!/usr/bin/env bash
# Usage: verify-alerts.sh <S1|S1R|S2|S3|S4|S4R|S5|COMBO>
# Runs the scenario, waits until alert-bridge has the expected alerts open (works in DRY_RUN too, it reads
# alert-bridge /status), prints them, then runs reset.sh and checks every alert resolved. PASS or FAIL.
# Expected: S1 risk|order error rate; S2 account plus a downstream error rate; S3 market-data price feed stale;
# S4 portfolio restarts (OOMKilled, takes 2-3 minutes); S5 account CrashLoopBackOff.
# Needs an idle story (scripts/reset.sh first). ALERT_TIMEOUT_S overrides the wait (default 240, S4 420).
set -uo pipefail
here=$(dirname "$0")
. "$here/lib.sh"
need jq
need curl

[ $# -eq 1 ] || { echo "usage: $0 <S1|S1R|S2|S3|S4|S4R|S5|COMBO>" >&2; exit 2; }
id=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
limit=${ALERT_TIMEOUT_S:-240}
case "$id" in S4|S4R) limit=${ALERT_TIMEOUT_S:-420} ;; esac

keys() { bridge_get /status | jq -r '[.open[].dedup_key] | join(" ")'; }
has() { grep -qE "(^| )($1)( |$)" <<<"$2"; }
# met <open keys>: succeeds when the expected alerts for the scenario are all open
met() {
  case "$id" in
    S1|S1R) has 'risk:error_rate|order:error_rate' "$1" ;;
    S2) has 'account:error_rate|account:health|account:latency' "$1" && has 'risk:error_rate|order:error_rate|portfolio:error_rate|gateway:error_rate' "$1" ;;
    S3|COMBO) has 'market-data:feed_stale' "$1" ;;
    S4|S4R) has 'portfolio:restarts' "$1" ;;
    S5) has 'account:crashloop' "$1" ;;
  esac
}
fail() { echo "FAIL ($id): $*"; exit 1; }

bridge_get /status >/dev/null || fail "alert-bridge is not reachable (is k8s/platform/alert-bridge.yaml deployed?)"
echo "alert-bridge: $(bridge_get /status | jq -c '{dryRun, routingKeySet, intervalS, open: (.open|length)}')"
[ "$(keys)" = "" ] || fail "alerts are already open ($(keys)): run scripts/reset.sh first"

"$here/scenario.sh" "$id" quick || fail "scenario.sh failed"
deadline=$((SECONDS + limit))
last=""
until k=$(keys); met "$k"; do
  [ "$k" = "$last" ] || { echo "  open alerts: ${k:-none}"; last=$k; }
  [ "$SECONDS" -lt "$deadline" ] || { "$here/reset.sh" >/dev/null 2>&1; fail "expected alerts not open after ${limit}s (open: ${k:-none}); reset ran"; }
  sleep 5
done
echo "  open alerts: $k"
bridge_get /status | jq -r '.open[] | "  \(.severity)\t\(.summary)"'
echo "  sample: $(bridge_get /status | jq -r '[.open[] | select(.sample_log != "(no error logged)")][0].sample_log // "(none)"' | cut -c1-160)"
echo "expected alerts are open for $id"

"$here/reset.sh" || fail "reset.sh did not finish healthy"
sleep 3
k=$(keys)
[ -z "$k" ] || fail "alerts still open after reset: $k"
echo "all alerts resolved after reset"
echo "PASS ($id)"
