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
// The scenario that is active (kept until the story is cleared, alert-bridge reads it as demo_mode).
const state = { scenario: null, mode: null, since: null };

// The panel "story": the single source of truth for what the UI panels show. Phases only move forward:
//   idle -> incident -> fixing -> resolved -> idle (only via POST /story/clear, which reset.sh and clear-story.sh call)
// scenario.sh starts it, the gateway reports detection and resolution (it owns the health signals), fix.sh moves it to
// fixing. kind 'partial' is a fix that does not remove the cause (S4 restart): the leak returns, so it never resolves.
// Held in memory: a chaos-api restart returns to idle, which is what a redeploy followed by reset.sh wants anyway.
const freshStory = () => ({
  phase: 'idle', scenario: null, mode: null, startedAt: null, detectedAt: null,
  fixAt: null, lastFixAt: null, fixScenario: null, fixKind: null, resolvedAt: null, resolvedWhy: null, frozen: null,
});
let story = freshStory();
let resettingSince = null;
const isResetting = () => resettingSince !== null && Date.now() - resettingSince < RESETTING_EXPIRES_MS;

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics });

app.get('/flags', (req, res) => res.json(flags));
app.get('/state', (req, res) => res.json({ ...state, story, resetting: isResetting(), flags }));

// POST /flags {feedPaused?: bool, loadCustomers?: int}
app.post('/flags', (req, res) => {
  const b = req.body || {};
  if (typeof b.feedPaused === 'boolean') flags.feedPaused = b.feedPaused;
  if (Number.isInteger(b.loadCustomers) && b.loadCustomers >= 1 && b.loadCustomers <= MAX_LOAD_CUSTOMERS) flags.loadCustomers = b.loadCustomers;
  res.locals.logMsg = `flags set feedPaused=${flags.feedPaused} loadCustomers=${flags.loadCustomers}`;
  res.json(flags);
});

// POST /state {resetting?: bool}: reset.sh sets it for the duration of the reset.
app.post('/state', (req, res) => {
  const b = req.body || {};
  if (typeof b.resetting === 'boolean') resettingSince = b.resetting ? Date.now() : null;
  res.locals.logMsg = `state resetting=${isResetting()}`;
  res.json({ ...state, story, resetting: isResetting() });
});

const refuse = (res, msg) => {
  res.locals.logMsg = `story refused: ${msg}`;
  return res.status(409).json({ error: msg, phase: story.phase });
};
const moved = (res, msg) => {
  res.locals.logMsg = `story ${msg}`;
  res.json(story);
};

// POST /story/start {scenario, mode, force?}: scenario.sh, the moment it starts. Only from idle (force overrides).
app.post('/story/start', (req, res) => {
  const b = req.body || {};
  if (!b.scenario) return res.status(400).json({ error: 'scenario is required' });
  if (story.phase !== 'idle' && !b.force) return refuse(res, `story is ${story.phase} (scenario ${story.scenario}), clear it first`);
  story = { ...freshStory(), phase: 'incident', scenario: b.scenario, mode: b.mode || 'quick', startedAt: Date.now() };
  Object.assign(state, { scenario: story.scenario, mode: story.mode, since: new Date(story.startedAt).toISOString() });
  moved(res, `incident started scenario=${story.scenario} mode=${story.mode}`);
});

// POST /story/detected: the gateway saw the first unhealthy signal. Sets the time once, only while incident or fixing.
app.post('/story/detected', (req, res) => {
  if (story.phase !== 'incident' && story.phase !== 'fixing') return refuse(res, `cannot mark detected while ${story.phase}`);
  if (!story.detectedAt) { story.detectedAt = Date.now(); return moved(res, `detected scenario=${story.scenario}`); }
  res.json(story);
});

// POST /story/fix {scenario?, kind: 'full'|'partial'}: fix.sh, when it starts. Valid from incident or fixing.
app.post('/story/fix', (req, res) => {
  const b = req.body || {};
  if (story.phase !== 'incident' && story.phase !== 'fixing') return refuse(res, `no incident to fix (story is ${story.phase})`);
  const now = Date.now();
  story.phase = 'fixing';
  story.fixAt = story.fixAt || now;
  story.lastFixAt = now;
  story.detectedAt = story.detectedAt || now;
  story.fixScenario = b.scenario || story.scenario;
  story.fixKind = b.kind === 'partial' ? 'partial' : 'full';
  moved(res, `fixing scenario=${story.scenario} fix=${story.fixScenario} kind=${story.fixKind}`);
});

// POST /story/resolve {why, frozen}: the gateway saw the services healthy long enough (or PagerDuty resolved). Only from fixing.
app.post('/story/resolve', (req, res) => {
  const b = req.body || {};
  if (story.phase !== 'fixing') return refuse(res, `cannot resolve while ${story.phase}`);
  story.phase = 'resolved';
  story.resolvedAt = Date.now();
  story.resolvedWhy = typeof b.why === 'string' ? b.why.slice(0, 80) : null;
  story.frozen = b.frozen && typeof b.frozen === 'object' ? b.frozen : null;
  moved(res, `resolved scenario=${story.scenario} why=${story.resolvedWhy}`);
});

// POST /story/clear: back to idle. The only way there. Does not touch flags or the environment.
app.post('/story/clear', (req, res) => {
  const was = story.phase;
  story = freshStory();
  Object.assign(state, { scenario: null, mode: null, since: null });
  moved(res, `cleared (was ${was})`);
});

const server = app.listen(PORT, () => logger.info(`chaos-api listening on :${PORT}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
