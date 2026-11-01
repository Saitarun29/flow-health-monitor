// Deterministic, rule-based incident write-up used in demo mode (server and browser).
import { fmtMinutes, fmtDuration } from './health.js';

export function demoExplain(wf) {
  const m = wf.metrics;
  const every = m.intervalMin ? fmtMinutes(m.intervalMin) : null;
  const since = m.sinceSuccessMin != null ? fmtMinutes(m.sinceSuccessMin) : null;

  if (wf.status === 'SILENT') {
    const missed = m.intervalMin && m.sinceSuccessMin ? Math.max(1, Math.floor(m.sinceSuccessMin / m.intervalMin)) : null;
    const missedTxt = missed ? `about ${missed} scheduled run${missed > 1 ? 's' : ''}` : 'its scheduled runs';
    if (!wf.active) {
      return {
        headline: `${wf.name} was switched off and stopped running`,
        summary: `"${wf.name}" has not completed a successful run in ${since}. It normally runs every ${every}, so ${missedTxt} have been missed. No errors were raised, which is why nobody noticed.`,
        likelyCause: 'The workflow is deactivated. This usually happens during an edit or import, or when n8n auto-disables a trigger after a credential error.',
        impact: `Downstream data for ${wf.client || 'the client'} is ${since} stale and will stay that way until someone re-activates it.`,
        nextSteps: ['Open the workflow and toggle it back to Active', 'Run it once manually to backfill the missed window', 'Add it to the silence watchlist so a switch-off pages you next time'],
        confidence: 'high',
      };
    }
    return {
      headline: `${wf.name} quietly stopped running ${since} ago`,
      summary: `"${wf.name}" is expected every ${every} but has had no successful run for ${since}, so ${missedTxt} have been missed. There are no error executions in that window. The trigger simply never fired.`,
      likelyCause: 'The trigger is not firing. Common causes: an instance restart or upgrade left the schedule unregistered, the cron or timezone was edited, or a queue-mode worker is down while the main process looks healthy.',
      impact: `Anything that depends on this run (reports, syncs, follow-ups) has been working off ${since}-old data without any visible error.`,
      nextSteps: ['Check the Schedule Trigger settings and the instance timezone (GENERIC_TIMEZONE)', 'Deactivate and re-activate the workflow to re-register the trigger', 'If running queue mode, confirm workers are up and Redis is reachable'],
      confidence: 'medium',
    };
  }

  if (wf.status === 'FAILING') {
    const err = m.lastError || wf.recent.find((r) => r.error)?.error || '';
    const node = m.lastErrorNode ? ` at the "${m.lastErrorNode}" node` : '';
    const c = classifyError(err);
    return {
      headline: `${wf.name} has failed ${m.failureStreak} times in a row`,
      summary: `"${wf.name}" has errored on its last ${m.failureStreak} runs${node}${err ? `, every time with "${err.slice(0, 120)}"` : ''}. ${every ? `At one run every ${every}, that is roughly ${fmtMinutes(m.failureStreak * m.intervalMin)} of failed work.` : ''}`.trim(),
      likelyCause: c.cause,
      impact: c.impact(wf),
      nextSteps: c.steps,
      confidence: err ? 'high' : 'medium',
    };
  }

  if (wf.status === 'SLOW') {
    const ratio = m.lastDurationMs && m.medianDurationMs ? (m.lastDurationMs / m.medianDurationMs).toFixed(1) : '3+';
    return {
      headline: `${wf.name} is running ${ratio}× slower than usual`,
      summary: `The latest run of "${wf.name}" took ${fmtDuration(m.lastDurationMs)} against a typical ${fmtDuration(m.medianDurationMs)} (${ratio}×). It still succeeded, but slow runs usually come before timeouts and overlapping executions.${wf.hint ? ' ' + wf.hint : ''}`,
      likelyCause: 'Most often an upstream API is responding slowly or rate-limiting, or the batch got larger (more records, unpaginated fetch). Less often the instance itself is short on CPU or memory.',
      impact: every && m.lastDurationMs && m.lastDurationMs > m.intervalMin * 60_000 * 0.5
        ? `At this pace runs may start overlapping the ${every} schedule.`
        : 'No data lost yet, but a timeout is the likely next step if it keeps growing.',
      nextSteps: ['Open the slow execution and compare per-node timings with a normal run', 'Add pagination or batching (Split In Batches) to the heavy fetch', 'Set a sensible timeout and retry on the HTTP node'],
      confidence: 'medium',
    };
  }

  return {
    headline: `${wf.name} is healthy`,
    summary: `"${wf.name}" is running ${every ? `on cadence (every ${every})` : 'normally'}, with ${m.successRate ?? '—'}% of recent runs succeeding.${m.failureStreak ? ` It has ${m.failureStreak} error${m.failureStreak > 1 ? 's' : ''} in a row, below the FAILING threshold of 3.` : ''}`,
    likelyCause: m.failureStreak ? `Isolated errors${m.lastError ? ` ("${m.lastError.slice(0, 80)}")` : ''} usually mean a transient upstream issue.` : 'No issue detected.',
    impact: 'None right now.',
    nextSteps: m.failureStreak ? ['Enable Retry On Fail on the erroring node', 'Keep watching: one more error flags it FAILING'] : ['Nothing to do'],
    confidence: 'high',
  };
}

function classifyError(err) {
  const e = err.toLowerCase();
  if (/401|403|unauthori[sz]ed|forbidden|invalid.*(key|token)|revoked|expired/.test(e))
    return {
      cause: 'Authentication is failing. The credential for this service was most likely revoked, rotated or expired, so every run is rejected at the same step.',
      impact: (w) => `Every run since the key broke has done nothing. For "${w.name}" that is lost output (e.g. emails, records) until the credential is fixed.`,
      steps: ['Re-create or reconnect the credential in n8n → Credentials', 'Retry the failed executions from the Executions list', 'Add an Error Trigger workflow so auth failures page you on the first run'],
    };
  if (/429|rate limit|too many requests/.test(e))
    return {
      cause: 'The upstream API is rate-limiting this workflow. Runs are sending more requests than the plan allows in the window.',
      impact: () => 'Work is being dropped or delayed until the rate window resets.',
      steps: ['Add a Wait node or batch requests with Split In Batches', 'Enable Retry On Fail with a back-off', 'Check the API plan limits with the vendor'],
    };
  if (/timeout|timed out|etimedout|503|502|504|unavailable|econnreset|econnrefused|enotfound/.test(e))
    return {
      cause: 'The upstream service is unreachable or overloaded (timeouts / 5xx). This is usually an outage on their side, or a network or DNS change on ours.',
      impact: () => 'Runs fail until the service recovers. Nothing is processed in the meantime.',
      steps: ["Check the vendor's status page", 'Enable Retry On Fail (3 tries, 30 s apart) on the HTTP node', 'Queue failed items so they replay once it recovers'],
    };
  return {
    cause: 'The same step fails on every run, which points to a data or configuration change, such as a renamed field, a changed API response or a missing value, rather than a blip.',
    impact: () => 'Each scheduled run is currently doing no useful work.',
    steps: ['Open the latest failed execution and inspect the input to the failing node', 'Compare it with the last successful execution', 'Add an IF guard for the missing or changed field'],
  };
}
