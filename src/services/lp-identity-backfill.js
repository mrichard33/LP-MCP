// LP → GHL identity backfill — src/services/lp-identity-backfill.js
//
// 2026-10-11. The one core behind three callers:
//   - scripts/backfill-lp-contact-names.js   one-time CLI (dry run default)
//   - POST /admin/lp-identity-fill            the same run on the server,
//                                             which holds the GHL key
//   - src/jobs/lp-identity-fill-sweep.js      the ongoing safety net: a name
//                                             typed into LP AFTER the contact
//                                             was linked (canvass / text leads
//                                             named at the demo) lands within
//                                             30 minutes.
//
// WHY A SWEEP AND NOT THE FIELD SYNC. ghl-field-sync.js pushes custom fields
// behind a payload hash and never reads the contact, so it cannot see an
// empty name, and a name added in LP does not change its hash. Reading every
// linked contact on every lead change would cost a GHL GET per change. The
// HL mirror already knows which contacts have no name (1,531 on 2026-10-11),
// so the sweep asks it first and spends GHL calls only on those.
//
// SELECTION, cheapest first:
//   1. HL mirror: live contacts whose name is missing, the phone number, or
//      "Guest Visitor …" (nameIsReplaceable in lp-identity-fill.js).
//   2. LP: their lp_leads rows; the NEWEST lead that carries a usable name
//      wins. No LP name → skipped_no_lp_name, no GHL call.
//   3. GHL, live: the contact is re-read. Gone → skipped_contact_gone. A real
//      name by now (the mirror lags) → skipped_has_name.
//   4. VERIFIED link only: the contact's LP Lead ID / Prospect ID field
//      equals the lead's, or its phone matches the lead's phone on the last
//      10 digits. lp_leads.ghl_contact_id alone is not proof (rows linked
//      before 2026-07 carry ghl_link_source 'legacy_unverified').
//   5. buildIdentityFill → ONE PUT of standard fields only (never tags).
//
// Every change is logged as `contact | lp_lead | field | old → new`. Errors go
// to lp_sync_errors (sync_type identity_backfill, or identity_fill_sweep for
// the job). A dry run writes nothing at all, errors included.

import { normalizePhone } from '../sync-utils.js';
import { buildIdentityFill, describeFill, dropTakenEmail, lpIdentityFrom, nameIsReplaceable, putWithIdentityFill } from './lp-identity-fill.js';

const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';     // lp-contact-backstop.js
const LP_PROSPECT_ID_FIELD = 'ZRQAVrzhtzApzLlHmT87';
export const DEMO_TAG = 'lp-demo-completed';

const PAGE = 1000;
const ID_CHUNK = 200;

// Digits/punctuation only = the phone number standing in for a name.
const NO_LETTERS = '"^[^[:alpha:]]*$"';
const NAMELESS_FILTER =
  `and(or(first_name.is.null,first_name.match.${NO_LETTERS}),or(last_name.is.null,last_name.match.${NO_LETTERS})),` +
  'first_name.ilike.guest visitor*';

const last10 = (p) => {
  const d = normalizePhone(p);
  return d && d.length >= 10 ? d.slice(-10) : null;
};

/** Value of a GHL custom field on a live contact, trimmed ('' when absent). */
function customFieldValue(contact, id) {
  const cfs = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const f = cfs.find((x) => x?.id === id);
  return String(f?.value ?? f?.field_value ?? '').trim();
}

/**
 * How we know this LP lead belongs to this GHL contact, or null when we
 * don't. Pure. Order: the LP ids already on the contact, then the phone.
 */
export function verifiedLinkBasis(contact, lead) {
  if (!contact || !lead) return null;
  const onLead = customFieldValue(contact, LP_LEAD_ID_FIELD);
  if (onLead && lead.lp_lead_id != null && onLead === String(lead.lp_lead_id)) return 'lp_lead_id';
  const onProspect = customFieldValue(contact, LP_PROSPECT_ID_FIELD);
  if (onProspect && lead.lp_prospect_id != null && onProspect === String(lead.lp_prospect_id)) return 'lp_prospect_id';
  const cp = last10(contact.phone);
  if (cp && (cp === last10(lead.phone) || cp === last10(lead.phone_alt))) return 'phone';
  return null;
}

/**
 * Newest lead (created_at_lp DESC) per contact that carries a usable name.
 * Soft-deleted LP leads are ignored. Pure.
 *
 * @param {object[]} rows  lp_leads rows
 * @returns {Map<string, object>} ghl_contact_id → lead
 */
export function pickNamedLeadPerContact(rows) {
  const sorted = [...(rows || [])].sort((a, b) =>
    (Date.parse(b.created_at_lp) || 0) - (Date.parse(a.created_at_lp) || 0));
  const out = new Map();
  for (const r of sorted) {
    if (!r?.ghl_contact_id || r.lp_deleted_at || out.has(r.ghl_contact_id)) continue;
    const id = lpIdentityFrom(r);
    if (id.firstName || id.lastName) out.set(r.ghl_contact_id, r);
  }
  return out;
}

/** HL mirror: live contacts with no real name. Demo-tagged first. */
export async function readNamelessContacts(hl, { demoOnly = false } = {}) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = hl.from('contacts')
      .select('ghl_contact_id, first_name, last_name, tags')
      .is('deleted_at', null)
      .or(NAMELESS_FILTER);
    if (demoOnly) q = q.contains('tags', [DEMO_TAG]);
    const { data, error } = await q.order('date_added', { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw new Error(`HL contacts read failed at ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const isDemo = (r) => Array.isArray(r.tags) && r.tags.includes(DEMO_TAG);
  // Stable: demo contacts first, otherwise newest first (the read order).
  return rows
    .filter((r) => r.ghl_contact_id)
    .map((r, i) => ({ ...r, _i: i, demo: isDemo(r) }))
    .sort((a, b) => (a.demo === b.demo ? a._i - b._i : a.demo ? -1 : 1));
}

/** LP: every lp_leads row for these contacts. */
export async function readLeadsForContacts(lp, contactIds) {
  const rows = [];
  for (let i = 0; i < contactIds.length; i += ID_CHUNK) {
    const chunk = contactIds.slice(i, i + ID_CHUNK);
    const { data, error } = await lp.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, first_name, last_name, email, address, city, state, zip, phone, phone_alt, created_at_lp, lp_deleted_at')
      .in('ghl_contact_id', chunk);
    if (error) throw new Error(`lp_leads read failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

/** lp_sync_errors rows, best-effort. Never throws; never on a dry run. */
async function persistErrors(lp, errors, { syncType, dryRun }) {
  if (dryRun || !lp || errors.length === 0) return { persisted: 0 };
  try {
    const { error } = await lp.from('lp_sync_errors').insert(errors.map((e) => ({
      lp_lead_id: e.lp_lead_id != null ? String(e.lp_lead_id) : null,
      lp_prospect_id: e.lp_prospect_id != null ? String(e.lp_prospect_id) : null,
      error_message: `contact ${e.contact_id}: ${String(e.error || 'unknown_error')}`.slice(0, 2000),
      error_stack: null,
      sync_type: syncType,
      retry_count: 0,
      resolved: false,
    })));
    return error ? { persisted: 0, persist_error: error.message } : { persisted: errors.length };
  } catch (err) {
    return { persisted: 0, persist_error: String(err.message || err) };
  }
}

/**
 * Run the identity fill over the nameless contacts.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun=true]
 * @param {number}  [opts.limit=0]       max contacts sent to GHL (0 = all)
 * @param {boolean} [opts.demoOnly=false]
 * @param {string}  [opts.syncType='identity_backfill']  lp_sync_errors tag
 * @param {Set<string>} [opts.skipIds]   contacts to leave out (sweep memory)
 * @param {object}  deps  { hl, lp, ghlFetch, log }
 */
export async function runIdentityFill({
  dryRun = true, limit = 0, demoOnly = false, syncType = 'identity_backfill', skipIds = null,
} = {}, deps = {}) {
  const { hl, lp, ghlFetch } = deps;
  const log = deps.log || console.log;
  if (!hl) throw new Error('HL mirror not configured');
  if (!lp) throw new Error('LP Supabase not configured');
  if (!ghlFetch) throw new Error('ghlFetch not provided');

  const counts = {
    nameless_in_mirror: 0, checked: 0, filled: 0, would_fill: 0,
    skipped_no_lp_name: 0, skipped_has_name: 0, skipped_unverified_link: 0,
    skipped_contact_gone: 0, skipped_nothing_to_fill: 0, skipped_remembered: 0,
    deferred_limit: 0, errors: 0,
  };
  const changes = [];  // { contact_id, lp_lead_id, field, old, new }
  const errors = [];
  const settled = [];  // contacts nothing more can be done for right now

  const nameless = await readNamelessContacts(hl, { demoOnly });
  counts.nameless_in_mirror = nameless.length;
  const leadByContact = pickNamedLeadPerContact(await readLeadsForContacts(lp, nameless.map((c) => c.ghl_contact_id)));

  const queue = [];
  for (const c of nameless) {
    if (!leadByContact.has(c.ghl_contact_id)) { counts.skipped_no_lp_name++; continue; }
    if (skipIds?.has(c.ghl_contact_id)) { counts.skipped_remembered++; continue; }
    queue.push({ contactId: c.ghl_contact_id, lead: leadByContact.get(c.ghl_contact_id), demo: c.demo });
  }
  const work = limit > 0 ? queue.slice(0, limit) : queue;
  counts.deferred_limit = queue.length - work.length;

  for (const { contactId, lead } of work) {
    counts.checked++;
    try {
      let contact;
      try {
        const res = await ghlFetch('GET', `/contacts/${contactId}`);
        contact = res?.contact || null;
      } catch (err) {
        if (/→\s*(400|404)/.test(String(err.message)) && /not found/i.test(String(err.message))) contact = null;
        else throw err;
      }
      if (!contact?.id) { counts.skipped_contact_gone++; settled.push(contactId); continue; }
      if (!nameIsReplaceable(contact)) { counts.skipped_has_name++; settled.push(contactId); continue; }
      const basis = verifiedLinkBasis(contact, lead);
      if (!basis) {
        counts.skipped_unverified_link++;
        settled.push(contactId);
        log(`[IdentityFill] unverified link — skipped contact=${contactId} lead=${lead.lp_lead_id}`);
        continue;
      }

      let fill = buildIdentityFill(contact, lead);
      if (fill.email) ({ fill } = await dropTakenEmail(fill, contactId, { hl }));
      if (Object.keys(fill).length === 0) { counts.skipped_nothing_to_fill++; settled.push(contactId); continue; }

      const lines = describeFill(contact, fill);
      if (dryRun) {
        counts.would_fill++;
        for (const l of lines) {
          changes.push({ contact_id: contactId, lp_lead_id: lead.lp_lead_id, basis, ...l });
          log(`[IdentityFill] DRY ${contactId} | ${lead.lp_lead_id} | ${l.field} | "${l.old}" → "${l.new}"`);
        }
        continue;
      }

      const res = await putWithIdentityFill(contactId, {}, fill, ghlFetch);
      if (!res.wrote) throw new Error(`identity fill refused: ${res.fill_error || 'unknown'}`);
      counts.filled++;
      settled.push(contactId);
      for (const l of lines) {
        changes.push({ contact_id: contactId, lp_lead_id: lead.lp_lead_id, basis, ...l });
        log(`[IdentityFill] ${contactId} | ${lead.lp_lead_id} | ${l.field} | "${l.old}" → "${l.new}"`);
      }
    } catch (err) {
      counts.errors++;
      errors.push({
        contact_id: contactId, lp_lead_id: lead.lp_lead_id, lp_prospect_id: lead.lp_prospect_id,
        error: String(err.message || err).slice(0, 300),
      });
    }
  }

  const persistence = await persistErrors(lp, errors, { syncType, dryRun });
  return {
    ok: errors.length === 0,
    dry_run: dryRun,
    demo_only: demoOnly,
    limit,
    counts,
    changes,
    errors,
    error_persistence: persistence,
    settled,
  };
}
