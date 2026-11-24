'use strict';
// One JSON line per request and per notable event, to stdout.
// {"ts","level","service","version","traceId","route","status","latency_ms","msg", ...extra}
const crypto = require('crypto');

function createLogger({ service, version }) {
  let lastError = null;

  function log(level, msg, extra = {}) {
    const line = {
      ts: new Date().toISOString(),
      level,
      service,
      version,
      traceId: extra.traceId || null,
      route: extra.route || null,
      status: extra.status === undefined ? null : extra.status,
      latency_ms: extra.latency_ms === undefined ? null : extra.latency_ms,
      msg,
      ...extra,
    };
    if (level === 'error') lastError = line;
    process.stdout.write(JSON.stringify(line) + '\n');
    return line;
  }

  return {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    // Served by GET /debug/last-error for alert-bridge's sample_log.
    getLastError: () => lastError,
  };
}

// Sets req.traceId (propagating x-trace-id), echoes it on the response, and
// logs one line per request when it finishes. Handlers add context to the log
// line by setting res.locals.logMsg / res.locals.logExtra and level by status.
function requestLogger(logger, metrics) {
  return function (req, res, next) {
    const start = process.hrtime.bigint();
    req.traceId = req.get('x-trace-id') || crypto.randomUUID().slice(0, 8);
    res.set('x-trace-id', req.traceId);

    res.on('finish', () => {
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route ? (req.baseUrl || '') + req.route.path : req.path;
      const status = res.statusCode;
      if (metrics) metrics.record(route, status, latency);
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level](res.locals.logMsg || `${req.method} ${req.originalUrl.split('?')[0]} ${status}`, {
        traceId: req.traceId,
        route,
        status,
        latency_ms: Math.round(latency * 10) / 10,
        method: req.method,
        ...(res.locals.logExtra || {}),
      });
    });
    next();
  };
}

module.exports = { createLogger, requestLogger };
