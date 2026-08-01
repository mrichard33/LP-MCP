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
 * Action payload shape:
 *   {
 *     dnc_code: "P",        // Required. One of C/M/T/E/P, or "CLEAR"
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

export async function executeUpdateLPDNCStatus(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  if (!contactId) {
    throw new Error('update_lp_dnc_status: target_id (GHL contact ID) is required');
  }

  // ─── Validate DNC code ─────────────────────────────────────────────
  const rawCode = payload.dnc_code || payload.newDncStatus || payload.code;
  if (!rawCode) {
    throw new Error('update_lp_dnc_status: action_payload.dnc_code is required (one of: C/M/T/E/P)');
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
    return await clearLPDNC({ contactId, ghlContact, payload, empId, prospectId, lpLeadId });
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
async function clearLPDNC({ contactId, ghlContact, payload, empId, prospectId, lpLeadId }) {
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
      const { name } = await resolveContactInfo(contactId, {});
      await applyGHLTag(contactId, 'lp-dnc-clear-failed').catch(() => {});
      const failMsg = buildRichNotification({
        baseMessage: `LP DNC CLEAR FAILED: could not wipe LP DNC (clear code ${LP_DNC_CLEAR_CODE})`,
        name,
        phone,
        contactId,
        prospectId,
        enrichment: { lpLeadId: lpLeadId || null, empId },
      });
      await sendGroupMeMessage(
        `${failMsg}\nError: ${String(err.message).slice(0, 250)}\n` +
        `Clear code may be wrong — confirm LP_DNC_CLEAR_CODE via a safe probe. Manual recovery may be required.`,
        { flushNow: true },
      ).catch(() => {});
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
      ? `LP Prospect ID: ${prospectId} — DNC wiped with clear code ${LP_DNC_CLEAR_CODE} (empid ${empId})\n`
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
