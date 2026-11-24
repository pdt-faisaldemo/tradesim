'use strict';
const express = require('express');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { createDb, PoolExhaustedError } = require('./db');

const SERVICE = 'account';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8083', 10);

const config = {
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'tradesim',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'tradesim',
  maxPool: parseInt(process.env.DB_MAX_POOL || '50', 10),
  poolTimeoutMs: parseInt(process.env.DB_POOL_TIMEOUT_MS || '2000', 10),
  holdMs: parseInt(process.env.DB_QUERY_HOLD_MS || '300', 10),
};

const logger = createLogger({ service: SERVICE, version: VERSION });
const db = createDb(config, logger);
const metrics = createMetrics({ service: SERVICE, version: VERSION, extra: db.stats });

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics, checks: db.checks });

const toAccount = (row) => ({ customerId: row.id, name: row.name, cash: Number(row.cash) });

function parseAmount(body) {
  const amount = Number(body && body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
}

function dbFailure(req, res, err) {
  const status = 503;
  res.locals.logMsg = err.message;
  res.locals.logExtra = { upstream: 'postgres' };
  const error = err instanceof PoolExhaustedError ? err.message : `database error: ${err.message}`;
  return res.status(status).json({ error, upstream: 'postgres', traceId: req.traceId });
}

const notFound = (req, res) => {
  res.locals.logMsg = `account not found id=${req.params.id}`;
  return res.status(404).json({ error: 'account not found', traceId: req.traceId });
};

app.get('/accounts/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, name, cash FROM accounts WHERE id = $1', [req.params.id]);
    if (!rows.length) return notFound(req, res);
    res.json(toAccount(rows[0]));
  } catch (err) {
    dbFailure(req, res, err);
  }
});

app.post('/accounts/:id/debit', async (req, res) => {
  const amount = parseAmount(req.body);
  if (amount === null) return res.status(400).json({ error: 'amount must be a positive number', traceId: req.traceId });
  try {
    // Atomic: only debits when funds are sufficient.
    const { rows } = await db.query(
      'UPDATE accounts SET cash = cash - $2, updated_at = now() WHERE id = $1 AND cash >= $2 RETURNING id, name, cash',
      [req.params.id, amount]
    );
    if (rows.length) return res.json(toAccount(rows[0]));
    const exists = await db.query('SELECT cash FROM accounts WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) return notFound(req, res);
    res.locals.logMsg = `debit refused: insufficient funds id=${req.params.id} amount=${amount} cash=${exists.rows[0].cash}`;
    res.status(409).json({ error: 'insufficient funds', cash: Number(exists.rows[0].cash), traceId: req.traceId });
  } catch (err) {
    dbFailure(req, res, err);
  }
});

app.post('/accounts/:id/credit', async (req, res) => {
  const amount = parseAmount(req.body);
  if (amount === null) return res.status(400).json({ error: 'amount must be a positive number', traceId: req.traceId });
  try {
    const { rows } = await db.query(
      'UPDATE accounts SET cash = cash + $2, updated_at = now() WHERE id = $1 RETURNING id, name, cash',
      [req.params.id, amount]
    );
    if (!rows.length) return notFound(req, res);
    res.json(toAccount(rows[0]));
  } catch (err) {
    dbFailure(req, res, err);
  }
});

async function main() {
  logger.info(
    `starting account: DB_HOST=${config.host} DB_MAX_POOL=${config.maxPool} DB_POOL_TIMEOUT_MS=${config.poolTimeoutMs}` +
      (db.holdMs ? ` (query hold ${db.holdMs}ms)` : '')
  );
  try {
    await db.connectOrThrow();
  } catch (err) {
    // Exit non-zero so Kubernetes shows CrashLoopBackOff; `logs --previous` ends with this line.
    logger.error(`${err.message}; exiting`);
    process.stdout.write('', () => process.exit(1));
    setTimeout(() => process.exit(1), 500).unref();
    return;
  }
  setInterval(db.probe, 5000).unref();
  const server = app.listen(PORT, () => logger.info(`account listening on :${PORT}`));

  const shutdown = () => {
    logger.info('shutting down');
    server.close(() => db.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
