#!/usr/bin/env bash
# Usage: change-event.sh <service> "<summary>" [link_url]
# Sends a PagerDuty change event with custom_details.service=<service>.
# Routing key: PD_CHANGE_KEY_<SERVICE> (per-service Change Events integration) if set, otherwise PD_ROUTING_KEY
# (global orchestration). Never fails the caller: a missing key or a send error is a loud warning, not an abort.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -ge 2 ] || { echo "usage: $0 <service> \"<summary>\" [link_url]" >&2; exit 2; }
service=$1
summary=$2
link=${3:-}
need curl
need jq

var="PD_CHANGE_KEY_$(printf '%s' "$service" | tr '[:lower:]-' '[:upper:]_')"
key=${!var:-}
if [ -n "$key" ]; then
  key_type=per-service
  log "routing key: $key_type ($var)"
elif [ -n "${PD_ROUTING_KEY:-}" ]; then
  key=$PD_ROUTING_KEY
  key_type=global-orchestration
  warn "$var is not set for service '$service'; falling back to PD_ROUTING_KEY (global orchestration). The change may not appear on the tradesim-$service timeline."
  log "routing key: $key_type (PD_ROUTING_KEY)"
else
  warn "no change key for '$service': neither $var nor PD_ROUTING_KEY is set. Change event NOT sent: \"$summary\""
  exit 0
fi

payload=$(jq -n --arg key "$key" --arg summary "$summary" --arg service "$service" --arg link "$link" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  {routing_key: $key,
   payload: {summary: $summary, timestamp: $ts, source: "tradesim-k3s", custom_details: {service: $service}}}
  + (if $link != "" then {links: [{href: $link, text: "Change details"}]} else {} end)')

log "sending change event service=$service key=$key_type summary=\"$summary\"${link:+ link=$link}"
resp=$(curl -sS --max-time 10 -w '\n%{http_code}' -X POST https://events.pagerduty.com/v2/change/enqueue \
  -H 'content-type: application/json' -d "$payload" 2>&1)
code=$(printf '%s' "$resp" | tail -n1)
if [ "$code" = 202 ]; then
  log "change event accepted (HTTP 202) service=$service key=$key_type"
else
  warn "change event failed service=$service key=$key_type: HTTP $code $(printf '%s' "$resp" | sed '$d' | head -c 300)"
fi
exit 0
