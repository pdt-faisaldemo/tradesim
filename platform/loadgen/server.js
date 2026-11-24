'use strict';
// Synthetic customers: each one, every LOADGEN_INTERVAL_MS, gets quotes, portfolio and account (what the
// dashboard polls) and places a small order, all through the gateway. Never stops. This traffic is what makes
// error rates, pool saturation (S2) and the memory leak (S4) real.
// The customer count follows chaos-api flag loadCustomers (5 normally, 20 during S2), polled every 5s.
const express = require('express');
const { createLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { SYMBOLS } = require('../../shared/tickers');

const SERVICE = 'loadgen';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8090', 10);
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway.tradesim:8080';
const BASE_CUSTOMERS = parseInt(process.env.LOADGEN_BASE_CUSTOMERS || '5', 10);
const MAX_CUSTOMERS = 20; // seeded accounts c-2001 to c-2020
const CHAOS_API_URL = process.env.CHAOS_API_URL || 'http://chaos-api.platform:8090';
const FLAG_POLL_MS = 5000;
// Seeded in k8s/base/seed-job.yaml.
const loadCustomerId = (i) => `c-${2001 + i}`;
const INTERVAL_MS = parseInt(process.env.LOADGEN_INTERVAL_MS || '2000', 10);
const MAX_QTY = parseInt(process.env.LOADGEN_MAX_QTY || '3', 10);
const MAX_INFLIGHT = 3; // per customer; a hung backend must not pile up unbounded cycles
const REPORT_MS = 10000;
const SUMMARY_MS = 30000;

const logger = createLogger({ service: SERVICE, version: VERSION });
const totals = { calls: 0, failed: 0, cycles: 0 };
const workers = []; // one per running customer: { customerId, timer }
const metrics = createMetrics({ service: SERVICE, version: VERSION, extra: () => ({ ...totals, customers: workers.length }) });

// Failures are aggregated per call+status so an outage logs a few clean lines, not one per request.
let failures = new Map();

async function step(name, customerId, method, path, body) {
  const start = Date.now();
  totals.calls++;
  let status = 0;
  let sample = null;
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    status = res.status;
    const text = await res.text();
    if (status >= 400) sample = (() => { try { return JSON.parse(text); } catch { return { error: text.slice(0, 120) }; } })();
  } catch (err) {
    sample = { error: err.name === 'TimeoutError' ? 'timed out after 5000ms' : `${err.message}${err.cause && err.cause.code ? ` (${err.cause.code})` : ''}` };
  }
  metrics.record(`${method} ${name}`, status || 599, Date.now() - start);
  if (status >= 200 && status < 400) return true;
  totals.failed++;
  const key = `${name} ${status || 'no-response'}`;
  const f = failures.get(key) || { count: 0, customerId, sample };
  f.count++;
  failures.set(key, f);
  return false;
}

async function cycle(customerId) {
  const id = encodeURIComponent(customerId);
  await step('quotes', customerId, 'GET', '/api/quotes');
  await step('portfolio', customerId, 'GET', `/api/portfolio/${id}`);
  await step('account', customerId, 'GET', `/api/accounts/${id}`);
  const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  const qty = 1 + Math.floor(Math.random() * MAX_QTY);
  await step('order', customerId, 'POST', '/api/orders', { customerId, symbol, qty });
  totals.cycles++;
}

function startCustomer(id, offsetMs) {
  const worker = { customerId: id, timer: null, starter: null };
  let inflight = 0;
  // Stagger customers across the interval so load is steady rather than bursty.
  worker.starter = setTimeout(() => {
    worker.timer = setInterval(() => {
      if (inflight >= MAX_INFLIGHT) return;
      inflight++;
      cycle(id).catch((err) => logger.error(`cycle crashed customer=${id}: ${err.message}`)).finally(() => { inflight--; });
    }, INTERVAL_MS);
  }, offsetMs);
  workers.push(worker);
}

function setCustomerCount(n) {
  if (n === workers.length) return;
  const from = workers.length;
  while (workers.length > n) {
    const w = workers.pop();
    clearTimeout(w.starter);
    clearInterval(w.timer);
  }
  while (workers.length < n) startCustomer(loadCustomerId(workers.length), Math.round((workers.length * INTERVAL_MS) / n));
  logger.info(`loadgen customers ${from} -> ${n}`);
}

let flagsReachable = null;
async function pollFlags() {
  try {
    const r = await fetch(`${CHAOS_API_URL}/flags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const n = (await r.json()).loadCustomers;
    if (Number.isInteger(n) && n >= 1 && n <= MAX_CUSTOMERS) setCustomerCount(n);
    flagsReachable = true;
  } catch (err) {
    // Keep whatever is running: an unreachable chaos-api must not change the load.
    if (flagsReachable !== false) logger.info(`flags unavailable at CHAOS_API_URL=${CHAOS_API_URL} (${err.message}); keeping ${workers.length} customers`);
    flagsReachable = false;
  }
}

setCustomerCount(BASE_CUSTOMERS);
pollFlags();
setInterval(pollFlags, FLAG_POLL_MS).unref();

setInterval(() => {
  for (const [key, f] of failures) {
    logger.warn(`loadgen ${key}: ${f.count} failures in last ${REPORT_MS / 1000}s, e.g. customer=${f.customerId} ${JSON.stringify(f.sample)}`, { traceId: f.sample && f.sample.traceId });
  }
  failures = new Map();
}, REPORT_MS).unref();

setInterval(() => {
  const m = metrics.snapshot();
  logger.info(`loadgen summary (60s): requests=${m.requests} errors=${m.errors} error_rate=${m.error_rate} p95_ms=${m.p95_ms} customers=${workers.length} gateway=${GATEWAY_URL}`);
}, SUMMARY_MS).unref();

const app = express();
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics });
const server = app.listen(PORT, () => logger.info(`loadgen started: ${workers.length} customers every ${INTERVAL_MS}ms against ${GATEWAY_URL}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
