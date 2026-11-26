'use strict';
// Incident panel for the UI. The story itself (idle -> incident -> fixing -> resolved) lives in chaos-api, so it survives
// page reloads and gateway restarts and looks the same in every browser. This module reads it from chaos-api /state,
// merges in the live metrics, and reports the two things only the gateway can see (it owns the health signals):
//   detected: the first unhealthy signal (health, error rate, restarts, or a PagerDuty incident) while in incident
//   resolved: while fixing, all services healthy for RESOLVE_HEALTHY_S in a row, or the PagerDuty incident resolved
// Health never moves the phase backwards, and a partial fix (S4 restart, the leak returns) never resolves.
// A 'resetting' phase is shown while scripts/reset.sh runs.

const TICK_MS = 2000; // state machine; PagerDuty is polled every PD_POLL_MS
const PD_POLL_MS = 5000;
const CHAOS_TIMEOUT_MS = 1500;
const PD_TIMEOUT_MS = 4000;
const PD_BASE = 'https://api.pagerduty.com';
const RESOLVE_HEALTHY_S = 15; // consecutive healthy seconds after the fix
const RESET_ERROR_GRACE_MS = 35000; // error rates in the 30s window still describe the old fault right after a reset
// A restart this long after the incident began, before any fix, is the platform restarting a crashing pod.
const RESTART_NOTE_AFTER_S = 30;
const MAX_NOTE_CHARS = 60;
const FAILED_ORDER_KEEP_MS = 30 * 60 * 1000;

const ROOT_CAUSE_NOTE = /^\s*SRE Agent:\s*/i;
const PANEL_SUMMARY_LINE = /^\s*Panel summary:\s*/i;

const DELIVERED_VALUES = {
  detect: 'Easy: one incident from many signals, no war room needed',
  resolve: 'Flexible: automation, AI agents or a code fix, your choice',
  prevent: 'Reliable: every incident makes the next one less likely',
};
const HEADLINES = {
  S1: ['Caught in seconds, traced to the exact code change', 'Rolled back with one approved click', 'Permanent code fix with an automatic test'],
  S1R: ['Recognized as a repeat of a past incident', 'Proven fix redeployed in one click', 'No new engineering needed'],
  S2: ['Five failing services traced to one root cause', 'Configuration restored in one click', 'Safeguard recommended for future changes'],
  S3: ['Caught even though nothing showed an error', 'Price feed restored in one click', 'Freshness monitoring keeps watch'],
  S4: ['Slowdown flagged before customers were hurt', 'Stabilized with one approved restart', 'Permanent code fix with an automatic test'],
  S5: ['Exact misconfiguration pinpointed in seconds', 'Rolled back with one approved click', 'Configuration checks recommended'],
};
HEADLINES.S4R = HEADLINES.S4;
const GENERIC_HEADLINES = ['Several failing signals traced to their root cause', 'Fix applied in one approved click', 'Safeguards recommended for next time'];

const ts = (iso) => Date.parse(iso) || null;

// At most `max` characters including the ellipsis, cut at a word boundary.
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

// The "Panel summary:" line of an "SRE Agent:" note, or null when the note has none.
function panelSummary(content) {
  const body = content.replace(ROOT_CAUSE_NOTE, '');
  const line = body.split('\n').find((l) => PANEL_SUMMARY_LINE.test(l));
  const text = line && line.replace(PANEL_SUMMARY_LINE, '').trim();
  return text ? clip(text, MAX_NOTE_CHARS) : null;
}

// Only link to PagerDuty over https.
const safeUrl = (u) => { try { return new URL(u).protocol === 'https:' ? u : null; } catch { return null; } };

const STALE_FEED_S = 30; // a price older than this makes a fill a "trade at a stale price" (market-data last_tick_age_s)
const STALE_SCENARIOS = new Set(['S3', 'COMBO']);

function createIncidentPanel({ sampler, sampleOrderService = 'order', chaosUrl, pd, config, logger }) {
  // pd: { token, serviceIds[] }; config: { revenuePerS, hourlyRate, defaultEngineers, comparison }
  const pdEnabled = Boolean(pd.token && pd.serviceIds.length);
  let story = { phase: 'idle' }; // last story read from chaos-api
  let st = fresh(null);
  let resetting = false;

  // Live measurements for the current story. Dropped when a new story starts or the story goes back to idle.
  function fresh(storyId) {
    return {
      storyId, scenario: null, source: pdEnabled ? 'pagerduty' : 'health-summary', lastTickAt: null, healthySince: null,
      orderUnhealthyMs: 0, orderUnhealthyNow: false, engineers: new Set(), failedOrders: [], staleTrades: [], incidents: [],
      rootCause: null, rootCauseUrl: null,
    };
  }

  // ---- inputs ----
  async function chaosCall(path, body) {
    try {
      const r = await fetch(`${chaosUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(CHAOS_TIMEOUT_MS),
      });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async function pdGet(path, params = {}) {
    const url = new URL(PD_BASE + path);
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) url.searchParams.append(k, x);
    const r = await fetch(url, {
      headers: { Authorization: `Token token=${pd.token}`, Accept: 'application/vnd.pagerduty+json;version=2' },
      signal: AbortSignal.timeout(PD_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`PagerDuty GET ${path} returned ${r.status}`);
    return r.json();
  }

  async function fetchIncidents(since) {
    const body = await pdGet('/incidents', {
      'service_ids[]': pd.serviceIds,
      'statuses[]': ['triggered', 'acknowledged', 'resolved'],
      since: new Date(since).toISOString(),
      sort_by: 'created_at:asc',
      limit: 25,
    });
    return body.incidents || [];
  }

  // The root-cause note is only looked up while fixing and until one is found.
  async function findRootCauseNote(incidents) {
    for (const inc of incidents.slice(0, 5)) {
      const { notes = [] } = await pdGet(`/incidents/${inc.id}/notes`);
      const note = notes.filter((n) => ROOT_CAUSE_NOTE.test(n.content || '')).sort((a, b) => ts(a.created_at) - ts(b.created_at))[0];
      if (note) {
        // The step shows the note's "Panel summary:" line; a note without one falls back to the scenario's preset text.
        st.rootCause = panelSummary(note.content) || presetHeadlines()[0];
        st.rootCauseUrl = safeUrl(inc.html_url);
        return;
      }
    }
  }

  // PagerDuty is polled every PD_POLL_MS even though the state machine ticks faster.
  const pdCache = { at: 0, incidents: null, since: null };
  async function pagerDutyIncidents(since, now) {
    if (!pdEnabled) return null;
    if (now - pdCache.at < PD_POLL_MS && pdCache.since === since) return pdCache.incidents;
    pdCache.at = now;
    pdCache.since = since;
    try {
      pdCache.incidents = await fetchIncidents(since);
    } catch (err) {
      pdCache.incidents = null;
      logger.warn(`incident panel: PagerDuty unavailable, using health summary: ${err.message}`);
    }
    return pdCache.incidents;
  }

  // ---- state machine ----
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try { await runTick(); } finally { busy = false; }
  }

  async function runTick() {
    const now = Date.now();
    const chaos = await chaosCall('/state');
    if (!chaos) return; // chaos-api unreachable: keep showing the last known story
    story = chaos.story || { phase: 'idle' };
    if (chaos.resetting) {
      if (!resetting) logger.info('incident panel: reset in progress');
      resetting = true;
      st = fresh(null);
      pdCache.at = 0;
      return;
    }
    if (resetting) {
      resetting = false;
      sampler.setErrorGrace(RESET_ERROR_GRACE_MS);
      logger.info('incident panel: reset finished');
    }
    if (story.phase === 'idle') {
      if (st.storyId !== null) logger.info('incident panel: story cleared');
      st = fresh(null);
      pdCache.at = 0;
      return;
    }
    if (st.storyId !== story.startedAt) st = fresh(story.startedAt);
    st.scenario = story.scenario;
    if (story.phase === 'resolved') return; // frozen until a clear path runs
    sampler.setErrorGrace(0);

    const detail = sampler.detail();
    const services = detail ? detail.services : [];
    const degraded = services.filter((s) => !s.healthy || s.erroring);
    const order = services.find((s) => s.name === sampleOrderService);
    st.orderUnhealthyNow = Boolean(order && (!order.healthy || order.erroring));
    const dt = st.lastTickAt ? now - st.lastTickAt : 0;
    st.lastTickAt = now;
    if (story.detectedAt && st.orderUnhealthyNow) st.orderUnhealthyMs += dt;

    const incidents = await pagerDutyIncidents(story.startedAt, now);
    st.source = incidents ? 'pagerduty' : 'health-summary';
    if (incidents) st.incidents = incidents;
    const open = incidents ? incidents.filter((i) => i.status !== 'resolved') : [];
    for (const i of open) {
      for (const a of i.assignments || []) if (a.assignee && a.assignee.type.startsWith('user')) st.engineers.add(a.assignee.id);
      for (const a of i.acknowledgements || []) if (a.acknowledger && a.acknowledger.type.startsWith('user')) st.engineers.add(a.acknowledger.id);
    }

    if (story.phase === 'incident') {
      // First unhealthy signal. A restart right at the start is the rollout of the fault itself, so it only counts later.
      const restarted = sampler.restartsSince(story.startedAt + RESTART_NOTE_AFTER_S * 1000).length > 0;
      if (!story.detectedAt && (degraded.length > 0 || restarted || (incidents && incidents.length > 0))) {
        const updated = await chaosCall('/story/detected', {});
        if (updated) { story = updated; logger.info(`incident panel: detected (${degraded.map((s) => s.name).join(', ') || 'restart or PagerDuty'}) scenario=${story.scenario}`); }
      }
      return;
    }

    // fixing
    if (!st.rootCause && incidents && incidents.length && pdCache.at === now) {
      try { await findRootCauseNote(incidents); } catch (err) { logger.warn(`incident panel: PagerDuty note lookup failed: ${err.message}`); }
    }
    if (story.fixKind === 'partial') { st.healthySince = null; return; } // the cause is still there: never resolves
    if (degraded.length === 0) { if (!st.healthySince) st.healthySince = now; } else st.healthySince = null;

    let why = null;
    if (st.healthySince && now - st.healthySince >= RESOLVE_HEALTHY_S * 1000) why = `healthy for ${RESOLVE_HEALTHY_S}s`;
    else if (incidents && incidents.length > 0 && open.length === 0) {
      const resolvedAt = Math.max(...incidents.map((i) => ts(i.last_status_change_at) || 0));
      if (resolvedAt >= story.fixAt) why = 'PagerDuty incident resolved';
    }
    if (why) {
      const resolved = await chaosCall('/story/resolve', { why, frozen: measure(now) });
      if (resolved) { story = resolved; logger.info(`incident panel: resolved (${why}) after ${Math.round((story.resolvedAt - story.detectedAt) / 1000)}s scenario=${story.scenario}`); }
    }
  }

  // ---- outputs ----
  const presetHeadlines = () => HEADLINES[story.scenario] || GENERIC_HEADLINES;
  const active = () => story.phase === 'incident' || story.phase === 'fixing';

  function recordFailedOrder(value) {
    if (!(value > 0) || !active()) return;
    const now = Date.now();
    st.failedOrders = st.failedOrders.filter((o) => now - o.at < FAILED_ORDER_KEEP_MS);
    st.failedOrders.push({ at: now, value });
  }

  // An order that filled while the price feed was stale (S3). Counted only while a stale-price scenario is active.
  function recordFill(value, priceAgeS) {
    if (!(value > 0) || !(priceAgeS > STALE_FEED_S) || !active() || !STALE_SCENARIOS.has(story.scenario)) return;
    const now = Date.now();
    st.staleTrades = st.staleTrades.filter((o) => now - o.at < FAILED_ORDER_KEEP_MS);
    st.staleTrades.push({ at: now, value });
  }

  // Numbers at time `end`. The timer starts at detection (0 until then).
  function measure(end) {
    const elapsedS = story.detectedAt ? Math.max(0, (end - story.detectedAt) / 1000) : 0;
    const failed = st.failedOrders.filter((o) => o.at >= story.startedAt && o.at <= end).reduce((sum, o) => sum + o.value, 0);
    const stale = st.staleTrades.filter((o) => o.at <= end);
    const engineers = Math.max(config.defaultEngineers, st.engineers.size);
    return {
      elapsedS,
      revenueAtRisk: Math.round(failed + (st.orderUnhealthyMs / 1000) * config.revenuePerS),
      staleTrades: stale.length,
      staleExposure: Math.round(stale.reduce((sum, o) => sum + o.value, 0)),
      engineers,
      cost: Math.round(engineers * (elapsedS / 60) * config.hourlyRate),
    };
  }

  function timeline() {
    const rel = (at) => (at && story.detectedAt ? Math.max(0, Math.round((at - story.detectedAt) / 1000)) : null);
    const fixing = story.phase === 'fixing' || story.phase === 'resolved';
    const resolved = story.phase === 'resolved';
    return [
      { key: 'detected', label: 'Detected', elapsedS: rel(story.detectedAt), detail: null },
      { key: 'root_cause', label: 'Root cause found', elapsedS: fixing ? rel(story.fixAt) : null, detail: fixing ? st.rootCause || presetHeadlines()[0] : null, url: fixing ? st.rootCauseUrl : null },
      { key: 'fix', label: 'Fix approved', elapsedS: fixing ? rel(story.fixAt) : null, detail: null },
      { key: 'resolved', label: 'Resolved', elapsedS: resolved ? rel(story.resolvedAt) : null, detail: null },
    ];
  }

  // The left panel always shows the preset headlines, never live note text.
  function delivered() {
    const [d, r, p] = presetHeadlines();
    return {
      scenario: story.scenario,
      blocks: [
        { key: 'detect', title: 'DETECT', headline: d, value: DELIVERED_VALUES.detect },
        { key: 'resolve', title: 'RESOLVE', headline: r, value: DELIVERED_VALUES.resolve },
        { key: 'prevent', title: 'PREVENT', headline: p, value: DELIVERED_VALUES.prevent },
      ],
    };
  }

  // The PagerDuty incident behind this story (first one raised since it started), for the link in the panel.
  function pagerDutyIncident() {
    const inc = st.incidents.find((i) => safeUrl(i.html_url));
    return inc ? { number: inc.incident_number, status: inc.status, url: safeUrl(inc.html_url) } : null;
  }

  function snapshot() {
    const base = { phase: story.phase, source: st.source, serverNow: Date.now() };
    if (resetting) return { ...base, phase: 'resetting' };
    if (story.phase === 'idle') return base;
    const resolved = story.phase === 'resolved';
    const m = resolved ? story.frozen || measure(story.resolvedAt) : measure(Date.now());
    const kind = STALE_SCENARIOS.has(story.scenario) ? 'stale' : 'revenue';
    return {
      ...base,
      scenario: story.scenario,
      startedAt: story.startedAt,
      detectedAt: story.detectedAt,
      fixAt: story.fixAt,
      resolvedAt: story.resolvedAt,
      metrics: {
        kind, revenueAtRisk: m.revenueAtRisk, staleTrades: m.staleTrades, staleExposure: m.staleExposure,
        timeToResolveS: Math.round(m.elapsedS), engineers: m.engineers, cost: m.cost,
      },
      live: active() && story.detectedAt
        ? { orderUnhealthy: kind === 'revenue' && st.orderUnhealthyNow, revenuePerS: config.revenuePerS, hourlyRate: config.hourlyRate }
        : null,
      incident: pagerDutyIncident(),
      timeline: timeline(),
      notes: story.fixKind === 'partial' && !resolved
        ? [{ label: 'Pod restarted, issue persists', elapsedS: Math.max(0, Math.round((story.fixAt - story.detectedAt) / 1000)) }]
        : [],
      comparison: config.comparison,
      delivered: resolved ? delivered() : null,
    };
  }

  tick().catch((err) => logger.error(`incident panel tick failed: ${err.message}`));
  setInterval(() => tick().catch((err) => logger.error(`incident panel tick failed: ${err.stack || err.message}`)), TICK_MS).unref();

  return { snapshot, recordFailedOrder, recordFill, pdEnabled, tick };
}

module.exports = { createIncidentPanel };
