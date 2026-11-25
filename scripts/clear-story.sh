#!/usr/bin/env bash
# Usage: clear-story.sh
# Ends the panel story (both UI panels disappear, the UI goes back to idle) WITHOUT touching the environment.
# Use it after a fix to end the story; scripts/reset.sh does this and restores the environment too.
# Outside the cluster set CHAOS_URL if the Service ClusterIP is not reachable; with IN_CLUSTER=1 it defaults to
# http://chaos-api.platform:8090.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
need curl
need jq
was=$(chaos_get /state | jq -r '.story.phase // "unknown"') || die "chaos-api not reachable: story not cleared"
chaos_post /story/clear '{}' >/dev/null || die "chaos-api not reachable: story not cleared"
log "story cleared (was $was). Environment untouched."
[ "$was" = resolved ] || [ "$was" = idle ] || warn "the story was $was, not resolved: the fault itself is still in place"
exit 0
