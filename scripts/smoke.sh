#!/usr/bin/env bash
# End-to-end check through the gateway. BASE defaults to http://localhost (Traefik on port 80). Needs curl and jq.
set -euo pipefail
BASE=${BASE:-http://localhost}
command -v jq >/dev/null || { echo "jq is required: sudo dnf install -y jq" >&2; exit 1; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok:   $*"; }
get() { curl -sf --max-time 5 "$BASE$1"; }

echo "==> health summary"
H=$(get /api/health-summary) || fail "gateway not reachable at $BASE"
echo "$H" | jq -c '.services[] | {name, healthy, reason}'
[ "$(echo "$H" | jq .healthy)" = true ] || fail "not all services healthy"
ok "all 6 services healthy"

echo "==> quotes tick"
A=$(get /api/quotes)
sleep 5
B=$(get /api/quotes)
[ "$(echo "$A" | jq -r .asOf)" != "$(echo "$B" | jq -r .asOf)" ] || fail "asOf did not change in 5s"
[ "$(echo "$B" | jq '.prices | length')" = 15 ] || fail "expected 15 tickers"
ok "asOf $(echo "$A" | jq -r .asOf) -> $(echo "$B" | jq -r .asOf); NVDA $(echo "$A" | jq .prices.NVDA) -> $(echo "$B" | jq .prices.NVDA)"

echo "==> buy 50 NVDA"
CASH0=$(get /api/accounts/c-1001 | jq .cash)
QTY0=$(get /api/portfolio/c-1001 | jq '[.positions[] | select(.symbol=="NVDA") | .qty] | add // 0')
R=$(curl -s --max-time 10 -w '\n%{http_code}' -X POST "$BASE/api/orders" -H 'content-type: application/json' \
  -d '{"customerId":"c-1001","symbol":"NVDA","qty":50}')
CODE=$(echo "$R" | tail -1)
BODY=$(echo "$R" | sed '$d')
echo "$BODY" | jq -c .
[ "$CODE" = 201 ] || fail "order returned HTTP $CODE"
ok "order filled: $(echo "$BODY" | jq -r .orderId)"

echo "==> portfolio and cash"
QTY1=$(get /api/portfolio/c-1001 | jq '[.positions[] | select(.symbol=="NVDA") | .qty] | add // 0')
[ "$QTY1" = $((QTY0 + 50)) ] || fail "NVDA qty $QTY0 -> $QTY1, expected +50"
CASH1=$(get /api/accounts/c-1001 | jq .cash)
[ "$(jq -n "$CASH1 < $CASH0")" = true ] || fail "cash did not decrease ($CASH0 -> $CASH1)"
ok "NVDA qty $QTY0 -> $QTY1, cash $CASH0 -> $CASH1"
get "/api/orders?customerId=c-1001&limit=3" | jq -c '.orders[0]'
echo "SMOKE PASSED"
