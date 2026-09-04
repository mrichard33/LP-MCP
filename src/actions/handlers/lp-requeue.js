/**
 * LP Callback Re-queue Handler — src/actions/handlers/lp-requeue.js
 *
 * action_type: lp_callback_requeue — fired by HOT_CALL_IMMEDIATE (rule_key,
 * agent_rules id 324) when the analyzer returns
 * recommended_action=callback_request + requested_fulfillment=phone_call.
 *
 * WHERE THE DIAL TRIGGER GOES — LP_REQUEUE_MODE, default 'five9' since
 * 2026-09-04.
 *
 * It used to be an LP LeadAdd: LP creates the lead, LP feeds LP_ASAP, DIAL
 * ASAP dials (~4s on lead 567746). That worked, and it also MINTED A NEW LP
 * LEAD every single time, because LeadAdd is the only LP endpoint that puts a
 * lead in a call queue — queues are derived views, so "re-queue" could only
 * ever mean "add another lead". On 2026-09-04 that duplicate (lead 573111,
 * contact zLDD7V1eosF8vldF5U7i) landed in LP's Data queue and triggered LP's
 * own Revin bot to send new-lead intake copy to a customer waiting at home for
 * an appointment we had already cancelled. The dedup was working — only one of
 * four fires performed a LeadAdd. One correct re-queue was enough.
 *
 * So the default now pushes a DIALING COPY into the Five9 "Callback Request"
 * list (src/five9/callback-push.js) and creates no LP lead at all. LP remains
 * the system of record for contact data; the agent's screen pop opens LP by
 * CustID. Setting LP_REQUEUE_MODE=lp_leadadd restores the old path exactly,
 * without a deploy. See the rewritten banner in src/five9/list-dispatch.js for
 * why writing this list is allowed where writing LP_ASAP still is not.
 *
 * Branching (handoff C3):
 *   no LP lead                    → create_lp_lead path (complete-address
 *                                   validation lives there; the Section-D
 *                                   hold-and-enrich gate hardens it). Still a
 *                                   LeadAdd in BOTH modes, deliberately: with
 *                                   no LP lead there is no prospect id, so
 *                                   there is no CustID to push and nothing for
 *                                   the agent to open. Creating the lead is
 *                                   genuine intake, not the duplicate above.
 *   LP lead exists, address OK    → five9 push (or LeadAdd in lp_leadadd mode)
 *   LP lead exists, address blank → UpdateProspectInfo FIRST, read back to
 *                                   confirm, THEN push. Never dispatch a
 *                                   rep to a lead with no address.
 *
 * Guardrails: queue precondition (skip when an existing lead is already
 * dialable in a Data queue), dedup window (LP_REQUEUE_DEDUP_MINUTES),
 * srs_id UNCHANGED (attribution stays on the paying channel), re-queue
 * marked only in sender/user2 (no reporting weight).
 *
 * The promise is closed by src/jobs/lp-requeue-verify.js: every completed
 * re-queue is verified dialable inside a bounded window or escalated to a
 * priority GroupMe — a promised call is never silently dropped.
 */

import supabase from '../../supabase.js';
import { addLead as lpAddLead, extractInboundLeadId, getInboundLeadInfo } from '../../lp-client.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote } from '../../ghl.js';
import { isLPLeadId, ghlFetch } from '../helpers.js';
import { emitEvent } from '../../event-emitter.js';
import {
  REQUEUE_SENDER,
  buildRequeueUser2,
  findLeadInDataQueues,
  recentRequeueExists,
  repairProspectAddress,
} from '../../services/lp-callback-requeue.js';
import {
  buildCallbackRecord,
  findContactInOtherLists,
  callbackListName,
  callbackCallNowMode,
} from '../../five9/callback-push.js';

import { executeCreateLPLead } from './lp-lead.js';

/**
 * Which system receives the dial trigger. 'five9' (default) pushes a dialing
 * copy into the Five9 Callback Request list; 'lp_leadadd' restores the pre
 * 2026-09-04 LP LeadAdd path exactly.
 *
 * Read per call so the whole change reverts from Railway without a deploy —
 * that is the rollback for Part 1, and it must not need a build to take.
 * Any unrecognised value falls back to 'five9' rather than throwing: a typo in
 * an env var must not take the callback path down entirely.
 */
export function requeueMode() {
  const raw = String(process.env.LP_REQUEUE_MODE || 'five9').trim().toLowerCase();
  return raw === 'lp_leadadd' ? 'lp_leadadd' : 'five9';
}

// GHL custom field ids (canonical Reece location field map — same ids as lp-lead.js)
const FIELD_LP_INBOUND_LEAD_ID = '3YMxheIlPyhACB8zyc3W'; // in1_id
const FIELD_LP_LEAD_ID         = 'GmAVmW6V9sekD7pVONKr'; // lds_id
// Corrected 2026-08-21: this pointed at BbUJ6RrdTjjEqqRA8JVx, which is the
// PROMOTER field (4-digit pro_id), so the srs_id fallback read a promoter id
// and re-queued the lead under the wrong source. srs_id lives in k6j4… —
// see src/lp-source-ids.js v2.1 (SubSource 3-digit, Promoter 4-digit) and
// the reference mapping in lp-lead.js:118-119.
const FIELD_LP_SOURCE_ID       = 'k6j4IBh5IejPooSCsj49'; // srs_id — LP SubSource (3-digit)

function readCF(contact, fieldId) {
  const arr = contact?.customFields || [];
  const f = arr.find((x) => x.id === fieldId);
  return (f?.value !== undefined && f?.value !== null) ? String(f.value) : '';
}

function verifyWindowMinutes() {
  return Math.max(2, Number(process.env.LP_REQUEUE_VERIFY_WINDOW_MIN) || 12);
}

// The executor kills a handler at 60s. loadQueueSnapshot() sweeps 5 Data queues
// at up to 12 pages each with 1.2s inter-call sleeps, so a cold cache can pass
// that limit on its own — which is what produced action 418351's two retries and
// three LeadAdds on 2026-09-03. Bound the scan well inside the handler budget.
// On timeout we proceed as "not present": the scan is an OPTIMISATION (skip a
// redundant LeadAdd when the lead is already dialable), not the safety net. The
// safety net is the dedup guard plus the LP inbound read below.
function queueScanTimeoutMs() {
  return Math.max(5000, Number(process.env.LP_REQUEUE_QUEUE_SCAN_TIMEOUT_MS) || 25000);
}

// deps is a TEST SEAM only — production calls this with ldsIds alone and both
// defaults below reproduce the handoff's code exactly. It exists because the
// timeout race is the whole point of this helper and an un-injectable race
// cannot be asserted without a live LP credential and a 25s wall clock.
export async function findLeadInDataQueuesBounded(ldsIds, deps = {}) {
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : queueScanTimeoutMs();
  const scan = deps.scan || findLeadInDataQueues;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([scan(ldsIds), timeout]);
    if (result?.__timedOut) {
      console.warn(`[LP-REQUEUE] queue scan exceeded ${timeoutMs}ms — proceeding without the precondition`);
      return { present: false, row: null, lds_id: null, truncated_queues: [], cache_age_ms: null, scan_timed_out: true };
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * External idempotency read (satisfies requirement 1 of the reaper's
 * "recoverable non-idempotent" contract, src/actions/reaper.js).
 *
 * Workflow 8e30ff37 and this handler both stamp lognumber = GHL contact id, so
 * LP's own inbound queue is queryable evidence that a prior attempt's LeadAdd
 * landed. Called only when this handler is re-entered for a contact that already
 * has a re-queue row in the window; a hit means DO NOT post again.
 *
 * Fails CLOSED (returns true = "already landed") only on a definite hit. On any
 * error it returns false so a transient LP outage never suppresses a first,
 * legitimate re-queue.
 */
async function priorRequeueLandedInLp(contactId, sinceIso) {
  try {
    const info = await getInboundLeadInfo({ lognumber: contactId });
    const rows = Array.isArray(info) ? info : (info?.data || info?.leads || info?.results || info?.items || []);
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const sinceMs = Date.parse(sinceIso);
    if (!Number.isFinite(sinceMs)) return rows.length > 0;
    return rows.some((r) => {
      const raw = r?.datereceived ?? r?.DateReceived ?? r?.created ?? r?.CreatedOn ?? null;
      const ms = raw ? Date.parse(String(raw)) : NaN;
      return Number.isFinite(ms) ? ms >= sinceMs - 60_000 : false;
    });
  } catch (err) {
    console.warn(`[LP-REQUEUE] LP inbound idempotency read failed for ${contactId}: ${err.message} — not treating as landed`);
    return false;
  }
}

export async function executeLpCallbackRequeue(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  if (!contactId || isLPLeadId(contactId)) {
    throw new Error(`lp_callback_requeue: target_id must be a GHL contact ID (got: ${contactId})`);
  }

  // ── Dedup window — one re-queue per contact per window ───────────
  // retryCount is the load-bearing argument: a retry of this same action row is
  // duplicate by definition, because the attempt that timed out may still have
  // posted its LeadAdd (2026-09-03, action 418351 → LP leads 572927/28/29).
  const dedup = await recentRequeueExists(contactId, {
    currentActionId: action.id,
    retryCount: Number(action.retry_count) || 0,
  });
  if (dedup.duplicate) {
    const windowStart = new Date(Date.now() - dedup.window_minutes * 60 * 1000).toISOString();
    const landed = await priorRequeueLandedInLp(contactId, windowStart);
    console.log(`[LP-REQUEUE] ⏭️ Skip ${contactId}: ${dedup.reason} (prior action ${dedup.prior_action_id || 'unknown'}, LP inbound evidence=${landed})`);
    return {
      action: 'requeue_deduped',
      requeued: false,
      contact_id: contactId,
      dedup_reason: dedup.reason,
      prior_action_id: dedup.prior_action_id || null,
      prior_status: dedup.prior_status || null,
      retry_count: dedup.retry_count ?? (Number(action.retry_count) || 0),
      lp_inbound_evidence: landed,
      window_minutes: dedup.window_minutes,
    };
  }

  // ── Fetch the GHL contact (identity + LP linkage fields) ─────────
  let ghlContact = null;
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    ghlContact = res?.contact || null;
  } catch (err) {
    throw new Error(`lp_callback_requeue: GHL contact fetch failed for ${contactId}: ${err.message}`);
  }
  if (!ghlContact) throw new Error(`lp_callback_requeue: GHL contact ${contactId} not found`);

  // ── Resolve LP state: prospect + existing leads ──────────────────
  // Supabase lp_leads is the local mirror (User1/HLCID carries the GHL
  // contact id); the GHL custom fields are the fallback linkage.
  let lpRows = [];
  try {
    const { data } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, address, city, state, zip, raw_lp_data, created_at_lp')
      .eq('ghl_contact_id', contactId)
      .order('created_at_lp', { ascending: false })
      .limit(10);
    lpRows = data || [];
  } catch (err) {
    console.warn(`[LP-REQUEUE] lp_leads lookup failed for ${contactId} (falling back to GHL fields): ${err.message}`);
  }
  const cfLdsId = readCF(ghlContact, FIELD_LP_LEAD_ID);
  const prospectId = lpRows[0]?.lp_prospect_id || null;
  const ldsIds = [...new Set([...lpRows.map((r) => r.lp_lead_id), cfLdsId].filter(Boolean))];
  const hasLpLead = ldsIds.length > 0;
  const preInboundId = readCF(ghlContact, FIELD_LP_INBOUND_LEAD_ID);

  const user2 = buildRequeueUser2();
  const verifyDeadline = new Date(Date.now() + verifyWindowMinutes() * 60 * 1000).toISOString();

  // ── Branch: no LP lead at all → the create path owns it ──────────
  // create_lp_lead validates the full address and cleanly skips (with a
  // GroupMe alert) when incomplete — the Section-D hold-and-enrich gate is
  // the durable fix for that case. The re-queue markers ride the payload.
  if (!hasLpLead) {
    console.log(`[LP-REQUEUE] ${contactId} has no LP lead — delegating to create_lp_lead with re-queue markers`);
    const createResult = await executeCreateLPLead({
      ...action,
      action_payload: {
        ...payload,
        sender: REQUEUE_SENDER,
        user2,
        include_appt: false,
        notes: payload.notes
          || `Callback requested via agentic system (recommended_action=callback_request, phone_call). GHL contact: ${contactId}. Customer was promised a call within minutes.`,
      },
    });
    const requeued = createResult?.action === 'lp_lead_created';
    return {
      ...createResult,
      action: requeued ? 'requeue_lead_created' : createResult.action,
      requeued,
      branch: 'no_lp_lead',
      user2: requeued ? user2 : null,
      pre_lds_ids: [],
      pre_inbound_id: preInboundId || null,
      verify_deadline: requeued ? verifyDeadline : null,
    };
  }

  // ── Precondition: already dialable in a Data queue? ──────────────
  const queueCheck = await findLeadInDataQueuesBounded(ldsIds);
  if (queueCheck.present) {
    const row = queueCheck.row || {};
    console.log(`[LP-REQUEUE] ⏭️ Skip ${contactId}: lead ${queueCheck.lds_id} already dialable in queue ${row.Cqd_ID} (attempts=${row.NumDialingAttempts}, lastResult=${row.LastCallResult || 'none'}) — no second LeadAdd`);
    await addGHLNote(contactId,
      `[LP REQUEUE] Skipped — LP lead ${queueCheck.lds_id} is already in dial queue ${row.Cqd_ID} ` +
      `with ${row.NumDialingAttempts ?? '?'} attempts so far. The lead is already dialable; a second ` +
      `LeadAdd would duplicate it. Callback promise rides the existing queue position.`
    ).catch(() => {});
    return {
      action: 'requeue_skipped_already_dialable',
      requeued: false,
      contact_id: contactId,
      lds_id: queueCheck.lds_id,
      queue: row.Cqd_ID ?? null,
      dialing_attempts: row.NumDialingAttempts ?? null,
      queue_cache_age_ms: queueCheck.cache_age_ms,
      truncated_queues: queueCheck.truncated_queues,
    };
  }

  // ── Address branch: repair the prospect BEFORE the re-queue ──────
  const lpAddressBlank = !String(lpRows[0]?.address || '').trim();
  const ghlHasAddress = !!String(ghlContact.address1 || '').trim();
  let addressRepair = null;
  if (lpAddressBlank && prospectId && ghlHasAddress) {
    addressRepair = await repairProspectAddress({ prospectId, ghlContact });
    console.log(`[LP-REQUEUE] prospect ${prospectId} address repaired from GHL before re-queue`);
  } else if (lpAddressBlank && !ghlHasAddress) {
    // Neither system has an address. The re-queue still goes out — a
    // promised call beats silence — but the address gap is surfaced loudly.
    console.warn(`[LP-REQUEUE] ⚠️ ${contactId}: LP address blank and GHL has no address either — re-queueing anyway, flagging for manual repair`);
    sendGroupMeMessage(
      `⚠️ CALLBACK RE-QUEUE WITH NO ADDRESS\n` +
      `Contact: ${ghlContact.firstName || ''} ${ghlContact.lastName || ''} (${contactId})\n` +
      `LP Prospect: ${prospectId || 'unknown'}\n` +
      `Neither LP nor GHL has a street address. The callback re-queue went out so the promised call happens, ` +
      `but the address must be collected on that call.`
    ).catch(() => {});
  }

  // ── FIVE9 PATH (default since 2026-09-04) ────────────────────────
  // A dialing copy into the Callback Request list instead of a new LP lead.
  // LP stays the system of record; nothing is written to LP but the note.
  //
  // Everything above this point is shared with the LeadAdd path on purpose —
  // the dedup, the already-dialable check and the address repair are about
  // whether a call should go out at all, which does not depend on who dials.
  if (requeueMode() === 'five9') {
    return pushCallbackToFive9({
      action, contactId, ghlContact, lpRows, ldsIds, prospectId,
      preInboundId, addressRepair, verifyDeadline, phone: String(ghlContact.phone || '').replace(/\D/g, '').slice(-10),
    });
  }

  // ── The re-queue LeadAdd (LP_REQUEUE_MODE=lp_leadadd) ────────────
  // srs_id UNCHANGED: the newest existing lead's srs_id (raw_lp_data), then
  // the contact's LP Source custom field. No default — if we cannot resolve
  // the true source we fail rather than misattribute.
  const existingSrsId = String(
    payload.srs_id
    || lpRows[0]?.raw_lp_data?.srs_id
    || readCF(ghlContact, FIELD_LP_SOURCE_ID)
    || ''
  ).trim();
  if (!existingSrsId) {
    throw new Error(`lp_callback_requeue: cannot resolve the existing srs_id for ${contactId} (prospect ${prospectId}) — refusing to guess source attribution`);
  }

  const address1 = String(ghlContact.address1 || lpRows[0]?.address || '').trim();
  const city     = String(ghlContact.city || lpRows[0]?.city || '').trim();
  const state    = String(ghlContact.state || lpRows[0]?.state || '').trim();
  const zip      = String(ghlContact.postalCode || lpRows[0]?.zip || '').trim();
  const phone    = String(ghlContact.phone || '').replace(/\D/g, '').slice(-10);

  const leadFields = {
    firstname: ghlContact.firstName || '',
    lastname:  ghlContact.lastName || '',
    address1,
    city,
    state,
    zip,
    phone,
    sender:    REQUEUE_SENDER,
    srs_id:    existingSrsId,
    notes:     payload.notes
      || `Agentic callback re-queue: customer asked for a phone call (recommended_action=callback_request). Existing prospect ${prospectId || 'unknown'}; prior lead(s): ${ldsIds.join(', ')}. srs_id unchanged for attribution.`,
    lognumber: contactId,
    User1:     contactId,
    user2,
    HasConsent: 'true',
    ConsentDate: ghlContact.dateAdded || new Date().toISOString(),
    TextOptIn: 'true',
    EmailOptIn: 'true',
  };
  if (ghlContact.email) leadFields.email = ghlContact.email;

  let lpResponse;
  try {
    lpResponse = await lpAddLead(leadFields);
  } catch (err) {
    sendGroupMeMessage(
      `❌ CALLBACK RE-QUEUE FAILED — PROMISED CALL AT RISK\n` +
      `Contact: ${ghlContact.firstName || ''} ${ghlContact.lastName || ''} (${contactId})\n` +
      `Phone: ${phone || 'unknown'}\n` +
      `LP Prospect: ${prospectId || 'unknown'}\n` +
      `Error: ${String(err.message).slice(0, 200)}\n` +
      `→ The customer was told someone will call. Place this call manually NOW.`
    ).catch(() => {});
    throw err;
  }

  const inboundId = extractInboundLeadId(lpResponse);
  if (!inboundId) {
    throw new Error(`lp_callback_requeue: LP addLead returned OK but in1_id could not be parsed: ${JSON.stringify(lpResponse).slice(0, 200)}`);
  }

  // Durable local record (queryable): the lp.callback_requeued event mirrors
  // the sender/user2 markers — LP's GetLead sync only returns the user
  // fields LP is configured to expose (currently 1/11/12), so this event +
  // this action row are the local source of truth for "was this a re-queue".
  //
  // AWAITED as of 2026-09-03. Fire-and-forget meant contact
  // eqjK58AwEZ1juYJH6szE produced three LeadAdds and ZERO lp.callback_requeued
  // rows — the only durable cross-attempt trail never landed. The emit is still
  // .catch()-guarded so a failure never blocks the re-queue.
  await emitEvent({
    event_type: 'lp.callback_requeued',
    source: 'lp_mcp',
    entity_type: 'contact',
    entity_id: String(contactId),
    ghl_contact_id: contactId,
    priority: 'high',
    payload: {
      lp_prospect_id: prospectId,
      prior_lds_ids: ldsIds,
      in1_id: inboundId,
      srs_id: existingSrsId,
      sender: REQUEUE_SENDER,
      user2,
      address_repaired: !!addressRepair,
      verify_deadline: verifyDeadline,
    },
    idempotency_key: `lp_callback_requeue_${contactId}_${inboundId}`,
  }).catch((err) => console.warn(`[LP-REQUEUE] event emit failed: ${err.message}`));

  await addGHLNote(contactId,
    `[LP REQUEUE] Callback re-queue pushed to Lead Perfection\n` +
    `LP Inbound ID (in1_id): ${inboundId}\n` +
    `Prospect: ${prospectId || 'unknown'} | prior lead(s): ${ldsIds.join(', ')}\n` +
    `srs_id: ${existingSrsId} (UNCHANGED — attribution preserved) | sender: ${REQUEUE_SENDER}\n` +
    `user2: ${user2}\n` +
    `${addressRepair ? 'Prospect address was repaired from GHL before the push.\n' : ''}` +
    `LP will issue a new lds_id (~60s) and push to LP_ASAP → DIAL ASAP dials. ` +
    `Verification sweep confirms dialability by ${verifyDeadline} or escalates.`
  ).catch(() => {});

  console.log(`[LP-REQUEUE] ✅ Re-queue pushed for ${contactId}: in1_id=${inboundId}, prospect=${prospectId}, srs_id=${existingSrsId}, address_repaired=${!!addressRepair}`);

  return {
    action: 'requeued',
    requeued: true,
    branch: addressRepair ? 'existing_lead_address_repaired' : 'existing_lead',
    contact_id: contactId,
    lp_prospect_id: prospectId,
    pre_lds_ids: ldsIds,
    pre_inbound_id: preInboundId || null,
    lp_inbound_lead_id: inboundId,
    srs_id: existingSrsId,
    sender: REQUEUE_SENDER,
    user2,
    address_repaired: !!addressRepair,
    verify_deadline: verifyDeadline,
    lp_path: lpResponse?._path || 'unknown',
  };
}

/**
 * Push the callback into the Five9 Callback Request list.
 *
 * Queues a five9_add_records_to_list row rather than calling the executor
 * inline. That row is the audit trail — it carries the exact fieldsMapping and
 * values that went to Five9, it is retryable, and five9.admin_write logs the
 * write. It is queued UNARMED (requires_approval false), which is only legal
 * for this one op: see AUTO_APPROVED_FIVE9_OP in src/tools/agent-tools.js and
 * the matching exemption in src/actions/handlers/five9.js.
 *
 * Failure here is loud and reaches a human, because the customer has already
 * been told someone will ring them.
 */
async function pushCallbackToFive9({
  action, contactId, ghlContact, lpRows, ldsIds, prospectId,
  preInboundId, addressRepair, verifyDeadline, phone,
}) {
  const listName = callbackListName();

  // 1. Build the record. Throws on a missing CustID or an unusable phone —
  //    a record the agent cannot work is worse than no record at all.
  let record;
  try {
    record = buildCallbackRecord({ contactId, ghlContact, lpRow: lpRows[0] || {} });
  } catch (err) {
    await emitEvent({
      event_type: 'lp.callback_requeue_refused',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: contactId,
      priority: 'high',
      payload: { reason: 'unworkable_record', error: String(err.message).slice(0, 300), lp_prospect_id: prospectId, prior_lds_ids: ldsIds },
      idempotency_key: `lp_callback_requeue_refused_${contactId}_${action.id}`,
    }).catch(() => {});
    sendGroupMeMessage(
      `❌ CALLBACK PUSH REFUSED — PROMISED CALL AT RISK\n` +
      `Contact: ${ghlContact.firstName || ''} ${ghlContact.lastName || ''} (${contactId})\n` +
      `Phone: ${phone || 'unknown'}\n` +
      `${String(err.message).slice(0, 240)}\n` +
      `→ The customer was told someone will call. Place this call manually NOW.`
    ).catch(() => {});
    throw err;
  }

  // 2. Cross-list suppression. Fails open — see findContactInOtherLists.
  const other = await findContactInOtherLists(record.number1, { listName });
  if (other.failed_open) {
    await emitEvent({
      event_type: 'lp.callback_requeue_fail_open',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: contactId,
      priority: 'high',
      payload: { stage: 'cross_list_check', error: String(other.error).slice(0, 300), proceeding: true },
      idempotency_key: `lp_callback_requeue_failopen_${contactId}_${action.id}`,
    }).catch(() => {});
    console.warn(`[LP-REQUEUE] cross-list check failed for ${contactId} — proceeding (fail open): ${other.error}`);
  }
  if (other.suppress) {
    console.log(`[LP-REQUEUE] ⏭️ Skip ${contactId}: already live in Five9 list(s) ${other.lists.join(', ')} — not double-dialing`);
    await emitEvent({
      event_type: 'lp.callback_requeue_suppressed',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: contactId,
      priority: 'normal',
      payload: { reason: 'live_in_other_five9_list', lists: other.lists, number1: record.number1 },
      idempotency_key: `lp_callback_requeue_supp_${contactId}_${action.id}`,
    }).catch(() => {});
    await addGHLNote(contactId,
      `[LP REQUEUE] Skipped the Five9 callback push — this number is already being worked in ` +
      `Five9 list(s): ${other.lists.join(', ')}. Pushing again would put two campaigns on the same ` +
      `person the same afternoon. The callback rides the existing dial.`
    ).catch(() => {});
    return {
      action: 'requeue_suppressed_other_list',
      // requeued:false is load-bearing for the dedup contract — a suppressed
      // push must NOT count as "a dial trigger already went out" for the next
      // attempt, exactly like requeue_skipped_already_dialable.
      requeued: false,
      contact_id: contactId,
      other_lists: other.lists,
      number1: record.number1,
    };
  }

  // 3. Queue the write.
  const callNowMode = callbackCallNowMode();
  const { data: queued, error } = await supabase.from('agent_actions').insert({
    event_id: action?.event_id || null,
    action_type: 'five9_add_records_to_list',
    target_system: 'five9',
    target_entity: 'list',
    target_id: listName,
    action_payload: {
      list_name: listName,
      field_names: record.fieldNames,
      records: [record.values],
      call_now_mode: callNowMode,
    },
    // The inverse of this push, ready to paste if a record needs pulling back.
    rollback_payload: {
      action_type: 'five9_delete_record_from_list',
      list_name: listName,
      field_names: ['number1'],
      records: [[record.number1]],
    },
    reasoning:
      `Agentic callback re-queue for GHL contact ${contactId} (LP prospect ${record.custId}). ` +
      `Dialing copy only — LP remains the system of record. Queued unarmed under the ` +
      `five9_add_records_to_list carve-out (Mark, 2026-09-04): a promised callback cannot wait on an approval click.`,
    rule_applied: 'LP_CALLBACK_REQUEUE_FIVE9',
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 90,
  }).select('id').single();

  if (error) {
    sendGroupMeMessage(
      `❌ CALLBACK PUSH COULD NOT BE QUEUED — PROMISED CALL AT RISK\n` +
      `Contact: ${ghlContact.firstName || ''} ${ghlContact.lastName || ''} (${contactId})\n` +
      `Phone: ${phone || 'unknown'} | LP Prospect: ${record.custId}\n` +
      `Error: ${String(error.message).slice(0, 200)}\n` +
      `→ The customer was told someone will call. Place this call manually NOW.`
    ).catch(() => {});
    throw new Error(`lp_callback_requeue: could not queue the Five9 push for ${contactId}: ${error.message}`);
  }

  await emitEvent({
    event_type: 'lp.callback_requeued',
    source: 'lp_mcp',
    entity_type: 'contact',
    entity_id: String(contactId),
    ghl_contact_id: contactId,
    priority: 'high',
    payload: {
      mode: 'five9',
      list: listName,
      five9_action_id: queued?.id ?? null,
      call_now_mode: callNowMode,
      cust_id: record.custId,
      lead_id: record.fieldNames.includes('lead_id') ? record.values[record.fieldNames.indexOf('lead_id')] : null,
      lp_rec_key: record.lpRecKey,
      lp_rec_type: record.lpRecType,
      lp_prospect_id: prospectId,
      prior_lds_ids: ldsIds,
      address_repaired: !!addressRepair,
      verify_deadline: verifyDeadline,
      cross_list_check_failed_open: other.failed_open,
    },
    idempotency_key: `lp_callback_requeue_${contactId}_five9_${queued?.id ?? action.id}`,
  }).catch((err) => console.warn(`[LP-REQUEUE] event emit failed: ${err.message}`));

  await addGHLNote(contactId,
    `[LP REQUEUE] Callback pushed to the Five9 "${listName}" list\n` +
    `CustID (LP prospect): ${record.custId} | lead_id: ${lpRows[0]?.lp_lead_id || 'none'}\n` +
    `${record.lpRecKey ? `LPRecKey: ${record.lpRecKey}\n` : ''}` +
    `callNowMode: ${callNowMode} | five9 action: ${queued?.id ?? 'unknown'}\n` +
    `${addressRepair ? 'Prospect address was repaired from GHL before the push.\n' : ''}` +
    `No new LP lead was created — LP stays the system of record and this is a dialing copy only. ` +
    `The agent's screen pop opens LP by CustID; the AI BRIEF note on this contact carries the call context.`
  ).catch(() => {});

  console.log(`[LP-REQUEUE] ✅ Five9 callback push queued for ${contactId}: list="${listName}", CustID=${record.custId}, callNowMode=${callNowMode}, action=${queued?.id}`);

  return {
    action: 'requeued',
    // requeued:true keeps the PR #823 dedup contract intact — the next attempt
    // inside the window sees prior_requeue_completed and stands down, exactly
    // as it did when this branch performed a LeadAdd.
    requeued: true,
    branch: addressRepair ? 'five9_push_address_repaired' : 'five9_push',
    mode: 'five9',
    contact_id: contactId,
    lp_prospect_id: prospectId,
    cust_id: record.custId,
    pre_lds_ids: ldsIds,
    pre_inbound_id: preInboundId || null,
    five9_list: listName,
    five9_action_id: queued?.id ?? null,
    five9_field_names: record.fieldNames,
    call_now_mode: callNowMode,
    lp_rec_key: record.lpRecKey,
    lp_rec_type: record.lpRecType,
    address_repaired: !!addressRepair,
    cross_list_check_failed_open: other.failed_open,
    verify_deadline: verifyDeadline,
  };
}

export default { executeLpCallbackRequeue, findLeadInDataQueuesBounded };
