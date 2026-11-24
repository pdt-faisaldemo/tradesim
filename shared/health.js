'use strict';
// Mounts the endpoints every service must expose: /health, /metrics, /debug/last-error.
// Each check is `async () => null | 'reason string'`; any reason makes /health return 503.

function mountStandardRoutes(app, { service, version, logger, metrics, checks = [] }) {
  app.get('/health', async (req, res) => {
    const reasons = [];
    for (const check of checks) {
      try {
        const reason = await check();
        if (reason) reasons.push(reason);
      } catch (err) {
        reasons.push(`health check threw: ${err.message}`);
      }
    }
    if (reasons.length) {
      res.locals.logMsg = `health failing: ${reasons.join('; ')}`;
      return res.status(503).json({ status: 'unavailable', service, version, reason: reasons.join('; ') });
    }
    res.json({ status: 'ok', service, version });
  });

  app.get('/metrics', (req, res) => res.json(metrics.snapshot()));

  app.get('/debug/last-error', (req, res) => res.json({ service, lastError: logger.getLastError() }));
}

module.exports = { mountStandardRoutes };
