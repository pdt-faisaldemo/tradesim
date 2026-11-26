# SRE Agent content for TradeSim

Upload these files to PagerDuty so the SRE Agent (Paige) and the responders can use them. Nothing here is read by the
cluster itself.

| Where in PagerDuty | File |
|---|---|
| Runbooks | `runbooks/tradesim-s1-bad-risk-check.md` |
| Runbooks | `runbooks/tradesim-s2-db-pool-exhausted.md` |
| Runbooks | `runbooks/tradesim-s3-stale-price-feed.md` |
| Runbooks | `runbooks/tradesim-s4-portfolio-memory-leak.md` |
| Runbooks | `runbooks/tradesim-s5-account-db-host-typo.md` |
| SRE Agent skills | `skills/tradesim-architecture-and-triage.md` |
| SRE Agent skills | `skills/tradesim-incident-note-format.md` |
| SRE Agent skills | `skills/tradesim-remediation-and-approvals.md` |

The incident note format in `skills/tradesim-incident-note-format.md` is what drives the "Root cause found" step in the
TradeSim UI panel: the gateway reads the first incident note that starts with `SRE Agent:` and shows its
`Panel summary:` line.
