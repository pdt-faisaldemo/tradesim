'use strict';
const path = require('path');
const express = require('express');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { call, route } = require('../../shared/http');

const SERVICE = 'gateway';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8080', 10);
const ORDER_URL = process.env.ORDER_URL || 'http://order:8081';
const RISK_URL = process.env.RISK_URL || 'http://risk:8082';
const ACCOUNT_URL = process.env.ACCOUNT_URL || 'http://account:8083';
const PORTFOLIO_URL = process.env.PORTFOLIO_URL || 'http://portfolio:8084';
const MARKET_DATA_URL = process.env.MARKET_DATA_URL || 'http://market-data:8085';
const DEFAULT_CUSTOMER = 'c-1001';

const logger = createLogger({ service: SERVICE, version: VERSION });
const metrics = createMetrics({ service: SERVICE, version: VERSION });

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics });

// Relays an upstream response: 2xx/4xx pass through; timeouts and 5xx become 503/502 via route().
const relay = (res, upstreamRes) => res.status(upstreamRes.status).json(upstreamRes.body);
const enc = encodeURIComponent;

app.get('/api/quotes', route(async (req, res) => {
  relay(res, await call('market-data', `${MARKET_DATA_URL}/quotes`, { traceId: req.traceId }));
}));

app.get('/api/accounts/:id', route(async (req, res) => {
  relay(res, await call('account', `${ACCOUNT_URL}/accounts/${enc(req.params.id)}`, { traceId: req.traceId }));
}));

app.get('/api/portfolio/:id', route(async (req, res) => {
  relay(res, await call('portfolio', `${PORTFOLIO_URL}/portfolio/${enc(req.params.id)}`, { traceId: req.traceId }));
}));

app.get('/api/orders', route(async (req, res) => {
  const customerId = req.query.customerId || DEFAULT_CUSTOMER;
  const limit = req.query.limit || 10;
  relay(res, await call('order', `${ORDER_URL}/orders?customerId=${enc(customerId)}&limit=${enc(limit)}`, { traceId: req.traceId }));
}));

// POST /api/orders {customerId?, symbol, qty}: the gateway prices the order from market-data.
app.post('/api/orders', route(async (req, res) => {
  const { symbol, qty } = req.body || {};
  const customerId = (req.body && req.body.customerId) || DEFAULT_CUSTOMER;
  const quotes = await call('market-data', `${MARKET_DATA_URL}/quotes`, { traceId: req.traceId });
  const price = quotes.status === 200 ? quotes.body.prices[symbol] : undefined;
  if (price === undefined) {
    res.locals.logMsg = `order not sent: no price for symbol=${symbol} (market-data ${quotes.status})`;
    return res.status(400).json({ error: `unknown symbol ${symbol}`, traceId: req.traceId });
  }
  relay(res, await call('order', `${ORDER_URL}/orders`, {
    method: 'POST',
    body: { customerId, symbol, qty, price },
    traceId: req.traceId,
  }));
}));

// ---- health summary: the six dots, plus a degraded flag for the status banner ----
const HEALTH_TARGETS = [
  ['order', ORDER_URL],
  ['risk', RISK_URL],
  ['account', ACCOUNT_URL],
  ['portfolio', PORTFOLIO_URL],
  ['market-data', MARKET_DATA_URL],
];

async function checkHealth(name, url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return { name, healthy: true };
    const body = await r.json().catch(() => ({}));
    return { name, healthy: false, reason: body.reason || `health returned ${r.status}` };
  } catch (err) {
    const cause = err.cause && (err.cause.code || err.cause.message);
    return { name, healthy: false, reason: err.name === 'TimeoutError' ? 'health check timed out' : `unreachable: ${cause || err.message}` };
  }
}

// Cached for 2s so many browsers polling every 3s do not fan out to every service each time.
let healthCache = { at: 0, value: null };
async function healthSummary() {
  if (healthCache.value && Date.now() - healthCache.at < 2000) return healthCache.value;
  const others = await Promise.all(HEALTH_TARGETS.map(([name, url]) => checkHealth(name, url)));
  const services = [{ name: 'gateway', healthy: true }, ...others];
  const value = { asOf: new Date().toISOString(), healthy: services.every((s) => s.healthy), services };
  healthCache = { at: Date.now(), value };
  return value;
}

app.get('/api/health-summary', route(async (req, res) => {
  res.json(await healthSummary());
}));

// Fallback implementation (incident lookup is not wired up yet): degraded when any service is unhealthy.
app.get('/api/status', route(async (req, res) => {
  const summary = await healthSummary();
  const unhealthy = summary.services.filter((s) => !s.healthy).map((s) => s.name);
  res.json({ degraded: unhealthy.length > 0, source: 'health-summary', unhealthy, asOf: summary.asOf });
}));

app.use('/api', (req, res) => {
  res.locals.logMsg = `no such route ${req.method} ${req.originalUrl.split('?')[0]}`;
  res.status(404).json({ error: 'not found', traceId: req.traceId });
});

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => logger.info(`gateway listening on :${PORT} upstreams: order=${ORDER_URL} portfolio=${PORTFOLIO_URL} market-data=${MARKET_DATA_URL} account=${ACCOUNT_URL}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
