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

const flags = { feedPaused: false };
const state = { scenario: null, mode: null, since: null };

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics });

app.get('/flags', (req, res) => res.json(flags));
app.get('/state', (req, res) => res.json({ ...state, flags }));

// POST /flags {feedPaused: bool}
app.post('/flags', (req, res) => {
  if (typeof (req.body || {}).feedPaused === 'boolean') flags.feedPaused = req.body.feedPaused;
  res.locals.logMsg = `flags set feedPaused=${flags.feedPaused}`;
  res.json(flags);
});

// POST /state {scenario: string|null, mode: 'quick'|'deep'|null}
app.post('/state', (req, res) => {
  const { scenario = null, mode = null } = req.body || {};
  state.scenario = scenario;
  state.mode = scenario ? mode : null;
  state.since = scenario ? new Date().toISOString() : null;
  res.locals.logMsg = `state set scenario=${state.scenario} mode=${state.mode}`;
  res.json(state);
});

const server = app.listen(PORT, () => logger.info(`chaos-api listening on :${PORT}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
