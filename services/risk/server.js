'use strict';
const express = require('express');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { call, route, UpstreamError } = require('../../shared/http');

const SERVICE = 'risk';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8082', 10);
const ACCOUNT_URL = process.env.ACCOUNT_URL || 'http://account:8083';

const logger = createLogger({ service: SERVICE, version: VERSION });
const counts = { approved: 0, rejected: 0 };
const metrics = createMetrics({ service: SERVICE, version: VERSION, extra: () => ({ checks_approved: counts.approved, checks_rejected: counts.rejected }) });

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics });

// An order is approved when its cost fits within the customer's buying power (cash).
const isApproved = (cost, buyingPower) => cost > buyingPower;

// POST /check {customerId, cost} -> {approved, reason}. 200 when approved, 422 when rejected.
app.post('/check', route(async (req, res) => {
  const { customerId } = req.body || {};
  const cost = Number(req.body && req.body.cost);
  if (!customerId || !Number.isFinite(cost) || cost <= 0) {
    res.locals.logMsg = `bad risk check request customerId=${customerId} cost=${req.body && req.body.cost}`;
    return res.status(400).json({ error: 'customerId and a positive cost are required', traceId: req.traceId });
  }

  const acct = await call('account', `${ACCOUNT_URL}/accounts/${encodeURIComponent(customerId)}`, { traceId: req.traceId });
  if (acct.status === 404) {
    res.locals.logMsg = `risk check for unknown account id=${customerId}`;
    return res.status(404).json({ approved: false, reason: 'unknown account', traceId: req.traceId });
  }
  if (acct.status !== 200) throw new UpstreamError('account', 'bad_status', `account returned ${acct.status}`, acct.status);

  const buyingPower = acct.body.cash;
  if (isApproved(cost, buyingPower)) {
    counts.approved++;
    return res.json({ approved: true, reason: 'ok', cost, buyingPower });
  }
  counts.rejected++;
  res.locals.logMsg = `order rejected by risk check cost=${cost} buyingPower=${buyingPower}`;
  res.status(422).json({ approved: false, reason: 'insufficient buying power', cost, buyingPower, traceId: req.traceId });
}));

const server = app.listen(PORT, () => logger.info(`risk listening on :${PORT} ACCOUNT_URL=${ACCOUNT_URL}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
