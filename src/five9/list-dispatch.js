/**
 * Five9 List Dispatch — src/five9/list-dispatch.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * BREAK-GLASS ONLY (architecture decision, Mark, 2026-08-18). Lead
 * Perfection is the ONLY writer into the Five9 LP_ASAP list; the agentic
 * system never inserts records into Five9 lists. The dialer feed
 * (POST /api/Downloads/GetLeadsByCQDID) carries Cst_ID + Lds_ID — the LP
 * identifiers that tie a dialed record back to the LP lead and drive the
 * agent's preview screen pop and the AddCallHistory write-back. A record
 * written directly through this module carries NO Cst_ID/Lds_ID: it is an
 * orphan the agent cannot work, and because LP_ASAP is LP-fed, LP may
 * match and overwrite it (observed live: agent_action 330019 wrote
 * 2246501321 into LP_ASAP "successfully" and the list size never changed —
 * Five9 UPDATED an existing LP-owned record). When a lead should be
 * dialed, make the LP push correct and let LP feed LP_ASAP → DIAL ASAP;
 * latency is not a reason to bypass LP (lead 567746: LP creation to dial
 * in 4 seconds).
 *
 * This module's ONLY remaining legitimate role: LP unreachable AND a call
 * already promised to a customer. Any use of it is an INCIDENT, not a
 * workflow. Do not extend it, do not wire dispatchConfirmationCallback
 * into the callback path, do not set FIVE9_DIRECT_DISPATCH, and do not
 * build an auto-approve carve-out for five9_add_records_to_list.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Write-side Five9 Configuration Web Services (Admin SOAP) client for the
 * direct confirmation-callback dispatch. DORMANT unless FIVE9_DIRECT_DISPATCH
 * is explicitly 'true' AND both FIVE9_CALLBACK_LIST and
 * FIVE9_CALLBACK_CAMPAIGN are set (the campaign name is not used in any SOAP
 * call — requiring it is a deliberate "owner finished the Five9-side config"
 * interlock, and it is echoed in notes/logs).
 *
 * When live, the call-time Conf Call dispatch (see the
 * /webhook/ghl/set-lp-appointment route in lp-appointment-sync.js) inserts
 * the callback into the Five9 list via addRecordToList and skips the LP
 * Dial-ASAP send entirely. Any Five9 failure throws — the caller falls back
 * to the LP path and fires a priority GroupMe; a promised call is never
 * silently dropped. The first dispatch attempt doubles as the permission
 * preflight (five9SoapCall self-diagnoses the missing "Administrator
 * Services" role in its fault parsing).
 *
 * List records map to DOMAIN contact fields via listUpdateSettings
 * .fieldsMapping. number1/first_name/last_name always exist; the four custom
 * fields (call_purpose, requested_time, ghl_contact_id, notes) must be
 * created by the owner in the Five9 admin UI (owner checklist). We verify
 * them read-only via getContactFields once per process and degrade the
 * record's richness — never block the callback — when some are missing.
 * We deliberately do NOT auto-createContactField: that mutates domain-global
 * schema and needs a broader permission grant than list writes.
 *
 * Reuses five9SoapCall/escapeXml from five9-admin.js (same endpoint, same
 * Basic-auth credential path as five9_get_campaigns — extended, not
 * duplicated).
 */

import { five9SoapCall, escapeXml } from '../five9-admin.js';
import { getGHLContact } from '../ghl.js';

// Standard Five9 contact fields that always exist. number1 is the dial key.
const STANDARD_FIELDS = ['number1', 'first_name', 'last_name'];

// Custom contact fields the owner creates in the VCC admin UI. Order matters:
// it defines the record's column order after the standard trio.
const CUSTOM_FIELDS = ['call_purpose', 'requested_time', 'ghl_contact_id', 'notes'];

export function five9DispatchConfigured() {
  return (process.env.FIVE9_DIRECT_DISPATCH || 'false') === 'true'
    && !!process.env.FIVE9_CALLBACK_LIST
    && !!process.env.FIVE9_CALLBACK_CAMPAIGN
    && !!process.env.FIVE9_USERNAME
    && !!process.env.FIVE9_PASSWORD;
}

// Boot-time visibility for a dormant feature: one config line, no network
// call, never the password.
if ((process.env.FIVE9_DIRECT_DISPATCH || 'false') === 'true') {
  console.log(
    `[Five9Dispatch] FIVE9_DIRECT_DISPATCH=true — list="${process.env.FIVE9_CALLBACK_LIST || '(unset)'}", ` +
    `campaign="${process.env.FIVE9_CALLBACK_CAMPAIGN || '(unset)'}", creds=${!!(process.env.FIVE9_USERNAME && process.env.FIVE9_PASSWORD)}` +
    (five9DispatchConfigured() ? '' : ' — INCOMPLETE CONFIG, dispatch stays on the LP path')
  );
}

// ─── ensureListExists (memoized, code-managed list) ────────────────

const listEnsured = new Map(); // listName -> Promise<true>

export function ensureListExists(listName) {
  if (!listEnsured.has(listName)) {
    const p = (async () => {
      try {
        await five9SoapCall('createList', `<listName>${escapeXml(listName)}</listName>`);
        console.log(`[Five9Dispatch] created list "${listName}"`);
      } catch (err) {
        if (isAlreadyExistsFault(err.message)) {
          console.log(`[Five9Dispatch] list "${listName}" already exists — ok`);
        } else {
          throw err;
        }
      }
      return true;
    })();
    // Real failure → evict so the next dispatch retries instead of caching
    // a rejected promise forever.
    p.catch(() => listEnsured.delete(listName));
    listEnsured.set(listName, p);
  }
  return listEnsured.get(listName);
}

// Five9 wsadmin fault text for a duplicate list varies by VCC version —
// match broadly. Exported for tests.
export function isAlreadyExistsFault(message) {
  return /alread?y\s+exist|same\s+name|duplicate/i.test(String(message || ''));
}

// ─── Custom contact-field verification (read-only, memoized) ───────

let contactFieldsPromise = null;

async function verifyContactFields() {
  if (!contactFieldsPromise) {
    contactFieldsPromise = (async () => {
      const xml = await five9SoapCall('getContactFields');
      const domainFields = new Set(
        [...xml.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim().toLowerCase())
      );
      const present = CUSTOM_FIELDS.filter(f => domainFields.has(f));
      const missing = CUSTOM_FIELDS.filter(f => !domainFields.has(f));
      if (missing.length) {
        console.warn(
          `[Five9Dispatch] custom contact fields missing in Five9 domain: ${missing.join(', ')} — ` +
          `records will carry only [${STANDARD_FIELDS.concat(present).join(', ')}]. ` +
          `Create them in VCC Admin → Contact Fields (owner checklist).`
        );
      }
      return present;
    })();
    contactFieldsPromise.catch(() => { contactFieldsPromise = null; });
  }
  return contactFieldsPromise;
}

// ─── addRecordToList ───────────────────────────────────────────────

/**
 * Pure SOAP-body builder for addRecordToList — exported so tests can
 * snapshot the exact envelope without network. fieldNames and values must be
 * parallel arrays; column numbers are assigned in order and number1 (column
 * 1) is the key.
 */
export function buildAddRecordToListXml(listName, fieldNames, values) {
  if (fieldNames.length !== values.length) {
    throw new Error(`fieldsMapping/values mismatch: ${fieldNames.length} fields vs ${values.length} values`);
  }
  const mappings = fieldNames.map((name, i) =>
    `<fieldsMapping><columnNumber>${i + 1}</columnNumber>` +
    `<fieldName>${escapeXml(name)}</fieldName>` +
    `<key>${name === 'number1'}</key></fieldsMapping>`
  ).join('');
  const records = values.map(v => `<values>${escapeXml(v ?? '')}</values>`).join('');
  return (
    `<listName>${escapeXml(listName)}</listName>` +
    `<listUpdateSettings>${mappings}` +
    `<crmAddMode>ADD_NEW</crmAddMode>` +
    `<crmUpdateMode>UPDATE_FIRST</crmUpdateMode>` +
    `<listAddMode>ADD_FIRST</listAddMode>` +
    `</listUpdateSettings>` +
    `<record>${records}</record>`
  );
}

/**
 * Insert one callback record into FIVE9_CALLBACK_LIST. Throws on any Five9
 * failure (auth, permission, fault, or a nonzero per-record failure counter
 * in the response) — the caller owns the LP fallback.
 */
export async function addCallbackToList({ phone, firstName, lastName, callPurpose, requestedTime, ghlContactId, notes }) {
  const listName = process.env.FIVE9_CALLBACK_LIST;
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) {
    throw new Error(`callback record has no dialable phone (got "${phone}")`);
  }

  let customPresent = [];
  try {
    customPresent = await verifyContactFields();
  } catch (err) {
    // Field verification is best-effort — fall back to the standard trio
    // rather than failing the dispatch on a getContactFields hiccup.
    console.warn(`[Five9Dispatch] getContactFields failed (${err.message}) — sending standard fields only`);
  }

  const byName = {
    number1: digits,
    first_name: firstName || '',
    last_name: lastName || '',
    call_purpose: callPurpose || '',
    requested_time: requestedTime || '',
    ghl_contact_id: ghlContactId || '',
    notes: notes || '',
  };
  const fieldNames = STANDARD_FIELDS.concat(customPresent);
  const values = fieldNames.map(f => byName[f]);

  const xml = await five9SoapCall('addRecordToList', buildAddRecordToListXml(listName, fieldNames, values));

  // The import result reports per-record failure counters. A record that
  // silently fails to import is a dropped promised call — treat as an error.
  const failTag = /<(failuresCount|failedToImport|failedRecords)>(\d+)<\/\1>/i.exec(xml);
  if (failTag && Number(failTag[2]) > 0) {
    throw new Error(`Five9 addRecordToList reported ${failTag[2]} failed record(s) for list "${listName}"`);
  }

  console.log(`[Five9Dispatch] ✅ callback record added to "${listName}" (fields: ${fieldNames.join(', ')})`);
  return { list: listName, fields: fieldNames };
}

// ─── Orchestrator: the route calls only this ───────────────────────

async function readCallPurpose(contactId) {
  const fieldId = process.env.CALL_PURPOSE_FIELD_ID;
  if (!fieldId || !contactId) return null;
  try {
    const contact = await getGHLContact(contactId);
    const v = (contact?.customFields || []).find(f => f.id === fieldId)?.value;
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

/**
 * Queue a confirmation callback directly in Five9. Throws on ANY failure —
 * the caller (the set-lp-appointment route) falls back to the LP Dial-ASAP
 * path and alerts. Returns dispatch metadata for the note/response.
 */
export async function dispatchConfirmationCallback({ contactId, contactName, contactPhone, appointmentDate, appointmentTime, calendarName }) {
  await ensureListExists(process.env.FIVE9_CALLBACK_LIST);
  const callPurpose = await readCallPurpose(contactId);
  const [first, ...rest] = String(contactName || '').trim().split(/\s+/);
  await addCallbackToList({
    phone: contactPhone,
    firstName: first || '',
    lastName: rest.join(' '),
    callPurpose,
    requestedTime: [appointmentDate, appointmentTime].filter(Boolean).join(' '),
    ghlContactId: contactId,
    notes: `GHL Confirmation Call — calendar "${calendarName || 'Confirmation Call'}"`,
  });
  return {
    list: process.env.FIVE9_CALLBACK_LIST,
    campaign: process.env.FIVE9_CALLBACK_CAMPAIGN,
    call_purpose: callPurpose,
  };
}
