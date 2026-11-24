'use strict';
const { Pool, Client } = require('pg');

const POOL_EXHAUSTED_RE = /timeout exceeded when trying to connect/;
const HOLD_BELOW_POOL_SIZE = 10;
const CONNECT_RETRY_WINDOW_MS = 5000;
const CONNECT_RETRY_INTERVAL_MS = 1000;

class PoolExhaustedError extends Error {
  constructor(inUse, max, waitedMs) {
    super(`db pool exhausted: ${inUse}/${max} in use, waited ${waitedMs}ms`);
    this.name = 'PoolExhaustedError';
  }
}

function createDb(config, logger) {
  const { host, port, user, password, database, maxPool, poolTimeoutMs, holdMs } = config;
  const connOpts = { host, port, user, password, database };
  // The hold only exists to saturate a deliberately tiny pool (S2); at the baseline pool size it would just add latency.
  const effectiveHoldMs = maxPool < HOLD_BELOW_POOL_SIZE ? holdMs : 0;

  const pool = new Pool({
    ...connOpts,
    max: maxPool,
    connectionTimeoutMillis: poolTimeoutMs,
    idleTimeoutMillis: 30000,
  });
  // Idle client errors (e.g. postgres restarted) must not crash the process.
  pool.on('error', (err) => logger.warn(`idle pg client error: ${err.message}`));

  const inUse = () => pool.totalCount - pool.idleCount;

  // Pool saturation tracking, for /health ("saturated for >10s").
  let saturatedSince = null;
  setInterval(() => {
    const saturated = inUse() >= maxPool && pool.waitingCount > 0;
    if (saturated && !saturatedSince) saturatedSince = Date.now();
    if (!saturated) saturatedSince = null;
  }, 500).unref();

  // Reachability probe on a dedicated connection so it works even when the pool is full.
  let unreachable = null;
  async function probe() {
    const client = new Client({ ...connOpts, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      if (unreachable) logger.info(`database reachable again at DB_HOST=${host}`);
      unreachable = null;
    } catch (err) {
      const msg = `cannot connect to DB_HOST=${host}: ${err.message}`;
      if (!unreachable) logger.error(msg);
      unreachable = msg;
    } finally {
      client.end().catch(() => {});
    }
  }

  // Retries for 5s, then throws. Nothing is logged per attempt: the caller logs one clear line
  // "cannot connect to DB_HOST=<host>" before exiting, so it is the last line `kubectl logs --previous` shows (S5).
  async function connectOrThrow() {
    const deadline = Date.now() + CONNECT_RETRY_WINDOW_MS;
    let last;
    let attempts = 0;
    for (;;) {
      attempts++;
      const client = new Client({ ...connOpts, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return;
      } catch (err) {
        last = err;
        client.end().catch(() => {});
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_INTERVAL_MS));
    }
    throw new Error(`cannot connect to DB_HOST=${host} after ${attempts} attempts over ${CONNECT_RETRY_WINDOW_MS / 1000}s (${last.message})`);
  }

  // Runs one query on a pooled connection. When the pool is tiny, each query holds its connection for holdMs
  // (pg_sleep) so it saturates under steady traffic (scenario S2). A connection not acquired within
  // DB_POOL_TIMEOUT_MS throws PoolExhaustedError, which the routes turn into a 503.
  async function query(sql, params) {
    const waitStart = Date.now();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      if (POOL_EXHAUSTED_RE.test(err.message)) {
        throw new PoolExhaustedError(inUse(), maxPool, Math.min(Date.now() - waitStart, poolTimeoutMs));
      }
      throw err;
    }
    try {
      if (effectiveHoldMs > 0) await client.query('SELECT pg_sleep($1)', [effectiveHoldMs / 1000]);
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  return {
    query,
    probe,
    connectOrThrow,
    holdMs: effectiveHoldMs,
    stats: () => ({ db_pool_in_use: inUse(), db_pool_max: maxPool, db_pool_waiting: pool.waitingCount }),
    // /health checks: DB unreachable, or pool saturated for more than 10s.
    checks: [
      async () => unreachable,
      async () =>
        saturatedSince && Date.now() - saturatedSince > 10000
          ? `db pool saturated: ${inUse()}/${maxPool} in use for ${Math.round((Date.now() - saturatedSince) / 1000)}s`
          : null,
    ],
    end: () => pool.end(),
  };
}

module.exports = { createDb, PoolExhaustedError };
