# Runbook: stale price feed (S3)

**Service:** tradesim-market-data. **Alert:** `market-data:feed_stale`, later `market-data:health`.

## Symptoms
- No errors anywhere. The UI "Prices as of" time stops moving and prices are frozen.
- Market-data `/metrics`: `last_tick_age_s` grows past 30. Quotes are still served.
- Orders still fill, but at stale prices.

## Confirm
1. `last_tick_age_s` keeps increasing while uptime does not reset (no restart).
2. Redis is reachable and the pod is Running, so this is the feed itself, not an outage.
3. No change event explains it: the feed was paused by a flag (`feedPaused=true`).

## Root cause note
`Panel summary: Price feed paused, quotes served frozen`

## Fix (needs approval)
Resume the feed: clear the `feedPaused` flag. Ticks resume within about 5 seconds.

## Verify
`last_tick_age_s` is under 5, "Prices as of" moves, the alert resolves after two healthy cycles.

## Prevent
Keep the freshness monitor (`last_tick_age_s > 30`) and consider blocking order fills when prices are older than 30s.
