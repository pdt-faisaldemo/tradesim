'use strict';
const express = require('express');
const pg = require('pg');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { call, route, UpstreamError } = require('../../shared/http');
const { createPgDb } = require('../../shared/pgdb');

const SERVICE = 'portfolio';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8084', 10);
const MARKET_DATA_URL = process.env.MARKET_DATA_URL || 'http://market-data:8085';
const ACCOUNT_URL = process.env.ACCOUNT_URL || 'http://account:8083';

const logger = createLogger({ service: SERVICE, version: VERSION });
const db = createPgDb(pg, {
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'tradesim',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'tradesim',
}, logger);
const metrics = createMetrics({ service: SERVICE, version: VERSION, extra: () => ({ leaked_mb: Math.round(leakedMb()) }) });

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));

// Recent responses kept around for repeat lookups.
const recentResponses = [];
const LEAK_BYTES = parseInt(process.env.LEAK_KB || '512', 10) * 1024;
const MEMORY_LIMIT_MB = 256; // matches the container limit in k8s/base/portfolio.yaml
const LATENCY_MS_PER_MB = 5;
const leakedMb = () => (recentResponses.length * LEAK_BYTES) / 1048576;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Unhealthy above 80% of the memory limit.
const memoryPressure = async () => {
  const rssMb = process.memoryUsage().rss / 1048576;
  return rssMb > MEMORY_LIMIT_MB * 0.8 ? `memory pressure: ${Math.round(rssMb)} MB of ${MEMORY_LIMIT_MB} MB` : null;
};
mountStandardRoutes(app, { service: SERVICE, version: VERSION, logger, metrics, checks: [...db.checks, memoryPressure] });

const round2 = (n) => Math.round(n * 100) / 100;

// GET /portfolio/:id -> positions with live P&L, plus cash from account and prices from market-data.
app.get('/portfolio/:id', route(async (req, res) => {
  const id = req.params.id;
  recentResponses.push(Buffer.alloc(LEAK_BYTES, 1));
  await sleep(Math.round(leakedMb() * LATENCY_MS_PER_MB)); // slower as the heap fills
  const [positionRows, quotes, account] = await Promise.all([
    db.query('SELECT symbol, qty, avg_cost FROM positions WHERE customer_id = $1 ORDER BY symbol', [id]),
    call('market-data', `${MARKET_DATA_URL}/quotes`, { traceId: req.traceId }),
    call('account', `${ACCOUNT_URL}/accounts/${encodeURIComponent(id)}`, { traceId: req.traceId }),
  ]);
  if (account.status === 404) {
    res.locals.logMsg = `portfolio for unknown account id=${id}`;
    return res.status(404).json({ error: 'account not found', traceId: req.traceId });
  }
  if (account.status !== 200) throw new UpstreamError('account', 'bad_status', `account returned ${account.status}`, account.status);
  if (quotes.status !== 200) throw new UpstreamError('market-data', 'bad_status', `market-data returned ${quotes.status}`, quotes.status);

  let positionsValue = 0;
  let costBasis = 0;
  const positions = positionRows.rows.map((r) => {
    const qty = r.qty;
    const avgCost = Number(r.avg_cost);
    const price = quotes.body.prices[r.symbol];
    const marketValue = qty * price;
    const cost = qty * avgCost;
    positionsValue += marketValue;
    costBasis += cost;
    return {
      symbol: r.symbol, qty, avgCost: round2(avgCost), price,
      marketValue: round2(marketValue), pnl: round2(marketValue - cost),
      pnlPct: cost ? round2(((marketValue - cost) / cost) * 100) : 0,
    };
  });
  const cash = account.body.cash;
  res.json({
    customerId: id,
    name: account.body.name,
    cash,
    positions,
    totals: {
      positionsValue: round2(positionsValue),
      pnl: round2(positionsValue - costBasis),
      accountValue: round2(cash + positionsValue),
    },
    asOf: quotes.body.asOf,
  });
}));

db.probe();
setInterval(db.probe, 5000).unref();
const server = app.listen(PORT, () => logger.info(`portfolio listening on :${PORT} MARKET_DATA_URL=${MARKET_DATA_URL} ACCOUNT_URL=${ACCOUNT_URL}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
