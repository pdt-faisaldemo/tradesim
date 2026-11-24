'use strict';
// Minimal chaos-api (P4): the demo flags and the active-scenario state, kept in memory.
// P6 extends this with the /ops console, scenario/reset endpoints and RBAC. State is lost on restart,
// which is safe: flags default to off and scripts/reset.sh clears both.
const express = require('express');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');

const SERVICE = 'chaos-api';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8090', 10);

const logger = createLogger({ service: SERVICE, version: VERSION });
const metrics = createMetrics({ service: SERVICE, version: VERSION });

const BASE_LOAD_CUSTOMERS = 5;
const MAX_LOAD_CUSTOMERS = 20; // seeded accounts c-2001 to c-2020
// reset.sh sets resetting=true on start and false at ALL HEALTHY. If it dies half way, resetting expires on its own.
const RESETTING_EXPIRES_MS = 3 * 60 * 1000;

// loadCustomers: how many synthetic customers loadgen runs (5 normally, 20 during S2).
const flags = { feedPaused: false, loadCustomers: BASE_LOAD_CUSTOMERS };
// outcome: 'fixed' when a remediation (Rundeck) cleared the scenario, so the UI shows Resolved rather than a plain reset.
const state = { scenario: null, mode: null, since: null, outcome: null };
let resettingSince = null;
const isResetting = () => resettingSince !== null && Date.now() - resettingSince < RESETTING_EXPIRES_MS;

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics });

app.get('/flags', (req, res) => res.json(flags));
app.get('/state', (req, res) => res.json({ ...state, resetting: isResetting(), flags }));

// POST /flags {feedPaused?: bool, loadCustomers?: int}
app.post('/flags', (req, res) => {
  const b = req.body || {};
  if (typeof b.feedPaused === 'boolean') flags.feedPaused = b.feedPaused;
  if (Number.isInteger(b.loadCustomers) && b.loadCustomers >= 1 && b.loadCustomers <= MAX_LOAD_CUSTOMERS) flags.loadCustomers = b.loadCustomers;
  res.locals.logMsg = `flags set feedPaused=${flags.feedPaused} loadCustomers=${flags.loadCustomers}`;
  res.json(flags);
});

// POST /state {scenario?: string|null, mode?: 'quick'|'deep'|null, outcome?: 'fixed', resetting?: bool}
// Only the fields present are changed. Setting or clearing the scenario also clears outcome unless it is 'fixed'.
app.post('/state', (req, res) => {
  const b = req.body || {};
  if ('scenario' in b) {
    state.scenario = b.scenario || null;
    state.mode = state.scenario ? b.mode || 'quick' : null;
    state.since = state.scenario ? new Date().toISOString() : null;
    state.outcome = !state.scenario && b.outcome === 'fixed' ? 'fixed' : null;
  }
  if (typeof b.resetting === 'boolean') resettingSince = b.resetting ? Date.now() : null;
  res.locals.logMsg = `state set scenario=${state.scenario} mode=${state.mode} outcome=${state.outcome} resetting=${isResetting()}`;
  res.json({ ...state, resetting: isResetting() });
});

const server = app.listen(PORT, () => logger.info(`chaos-api listening on :${PORT}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
