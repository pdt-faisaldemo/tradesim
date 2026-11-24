'use strict';
// Samples /health and /metrics of every service every few seconds in the background.
// Feeds the health strip (a service stays red for a few seconds while its pod restarts, so a 1-2s restart is not
// missed by a 3s browser poll) and the incident panel (error-rate signals, which health alone does not show).

const RESTART_HOLD_MS = 8000;
const ERROR_RATE_THRESHOLD = 0.2; // same as alert-bridge
const MIN_REQUESTS = 10;

function createSampler({ targets, self, intervalMs = 2000, logger }) {
  // targets: [[name, baseUrl]]; self: () => metrics snapshot for the gateway itself.
  const memory = new Map(); // name -> { uptime, restartingUntil }
  let latest = null;

  async function getJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  }

  async function checkOne(name, url) {
    const mem = memory.get(name) || { uptime: null, restartingUntil: 0 };
    const now = Date.now();
    let healthy = true;
    let reason;
    let metrics = null;

    const [health, met] = await Promise.allSettled([getJson(`${url}/health`), getJson(`${url}/metrics`)]);
    if (health.status === 'fulfilled') {
      if (!health.value.ok) {
        healthy = false;
        reason = health.value.body.reason || `health returned ${health.value.status}`;
      }
    } else {
      healthy = false;
      const err = health.reason;
      const cause = err.cause && (err.cause.code || err.cause.message);
      reason = err.name === 'TimeoutError' ? 'health check timed out' : `unreachable: ${cause || err.message}`;
      // No connection at all means the pod is down or starting: keep it red through the restart.
      if (err.name !== 'TimeoutError') mem.restartingUntil = now + RESTART_HOLD_MS;
    }
    if (met.status === 'fulfilled' && met.value.ok) {
      metrics = met.value.body;
      // uptime going backwards = the process restarted since the last sample.
      if (mem.uptime !== null && metrics.uptime_s < mem.uptime) mem.restartingUntil = now + RESTART_HOLD_MS;
      mem.uptime = metrics.uptime_s;
    }
    memory.set(name, mem);

    if (healthy && now < mem.restartingUntil) {
      healthy = false;
      reason = 'pod restarting';
    }
    const errorRate = metrics ? metrics.error_rate : 0;
    const requests = metrics ? metrics.requests : 0;
    const erroring = errorRate > ERROR_RATE_THRESHOLD && requests >= MIN_REQUESTS;
    return { name, healthy, reason, erroring, errorRate, requests };
  }

  async function sample() {
    const others = await Promise.all(targets.map(([name, url]) => checkOne(name, url)));
    const s = self();
    const gatewayErroring = s.error_rate > ERROR_RATE_THRESHOLD && s.requests >= MIN_REQUESTS;
    const services = [{ name: 'gateway', healthy: true, erroring: gatewayErroring, errorRate: s.error_rate, requests: s.requests }, ...others];
    latest = { asOf: new Date().toISOString(), services };
  }

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    sample().catch((err) => logger.error(`health sampling failed: ${err.message}`)).finally(() => { running = false; });
  };
  tick();
  setInterval(tick, intervalMs).unref();

  return {
    // Shape served on /api/health-summary.
    summary() {
      if (!latest) return { asOf: new Date().toISOString(), healthy: false, services: [] };
      const services = latest.services.map(({ name, healthy, reason }) => (healthy ? { name, healthy } : { name, healthy, reason }));
      return { asOf: latest.asOf, healthy: services.every((s) => s.healthy), services };
    },
    // Detail for the incident panel: per service healthy + erroring flags.
    detail() { return latest; },
  };
}

module.exports = { createSampler };
