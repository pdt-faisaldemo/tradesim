'use strict';
const path = require('path');
const express = require('express');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { call, route, UpstreamError } = require('../../shared/http');
const { createSampler } = require('./sampler');
const { createIncidentPanel } = require('./incident-panel');

const SERVICE = 'gateway';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8080', 10);
const ORDER_URL = process.env.ORDER_URL || 'http://order:8081';
const RISK_URL = process.env.RISK_URL || 'http://risk:8082';
const ACCOUNT_URL = process.env.ACCOUNT_URL || 'http://account:8083';
const PORTFOLIO_URL = process.env.PORTFOLIO_URL || 'http://portfolio:8084';
const MARKET_DATA_URL = process.env.MARKET_DATA_URL || 'http://market-data:8085';
const CHAOS_URL = process.env.CHAOS_URL || 'http://chaos-api.platform:8090';
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
// Orders that fail for a system reason (5xx, timeout, or valid orders declined by the risk check) feed the
// incident panel's "revenue at risk".
app.post('/api/orders', route(async (req, res) => {
  const { symbol, qty } = req.body || {};
  const customerId = (req.body && req.body.customerId) || DEFAULT_CUSTOMER;
  const quotes = await call('market-data', `${MARKET_DATA_URL}/quotes`, { traceId: req.traceId });
  const price = quotes.status === 200 ? quotes.body.prices[symbol] : undefined;
  if (price === undefined) {
    res.locals.logMsg = `order not sent: no price for symbol=${symbol} (market-data ${quotes.status})`;
    return res.status(400).json({ error: `unknown symbol ${symbol}`, traceId: req.traceId });
  }
  const orderValue = Number(qty) > 0 ? Number(qty) * price : 0;
  let upstream;
  try {
    upstream = await call('order', `${ORDER_URL}/orders`, {
      method: 'POST',
      body: { customerId, symbol, qty, price },
      traceId: req.traceId,
    });
  } catch (err) {
    if (err instanceof UpstreamError) panel.recordFailedOrder(orderValue);
    throw err;
  }
  if (upstream.status === 422) panel.recordFailedOrder(orderValue);
  relay(res, upstream);
}));

// ---- health summary: the six dots, plus a degraded flag for the status banner ----
const sampler = createSampler({
  targets: [
    ['order', ORDER_URL],
    ['risk', RISK_URL],
    ['account', ACCOUNT_URL],
    ['portfolio', PORTFOLIO_URL],
    ['market-data', MARKET_DATA_URL],
  ],
  self: () => metrics.snapshot(),
  logger,
});

// ---- incident panel (right and left floating panels in the UI) ----
const panel = createIncidentPanel({
  sampler,
  chaosUrl: CHAOS_URL,
  pd: {
    token: process.env.PD_API_TOKEN,
    serviceIds: (process.env.PD_SERVICE_IDS || '').split(',').map((x) => x.trim()).filter(Boolean),
  },
  config: {
    revenuePerS: Number(process.env.REVENUE_AT_RISK_PER_S || 500),
    hourlyRate: Number(process.env.ENGINEER_HOURLY_RATE || 150),
    defaultEngineers: Number(process.env.DEFAULT_ENGINEERS || 1),
    comparison: process.env.TYPICAL_COMPARISON || '6 engineers \u00b7 45+ min \u00b7 $680',
  },
  logger,
});
logger.info(`incident panel source: ${panel.pdEnabled ? 'PagerDuty REST API (falls back to health summary on error)' : 'health summary (PD_API_TOKEN / PD_SERVICE_IDS not set)'}`);

app.get('/api/health-summary', route(async (req, res) => {
  res.json(sampler.summary());
}));

app.get('/api/incident-panel', route(async (req, res) => {
  res.json(panel.snapshot());
}));

// Banner: degraded when any service is unhealthy or the incident panel has an incident in progress
// (silent faults such as S1 keep every /health green).
app.get('/api/status', route(async (req, res) => {
  const summary = sampler.summary();
  const unhealthy = summary.services.filter((s) => !s.healthy).map((s) => s.name);
  const incident = panel.snapshot().phase === 'incident';
  res.json({ degraded: unhealthy.length > 0 || incident, source: panel.pdEnabled ? 'pagerduty' : 'health-summary', unhealthy, asOf: summary.asOf });
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
