#!/usr/bin/env bash
# Usage: verify-story.sh <S1|S1R|S2|S3|S4|S4R|S5|COMBO>
# End-to-end check of the panel story: scenario -> incident (and detected) -> fix -> resolved -> clear-story -> idle.
# Prints the phase at each step and PASS or FAIL. Expected to pass for S1, S2, S3, S5. S4 (and COMBO's S4 half)
# stops at fixing: it checks the story STAYS in fixing after the restart, then clears the story. The S4 fault is still
# in the environment afterwards: run scripts/reset.sh.
# Needs an idle story to start (run scripts/reset.sh or scripts/clear-story.sh first). Timeouts: DETECT_TIMEOUT_S
# (default 240, S4's leak is slow), RESOLVE_TIMEOUT_S (default 150).
set -uo pipefail
here=$(dirname "$0")
. "$here/lib.sh"
need jq
need curl

[ $# -eq 1 ] || { echo "usage: $0 <S1|S1R|S2|S3|S4|S4R|S5|COMBO>" >&2; exit 2; }
id=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
DETECT_TIMEOUT_S=${DETECT_TIMEOUT_S:-240}
RESOLVE_TIMEOUT_S=${RESOLVE_TIMEOUT_S:-150}
partial=false
[ "$id" = S4 ] && partial=true

phase() { chaos_get /state | jq -r '.story.phase // "unreachable"' 2>/dev/null || echo unreachable; }
panel() { # panel <jq filter>: from the gateway's merged view
  local url
  url=$(svc_url gateway) || return 1
  curl -s --max-time 3 "$url/api/incident-panel" | jq -r "$1" 2>/dev/null
}
step() { printf '\n[%s] %s\n' "$(date +%T)" "$*"; }
fail() { echo "FAIL ($id): $*"; echo "phase now: $(phase)"; exit 1; }
# wait_for <timeout_s> <description> <command...>: polls every 2s, prints the phase when it changes.
wait_for() {
  local limit=$1 what=$2 last="" p
  shift 2
  local deadline=$((SECONDS + limit))
  while ! "$@"; do
    p=$(phase)
    [ "$p" = "$last" ] || { echo "  phase=$p"; last=$p; }
    [ "$SECONDS" -lt "$deadline" ] || fail "timed out after ${limit}s waiting for $what"
    sleep 2
  done
}
is_phase() { [ "$(phase)" = "$1" ]; }
detected() { [ "$(chaos_get /state | jq -r '.story.detectedAt // empty')" != "" ]; }

step "0. start state"
echo "  phase=$(phase)"
is_phase idle || fail "the story is not idle: run scripts/clear-story.sh or scripts/reset.sh first"

step "1. scenario.sh $id quick"
"$here/scenario.sh" "$id" quick || fail "scenario.sh failed"
wait_for 20 "phase incident" is_phase incident
echo "  phase=incident"
if panel '.phase' | grep -q incident; then echo "  gateway /api/incident-panel agrees: incident"; else fail "gateway /api/incident-panel does not show incident"; fi

step "2. wait for Detected (first unhealthy signal)"
wait_for "$DETECT_TIMEOUT_S" "Detected" detected
echo "  phase=incident, detected: $(panel '.timeline[0] | "elapsed \(.elapsedS)s"') after the first unhealthy signal"

step "3. fix.sh"
"$here/fix.sh" || fail "fix.sh failed"
wait_for 20 "phase fixing" is_phase fixing
echo "  phase=fixing"
panel '.timeline[] | select(.elapsedS != null) | "  ✓ \(.label)\(if .detail then ": \(.detail)" else "" end)"'

if [ "$partial" = true ]; then
  step "4. S4: must stay in fixing (restart does not remove the leak). Watching 30s"
  for _ in $(seq 15); do
    sleep 2
    is_phase fixing || fail "phase left fixing after a restart: $(phase)"
  done
  echo "  phase=fixing, note: $(panel '.notes[0].label // "(none)"')"
else
  step "4. wait for resolved (15s of all services healthy after the fix)"
  wait_for "$RESOLVE_TIMEOUT_S" "phase resolved" is_phase resolved
  echo "  phase=resolved"
  [ "$(panel '.delivered.blocks | length')" = 3 ] || fail "resolved but the Reliability delivered blocks are missing in /api/incident-panel"
  echo "  reliability delivered: 3 blocks present, time to resolve $(panel '.metrics.timeToResolveS')s"
  sleep 4
  is_phase resolved || fail "phase moved away from resolved on its own: $(phase)"
  echo "  phase=resolved (stable)"
fi

step "5. clear-story.sh"
"$here/clear-story.sh" || fail "clear-story.sh failed"
is_phase idle || fail "phase is $(phase) after clear-story, expected idle"
echo "  phase=idle"
[ "$(panel '.phase')" = idle ] || { sleep 4; [ "$(panel '.phase')" = idle ] || fail "gateway /api/incident-panel still shows $(panel '.phase') after clear-story"; }
echo "  gateway /api/incident-panel: idle"

echo
[ "$partial" = true ] && echo "NOTE: the $id fault is still in the environment. Run scripts/reset.sh."
echo "PASS ($id)"
