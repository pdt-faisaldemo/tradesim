#!/usr/bin/env bash
# Usage: verify-s2.sh
# Run a minute or so after `scenario.sh S2`: prints each service's error rate (last 30s and 60s, from /metrics), the
# account DB pool stats and the loadgen customer count, then says whether the cascade is visible. Exit 0 when it is.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
need jq
need curl

fetch() { curl -s --max-time 3 "$1"; }

echo "scenario state:"
chaos_get /state | jq -c '{scenario, mode, since, resetting, loadCustomers: .flags.loadCustomers}' || warn "chaos-api not reachable"
echo
printf '%-12s %9s %13s %13s %8s\n' service req_30s err_rate_30s err_rate_60s p95_ms
downstream=0
account_failing=false
account_metrics=""
for svc in account risk order portfolio gateway market-data; do
  url=$(svc_url "$svc") || { printf '%-12s %s\n' "$svc" "no Service found"; continue; }
  m=$(fetch "$url/metrics") || { printf '%-12s %s\n' "$svc" "metrics unreachable"; continue; }
  printf '%-12s %9s %13s %13s %8s\n' "$svc" \
    "$(jq -r '.requests_30s // .requests' <<<"$m")" "$(jq -r '.error_rate_30s // .error_rate' <<<"$m")" "$(jq -r .error_rate <<<"$m")" "$(jq -r .p95_ms <<<"$m")"
  failing=$(jq -r '((.error_rate_30s // .error_rate) > 0.2) and ((.requests_30s // .requests) >= 10)' <<<"$m")
  case "$svc" in
    account) account_failing=$failing; account_metrics=$m ;;
    market-data) ;;
    *) [ "$failing" = true ] && downstream=$((downstream + 1)) ;;
  esac
done
echo
if [ -n "$account_metrics" ]; then
  echo "account pool: in_use=$(jq -r .db_pool_in_use <<<"$account_metrics") max=$(jq -r .db_pool_max <<<"$account_metrics") waiting=$(jq -r .db_pool_waiting <<<"$account_metrics")"
fi
echo "account last error: $(fetch "$(svc_url account)/debug/last-error" | jq -r '.lastError.msg // "(none)"')"
echo
if [ "$account_failing" = true ] && [ "$downstream" -ge 3 ]; then
  echo "S2 CASCADE VISIBLE: account and $downstream downstream services are over 20% errors"
else
  echo "S2 cascade NOT (yet) visible: account over threshold=$account_failing, downstream services over threshold=$downstream (want 3 or more)" >&2
  exit 1
fi
