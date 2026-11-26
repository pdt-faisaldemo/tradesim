'use strict';
// Minimal chaos-api (P4): the demo flags and the active-scenario state, kept in memory.
// P6 extends this with the /ops console, scenario/reset endpoints and RBAC. State is lost on restart,
// which is safe: flags default to off and scripts/reset.sh clears both.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

// ---------- /ops console and script runner ----------
// The scenario, fix, clear-story and reset buttons run the scripts in scripts/ (the same ones used by hand) inside this pod,
// with kubectl and the ServiceAccount from k8s/platform/chaos-api.yaml. One script at a time; RESET ALL stops whatever runs.
// Only /ops is routed from outside the cluster (k8s/platform/chaos-api.yaml), and it needs basic auth.
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(__dirname, '../..');
const ALERT_BRIDGE_URL = process.env.ALERT_BRIDGE_URL || 'http://alert-bridge.platform:8095';
const TRADESIM_NS = process.env.TRADESIM_NS || 'tradesim';
const OPS_USER = process.env.OPS_USER || '';
const OPS_PASSWORD = process.env.OPS_PASSWORD || '';
const SCENARIOS = ['S1', 'S1R', 'S2', 'S3', 'S4', 'S4R', 'S5', 'COMBO'];
const SERVICE_PORTS = [['gateway', 8080], ['order', 8081], ['risk', 8082], ['account', 8083], ['portfolio', 8084], ['market-data', 8085]];
const OUTPUT_CAP = 200 * 1024;

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function requireOps(req, res, next) {
  if (!OPS_USER || !OPS_PASSWORD) {
    res.locals.logMsg = 'ops refused: OPS_USER / OPS_PASSWORD are not set';
    return res.status(503).type('text/plain').send('The ops console is disabled: set OPS_USER and OPS_PASSWORD in tradesim-secrets and restart chaos-api.');
  }
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  const [user, ...rest] = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':') : [];
  if (m && safeEqual(user || '', OPS_USER) && safeEqual(rest.join(':'), OPS_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="TradeSim ops", charset="UTF-8"');
  res.locals.logMsg = 'ops auth failed';
  return res.status(401).type('text/plain').send('Authentication required');
}

// The one running (or last) script.
const run = { id: 0, action: null, label: null, startedAt: null, endedAt: null, exitCode: null, child: null, text: '', dropped: 0 };
const running = () => run.child !== null;
function append(chunk) {
  run.text += chunk;
  if (run.text.length > OUTPUT_CAP) { const cut = run.text.length - OUTPUT_CAP; run.text = run.text.slice(cut); run.dropped += cut; }
  for (const w of run.watchers || []) w(chunk);
}

// Which actions the current story allows. The UI disables the other buttons; the API enforces the same rules.
function allowedNow() {
  const phase = story.phase;
  const free = !running();
  return {
    scenario: free && (phase === 'idle' || phase === 'resolved'),
    fix: free && (phase === 'incident' || phase === 'fixing'),
    clearStory: free && phase !== 'idle',
    reset: true, // always: it stops a running script first
  };
}

function startScript(action, args, label) {
  const allowed = allowedNow();
  if (action === 'scenario' && !allowed.scenario) return { error: running() ? `${run.label} is still running` : `a scenario is still ${story.phase}: fix it and clear the story, or reset` };
  if (action === 'fix' && !allowed.fix) return { error: running() ? `${run.label} is still running` : `nothing to fix: the story is ${story.phase}` };
  if (action === 'clear-story' && !allowed.clearStory) return { error: running() ? `${run.label} is still running` : 'the story is already idle' };
  if (action === 'reset' && running()) {
    try { process.kill(-run.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    append('\n[ops] stopped the running script for a reset\n');
  }
  const script = { scenario: 'scenario.sh', fix: 'fix.sh', 'clear-story': 'clear-story.sh', reset: 'reset.sh' }[action];
  if (!script) return { error: `unknown action ${action}` };
  Object.assign(run, { id: run.id + 1, action, label, startedAt: Date.now(), endedAt: null, exitCode: null, text: '', dropped: 0, watchers: [] });
  append(`$ scripts/${script} ${args.join(' ')}\n`);
  const child = spawn('bash', [path.join(REPO_ROOT, 'scripts', script), ...args], {
    cwd: REPO_ROOT, detached: true, env: { ...process.env, IN_CLUSTER: '1', TERM: 'dumb', CHAOS_URL: `http://127.0.0.1:${PORT}` },
  });
  run.child = child;
  const mine = run.id;
  child.stdout.on('data', (d) => append(d.toString()));
  child.stderr.on('data', (d) => append(d.toString()));
  const finish = (code, err) => {
    if (run.id !== mine || !running()) return;
    if (err) append(`[ops] could not run the script: ${err.message}\n`);
    run.child = null;
    run.endedAt = Date.now();
    run.exitCode = code;
    append(`\n[ops] ${label} finished with exit code ${code}\n`);
    logger.info(`ops: ${label} finished exit=${code}`);
    for (const w of run.watchers) w(null);
  };
  child.on('close', (code) => finish(code === null ? 143 : code));
  child.on('error', (err) => finish(127, err));
  logger.info(`ops: started ${label}`);
  return { ok: true, id: run.id };
}

const runBody = (req) => {
  const b = req.body || {};
  const mode = String(b.mode || 'quick').toLowerCase();
  return { scenario: String(b.scenario || req.params.id || '').toUpperCase(), mode: mode === 'deep' ? 'deep' : 'quick' };
};
function handleAction(action) {
  return (req, res) => {
    const { scenario, mode } = runBody(req);
    let args = [];
    let label = action;
    if (action === 'scenario') {
      if (!SCENARIOS.includes(scenario)) return res.status(400).json({ error: `scenario must be one of ${SCENARIOS.join(', ')}` });
      args = [scenario, mode];
      label = `scenario ${scenario} ${mode}`;
    }
    if (action === 'fix') label = `fix${story.scenario ? ` ${story.scenario}` : ''}`;
    const r = startScript(action, args, label);
    if (r.error) { res.locals.logMsg = `ops refused ${label}: ${r.error}`; return res.status(409).json({ error: r.error, allowed: allowedNow() }); }
    res.locals.logMsg = `ops: ${label} started`;
    res.status(202).json({ ...r, label });
  };
}

app.get('/ops', requireOps, (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'ops.html')));
app.post('/ops/api/scenario', requireOps, handleAction('scenario'));
app.post('/ops/api/fix', requireOps, handleAction('fix'));
app.post('/ops/api/clear-story', requireOps, handleAction('clear-story'));
app.post('/ops/api/reset', requireOps, handleAction('reset'));
// The same actions without the /ops prefix (CLAUDE.md): POST /scenario/:id {mode}, POST /reset streams the output.
app.post('/scenario/:id', requireOps, handleAction('scenario'));
app.post('/fix', requireOps, handleAction('fix'));
app.post('/clear-story', requireOps, handleAction('clear-story'));
app.post('/reset', requireOps, (req, res) => {
  const r = startScript('reset', [], 'reset');
  if (r.error) return res.status(409).json({ error: r.error });
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write(run.text);
  const watcher = (chunk) => { if (chunk === null) res.end(); else res.write(chunk); };
  run.watchers.push(watcher);
  res.on('close', () => { run.watchers = run.watchers.filter((w) => w !== watcher); });
});

// Output since byte offset `from` (offsets count from the start of the run; `dropped` bytes may be gone).
app.get('/ops/api/output', requireOps, (req, res) => {
  const from = Math.max(0, parseInt(req.query.from || '0', 10) || 0);
  const total = run.dropped + run.text.length;
  const start = Math.max(from, run.dropped);
  res.set('Cache-Control', 'no-store').json({
    id: run.id, label: run.label, running: running(), startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode,
    from: start, total, text: run.text.slice(start - run.dropped),
  });
});

async function fetchJson(url, headers, timeoutMs = 2000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// The PagerDuty incident behind the story (needs PD_API_TOKEN and PD_SERVICE_IDS). Cached for 8s.
const pdCache = { at: 0, key: '', value: null };
async function openIncident() {
  const token = process.env.PD_API_TOKEN;
  const ids = (process.env.PD_SERVICE_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!token || !ids.length || story.phase === 'idle' || !story.startedAt) return null;
  const key = `${story.startedAt}`;
  if (pdCache.key === key && Date.now() - pdCache.at < 8000) return pdCache.value;
  pdCache.at = Date.now();
  pdCache.key = key;
  try {
    const url = new URL('https://api.pagerduty.com/incidents');
    for (const id of ids) url.searchParams.append('service_ids[]', id);
    for (const st of ['triggered', 'acknowledged', 'resolved']) url.searchParams.append('statuses[]', st);
    url.searchParams.set('since', new Date(story.startedAt - 60000).toISOString());
    url.searchParams.set('sort_by', 'created_at:asc');
    url.searchParams.set('limit', '25');
    const body = await fetchJson(url, { Authorization: `Token token=${token}`, Accept: 'application/vnd.pagerduty+json;version=2' }, 4000);
    const incs = body.incidents || [];
    const pick = incs.find((i) => i.status !== 'resolved') || incs[incs.length - 1];
    pdCache.value = pick ? { number: pick.incident_number, title: pick.title, status: pick.status, url: pick.html_url } : null;
  } catch (err) {
    logger.warn(`ops: PagerDuty incident lookup failed: ${err.message}`);
    pdCache.value = null;
  }
  return pdCache.value;
}

app.get('/ops/api/status', requireOps, async (req, res) => {
  const [services, alerts, incident] = await Promise.all([
    Promise.all(SERVICE_PORTS.map(async ([name, port]) => {
      try {
        const r = await fetch(`http://${name}.${TRADESIM_NS}:${port}/health`, { signal: AbortSignal.timeout(1500) });
        const b = await r.json().catch(() => ({}));
        return { name, healthy: r.ok, reason: r.ok ? null : b.reason || `health returned ${r.status}` };
      } catch (err) {
        return { name, healthy: false, reason: err.name === 'TimeoutError' ? 'timed out' : 'unreachable' };
      }
    })),
    fetchJson(`${ALERT_BRIDGE_URL}/status`, undefined, 1500).then((b) => ({ ok: true, dryRun: b.dryRun, open: b.open, lastCycle: b.lastCycle })).catch(() => ({ ok: false, open: [] })),
    openIncident(),
  ]);
  res.set('Cache-Control', 'no-store').json({
    serverNow: Date.now(), story, scenario: state.scenario, mode: state.mode, resetting: isResetting(), flags,
    services, alerts, incident, allowed: allowedNow(), run: { id: run.id, label: run.label, running: running() },
  });
});

const server = app.listen(PORT, () => logger.info(`chaos-api listening on :${PORT}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
