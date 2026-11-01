// POST /api/scan
// Body: { baseUrl?, apiKey?, label? }
// With credentials: proxies the n8n public API (GET /api/v1/workflows + /api/v1/executions),
// computes health and returns it. The API key is used for this request only and is never stored or logged.
// Without credentials: returns the built-in sample data (source: "demo").

import { analyze, scheduleFromNodes } from '../lib/health.js';
import { sampleWorkflows } from '../lib/sample.js';
import { rateLimited, readJson, send } from '../lib/http.js';

const TIMEOUT_MS = 8000;
const MAX_WORKFLOWS = 150;
const EXEC_PAGES = 4;       // up to 1,000 recent executions in one sweep
const PER_WF_TOPUP = 25;    // extra per-workflow calls for quiet flows
const ERROR_DETAIL = 8;     // fetch error message for up to N failing flows
const KEEP_EXECS = 40;

export default async function handler(req, res) {
  if (req.method === 'GET') return send(res, 200, demoPayload());
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  if (rateLimited(req, 20)) return send(res, 429, { error: 'Too many scans. Wait a minute and try again.' });

  let body;
  try {
    body = await readJson(req, 4000);
  } catch (e) {
    return send(res, e.status || 400, { error: e.status === 413 ? 'Request too large' : 'Invalid JSON body' });
  }

  const baseUrlIn = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';

  if (!baseUrlIn && !apiKey) return send(res, 200, demoPayload());
  if (!baseUrlIn || !apiKey) return send(res, 400, { error: 'Both the n8n base URL and an API key are needed for a live scan.' });
  if (baseUrlIn.length > 300 || apiKey.length > 600) return send(res, 400, { error: 'Base URL or API key is too long.' });

  let base;
  try {
    base = normalizeBase(baseUrlIn);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }

  const started = Date.now();
  try {
    const client = label || base.hostname;
    const headers = { 'X-N8N-API-KEY': apiKey, Accept: 'application/json' };
    const api = (path) => getJson(`${base.origin}${base.prefix}/api/v1${path}`, headers);

    // 1) Workflows (with nodes, so we can read the schedule trigger)
    const workflows = [];
    let cursor = null;
    for (let page = 0; page < 2; page++) {
      const q = new URLSearchParams({ limit: '250' });
      if (cursor) q.set('cursor', cursor);
      const r = await api(`/workflows?${q}`);
      workflows.push(...(r.data || []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }

    // 2) Recent executions, one sweep
    const execs = [];
    cursor = null;
    for (let page = 0; page < EXEC_PAGES; page++) {
      const q = new URLSearchParams({ limit: '250' });
      if (cursor) q.set('cursor', cursor);
      const r = await api(`/executions?${q}`);
      execs.push(...(r.data || []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    const byWf = new Map();
    for (const e of execs) {
      const k = String(e.workflowId);
      if (!byWf.has(k)) byWf.set(k, []);
      byWf.get(k).push(e);
    }

    // Keep active workflows + inactive ones that ran recently (likely switched off by accident)
    const weekAgo = Date.now() - 7 * 86400_000;
    const chosen = workflows
      .filter((w) => w.active || (byWf.get(String(w.id)) || []).some((e) => Date.parse(e.startedAt) > weekAgo))
      .slice(0, MAX_WORKFLOWS);
    const skipped = workflows.length - chosen.length;

    // 3) Top up quiet workflows that the global sweep barely covered
    const thin = chosen.filter((w) => (byWf.get(String(w.id)) || []).length < 6).slice(0, PER_WF_TOPUP);
    await pool(thin, 6, async (w) => {
      try {
        const r = await api(`/executions?${new URLSearchParams({ workflowId: String(w.id), limit: '30' })}`);
        const seen = new Set((byWf.get(String(w.id)) || []).map((e) => String(e.id)));
        const merged = [...(byWf.get(String(w.id)) || []), ...(r.data || []).filter((e) => !seen.has(String(e.id)))];
        byWf.set(String(w.id), merged);
      } catch { /* keep what we have */ }
    });

    const normalized = chosen.map((w) => {
      const runs = (byWf.get(String(w.id)) || [])
        .map(normExec)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, KEEP_EXECS);
      return {
        id: String(w.id),
        name: String(w.name || `Workflow ${w.id}`).slice(0, 120),
        client,
        instance: base.hostname,
        url: `${base.origin}${base.prefix}/workflow/${w.id}`,
        active: !!w.active,
        nodeCount: Array.isArray(w.nodes) ? w.nodes.length : null,
        schedule: scheduleFromNodes(w.nodes || []),
        tags: (w.tags || []).map((t) => t.name).filter(Boolean).slice(0, 5),
        executions: runs,
      };
    });

    // 4) Error messages for flows whose latest finished run failed
    const failing = normalized
      .map((w) => ({ w, e: w.executions.find((x) => x.status !== 'running' && x.status !== 'waiting') }))
      .filter(({ e }) => e && (e.status === 'error' || e.status === 'crashed'))
      .slice(0, ERROR_DETAIL);
    await pool(failing, 4, async ({ e }) => {
      try {
        const d = await api(`/executions/${encodeURIComponent(e.id)}?includeData=true`);
        const rd = d?.data?.resultData || {};
        e.error = String(rd.error?.message || rd.error?.description || '').slice(0, 300) || null;
        e.node = rd.lastNodeExecuted || rd.error?.node?.name || null;
      } catch { /* optional detail */ }
    });

    const { workflows: out, summary } = analyze(normalized);
    return send(res, 200, {
      source: 'live',
      instance: base.hostname,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      notes: [
        `Read ${workflows.length} workflows and ${execs.length} recent executions.`,
        skipped > 0 ? `${skipped} inactive workflow(s) with no runs in 7 days were skipped.` : null,
        'Your API key was used for this scan only. It was not stored or logged.',
      ].filter(Boolean),
      workflows: out,
      summary,
    });
  } catch (e) {
    const status = e.status === 401 || e.status === 403 ? 401 : 502;
    return send(res, status, { error: friendlyError(e, base) });
  }
}

function demoPayload() {
  const { workflows, summary } = analyze(sampleWorkflows());
  return {
    source: 'demo',
    instance: '2 sample client instances',
    generatedAt: new Date().toISOString(),
    notes: ['Sample data: 10 workflows across 2 fictional client instances.'],
    workflows,
    summary,
  };
}

function normExec(e) {
  let status = e.status;
  if (!status) status = e.finished ? 'success' : e.stoppedAt ? 'error' : 'running';
  if (status === 'failed') status = 'error';
  const start = Date.parse(e.startedAt);
  const stop = e.stoppedAt ? Date.parse(e.stoppedAt) : null;
  return {
    id: String(e.id),
    status,
    mode: e.mode || null,
    startedAt: e.startedAt,
    stoppedAt: e.stoppedAt || null,
    durationMs: stop && start ? stop - start : null,
    error: null,
    node: null,
  };
}

function normalizeBase(input) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('That does not look like a valid URL, e.g. https://n8n.yourdomain.com');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported.');
  const h = u.hostname.toLowerCase();
  const privateHost =
    h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0' || h === '[::1]' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^\[?(fc|fd|fe80)/i.test(h);
  // ALLOW_PRIVATE_HOSTS=1 lets `vercel dev` scan a local n8n (e.g. http://localhost:5678). Never set it in production.
  if (privateHost && process.env.ALLOW_PRIVATE_HOSTS !== '1') throw new Error('Private or local addresses cannot be scanned from the cloud. Use your public n8n URL.');
  const prefix = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '').replace(/\/(home|workflows?|signin).*$/, '');
  return { origin: u.origin, hostname: u.hostname, prefix };
}

async function getJson(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body: text.slice(0, 200) });
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Response was not JSON'), { status: 502, notJson: true });
    }
  } finally {
    clearTimeout(t);
  }
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

function friendlyError(e, base) {
  if (e.name === 'AbortError') return `Timed out reaching ${base.hostname}. Check the URL and that the instance is public.`;
  if (e.status === 401 || e.status === 403) return 'n8n rejected the API key (401). Create one in Settings → n8n API and paste it again.';
  if (e.status === 404) return `No n8n public API found at ${base.hostname}/api/v1. Check the base URL, and that the public API is enabled.`;
  if (e.notJson) return `${base.hostname} answered, but not with n8n API JSON. Is this the right base URL?`;
  if (e.status) return `n8n returned HTTP ${e.status}.`;
  return `Could not reach ${base.hostname}. ${e.cause?.code ? `(${e.cause.code})` : ''}`.trim();
}
