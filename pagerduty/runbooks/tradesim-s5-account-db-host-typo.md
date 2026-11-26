# Runbook: account in CrashLoopBackOff (S5)

**Services:** tradesim-account (cause); everything downstream. **Alerts:** `account:crashloop`, `account:restarts`,
`account:health`, then `risk`, `order`, `portfolio`, `gateway` alerts.

## Symptoms
- The account pod is in CrashLoopBackOff and the restart count climbs.
- Every service that depends on account fails.
- A change event `tradesim-account env: DB_HOST postgres -> postgress (update database host)` arrived just before.

## Confirm
1. `logs --previous` of the account pod ends with `cannot connect to DB_HOST=postgress`.
2. The Deployment has a `DB_HOST` env override that differs from the ConfigMap value `postgres`.

## Root cause note
`Panel summary: Account DB_HOST typo 'postgress' crashes the pod`

## Fix (needs approval)
Rollback the account Deployment (`rollout undo`): this removes the bad `DB_HOST` override.

## Verify
The account pod becomes Ready, restart count stops increasing, downstream alerts resolve on their own.

## Prevent
Validate environment variables in CI and prefer ConfigMap values over per-Deployment env overrides.
