'use strict';
const crypto = require('crypto');
const express = require('express');
const pg = require('pg');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { call, route, UpstreamError } = require('../../shared/http');
const { createPgDb } = require('../../shared/pgdb');
const { SYMBOLS } = require('../../shared/tickers');

const SERVICE = 'order';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8081', 10);
const RISK_URL = process.env.RISK_URL || 'http://risk:8082';
const ACCOUNT_URL = process.env.ACCOUNT_URL || 'http://account:8083';
const DEFAULT_CUSTOMER = 'c-1001';
const MAX_QTY = 10000;

const logger = createLogger({ service: SERVICE, version: VERSION });
const db = createPgDb(pg, {
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'tradesim',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'tradesim',
}, logger);
const metrics = createMetrics({ service: SERVICE, version: VERSION });

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics, checks: db.checks });

const round2 = (n) => Math.round(n * 100) / 100;
const reject = (req, res, status, msg, body = {}) => {
  res.locals.logMsg = msg;
  return res.status(status).json({ ...body, traceId: req.traceId });
};
const accountUrl = (id, action) => `${ACCOUNT_URL}/accounts/${encodeURIComponent(id)}/${action}`;

// POST /orders {customerId?, symbol, qty, price} -> risk check -> debit account -> store order + position.
// The gateway supplies `price` from market-data (order does not call market-data).
app.post('/orders', route(async (req, res) => {
  const body = req.body || {};
  const customerId = body.customerId || DEFAULT_CUSTOMER;
  const { symbol, qty } = body;
  const price = Number(body.price);
  if (!SYMBOLS.includes(symbol)) return reject(req, res, 400, `order rejected: unknown symbol=${symbol}`, { error: 'unknown symbol' });
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return reject(req, res, 400, `order rejected: bad qty=${qty}`, { error: `qty must be a whole number between 1 and ${MAX_QTY}` });
  }
  if (!Number.isFinite(price) || price <= 0) return reject(req, res, 400, `order rejected: bad price=${body.price}`, { error: 'price must be positive' });
  const cost = round2(qty * price);

  // 1. risk check
  const risk = await call('risk', `${RISK_URL}/check`, { method: 'POST', body: { customerId, cost }, traceId: req.traceId });
  if (risk.status === 404) return reject(req, res, 404, `order rejected: unknown account id=${customerId}`, { error: 'account not found' });
  if (risk.status !== 200 && risk.status !== 422) throw new UpstreamError('risk', 'bad_status', `risk returned ${risk.status}`, risk.status);
  if (!risk.body.approved) {
    return reject(req, res, 422, `order rejected by risk check cost=${cost} buyingPower=${risk.body.buyingPower}`,
      { error: 'order rejected: insufficient buying power', reason: risk.body.reason, cost, buyingPower: risk.body.buyingPower });
  }

  // 2. debit account
  const debit = await call('account', accountUrl(customerId, 'debit'), { method: 'POST', body: { amount: cost }, traceId: req.traceId });
  if (debit.status === 409) return reject(req, res, 409, `order rejected: insufficient funds cost=${cost} cash=${debit.body.cash}`, { error: 'insufficient funds', cash: debit.body.cash });
  if (debit.status !== 200) throw new UpstreamError('account', 'bad_status', `account returned ${debit.status}`, debit.status);

  // 3. store order and update the position in one transaction; refund the debit if that fails.
  const orderId = `o-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await db.transaction(async (client) => {
      await client.query(
        'INSERT INTO orders (id, customer_id, symbol, qty, price, cost) VALUES ($1, $2, $3, $4, $5, $6)',
        [orderId, customerId, symbol, qty, price, cost]
      );
      // Written here (not via portfolio) so buying does not depend on the portfolio service.
      await client.query(
        `INSERT INTO positions (customer_id, symbol, qty, avg_cost) VALUES ($1, $2, $3, $4)
         ON CONFLICT (customer_id, symbol) DO UPDATE SET
           avg_cost = (positions.avg_cost * positions.qty + EXCLUDED.avg_cost * EXCLUDED.qty) / (positions.qty + EXCLUDED.qty),
           qty = positions.qty + EXCLUDED.qty`,
        [customerId, symbol, qty, price]
      );
    });
  } catch (err) {
    logger.error(`order store failed, refunding cost=${cost} id=${customerId}: ${err.message}`, { traceId: req.traceId });
    await call('account', accountUrl(customerId, 'credit'), { method: 'POST', body: { amount: cost }, traceId: req.traceId })
      .catch((e) => logger.error(`refund failed id=${customerId} cost=${cost}: ${e.message}`, { traceId: req.traceId }));
    throw err;
  }

  res.locals.logMsg = `order filled id=${orderId} customer=${customerId} ${symbol} x${qty} @ ${price} cost=${cost}`;
  res.status(201).json({ orderId, customerId, symbol, qty, price, cost, status: 'filled', cash: debit.body.cash });
}));

// GET /orders?customerId=c-1001&limit=10 -> most recent orders first.
app.get('/orders', route(async (req, res) => {
  const customerId = req.query.customerId || DEFAULT_CUSTOMER;
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 100);
  const { rows } = await db.query(
    'SELECT id, customer_id, symbol, qty, price, cost, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2',
    [customerId, limit]
  );
  res.json({
    orders: rows.map((r) => ({
      orderId: r.id, customerId: r.customer_id, symbol: r.symbol, qty: r.qty,
      price: Number(r.price), cost: Number(r.cost), status: 'filled', createdAt: r.created_at,
    })),
  });
}));

db.probe();
setInterval(db.probe, 5000).unref();
const server = app.listen(PORT, () => logger.info(`order listening on :${PORT} RISK_URL=${RISK_URL} ACCOUNT_URL=${ACCOUNT_URL}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
