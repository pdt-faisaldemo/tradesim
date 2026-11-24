'use strict';
const express = require('express');
const Redis = require('ioredis');
const { createLogger, requestLogger } = require('../../shared/logger');
const { createMetrics } = require('../../shared/metrics');
const { mountStandardRoutes } = require('../../shared/health');
const { route, UpstreamError } = require('../../shared/http');
const { START_PRICES, SYMBOLS } = require('../../shared/tickers');

const SERVICE = 'market-data';
const VERSION = process.env.VERSION || 'dev';
const PORT = parseInt(process.env.PORT || '8085', 10);
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || '2000', 10);
const STALE_AFTER_S = parseInt(process.env.FEED_STALE_AFTER_S || '30', 10);
const CHAOS_API_URL = process.env.CHAOS_API_URL || 'http://chaos-api.platform:8090';
const FLAG_POLL_MS = parseInt(process.env.FLAG_POLL_MS || '5000', 10);
const PRICES_KEY = 'tradesim:prices';
const VOLATILITY = 0.0015; // per-tick standard deviation of the random walk
const REVERSION = 0.003; // per-tick pull back towards the ticker's starting price
const MAX_DRIFT = 0.08; // hard bound around the starting price (+/- 8%)

const logger = createLogger({ service: SERVICE, version: VERSION });

// Fail fast instead of queueing commands while Redis is down, so /quotes surfaces the outage.
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 2000,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

let redisError = null;
redis.on('error', (err) => {
  const msg = `cannot reach redis at REDIS_HOST=${REDIS_HOST}: ${err.message || err.code}`;
  if (redisError !== msg) logger.error(msg);
  redisError = msg;
});
redis.on('ready', () => {
  if (redisError) logger.info(`redis reachable again at REDIS_HOST=${REDIS_HOST}`);
  redisError = null;
});

const startedAt = Date.now();
let lastTickAt = null;
const lastTickAgeS = () => (Date.now() - (lastTickAt || startedAt)) / 1000;

const metrics = createMetrics({
  service: SERVICE,
  version: VERSION,
  extra: () => ({ last_tick_age_s: Math.round(lastTickAgeS()), redis_connected: redis.status === 'ready' }),
});

const app = express();
app.use(express.json());
app.use(requestLogger(logger, metrics));
mountStandardRoutes(app, {
  service: SERVICE,
  version: VERSION,
  logger,
  metrics,
  checks: [
    async () => redisError,
    async () => (lastTickAgeS() > STALE_AFTER_S ? `price feed stale: last tick ${Math.round(lastTickAgeS())}s ago` : null),
  ],
});

// ---- price simulator: mean-reverting random walk, one tick per TICK_INTERVAL_MS, written to Redis ----
const prices = { ...START_PRICES };
const bounded = (s, p) => Math.min(START_PRICES[s] * (1 + MAX_DRIFT), Math.max(START_PRICES[s] * (1 - MAX_DRIFT), p));

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

async function tick() {
  for (const s of SYMBOLS) {
    const walk = prices[s] * (1 + VOLATILITY * gaussian());
    prices[s] = Math.round(bounded(s, walk + REVERSION * (START_PRICES[s] - prices[s])) * 100) / 100;
  }
  const fields = { ...prices, asOf: new Date().toISOString() };
  await redis.hset(PRICES_KEY, fields);
  lastTickAt = Date.now();
}

// ---- demo flag feedPaused (scenario S3): polled from chaos-api; false when chaos-api is absent ----
let feedPaused = false;
let flagsReachable = null;

async function pollFlags() {
  let paused = false;
  try {
    const r = await fetch(`${CHAOS_API_URL}/flags`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    paused = (await r.json()).feedPaused === true;
    if (flagsReachable === false) logger.info(`flags reachable again at CHAOS_API_URL=${CHAOS_API_URL}`);
    flagsReachable = true;
  } catch (err) {
    if (flagsReachable !== false) logger.info(`flags unavailable at CHAOS_API_URL=${CHAOS_API_URL} (${err.message}); using feedPaused=false`);
    flagsReachable = false;
  }
  if (paused !== feedPaused) {
    feedPaused = paused;
    logger.info(feedPaused ? 'flag feedPaused=true: price ticks stopped' : 'flag feedPaused=false: price ticks resumed');
  }
}
pollFlags();
setInterval(pollFlags, FLAG_POLL_MS).unref();

let ticking = false;
async function safeTick() {
  if (ticking || feedPaused) return;
  ticking = true;
  try {
    await tick();
  } catch (err) {
    logger.warn(`tick failed: ${err.message}`);
  } finally {
    ticking = false;
  }
}

// Once Redis is first ready: resume from stored prices (if any), then start ticking.
let started = false;
redis.on('ready', async () => {
  if (started) return;
  started = true;
  try {
    const stored = await redis.hgetall(PRICES_KEY);
    for (const s of SYMBOLS) if (stored[s]) prices[s] = bounded(s, Number(stored[s]));
  } catch (err) {
    logger.warn(`could not load stored prices, using starting prices: ${err.message}`);
  }
  logger.info(`price simulator started: ${SYMBOLS.length} tickers every ${TICK_INTERVAL_MS}ms`);
  await safeTick();
  setInterval(safeTick, TICK_INTERVAL_MS).unref();
});

// GET /quotes -> {asOf, prices}
app.get('/quotes', route(async (req, res) => {
  let stored;
  try {
    stored = await redis.hgetall(PRICES_KEY);
  } catch (err) {
    throw new UpstreamError('redis', 'unreachable', `cannot read quotes from redis at REDIS_HOST=${REDIS_HOST}: ${err.message}`);
  }
  if (!stored.asOf) {
    res.locals.logMsg = 'no quotes in redis yet';
    return res.status(503).json({ error: 'no quotes available yet', upstream: 'redis', traceId: req.traceId });
  }
  const out = {};
  for (const s of SYMBOLS) out[s] = Number(stored[s]);
  res.json({ asOf: stored.asOf, prices: out });
}));

const server = app.listen(PORT, () => logger.info(`market-data listening on :${PORT} REDIS_HOST=${REDIS_HOST}`));
const shutdown = () => {
  logger.info('shutting down');
  server.close(() => { redis.disconnect(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
