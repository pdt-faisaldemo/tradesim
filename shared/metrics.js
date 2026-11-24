'use strict';
// Rolling 60s window of per-second buckets. An "error" is any response >= 400,
// so business rejections (e.g. orders refused by the risk check) show up in error_rate.
const WINDOW_S = 60;
const SHORT_WINDOW_S = 30; // error_rate_30s: what the UI health strip reacts to
const IGNORED_ROUTES = new Set(['/health', '/metrics', '/debug/last-error']);

function createMetrics({ service, version, extra = () => ({}) }) {
  const buckets = new Array(WINDOW_S).fill(null);
  const startedAt = Date.now();

  function bucketFor(sec) {
    const i = sec % WINDOW_S;
    if (!buckets[i] || buckets[i].sec !== sec) buckets[i] = { sec, requests: 0, errors: 0, lat: [] };
    return buckets[i];
  }

  function record(route, status, latencyMs) {
    if (IGNORED_ROUTES.has(route)) return;
    const b = bucketFor(Math.floor(Date.now() / 1000));
    b.requests++;
    if (status >= 400) b.errors++;
    b.lat.push(latencyMs);
  }

  function snapshot() {
    const nowSec = Math.floor(Date.now() / 1000);
    let requests = 0;
    let errors = 0;
    let requests30 = 0;
    let errors30 = 0;
    let lat = [];
    for (const b of buckets) {
      if (!b || nowSec - b.sec >= WINDOW_S) continue;
      requests += b.requests;
      errors += b.errors;
      if (nowSec - b.sec < SHORT_WINDOW_S) {
        requests30 += b.requests;
        errors30 += b.errors;
      }
      lat = lat.concat(b.lat);
    }
    lat.sort((a, b) => a - b);
    const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : 0;
    return {
      service,
      version,
      requests,
      errors,
      error_rate: requests ? Math.round((errors / requests) * 1000) / 1000 : 0,
      requests_30s: requests30,
      error_rate_30s: requests30 ? Math.round((errors30 / requests30) * 1000) / 1000 : 0,
      p95_ms: Math.round(p95),
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      memory_rss_mb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
      ...extra(),
    };
  }

  return { record, snapshot };
}

module.exports = { createMetrics };
