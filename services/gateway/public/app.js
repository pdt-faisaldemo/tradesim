'use strict';
// TradeSim UI: vanilla JS, hash routing, no build step. All text goes through textContent (never innerHTML).

const CUSTOMER_ID = 'c-1001';
const SERVICES = ['gateway', 'order', 'risk', 'account', 'portfolio', 'market-data'];
const NAMES = {
  AMZN: 'Amazon', NVDA: 'NVIDIA', ANTH: 'Anthropic', IBM: 'IBM', AMD: 'AMD', INTC: 'Intel',
  META: 'Meta Platforms', CRM: 'Salesforce', SNOW: 'Snowflake', CRWD: 'CrowdStrike', PANW: 'Palo Alto Networks',
  ANET: 'Arista Networks', NBIS: 'Nebius', CRWV: 'CoreWeave', NFLX: 'Netflix',
};
const SYMBOLS = Object.keys(NAMES);
const GET_TIMEOUT_MS = 5000;
const POST_TIMEOUT_MS = 10000;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => usd.format(n);
const signed = (n) => (n > 0 ? '+' : n < 0 ? '-' : '') + usd.format(Math.abs(n));
const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

// ---------- DOM helpers ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

// ---------- API ----------
class ApiError extends Error {
  constructor(message, { ref = null, status = 0, body = null } = {}) {
    super(message);
    this.ref = ref;
    this.status = status;
    this.body = body;
  }
}

// Turns any failure into a sentence a customer can read; the reference id goes alongside it.
function friendly(status, body) {
  if (status === 502 || status === 503) {
    const up = body && body.upstream ? ` (${body.upstream} is not responding)` : '';
    return `We're having trouble reaching part of our trading system${up}. Please try again in a moment.`;
  }
  if (status === 404) return 'We could not find that account or page.';
  if (status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  return (body && body.error) || 'That request could not be completed.';
}

async function api(path, { method = 'GET', body, timeoutMs } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs || (method === 'GET' ? GET_TIMEOUT_MS : POST_TIMEOUT_MS)),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new ApiError(timedOut ? 'This is taking longer than expected. Please try again.' : 'We could not reach TradeSim. Check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  const ref = (data && data.traceId) || res.headers.get('x-trace-id');
  if (!res.ok) throw new ApiError(friendly(res.status, data), { ref, status: res.status, body: data });
  return data;
}

// An error counts as incident-related (data-incident) when it is a system failure, or it appears while the incident panel
// reports an incident or a reset. Those are swapped for "Service restored" when the panel recovers. Everything else
// (an invalid quantity, a genuine decline while healthy) is a normal error and stays.
function errorBox(err, extraClass = '') {
  const phase = panelData && panelData.phase;
  const systemError = err.status === 0 || err.status >= 500;
  const incidentRelated = systemError || phase === 'incident' || phase === 'resetting';
  return h('div', { class: `msg error ${extraClass}`, role: 'alert', 'data-incident': incidentRelated },
    err.message,
    err.ref ? h('span', { class: 'ref' }, `Reference: ${err.ref}`) : null);
}

// ---------- polling ----------
// Every page registers its timers here; they are all cleared when the route changes.
// Each polled function is also kept in `refreshers`, so the page can re-fetch at once when service is restored.
// `pageHooks` are per-page callbacks for those moments (also cleared on route change).
let timers = [];
let refreshers = [];
let pageHooks = { restored: [], reset: [] };
function every(ms, fn) {
  fn();
  timers.push(setInterval(fn, ms));
  refreshers.push(fn);
}
function stopTimers() { timers.forEach(clearInterval); timers = []; refreshers = []; pageHooks = { restored: [], reset: [] }; }

// ---------- shared state: last good quotes, so every page can show the previous price ----------
const quoteState = { prices: null, prev: null, asOf: null };
async function refreshQuotes() {
  const q = await api('/api/quotes');
  if (q.asOf !== quoteState.asOf) quoteState.prev = quoteState.prices;
  quoteState.prices = q.prices;
  quoteState.asOf = q.asOf;
  return q;
}

// ---------- widgets ----------
function stat(label, value, sub, cls) {
  return h('div', { class: 'card stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${cls || ''}` }, value),
    sub ? h('div', { class: 'sub' }, sub) : null);
}

// A section that shows "Loading..." only until the first result or error, never indefinitely.
function section(title, headRight) {
  const body = h('div', {}, h('div', { class: 'empty' }, 'Loading...'));
  const right = h('span', { class: 'muted' }, headRight || '');
  const card = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title), right), body);
  return { card, body, right };
}

function showTable(sec, headers, rows, emptyText) {
  clear(sec.body);
  if (!rows.length) { sec.body.append(h('div', { class: 'empty' }, emptyText)); return; }
  sec.body.append(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map(([text, num]) => h('th', { class: num ? 'num' : '' }, text)))),
    h('tbody', {}, rows))));
}

function showError(sec, err, stale) {
  // Keep stale data visible (dimmed message above it) if we have some; otherwise replace the loading text.
  if (stale) {
    const old = sec.body.querySelector('.inline-error');
    if (old) old.remove();
    sec.body.prepend(errorBox(err, 'inline-error'));
  } else {
    clear(sec.body).append(errorBox(err, 'inline-error'));
  }
}
function clearError(sec) {
  const old = sec.body.querySelector('.inline-error');
  if (old) old.remove();
}

function marketRows(withName) {
  return SYMBOLS.map((sym) => {
    const price = quoteState.prices[sym];
    const prev = quoteState.prev && quoteState.prev[sym];
    const delta = prev ? price - prev : 0;
    return h('tr', {},
      h('td', { class: 'sym' }, sym, withName ? h('small', {}, NAMES[sym]) : null),
      h('td', { class: 'num' }, money(price)),
      h('td', { class: `num ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted'}` },
        prev ? (delta > 0 ? '▲ ' : delta < 0 ? '▼ ' : '') + (delta === 0 ? '-' : signed(delta)) : '-'));
  });
}

// ---------- pages ----------
function dashboardPage(root) {
  const stats = h('div', { class: 'grid stats' });
  const market = section('Market watch', '');
  root.append(h('h1', {}, 'Dashboard'), stats, market.card);
  let haveMarket = false;

  const paintStats = (p) => {
    clear(stats).append(
      stat('Cash', money(p.cash), `Account ${p.customerId}`),
      stat('Account value', money(p.totals.accountValue), `Positions ${money(p.totals.positionsValue)}`),
      stat('Unrealised P&L', signed(p.totals.pnl), p.name, p.totals.pnl >= 0 ? 'up' : 'down'));
  };
  clear(stats).append(h('div', { class: 'msg info' }, 'Loading account...'));

  every(3000, async () => {
    try {
      paintStats(await api(`/api/portfolio/${CUSTOMER_ID}`));
    } catch (err) {
      clear(stats).append(errorBox(err));
    }
  });
  every(2000, async () => {
    try {
      const q = await refreshQuotes();
      market.right.textContent = `Prices as of ${clock(q.asOf)}`;
      showTable(market, [['Symbol'], ['Price', true], ['Change', true]], marketRows(true), 'No quotes available.');
      haveMarket = true;
    } catch (err) {
      showError(market, err, haveMarket);
    }
  });
}

function tradePage(root) {
  const symbolSel = h('select', { id: 'symbol', required: true }, SYMBOLS.map((s) => h('option', { value: s }, `${s} – ${NAMES[s]}`)));
  const qtyIn = h('input', { id: 'qty', type: 'number', min: '1', step: '1', value: '10', required: true, inputmode: 'numeric' });
  const priceEl = h('strong', {}, '...');
  const costEl = h('strong', {}, '-');
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Buy');
  const result = h('div', { 'aria-live': 'polite' });
  const orders = section('Recent orders');

  const updateQuote = () => {
    const price = quoteState.prices && quoteState.prices[symbolSel.value];
    priceEl.textContent = price ? money(price) : 'unavailable';
    const qty = Number(qtyIn.value);
    costEl.textContent = price && Number.isInteger(qty) && qty > 0 ? money(price * qty) : '-';
  };
  symbolSel.addEventListener('change', updateQuote);
  qtyIn.addEventListener('input', updateQuote);

  let lastOrder = null; // the last order submitted, for "Retry order"

  async function placeOrder(order) {
    lastOrder = order;
    submit.disabled = true;
    submit.textContent = 'Placing order...';
    clear(result).append(h('div', { class: 'msg info' }, 'Placing your order...'));
    try {
      const o = await api('/api/orders', { method: 'POST', body: { customerId: CUSTOMER_ID, ...order } });
      lastOrder = null;
      clear(result).append(h('div', { class: 'msg ok', role: 'status' },
        `Order filled: bought ${o.qty} ${o.symbol} at ${money(o.price)} for ${money(o.cost)}. Cash remaining ${money(o.cash)}.`,
        h('span', { class: 'ref' }, `Order ${o.orderId}`)));
      loadOrders();
    } catch (err) {
      if (err.status === 422) err.message = 'Order declined: insufficient buying power for this trade.';
      else if (err.status === 409) err.message = 'Order declined: not enough cash for this trade.';
      clear(result).append(errorBox(err));
    } finally {
      submit.disabled = false;
      submit.textContent = 'Buy';
    }
  }

  const form = h('form', { novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const qty = Number(qtyIn.value);
    if (!Number.isInteger(qty) || qty < 1) {
      clear(result).append(h('div', { class: 'msg error', role: 'alert' }, 'Enter a whole number of shares, 1 or more.'));
      return;
    }
    placeOrder({ symbol: symbolSel.value, qty });
  } },
  h('label', {}, 'Symbol', symbolSel),
  h('label', {}, 'Quantity (shares)', qtyIn),
  h('div', { class: 'quote-line' }, h('span', {}, 'Price ', priceEl), h('span', {}, 'Estimated cost ', costEl)),
  submit);

  // Service restored: the failed order's message became "Service restored", so offer to send that order again.
  pageHooks.restored.push(() => {
    if (!lastOrder || !result.querySelector('.restored')) return;
    const order = lastOrder;
    result.firstChild.append(' ', h('button', { class: 'btn btn-small', type: 'button', onclick: () => placeOrder(order) }, 'Retry order'));
  });
  // Reset: back to a clean form.
  pageHooks.reset.push(() => {
    lastOrder = null;
    clear(result);
    symbolSel.selectedIndex = 0;
    qtyIn.value = '10';
    updateQuote();
  });

  root.append(h('h1', {}, 'Trade'), h('div', { class: 'grid two-col' },
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Buy shares'), h('span', { class: 'muted' }, 'Market order')),
      h('div', { class: 'card-body' }, form, result)),
    orders.card));

  let haveOrders = false;
  async function loadOrders() {
    try {
      const { orders: list } = await api(`/api/orders?customerId=${CUSTOMER_ID}&limit=10`);
      showTable(orders, [['Time'], ['Symbol'], ['Qty', true], ['Price', true], ['Cost', true]],
        list.map((o) => h('tr', {},
          h('td', {}, clock(o.createdAt)), h('td', { class: 'sym' }, o.symbol),
          h('td', { class: 'num' }, o.qty), h('td', { class: 'num' }, money(o.price)), h('td', { class: 'num' }, money(o.cost)))),
        'No orders yet. Place your first trade.');
      haveOrders = true;
    } catch (err) {
      showError(orders, err, haveOrders);
    }
  }
  every(5000, loadOrders);
  every(2000, async () => {
    try { await refreshQuotes(); } catch { /* the price line shows "unavailable" until quotes recover */ }
    updateQuote();
  });
}

function portfolioPage(root) {
  const stats = h('div', { class: 'grid stats' });
  const positions = section('Positions', '');
  root.append(h('h1', {}, 'Portfolio'), stats, positions.card);
  clear(stats).append(h('div', { class: 'msg info' }, 'Loading portfolio...'));
  let have = false;

  every(3000, async () => {
    const started = performance.now();
    try {
      const p = await api(`/api/portfolio/${CUSTOMER_ID}`);
      const loadedMs = Math.round(performance.now() - started);
      have = true;
      clear(stats).append(
        stat('Account value', money(p.totals.accountValue), p.name),
        stat('Positions value', money(p.totals.positionsValue)),
        stat('Cash', money(p.cash)),
        stat('Unrealised P&L', signed(p.totals.pnl), null, p.totals.pnl >= 0 ? 'up' : 'down'));
      positions.right.textContent = `Prices as of ${clock(p.asOf)} · Loaded in ${loadedMs} ms`;
      showTable(positions, [['Symbol'], ['Qty', true], ['Avg cost', true], ['Price', true], ['Value', true], ['P&L', true], ['P&L %', true]],
        p.positions.map((x) => {
          const cls = x.pnl >= 0 ? 'up' : 'down';
          return h('tr', {},
            h('td', { class: 'sym' }, x.symbol, h('small', {}, NAMES[x.symbol] || '')),
            h('td', { class: 'num' }, x.qty), h('td', { class: 'num' }, money(x.avgCost)), h('td', { class: 'num' }, money(x.price)),
            h('td', { class: 'num' }, money(x.marketValue)),
            h('td', { class: `num ${cls}` }, signed(x.pnl)),
            h('td', { class: `num ${cls}` }, `${x.pnlPct > 0 ? '+' : ''}${x.pnlPct.toFixed(2)}%`));
        }),
        'You do not hold any positions yet. Head to Trade to buy your first shares.');
    } catch (err) {
      if (!have) clear(stats);
      positions.right.textContent = `Failed after ${Math.round(performance.now() - started)} ms`;
      showError(positions, err, have);
    }
  });
}

const PAGES = { dashboard: dashboardPage, trade: tradePage, portfolio: portfolioPage };
const PANEL_PAGES = new Set(['dashboard', 'trade', 'portfolio']);

function route() {
  const page = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const name = PAGES[page] ? page : 'dashboard';
  stopTimers();
  const root = clear(document.getElementById('app'));
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === name));
  document.title = `TradeSim – ${name[0].toUpperCase()}${name.slice(1)}`;
  document.getElementById('dock').hidden = !PANEL_PAGES.has(name);
  PAGES[name](root);
}

// ---------- on every page: health strip + status banner ----------
const strip = document.getElementById('health-strip');
const banner = document.getElementById('banner');

let lastServices = [];
const isResetting = () => Boolean(panelData && panelData.phase === 'resetting');

// Dots: green healthy, red unhealthy (health check failing or error rate high), grey unknown or while updates are applied.
function paintHealth(services) {
  lastServices = services || [];
  const byName = Object.fromEntries(lastServices.map((s) => [s.name, s]));
  const updating = isResetting();
  clear(strip).append(...SERVICES.map((name) => {
    const s = byName[name];
    const state = updating || !s ? 'unknown' : s.healthy ? 'ok' : 'bad';
    const label = updating ? 'updating' : state === 'ok' ? 'healthy' : state === 'bad' ? `unhealthy${s.reason ? `: ${s.reason}` : ''}` : 'status unknown';
    return h('span', { class: 'svc', title: `${name}: ${label}` },
      h('span', { class: `dot ${state === 'unknown' ? '' : state}`, role: 'img', 'aria-label': `${name} ${label}` }), name);
  }));
}

async function pollHealth() {
  try {
    paintHealth((await api('/api/health-summary')).services);
  } catch {
    // Could not even reach the gateway: show every dot as red rather than stale green.
    paintHealth(SERVICES.map((name) => ({ name, healthy: false, reason: 'cannot reach gateway' })));
  }
}

// The banner follows the same /api/incident-panel data as the panel, so the two always agree.
const BANNER_TEXT = {
  incident: "Trading is degraded. We're working on it.",
  resetting: 'Applying scheduled updates. Back in a moment.',
};
function paintBanner() {
  const phase = panelData && panelData.phase;
  const text = BANNER_TEXT[phase];
  banner.hidden = !text;
  banner.classList.toggle('info', phase === 'resetting');
  if (text) banner.textContent = text;
}

// ---------- recovery: replace stale error messages ----------
const RESTORED_TEXT = 'Service restored. Please try again.';
const refreshPage = () => refreshers.forEach((fn) => fn());

// Incident over (healthy or resolved): incident-related errors become a green "Service restored" message.
function restoreUi() {
  document.querySelectorAll('#app .msg.error[data-incident]').forEach((el) => {
    el.replaceWith(h('div', { class: `msg ok restored ${el.classList.contains('inline-error') ? 'inline-error' : ''}`, role: 'status' }, RESTORED_TEXT));
  });
  pageHooks.restored.forEach((fn) => fn());
  refreshPage();
}

// Reset: no messages left on the page, forms back to their defaults, data re-fetched.
function resetUi() {
  document.querySelectorAll('#app .msg.error[data-incident], #app .msg.restored').forEach((el) => el.remove());
  pageHooks.reset.forEach((fn) => fn());
  refreshPage();
}

function onPhaseChange(prev, next) {
  if (next === 'resetting' || prev === 'resetting') resetUi();
  else if (prev === 'incident' && (next === 'healthy' || next === 'resolved')) restoreUi();
}

// ---------- floating panels: incident status (right) and reliability delivered (left) ----------
// State comes from /api/incident-panel (the gateway polls PagerDuty every 5s). Time and cost tick locally each second.
const incidentEl = document.getElementById('incident-panel');
const deliveredEl = document.getElementById('delivered-panel');
const BLOCK_STAGGER_MS = 600;

let panelData = null;
let panelKey = null; // last painted content, so an unchanged poll does not rebuild the DOM
let panelClockSkew = 0; // server clock minus browser clock
let live = null; // text nodes updated every second while an incident is open
let deliveredShown = false;
let deliveredTimers = [];

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const usd0 = (n) => usd.format(Math.round(n)).replace(/\.00$/, '');

function paintIncidentPanel() {
  const d = panelData;
  live = null;
  clear(incidentEl);
  incidentEl.className = 'panel panel-right';
  if (d && d.phase === 'resetting') {
    incidentEl.classList.add('pill');
    incidentEl.append(h('span', { class: 'dot idle', 'aria-hidden': 'true' }), 'Applying updates…');
    return;
  }
  if (!d || d.phase === 'healthy') {
    incidentEl.classList.add('pill');
    incidentEl.append(h('span', { class: 'dot ok', 'aria-hidden': 'true' }), 'All systems operational · Monitored by PagerDuty');
    return;
  }
  const resolved = d.phase === 'resolved';
  const m = d.metrics;
  const stale = m.kind === 'stale';
  const first = stale
    ? h('div', {}, h('div', { class: 'v' }, String(m.staleTrades)), h('div', { class: 'sub' }, `${usd0(m.staleExposure)} exposure`))
    : h('div', { class: 'v' }, usd0(m.revenueAtRisk));
  const time = h('div', { class: 'v' }, mmss(m.timeToResolveS));
  const engineers = h('div', { class: 'v' }, String(m.engineers));
  const cost = h('div', { class: 'v' }, usd0(m.cost));
  const metric = (label, v) => h('div', { class: 'ip-metric' }, h('div', { class: 'k' }, label), v);

  const steps = d.timeline.map((t) => h('li', { class: t.elapsedS == null ? '' : 'done' },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, t.elapsedS == null ? '○' : '✓'),
    h('span', {}, t.label),
    h('span', { class: 't' }, t.elapsedS == null ? '--' : mmss(t.elapsedS)),
    t.detail ? h('span', { class: 'd' }, t.detail) : null,
    t.detail && t.url && t.url.startsWith('https://')
      ? h('a', { class: 'ip-link', href: t.url, target: '_blank', rel: 'noopener noreferrer' }, 'Full analysis in PagerDuty →')
      : null));
  const notes = (d.notes || []).map((n) => h('li', { class: 'note' },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, '↻'), h('span', {}, n.label), h('span', { class: 't' }, mmss(n.elapsedS))));

  incidentEl.append(h('div', { class: `ipanel ${resolved ? 'resolved' : 'incident'}`, role: 'status' },
    h('div', { class: 'ip-head' }, h('span', {}, 'TradeSim incident'), h('span', { class: 'ip-chip' }, resolved ? 'RESOLVED' : 'IN PROGRESS')),
    h('div', { class: 'ip-metrics' },
      metric(stale ? 'Trades at stale prices' : 'Revenue at risk', first), metric('Time to resolve', time),
      metric('Engineers engaged', engineers), metric('Cost of response', cost)),
    h('div', { class: 'ip-section' }, h('h3', {}, 'Investigation led by Paige'), h('ol', { class: 'ip-steps' }, steps, notes)),
    h('div', { class: 'ip-compare' }, `Typical without AI (illustrative): ${d.comparison}`),
    resolved ? h('div', { class: 'ip-checks' }, h('span', {}, '✓ Detect'), h('span', {}, '✓ Resolve'), h('span', {}, '✓ Prevent')) : null,
    resolved ? h('div', { class: 'ip-foot' }, 'PagerDuty Reliability Platform') : null));

  if (!resolved) live = { revenue: stale ? null : first, time, cost, engineers };
  tickIncidentPanel();
}

// Extrapolates between polls: elapsed time, cost, and revenue while the order service is unhealthy.
function tickIncidentPanel() {
  const d = panelData;
  if (!live || !d || d.phase !== 'incident') return;
  const nowServer = Date.now() + panelClockSkew;
  const sinceSnapshotS = Math.max(0, (nowServer - d.serverNow) / 1000);
  const elapsedS = Math.max(0, (nowServer - d.startedAt) / 1000);
  if (live.revenue) live.revenue.textContent = usd0(d.metrics.revenueAtRisk + (d.live.orderUnhealthy ? sinceSnapshotS * d.live.revenuePerS : 0));
  live.time.textContent = mmss(elapsedS);
  live.cost.textContent = usd0(d.metrics.engineers * (elapsedS / 60) * d.live.hourlyRate);
}

function paintDeliveredPanel() {
  const d = panelData;
  if (!d || d.phase !== 'resolved' || !d.delivered) {
    // Back to healthy (reset): hide and rearm.
    deliveredTimers.forEach(clearTimeout);
    deliveredTimers = [];
    deliveredShown = false;
    deliveredEl.hidden = true;
    clear(deliveredEl);
    return;
  }
  if (deliveredShown) return; // stays as it is until reset
  deliveredShown = true;
  const blocks = d.delivered.blocks.map((b) => h('div', { class: 'dp-block' },
    h('span', { class: 'dp-check', 'aria-hidden': 'true' }, '✓'),
    h('span', { class: 'dp-label' }, b.title),
    h('span', { class: 'dp-headline' }, b.headline),
    h('span', { class: 'dp-value' }, b.value)));
  clear(deliveredEl).append(h('div', { class: 'dpanel' },
    h('div', { class: 'dp-title' }, 'Reliability delivered'), blocks,
    h('div', { class: 'dp-foot' }, 'PagerDuty Reliability Platform')));
  deliveredEl.hidden = false;
  blocks.forEach((el, i) => deliveredTimers.push(setTimeout(() => el.classList.add('in'), 50 + i * BLOCK_STAGGER_MS)));
}

async function pollIncidentPanel() {
  let d;
  try {
    d = await api('/api/incident-panel');
  } catch {
    return; // keep showing the last known state rather than flashing
  }
  panelClockSkew = d.serverNow - Date.now();
  const prev = panelData ? panelData.phase : null;
  const phaseChanged = prev !== d.phase;
  const { serverNow, ...content } = d;
  const key = JSON.stringify(content);
  panelData = d;
  if (key !== panelKey) { panelKey = key; paintIncidentPanel(); }
  if (phaseChanged || d.phase === 'healthy' || d.phase === 'resetting') paintDeliveredPanel();
  paintBanner();
  if (phaseChanged) {
    paintHealth(lastServices);
    onPhaseChange(prev, d.phase);
  }
}

// ---------- theme ----------
document.getElementById('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
});

paintHealth([]);
pollHealth();
setInterval(pollHealth, 3000);
pollIncidentPanel();
setInterval(pollIncidentPanel, 3000);
setInterval(tickIncidentPanel, 1000);
window.addEventListener('hashchange', route);
route();
