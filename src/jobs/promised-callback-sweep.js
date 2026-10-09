/**
 * Promised-callback sweep — src/jobs/promised-callback-sweep.js
 *
 * 2026-10-07 (Mark's handoff; McKoy, rRPO34Ooq0QmtSfXyqSw). Every 15 minutes
 * while the team is in, each OPEN promised_callbacks row (sql/150) is checked:
 *
 *   KEPT     a Five9 call to the phone after promised_at (five9_events_raw is
 *            the only source of truth for a call, never LP call logs), or a
 *            rep's outbound text/email in GHL that is not one of ours.
 *   EXPIRED  past due_at (next business day 12:00 ET) and not kept: one
 *            #contact-center card (postToSlack, deduped in audit_posted_items),
 *            needs-rep-review on the contact. Never texts the lead.
 *   neither  left open. A read that failed is "could not tell": nothing changes.
 *
 * PROMISED_CALLBACK_MODE: off stops the job; shadow updates the rows and posts
 * and tags nothing; live does all of it. Recorded in job_runs (runJob).
 *
 * deps (all optional, for tests): { supabase, fetchRecentMessages, postToSlack, filterNew,
 *   recordPosted, addTag, env, now, log, warn }
 */

import { runJob } from '../job-runner.js';
import { isTeamOpen } from '../agentic/team-hours.js';
import {
  promisedCallbackMode, keptVerdict, sweepDecision, formatExpiredCard, NEEDS_REVIEW_TAG,
} from '../agentic/promised-callbacks.js';

export const JOB_ID = 'promised-callback-sweep';
const INTERVAL_MS = 15 * 60 * 1000;
const BATCH = 100;
const AUDIT_EXPIRED = 'promised_call_expired';

async function withDefaults(deps) {
  const d = { ...deps };
  d.env ||= process.env;
  d.now ||= Date.now;
  d.log ||= console.log;
  d.warn ||= console.warn;
  if (!d.supabase) d.supabase = (await import('../supabase.js')).default;
  if (!d.fetchRecentMessages) d.fetchRecentMessages = (await import('../agentic/reply-sender.js')).fetchRecentMessages;
  if (!d.postToSlack) d.postToSlack = (await import('../slack.js')).postToSlack;
  if (!d.filterNew || !d.recordPosted) {
    const ap = await import('../alert-posted.js');
    d.filterNew ||= ap.filterNew;
    d.recordPosted ||= ap.recordPosted;
  }
  if (!d.addTag) {
    const { executeAddTag } = await import('../actions/handlers/tags.js');
    d.addTag = (contactId, tag) => executeAddTag({ target_id: contactId, action_payload: { tag }, rule_applied: 'PROMISED_CALLBACK_EXPIRED' });
  }
  return d;
}

async function readFive9Calls(d, phone, sinceIso) {
  if (!phone) return [];
  const { data, error } = await d.supabase.from('five9_events_raw')
    .select('dnis, call_start_at, received_at, campaign, disposition_name, agent_name')
    .eq('dnis', phone)
    .gte('received_at', sinceIso)
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

async function readGhlMessages(d, contactId) {
  const { messages } = await d.fetchRecentMessages(contactId);
  return Array.isArray(messages) ? messages : [];
}

/**
 * What WE sent this contact around the promise: GHL message ids and the text.
 * 2026-10-09: ids alone are not enough. A bot email reached GHL under a
 * different id than the one the send recorded (kOrbvKKQD6e8D5tptOuX, 10-07),
 * so the sweep read our own email as a rep's and marked the promise kept.
 */
async function readBotSends(d, contactId, sinceIso) {
  const { data, error } = await d.supabase.from('agent_actions')
    .select('execution_result')
    .eq('target_id', contactId)
    .eq('action_type', 'send_message')
    .gte('created_at', new Date(Date.parse(sinceIso) - 3600000).toISOString())
    .limit(200);
  if (error) throw new Error(error.message);
  const ids = new Set();
  const bodies = [];
  for (const r of data || []) {
    for (const k of ['message_id', 'email_message_id']) {
      const v = r?.execution_result?.[k];
      if (v) ids.add(String(v));
    }
    const body = r?.execution_result?.sent_body;
    if (body) bodies.push(String(body));
  }
  return { ids, bodies };
}

/** One pass. Returns a summary for job_runs. */
export async function runPromisedCallbackSweep(deps = {}) {
  const d = await withDefaults(deps);
  const mode = promisedCallbackMode(d.env);
  const nowMs = d.now();
  if (mode === 'off') return { ok: true, skipped: true, reason: 'off', mode };
  if (!isTeamOpen(nowMs)) return { ok: true, skipped: true, reason: 'team_closed', mode };

  const { data: rows, error } = await d.supabase.from('promised_callbacks')
    .select('*').eq('status', 'open').order('promised_at', { ascending: true }).limit(BATCH);
  if (error) {
    // sql/150 not applied yet reads the same as any failed read: nothing to do, say so.
    return { ok: false, mode, errors: [`promised_callbacks unreadable: ${error.message}`] };
  }

  const summary = { ok: true, mode, checked: 0, kept: 0, expired: 0, open: 0, could_not_tell: 0, cards: 0, errors: [] };
  for (const promise of rows || []) {
    summary.checked += 1;
    let five9Calls = null;
    let ghlMessages = null;
    let botSends = { ids: new Set(), bodies: [] };
    try { five9Calls = await readFive9Calls(d, promise.phone10, new Date(Date.parse(promise.promised_at) - 60000).toISOString()); } catch (err) { summary.errors.push(`five9 ${promise.id}: ${err.message}`); }
    try {
      ghlMessages = await readGhlMessages(d, promise.ghl_contact_id);
      botSends = await readBotSends(d, promise.ghl_contact_id, promise.promised_at);
    } catch (err) {
      ghlMessages = null;
      summary.errors.push(`ghl ${promise.id}: ${err.message}`);
    }
    const verdict = keptVerdict({ promise, five9Calls, ghlMessages, botMessageIds: botSends.ids, botBodies: botSends.bodies });
    const decision = sweepDecision({ promise, verdict, nowMs });
    const stamp = new Date(nowMs).toISOString();

    if (decision.action === 'kept') {
      await d.supabase.from('promised_callbacks')
        .update({ status: 'kept', kept_evidence: decision.evidence, kept_at: decision.evidence?.at || stamp, updated_at: stamp })
        .eq('id', promise.id).eq('status', 'open');
      summary.kept += 1;
      d.log(`[PromisedCallbackSweep] #${promise.id} ${promise.ghl_contact_id} kept (${decision.evidence?.source})`);
      continue;
    }
    if (decision.action === 'expired') {
      if (mode === 'live') {
        const channel = String(d.env.SLACK_CHANNEL_SERVICE || '').trim();
        const item = { key: promise.ghl_contact_id, reason: `promise:${promise.id}` };
        try {
          const { fresh } = await d.filterNew({ audit: AUDIT_EXPIRED, items: [item], ttlDays: 60, nowMs });
          if (fresh.length) {
            const res = channel
              ? await d.postToSlack(formatExpiredCard({ promise, locationId: d.env.GHL_LOCATION_ID || null }), channel)
              : { ok: false, error: 'SLACK_CHANNEL_SERVICE unset' };
            if (res?.ok) { await d.recordPosted({ audit: AUDIT_EXPIRED, items: [item], nowMs }); summary.cards += 1; }
            else summary.errors.push(`card ${promise.id}: ${res?.error || 'unknown'}`);
          }
        } catch (err) {
          summary.errors.push(`card ${promise.id}: ${err.message}`);
        }
        try { await d.addTag(promise.ghl_contact_id, NEEDS_REVIEW_TAG); } catch (err) { summary.errors.push(`tag ${promise.id}: ${err.message}`); }
      }
      await d.supabase.from('promised_callbacks')
        .update({ status: 'expired', expired_at: stamp, updated_at: stamp })
        .eq('id', promise.id).eq('status', 'open');
      summary.expired += 1;
      d.log(`[PromisedCallbackSweep] #${promise.id} ${promise.ghl_contact_id} expired (${mode})`);
      continue;
    }
    if (decision.reason === 'could_not_tell') summary.could_not_tell += 1;
    else summary.open += 1;
  }
  summary.ok = summary.errors.length === 0;
  return summary;
}

let timer = null;
let running = false;

export async function runPromisedCallbackTick() {
  const { value: res } = await runJob(JOB_ID, () => runPromisedCallbackSweep());
  if (res && res.ok === false) console.warn(`[PromisedCallbackSweep] pass finished with errors: ${(res.errors || []).slice(0, 5).join('; ')}`);
  else if (res && !res.skipped && (res.kept || res.expired)) console.log(`[PromisedCallbackSweep] ${res.mode}: ${res.kept} kept, ${res.expired} expired, ${res.open} still open`);
}

export function startPromisedCallbackScheduler(env = process.env) {
  if (timer) return timer;
  if (promisedCallbackMode(env) === 'off') {
    console.log('[PromisedCallbackSweep] scheduler not started (PROMISED_CALLBACK_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPromisedCallbackTick();
    } catch (err) {
      console.error(`[PromisedCallbackSweep] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[PromisedCallbackSweep] scheduler started — ${promisedCallbackMode(env)}, every 15m in team hours`);
  return timer;
}

export function stopPromisedCallbackScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
