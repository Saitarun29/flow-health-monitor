// POST /api/explain  { workflow: {...} }  → plain-English incident summary + likely cause.
// GET  /api/explain                        → { aiAvailable } (drives the "Live AI" / "Demo mode" badge)
// Uses Gemini when GEMINI_API_KEY is set; otherwise (or on any failure) a deterministic rule-based write-up.

import { rateLimited, readJson, send } from '../lib/http.js';
import { demoExplain } from '../lib/explain-demo.js';

const MODEL_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

export default async function handler(req, res) {
  if (req.method === 'GET') return send(res, 200, { aiAvailable: !!process.env.GEMINI_API_KEY });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  if (rateLimited(req, 30)) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' });

  let body;
  try {
    body = await readJson(req, 24_000);
  } catch (e) {
    return send(res, e.status || 400, { error: e.status === 413 ? 'Request too large' : 'Invalid JSON body' });
  }
  const wf = sanitize(body?.workflow);
  if (!wf) return send(res, 400, { error: 'Send { workflow } with name, status and metrics.' });

  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      const ai = await callGemini(key, wf);
      return send(res, 200, { mode: 'live', ...ai });
    } catch (e) {
      return send(res, 200, { mode: 'demo', fallbackReason: 'AI call failed, showing rule-based analysis', ...demoExplain(wf) });
    }
  }
  return send(res, 200, { mode: 'demo', ...demoExplain(wf) });
}

// ---------- input hygiene ----------
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v == null ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function sanitize(w) {
  if (!w || typeof w !== 'object') return null;
  const status = str(w.status, 10);
  if (!w.name || !['OK', 'SILENT', 'FAILING', 'SLOW'].includes(status)) return null;
  const m = w.metrics || {};
  return {
    name: str(w.name, 120),
    client: str(w.client, 60),
    status,
    reason: str(w.reason, 240),
    active: w.active !== false,
    schedule: str(w.schedule, 60),
    hint: str(w.hint, 240),
    metrics: {
      intervalMin: num(m.intervalMin),
      intervalSource: str(m.intervalSource, 20),
      sinceSuccessMin: num(m.sinceSuccessMin),
      sinceLastRunMin: num(m.sinceLastRunMin),
      failureStreak: num(m.failureStreak),
      recentErrors: num(m.recentErrors),
      successRate: num(m.successRate),
      medianDurationMs: num(m.medianDurationMs),
      lastDurationMs: num(m.lastDurationMs),
      lastError: str(m.lastError, 300),
      lastErrorNode: str(m.lastErrorNode, 80),
    },
    recent: (Array.isArray(w.recent) ? w.recent : []).slice(0, 12).map((r) => ({
      status: str(r.status, 12),
      startedAt: str(r.startedAt, 30),
      durationMs: num(r.durationMs),
      error: str(r.error, 200),
      node: str(r.node, 80),
    })),
  };
}

// ---------- Gemini ----------
async function callGemini(key, wf) {
  const prompt = `You are an on-call automation engineer reviewing an n8n workflow health incident for a client.
Health rules: SILENT = no successful run within 2x the expected interval (and errors don't explain the gap); FAILING = 3+ consecutive errors; SLOW = latest duration > 3x median; OK = healthy.
Write for a busy business owner: plain English, specific, no fluff, no markdown. Base every claim on the data; say "likely" where you infer.
Return JSON exactly: {"headline": string (max 12 words), "summary": string (2-3 sentences: what is happening and since when), "likelyCause": string (1-2 sentences), "impact": string (1 sentence, what the business is missing), "nextSteps": [3 short imperative strings, n8n-specific], "confidence": "high"|"medium"|"low"}.

Workflow data:
${JSON.stringify(wf)}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(`${MODEL_URL}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 600 },
      }),
    });
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    const j = JSON.parse(text.replace(/^```json\s*|```$/g, ''));
    if (!j.summary || !j.likelyCause) throw new Error('Incomplete AI response');
    return {
      headline: str(j.headline, 120) || `${wf.name}: ${wf.status}`,
      summary: str(j.summary, 700),
      likelyCause: str(j.likelyCause, 500),
      impact: str(j.impact, 300) || '',
      nextSteps: (Array.isArray(j.nextSteps) ? j.nextSteps : []).slice(0, 4).map((s) => str(s, 160)),
      confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'medium',
    };
  } finally {
    clearTimeout(t);
  }
}
