# Runbook: portfolio memory leak (S4 and S4R)

**Service:** tradesim-portfolio. **Alerts:** `portfolio:latency` (warning), `portfolio:health` ("memory pressure"),
`portfolio:restarts` (OOMKilled).

## Symptoms
- Portfolio gets slower over a few minutes, then `/health` returns 503 "memory pressure" above 80% of the 256Mi limit.
- The container is OOMKilled and restarts about every 2-3 minutes under load; after each restart it is fast again, then
  degrades again.
- A `tradesim-portfolio deploy v1.0.1: Cache recent portfolio responses` change event preceded all of it.

## Confirm
1. `memory_rss_mb` climbs steadily between restarts; latency rises with it.
2. Pod `lastState.terminated.reason` is `OOMKilled`.
3. The restarts began after the v1.0.1 deploy.

## Root cause note
`Panel summary: Memory leak in portfolio v1.0.1 causing OOM restarts`

## Fix (needs approval)
- **Immediate (S4):** rolling restart of portfolio. This only buys time: the leak returns. Say so in the note.
- **Permanent (S4R, repeat incident):** deploy the known fix `v1.0.2` of portfolio.

## Verify
After v1.0.2: `memory_rss_mb` stays flat, no new restarts, alerts resolve. After a restart alone, expect the problem to return.

## Prevent
Ship the code fix with a test that fails on unbounded growth, and review the cache change that introduced it.
