# Runbook: account database pool exhausted (S2)

**Services:** tradesim-account (cause); risk, order, portfolio, gateway (symptoms). **Alerts:** `account:error_rate`,
`account:latency`, then `risk`, `order`, `portfolio`, `gateway` `error_rate`.

## Symptoms
- Five services alert within minutes; account is the deepest one.
- Account logs `db pool exhausted: 1/1 in use, waited 300ms` and returns 503.
- Account `/metrics`: `db_pool_max: 1`, `db_pool_in_use: 1`.

## Decoy
A change event `tradesim-portfolio config: update logging format` arrives about a minute BEFORE the real change. Portfolio
is failing only because account is. Do not roll it back.

## Confirm
1. The newest change on the deepest failing service is `tradesim-account config: DB_MAX_POOL 50 -> 1, DB_POOL_TIMEOUT_MS 2000 -> 300`.
2. Account restarted right after that change, and the pool errors began with the restart.

## Root cause note
`Panel summary: DB pool cut to 1 connection by a config change`

## Fix (needs approval)
Restore config on account: re-apply the baseline ConfigMap (`DB_MAX_POOL=50`, `DB_POOL_TIMEOUT_MS=2000`) and restart account.

## Verify
`db_pool_max` is 50, account error rate falls, the four downstream alerts resolve on their own.

## Prevent
Guard pool-size changes: require review for `DB_MAX_POOL` below the number of concurrent requests, and alert on `db_pool_in_use / db_pool_max` near 1.
