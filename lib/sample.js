// Deterministic sample data: 10 workflows across 2 fictional client n8n instances.
// Timestamps are generated relative to "now" so the demo always looks current.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;

export const SAMPLE_INSTANCES = [
  { client: 'Northwind Dental', host: 'n8n.northwind-dental.example' },
  { client: 'Brightcart Commerce', host: 'automations.brightcart.example' },
];

// scenario: ok | silent | failing | slow | flaky
const BLUEPRINTS = [
  { id: 'nwd-101', client: 'Northwind Dental', name: 'Lead intake → HubSpot', label: 'Every 15 min', intervalMin: 15, runs: 40, baseMs: 2400, scenario: 'ok', nodes: 6 },
  { id: 'nwd-102', client: 'Northwind Dental', name: 'Appointment reminders (SMS)', label: 'Every hour', intervalMin: 60, runs: 36, baseMs: 5200, scenario: 'ok', nodes: 8 },
  { id: 'nwd-103', client: 'Northwind Dental', name: 'Nightly patient sync → Sheets', label: 'Daily at 02:00', intervalMin: 1440, runs: 24, baseMs: 48000, scenario: 'silent', silentForMin: 3 * 1440 + 7 * 60, nodes: 11,
    hint: 'Last 3 scheduled runs never started. No error execution was recorded.' },
  { id: 'nwd-104', client: 'Northwind Dental', name: 'Google review requests', label: 'Every 30 min', intervalMin: 30, runs: 40, baseMs: 3100, scenario: 'slow', slowX: 4.6, nodes: 7,
    hint: 'Latest run spent most of its time in the "Fetch completed visits" HTTP node.' },
  { id: 'nwd-105', client: 'Northwind Dental', name: 'Invoices → Xero', label: 'Every hour', intervalMin: 60, runs: 36, baseMs: 6800, scenario: 'flaky', streak: 1, nodes: 9,
    errors: ['Xero API: 429 Too Many Requests'] },
  { id: 'bcc-201', client: 'Brightcart Commerce', name: 'Shopify order → Slack #sales', label: 'Webhook', intervalMin: null, runs: 40, baseMs: 900, scenario: 'webhook', nodes: 4 },
  { id: 'bcc-202', client: 'Brightcart Commerce', name: 'Abandoned cart emails', label: 'Every 30 min', intervalMin: 30, runs: 40, baseMs: 4200, scenario: 'failing', streak: 5, nodes: 10,
    errors: ['401 Unauthorized — Klaviyo API key is invalid or revoked'], errNode: 'Klaviyo: Send campaign' },
  { id: 'bcc-203', client: 'Brightcart Commerce', name: 'Supplier inventory sync', label: 'Every 6 h', intervalMin: 360, runs: 28, baseMs: 92000, scenario: 'silent', silentForMin: 19 * 60, inactive: true, nodes: 14,
    hint: 'Workflow was deactivated 19 h ago. Last execution before that succeeded.' },
  { id: 'bcc-204', client: 'Brightcart Commerce', name: 'AI support ticket triage', label: 'Every 10 min', intervalMin: 10, runs: 40, baseMs: 7400, scenario: 'flaky', streak: 2, nodes: 12,
    errors: ['OpenAI: 503 Service Unavailable', 'OpenAI: request timed out after 60000 ms'], errNode: 'OpenAI: Classify ticket' },
  { id: 'bcc-205', client: 'Brightcart Commerce', name: 'Weekly sales report (PDF)', label: 'Mondays 08:00', intervalMin: 10080, runs: 12, baseMs: 21000, scenario: 'ok', nodes: 9 },
];

export function sampleWorkflows(now = Date.now()) {
  return BLUEPRINTS.map((b, idx) => {
    const r = rng(1000 + idx * 97);
    const inst = SAMPLE_INSTANCES.find((i) => i.client === b.client);
    const execs = [];
    // newest run time
    let t;
    if (b.scenario === 'silent') t = now - b.silentForMin * MIN;
    else if (b.intervalMin) t = now - r() * Math.min(b.intervalMin, 120) * 0.8 * MIN;
    else t = now - (2 + r() * 10) * MIN;

    for (let i = 0; i < b.runs; i++) {
      let status = 'success';
      let dur = b.baseMs * (0.78 + r() * 0.5);
      let error = null;
      let node = null;
      if (b.scenario === 'failing' && i < b.streak) {
        status = 'error';
        dur = 600 + r() * 500;
        error = b.errors[0];
        node = b.errNode;
      } else if (b.scenario === 'flaky' && (i < b.streak || (i > 6 && r() < 0.08))) {
        status = 'error';
        dur = b.baseMs * (0.3 + r() * 0.4);
        error = b.errors[Math.floor(r() * b.errors.length)];
        node = b.errNode || null;
      } else if (b.scenario === 'slow' && i === 0) {
        dur = b.baseMs * b.slowX;
      } else if (i > 3 && r() < 0.03) {
        status = 'error';
        error = 'ETIMEDOUT: upstream request timed out';
        node = 'HTTP Request';
      }
      const start = t;
      execs.push({
        id: `${b.id.split('-')[1]}${String(9000 - i).padStart(4, '0')}`,
        status,
        mode: b.intervalMin ? 'trigger' : 'webhook',
        startedAt: new Date(start).toISOString(),
        stoppedAt: new Date(start + dur).toISOString(),
        durationMs: Math.round(dur),
        error,
        node,
      });
      const gap = b.intervalMin ? b.intervalMin * (0.98 + r() * 0.04) : 6 + r() * 22;
      t -= gap * MIN;
    }

    return {
      id: b.id,
      name: b.name,
      client: b.client,
      instance: inst.host,
      url: `https://${inst.host}/workflow/${b.id}`,
      active: !b.inactive,
      nodeCount: b.nodes,
      schedule: { label: b.label, intervalMin: b.intervalMin, source: b.intervalMin ? 'schedule' : null },
      hint: b.hint || null,
      executions: execs,
    };
  });
}
