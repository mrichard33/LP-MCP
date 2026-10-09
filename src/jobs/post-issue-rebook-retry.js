// ─── Post-issue rebook retry — src/jobs/post-issue-rebook-retry.js ──────────
//
// WHY (Mark, 2026-10-09: "limit depending on a person to need to input a
// lead"). In live mode, src/lp-post-issue-rebook.js refuses an appointment on
// an issued LP lead and sends a new lead instead. When it cannot (an LP read
// failed, LP refused the addLead, a disposition it does not know), the booking
// is still a person's booking, so the system tries again before anyone is
// asked (CLAUDE.md: #contact-center hears only after the system had its chance).
//
// WHAT, every 15 minutes, live mode only:
//   - every lp.post_issue_rebook key whose newest live event is a retryable
//     failure (RETRYABLE), younger than LOOKBACK_H;
//   - fewer than MAX_ATTEMPTS failures and under GIVE_UP_MS since the first →
//     re-drive the booking through the SAME entry point it came from
//     (syncAppointmentToLP for a GHL contact, executeSetLPAppointment for a bare
//     LP lead id), so every guard runs again and a lead that turns out not to
//     be issued gets its normal SetAppointment;
//   - otherwise one #contact-center card (notify, deduped) and a gave_up event.
// A re-drive that ends anywhere but another retryable failure records
// post_issue_retry_resolved, so the key stops.

import { runJob } from '../job-runner.js';
import { postIssueMode } from '../lp-post-issue.js';
import { RETRYABLE, EVENT_TYPE, record, notify } from '../lp-post-issue-rebook.js';

export const JOB_ID = 'post-issue-rebook-retry';
const INTERVAL_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const GIVE_UP_MS = 2 * 3600_000;
const LOOKBACK_H = 6;
const MIN_GAP_MS = 10 * 60 * 1000;
const MAX_PER_PASS = 20;

async function withDefaults(deps = {}) {
  const d = { ...deps };
  d.env ||= process.env;
  d.nowMs ??= Date.now();
  if (!d.supabase) d.supabase = (await import('../supabase.js')).default;
  if (!d.syncAppointmentToLP) d.syncAppointmentToLP = (await import('../lp-appointment-sync.js')).syncAppointmentToLP;
  if (!d.executeSetLPAppointment) d.executeSetLPAppointment = (await import('../actions/handlers/lp-appointment.js')).executeSetLPAppointment;
  if (!d.emitEvent) d.emitEvent = (await import('../event-emitter.js')).emitEvent;
  if (!d.postToSlack || !d.filterNew) {
    const [slack, posted, alerts] = await Promise.all([import('../slack.js'), import('../alert-posted.js'), import('../alert-state.js')]);
    d.postToSlack ||= slack.postToSlack;
    d.opsChannelId ||= slack.opsChannelId;
    d.filterNew ||= posted.filterNew;
    d.recordPosted ||= posted.recordPosted;
    d.sendAlertMessage ||= alerts.sendAlertMessage;
  }
  return d;
}

/** Group live events by key, oldest first. Pure. */
export function pendingRetries(rows, nowMs) {
  const byKey = new Map();
  for (const row of rows || []) {
    const p = row?.payload;
    if (!p?.idempotency_key || p.mode !== 'live') continue;
    if (!byKey.has(p.idempotency_key)) byKey.set(p.idempotency_key, []);
    byKey.get(p.idempotency_key).push({ ...p, at: Date.parse(row.created_at) });
  }
  const out = [];
  for (const [key, evs] of byKey) {
    evs.sort((a, b) => a.at - b.at);
    const last = evs.at(-1);
    if (!RETRYABLE.has(last.outcome) || last.gave_up) continue;
    const failures = evs.filter((e) => RETRYABLE.has(e.outcome));
    const firstAt = failures[0].at;
    const giveUp = failures.length >= MAX_ATTEMPTS || nowMs - firstAt >= GIVE_UP_MS;
    if (!giveUp && nowMs - last.at < MIN_GAP_MS) continue;
    out.push({ key, last, attempts: failures.length, giveUp });
  }
  return out;
}

/** One pass. Never throws for a single key; returns counts for job_runs. */
export async function runPostIssueRetryPass(deps = {}) {
  const d = await withDefaults(deps);
  if (postIssueMode(d.env) !== 'live') return { ok: true, skipped: 'not_live' };
  const since = new Date(d.nowMs - LOOKBACK_H * 3600_000).toISOString();
  const { data, error } = await d.supabase.from('system_events')
    .select('payload, created_at').eq('event_type', EVENT_TYPE).gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) return { ok: false, errors: [`events read: ${error.message}`] };

  const todo = pendingRetries(data, d.nowMs).slice(0, MAX_PER_PASS);
  const counts = { retried: 0, resolved: 0, still_failing: 0, gave_up: 0, errors: 0 };
  const errors = [];
  for (const item of todo) {
    const p = item.last;
    try {
      if (item.giveUp) {
        const r = { ...p, gave_up: true, attempts: item.attempts };
        delete r.at;
        await record(r, d);
        await notify(r, d);
        counts.gave_up += 1;
        continue;
      }
      counts.retried += 1;
      const res = p.ghl_contact
        ? await d.syncAppointmentToLP({
          contactId: p.contact_id, appointmentDate: p.appt_date, appointmentTime: p.appt_time,
          contactName: p.contact_name || undefined, contactPhone: p.phone || undefined,
        })
        : await d.executeSetLPAppointment({
          id: null, event_id: null, action_type: 'set_lp_appointment', target_id: p.issued_lead_id,
          rule_applied: 'POST_ISSUE_RETRY', action_payload: { appt_date: p.appt_date, appt_time: p.appt_time },
        });
      if (RETRYABLE.has(res?.action)) {
        counts.still_failing += 1;
      } else {
        counts.resolved += 1;
        const r = { ...p, outcome: 'post_issue_retry_resolved', resolved_by: res?.action || 'unknown' };
        delete r.at;
        await record(r, d);
      }
    } catch (err) {
      counts.errors += 1;
      errors.push(`${item.key}: ${err.message}`);
    }
  }
  if (todo.length) console.log(`[PostIssueRetry] ${JSON.stringify(counts)}`);
  return { ok: errors.length === 0, ...counts, errors };
}

let timer = null;
let running = false;

export function startPostIssueRetryScheduler(env = process.env) {
  if (timer) return timer;
  if (postIssueMode(env) !== 'live') {
    console.log('[PostIssueRetry] scheduler not started (LP_POST_ISSUE_NEW_LEAD_MODE is not live)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runJob(JOB_ID, () => runPostIssueRetryPass());
    } catch (err) {
      console.error(`[PostIssueRetry] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[PostIssueRetry] scheduler started — every 15m');
  return timer;
}

export function stopPostIssueRetryScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
