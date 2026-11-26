# Runbook: valid orders rejected after a risk deploy (S1 and S1R)

**Services:** tradesim-risk (cause), tradesim-order (symptom). **Alerts:** `risk:error_rate`, `order:error_rate`.

## Symptoms
- Orders that should be approved are rejected with "insufficient buying power".
- Order and risk error rates climb above 20% within a minute. Every `/health` stays green.
- A `tradesim-risk deploy v1.0.1: Refactor buying power check` change event arrived just before.

## Confirm
1. Check the change event timeline: the risk deploy precedes the first alert.
2. Risk logs show `order rejected by risk check cost=... buyingPower=...` where cost is well below buyingPower.
3. The comparison is inverted: orders are rejected when `cost <= buyingPower`.

## Root cause note
`Panel summary: Inverted buying-power check in risk v1.0.1`

## Fix (needs approval)
- **S1:** Rollback risk to the previous image (`v1.0.0`).
- **S1R (repeat incident):** Deploy the known fix `v1.0.2` of risk.

## Verify
Risk and order error rates fall under 20% and the alerts resolve; a small test order is approved.

## Prevent
Add a unit test for the buying-power comparison and require it to pass before a risk image is deployed.
