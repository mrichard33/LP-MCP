/**
 * Run one automatic DNC lift — src/consent/dnc-auto-lift-run.js
 *
 * 2026-10-18 (Mark). With DNC_LIFT_APPROVAL_MODE=auto, request_dnc_lift_review
 * (./dnc-lift-review.js) no longer posts the Approve / Keep Blocked card for a
 * contact that is not canvassing and has no fresh opt-out
 * (./dnc-auto-lift.js decideAutoLift). It calls this instead, which does what
 * an Approve click does, with a system actor:
 *
 *   1. dnc_lift_requests row, decision approve, status processing. The
 *      request_id is still the idempotency key: a request_id already on file
 *      runs nothing and posts nothing a second time.
 *   2. buildLiftBatch({ auto: true }) — the SAME batch the Slack route builds
 *      (never a copy), so a carrier STOP still keeps SMS/RCS DND and dnc-sms.
 *      Queued with retry_at ROUTE_HOLD_MS out, like the route's.
 *   3. the Five9 row approved through approve_action as AUTO_DNC_LIFT_APPROVER;
 *      admin-writes.js accepts that only for AUTO_DNC_LIFT while the mode is
 *      still auto.
 *   4. runActionsNow IN THE BACKGROUND (runLimited, MAX_PARALLEL_LIFTS at a
 *      time, trackBackground so a deploy drains it). The action itself returns
 *      as soon as 1-3 are written: a batch has taken 2+ minutes under load
 *      (2026-10-02), past the executor's 60s handler watchdog, and a running
 *      handler holds the whole executor pass while it waits.
 *   5. finishAutoLift: the result on the request row (approved / failed) and
 *      ONE notice in #dnc-lift-approval (SLACK_CHANNEL_DNC_LIFT) through
 *      postToSlack: no buttons, nothing to click. A failed step is said in the
 *      notice AND gets one #ops-alerts line (sendAlertMessage). A notice that
 *      could not post is an #ops-alerts line too: a silent Slack failure looks
 *      exactly like a quiet day (CLAUDE.md).
 *
 * If the process dies between 4 and 5, the held rows run from the queue after
 * ROUTE_HOLD_MS and sweepStaleAutoLifts (inside the dnc-lift-report sweep, every
 * 5 min) finishes the request from its agent_actions rows.
 */

import supabase from '../supabase.js';
import { approveAgentAction } from '../actions/approve-action.js';
import { postToSlack } from '../slack.js';
import { trackBackground } from '../graceful-shutdown.js';
import { blockingTags } from './consent-store.js';
import { buildLiftBatch, lpClearOutcome, defaultInsertActions, runLimited, ROUTE_HOLD_MS } from './dnc-lift-decision.js';
import { systemRollup, resultsFromRows } from './dnc-lift-report.js';
import { lpManualClearRequired } from './dnc-lift-review.js';
import { AUTO_DNC_LIFT_APPROVER, formatAutoLiftNotice } from './dnc-auto-lift.js';

export const REPORT_MODE_AUTO = 'auto';
export const SMS_STOP_NOTICE = 'Texts stay OFF: the lead texted STOP. They reopen only when the lead texts START or submits a new form with SMS consent.';
// A request still `processing` this long after it started was cut off.
export const STALE_AFTER_MS = ROUTE_HOLD_MS + 5 * 60 * 1000;
// Past this, report the steps as they stand, even if one is still retrying.
export const FINAL_AFTER_MS = 2 * 60 * 60 * 1000;
const ACTIVE = new Set(['pending', 'executing', 'pending_approval']);

async function defaultFallbackChannel(db) {
  // The channel the cards already post in, when the variable is unset.
  const { data } = await db.from('dnc_lift_requests').select('batch_result')
    .not('batch_result->>slack_channel', 'is', null)
    .order('decided_at', { ascending: false }).limit(1);
  return (data || [])[0]?.batch_result?.slack_channel || null;
}

async function defaultSendAlert(text) {
  const { sendAlertMessage } = await import('../alert-state.js');
  return sendAlertMessage(text, { channel: 'ops' });
}

const defaultRunInBackground = (fn) => {
  trackBackground(runLimited(fn).catch((err) => console.error(`[DncAutoLift] background lift threw: ${err.message}`)));
};

/**
 * Start one lift. Writes the request and the batch, then runs the batch in the
 * background. Throws only before the request row exists (nothing lifted yet,
 * so the executor's retry is safe).
 *
 * @param {object} p
 *   requestId, contactId, contact (live GHL read), carrier (detectCarrierStop),
 *   payload (buildReviewPayload's answer: name, phone, source, prospect, url)
 */
export async function runAutoLift({ requestId, contactId, contact, carrier, payload }, deps = {}) {
  const env = deps.env || process.env;
  const db = deps.supabase || supabase;
  const now = deps.now ? deps.now() : Date.now();

  // ── the idempotency record ──
  const found = await db.from('dnc_lift_requests').select('request_id, status').eq('request_id', requestId).maybeSingle();
  if (found.error) throw new Error(`auto DNC lift: request lookup failed: ${found.error.message}`);
  if (found.data) {
    console.log(`[DncAutoLift] ${requestId} already ran (${found.data.status}) — nothing done twice`);
    return { action: 'auto_lift_already_ran', request_id: requestId, status: found.data.status };
  }
  const ins = await db.from('dnc_lift_requests').insert({
    request_id: requestId,
    ghl_contact_id: contactId,
    status: 'processing',
    decision: 'approve',
    decided_at: new Date(now).toISOString(),
    review_payload: { ...payload, auto_lift: true },
    batch_result: { report_mode: REPORT_MODE_AUTO, sms_carrier_stop: carrier.carrierStop, carrier_stop_basis: carrier.basis },
  });
  if (ins.error) {
    if (ins.error.code === '23505') return { action: 'auto_lift_already_ran', request_id: requestId };
    throw new Error(`auto DNC lift: could not record request: ${ins.error.message}`);
  }

  let inserted;
  try {
    const rows = buildLiftBatch({
      contactId, requestId, auto: true,
      carrierStop: carrier.carrierStop, carrierBasis: carrier.basis,
      blocking: blockingTags(contact?.tags || []),
      lpClear: !lpManualClearRequired(env),
    });
    inserted = await (deps.insertActions || defaultInsertActions)(rows, db, new Date(now + ROUTE_HOLD_MS).toISOString());
    const five9Row = inserted.find((r) => r.action_type === 'five9_remove_numbers_from_dnc_approved');
    if (five9Row) {
      const appr = await (deps.approveAction || approveAgentAction)(
        { actionId: five9Row.id, decision: 'approve', approvedBy: AUTO_DNC_LIFT_APPROVER }, { supabase: db });
      if (!appr.ok) console.warn(`[DncAutoLift] approve_action failed for five9 row ${five9Row.id}: ${appr.error || 'not found'}`);
    }
  } catch (err) {
    // The request exists, so this is reported, never retried into a second lift.
    await finishAutoLift({ requestId, contactId, payload, carrier, results: [], error: err.message }, deps);
    return { action: 'auto_lift_failed', request_id: requestId, status: 'failed', error: err.message };
  }

  const work = async () => {
    let results = [];
    let error = null;
    try {
      const runNow = deps.runActionsNow || (await import('../actions/index.js')).runActionsNow;
      results = await runNow(inserted.map((r) => r.id));
    } catch (err) {
      error = err.message;
    }
    return finishAutoLift({ requestId, contactId, payload, carrier, results, error }, deps);
  };
  (deps.runInBackground || defaultRunInBackground)(work);
  console.log(`[DncAutoLift] ${contactId} → lift started (request ${requestId}, ${inserted.length} steps, carrier_stop=${carrier.carrierStop})`);
  return { action: 'auto_lift_started', request_id: requestId, status: 'processing', sms_carrier_stop: carrier.carrierStop, steps: inserted.length };
}

/**
 * The end of a lift: status on the request row, the notice, the ops line.
 * Never throws.
 */
export async function finishAutoLift({ requestId, contactId, payload = {}, carrier = {}, results = [], error = null }, deps = {}) {
  const env = deps.env || process.env;
  const db = deps.supabase || supabase;
  const sendAlert = deps.sendAlert || defaultSendAlert;
  try {
    const systems = systemRollup(results);
    const lp = lpClearOutcome(results, { env, reviewPayload: payload });
    const smsWarning = carrier.carrierStop ? SMS_STOP_NOTICE : null;
    const notice = formatAutoLiftNotice({
      name: payload.contact_name,
      phone10: payload.phone_full,
      source: payload.source,
      subSource: payload.sub_source,
      trigger: payload.trigger,
      systems,
      lpManual: lp.lp_manual_clear_required,
      lpProspectId: lp.lp_prospect_id,
      smsWarning,
      ghlUrl: payload.ghl_contact_url,
      error,
    });
    const status = notice.anyFailed ? 'failed' : 'approved';

    const channel = String(env.SLACK_CHANNEL_DNC_LIFT || '').trim()
      || await (deps.fallbackChannel || defaultFallbackChannel)(db).catch(() => null);
    const post = channel
      ? await (deps.postToSlack || postToSlack)(notice.text, channel)
      : { ok: false, error: 'SLACK_CHANNEL_DNC_LIFT is not set' };
    if (!post.ok) console.warn(`[DncAutoLift] notice for ${requestId} did not post: ${post.error}`);

    const who = `${payload.contact_name || contactId} (${payload.phone_full || 'no phone'})`;
    const opsLines = [];
    if (notice.anyFailed) opsLines.push(`DNC auto-lift for ${who} did not fully complete — see #dnc-lift-approval (request ${requestId}).`);
    if (!post.ok) opsLines.push(`DNC auto-lift notice for ${who} could not post to #dnc-lift-approval: ${post.error}.`);
    for (const line of opsLines) {
      try { await sendAlert(line); } catch (err) { console.warn(`[DncAutoLift] ops alert failed: ${err.message}`); }
    }

    await db.from('dnc_lift_requests').update({
      status,
      completed_at: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
      batch_result: {
        report_mode: REPORT_MODE_AUTO,
        decision: 'approve',
        sms_carrier_stop: carrier.carrierStop === true,
        carrier_stop_basis: carrier.basis || [],
        sms_warning: smsWarning,
        ...lp,
        systems,
        any_failed: notice.anyFailed,
        ...(error ? { error } : {}),
        slack_channel: channel || null,
        notice_ts: post.ts || null,
        notice_posted: !!post.ok,
      },
    }).eq('request_id', requestId);

    console.log(`[DncAutoLift] ${contactId} → ${status} (request ${requestId}, notice ${post.ok ? 'posted' : 'NOT posted'})`);
    return { ok: true, status, notice_posted: !!post.ok, systems };
  } catch (err) {
    console.error(`[DncAutoLift] finishing ${requestId} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Safety net, called by the dnc-lift-report sweep: an automatic lift still
 * `processing` well after it started was cut off (a deploy, a crash) before
 * its notice. Its held steps ran from the queue; report them as they stand.
 */
export async function sweepStaleAutoLifts(deps = {}) {
  const db = deps.supabase || supabase;
  const now = deps.now ? deps.now() : Date.now();
  const { data, error } = await db.from('dnc_lift_requests')
    .select('request_id, ghl_contact_id, status, decided_at, review_payload, batch_result')
    .eq('status', 'processing')
    .eq('batch_result->>report_mode', REPORT_MODE_AUTO)
    .limit(50);
  if (error) return { ok: false, error: error.message };
  let finished = 0;
  const errors = [];
  for (const r of data || []) {
    const age = now - Date.parse(r.decided_at || 0);
    if (!(age >= STALE_AFTER_MS)) continue;
    const acts = await db.from('agent_actions').select('id, action_type, status, execution_result, error_message').eq('batch_id', r.request_id);
    if (acts.error) { errors.push(`${r.request_id}: ${acts.error.message}`); continue; }
    if ((acts.data || []).some((a) => ACTIVE.has(a.status)) && age < FINAL_AFTER_MS) continue;
    const br = r.batch_result || {};
    const out = await finishAutoLift({
      requestId: r.request_id,
      contactId: r.ghl_contact_id,
      payload: r.review_payload || {},
      carrier: { carrierStop: br.sms_carrier_stop === true, basis: br.carrier_stop_basis || [] },
      results: resultsFromRows(acts.data || []),
      error: (acts.data || []).length ? null : 'the lift was cut off before its steps were queued',
    }, deps);
    if (out.ok) finished += 1; else errors.push(`${r.request_id}: ${out.error}`);
  }
  return { ok: errors.length === 0, finished, errors };
}
