'use strict';
// Postgres helper for services that own tables (order, portfolio). The `pg` module is passed in because
// shared/ has no node_modules of its own. Failures surface as UpstreamError('postgres') so they cascade as 503s.
const { UpstreamError } = require('./http');

const describe = (err) => err.message || err.code || String(err);

function createPgDb(pg, config, logger) {
  const { host, port, user, password, database, maxPool = 10 } = config;
  const connOpts = { host, port, user, password, database };

  const pool = new pg.Pool({ ...connOpts, max: maxPool, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000 });
  // Idle client errors (e.g. postgres restarted) must not crash the process.
  pool.on('error', (err) => logger.warn(`idle pg client error: ${describe(err)}`));

  // Reachability probe on a dedicated connection; drives /health.
  let unreachable = null;
  async function probe() {
    const client = new pg.Client({ ...connOpts, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      if (unreachable) logger.info(`database reachable again at DB_HOST=${host}`);
      unreachable = null;
    } catch (err) {
      const msg = `cannot connect to DB_HOST=${host}: ${describe(err)}`;
      if (!unreachable) logger.error(msg);
      unreachable = msg;
    } finally {
      client.end().catch(() => {});
    }
  }

  const wrap = (err) => new UpstreamError('postgres', 'unreachable', `database error: ${describe(err)}`);

  async function query(sql, params) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      throw wrap(err);
    }
  }

  // Runs fn(client) inside BEGIN/COMMIT; rolls back on any error.
  async function transaction(fn) {
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      throw wrap(err);
    }
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err instanceof UpstreamError ? err : wrap(err);
    } finally {
      client.release();
    }
  }

  return {
    query,
    transaction,
    probe,
    checks: [async () => unreachable],
    end: () => pool.end(),
  };
}

module.exports = { createPgDb };
