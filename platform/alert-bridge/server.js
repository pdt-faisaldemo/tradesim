'use strict';
// alert-bridge (P5): every INTERVAL_S seconds it probes each TradeSim service (/health, /metrics), reads the pods in the
// tradesim namespace from the k8s API, checks postgres and redis, and turns what it finds into PagerDuty Events API v2
// alerts. ONE routing key (PD_ROUTING_KEY, a Global Event Orchestration); PagerDuty routes by payload.component.
// dedup_key = <service>:<check>. An alert resolves after RESOLVE_CYCLES healthy cycles. DRY_RUN=true logs instead of sending.
const fs = require('fs');
const https = require('https');
const net = require('net');
const express = require('express');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');

const SERVICE = 'alert-bridge';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8095', 10);
const NS = process.env.TRADESIM_NS || 'tradesim';
const CHAOS_URL = process.env.CHAOS_URL || 'http://chaos-api.platform:8090';
const EVENTS_URL = process.env.PD_EVENTS_URL || 'https://events.pagerduty.com/v2/enqueue';
const ROUTING_KEY = process.env.PD_ROUTING_KEY || '';
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

const num = (name, dflt) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : dflt);
const INTERVAL_S = num('INTERVAL_S', 15);
const T = {
  errorRate: num('ERROR_RATE_THRESHOLD', 0.2),
  minRequests: num('MIN_REQUESTS', 10),
  p95Ms: num('P95_THRESHOLD_MS', 2000),
  feedStaleS: num('FEED_STALE_S', 30),
  healthCycles: num('HEALTH_CYCLES', 2),
  resolveCycles: num('RESOLVE_CYCLES', 2),
  restartWindowS: num('RESTART_WINDOW_S', 120),
  suppressAfterResolveS: num('SUPPRESS_AFTER_RESOLVE_S', 30),
};
// error_rate over the last 30s (error_rate_30s) reacts and clears faster than the 60s window; ERROR_WINDOW=60 uses that.
const ERROR_WINDOW = String(process.env.ERROR_WINDOW || '30');

const logger = createLogger({ service: SERVICE, version: VERSION });
const metrics = createMetrics({ service: SERVICE, version: VERSION });

const HTTP_TARGETS = [['gateway', 8080], ['order', 8081], ['risk', 8082], ['account', 8083], ['portfolio', 8084], ['market-data', 8085]];
const TCP_TARGETS = [['postgres', 5432], ['redis', 6379]];
const ALL = [...HTTP_TARGETS.map(([n]) => n), ...TCP_TARGETS.map(([n]) => n)];
const urlOf = (name, port) => process.env[`${name.toUpperCase().replace(/-/g, '_')}_URL`] || `http://${name}.${NS}:${port}`;

// ---------- inputs ----------
async function getJson(url, timeoutMs = 2000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

function tcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok, reason) => { sock.destroy(); resolve({ ok, reason }); };
    sock.setTimeout(timeoutMs, () => done(false, `connect to ${host}:${port} timed out`));
    sock.on('connect', () => done(true));
    sock.on('error', (err) => done(false, `connect to ${host}:${port} failed: ${err.code || err.message}`));
  });
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
// Pods in the tradesim namespace through the in-cluster API. K8S_API_URL (plain http) is for tests.
function listPods() {
  return new Promise((resolve, reject) => {
    const apiUrl = process.env.K8S_API_URL;
    const reqPath = `/api/v1/namespaces/${NS}/pods`;
    const onRes = (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`k8s API returned ${res.statusCode}: ${data.slice(0, 120)}`));
        try { resolve(JSON.parse(data).items || []); } catch (err) { reject(err); }
      });
    };
    let req;
    if (apiUrl) {
      req = require('http').get(new URL(reqPath, apiUrl), onRes);
    } else {
      const host = process.env.KUBERNETES_SERVICE_HOST;
      if (!host) return reject(new Error('not running in a cluster (KUBERNETES_SERVICE_HOST unset)'));
      req = https.get({
        host, port: process.env.KUBERNETES_SERVICE_PORT || 443, path: reqPath,
        ca: fs.readFileSync(`${SA_DIR}/ca.crt`),
        headers: { Authorization: `Bearer ${fs.readFileSync(`${SA_DIR}/token`, 'utf8').trim()}` },
      }, onRes);
    }
    req.setTimeout(4000, () => req.destroy(new Error('k8s API timed out')));
    req.on('error', reject);
  });
}

// Per app: restart counts, CrashLoopBackOff, and the last termination reason, from the pods that are not shutting down.
function podFacts(items) {
  const facts = {};
  for (const pod of items) {
    const app = pod.metadata && pod.metadata.labels && pod.metadata.labels.app;
    if (!app || pod.metadata.deletionTimestamp) continue;
    const f = facts[app] || (facts[app] = { pods: [], restarts: 0, crashLoop: false, lastTerminated: null });
    for (const c of (pod.status && pod.status.containerStatuses) || []) {
      f.pods.push({ uid: pod.metadata.uid, name: pod.metadata.name, restartCount: c.restartCount });
      f.restarts += c.restartCount;
      if (c.state && c.state.waiting && c.state.waiting.reason === 'CrashLoopBackOff') f.crashLoop = true;
      const t = c.lastState && c.lastState.terminated;
      if (t && (!f.lastTerminated || Date.parse(t.finishedAt) > Date.parse(f.lastTerminated.finishedAt))) f.lastTerminated = t;
    }
  }
  return facts;
}

// ---------- alert state ----------
const open = new Map(); // dedup_key -> alert
const progress = new Map(); // dedup_key -> { bad: consecutive bad cycles, healthy: consecutive healthy cycles }
const lastRestart = new Map(); // service -> { at, reason }
const podRestarts = new Map(); // pod uid -> restartCount seen last cycle
const recent = []; // last sends, for /status
let suppressUntil = 0;
let lastCycle = null;
let cycles = 0;
let chaosState = { scenario: null, mode: null, story: { phase: 'idle' }, resetting: false };
let lastProbe = [];

function record(entry) {
  recent.unshift({ at: new Date().toISOString(), ...entry });
  if (recent.length > 50) recent.length = 50;
}

async function sendEvent(action, alert, extra = {}) {
  const body = { routing_key: ROUTING_KEY || '(unset)', event_action: action, dedup_key: alert.dedupKey };
  if (action === 'trigger') {
    body.payload = {
      summary: alert.summary,
      source: 'tradesim-k3s',
      severity: alert.severity,
      component: alert.service,
      group: 'tradesim',
      class: alert.check,
      custom_details: {
        service: alert.service, check: alert.check, threshold: alert.threshold, value: alert.value,
        sample_log: alert.sampleLog, demo_mode: chaosState.mode, scenario: chaosState.scenario,
      },
    };
  }
  const label = `${action} ${alert.dedupKey}`;
  if (DRY_RUN || !ROUTING_KEY) {
    const why = DRY_RUN ? 'DRY_RUN' : 'PD_ROUTING_KEY not set';
    logger.info(`${why}: would send ${label}: ${alert.summary}`, { dedup_key: alert.dedupKey, event_action: action, payload: { ...body, routing_key: '***' }, ...extra });
    record({ action, dedup_key: alert.dedupKey, summary: alert.summary, result: why });
    return;
  }
  try {
    const r = await fetch(EVENTS_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    logger.info(`pagerduty ${label} sent (HTTP ${r.status}): ${alert.summary}`, { dedup_key: alert.dedupKey, event_action: action, http_status: r.status, ...extra });
    record({ action, dedup_key: alert.dedupKey, summary: alert.summary, result: `HTTP ${r.status}`, response: r.ok ? undefined : text.slice(0, 160) });
  } catch (err) {
    logger.error(`pagerduty ${label} FAILED: ${err.message}`, { dedup_key: alert.dedupKey, event_action: action });
    record({ action, dedup_key: alert.dedupKey, summary: alert.summary, result: `failed: ${err.message}` });
  }
}

async function sampleLog(service) {
  const target = HTTP_TARGETS.find(([n]) => n === service);
  if (!target) return null;
  try {
    const { body } = await getJson(`${urlOf(...target)}/debug/last-error`, 1500);
    const e = body && body.lastError;
    return e ? `${e.ts || ''} ${e.msg || ''}`.trim() : null;
  } catch {
    return null;
  }
}

// cond: { service, check, severity, summary, threshold, value, bad, ok }. bad opens (or keeps) the alert; ok counts toward
// resolving it; neither (e.g. no data this cycle) changes nothing.
async function update(cond) {
  const key = `${cond.service}:${cond.check}`;
  const p = progress.get(key) || { bad: 0, healthy: 0 };
  const alert = open.get(key);
  if (cond.bad) {
    p.bad += 1;
    p.healthy = 0;
    progress.set(key, p);
    if (alert) { alert.summary = cond.summary; alert.value = cond.value; return; }
    if (Date.now() < suppressUntil) return;
    const need = cond.cycles || 1;
    if (p.bad < need) return;
    const fresh = {
      dedupKey: key, service: cond.service, check: cond.check, severity: cond.severity, summary: cond.summary,
      threshold: cond.threshold, value: cond.value, sampleLog: (await sampleLog(cond.service)) || '(no error logged)', openedAt: new Date().toISOString(),
    };
    open.set(key, fresh);
    await sendEvent('trigger', fresh);
  } else if (cond.ok) {
    p.bad = 0;
    p.healthy += 1;
    progress.set(key, p);
    if (alert && p.healthy >= T.resolveCycles) {
      open.delete(key);
      await sendEvent('resolve', alert, { reason: `healthy for ${p.healthy} cycles` });
    }
  } else {
    p.bad = 0;
    progress.set(key, p);
  }
}

async function resolveAll(reason) {
  const alerts = [...open.values()];
  open.clear();
  progress.clear();
  suppressUntil = Date.now() + T.suppressAfterResolveS * 1000;
  logger.info(`resolving ${alerts.length} open alert(s): ${reason}`);
  await Promise.all(alerts.map((a) => sendEvent('resolve', a, { reason })));
  return alerts.length;
}

// ---------- the cycle ----------
const pct = (x) => `${Math.round(x * 100)}%`;

async function probe([name, port]) {
  const url = urlOf(name, port);
  const out = { name, healthy: false, reason: null, metrics: null };
  const [h, m] = await Promise.allSettled([getJson(`${url}/health`), getJson(`${url}/metrics`)]);
  if (h.status === 'fulfilled') {
    out.healthy = h.value.ok;
    if (!h.value.ok) out.reason = (h.value.body && h.value.body.reason) || `health returned ${h.value.status}`;
  } else {
    const cause = h.reason.cause && (h.reason.cause.code || h.reason.cause.message);
    out.reason = h.reason.name === 'TimeoutError' ? 'health check timed out' : `unreachable: ${cause || h.reason.message}`;
  }
  if (m.status === 'fulfilled' && m.value.ok) out.metrics = m.value.body;
  return out;
}

async function runCycle() {
  cycles += 1;
  const now = Date.now();
  // Story and scenario, from chaos-api. A reset or a cleared story resolves everything at once (the scripts also call
  // POST /resolve-all themselves, this catches the cases where they could not).
  try {
    const { body } = await getJson(`${CHAOS_URL}/state`, 1500);
    const was = chaosState.story && chaosState.story.phase;
    chaosState = { scenario: body.scenario || null, mode: body.mode || null, story: body.story || { phase: 'idle' }, resetting: Boolean(body.resetting) };
    const phase = chaosState.story.phase;
    if (chaosState.resetting) { if (open.size) await resolveAll('reset in progress'); suppressUntil = now + T.suppressAfterResolveS * 1000; }
    else if (was && was !== 'idle' && phase === 'idle' && open.size) await resolveAll('story cleared');
  } catch (err) {
    logger.warn(`chaos-api unreachable, scenario unknown: ${err.message}`);
  }

  let facts = null;
  try { facts = podFacts(await listPods()); } catch (err) { logger.warn(`cannot read pods: ${err.message}`); }

  const results = await Promise.all(HTTP_TARGETS.map(probe));
  const tcp = await Promise.all(TCP_TARGETS.map(async ([name, port]) => {
    const r = await tcpReachable(`${name}.${NS}`, port);
    return { name, healthy: r.ok, reason: r.reason, metrics: null };
  }));
  const everything = [...results, ...tcp];
  lastProbe = everything.map((r) => ({
    name: r.name, healthy: r.healthy, reason: r.reason,
    error_rate: r.metrics ? (ERROR_WINDOW === '60' ? r.metrics.error_rate : r.metrics.error_rate_30s ?? r.metrics.error_rate) : null,
    p95_ms: r.metrics ? r.metrics.p95_ms : null, last_tick_age_s: r.metrics ? r.metrics.last_tick_age_s ?? null : null,
  }));

  for (const r of everything) {
    const m = r.metrics;
    // health failing for HEALTH_CYCLES cycles in a row
    await update({
      service: r.name, check: 'health', severity: 'critical', cycles: T.healthCycles, threshold: `${T.healthCycles} failing cycles`,
      value: r.reason, summary: `${r.name}: health check failing (${r.reason})`, bad: !r.healthy, ok: r.healthy,
    });
    if (m) {
      const rate = ERROR_WINDOW === '60' ? m.error_rate : m.error_rate_30s ?? m.error_rate;
      const reqs = ERROR_WINDOW === '60' ? m.requests : m.requests_30s ?? m.requests;
      const badRate = rate > T.errorRate && reqs >= T.minRequests;
      await update({
        service: r.name, check: 'error_rate', severity: 'critical', threshold: T.errorRate, value: rate,
        summary: `${r.name}: error rate ${pct(rate)} (threshold ${pct(T.errorRate)})`, bad: badRate, ok: !badRate,
      });
      const slow = m.p95_ms > T.p95Ms;
      await update({
        service: r.name, check: 'latency', severity: 'warning', threshold: T.p95Ms, value: m.p95_ms,
        summary: `${r.name}: p95 latency ${m.p95_ms}ms (threshold ${T.p95Ms}ms)`, bad: slow, ok: !slow,
      });
      if (r.name === 'market-data' && typeof m.last_tick_age_s === 'number') {
        const stale = m.last_tick_age_s > T.feedStaleS;
        await update({
          service: 'market-data', check: 'feed_stale', severity: 'critical', threshold: T.feedStaleS, value: m.last_tick_age_s,
          summary: `market-data: price feed stale (last tick ${Math.round(m.last_tick_age_s)}s ago, threshold ${T.feedStaleS}s)`, bad: stale, ok: !stale,
        });
      }
    }
  }

  if (facts) {
    for (const name of ALL) {
      const f = facts[name];
      if (!f) continue;
      // Restart increase on a pod we already knew; a replaced pod starts again at 0 and is not a restart.
      for (const p of f.pods) {
        const before = podRestarts.get(p.uid);
        if (before !== undefined && p.restartCount > before) {
          const reason = f.lastTerminated ? f.lastTerminated.reason : 'unknown';
          lastRestart.set(name, { at: now, reason });
        }
        podRestarts.set(p.uid, p.restartCount);
      }
      // First sight of a pod that was OOM killed recently (bridge restarted while the problem was going on).
      const t = f.lastTerminated;
      if (t && t.reason === 'OOMKilled' && now - Date.parse(t.finishedAt) < T.restartWindowS * 1000 && !lastRestart.has(name)) {
        lastRestart.set(name, { at: Date.parse(t.finishedAt), reason: 'OOMKilled' });
      }
      const lr = lastRestart.get(name);
      const recently = Boolean(lr) && now - lr.at < T.restartWindowS * 1000;
      const oom = recently && lr.reason === 'OOMKilled';
      await update({
        service: name, check: 'restarts', severity: 'critical', threshold: 'any restart', value: f.restarts,
        summary: oom ? `${name}: container OOMKilled and restarted (${f.restarts} restarts)` : `${name}: pod restarted (${f.restarts} restarts, last exit: ${lr ? lr.reason : 'unknown'})`,
        bad: recently, ok: !recently,
      });
      const t2 = f.lastTerminated;
      await update({
        service: name, check: 'crashloop', severity: 'critical', threshold: 'CrashLoopBackOff', value: f.restarts,
        summary: `${name}: CrashLoopBackOff (${f.restarts} restarts${t2 ? `, last exit: ${t2.reason} code ${t2.exitCode}` : ''})`, bad: f.crashLoop, ok: !f.crashLoop,
      });
    }
  }
  lastCycle = new Date().toISOString();
  logger.info(`cycle ${cycles}: ${open.size} open alert(s)`, { open: [...open.keys()] });
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await runCycle(); } catch (err) { logger.error(`cycle failed: ${err.stack || err.message}`); } finally { running = false; }
}

// ---------- http ----------
const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics });

app.get('/status', (req, res) => res.json({
  dryRun: DRY_RUN, routingKeySet: Boolean(ROUTING_KEY), intervalS: INTERVAL_S, cycles, lastCycle,
  scenario: chaosState.scenario, mode: chaosState.mode, story: chaosState.story.phase, suppressedUntil: suppressUntil > Date.now() ? new Date(suppressUntil).toISOString() : null,
  open: [...open.values()].map(({ dedupKey, service, check, severity, summary, value, threshold, openedAt, sampleLog: log }) => ({ dedup_key: dedupKey, service, check, severity, summary, value, threshold, openedAt, sample_log: log })),
  services: lastProbe,
  recent,
}));

// reset.sh and clear-story.sh call this so the alerts resolve now, not at the next cycle.
app.post('/resolve-all', async (req, res) => {
  const n = await resolveAll((req.body && req.body.reason) || 'requested');
  res.locals.logMsg = `resolve-all: ${n} alert(s)`;
  res.json({ resolved: n });
});

const server = app.listen(PORT, () => {
  logger.info(`alert-bridge listening on :${PORT} dry_run=${DRY_RUN} routing_key=${ROUTING_KEY ? 'set' : 'NOT SET (events are only logged)'} interval=${INTERVAL_S}s`);
  tick();
  setInterval(tick, INTERVAL_S * 1000).unref();
});
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
