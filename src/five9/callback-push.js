/**
 * Five9 Callback Push — src/five9/callback-push.js
 *
 * Builds the ONE contact record that lp_callback_requeue pushes into the Five9
 * "Callback Request" list, and the cross-list check that stops us dialing
 * someone two campaigns are already working.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS — and why it is not the thing list-dispatch.js was banned for
 *
 * Until 2026-09-04 lp_callback_requeue answered a callback request with an LP
 * LeadAdd, because "the push IS the dial trigger": LP creates the lead, LP
 * feeds LP_ASAP, DIAL ASAP dials. That works, and it also creates a NEW LP LEAD
 * every time. On 2026-09-04 it created lead 573111 for Robert Pederson
 * (zLDD7V1eosF8vldF5U7i), which landed in LP's Data queue and triggered LP's
 * own Revin bot to send new-lead intake copy to a customer who was sitting at
 * home waiting for an appointment we had already cancelled.
 *
 * The dedup was not the problem and is not what changed here — PR #823 fixed
 * that, and of the four fires that day only one performed a LeadAdd. The defect
 * is that ONE correct re-queue still mints a duplicate lead. This module
 * removes the LeadAdd from the path entirely: LP stays the system of record for
 * contact data, and Five9 gets a dialing copy only.
 *
 * src/five9/list-dispatch.js carries a 2026-08-18 decision forbidding exactly
 * this. Mark superseded it on 2026-09-04; read the rewritten banner there for
 * what changed. The short version is that its two objections were specific, and
 * both are answered:
 *
 *   1. "LP may match and overwrite it." True of LP_ASAP, which LP FEEDS.
 *      "Callback Request" is API-fed only, so there is no LP writer to race.
 *      LP_ASAP remains off-limits to direct writes.
 *   2. "No Cst_ID/Lds_ID — an orphan the agent cannot work." True of
 *      list-dispatch as written: its CUSTOM_FIELDS were call_purpose /
 *      requested_time / ghl_contact_id / notes, and NOT ONE of those exists in
 *      the Five9 contact schema, so every record it wrote silently degraded to
 *      number1 + first_name + last_name. The domain does carry CustID,
 *      lead_id, LPRecKey and LPRecType. Populating them is what closes the
 *      objection, and it is why this module refuses to push without CustID.
 *
 * THE SCREEN POP IS THE WHOLE POINT. The LeadPerfection web connector fires
 * OnCallAccepted with F9key=CustID and reads the FIVE9 CONTACT RECORD, not LP's
 * dialer feed. So CustID is not decoration — it is the only thing that makes
 * the agent's screen open the right customer. A record without it is the orphan
 * the banner warned about, which is why buildCallbackRecord throws rather than
 * pushing a partial record and letting an agent discover the gap on the call.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHAT WE DO NOT WRITE
 *
 * Five9 owns Last Agent, Contact create time and date, Number of attempts,
 * f9_last_list, f9_last_campaign, f9_last_dispo_date_time and the three
 * UUID-named variables. "Contact create time and date" matters most: it is what
 * the Callback Request profile's 48-HOURS-Ago filter reads. Setting it
 * ourselves risks a record born outside its own filter that never dials.
 *
 * cqd_id is also deliberately absent. The Data_Hot_Sample export shows 51 on
 * every row, but LP's stored values for those same leads are 8, 31 and 51 — it
 * is the queue that last fed the lead, a property of LP's feed rather than of
 * the lead. We are not using that feed.
 */

import { getContactRecords } from '../five9-admin.js';

/** Default list name. Overridable so a test run can target a scratch list. */
export const DEFAULT_CALLBACK_LIST = 'Callback Request';

/**
 * Five9-owned fields. Asserted against in tests so a future edit cannot quietly
 * start writing one — the failure mode (a record outside its own 48h filter)
 * is invisible until someone notices callbacks never dialing.
 */
export const FIVE9_OWNED_FIELDS = Object.freeze([
  'Last Agent',
  'Contact create time and date',
  'Number of attempts',
  'f9_last_list',
  'f9_last_campaign',
  'f9_last_dispo_date_time',
  '2c005aba-a290-41ec-9e22-0b97d28fb370',
  '7b179379-e390-468c-b5a6-3c4b9fc72d7d',
  '2c65a2d5-6a8d-44f8-9b72-8303c905ee91',
]);

/* --- env, read per call so Railway can retune without a deploy ---------- */

export function callbackListName() {
  return String(process.env.FIVE9_CALLBACK_LIST_NAME || DEFAULT_CALLBACK_LIST).trim() || DEFAULT_CALLBACK_LIST;
}

/**
 * callNowMode for the push. ANY by default, per Mark 2026-09-04.
 *
 * This is what makes the record DIAL rather than sit until the next list pass;
 * see buildAddRecordToListXml in admin-writes.js for the WSDL detail. ANY
 * rather than NEW_LIST_ONLY because crmUpdateMode is UPDATE_FIRST: a contact
 * Five9's CRM already knows can be treated as an update rather than a new list
 * record, and under NEW_LIST_ONLY that record would never be marked call-now —
 * the promise silently unkept, which is the exact failure this path exists to
 * prevent. Set FIVE9_CALLBACK_CALL_NOW_MODE=NONE to append without dialing.
 */
export function callbackCallNowMode() {
  const raw = String(process.env.FIVE9_CALLBACK_CALL_NOW_MODE || 'ANY').trim().toUpperCase();
  return raw || 'ANY';
}

/**
 * LPRecType. OMITTED unless explicitly configured — Mark's ruling 2026-09-04.
 *
 * Every row of the Data_Hot_Sample export reads 'cst', but that export was a
 * CUSTOMER list, so it is evidence about customers and not about callbacks.
 * Other campaigns filter ON this value, so a wrong guess does not degrade this
 * record — it leaks the record into another campaign's filter and gets the
 * customer dialed by the wrong team. Sending nothing cannot match any filter,
 * and the screen pop keys on CustID, so nothing here needs it.
 */
export function callbackLpRecType() {
  const raw = String(process.env.FIVE9_CALLBACK_LPRECTYPE || '').trim();
  return raw || null;
}

/* --- record construction ------------------------------------------------ */

/** Ten digits, no +1, no punctuation — the shape every sample row carries. */
export function normalizeNumber1(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * LPRecKey is 'INQ' + the LP inbound id. Confirmed 6/6 against the
 * Data_Hot_Sample export on 2026-09-04 (571758→INQ419729, 571829→INQ419681,
 * 572314→INQ420255, 572416→INQ420336, 572463→INQ420359, 572910→INQ420775).
 *
 * Returns null when in1_id is blank, which is NOT an error: a lead a setter
 * created directly in LP has no inbound record at all (573055 is one). The
 * connector degrades gracefully on a blank LPRecKey — it keys on CustID — so
 * the field is omitted rather than sent as the meaningless string 'INQ'.
 */
export function deriveLpRecKey(in1Id) {
  const id = String(in1Id ?? '').trim();
  return id ? `INQ${id}` : null;
}

/**
 * Build the field/value pair of arrays for one callback record.
 *
 * Pure and offline — every Five9 and GHL read happens before this is called,
 * so the mapping itself is testable without a network.
 *
 * @throws when CustID cannot be resolved. Deliberately loud: see the header.
 */
export function buildCallbackRecord({ contactId, ghlContact = {}, lpRow = {} }) {
  const custId = String(lpRow.lp_prospect_id ?? '').trim();
  if (!custId) {
    throw new Error(
      `five9 callback push: no CustID (lp_prospect_id) for contact ${contactId} — refusing to push a record ` +
      `the agent cannot open in LP. The LeadPerfection screen pop keys on CustID (F9key=CustID); without it ` +
      `the agent gets a blank screen on a call we promised.`
    );
  }

  const number1 = normalizeNumber1(ghlContact.phone);
  if (!number1) {
    throw new Error(`five9 callback push: contact ${contactId} has no usable 10-digit phone — nothing to dial`);
  }

  // Insertion order is the fieldsMapping order; Five9 pairs it positionally
  // with the values array, so these two must be built together and stay
  // aligned. Optional fields are appended only when they have a value, which
  // keeps a blank from overwriting something Five9 already holds.
  const pairs = [
    ['number1', number1],
    ['first_name', String(ghlContact.firstName || '').trim()],
    ['last_name', String(ghlContact.lastName || '').trim()],
    ['street', String(ghlContact.address1 || lpRow.address || '').trim()],
    ['city', String(ghlContact.city || lpRow.city || '').trim()],
    ['state', String(ghlContact.state || lpRow.state || '').trim()],
    ['zip', String(ghlContact.postalCode || lpRow.zip || '').trim()],
    ['email', String(ghlContact.email || '').trim()],
    ['CustID', custId],
    ['lead_id', String(lpRow.lp_lead_id ?? '').trim()],
    // Reconciliation only — displayAs Invisible, mapTo None, empty in every
    // sample row. The GHL contact id has no other home in the 26-field schema,
    // and overloading a visible field (company, say) to carry it would put an
    // opaque id in front of an agent mid-call.
    ['call_ID', String(contactId || '').trim()],
  ];

  const lpRecKey = deriveLpRecKey(lpRow?.raw_lp_data?.in1_id);
  if (lpRecKey) pairs.push(['LPRecKey', lpRecKey]);

  const lpRecType = callbackLpRecType();
  if (lpRecType) pairs.push(['LPRecType', lpRecType]);

  const kept = pairs.filter(([, v]) => v !== '' && v != null);
  return {
    fieldNames: kept.map(([k]) => k),
    values: kept.map(([, v]) => String(v)),
    custId,
    number1,
    lpRecKey,
    lpRecType,
  };
}

/* --- cross-list suppression --------------------------------------------- */

/**
 * Is this number already live in a Five9 list other than the callback list?
 *
 * The same person in LP_ASAP and Callback Request is two campaigns, two agents,
 * the same afternoon — from the customer's side, being called twice about the
 * same thing by people who evidently do not talk to each other.
 *
 * FAILS OPEN, deliberately, and in the opposite direction from the CustID
 * refusal above. A missing CustID means the record would be UNWORKABLE, so we
 * refuse. A Five9 read that errors tells us nothing either way, and the cost of
 * guessing wrong is asymmetric: suppressing on an unreadable list means a
 * promised call never happens, which is the harm this whole action exists to
 * prevent. A duplicate dial is an annoyance; silence is the failure.
 *
 * @returns {Promise<{suppress: boolean, lists: string[], failed_open: boolean, error: string|null}>}
 */
export async function findContactInOtherLists(number1, { listName = null, deps = {} } = {}) {
  const ours = listName || callbackListName();
  const read = deps.getContactRecords || getContactRecords;
  try {
    const res = await read([{ field: 'number1', value: number1 }]);
    const records = Array.isArray(res?.records) ? res.records : [];
    // f9_last_list is Five9's own LastList mapping — the list that last worked
    // this contact. It is the only list membership a contact-DB read exposes.
    const lists = [...new Set(
      records
        .map((r) => String(r?.f9_last_list ?? '').trim())
        .filter((l) => l && l !== ours),
    )];
    return { suppress: lists.length > 0, lists, failed_open: false, error: null };
  } catch (err) {
    return { suppress: false, lists: [], failed_open: true, error: String(err?.message || err) };
  }
}

export default { buildCallbackRecord, findContactInOtherLists, callbackListName };
