// Flow Health Monitor — shared health engine.
// Used by the browser (demo), /api/scan (live n8n) and mirrored in the n8n Code node.
// Pure functions, no dependencies.

export const RULES = {
  silentMultiplier: 2,   // SILENT: no success within 2x the expected interval
  failStreak: 3,         // FAILING: 3+ consecutive errors (most recent first)
  slowMultiplier: 3,     // SLOW: latest duration > 3x median of earlier successes
  minSlowSamples: 5,     // need at least this many successful runs to judge SLOW
};

export const STATUS_ORDER = { FAILING: 0, SILENT: 1, SLOW: 2, OK: 3 };

const MIN = 60_000;

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function percentile(nums, p) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
}

const ERR = new Set(['error', 'crashed', 'failed']);
const isErr = (s) => ERR.has(String(s || '').toLowerCase());
const isOk = (s) => String(s || '').toLowerCase() === 'success';

/** Human label for minutes, e.g. 15 → "15 min", 1440 → "1 day". */
export function fmtMinutes(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 1) return `${Math.max(1, Math.round(min * 60))} sec`;
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `${+h.toFixed(h < 10 ? 1 : 0)} h`;
  const d = h / 24;
  return `${+d.toFixed(d < 10 ? 1 : 0)} days`;
}

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${+s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${+(s / 60).toFixed(1)} min`;
}

/**
 * Compute health for one workflow.
 * @param {object} wf  { id, name, client, active, schedule:{label, intervalMin, source}, executions:[{id,status,startedAt,stoppedAt,durationMs,error,node}] }
 * @param {number} now epoch ms
 */
export function computeHealth(wf, now = Date.now()) {
  const runs = (wf.executions || [])
    .map((e) => {
      const start = Date.parse(e.startedAt);
      const stop = e.stoppedAt ? Date.parse(e.stoppedAt) : null;
      const durationMs = Number.isFinite(e.durationMs) ? e.durationMs : stop && start ? stop - start : null;
      return { ...e, start, stop, durationMs };
    })
    .filter((e) => Number.isFinite(e.start))
    .sort((a, b) => b.start - a.start); // newest first

  const finished = runs.filter((r) => isOk(r.status) || isErr(r.status));
  const successes = finished.filter((r) => isOk(r.status));
  const lastRun = runs[0] || null;
  const lastSuccess = successes[0] || null;

  // Failure streak: consecutive errors from the newest finished run backwards.
  let failureStreak = 0;
  for (const r of finished) {
    if (isErr(r.status)) failureStreak++;
    else break;
  }

  // Expected interval: from the schedule, else inferred from gaps between runs.
  let intervalMin = wf.schedule?.intervalMin ?? null;
  let intervalSource = wf.schedule?.source || (intervalMin ? 'schedule' : null);
  if (!intervalMin && runs.length >= 4) {
    const gaps = [];
    for (let i = 0; i < runs.length - 1 && i < 40; i++) gaps.push((runs[i].start - runs[i + 1].start) / MIN);
    const p75 = percentile(gaps, 75);
    if (p75 && p75 > 0) {
      intervalMin = Math.max(1, Math.round(p75));
      intervalSource = 'inferred';
    }
  }

  // Durations
  const okDur = successes.map((r) => r.durationMs).filter(Number.isFinite);
  const latestFinished = finished[0] || null;
  const latestDur = latestFinished?.durationMs ?? null;
  const baseline = median(okDur.slice(latestFinished && isOk(latestFinished.status) ? 1 : 0));
  const avgDurationMs = okDur.length ? okDur.reduce((a, b) => a + b, 0) / okDur.length : null;

  const sinceSuccessMin = lastSuccess ? (now - (lastSuccess.stop || lastSuccess.start)) / MIN : null;
  const silentLimitMin = intervalMin ? intervalMin * RULES.silentMultiplier : null;
  const sinceLastRunMin = lastRun ? (now - (lastRun.stop || lastRun.start)) / MIN : null;

  const flags = [];
  const reasons = {};

  if (failureStreak >= RULES.failStreak) {
    flags.push('FAILING');
    const lastErr = finished.find((r) => isErr(r.status));
    reasons.FAILING = `${failureStreak} consecutive errors${lastErr?.error ? ` — "${truncate(lastErr.error, 90)}"` : ''}`;
  }
  if (silentLimitMin) {
    if (sinceSuccessMin == null && runs.length) {
      flags.push('SILENT');
      reasons.SILENT = 'No successful run in recent history';
    } else if (sinceSuccessMin != null && sinceSuccessMin > silentLimitMin && !(failureStreak > 0 && sinceLastRunMin <= silentLimitMin)) {
      // If the gap is covered by recent error runs the flow is not quiet, it is loud: FAILING owns it.
      flags.push('SILENT');
      reasons.SILENT = `No success for ${fmtMinutes(sinceSuccessMin)} (expected every ${fmtMinutes(intervalMin)}, limit ${fmtMinutes(silentLimitMin)})`;
    }
  }
  if (wf.active === false && runs.length && flags.includes('SILENT')) {
    reasons.SILENT += ' · workflow is deactivated';
  }
  if (
    latestDur != null &&
    baseline != null &&
    okDur.length >= RULES.minSlowSamples &&
    latestDur > baseline * RULES.slowMultiplier
  ) {
    flags.push('SLOW');
    reasons.SLOW = `Last run took ${fmtDuration(latestDur)} vs ${fmtDuration(baseline)} median (${(latestDur / baseline).toFixed(1)}×)`;
  }

  const status = flags.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b])[0] || 'OK';
  const recentErrors = finished.slice(0, 20).filter((r) => isErr(r.status)).length;

  return {
    status,
    flags,
    reason: status === 'OK' ? okReason(failureStreak, recentErrors, intervalMin, intervalSource) : reasons[status],
    reasons,
    metrics: {
      intervalMin,
      intervalSource,
      silentLimitMin,
      lastRunAt: lastRun ? new Date(lastRun.start).toISOString() : null,
      lastSuccessAt: lastSuccess ? new Date(lastSuccess.stop || lastSuccess.start).toISOString() : null,
      sinceSuccessMin: sinceSuccessMin != null ? Math.round(sinceSuccessMin) : null,
      sinceLastRunMin: sinceLastRunMin != null ? Math.round(sinceLastRunMin) : null,
      failureStreak,
      recentErrors,
      totalRuns: runs.length,
      successRate: finished.length ? Math.round((successes.length / finished.length) * 100) : null,
      avgDurationMs: avgDurationMs != null ? Math.round(avgDurationMs) : null,
      medianDurationMs: baseline != null ? Math.round(baseline) : null,
      lastDurationMs: latestDur,
      lastError: finished.find((r) => isErr(r.status))?.error || null,
      lastErrorNode: finished.find((r) => isErr(r.status))?.node || null,
    },
  };
}

function okReason(streak, recentErrors, intervalMin, source) {
  if (!intervalMin) return 'Healthy · no schedule detected, silence check skipped';
  if (streak > 0) return `Watch · ${streak} error${streak > 1 ? 's' : ''} in a row, flags FAILING at ${RULES.failStreak}`;
  if (recentErrors) return `Healthy · ${recentErrors} error${recentErrors > 1 ? 's' : ''} in last 20 runs, recovered`;
  return source === 'inferred' ? 'Healthy · event-driven, cadence inferred from runs' : 'Healthy · running on schedule';
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function summarize(workflows) {
  const counts = { OK: 0, SILENT: 0, FAILING: 0, SLOW: 0 };
  for (const w of workflows) counts[w.health.status]++;
  const unhealthy = workflows.length - counts.OK;
  const rates = workflows.map((w) => w.health.metrics.successRate).filter((n) => n != null);
  return {
    total: workflows.length,
    healthy: counts.OK,
    unhealthy,
    counts,
    healthScore: workflows.length ? Math.round((counts.OK / workflows.length) * 100) : 100,
    successRate: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
    clients: [...new Set(workflows.map((w) => w.client).filter(Boolean))],
  };
}

/** Attach health to every workflow and sort worst-first. */
export function analyze(workflows, now = Date.now()) {
  const out = workflows.map((w) => ({ ...w, health: computeHealth(w, now) }));
  out.sort(
    (a, b) =>
      STATUS_ORDER[a.health.status] - STATUS_ORDER[b.health.status] ||
      String(a.client).localeCompare(String(b.client)) ||
      String(a.name).localeCompare(String(b.name))
  );
  return { workflows: out, summary: summarize(out) };
}

// ---------- Schedule parsing for live n8n workflows ----------

const UNIT_MIN = { seconds: 1 / 60, minutes: 1, hours: 60, days: 1440, weeks: 10080, months: 43200 };

/** Estimate an interval (minutes) from a 5/6-field cron expression. Best effort. */
export function cronToMinutes(expr) {
  if (!expr || typeof expr !== 'string') return null;
  let f = expr.trim().split(/\s+/);
  if (f.length === 6) f = f.slice(1); // drop seconds
  if (f.length < 5) return null;
  const [mi, h, dom, , dow] = f;
  const step = (v) => (/^\*\/(\d+)$/.exec(v) || [])[1];
  const count = (v) => (v.includes(',') ? v.split(',').length : 1);
  if (mi === '*') return 1;
  if (step(mi)) return +step(mi);
  if (h === '*') return 60 / count(mi);
  if (step(h)) return (+step(h) * 60) / count(mi);
  const perDay = count(h) * count(mi);
  if (dow !== '*' && dom === '*') return 10080 / (count(dow) * perDay);
  if (dom !== '*') return 43200 / (count(dom) * perDay);
  return 1440 / perDay;
}

/** Read the trigger node of an n8n workflow and return {label, intervalMin, source}. */
export function scheduleFromNodes(nodes = []) {
  for (const n of nodes) {
    const t = String(n.type || '');
    const p = n.parameters || {};
    if (n.disabled) continue;
    if (t.endsWith('.scheduleTrigger')) {
      const rules = p.rule?.interval?.length ? p.rule.interval : [{ field: 'days' }];
      const mins = rules
        .map((r) => {
          const field = r.field || 'days';
          if (field === 'cronExpression') return cronToMinutes(r.expression);
          const key = { seconds: 'secondsInterval', minutes: 'minutesInterval', hours: 'hoursInterval', days: 'daysInterval', weeks: 'weeksInterval', months: 'monthsInterval' }[field];
          const every = Number(r[key] ?? 1) || 1;
          return (UNIT_MIN[field] || 1440) * every;
        })
        .filter(Boolean);
      if (mins.length) {
        const m = Math.min(...mins);
        return { label: `Every ${fmtMinutes(m)}`, intervalMin: m, source: 'schedule' };
      }
    }
    if (t.endsWith('.cron')) {
      const items = p.triggerTimes?.item || [];
      const map = { everyMinute: 1, everyHour: 60, everyDay: 1440, everyWeek: 10080, everyMonth: 43200 };
      const mins = items
        .map((i) => (i.mode === 'everyX' ? (Number(i.value) || 1) * (i.unit === 'hours' ? 60 : 1) : i.mode === 'custom' ? cronToMinutes(i.cronExpression) : map[i.mode]))
        .filter(Boolean);
      if (mins.length) {
        const m = Math.min(...mins);
        return { label: `Every ${fmtMinutes(m)}`, intervalMin: m, source: 'schedule' };
      }
    }
    if (t.endsWith('.interval')) {
      const m = (Number(p.interval) || 1) * (UNIT_MIN[p.unit] || 1 / 60);
      return { label: `Every ${fmtMinutes(m)}`, intervalMin: m, source: 'schedule' };
    }
  }
  const trig = nodes.find((n) => /trigger|webhook/i.test(String(n.type)));
  return { label: trig ? 'Event-driven' : 'Manual / unknown', intervalMin: null, source: null };
}
