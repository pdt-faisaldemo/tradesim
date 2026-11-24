#!/usr/bin/env bash
# Usage: verify-s5.sh
# Finds the account pod and prints its status, restart count and last log lines. Under S5 (DB_HOST=postgress) the
# previous container's log must end with "cannot connect to DB_HOST=postgress ...". Exit 0 when that line is there.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

pod=$($K -n "$NS" get pods -l app=account --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}' 2>/dev/null)
[ -n "$pod" ] || die "no account pod found in namespace $NS"

jp() { $K -n "$NS" get pod "$pod" -o jsonpath="$1" 2>/dev/null; }
echo "pod:            $pod"
echo "phase:          $(jp '{.status.phase}')"
echo "state:          $(jp '{.status.containerStatuses[0].state.waiting.reason}')$(jp '{.status.containerStatuses[0].state.running.startedAt}')"
echo "last exit:      $(jp '{.status.containerStatuses[0].lastState.terminated.reason}') code=$(jp '{.status.containerStatuses[0].lastState.terminated.exitCode}')"
echo "restart count:  $(jp '{.status.containerStatuses[0].restartCount}')"
echo "DB_HOST override on the Deployment: $($K -n "$NS" get deploy account -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DB_HOST")].value}' 2>/dev/null)"
echo
echo "--- logs --previous --tail=10"
prev=$($K -n "$NS" logs "$pod" --previous --tail=10 2>&1)
echo "${prev:-(no previous container yet)}"
echo
echo "--- logs --tail=10 (current container)"
$K -n "$NS" logs "$pod" --tail=10 2>&1
echo
if grep -q 'cannot connect to DB_HOST=' <<<"$prev"; then
  echo "S5 CAUSE VISIBLE: $(grep -o 'cannot connect to DB_HOST=[^ ]*' <<<"$prev" | tail -1)"
else
  echo "no 'cannot connect to DB_HOST=' line in the previous container's log yet (wait for a restart, or S5 is not active)" >&2
  exit 1
fi
