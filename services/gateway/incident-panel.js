'use strict';
// Incident panel state for the UI: one in-memory state machine (healthy -> incident -> resolved), refreshed every 5s.
//
// Inputs: chaos-api /state (active scenario; no scenario = nothing to show, state cleared), the health sampler
// (health failing or error rate over threshold), and the PagerDuty REST API (incidents, notes, log entries, change
// events) when PD_API_TOKEN and PD_SERVICE_IDS are set. Without them, or when the API fails, it falls back to the
// sampler alone. Reset clears the scenario in chaos-api (and restarts the gateway), which clears this state.

const TICK_MS = 5000;
const CHAOS_TIMEOUT_MS = 1500;
const PD_TIMEOUT_MS = 4000;
const PD_BASE = 'https://api.pagerduty.com';
// Healthy ticks in a row, and minimum incident age, before an incident counts as resolved. Guards against a quiet
// gap between the first blip (a rollout, a restart) and the real symptom. With PagerDuty, at least one incident
// must also exist and be resolved; the stricter fallback numbers compensate for that missing signal.
const STABLE_TICKS = { pagerduty: 2, 'health-summary': 6 };
const MIN_INCIDENT_S = { pagerduty: 30, 'health-summary': 45 };
const MAX_NOTE_CHARS = 60;
const FAILED_ORDER_KEEP_MS = 30 * 60 * 1000;

const ROOT_CAUSE_NOTE = /^\s*SRE Agent:\s*/i;
const FIX_CHANGE_EVENT = /\bfix|rollback|rolled back|\[INC\]/i;
// A Rundeck / automation job run on the incident. Diagnose runs automatically and is not the approved fix.
const AUTOMATION_ENTRY = /rundeck|runbook|process automation|automation action|action_invocation|invoke_action/i;
const DIAGNOSE = /diagnos/i;

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

function createIncidentPanel({ sampler, sampleOrderService = 'order', chaosUrl, pd, config, logger }) {
  // pd: { token, serviceIds[] }; config: { revenuePerS, hourlyRate, defaultEngineers, comparison }
  const bootAt = Date.now();
  const pdEnabled = Boolean(pd.token && pd.serviceIds.length);
  let st = fresh();
  let tickNo = 0;

  function fresh() {
    return {
      phase: 'healthy', startedAt: null, resolvedAt: null, scenario: null, mode: null, source: pdEnabled ? 'pagerduty' : 'health-summary',
      lastTickAt: null, healthyTicks: 0, healthySince: null, orderUnhealthyMs: 0, orderUnhealthyNow: false,
      engineers: new Set(), failedOrders: [], incidents: [], detectedAt: null, rootCause: null, rootCauseAt: null, fixAt: null,
      frozen: null,
    };
  }

  // ---- inputs ----
  async function fetchChaos() {
    try {
      const r = await fetch(`${chaosUrl}/state`, { signal: AbortSignal.timeout(CHAOS_TIMEOUT_MS) });
      if (!r.ok) return null;
      return await r.json();
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

  // Notes and log entries are only looked up while something is still missing, and every other tick.
  async function enrichFromPagerDuty(incidents) {
    for (const inc of incidents.slice(0, 5)) {
      if (!st.rootCause) {
        const { notes = [] } = await pdGet(`/incidents/${inc.id}/notes`);
        const note = notes.filter((n) => ROOT_CAUSE_NOTE.test(n.content || '')).sort((a, b) => ts(a.created_at) - ts(b.created_at))[0];
        if (note) {
          const line = note.content.replace(ROOT_CAUSE_NOTE, '').split('\n').map((l) => l.trim()).find(Boolean) || '';
          st.rootCause = line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS - 1)}…` : line;
          st.rootCauseAt = ts(note.created_at);
        }
      }
      if (!st.fixAt) {
        const { log_entries: entries = [] } = await pdGet(`/incidents/${inc.id}/log_entries`, { is_overview: 'false', limit: 100 });
        for (const e of entries) {
          const text = `${e.type || ''} ${e.summary || ''} ${(e.channel && (e.channel.summary || e.channel.type)) || ''}`;
          if (AUTOMATION_ENTRY.test(text) && !DIAGNOSE.test(text)) {
            const at = ts(e.created_at);
            if (!st.fixAt || at < st.fixAt) st.fixAt = at;
          }
        }
      }
    }
    if (!st.fixAt && st.startedAt) {
      const { change_events: events = [] } = await pdGet('/change_events', { since: new Date(st.startedAt).toISOString(), limit: 100 });
      for (const ev of events) {
        const at = ts(ev.timestamp || ev.created_at);
        if (at && at >= st.startedAt && /tradesim/i.test(ev.summary || '') && FIX_CHANGE_EVENT.test(ev.summary || '')) {
          if (!st.fixAt || at < st.fixAt) st.fixAt = at;
        }
      }
    }
  }

  // ---- state machine ----
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try { await runTick(); } finally { busy = false; }
  }

  async function runTick() {
    tickNo++;
    const now = Date.now();
    const chaos = await fetchChaos();
    if (chaos && !chaos.scenario) {
      // No active scenario (fresh install, or reset just ran): clear everything.
      if (st.phase !== 'healthy' || st.lastTickAt) logger.info('incident panel: no active scenario, state cleared');
      st = fresh();
      return;
    }
    if (st.phase === 'resolved') return; // frozen until reset
    if (chaos) { st.scenario = chaos.scenario; st.mode = chaos.mode; }

    const detail = sampler.detail();
    const services = detail ? detail.services : [];
    const degraded = services.filter((s) => !s.healthy || s.erroring);
    const order = services.find((s) => s.name === sampleOrderService);
    st.orderUnhealthyNow = Boolean(order && (!order.healthy || order.erroring));

    // PagerDuty: incidents on the TradeSim services since the scenario started. Failure falls back to health only.
    let incidents = null;
    if (pdEnabled) {
      const since = (chaos && ts(chaos.since)) || bootAt;
      try {
        incidents = await fetchIncidents(since);
        st.source = 'pagerduty';
      } catch (err) {
        st.source = 'health-summary';
        logger.warn(`incident panel: PagerDuty unavailable, using health summary: ${err.message}`);
      }
    } else {
      st.source = 'health-summary';
    }
    if (incidents) st.incidents = incidents;
    const open = incidents ? incidents.filter((i) => i.status !== 'resolved') : [];

    if (st.phase === 'healthy') {
      const signal = degraded.length > 0 || (incidents && incidents.length > 0);
      if (!signal) { st.lastTickAt = now; return; }
      const created = incidents && incidents.length ? Math.min(...incidents.map((i) => ts(i.created_at))) : now;
      st.phase = 'incident';
      st.startedAt = Math.min(now, created);
      st.lastTickAt = now;
      logger.info(`incident panel: incident started (${degraded.map((s) => s.name).join(', ') || 'from PagerDuty'}) scenario=${st.scenario}`);
    }

    // incident phase
    const dt = st.lastTickAt ? now - st.lastTickAt : 0;
    st.lastTickAt = now;
    if (st.orderUnhealthyNow) st.orderUnhealthyMs += dt;

    if (incidents && incidents.length) {
      st.detectedAt = Math.min(...incidents.map((i) => ts(i.created_at)));
      for (const i of open) {
        for (const a of i.assignments || []) if (a.assignee && a.assignee.type.startsWith('user')) st.engineers.add(a.assignee.id);
        for (const a of i.acknowledgements || []) if (a.acknowledger && a.acknowledger.type.startsWith('user')) st.engineers.add(a.acknowledger.id);
      }
      if (tickNo % 2 === 0 && (!st.rootCause || !st.fixAt)) {
        try { await enrichFromPagerDuty(incidents); } catch (err) { logger.warn(`incident panel: PagerDuty detail lookup failed: ${err.message}`); }
      }
    }

    const viaPd = st.source === 'pagerduty';
    const healthyNow = degraded.length === 0 && open.length === 0 && (!viaPd || incidents.length > 0);
    if (healthyNow) {
      st.healthyTicks++;
      if (!st.healthySince) st.healthySince = now;
    } else {
      st.healthyTicks = 0;
      st.healthySince = null;
    }
    if (st.healthyTicks >= STABLE_TICKS[st.source] && (now - st.startedAt) / 1000 >= MIN_INCIDENT_S[st.source]) {
      const pdResolvedAt = incidents && incidents.length ? Math.max(...incidents.map((i) => ts(i.last_status_change_at) || 0)) : 0;
      st.resolvedAt = Math.max(st.healthySince, pdResolvedAt);
      st.phase = 'resolved';
      st.frozen = measure(st.resolvedAt);
      logger.info(`incident panel: resolved after ${Math.round((st.resolvedAt - st.startedAt) / 1000)}s scenario=${st.scenario}`);
    }
  }

  // ---- outputs ----
  function recordFailedOrder(value) {
    if (!(value > 0)) return;
    const now = Date.now();
    st.failedOrders = st.failedOrders.filter((o) => now - o.at < FAILED_ORDER_KEEP_MS);
    st.failedOrders.push({ at: now, value });
  }

  function measure(end) {
    const elapsedS = Math.max(0, (end - st.startedAt) / 1000);
    const failed = st.failedOrders.filter((o) => o.at >= st.startedAt && o.at <= end).reduce((sum, o) => sum + o.value, 0);
    const engineers = Math.max(config.defaultEngineers, st.engineers.size);
    return {
      elapsedS,
      revenueAtRisk: Math.round(failed + (st.orderUnhealthyMs / 1000) * config.revenuePerS),
      engineers,
      cost: Math.round(engineers * (elapsedS / 60) * config.hourlyRate),
    };
  }

  function timeline(m) {
    const rel = (at) => (at ? Math.max(0, Math.round((at - st.startedAt) / 1000)) : null);
    const resolved = st.phase === 'resolved';
    return [
      { key: 'detected', label: 'Detected', elapsedS: rel(st.detectedAt || st.startedAt), detail: null },
      { key: 'root_cause', label: 'Root cause found', elapsedS: rel(st.rootCauseAt), detail: st.rootCause },
      { key: 'fix', label: 'Fix approved', elapsedS: rel(st.fixAt), detail: null },
      { key: 'resolved', label: 'Resolved', elapsedS: resolved ? Math.round(m.elapsedS) : null, detail: null },
    ];
  }

  function delivered() {
    const [d, r, p] = HEADLINES[st.scenario] || GENERIC_HEADLINES;
    return {
      scenario: st.scenario,
      blocks: [
        { key: 'detect', title: 'DETECT', headline: st.rootCause || d, value: DELIVERED_VALUES.detect },
        { key: 'resolve', title: 'RESOLVE', headline: r, value: DELIVERED_VALUES.resolve },
        { key: 'prevent', title: 'PREVENT', headline: p, value: DELIVERED_VALUES.prevent },
      ],
    };
  }

  function snapshot() {
    const base = { phase: st.phase, source: st.source, serverNow: Date.now() };
    if (st.phase === 'healthy') return base;
    const resolved = st.phase === 'resolved';
    const m = resolved ? st.frozen : measure(Date.now());
    return {
      ...base,
      scenario: st.scenario,
      startedAt: st.startedAt,
      resolvedAt: st.resolvedAt,
      metrics: { revenueAtRisk: m.revenueAtRisk, timeToResolveS: Math.round(m.elapsedS), engineers: m.engineers, cost: m.cost },
      live: resolved ? null : { orderUnhealthy: st.orderUnhealthyNow, revenuePerS: config.revenuePerS, hourlyRate: config.hourlyRate },
      timeline: timeline(m),
      comparison: config.comparison,
      delivered: resolved ? delivered() : null,
    };
  }

  tick().catch((err) => logger.error(`incident panel tick failed: ${err.message}`));
  setInterval(() => tick().catch((err) => logger.error(`incident panel tick failed: ${err.stack || err.message}`)), TICK_MS).unref();

  return { snapshot, recordFailedOrder, pdEnabled };
}

module.exports = { createIncidentPanel };
