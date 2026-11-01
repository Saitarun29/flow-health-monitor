import { analyze, fmtMinutes, fmtDuration, RULES } from '/lib/health.js';
import { sampleWorkflows } from '/lib/sample.js';
import { demoExplain } from '/lib/explain-demo.js';
import { alertText } from '/lib/alert.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MIN = 60_000;
const C = { ok: '#B9B9B2', bad: '#B42318', warn: '#A86A12', ink: '#111111', ink2: '#3D3D3A', line: '#E6E6E1', muted: '#6F6F6A', okDot: '#2F7D4F', idle: '#D9D9D3' };
const LABEL = { OK: 'Healthy', SILENT: 'Silent', FAILING: 'Failing', SLOW: 'Slow' };
const STATUSES = ['FAILING', 'SILENT', 'SLOW', 'OK'];

const state = {
  data: null,
  client: 'all',
  status: 'all',
  q: '',
  selected: null,
  apiOnline: true,
  explainCache: new Map(),
  alertTab: 'slack',
  lastCreds: null, // memory only, so Re-scan can repeat a live scan this visit. Never persisted.
  returnFocus: null,
};

// ---------------- data ----------------
async function scan(creds = null) {
  setLoading(true);
  try {
    let payload;
    try {
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds || {}) });
      if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error('offline');
      payload = await r.json();
      if (!r.ok) throw Object.assign(new Error(payload.error || `Scan failed (HTTP ${r.status})`), { user: true });
      state.apiOnline = true;
    } catch (e) {
      if (e.user) throw e;
      if (creds) throw Object.assign(new Error('The scan API is not reachable here. Run with `npx vercel dev` or deploy to Vercel to scan a live instance.'), { user: true });
      state.apiOnline = false;
      const { workflows, summary } = analyze(sampleWorkflows());
      payload = { source: 'demo', instance: '2 sample client instances', generatedAt: new Date().toISOString(), workflows, summary, notes: [] };
    }
    const same = state.data && state.data.source === payload.source && state.data.instance === payload.instance;
    state.data = payload;
    if (!same || !payload.workflows.some((w) => w.client === state.client)) { state.client = 'all'; state.status = 'all'; }
    state.explainCache.clear();
    render();
    return payload;
  } finally {
    setLoading(false);
  }
}

// ---------------- render ----------------
const inClient = () => (state.data?.workflows || []).filter((w) => state.client === 'all' || w.client === state.client);
function visible() {
  const q = state.q.trim().toLowerCase();
  return inClient().filter((w) => (state.status === 'all' || w.health.status === state.status) && (!q || `${w.name} ${w.client}`.toLowerCase().includes(q)));
}

function render() {
  const d = state.data;
  if (!d) return;
  const live = d.source === 'live';
  const sb = $('#sourceBadge');
  sb.textContent = live ? `Live · ${d.instance}` : 'Demo data';
  sb.classList.toggle('is-live', live);
  sb.title = live ? 'Scanned from your n8n instance' : 'Sample data: 10 workflows across 2 fictional clients';
  $('#crumbScope').textContent = state.client === 'all' ? 'All clients' : state.client;
  $('#scannedAt').textContent = `Checked ${timeOnly(d.generatedAt)} · ${d.workflows.length} workflows · ${live ? d.instance : 'demo data'}`;

  const n = $('#notice');
  if (live) {
    n.hidden = false; n.className = 'notice';
    n.innerHTML = `<span>${esc(d.notes.join(' '))}</span><button class="btn btn-sm" id="backToSample" type="button">Back to demo data</button>`;
    $('#backToSample').onclick = () => { state.lastCreds = null; scan().catch(showError); };
  } else if (!state.apiOnline) {
    n.hidden = false; n.className = 'notice';
    n.innerHTML = '<span>Static preview: demo data computed in the browser. Live scans need the serverless API (<code>npx vercel dev</code>).</span>';
  } else n.hidden = true;

  renderNav();
  renderStats();
  renderRows();
}

function renderNav() {
  const all = state.data.workflows;
  const clients = [...new Set(all.map((w) => w.client))];
  const item = (attr, val, label, count, cur, dot = '') =>
    `<li><button type="button" data-${attr}="${esc(val)}" aria-current="${cur}"><span>${dot}${esc(label)}</span><span class="n">${count}</span></button></li>`;
  $('#clientNav').innerHTML = item('client', 'all', 'All clients', all.length, state.client === 'all') +
    clients.map((c) => item('client', c, c, all.filter((w) => w.client === c).length, state.client === c)).join('');
  const scoped = inClient();
  $('#statusNav').innerHTML = item('status', 'all', 'All statuses', scoped.length, state.status === 'all') +
    STATUSES.map((s) => item('status', s, LABEL[s], scoped.filter((w) => w.health.status === s).length, state.status === s, `<span class="dot sd-${s}"></span>`)).join('');
  $('#clientNav').querySelectorAll('button').forEach((b) => (b.onclick = () => setClient(b.dataset.client)));
  $('#statusNav').querySelectorAll('button').forEach((b) => (b.onclick = () => setStatus(b.dataset.status)));
  const sel = $('#clientSelect');
  sel.innerHTML = `<option value="all">All clients</option>` + clients.map((c) => `<option ${state.client === c ? 'selected' : ''} value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.onchange = () => setClient(sel.value);
}

function setClient(c) { state.client = c; state.status = 'all'; render(); }
function setStatus(s) { state.status = state.status === s && s !== 'all' ? 'all' : s; renderNav(); renderStats(); renderRows(); }

function renderStats() {
  const list = inClient();
  const c = { OK: 0, SILENT: 0, FAILING: 0, SLOW: 0 };
  list.forEach((w) => c[w.health.status]++);
  const pct = list.length ? Math.round((c.OK / list.length) * 100) : 100;
  const rates = list.map((w) => w.health.metrics.successRate).filter((x) => x != null);
  const rate = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
  const tile = (s, hint) => `<button class="stat" type="button" data-status="${s}" aria-pressed="${state.status === s}">
      <div class="k"><span class="sd sd-${s}"></span>${LABEL[s]}</div>
      <div class="v">${c[s]}</div><div class="h">${hint}</div></button>`;
  $('#stats').innerHTML = `
    <div class="stat">
      <div class="k">Fleet health</div>
      <div class="v">${c.OK}<small> / ${list.length} healthy</small></div>
      <div class="meter" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="h">${rate != null ? `${rate}% of recent runs succeeded` : 'No runs recorded'}</div>
    </div>
    ${tile('SILENT', 'Stopped without an error')}
    ${tile('FAILING', `${RULES.failStreak}+ errors in a row`)}
    ${tile('SLOW', `Over ${RULES.slowMultiplier}× median duration`)}
    ${tile('OK', 'On cadence')}`;
  $('#stats').querySelectorAll('button.stat').forEach((b) => (b.onclick = () => setStatus(b.dataset.status)));
}

function renderRows() {
  const list = visible();
  $('#wfCount').textContent = list.length === inClient().length ? list.length : `${list.length} of ${inClient().length}`;
  const rows = $('#rows');
  if (!list.length) {
    const none = !state.data.workflows.length;
    rows.innerHTML = `<div class="empty" role="row"><div role="cell">${none ? 'No active workflows found on this instance.' : 'No workflows match these filters.'}${none ? '' : ' <button class="btn btn-sm" type="button" id="clearF">Clear filters</button>'}</div></div>`;
    const cf = $('#clearF');
    if (cf) cf.onclick = () => { state.status = 'all'; state.q = ''; $('#search').value = ''; render(); };
    return;
  }
  rows.innerHTML = list.map((w) => {
    const h = w.health, m = h.metrics;
    return `<div class="tr row" role="row" tabindex="0" data-id="${esc(w.id)}" aria-selected="${state.selected === w.id}" aria-label="${esc(w.name)}, ${LABEL[h.status]}">
      <div class="c-name" role="cell">
        <div class="wf-name">${esc(w.name)}</div>
        <div class="wf-meta">${esc(w.client)}<span class="sep">/</span>${esc(w.schedule?.label || '—')}${m.intervalSource === 'inferred' ? `<span title="Cadence inferred from run gaps">~${fmtMinutes(m.intervalMin)}</span>` : ''}${w.active === false ? '<span class="tag">Inactive</span>' : ''}</div>
      </div>
      <div class="c-status" role="cell"><span class="pill pill-${h.status}" title="${esc(h.reason)}">${LABEL[h.status]}</span></div>
      <div class="c-meta">
        <div role="cell"><span class="m-lbl">Last success </span><span class="tnum">${m.lastSuccessAt ? ago(m.lastSuccessAt) : 'never'}</span><div class="cell-sub c-hide">${m.lastRunAt && m.lastRunAt !== m.lastSuccessAt ? `last run ${ago(m.lastRunAt)}` : '&nbsp;'}</div></div>
        <div role="cell" class="r tnum ${m.failureStreak >= RULES.failStreak ? 'streak-hot' : ''}"><span class="m-lbl">Streak </span>${m.failureStreak}</div>
        <div role="cell" class="r tnum"><span class="m-lbl">Avg </span>${fmtDuration(m.avgDurationMs)}</div>
      </div>
      <div class="c-spark" role="cell">${sparkline(w)}</div>
    </div>`;
  }).join('');
  rows.querySelectorAll('.row').forEach((r) => {
    r.onclick = () => openDrawer(r.dataset.id, r);
    r.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(r.dataset.id, r); }
      if (e.key === 'ArrowDown') { e.preventDefault(); r.nextElementSibling?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); r.previousElementSibling?.focus(); }
    };
  });
}

function skeletonRows() {
  $('#rows').innerHTML = Array.from({ length: 6 }, () => `<div class="tr skel-row" role="row" aria-hidden="true">${'<div><div class="skel"></div></div>'.repeat(6)}</div>`).join('');
}

// Bars = last runs (oldest → newest). Height = duration; grey success, red error, amber slow; dashed = missed run.
function sparkline(w, width = 176, height = 28) {
  const h = w.health, m = h.metrics, N = 24;
  const missed = h.status === 'SILENT' && m.intervalMin && m.sinceSuccessMin ? Math.min(5, Math.floor(m.sinceSuccessMin / m.intervalMin)) : 0;
  const runs = w.executions.slice(0, N - missed).reverse();
  if (!runs.length && !missed) return '<span class="cell-sub">No executions</span>';
  const max = Math.max(...runs.map((r) => r.durationMs || 0), 1);
  const slots = runs.length + missed, gap = 2;
  const bw = Math.max(2, Math.min(5, (width - gap * (slots - 1)) / Math.max(slots, 1)));
  let x = width - (bw + gap) * slots + gap, out = '';
  runs.forEach((r, i) => {
    const bh = Math.max(3, Math.round(((r.durationMs || 0) / max) * (height - 2)));
    const last = i === runs.length - 1;
    const col = r.status === 'success' ? (last && h.status === 'SLOW' ? C.warn : C.ok) : r.status === 'running' || r.status === 'waiting' ? C.idle : C.bad;
    out += `<rect x="${x.toFixed(1)}" y="${height - bh}" width="${bw.toFixed(1)}" height="${bh}" rx="1" fill="${col}"><title>${esc(r.status)} · ${fmtDuration(r.durationMs)} · ${esc(fmtDate(r.startedAt))}</title></rect>`;
    x += bw + gap;
  });
  for (let i = 0; i < missed; i++) {
    out += `<rect x="${(x + 0.5).toFixed(1)}" y="${height - 10.5}" width="${(bw - 1).toFixed(1)}" height="10" rx="1" fill="none" stroke="${C.ink}" stroke-dasharray="2 1.5"><title>Expected run missed</title></rect>`;
    x += bw + gap;
  }
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Last ${runs.length} runs${missed ? `, ${missed} missed` : ''}">${out}</svg>`;
}

// ---------------- drawer ----------------
function openDrawer(id, from) {
  const w = state.data.workflows.find((x) => x.id === id);
  if (!w) return;
  state.selected = id;
  state.returnFocus = from || document.activeElement;
  history.replaceState(null, '', `#wf=${encodeURIComponent(id)}`);
  document.querySelectorAll('.row').forEach((r) => r.setAttribute('aria-selected', r.dataset.id === id));
  const h = w.health, m = h.metrics;
  const extra = h.flags.filter((f) => f !== h.status);
  $('#drawerBody').innerHTML = `
    <div class="d-head">
      <div>
        <span class="pill pill-${h.status}">${LABEL[h.status]}</span>
        ${extra.map((f) => ` <span class="pill pill-${f}">${LABEL[f]}</span>`).join('')}
        <h2 id="dTitle">${esc(w.name)}</h2>
        <div class="d-sub">${esc(w.client)} · <span class="mono">${esc(w.instance)}</span> · ${esc(w.schedule?.label || '—')}${w.active === false ? ' · inactive' : ''}</div>
      </div>
      <button class="icon-btn" id="closeDrawer" type="button" aria-label="Close details"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
    </div>
    <div class="d-reason st-${h.status}">${esc(h.reason)}</div>

    <div class="d-section">
      <div class="metrics">
        ${metric('Last success', m.lastSuccessAt ? ago(m.lastSuccessAt) : 'never')}
        ${metric('Expected every', m.intervalMin ? fmtMinutes(m.intervalMin) + (m.intervalSource === 'inferred' ? ' (inferred)' : '') : 'n/a')}
        ${metric('Silence limit', m.silentLimitMin ? fmtMinutes(m.silentLimitMin) : 'n/a')}
        ${metric('Failure streak', m.failureStreak)}
        ${metric('Median duration', fmtDuration(m.medianDurationMs))}
        ${metric('Success rate', m.successRate != null ? m.successRate + '%' : '—')}
      </div>
    </div>

    <div class="d-section">
      <h3>Timeline</h3>
      <div class="box timeline-box">${timeline(w)}
        <div class="legend">
          <span><i style="background:${C.ink2}"></i>Success</span>
          <span><i style="background:${C.bad}"></i>Error</span>
          ${h.status === 'SILENT' ? `<span><i style="border:1px dashed ${C.ink};background:#fff"></i>Expected, never ran</span><span><i style="background:${C.warn};border-radius:1px;width:2px"></i>Alert threshold</span>` : ''}
          ${h.status === 'SLOW' ? `<span><i style="background:${C.warn}"></i>Slow run</span>` : ''}
        </div>
      </div>
    </div>

    <div class="d-section">
      <h3><span>Incident summary</span><span id="aiConf"></span></h3>
      <div class="box ai" id="aiBox" aria-live="polite" aria-busy="${h.status !== 'OK'}">${h.status === 'OK' ? `<p style="margin:0">Healthy. No incident to summarise.</p><button class="btn btn-sm" type="button" id="explainBtn" style="margin-top:8px">Summarise anyway</button>` : aiSkeleton()}</div>
    </div>

    <div class="d-section">
      <h3><span>Alert preview</span>
        <span class="seg" role="tablist" aria-label="Alert channel">
          <button role="tab" type="button" data-tab="slack" aria-selected="${state.alertTab === 'slack'}">Slack</button>
          <button role="tab" type="button" data-tab="telegram" aria-selected="${state.alertTab === 'telegram'}">Telegram</button>
        </span>
      </h3>
      <div id="alertBox" role="tabpanel"></div>
      <div class="copy-row">
        <span>${h.status === 'OK' ? 'Healthy, so nothing is sent. This is the recovery message.' : 'Sent once per incident, then once when it recovers.'}</span>
        <button class="btn btn-sm" id="copyAlert" type="button">Copy text</button>
      </div>
    </div>

    <div class="d-section">
      <h3><span>Recent executions</span>${w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener" style="font-weight:400;font-size:12px">Open in n8n ↗</a>` : ''}</h3>
      ${runList(w)}
    </div>`;

  $('#closeDrawer').onclick = closeDrawer;
  $('#drawerBody').querySelectorAll('.seg button').forEach((b) => (b.onclick = () => {
    state.alertTab = b.dataset.tab;
    $('#drawerBody').querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-selected', x === b));
    renderAlert(w);
  }));
  $('#copyAlert').onclick = async () => {
    try { await navigator.clipboard.writeText(alertFor(w, state.alertTab)); toast('Alert text copied'); } catch { toast('Clipboard not available'); }
  };
  renderAlert(w);
  if (h.status !== 'OK') explain(w);
  else $('#explainBtn').onclick = () => { $('#aiBox').innerHTML = aiSkeleton(); explain(w); };

  $('#scrim').hidden = false;
  const dr = $('#drawer');
  dr.setAttribute('aria-hidden', 'false');
  dr.scrollTop = 0;
  requestAnimationFrame(() => { dr.classList.add('open'); dr.focus(); });
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  const dr = $('#drawer');
  dr.classList.remove('open');
  dr.setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
  state.selected = null;
  document.querySelectorAll('.row[aria-selected="true"]').forEach((r) => r.setAttribute('aria-selected', 'false'));
  history.replaceState(null, '', location.pathname + location.search);
  state.returnFocus?.focus?.();
}

const metric = (k, v) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
const aiSkeleton = () => '<div class="skeleton" style="width:55%;height:12px"></div><div class="skeleton"></div><div class="skeleton" style="width:85%"></div><div class="skeleton" style="width:70%"></div>';

function timeline(w) {
  const W = Math.round(Math.max(300, Math.min(550, Math.min(600, window.innerWidth) - 74))), H = 112, P = 12, Y = 54;
  const now = Date.parse(state.data.generatedAt) || Date.now();
  const h = w.health, m = h.metrics;
  const runs = w.executions.map((e) => ({ ...e, t: Date.parse(e.startedAt) })).filter((e) => Number.isFinite(e.t));
  const I = m.intervalMin;
  let win = I ? Math.max(I * 10, (m.sinceSuccessMin || 0) + I * 2) : runs.length ? ((now - runs[Math.min(runs.length - 1, 19)].t) / MIN) * 1.08 : 1440;
  const oldest = runs.length ? (now - runs[runs.length - 1].t) / MIN : win;
  win = Math.max(5, Math.min(win, oldest * 1.04 + (I || 0) * 0.5));
  const t0 = now - win * MIN;
  const x = (t) => P + ((t - t0) / (win * MIN)) * (W - 2 * P);
  const F = 'font-family="Geist, sans-serif"';
  let g = `<line x1="${P}" y1="${Y}" x2="${W - P}" y2="${Y}" stroke="${C.line}" stroke-width="1.5"/>`;
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (i / 4) * win * MIN, xx = x(t);
    g += `<line x1="${xx}" y1="${Y + 5}" x2="${xx}" y2="${Y + 9}" stroke="${C.idle}"/>`;
    g += `<text ${F} x="${xx}" y="${Y + 23}" font-size="11" fill="${C.muted}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${i === 4 ? 'now' : shortAgo(now - t)}</text>`;
  }
  if (h.status === 'SILENT' && m.lastSuccessAt) {
    const ls = Date.parse(m.lastSuccessAt), lim = ls + m.silentLimitMin * MIN;
    g += `<rect x="${x(ls)}" y="${Y - 14}" width="${Math.max(0, x(now) - x(ls))}" height="28" rx="4" fill="${C.ink}" opacity="0.05"/>`;
    g += `<line x1="${x(lim)}" y1="${Y - 14}" x2="${x(lim)}" y2="${Y + 27}" stroke="${C.warn}" stroke-width="1.25" stroke-dasharray="3 2"/>`;
    const an = x(lim) > W - P - 60 ? 'end' : x(lim) < P + 60 ? 'start' : 'middle';
    g += `<text ${F} x="${x(lim)}" y="${Y + 40}" font-size="11" fill="${C.warn}" text-anchor="${an}">alert threshold</text>`;
    const missed = [];
    for (let t = ls + I * MIN; t < now && missed.length < 60; t += I * MIN) missed.push(t);
    missed.forEach((t) => (g += `<circle cx="${x(t)}" cy="${Y}" r="4" fill="#fff" stroke="${C.ink}" stroke-width="1" stroke-dasharray="2 1.5"/>`));
    const mid = Math.min(Math.max((x(ls) + x(now)) / 2, P + 80), W - P - 80);
    g += `<text ${F} x="${mid}" y="${Y - 22}" font-size="12" font-weight="500" fill="${C.ink}" text-anchor="middle">silent ${fmtMinutes(m.sinceSuccessMin)} · ${missed.length} missed</text>`;
  }
  if (h.status === 'FAILING') {
    const fails = runs.slice(0, m.failureStreak);
    if (fails.length) {
      const a = x(fails[fails.length - 1].t), b = x(fails[0].t);
      g += `<rect x="${a - 8}" y="${Y - 11}" width="${b - a + 16}" height="22" rx="4" fill="${C.bad}" opacity="0.07"/>`;
      g += `<text ${F} x="${Math.min(Math.max((a + b) / 2, P + 60), W - P - 60)}" y="${Y - 19}" font-size="12" font-weight="500" fill="${C.bad}" text-anchor="middle">${m.failureStreak} errors in a row</text>`;
    }
  }
  runs.filter((r) => r.t >= t0).forEach((r, i) => {
    const slow = i === 0 && h.status === 'SLOW';
    const col = r.status === 'success' ? (slow ? C.warn : C.ink2) : r.status === 'running' || r.status === 'waiting' ? C.idle : C.bad;
    g += `<circle cx="${x(r.t)}" cy="${Y}" r="${slow ? 6 : 4}" fill="${col}" stroke="#fff" stroke-width="1.5"><title>${esc(r.status)} · ${esc(fmtDate(r.startedAt))} · ${fmtDuration(r.durationMs)}</title></circle>`;
    if (slow && m.medianDurationMs) g += `<text ${F} x="${Math.min(x(r.t), W - P)}" y="${Y - 14}" font-size="12" font-weight="500" fill="${C.warn}" text-anchor="end">${(m.lastDurationMs / m.medianDurationMs).toFixed(1)}× slower</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Execution timeline">${g}</svg>`;
}

function runList(w) {
  const h = w.health, m = h.metrics;
  let items = '';
  if (h.status === 'SILENT' && m.lastSuccessAt && m.intervalMin) {
    const ls = Date.parse(m.lastSuccessAt), now = Date.parse(state.data.generatedAt) || Date.now();
    const exp = [];
    for (let t = ls + m.intervalMin * MIN; t < now; t += m.intervalMin * MIN) exp.push(t);
    exp.reverse().slice(0, 3).forEach((t) => {
      items += `<li class="missed"><span class="rd" style="border:1px dashed ${C.ink}"></span><div>Expected run, never started</div><div class="when">${esc(fmtDate(new Date(t).toISOString()))}</div></li>`;
    });
    if (exp.length > 3) items += `<li class="missed"><span></span><div>${exp.length - 3} more missed run${exp.length - 3 > 1 ? 's' : ''}</div><div></div></li>`;
  }
  items += w.executions.slice(0, 15).map((r, i) => {
    const col = r.status === 'success' ? (i === 0 && h.status === 'SLOW' ? C.warn : C.okDot) : r.status === 'running' || r.status === 'waiting' ? C.idle : C.bad;
    return `<li><span class="rd" style="background:${col}"></span><div><span style="font-weight:500">${esc(cap(r.status))}</span> · <span class="tnum">${fmtDuration(r.durationMs)}</span> <span class="cell-sub mono">#${esc(r.id)}</span>${r.error ? `<div class="err">${r.node ? esc(r.node) + ': ' : ''}${esc(r.error)}</div>` : ''}</div><div class="when">${esc(fmtDate(r.startedAt))}</div></li>`;
  }).join('');
  return items ? `<ul class="runs">${items}</ul>` : '<div class="cell-sub">No executions recorded.</div>';
}

// ---------------- incident summary ----------------
async function explain(w) {
  const key = `${w.id}:${w.health.status}`;
  let res = state.explainCache.get(key);
  if (!res) {
    const workflow = {
      name: w.name, client: w.client, status: w.health.status, reason: w.health.reason, active: w.active,
      schedule: w.schedule?.label, hint: w.hint || null, metrics: w.health.metrics,
      recent: w.executions.slice(0, 12).map(({ status, startedAt, durationMs, error, node }) => ({ status, startedAt, durationMs, error, node })),
    };
    try {
      if (!state.apiOnline) throw new Error('offline');
      const r = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      res = await r.json();
    } catch {
      res = { mode: 'demo', ...demoExplain(workflow) };
    }
    state.explainCache.set(key, res);
  }
  if (state.selected !== w.id) return;
  $('#aiConf').innerHTML = `<span class="chip" title="${res.mode === 'live' ? 'Written by Gemini from the run data' : 'Rule-based summary. Set GEMINI_API_KEY for model-written summaries.'}">${res.mode === 'live' ? 'Live' : 'Demo'} · ${esc(res.confidence)} confidence</span>`;
  const box = $('#aiBox');
  box.setAttribute('aria-busy', 'false');
  box.innerHTML = `
    <h4>${esc(res.headline)}</h4>
    <p>${esc(res.summary)}</p>
    <div class="lbl">Likely cause</div><p>${esc(res.likelyCause)}</p>
    ${res.impact ? `<div class="lbl">Business impact</div><p>${esc(res.impact)}</p>` : ''}
    ${res.nextSteps?.length ? `<div class="lbl">Next steps</div><ol>${res.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}`;
}

// ---------------- alert preview (same text as the n8n Code node) ----------------
function alertFor(w, channel) {
  const m = w.health.metrics;
  return alertText({
    channel, status: w.health.status, recovered: w.health.status === 'OK', name: w.name, client: `${w.client} (${w.instance})`,
    reason: w.health.status === 'OK' ? 'Back to healthy' : w.health.reason,
    lastSuccess: m.lastSuccessAt ? fmtDate(m.lastSuccessAt) : 'never', streak: m.failureStreak, url: w.url || '',
  });
}

function renderAlert(w) {
  const text = alertFor(w, state.alertTab);
  const html = esc(text)
    .replace(/\*(.+?)\*/g, '<b>$1</b>')
    .replace(/^&gt; (.*)$/gm, '<span class="q">$1</span>')
    .replace(/&lt;([^|]+?)\|(.+?)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$2</a>');
  const where = state.alertTab === 'slack' ? 'Slack · #client-alerts' : 'Telegram · Flow Health bot';
  $('#alertBox').innerHTML = `<div class="box msg-preview"><div class="msg-top"><span>${where}</span><span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>${html}</div>`;
}

// ---------------- connect form ----------------
function setupConnect() {
  const dlg = $('#connectModal'), form = $('#connectForm'), err = $('#connectError');
  const close = () => { form.apiKey.value = ''; dlg.close(); $('#connectBtn').focus(); };
  $('#connectBtn').onclick = () => { err.hidden = true; dlg.showModal(); setTimeout(() => form.baseUrl.focus(), 30); };
  $('#closeModal').onclick = close;
  dlg.addEventListener('cancel', () => { form.apiKey.value = ''; });
  $('#useSample').onclick = () => { close(); state.lastCreds = null; scan().catch(showError); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const creds = { baseUrl: form.baseUrl.value.trim(), apiKey: form.apiKey.value.trim(), label: form.label.value.trim() };
    form.baseUrl.setAttribute('aria-invalid', !creds.baseUrl);
    form.apiKey.setAttribute('aria-invalid', !creds.apiKey);
    if (!creds.baseUrl || !creds.apiKey) { err.hidden = false; err.textContent = 'Add the base URL and an API key.'; return; }
    const btn = $('#scanSubmit');
    btn.disabled = true; btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Scanning…';
    err.hidden = true;
    try {
      const p = await scan(creds);
      state.lastCreds = creds;
      form.apiKey.value = '';
      dlg.close();
      toast(`Scanned ${p.workflows.length} workflows on ${p.instance}`);
    } catch (ex) {
      err.hidden = false; err.textContent = ex.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Scan workflows';
    }
  });
}

// ---------------- utils ----------------
function setLoading(on) {
  $('#rescanBtn').disabled = on;
  $('#rescanBtn').textContent = on ? 'Scanning…' : 'Re-scan';
  if (on && !state.data) skeletonRows();
}
function showError(e) {
  const n = $('#notice');
  n.hidden = false; n.className = 'notice is-error';
  n.innerHTML = `<span>${esc(e.message || 'Something went wrong.')}</span><button class="btn btn-sm" type="button" id="retryBtn">Retry</button>`;
  $('#retryBtn').onclick = () => scan(state.lastCreds).catch(showError);
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const ago = (iso) => { const min = (Date.now() - Date.parse(iso)) / MIN; return min < 1 ? 'just now' : `${fmtMinutes(min)} ago`; };
function shortAgo(ms) {
  const m = ms / MIN;
  if (m < 60) return `-${Math.round(m)}m`;
  if (m < 2880) return `-${Math.round(m / 60)}h`;
  return `-${Math.round(m / 1440)}d`;
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const timeOnly = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---------------- boot ----------------
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected && !$('#connectModal').open) closeDrawer();
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); $('#search').focus(); }
});
$('#search').addEventListener('input', (e) => { state.q = e.target.value.slice(0, 60); renderRows(); });
$('#rescanBtn').onclick = async () => {
  try { await scan(state.lastCreds); toast('Health re-checked'); } catch (e) { showError(e); }
};
setupConnect();
scan()
  .then(() => {
    const m = /#wf=([^&]+)/.exec(location.hash);
    if (m) openDrawer(decodeURIComponent(m[1]));
  })
  .catch(showError);
