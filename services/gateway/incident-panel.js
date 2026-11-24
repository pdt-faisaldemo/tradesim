'use strict';
// Incident panel state for the UI: one in-memory state machine (healthy -> incident -> resolved), refreshed every 5s,
// plus a 'resetting' phase while scripts/reset.sh runs. The status banner and the health dots follow this same state.
//
// Inputs: chaos-api /state (active scenario, resetting flag, outcome), the health sampler (health failing or error
// rate over threshold), and the PagerDuty REST API (incidents, notes, log entries, change events) when PD_API_TOKEN
// and PD_SERVICE_IDS are set.
//
// Resolving: while a scenario is active, health alone never resolves an incident. It ends when the PagerDuty incident
// is resolved (needs the API token), or when the scenario is cleared: by a fix (chaos-api outcome 'fixed', set by
// scripts/clear-scenario.sh from the Rundeck fix jobs) which shows Resolved, or by reset.sh which returns to healthy.
// Only when no scenario is known (chaos-api unreachable) does health alone resolve, after 60 healthy seconds.

const TICK_MS = 2000; // state machine; PagerDuty is polled every PD_POLL_MS
const PD_POLL_MS = 5000;
const CHAOS_TIMEOUT_MS = 1500;
const PD_TIMEOUT_MS = 4000;
const PD_BASE = 'https://api.pagerduty.com';
// With PagerDuty, an incident must exist, none may be open for PD_STABLE_MS, and the incident must be at
// least MIN_INCIDENT_S old: guards against a short-lived incident from the first blip (a rollout) resolving the panel.
const PD_STABLE_MS = 10000;
const MIN_INCIDENT_S = 30;
const HEALTH_ONLY_RESOLVE_S = 60; // consecutive healthy seconds, only when no scenario is known
const RESET_ERROR_GRACE_MS = 35000; // error rates in the 30s window still describe the old fault right after a reset
// A restart this long after the incident began, before any fix, is the platform restarting a crashing pod.
const RESTART_NOTE_AFTER_S = 30;
const MAX_NOTE_CHARS = 60;
const FAILED_ORDER_KEEP_MS = 30 * 60 * 1000;

const ROOT_CAUSE_NOTE = /^\s*SRE Agent:\s*/i;
const PANEL_SUMMARY_LINE = /^\s*Panel summary:\s*/i;
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
  const bootAt = Date.now();
  const pdEnabled = Boolean(pd.token && pd.serviceIds.length);
  let st = fresh();
  let resetting = false;

  function fresh() {
    return {
      phase: 'healthy', startedAt: null, resolvedAt: null, scenario: null, mode: null, source: pdEnabled ? 'pagerduty' : 'health-summary',
      lastTickAt: null, healthyTicks: 0, healthySince: null, orderUnhealthyMs: 0, orderUnhealthyNow: false,
      engineers: new Set(), failedOrders: [], staleTrades: [], incidents: [], detectedAt: null,
      rootCause: null, rootCauseAt: null, rootCauseUrl: null, fixAt: null, restartAt: null,
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
      if (!st.rootCauseAt) {
        const { notes = [] } = await pdGet(`/incidents/${inc.id}/notes`);
        const note = notes.filter((n) => ROOT_CAUSE_NOTE.test(n.content || '')).sort((a, b) => ts(a.created_at) - ts(b.created_at))[0];
        if (note) {
          // The step shows the note's "Panel summary:" line; a note without one falls back to the scenario's preset text.
          st.rootCause = panelSummary(note.content) || presetHeadlines()[0];
          st.rootCauseAt = ts(note.created_at);
          st.rootCauseUrl = safeUrl(inc.html_url);
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

  // PagerDuty is polled every PD_POLL_MS even though the state machine ticks faster (to notice a reset quickly).
  const pdCache = { at: 0, incidents: null, since: null, fetches: 0 };
  async function pagerDutyIncidents(since, now) {
    if (!pdEnabled) return null;
    if (now - pdCache.at < PD_POLL_MS && pdCache.since === since) return pdCache.incidents;
    pdCache.at = now;
    pdCache.since = since;
    try {
      pdCache.incidents = await fetchIncidents(since);
      pdCache.fetches++;
    } catch (err) {
      pdCache.incidents = null;
      logger.warn(`incident panel: PagerDuty unavailable, using health summary: ${err.message}`);
    }
    return pdCache.incidents;
  }

  function resolveNow(at, why) {
    st.resolvedAt = at;
    st.phase = 'resolved';
    st.frozen = measure(at);
    logger.info(`incident panel: resolved (${why}) after ${Math.round((at - st.startedAt) / 1000)}s scenario=${st.scenario}`);
  }

  async function runTick() {
    const now = Date.now();
    const chaos = await fetchChaos();
    if (chaos && chaos.resetting) {
      if (!resetting) logger.info('incident panel: reset in progress');
      resetting = true;
      st = fresh();
      pdCache.at = 0;
      return;
    }
    if (resetting) {
      resetting = false;
      sampler.setErrorGrace(RESET_ERROR_GRACE_MS);
      logger.info('incident panel: reset finished');
    }
    if (chaos && chaos.scenario) sampler.setErrorGrace(0);
    if (chaos && !chaos.scenario) {
      if (chaos.outcome === 'fixed') {
        // A remediation cleared the scenario: that is a resolution, not a reset.
        if (st.phase === 'incident') resolveNow(now, 'scenario cleared by a fix');
        return;
      }
      // No active scenario (fresh install, or reset just ran): clear everything.
      if (st.phase !== 'healthy' || st.lastTickAt) logger.info('incident panel: no active scenario, state cleared');
      st = fresh();
      pdCache.at = 0;
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
    const since = (chaos && ts(chaos.since)) || bootAt;
    const incidents = await pagerDutyIncidents(since, now);
    st.source = incidents ? 'pagerduty' : 'health-summary';
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

    if (!st.restartAt) {
      const restart = sampler.restartsSince(st.startedAt + RESTART_NOTE_AFTER_S * 1000).find((r) => !st.fixAt || r.at < st.fixAt);
      if (restart) st.restartAt = restart.at;
    }

    if (incidents && incidents.length) {
      st.detectedAt = Math.min(...incidents.map((i) => ts(i.created_at)));
      for (const i of open) {
        for (const a of i.assignments || []) if (a.assignee && a.assignee.type.startsWith('user')) st.engineers.add(a.assignee.id);
        for (const a of i.acknowledgements || []) if (a.acknowledger && a.acknowledger.type.startsWith('user')) st.engineers.add(a.acknowledger.id);
      }
      if (pdCache.at === now && (!st.rootCauseAt || !st.fixAt)) {
        try { await enrichFromPagerDuty(incidents); } catch (err) { logger.warn(`incident panel: PagerDuty detail lookup failed: ${err.message}`); }
      }
    }

    // Resolved: see the header comment. Health alone only counts when no scenario is known.
    let quiet;
    if (st.source === 'pagerduty') quiet = incidents.length > 0 && open.length === 0;
    else if (!st.scenario) quiet = degraded.length === 0;
    else quiet = false;
    if (quiet) { if (!st.healthySince) st.healthySince = now; } else st.healthySince = null;
    if (!quiet) return;
    if (st.source === 'pagerduty') {
      if (now - st.healthySince >= PD_STABLE_MS && (now - st.startedAt) / 1000 >= MIN_INCIDENT_S) {
        const resolvedAt = Math.max(...incidents.map((i) => ts(i.last_status_change_at) || 0), st.healthySince);
        resolveNow(Math.min(resolvedAt, now), 'PagerDuty incident resolved');
      }
    } else if (now - st.healthySince >= HEALTH_ONLY_RESOLVE_S * 1000) {
      resolveNow(st.healthySince, `healthy for ${HEALTH_ONLY_RESOLVE_S}s`);
    }
  }

  // ---- outputs ----
  const presetHeadlines = () => HEADLINES[st.scenario] || GENERIC_HEADLINES;

  function recordFailedOrder(value) {
    if (!(value > 0)) return;
    const now = Date.now();
    st.failedOrders = st.failedOrders.filter((o) => now - o.at < FAILED_ORDER_KEEP_MS);
    st.failedOrders.push({ at: now, value });
  }

  // An order that filled while the price feed was stale (S3). Counted only while a stale-price scenario is active.
  function recordFill(value, priceAgeS) {
    if (!(value > 0) || !(priceAgeS > STALE_FEED_S) || !STALE_SCENARIOS.has(st.scenario)) return;
    const now = Date.now();
    st.staleTrades = st.staleTrades.filter((o) => now - o.at < FAILED_ORDER_KEEP_MS);
    st.staleTrades.push({ at: now, value });
  }

  function measure(end) {
    const elapsedS = Math.max(0, (end - st.startedAt) / 1000);
    const failed = st.failedOrders.filter((o) => o.at >= st.startedAt && o.at <= end).reduce((sum, o) => sum + o.value, 0);
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

  function timeline(m) {
    const rel = (at) => (at ? Math.max(0, Math.round((at - st.startedAt) / 1000)) : null);
    const resolved = st.phase === 'resolved';
    return [
      { key: 'detected', label: 'Detected', elapsedS: rel(st.detectedAt || st.startedAt), detail: null },
      { key: 'root_cause', label: 'Root cause found', elapsedS: rel(st.rootCauseAt), detail: st.rootCause, url: st.rootCauseUrl },
      { key: 'fix', label: 'Fix approved', elapsedS: rel(st.fixAt), detail: null },
      { key: 'resolved', label: 'Resolved', elapsedS: resolved ? Math.round(m.elapsedS) : null, detail: null },
    ];
  }

  // The left panel always shows the preset headlines, never live note text.
  function delivered() {
    const [d, r, p] = presetHeadlines();
    return {
      scenario: st.scenario,
      blocks: [
        { key: 'detect', title: 'DETECT', headline: d, value: DELIVERED_VALUES.detect },
        { key: 'resolve', title: 'RESOLVE', headline: r, value: DELIVERED_VALUES.resolve },
        { key: 'prevent', title: 'PREVENT', headline: p, value: DELIVERED_VALUES.prevent },
      ],
    };
  }

  function snapshot() {
    const base = { phase: st.phase, source: st.source, serverNow: Date.now() };
    if (resetting) return { ...base, phase: 'resetting' };
    if (st.phase === 'healthy') return base;
    const resolved = st.phase === 'resolved';
    const m = resolved ? st.frozen : measure(Date.now());
    const kind = STALE_SCENARIOS.has(st.scenario) ? 'stale' : 'revenue';
    return {
      ...base,
      scenario: st.scenario,
      startedAt: st.startedAt,
      resolvedAt: st.resolvedAt,
      metrics: {
        kind, revenueAtRisk: m.revenueAtRisk, staleTrades: m.staleTrades, staleExposure: m.staleExposure,
        timeToResolveS: Math.round(m.elapsedS), engineers: m.engineers, cost: m.cost,
      },
      live: resolved ? null : { orderUnhealthy: kind === 'revenue' && st.orderUnhealthyNow, revenuePerS: config.revenuePerS, hourlyRate: config.hourlyRate },
      timeline: timeline(m),
      notes: st.restartAt ? [{ label: 'Pod restarted automatically, issue persists', elapsedS: Math.max(0, Math.round((st.restartAt - st.startedAt) / 1000)) }] : [],
      comparison: config.comparison,
      delivered: resolved ? delivered() : null,
    };
  }

  tick().catch((err) => logger.error(`incident panel tick failed: ${err.message}`));
  setInterval(() => tick().catch((err) => logger.error(`incident panel tick failed: ${err.stack || err.message}`)), TICK_MS).unref();

  return { snapshot, recordFailedOrder, recordFill, pdEnabled, tick };
}

module.exports = { createIncidentPanel };
