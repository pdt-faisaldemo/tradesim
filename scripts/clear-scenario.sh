#!/usr/bin/env bash
# Usage: clear-scenario.sh
# Called by the Rundeck fix jobs after a successful fix. Clears the active scenario in chaos-api with outcome "fixed",
# so the UI incident panel shows Resolved (a plain reset.sh returns it to healthy instead). Outside the cluster set
# CHAOS_URL; with IN_CLUSTER=1 it defaults to http://chaos-api.platform:8090.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
need curl
if chaos_post /state '{"scenario": null, "mode": null, "outcome": "fixed"}' >/dev/null; then
  log "scenario cleared (outcome fixed)"
else
  warn "chaos-api not reachable: scenario state not cleared"
  exit 1
fi
