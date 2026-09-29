/**
 * POST /slack/dnc-lift/decision — src/consent/dnc-lift-decision.js
 *
 * Consent Model v1 (2026-09-28). The other half of request_dnc_lift_review:
 * n8n's "OPS.DNC-LIFT Slack Approval" posts here when someone clicks
 * ✅ Approve Lift or ⛔ Keep Blocked in #dnc-lift-approval, then prints the
 * per-system result this route returns into the card's thread.
 *
 * Internal, n8n-only. Auth is a shared header secret, X-DNC-Lift-Secret =
 * DNC_LIFT_WEBHOOK_SECRET, compared in constant time and FAIL-CLOSED: an unset
 * secret refuses every request.
 *
 * Body: { ghl_contact_id, decision: 'approve'|'keep_blocked', slack_user_id,
 *         slack_user_name, slack_ts, request_id }
 *
 * IDEMPOTENT ON request_id. dnc_lift_requests (sql/140) is the claim: the first
 * decision to move a row out of 'awaiting_decision' wins; a re-post (n8n retry,
 * double click) gets the stored result back and queues nothing. The route only
 * accepts a request_id this service issued, for the same contact — a leaked
 * secret alone cannot lift an arbitrary number. Missing table → 503: refuse
 * rather than lift without the idempotency record.
 *
 * APPROVE queues ONE batch (batch_id = request_id), in this order:
 *   1. record_consent_change  all/dnc_full_off, then phone/granted
 *      (with a carrier STOP: granted FOR CALLS, reason says SMS stays blocked)
 *   2. remove_tag  the DNC family — NOT dnc-sms when the lead texted STOP
 *   3. set_dnd inactive  Call, Email, WhatsApp, GMB, FB (+ SMS, RCS only
 *      without a carrier STOP)
 *   4. update_lp_dnc_status  mode: clear
 *   5. five9_remove_numbers_from_dnc_approved, then approve_action with the
 *      Slack approver (the op refuses any other kind of approval)
 *   6. add_tag recovery:dnc-lifted-manual
 *   7. emit_event consent.dnc_lifted_manual (approver + evidence)
 * KEEP BLOCKED: record_consent_change all/dnc_full_on (source slack_review),
 * add_tag dnc-lift:reviewed-blocked, emit_event consent.dnc_lift_denied.
 *
 * A CARRIER STOP IS NEVER OVERRIDDEN HERE. A lead who texted STOP gets calls,
 * LP and Five9 back; GHL SMS/RCS DND and dnc-sms stay. Texts reopen only on
 * START/UNSTOP or a new first-party form with explicit SMS consent. (A GHL
 * 'permanent' SMS DND could not be lifted anyway — only the carrier can.)
 *
 * The batch runs IMMEDIATELY (runActionsNow) so the response carries real
 * per-action outcomes; rows are inserted with retry_at in the future so the
 * queue executor cannot race the route for them.
 */

import crypto from 'node:crypto';
import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { approveAgentAction } from '../actions/approve-action.js';
import { getConsent, detectCarrierStop, blockingTags, isMissingSchemaError } from './consent-store.js';
import { APPROVED_DNC_LIFT_RULE_KEY, isSlackUserId } from '../five9/admin-writes.js';

export const KEEP_BLOCKED_RULE_KEY = 'SLACK_DNC_KEEP_BLOCKED';
export const LIFT_TAGS = Object.freeze([
  'dnc', 'stage:dnc', 'lp-dnc', 'do-not-contact', 'dnc-voice', 'dnc-email', 'loss-reason:dnc',
  'stop-bot', 'mark-p1-lost', 'suppress-automation',
]);
export const CARRIER_STOP_KEEP_TAG = 'dnc-sms';
export const LIFT_DND_CHANNELS = Object.freeze(['Call', 'Email', 'WhatsApp', 'GMB', 'FB']);
export const SMS_DND_CHANNELS = Object.freeze(['SMS', 'RCS']);
// Rows sit un-claimable this long, so only the route runs them. If the process
// dies before it claims them, the queue picks them up after this.
export const ROUTE_HOLD_MS = 15 * 60 * 1000;

// ─── auth ───────────────────────────────────────────────────────────────────

export function checkDncLiftSecret(headers = {}, secret = process.env.DNC_LIFT_WEBHOOK_SECRET) {
  const expected = String(secret || '');
  if (!expected) return { ok: false, reason: 'secret_not_configured' };
  const provided = String(headers['x-dnc-lift-secret'] || '');
  if (!provided) return { ok: false, reason: 'no_secret_header' };
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_secret' };
  return { ok: true };
}

export function validateDecisionBody(body = {}) {
  const errors = [];
  const s = (k) => (typeof body[k] === 'string' ? body[k].trim() : '');
  if (!s('ghl_contact_id')) errors.push('ghl_contact_id is required');
  if (!['approve', 'keep_blocked'].includes(body.decision)) errors.push("decision must be 'approve' or 'keep_blocked'");
  if (!isSlackUserId(s('slack_user_id'))) errors.push('slack_user_id must be a Slack user id (U…/W…)');
  if (!s('slack_ts')) errors.push('slack_ts is required');
  if (!s('request_id')) errors.push('request_id is required');
  return errors;
}

// ─── the batch, as data ──────────────────────────────────────────────────────

function actorLabel({ slackUserId, slackUserName }) {
  return slackUserName ? `${slackUserName} (${slackUserId})` : slackUserId;
}

/**
 * The APPROVE batch as agent_actions rows. Pure. `carrierStop` decides the
 * only three differences: dnc-sms stays, SMS/RCS DND stays, and phone consent
 * is recorded as granted-for-calls with a reason that says so.
 */
export function buildLiftBatch({ contactId, requestId, slackUserId, slackUserName, slackTs, carrierStop, carrierBasis = [], blocking = [] }) {
  const actor = actorLabel({ slackUserId, slackUserName });
  const evidence = {
    slack_ts: slackTs, request_id: requestId, slack_user_id: slackUserId,
    slack_user_name: slackUserName || null, blocking_tags: blocking,
    sms_carrier_stop: carrierStop, carrier_stop_basis: carrierBasis,
  };
  const base = (action_type, target_system, action_payload, extra = {}) => ({
    action_type, target_system, target_entity: 'contact', target_id: contactId,
    action_payload, rule_applied: APPROVED_DNC_LIFT_RULE_KEY, batch_id: requestId,
    requires_approval: false,
    reasoning: `Manual DNC lift approved in Slack by ${actor} (request ${requestId})`,
    ...extra,
  });
  const tags = carrierStop ? [...LIFT_TAGS] : [...LIFT_TAGS, CARRIER_STOP_KEEP_TAG];
  const dnd = carrierStop ? [...LIFT_DND_CHANNELS] : [...LIFT_DND_CHANNELS, ...SMS_DND_CHANNELS];
  const rows = [
    base('record_consent_change', 'lp', {
      channel: 'all', change: 'dnc_full_off', source: 'slack_lift', actor, evidence,
      reason: 'Manual DNC lift approved in #dnc-lift-approval',
    }),
    base('record_consent_change', 'lp', {
      channel: 'phone', change: 'granted', source: 'slack_lift', actor, evidence,
      reason: carrierStop
        ? 'Granted for CALLS only — the lead texted STOP, so SMS stays carrier-blocked until START/UNSTOP or a new form with SMS consent'
        : 'Manual DNC lift approved in #dnc-lift-approval',
    }),
    base('remove_tag', 'ghl', { tags, bypass_suppression: true }),
    base('set_dnd', 'ghl', {
      status: 'inactive', channels: dnd,
      reason: `Manual DNC lift approved in Slack by ${actor}${carrierStop ? ' — SMS/RCS left ON (lead texted STOP)' : ''}`,
    }),
    base('update_lp_dnc_status', 'lp', { mode: 'clear', source: `slack_lift by ${actor}` }),
    base('five9_remove_numbers_from_dnc_approved', 'lp', {
      numbers_from_contact: true,
      approved_by: slackUserId,
      approved_by_name: slackUserName || null,
      clear_sms: !carrierStop,
      evidence,
    }, { requires_approval: true }),
    base('add_tag', 'ghl', { tag: 'recovery:dnc-lifted-manual', bypass_suppression: true }),
    base('emit_event', 'lp', {
      event_type: 'consent.dnc_lifted_manual',
      bypass_filter: true,
      idempotency_key: `consent_dnc_lifted_manual_${requestId}`,
      payload: { approver: { slack_user_id: slackUserId, slack_user_name: slackUserName || null }, evidence },
    }),
  ];
  return rows.map((r, i) => ({ ...r, sequence_order: i + 1 }));
}

export function buildKeepBlockedBatch({ contactId, requestId, slackUserId, slackUserName, slackTs, blocking = [] }) {
  const actor = actorLabel({ slackUserId, slackUserName });
  const evidence = { slack_ts: slackTs, request_id: requestId, slack_user_id: slackUserId, slack_user_name: slackUserName || null, blocking_tags: blocking };
  const base = (action_type, target_system, action_payload) => ({
    action_type, target_system, target_entity: 'contact', target_id: contactId,
    action_payload, rule_applied: KEEP_BLOCKED_RULE_KEY, batch_id: requestId, requires_approval: false,
    reasoning: `DNC lift reviewed in Slack — kept blocked by ${actor} (request ${requestId})`,
  });
  return [
    base('record_consent_change', 'lp', {
      channel: 'all', change: 'dnc_full_on', source: 'slack_review', actor, evidence,
      reason: 'Reviewed in #dnc-lift-approval — kept blocked',
    }),
    base('add_tag', 'ghl', { tag: 'dnc-lift:reviewed-blocked', bypass_suppression: true }),
    base('emit_event', 'lp', {
      event_type: 'consent.dnc_lift_denied',
      bypass_filter: true,
      idempotency_key: `consent_dnc_lift_denied_${requestId}`,
      payload: { reviewer: { slack_user_id: slackUserId, slack_user_name: slackUserName || null }, evidence },
    }),
  ].map((r, i) => ({ ...r, sequence_order: i + 1 }));
}

// ─── result → what the Slack thread says ─────────────────────────────────────

const SYSTEM_OF = {
  record_consent_change: 'consent',
  remove_tag: 'ghl', set_dnd: 'ghl', add_tag: 'ghl',
  update_lp_dnc_status: 'lp',
  five9_remove_numbers_from_dnc_approved: 'five9',
  emit_event: 'audit',
};

/** executor status → done | skipped | failed. A retrying row is not done. Pure. */
export function outcomeOf(r) {
  if (!r) return 'failed';
  if (r.status === 'completed') return r.result?.skipped ? 'skipped' : 'done';
  if (r.status === 'skipped' || r.status === 'suppressed') return 'skipped';
  return 'failed';
}

/**
 * Per-system roll-up for the thread: GHL / LP / Five9 (+ consent, audit).
 * A system is 'failed' if any of its actions failed. Pure.
 */
export function summarizeBatch(results) {
  const systems = {};
  const actions = (results || []).map((r) => {
    const outcome = outcomeOf(r);
    const sys = SYSTEM_OF[r.action_type] || 'other';
    const cur = systems[sys] || { status: 'done', errors: [] };
    if (outcome === 'failed') {
      cur.status = 'failed';
      cur.errors.push(`${r.action_type}: ${r.error || r.status}`);
    }
    systems[sys] = cur;
    return {
      action_id: r.action_id, action_type: r.action_type, system: sys, outcome,
      status: r.status, error: r.error || null,
      ...(r.status === 'pending' ? { note: 'failed — the executor will retry it' } : {}),
    };
  });
  const anyFailed = actions.some((a) => a.outcome === 'failed');
  return { any_failed: anyFailed, systems, actions };
}

// ─── the route ───────────────────────────────────────────────────────────────

async function defaultReadContact(contactId) {
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    return res?.contact || null;
  } catch (err) {
    console.warn(`[DncLiftDecision] contact read failed for ${contactId}: ${err.message}`);
    return null;
  }
}

async function defaultInsertActions(rows, db, holdUntilIso) {
  const insertRows = rows.map((r) => ({
    ...r,
    status: r.requires_approval ? 'pending_approval' : 'pending',
    retry_at: holdUntilIso,
    priority: 5,
  }));
  const { data, error } = await db.from('agent_actions').insert(insertRows).select('id, action_type, sequence_order, status');
  if (error) throw new Error(`could not queue the batch: ${error.message}`);
  return (data || []).slice().sort((a, b) => a.sequence_order - b.sequence_order);
}

/**
 * The whole decision, behind a deps seam. Returns { status, json }.
 */
export async function handleDncLiftDecision({ body = {}, headers = {} }, deps = {}) {
  const env = deps.env || process.env;
  const db = deps.supabase || supabase;
  const now = deps.now ? deps.now() : Date.now();
  const nowIso = new Date(now).toISOString();

  const auth = checkDncLiftSecret(headers, env.DNC_LIFT_WEBHOOK_SECRET);
  if (!auth.ok) return { status: auth.reason === 'secret_not_configured' ? 503 : 401, json: { ok: false, error: auth.reason } };

  const errors = validateDecisionBody(body);
  if (errors.length) return { status: 400, json: { ok: false, errors } };

  const contactId = body.ghl_contact_id.trim();
  const requestId = body.request_id.trim();
  const slackUserId = body.slack_user_id.trim();
  const slackUserName = typeof body.slack_user_name === 'string' ? body.slack_user_name.trim() : '';
  const slackTs = body.slack_ts.trim();
  const decision = body.decision;

  // ── the idempotency record ──
  const found = await db.from('dnc_lift_requests').select('*').eq('request_id', requestId).maybeSingle();
  if (found.error) {
    if (isMissingSchemaError(found.error)) {
      return { status: 503, json: { ok: false, error: 'dnc_lift_requests is missing — apply sql/140; refusing to lift without the idempotency record' } };
    }
    return { status: 500, json: { ok: false, error: `request lookup failed: ${found.error.message}` } };
  }
  if (!found.data) return { status: 404, json: { ok: false, error: `unknown request_id ${requestId} — only a request this service issued can be decided` } };
  if (found.data.ghl_contact_id !== contactId) {
    return { status: 409, json: { ok: false, error: `request ${requestId} is for a different contact` } };
  }
  const replay = (row) => ({
    status: 200,
    json: {
      ok: row.status !== 'failed', idempotent: true, request_id: requestId,
      status: row.status, decision: row.decision,
      decided_by: row.slack_user_name || row.slack_user_id || null,
      ...(row.batch_result || {}),
    },
  });
  if (found.data.status !== 'awaiting_decision') return replay(found.data);

  const claim = await db.from('dnc_lift_requests')
    .update({
      status: 'processing', decision, slack_user_id: slackUserId,
      slack_user_name: slackUserName || null, slack_ts: slackTs, decided_at: nowIso,
    })
    .eq('request_id', requestId)
    .eq('status', 'awaiting_decision')
    .select('request_id');
  if (claim.error) return { status: 500, json: { ok: false, error: `claim failed: ${claim.error.message}` } };
  if (!claim.data || claim.data.length === 0) {
    const again = await db.from('dnc_lift_requests').select('*').eq('request_id', requestId).maybeSingle();
    return again.data ? replay(again.data) : { status: 409, json: { ok: false, error: 'lost the claim race and could not re-read the request' } };
  }

  const finish = async (status, batchResult) => {
    await db.from('dnc_lift_requests')
      .update({ status, batch_result: batchResult, completed_at: new Date(deps.now ? deps.now() : Date.now()).toISOString() })
      .eq('request_id', requestId);
  };

  try {
    // ── what blocks them, and did they text STOP? ──
    const readContact = deps.readContact || defaultReadContact;
    const [contact, consentRead] = await Promise.all([
      readContact(contactId),
      (deps.getConsent || getConsent)(contactId, { supabase: db, eventLimit: 1 }),
    ]);
    const carrier = detectCarrierStop({
      consent: consentRead.consent,
      tags: contact?.tags,
      dndSettings: contact?.dndSettings,
      contactReadFailed: !contact,
    });
    const blocking = blockingTags(contact?.tags || []);
    const who = { contactId, requestId, slackUserId, slackUserName, slackTs, blocking };

    const rows = decision === 'approve'
      ? buildLiftBatch({ ...who, carrierStop: carrier.carrierStop, carrierBasis: carrier.basis })
      : buildKeepBlockedBatch(who);

    const holdUntil = new Date(now + ROUTE_HOLD_MS).toISOString();
    const inserted = await (deps.insertActions || defaultInsertActions)(rows, db, holdUntil);

    // The Five9 row is queued requires_approval (five9_ prefix) — approve it
    // through approve_action AS the Slack user. The op refuses anything else.
    const five9Row = inserted.find((r) => r.action_type === 'five9_remove_numbers_from_dnc_approved');
    if (five9Row) {
      const appr = await (deps.approveAction || approveAgentAction)(
        { actionId: five9Row.id, decision: 'approve', approvedBy: slackUserId }, { supabase: db });
      if (!appr.ok) console.warn(`[DncLiftDecision] approve_action failed for five9 row ${five9Row.id}: ${appr.error || 'not found'}`);
    }

    const runNow = deps.runActionsNow || (await import('../actions/index.js')).runActionsNow;
    const results = await runNow(inserted.map((r) => r.id));
    const summary = summarizeBatch(results);
    const batchResult = {
      decision,
      sms_carrier_stop: carrier.carrierStop,
      carrier_stop_basis: carrier.basis,
      sms_warning: decision === 'approve' && carrier.carrierStop
        ? 'Texts stay OFF: the lead texted STOP. They reopen only when the lead texts START or submits a new form with SMS consent.'
        : null,
      ...summary,
    };
    const finalStatus = summary.any_failed ? 'failed' : (decision === 'approve' ? 'approved' : 'kept_blocked');
    await finish(finalStatus, batchResult);
    console.log(`[DncLiftDecision] ${decision} for ${contactId} by ${slackUserName || slackUserId} → ${finalStatus} (request ${requestId})`);
    return {
      status: 200,
      json: {
        ok: !summary.any_failed, idempotent: false, request_id: requestId, status: finalStatus,
        decided_by: slackUserName || slackUserId, ...batchResult,
      },
    };
  } catch (err) {
    await finish('failed', { decision, error: err.message }).catch(() => {});
    console.error(`[DncLiftDecision] ${decision} for ${contactId} failed: ${err.message}`);
    return { status: 500, json: { ok: false, request_id: requestId, error: err.message } };
  }
}

export function registerDncLiftDecisionRoutes(app) {
  app.post('/slack/dnc-lift/decision', async (req, res) => {
    const out = await handleDncLiftDecision({ body: req.body || {}, headers: req.headers || {} })
      .catch((err) => ({ status: 500, json: { ok: false, error: err.message } }));
    res.status(out.status).json(out.json);
  });
}
