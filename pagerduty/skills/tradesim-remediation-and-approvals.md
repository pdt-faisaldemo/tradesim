# TradeSim remediation and approvals

Recommend one remediation per incident and ask for approval before running it. Never run a change that was not approved.

## Remediation actions

| Situation | Action | What it does |
|---|---|---|
| Bad deploy of a service (error rate began right after a `deploy` change event) | Rollback | `rollout undo` of that Deployment |
| Config change broke a service (`config: KEY old -> new` change event) | Restore config | re-apply the baseline ConfigMap and restart the service |
| Bad env var on a Deployment (CrashLoopBackOff, cause in `logs --previous`) | Rollback | `rollout undo` of that Deployment |
| Price feed paused (stale prices, no errors) | Resume feed | clear the `feedPaused` flag |
| Memory growth ending in OOMKilled | Restart, then known fix | rolling restart buys minutes; the permanent fix is the known-good image `v1.0.2` |
| Same incident as one already fixed before | Deploy known fix | deploy `v1.0.2` of the service |

The Rundeck jobs behind these actions are `diagnose`, `restart`, `rollback`, `restore-config`, `deploy-known-fix` and
`reset`, all limited to the `tradesim` namespace.

## Approval rules

- Run `diagnose` freely: it is read-only.
- `restart`, `rollback`, `restore-config` and `deploy-known-fix` need an explicit human approval on the incident.
- State in the approval request: the action, the service, what you expect to change, and how you will verify it.
- A restart is not a fix for a memory leak. Say so, and recommend the known fix alongside it.

## Verify after the fix

1. All six service health dots green; `error_rate` back under 20%.
2. The alerts resolve by themselves after two healthy cycles (30s).
3. Post a short follow-up note: what was done, the time, and the evidence it worked.

## Prevent

Close the incident with one prevention recommendation: a config guard for pool sizes, a deploy check for the risk
comparison, a freshness monitor on the price feed, a memory limit review, or an env var validation in CI.
