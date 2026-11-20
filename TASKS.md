# TradeSim build tasks for Claude Code

Paste ONE prompt per session, in order. Run the checks yourself; paste back only failures. Use `/clear` between phases. Use a faster model for P2-P3 boilerplate, the strongest model for P5-P7.

## P0 - Today, by hand (no Claude Code)
1. Create empty GitHub repo `tradesim` (public). Add `CLAUDE.md` and `TASKS.md` from this kit to its root.
2. EC2: t3.large, Amazon Linux 2023, 30 GB gp3, IAM instance role with `CloudWatchAgentServerPolicy` + `CloudWatchLogsFullAccess`. Security group: SSH 22 from Anywhere-IPv4, TCP 80 from your IP (Anywhere at the booth).
3. On the instance (EC2 Instance Connect):
   ```
   sudo dnf install -y git
   curl -sfL https://get.k3s.io | sh -
   sudo k3s kubectl get nodes
   echo "alias kubectl='sudo k3s kubectl'" >> ~/.bashrc && source ~/.bashrc
   ```
4. PagerDuty: create the 9 technical services + 3 business services + dependencies (Build Guide section 4). Copy each Events API v2 key. Create a REST API key (read/write) for reset and status.
5. AWS DevOps Agent: Agent Space + PagerDuty Capability Provider (Scoped OAuth: incidents.read, incidents.write, services.read; Events Integration on).

## P1 - Skeleton + account service (end to end)
> Read CLAUDE.md. Create the repository layout, `shared/` (logger, metrics with rolling 60s window, health helper, http client with timeout + trace id), and the `account` service with Postgres (pool from env), its Dockerfile, k8s Deployment/Service/ConfigMap, Postgres + seed Job (demo customer c-1001 with 41870.00), and `.github/workflows/build.yml`. Include `/debug/last-error`. Stop when account runs on k3s.

Check: `kubectl -n tradesim get pods`; `curl` account `/health`, `/metrics`, `/accounts/c-1001`.

## P2 - Remaining services
> Using account as the pattern, build risk, order, portfolio, market-data (with Redis and the price simulator) and gateway (API routing, /api/health-summary). Wire all calls per the dependency table with 2s timeouts and 502/503 cascades. Manifests for all.

Check: through gateway, buy 50 NVDA succeeds; portfolio shows it; quotes change every 2s.

## P3 - UI
> Build the gateway UI per CLAUDE.md: Dashboard, Trade, Portfolio, health strip, status banner, friendly errors with reference id. Clean, professional, light and dark.

Check: open http://EC2_IP/ ; kill a pod and watch its dot go red.

## P4 - Fault images, scripts, loadgen
> Create branches demo/bad-risk-check (S1) and demo/portfolio-leak (S4). Implement DB_MAX_POOL behaviour, the feedPaused flag, scripts/ (change-event, deploy, config, scenario, reset) and loadgen. Document image builds: v1.0.0 from main for all services, v1.0.1 for risk and portfolio from the demo branches.

Check: run each scenario via scripts/scenario.sh and see the symptom; scripts/reset.sh restores health under 60s.

## P5 - alert-bridge
> Build alert-bridge per CLAUDE.md with auto-resolve, k8s pod checks and the PagerDuty secret. Add a dry-run mode that logs events instead of sending.

Check: dry-run shows expected triggers for S1-S5 and resolves after reset; then live mode creates PagerDuty incidents on the right services.

## P6 - chaos-api and /ops console
> Build chaos-api with RBAC, the /ops console (basic auth), scenario and reset endpoints, active-scenario lock, COMBO, Quick/Deep mode passed into alerts.

Check: every button works from a phone browser; RESET ALL shows ALL HEALTHY.

## P7 - Observability and automation
> Add fluent-bit DaemonSet to CloudWatch Logs, the automation namespace Role/RoleBinding for the PD Automation Runner, and rundeck/ job scripts. Write README sections: installing the Runner and registering the six jobs.

Check (by hand): logs visible in CloudWatch `/tradesim/containers`; install the Runner; each Rundeck job runs from PagerDuty.

## P8 - By hand: agents, golden incidents, rehearsal
1. SRE Agent skill `code-fix-handoff` (Build Guide Appendix A); Incident Workflow (auto Diagnose; manual remediation actions).
2. Devin: connect repo + Slack. Run S1 and S4 in Deep mode; merge Devin's PRs; build v1.0.2 for risk and portfolio.
3. Create Golden 1 (S1) and Golden 2 (S2) with a Zoom/Teams war room, stakeholder update, status page post, AI PIR.
4. Rehearse Quick and Deep modes; time RESET ALL.
