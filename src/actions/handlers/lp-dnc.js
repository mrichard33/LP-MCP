/**
 * LP DNC Handler — src/actions/handlers/lp-dnc.js
 *
 * Pushes a DNC (Do Not Contact) flag from GHL to LP via the
 * /api/Customers/UpdateDNCStatus endpoint. Closes the GHL→LP DNC
 * propagation gap that left contacts marked DNC in GHL but still
 * "Data" disposition in LP.
 *
 * Why this exists: the GHL workflow "Customer Replied Stop - SMS / Chat
 * Widget" (4743b7a5-4936-420b-a94a-496c44bae151) was meant to handle
 * this propagation, but its webhook was failing with LP returning:
 *   [{"Result":0,"Message":"Error: Invalid DNC value. Customer ID does
 *     not exist. Employee ID does not exist."}]
 * Root cause: the GHL merge field {{contact.lp_prospect_id}} was not
 * resolving to the actual prospect ID. Plus the agentic
 * TRUST_BREAK_PROCESS rule fires `remove_from_workflow remove_all=true`
 * within minutes of STOP, which can kill the workflow before its 1-hour
 * wait step resolves.
 *
 * This handler bypasses both problems:
 *   1. Reads the prospect ID directly off the GHL contact's customFields
 *      array (field ID ZRQAVrzhtzApzLlHmT87) — no merge field involved.
 *   2. Runs as an agent action in the same batch as the trust-break
 *      tagging, so it fires before any workflow-removal action.
 *
 * Idempotency: skip with success status if the contact already has a
 * `lp-dnc:{code}` tag. Each code gets its own tag (a P push doesn't
 * satisfy a T request and vice versa).
 *
 * No prospect ID = clean skip with GroupMe alert (mirrors lp-lead.js
 * pattern). Action is marked completed so it doesn't churn retries.
 *
 * 2026-10-23 — no echo cards. A contact carrying `lp-dnc` (LP_DISP_DNC: the
 * DNC came from LP) is `origin_lp_skip`: no LP call, no card, prospect id or
 * not. LP's "already set to supplied value" is `already_set_in_lp`: tag + a
 * one-line note, no card. The SKIP card stays for a GHL-origin DNC, and the
 * FAILED card for every real error.
 *
 * Action payload shape:
 *   {
 *     dnc_code: "P",        // Required. One of C/M/T/E/P, or "CLEAR"
 *     mode:     "clear",    // Optional alias for dnc_code "CLEAR" (2026-09-28)
 *     emp_id:   "5686",     // Optional. Defaults to 5686
 *     phone:    "+18135551234"  // Optional. Sent to LP for audit
 *   }
 *
 * Built 2026-05-01 in response to Charles Poulos
 * (orxWvmsoFzgCnsG0BL0R) — STOP-keyword DNC never reached LP.
 *
 * Phase 2 (2026-07-24) — CLEAR support (re-entry = new consent). A
 * `dnc_code: "CLEAR"` wipes the LP DNC flag (LP only supports a full clear,
 * not per-channel clears, so CLEAR removes all codes at once), then strips
 * EVERY `lp-dnc` / `lp-dnc:*` idempotency tag off the GHL contact. Those
 * tags MUST NOT survive a clear — a surviving `lp-dnc:t` would false-skip a
 * legitimate future DNC push (the hasDncTag idempotency guard). Pairs with
 * the inbound consent.reestablished emitter (sync-leads.js) and the
 * CONSENT_RENEWAL_ON_REENTRY rule. Compliance: a clear is only ever queued
 * off an audited consent.reestablished event — never silently.
 */

import { updateDncStatus as lpUpdateDncStatus, LP_DNC_CLEAR_CODE } from '../../lp-client.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote, applyGHLTag, removeGHLTags } from '../../ghl.js';
import { ghlFetch } from '../helpers.js';
import { resolveContactInfo } from '../resolvers.js';
import { buildRichNotification } from '../enrichment.js';
import { LP_EMP } from '../../lp-source-ids.js';

// ─── GHL custom field IDs ──────────────────────────────────────────
const FIELD_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87';
const FIELD_LP_LEAD_ID     = 'GmAVmW6V9sekD7pVONKr';

// Default LP employee ID. 5686 = "Integration, GoHighLevel" (GHL system
// user), confirmed working for the setAppointment chain. Sourced from the
// shared registry (src/lp-source-ids.js) as of 2026-08-01. Override per
// deployment via LP_DEFAULT_EMP_ID, or per-action via the emp_id payload.
const DEFAULT_EMP_ID = process.env.LP_DEFAULT_EMP_ID || LP_EMP.GHL_INTEGRATION;

const DNC_LABEL = {
  C: 'Do Not Call',
  M: 'Do Not Mail',
  T: 'Do Not Text',
  E: 'Do Not Email',
  P: 'Do Not Promote (master suppression)',
};

function readCF(contact, fieldId) {
  const arr = contact?.customFields || [];
  const f = arr.find(x => x.id === fieldId);
  return (f?.value !== undefined && f?.value !== null) ? String(f.value) : '';
}

function hasDncTag(contact, code) {
  const tags = contact?.tags || [];
  return tags.includes(`lp-dnc:${code.toLowerCase()}`);
}

// 2026-10-23 (lLiY0ptM6dZiRAdx34dA, LP prospect 350405) — a lead that arrives
// from LP already DNC gets `lp-dnc` / `stage:dnc` from LP_DISP_DNC, which then
// sets GHL DND and fires TAG_DNC_SMS_OPTOUT and RECONCILE_LP_DNC_ON_LINK. Each of
// those queued a push back to LP: two "LP DNC SKIP" cards (no prospect id yet)
// and one "LP DNC Pushed" card for a C that LP answered "already set to supplied
// value". An LP → GHL → LP echo, three cards, nothing new. `lp-dnc` means the
// DNC came FROM LP, so there is nothing to push.
// NOT `stage:dnc`, though LP_DISP_DNC sets it too: GHL's U.STOP Customer Replied
// Stop adds `stage:dnc` with `dnc-sms` on a customer's own STOP, and that STOP
// must still reach LP. Only rule 14 adds `lp-dnc` (every GHL workflow that names
// it only reads it, HL mirror 2026-10-23).
export const LP_ORIGIN_DNC_TAGS = ['lp-dnc'];

export function dncOriginatedInLP(contact) {
  const tags = (contact?.tags || []).map(t => String(t).toLowerCase());
  return LP_ORIGIN_DNC_TAGS.some(t => tags.includes(t));
}

// lp-client's updateDncStatus marks LP's "Current DNC status is already set to
// supplied value" reply as `already_set: true`; the message test covers a
// response that reaches us without the flag.
export function lpAlreadySet(lpResponse) {
  if (lpResponse?.already_set === true) return true;
  const message = String(lpResponse?.Message ?? lpResponse?.message ?? '');
  return /already set to supplied value/i.test(message);
}

const DEFAULT_DEPS = {
  ghlFetch,
  lpUpdateDncStatus,
  sendGroupMeMessage,
  addGHLNote,
  applyGHLTag,
  removeGHLTags,
  resolveContactInfo,
};

// The executor calls handler(action, context); `deps` is the third argument so
// the tests can swap the network out without colliding with that context.
export async function executeUpdateLPDNCStatus(action, _context, deps = {}) {
  const {
    ghlFetch, lpUpdateDncStatus, sendGroupMeMessage, addGHLNote, applyGHLTag, removeGHLTags, resolveContactInfo,
  } = { ...DEFAULT_DEPS, ...deps };
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  if (!contactId) {
    throw new Error('update_lp_dnc_status: target_id (GHL contact ID) is required');
  }

  // ─── Validate DNC code ─────────────────────────────────────────────
  // 2026-09-28 (Consent Model v1) — `mode: 'clear'` is an alias for
  // dnc_code: 'CLEAR', so the Slack DNC-lift batch can say what it means.
  // Same path, same LP call: LP has no per-code clear, so a clear wipes C
  // and T (and every other code) at once. LP_DNC_CLEAR_CODE is a single space,
  // LP's "blank" (see lp-client.js).
  const modeClear = String(payload.mode || '').trim().toLowerCase() === 'clear';
  const rawCode = modeClear ? 'CLEAR' : (payload.dnc_code || payload.newDncStatus || payload.code);
  if (!rawCode) {
    throw new Error('update_lp_dnc_status: action_payload.dnc_code is required (one of: C/M/T/E/P), or mode: "clear"');
  }
  const code = String(rawCode).trim().toUpperCase();
  const isClear = code === 'CLEAR';
  if (!isClear && !DNC_LABEL[code]) {
    throw new Error(`update_lp_dnc_status: invalid dnc_code "${rawCode}" (must be one of: C/M/T/E/P or CLEAR)`);
  }

  const empId = String(payload.emp_id || payload.empid || DEFAULT_EMP_ID);

  // ─── Fetch GHL contact ─────────────────────────────────────────────
  let ghlContact = null;
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    ghlContact = ghlRes?.contact || null;
  } catch (err) {
    throw new Error(`update_lp_dnc_status: GHL contact fetch failed for ${contactId}: ${err.message}`);
  }
  if (!ghlContact) {
    throw new Error(`update_lp_dnc_status: GHL contact ${contactId} not found`);
  }

  // ─── Resolve LP prospect ID (both push + clear paths) ──────────────
  const prospectId = readCF(ghlContact, FIELD_LP_PROSPECT_ID);
  const lpLeadId   = readCF(ghlContact, FIELD_LP_LEAD_ID);

  // ─── CLEAR path (Phase 2) — re-entry = new consent ─────────────────
  if (isClear) {
    return await clearLPDNC({ contactId, ghlContact, payload, empId, prospectId, lpLeadId }, {
      lpUpdateDncStatus, sendGroupMeMessage, addGHLNote, applyGHLTag, removeGHLTags, resolveContactInfo,
    });
  }

  // ─── Idempotency guard (push only) ─────────────────────────────────
  if (hasDncTag(ghlContact, code)) {
    console.log(`[LP-DNC] Skip: contact ${contactId} already has lp-dnc:${code.toLowerCase()} tag`);
    return {
      action: 'already_pushed',
      contact_id: contactId,
      dnc_code: code,
    };
  }

  // ─── LP-origin DNC: nothing to push back (2026-10-23) ──────────────
  // `lp-dnc` means LP is where the DNC came from. No LP call and
  // no card, with or without a prospect id; the code tag is written so the
  // next rule that queues this push stops at the idempotency guard above.
  if (dncOriginatedInLP(ghlContact)) {
    await applyGHLTag(contactId, `lp-dnc:${code.toLowerCase()}`).catch(err =>
      console.warn(`[LP-DNC] tag writeback failed (non-blocking): ${err.message}`));
    console.log(`[LP-DNC] Skip: contact ${contactId} DNC came from LP (lp-dnc tag), nothing to push for ${code}`);
    return {
      action: 'origin_lp_skip',
      contact_id: contactId,
      lp_prospect_id: prospectId || null,
      lp_lead_id: lpLeadId || null,
      dnc_code: code,
    };
  }

  if (!prospectId) {
    const { name } = await resolveContactInfo(contactId, {});
    const skipMsg = buildRichNotification({
      baseMessage: `LP DNC SKIP: contact has no LP prospect ID — DNC ${code} (${DNC_LABEL[code]}) cannot be pushed yet`,
      name,
      phone: ghlContact.phone || null,
      contactId,
      prospectId: null,
      enrichment: {
        lpLeadId: lpLeadId || null,
      },
    });
    await sendGroupMeMessage(skipMsg).catch(() => {});
    await addGHLNote(contactId,
      `[LP DNC v1.0] Skipped — contact has no LP prospect ID populated.\n` +
      `Cannot push DNC code "${code}" (${DNC_LABEL[code]}) until prospect ID exists.\n` +
      `${lpLeadId ? `(LP Lead ID is populated as ${lpLeadId} — sync may resolve this shortly.)\n` : ''}` +
      `Add the contact to LP via create_lp_lead, then re-fire the DNC event.`
    ).catch(() => {});
    console.warn(`[LP-DNC] SKIPPED ${contactId}: no LP prospect ID (lds=${lpLeadId || 'none'})`);
    return {
      action: 'skipped_no_prospect_id',
      contact_id: contactId,
      dnc_code: code,
      lp_lead_id: lpLeadId || null,
    };
  }

  // ─── POST TO LP ────────────────────────────────────────────────────
  const phone = ghlContact.phone ? String(ghlContact.phone) : undefined;
  let lpResponse;
  try {
    lpResponse = await lpUpdateDncStatus({
      custid:       prospectId,
      newDncStatus: code,
      empid:        empId,
      phone,
    });
  } catch (err) {
    const { name } = await resolveContactInfo(contactId, {});
    await applyGHLTag(contactId, 'lp-dnc-failed').catch(() => {});
    const failMsg = buildRichNotification({
      baseMessage: `LP DNC FAILED: ${code} (${DNC_LABEL[code]}) push to LP rejected`,
      name,
      phone,
      contactId,
      prospectId,
      enrichment: {
        lpLeadId: lpLeadId || null,
        empId,
      },
    });
    await sendGroupMeMessage(`${failMsg}\nError: ${String(err.message).slice(0, 250)}\nManual recovery may be required.`).catch(() => {});
    throw err;
  }

  // ─── Write success tag + GHL note ──────────────────────────────────
  try {
    await applyGHLTag(contactId, `lp-dnc:${code.toLowerCase()}`);
  } catch (err) {
    console.warn(`[LP-DNC] tag writeback failed (non-blocking): ${err.message}`);
  }

  // ─── LP already had it: a no-op, not news (2026-10-23) ─────────────
  // "Current DNC status is already set to supplied value" — LP changed
  // nothing, so no card. The tag above still stops the next push.
  if (lpAlreadySet(lpResponse)) {
    await addGHLNote(contactId, `[LP DNC v1.0] LP already had DNC ${code} — no change.`).catch(() => {});
    console.log(`[LP-DNC] DNC ${code} already set in LP for contact ${contactId} (prospect ${prospectId}), no card`);
    return {
      action: 'already_set_in_lp',
      contact_id: contactId,
      lp_prospect_id: prospectId,
      dnc_code: code,
      dnc_label: DNC_LABEL[code],
      emp_id: empId,
      lp_response: lpResponse,
    };
  }

  await addGHLNote(contactId,
    `[LP DNC v1.0] DNC pushed to Lead Perfection\n` +
    `Code: ${code} (${DNC_LABEL[code]})\n` +
    `LP Prospect ID: ${prospectId}\n` +
    `Set by: empid ${empId}\n` +
    `LP response: ${JSON.stringify(lpResponse).slice(0, 200)}`
  ).catch(() => {});

  // ─── Notify GroupMe ────────────────────────────────────────────────
  const { name } = await resolveContactInfo(contactId, {});
  const successMsg = buildRichNotification({
    baseMessage: `LP DNC Pushed: ${code} (${DNC_LABEL[code]})`,
    name,
    phone,
    contactId,
    prospectId,
    enrichment: {
      lpLeadId: lpLeadId || null,
      empId,
    },
  });
  await sendGroupMeMessage(successMsg).catch(() => {});

  console.log(`[LP-DNC] DNC ${code} pushed to LP for contact ${contactId} (prospect ${prospectId})`);

  return {
    action: 'lp_dnc_pushed',
    contact_id: contactId,
    lp_prospect_id: prospectId,
    dnc_code: code,
    dnc_label: DNC_LABEL[code],
    emp_id: empId,
    lp_response: lpResponse,
  };
}

// ─── CLEAR: wipe LP DNC + strip idempotency tags (re-entry = new consent) ──
//
// LP UpdateDNCStatus only supports a FULL clear (one clear code wipes every
// channel flag) — no per-channel clear. So CLEAR unconditionally clears LP
// and removes ALL `lp-dnc` / `lp-dnc:*` tags. Those tags are this handler's
// own push-idempotency markers; leaving even one behind would false-skip a
// later legitimate DNC push, so removal is mandatory, not best-effort hygiene.
//
// Compliance: a clear only ever runs off an audited consent.reestablished
// event (the audit trail). This function never deletes DNC history — the
// consent event + GHL note ARE the record of why the DNC was lifted.
async function clearLPDNC({ contactId, ghlContact, payload, empId, prospectId, lpLeadId }, {
  lpUpdateDncStatus, sendGroupMeMessage, addGHLNote, applyGHLTag, removeGHLTags, resolveContactInfo,
}) {
  const source = payload.source || payload.lead_source || payload.reason || 'inbound';
  const phone = ghlContact.phone ? String(ghlContact.phone) : undefined;

  // 1. Wipe the LP-side DNC flag (only if we have a prospect to clear).
  let lpResponse = null;
  if (prospectId) {
    try {
      lpResponse = await lpUpdateDncStatus({
        custid:       prospectId,
        newDncStatus: 'CLEAR',
        empid:        empId,
        phone,
      });
    } catch (err) {
      // No group card (2026-10-02, the user's ruling). LP refuses every clear
      // value tried so far, so this fired on every lift — and once per executor
      // retry, three times each: 34 of the last 100 posts in Reece Lead
      // Intelligence were this card. The tag, the log line and the failed
      // action row stay; the DNC-lift thread reply tells the approver LP needs
      // a manual clear.
      await applyGHLTag(contactId, 'lp-dnc-clear-failed').catch(() => {});
      console.warn(`[LP-DNC] CLEAR failed for contact ${contactId} (prospect ${prospectId}, empid ${empId}): ${String(err.message).slice(0, 250)}`);
      throw err;
    }
  }

  // 2. Strip EVERY lp-dnc / lp-dnc:* idempotency tag (must not survive a clear).
  const dncTags = (ghlContact.tags || []).filter(
    t => t === 'lp-dnc' || String(t).toLowerCase().startsWith('lp-dnc:')
  );
  if (dncTags.length) {
    await removeGHLTags(contactId, dncTags).catch(err =>
      console.warn(`[LP-DNC] CLEAR tag removal failed (non-blocking): ${err.message}`));
  }

  // 3. GHL note — audit record of the lift.
  await addGHLNote(contactId,
    `[LP DNC] Cleared — consent re-established via new inbound (${source})\n` +
    (prospectId
      ? `LP Prospect ID: ${prospectId} — DNC wiped with a single-space newDncStatus (empid ${empId})\n`
      : `No LP prospect ID on contact — no LP-side DNC to clear.\n`) +
    `Removed idempotency tags: ${dncTags.length ? dncTags.join(', ') : '(none present)'}\n` +
    (prospectId && lpResponse ? `LP response: ${JSON.stringify(lpResponse).slice(0, 200)}` : '')
  ).catch(() => {});

  // 4. GroupMe notice (intelligence-class event).
  const { name } = await resolveContactInfo(contactId, {});
  const clearMsg = buildRichNotification({
    baseMessage: `LP DNC CLEARED — consent re-established (${source})`,
    name,
    phone,
    contactId,
    prospectId,
    enrichment: { lpLeadId: lpLeadId || null, empId },
    headerEmoji: '♻️',
  });
  await sendGroupMeMessage(clearMsg, { flushNow: true }).catch(() => {});

  console.log(
    `[LP-DNC] CLEAR done for contact ${contactId} ` +
    `(prospect ${prospectId || 'none'}) — removed ${dncTags.length} lp-dnc tag(s), source=${source}`
  );

  return {
    action: 'lp_dnc_cleared',
    contact_id: contactId,
    lp_prospect_id: prospectId || null,
    lp_lead_id: lpLeadId || null,
    clear_code: LP_DNC_CLEAR_CODE,
    removed_tags: dncTags,
    source,
    lp_response: lpResponse,
  };
}
