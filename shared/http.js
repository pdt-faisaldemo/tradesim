'use strict';
// Inter-service HTTP client: 2s timeout, x-trace-id propagation, uniform failure shape.

const DEFAULT_TIMEOUT_MS = 2000;

class UpstreamError extends Error {
  // kind: 'timeout' | 'unreachable' | 'bad_status'
  constructor(upstream, kind, message, status = null) {
    super(message);
    this.name = 'UpstreamError';
    this.upstream = upstream;
    this.kind = kind;
    this.upstreamStatus = status;
  }
}

// Resolves { status, body } for any response below 500 (callers decide what a 4xx means).
// Throws UpstreamError on timeout, connection failure or an upstream 5xx.
async function call(upstream, url, { method = 'GET', body, traceId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (traceId) headers['x-trace-id'] = traceId;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new UpstreamError(upstream, 'timeout', `${upstream} timed out after ${timeoutMs}ms (${method} ${url})`);
    }
    const cause = err.cause && (err.cause.code || err.cause.message);
    throw new UpstreamError(upstream, 'unreachable', `${upstream} unreachable: ${cause || err.message} (${method} ${url})`);
  }
  let parsed = null;
  const text = await res.text();
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  }
  if (res.status >= 500) {
    throw new UpstreamError(upstream, 'bad_status', `${upstream} returned ${res.status} (${method} ${url})`, res.status);
  }
  return { status: res.status, body: parsed };
}

// Standard cascade response: 503 for timeout/unreachable, 502 for an upstream 5xx.
// Body is {error, upstream, traceId}; the log line is written by the request logger.
function respondUpstreamError(req, res, err) {
  const status = err.kind === 'bad_status' ? 502 : 503;
  res.locals.logMsg = err.message;
  res.locals.logExtra = { upstream: err.upstream, error_kind: err.kind };
  return res.status(status).json({ error: err.message, upstream: err.upstream, traceId: req.traceId });
}

module.exports = { call, respondUpstreamError, UpstreamError, DEFAULT_TIMEOUT_MS };
