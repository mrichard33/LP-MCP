/**
 * Resolvers — src/actions/resolvers.js
 *
 * Contact name/phone resolution, LP prospect ID resolution, event context
 * retrieval. Extracted from action-executor.js v4.2 refactor.
 *
 * Resolution fallback chains are preserved exactly as v3.5–v3.9:
 *   resolveContactInfo: LP Lead (numeric) → GHL → LP cache → payload name
 *   resolveLPProspectId: LP Lead → LP API live → cached prospect_id
 *
 * v3.11 (2026-06-11) — GHL CONTACT CONTEXT + PROSPECT-ID WRITE-BACK.
 *   1. resolveContactInfo now returns `ghlContact` — a slim snapshot of
 *      the GHL contact it ALREADY fetches (tags, city, postalCode,
 *      customFields). Downstream consumers (enrichment.js v5.0 market /
 *      loss-reason / calculator-field resolution, resolveLPProspectId)
 *      reuse it instead of refetching, saving one GHL API call per
 *      notification.
 *   2. resolveLPProspectId accepts an optional { ghlContact } and, when
 *      the prospect ID is resolved from LP (API or cache) but the GHL
 *      custom field ZRQAVrzhtzApzLlHmT87 is EMPTY, writes the resolved
 *      ID back to the GHL contact (fire-and-forget, via the same
 *      updateGHLContactFields path the update_custom_fields action uses
 *      — custom-fields-only PUT, never touches tags). Per Mark's
 *      2026-06-11 directive: "Prospect ID — if not present we should be
 *      able to get and then save back to the GHL Contact." This is the
 *      self-healing that v3.10 deliberately deferred.
 *
 * v3.10 (2026-05-04) — GHL CUSTOM FIELD FALLBACK in resolveLPProspectId.
 *   PROBLEM: lp_leads cache has 100% prospect_id coverage (204K rows) but
 *   only 1.03% (2,100 rows) have ghl_contact_id populated. Calling
 *   resolveLPProspectId with a GHL contact ID short-circuited to
 *   'Not in LP' for 99% of contacts because the
 *     SELECT FROM lp_leads WHERE ghl_contact_id = ?
 *   lookup missed, leaving lpLeadId null and skipping the LP API path
 *   entirely. End result: GroupMe notifications rendered "Prospect: NONE"
 *   for nearly every contact, even when GHL had the prospect ID right
 *   there in custom field ZRQAVrzhtzApzLlHmT87.
 *
 *   FIX: When the cache + LP API paths produce nothing AND the contactId
 *   is a GHL ID (not numeric LP lead ID), GET the GHL contact and read
 *   the LP Prospect ID custom field directly.
 */

import supabase from '../supabase.js';
import { getLeadByLdsId } from '../lp-client.js';
import { updateGHLContactFields } from '../ghl.js';
import { isLPLeadId, ghlFetch } from './helpers.js';
// 2026-09-21 — NANP-strict normalizer (10 digits, [2-9] leading, or null).
// Deliberately the outbound guard's copy, not sync-utils' looser
// replace(/\D/g,''): a DNC write must never carry a 7-digit or 12-digit
// string that Five9 would silently store as a number nobody owns.
import { normalizePhone as normalizeNanpPhone } from '../outbound-phone-guard.js';

const LP_LEAD_COLUMNS =
  'lp_lead_id, lp_prospect_id, ghl_contact_id, first_name, last_name, phone, ' +
  'city, zip, lead_source, lead_source_detail, disposition_code, disposition_label, rep_name, ' +
  // lp_branch_id (2026-09-21) is the market of THIS lead. resolveMarketCode
  // prefers it over the contact-level GHL field, which is a rollup across
  // every branch a prospect has ever been in and cannot route a card.
  'lp_branch_id, appointment_set, appointment_date, demo_completed';

// v3.10 — GHL custom field IDs used in the prospect-ID fallback. Mirrors
// lp-dnc.js. Single source of truth for the field ID lives in the project's
// architecture doc; if GHL ever rotates the field, update both files.
const FIELD_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87';

// v3.11 — slim GHL contact snapshot returned by resolveContactInfo so
// downstream consumers don't refetch. Only the fields notification
// enrichment actually uses.
function slimGhlContact(c) {
  if (!c) return null;
  return {
    id: c.id || null,
    tags: Array.isArray(c.tags) ? c.tags : [],
    city: c.city || null,
    postalCode: c.postalCode || c.postal_code || null,
    customFields: Array.isArray(c.customFields) ? c.customFields : [],
    // 2026-09-11 — the contact's owning GHL user. create_task defaults its
    // assignee from this when a rule didn't name one; carried on the snapshot
    // so that costs zero extra API calls.
    assignedTo: c.assignedTo || c.assigned_to || null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// CONTACT + LP PROSPECT RESOLVER — with guaranteed fallback chain
// ═══════════════════════════════════════════════════════════════════

export async function resolveContactInfo(contactId, eventContext = {}) {
  if (!contactId) return { name: 'Unknown', phone: null, ghlContactId: null, lpLead: null, ghlContact: null };

  if (isLPLeadId(contactId)) {
    let lpLeadRow = null;
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select(LP_LEAD_COLUMNS)
        .eq('lp_lead_id', contactId)
        .maybeSingle();
      if (lpLead) {
        lpLeadRow = lpLead;
        const name = [lpLead.first_name, lpLead.last_name].filter(Boolean).join(' ') || null;
        if (name) return { name, phone: lpLead.phone || null, ghlContactId: lpLead.ghl_contact_id || null, lpLead: lpLeadRow, ghlContact: null };
      }
    } catch {}
    try {
      const result = await getLeadByLdsId(contactId);
      const prospects = Array.isArray(result) ? result : [result];
      for (const p of prospects) {
        if (!p) continue;
        const name = [p.FirstName || p.firstname, p.LastName || p.lastname].filter(Boolean).join(' ') || null;
        if (name) return { name, phone: p.Phone || p.phone || null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow, ghlContact: null };
      }
    } catch {}
    const payloadName = eventContext.contactName || eventContext.contact_name || eventContext.lead_name || eventContext.leadName || null;
    if (payloadName) return { name: payloadName, phone: null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow, ghlContact: null };
    return { name: `LP Lead ${contactId}`, phone: null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow, ghlContact: null };
  }

  let lpLeadRow = null;
  try {
    const { data: lpLead } = await supabase.from('lp_leads')
      .select(LP_LEAD_COLUMNS)
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    if (lpLead) lpLeadRow = lpLead;
  } catch {}

  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const c = ghlRes?.contact || {};
    const ghlContact = slimGhlContact(c);
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null;
    const phone = c.phone || null;
    if (name) return { name, phone, ghlContactId: contactId, lpLead: lpLeadRow, ghlContact };
    // Name missing but fetch succeeded — still hand back the contact
    // snapshot so enrichment can use tags / fields.
    if (ghlContact) {
      const fallbackName = lpLeadRow
        ? [lpLeadRow.first_name, lpLeadRow.last_name].filter(Boolean).join(' ') || contactId
        : contactId;
      return { name: fallbackName, phone: phone || lpLeadRow?.phone || null, ghlContactId: contactId, lpLead: lpLeadRow, ghlContact };
    }
  } catch {}

  if (lpLeadRow) {
    const name = [lpLeadRow.first_name, lpLeadRow.last_name].filter(Boolean).join(' ') || null;
    if (name) return { name, phone: lpLeadRow.phone || null, ghlContactId: contactId, lpLead: lpLeadRow, ghlContact: null };
  }

  const payloadName = eventContext.contactName || eventContext.contact_name || eventContext.lead_name || eventContext.leadName || null;
  if (payloadName && payloadName !== contactId) {
    return { name: payloadName, phone: null, ghlContactId: contactId, lpLead: lpLeadRow, ghlContact: null };
  }

  return { name: contactId, phone: null, ghlContactId: contactId, lpLead: lpLeadRow, ghlContact: null };
}

// v3.10 — extract the LP Prospect ID from a GHL contact's customFields
// array. Defensive: empty values, sentinel strings, and non-string types
// all collapse to null so callers can treat null === "not present".
function readProspectIdFromGhlCustomFields(contact) {
  const arr = contact?.customFields || [];
  const f = arr.find(x => x.id === FIELD_LP_PROSPECT_ID);
  if (!f) return null;
  const raw = f.value;
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/**
 * v3.11 — fire-and-forget write-back of a resolved prospect ID to the GHL
 * custom field. Custom-fields-only PUT (same path as the
 * update_custom_fields action handler) — never touches tags or other
 * standard fields. Errors are logged and swallowed; the notification
 * pipeline must never fail because a write-back did.
 */
function writeBackProspectId(contactId, pid, source) {
  updateGHLContactFields(contactId, [{ id: FIELD_LP_PROSPECT_ID, field_value: String(pid) }])
    .then((result) => {
      if (result && result !== 'not_found') {
        console.log(`[Resolvers] Prospect ID write-back: ${pid} → GHL ${contactId} (resolved via ${source})`);
      } else {
        console.warn(`[Resolvers] Prospect ID write-back skipped for ${contactId}: ${result === 'not_found' ? 'contact not found' : 'update failed'}`);
      }
    })
    .catch((err) => {
      console.warn(`[Resolvers] Prospect ID write-back failed for ${contactId}: ${err.message}`);
    });
}

/**
 * Resolve the LP Prospect ID for a contact.
 *
 * @param {string} contactId — GHL contact ID or numeric LP lead ID
 * @param {object} [opts]
 * @param {object} [opts.ghlContact] — slim GHL contact from
 *   resolveContactInfo. When provided: (a) the custom-field fallback
 *   reads from it instead of refetching, and (b) a prospect ID resolved
 *   from LP while the GHL field is empty triggers a write-back.
 */
export async function resolveLPProspectId(contactId, { ghlContact = null } = {}) {
  if (!contactId) return 'Not in LP';

  let lpLeadId = null;
  let cachedProspectId = null;

  if (isLPLeadId(contactId)) {
    lpLeadId = contactId;
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select('lp_prospect_id')
        .eq('lp_lead_id', contactId)
        .maybeSingle();
      cachedProspectId = lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null;
    } catch {}
  } else {
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select('lp_lead_id, lp_prospect_id')
        .eq('ghl_contact_id', contactId)
        .order('synced_at', { ascending: false })
        .limit(1).maybeSingle();
      lpLeadId = lpLead?.lp_lead_id || null;
      cachedProspectId = lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null;
    } catch {}
  }

  // v3.11 — pre-read the GHL custom field from the provided snapshot so
  // we know whether a write-back is needed when LP resolves the ID.
  const isGhlContact = !isLPLeadId(contactId);
  const ghlFieldValue = isGhlContact && ghlContact ? readProspectIdFromGhlCustomFields(ghlContact) : undefined;
  const ghlFieldKnownEmpty = isGhlContact && ghlContact && !ghlFieldValue;

  // 1. LP API live — most authoritative when we have an LP lead ID
  if (lpLeadId) {
    try {
      const result = await getLeadByLdsId(lpLeadId);
      const prospects = Array.isArray(result) ? result : [result];
      for (const prospect of prospects) {
        if (!prospect) continue;
        const pid = prospect.ProspectID || prospect.prospectid || prospect.CstID
          || prospect.cst_id || prospect.prospectId || null;
        if (pid) {
          console.log(`[ActionExecutor] LP API resolved prospect ID: ${pid} for lead ${lpLeadId}`);
          if (ghlFieldKnownEmpty) writeBackProspectId(contactId, pid, 'lp_api');
          return String(pid);
        }
      }
    } catch (err) {
      console.warn(`[ActionExecutor] LP API prospect lookup failed for lead ${lpLeadId}: ${err.message}`);
    }
  }

  // 2. Cached prospect ID from lp_leads
  if (cachedProspectId) {
    console.log(`[ActionExecutor] Using cached prospect ID: ${cachedProspectId} for ${isLPLeadId(contactId) ? `lead ${contactId}` : `contact ${contactId}`}`);
    if (ghlFieldKnownEmpty) writeBackProspectId(contactId, cachedProspectId, 'lp_cache');
    return cachedProspectId;
  }

  // 3. v3.10 — GHL custom field fallback. Closes the gap where lp_leads
  // has the prospect ID but no ghl_contact_id linkage (~99% of rows).
  // v3.11: read from the provided snapshot first (no refetch); only hit
  // the API when no snapshot was supplied.
  if (isGhlContact) {
    if (ghlContact) {
      if (ghlFieldValue) {
        console.log(`[ActionExecutor] Resolved prospect ID from GHL contact snapshot: ${ghlFieldValue} for contact ${contactId}`);
        return ghlFieldValue;
      }
    } else {
      try {
        const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
        const fromGhl = readProspectIdFromGhlCustomFields(ghlRes?.contact);
        if (fromGhl) {
          console.log(`[ActionExecutor] Resolved prospect ID from GHL custom field: ${fromGhl} for contact ${contactId}`);
          return fromGhl;
        }
      } catch (err) {
        console.warn(`[ActionExecutor] GHL custom field prospect lookup failed for ${contactId}: ${err.message}`);
      }
    }
  }

  return 'Not in LP';
}

// ═══════════════════════════════════════════════════════════════════
// EVENT CONTEXT — fetch and parse system_events.payload for an action
// ═══════════════════════════════════════════════════════════════════

export async function getEventContext(action) {
  if (!action.event_id) return {};
  try {
    const { data: evt } = await supabase
      .from('system_events')
      .select('payload, event_type, event_subtype')
      .eq('id', action.event_id)
      .maybeSingle();
    if (!evt?.payload) return {};
    const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
    return { ...payload };
  } catch (err) {
    console.error(`[ActionExecutor] Failed to fetch event context for action ${action.id}:`, err.message);
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════
// DNC NUMBER RESOLUTION (2026-09-21)
// ═══════════════════════════════════════════════════════════════════

/**
 * Every phone number belonging to a contact, for a DNC write.
 *
 * WHY THIS EXISTS: a STOP text revokes consent for the PERSON, not for the
 * one handset the message happened to arrive on. Five9 dials from the LP
 * lead's phone AND phone_alt, and a prospect can carry several leads; pushing
 * only the GHL primary left a second number of the same person live on the
 * dialer. qM5QYwn5ISZ8DQOgFJpX was called ~7 more times after opting out.
 *
 * FAIL-CLOSED, both ways. A read that FAILS throws so the executor retries —
 * it must never look like "this person has no other numbers". An empty result
 * also throws: adding nothing to DNC and reporting success is the failure mode
 * this whole change exists to end. Numbers that are not valid NANP are dropped
 * silently, because adding a malformed number to DNC suppresses nobody while a
 * mistyped one could suppress a stranger.
 *
 * @param {string} contactId — GHL contact ID
 * @param {object} [eventContext]
 * @param {object} [deps] — { supabase, ghlFetch } seam for tests
 * @returns {Promise<{numbers: string[], sources: object}>} 10-digit strings
 */
export async function resolveContactDncNumbers(contactId, eventContext = {}, deps = {}) {
  const db = deps.supabase || supabase;
  const fetchGhl = deps.ghlFetch || ghlFetch;
  if (!contactId) throw new Error('resolveContactDncNumbers requires a contact id');

  const found = new Map(); // 10 digits → first source that produced it
  const add = (raw, source) => {
    const digits = normalizeNanpPhone(raw);
    if (digits && !found.has(digits)) found.set(digits, source);
  };

  // 1. GHL — the primary, plus every additional number on the record.
  //    A failure here throws: the GHL contact is the authoritative identity.
  const ghlRes = await fetchGhl('GET', `/contacts/${contactId}`);
  const contact = ghlRes?.contact || {};
  add(contact.phone, 'ghl_primary');
  for (const extra of Array.isArray(contact.additionalPhones) ? contact.additionalPhones : []) {
    // GHL returns either a bare string or { phone } depending on API version.
    add(typeof extra === 'string' ? extra : extra?.phone, 'ghl_additional');
  }

  // 2. LP — every lead for this contact, and every lead of the same prospect.
  //    lp_leads is keyed per LEAD; one person re-quoted three times has three
  //    rows and the dialer works from all of them.
  const { data: byContact, error: contactErr } = await db
    .from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, phone, phone_alt')
    .eq('ghl_contact_id', contactId)
    .limit(200);
  if (contactErr) throw new Error(`lp_leads read failed for ${contactId}: ${contactErr.message}`);

  const prospectIds = [...new Set((byContact || []).map(r => r.lp_prospect_id).filter(Boolean))];
  let byProspect = [];
  if (prospectIds.length) {
    const { data, error } = await db
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, phone, phone_alt')
      .in('lp_prospect_id', prospectIds)
      .limit(500);
    if (error) throw new Error(`lp_leads prospect read failed for ${contactId}: ${error.message}`);
    byProspect = data || [];
  }

  for (const row of [...(byContact || []), ...byProspect]) {
    add(row.phone, 'lp_phone');
    add(row.phone_alt, 'lp_phone_alt');
  }

  // 3. The triggering event, when it carried the inbound number. Last, so it
  //    only ever ADDS a number the records missed.
  add(eventContext?.inbound_from || eventContext?.from || null, 'event_payload');

  if (!found.size) {
    throw new Error(
      `resolveContactDncNumbers found no valid phone number for ${contactId} — ` +
      'refusing to report a DNC write that would suppress nothing'
    );
  }

  const sources = {};
  for (const [digits, source] of found) sources[digits] = source;
  return { numbers: [...found.keys()], sources };
}
