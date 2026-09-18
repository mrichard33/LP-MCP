// --- Prospect Upsert Module --- src/upsert-prospect.js ---
//
// v6.0 — DISK I/O OPTIMIZATION:
// - Conditional write: skips upsert if last_changed hasn't changed
// - Prospect is the ONLY table that stores raw_lp_data (removed from lp_leads)
// - Skip counter exported for observability
//
// lp_prospects stores ONE ROW per person (cst_id). Contact info lives here.
// lp_leads stores ONE ROW per inquiry (lds_id). Lead-specific data lives here.

import supabase from './supabase.js';
import { diffLeadContent } from './services/lead-content-diff.js';
import { verifiedStamp, verifiedAtEnabled, VERIFIED_FROM } from './services/freshness.js';

// ─── Content gate (2026-09-18) ───────────────────────────────────────────
// lp_prospects skipped the upsert whenever LP's `lastchanged` matched the
// stored value. That is the SAME defect PR #971 removed from lp_leads: LP does
// not bump lastchanged for every edit, so a corrected phone or address on the
// prospect record could sit stale indefinitely. Compare content instead.
//
// Deliberately NOT gated behind LP_LEAD_CONTENT_DIFF_MODE. That flag soaks the
// LEAD gate, whose allowlist covers 35 columns across two writers; this is one
// writer over nine contact fields with no derivation logic to get wrong, and
// holding it behind an unrelated flag would couple two independent rollouts.
const PROSPECT_CONTENT_COLUMNS = Object.freeze([
  'first_name', 'last_name', 'email', 'phone', 'phone_alt',
  'address', 'city', 'state', 'zip',
]);

// Every column the skip path must read so the diff can see the stored row.
const PROSPECT_SELECT = ['last_changed', 'ghl_contact_id', ...PROSPECT_CONTENT_COLUMNS]
  .concat(verifiedAtEnabled() ? ['verified_at'] : [])
  .join(', ');

// Skip-path stamp, rate-limited to once per row per day: lp_prospects is 147k
// rows and an unbounded stamp would add 147k updates per full sync (the v6.0
// disk-I/O rule this file was written around). Mirrors stampLeadVerified in
// src/sync-leads.js.
const VERIFIED_STAMP_MIN_MS = 24 * 60 * 60 * 1000;

async function stampProspectVerified(lpProspectId, existing) {
  if (!verifiedAtEnabled() || !existing) return;
  const last = existing.verified_at ? Date.parse(existing.verified_at) : 0;
  if (Date.now() - last < VERIFIED_STAMP_MIN_MS) return;
  const { error } = await supabase.from('lp_prospects')
    .update(verifiedStamp(VERIFIED_FROM.LP))
    .eq('lp_prospect_id', lpProspectId);
  if (error) console.warn(`[Sync] prospect verified stamp failed for ${lpProspectId}: ${error.message}`);
}

function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '') || null;
}

function getField(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  const objKeys = Object.keys(obj);
  for (const k of keys) {
    const lower = k.toLowerCase();
    const match = objKeys.find(ok => ok.toLowerCase() === lower);
    if (match && obj[match] !== undefined && obj[match] !== null && obj[match] !== '') return obj[match];
  }
  return null;
}

// ─── Skip counter for observability ──────────────────────────────
let _prospectSkips = 0;
export function getProspectSkipStats() { const s = _prospectSkips; _prospectSkips = 0; return s; }

/**
 * Upsert a prospect record from LP API response data.
 * Called once per prospect (not per lead). Extracts contact-level fields.
 *
 * v6.0: Checks last_changed before writing. If LP hasn't updated the
 * prospect since our last sync, we skip the heavy TOAST write entirely.
 *
 * @param {Object} prospect - The top-level LP API prospect object
 * @param {Object} opts
 * @param {string|null} opts.ghlContactId - Resolved GHL contact ID (if known)
 * @param {boolean} opts.ghlTagApplied - Whether the GHL entry tag has been applied
 * @param {Array} opts.leads - The leads array from this prospect (for aggregate stats)
 * @returns {string} The lp_prospect_id
 */
export async function upsertProspect(prospect, opts = {}) {
  const { ghlContactId = null, ghlTagApplied = false, leads = [] } = opts;

  const lpProspectId = String(
    getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID')
  );

  if (!lpProspectId || lpProspectId === 'null' || lpProspectId === '') {
    return null;
  }

  // ─── CONDITIONAL WRITE: skip only when the CONTENT matches ─────
  // Was: skip whenever LP's `lastchanged` equalled the stored value. LP does
  // not bump that field for every edit, so a phone or address corrected in LP
  // never landed. The timestamp test is KEPT as the cheap first pass — it is
  // right far more often than not — and the content diff is what decides.
  const newLastChanged = getField(prospect, 'lastchanged', 'LastChanged', 'last_changed');
  if (newLastChanged) {
    try {
      const { data: existing } = await supabase.from('lp_prospects')
        .select(PROSPECT_SELECT)
        .eq('lp_prospect_id', lpProspectId).single();

      if (existing?.last_changed
          && existing.last_changed === newLastChanged
          && (existing.ghl_contact_id === ghlContactId || (!ghlContactId && existing.ghl_contact_id))) {
        // Built with the SAME expressions as the upsert literal below, so the
        // diff can never disagree with what the write path would store.
        const candidate = {
          first_name: getField(prospect, 'firstname', 'FirstName', 'first_name'),
          last_name:  getField(prospect, 'lastname', 'LastName', 'last_name'),
          email:      getField(prospect, 'email', 'Email'),
          phone:      normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone')),
          phone_alt:  normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2')),
          address:    getField(prospect, 'address1', 'Address1'),
          city:       getField(prospect, 'city', 'City'),
          state:      getField(prospect, 'state', 'State'),
          zip:        getField(prospect, 'zip', 'Zip'),
        };
        const drift = diffLeadContent(existing, candidate, PROSPECT_CONTENT_COLUMNS);
        if (drift.length === 0) {
          await stampProspectVerified(lpProspectId, existing);
          _prospectSkips++;
          return lpProspectId;
        }
        console.log(`[Sync] PROSPECT DRIFT ${lpProspectId}: ${drift.map(d => d.field).join(', ')} — forcing upsert`);
      }
    } catch (_) {
      // Row doesn't exist yet — proceed with insert
    }
  }

  // Compute aggregates from leads array
  let totalLeadCount = leads.length || 0;
  let latestLeadDate = null;
  let latestDisposition = null;
  let latestRepName = null;
  let hasAppointment = false;
  let hasDemo = false;
  let hasSale = false;
  let totalJobValue = 0;

  for (const lead of leads) {
    const entryDate = getField(lead, 'entrydate', 'EntryDate');
    if (entryDate && (!latestLeadDate || new Date(entryDate) > new Date(latestLeadDate))) {
      latestLeadDate = entryDate;
      latestDisposition = getField(lead, 'disposition', 'Disposition');
      latestRepName = getField(lead, 'salesrepname', 'SalesRepName');
    }
    const apptSet = getField(lead, 'apptset', 'ApptSet');
    if (apptSet === 'true' || apptSet === true) hasAppointment = true;
    const sat = getField(lead, 'sat', 'Sat');
    if (sat === 'true' || sat === true) hasDemo = true;
    const sold = getField(lead, 'sold', 'Sold');
    if (sold === 'true' || sold === true) hasSale = true;
    const gsa = parseFloat(getField(lead, 'gsa', 'GSA', 'grossamount', 'GrossAmount') || 0) || 0;
    totalJobValue += gsa;
  }

  const { error } = await supabase.from('lp_prospects').upsert({
    lp_prospect_id: lpProspectId,
    first_name:     getField(prospect, 'firstname', 'FirstName', 'first_name'),
    last_name:      getField(prospect, 'lastname', 'LastName', 'last_name'),
    email:          getField(prospect, 'email', 'Email'),
    phone:          normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone')),
    phone_alt:      normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2')),
    address:        getField(prospect, 'address1', 'Address1'),
    city:           getField(prospect, 'city', 'City'),
    state:          getField(prospect, 'state', 'State'),
    zip:            getField(prospect, 'zip', 'Zip'),
    ghl_contact_id: ghlContactId,
    ghl_tag_applied: ghlTagApplied,
    date_added:     getField(prospect, 'dateadded', 'DateAdded', 'date_added'),
    last_changed:   newLastChanged,
    total_lead_count: totalLeadCount,
    latest_lead_date: latestLeadDate,
    latest_disposition: latestDisposition,
    latest_rep_name: latestRepName,
    has_appointment: hasAppointment,
    has_demo: hasDemo,
    has_sale: hasSale,
    total_job_value: totalJobValue || null,
    synced_at: new Date().toISOString(),
    ...verifiedStamp(VERIFIED_FROM.LP),
    raw_lp_data: prospect,
  }, {
    onConflict: 'lp_prospect_id',
  });

  if (error) {
    console.warn(`[Sync] Prospect upsert failed for ${lpProspectId}: ${error.message}`);
  }

  return lpProspectId;
}

/**
 * Update just the GHL contact ID on a prospect record.
 * Called during GHL backfill when a match is found.
 */
export async function updateProspectGHL(lpProspectId, ghlContactId, ghlTagApplied = false) {
  if (!lpProspectId || !ghlContactId) return;
  try {
    const update = { ghl_contact_id: ghlContactId };
    if (ghlTagApplied) update.ghl_tag_applied = true;
    await supabase.from('lp_prospects')
      .update(update)
      .eq('lp_prospect_id', lpProspectId);
  } catch (err) {
    console.warn(`[Sync] Prospect GHL update failed for ${lpProspectId}: ${err.message}`);
  }
}

/**
 * Refresh aggregate stats on a prospect from its leads.
 * Called after leads are updated (e.g. disposition change, demo completed).
 */
export async function refreshProspectAggregates(lpProspectId) {
  if (!lpProspectId) return;
  try {
    const { data: leads } = await supabase
      .from('lp_leads')
      .select('created_at_lp, disposition_code, rep_name, appointment_set, demo_completed, closed_won, job_value')
      .eq('lp_prospect_id', lpProspectId);

    if (!leads || leads.length === 0) return;

    let latestLeadDate = null;
    let latestDisposition = null;
    let latestRepName = null;

    for (const l of leads) {
      if (l.created_at_lp && (!latestLeadDate || new Date(l.created_at_lp) > new Date(latestLeadDate))) {
        latestLeadDate = l.created_at_lp;
        latestDisposition = l.disposition_code;
        latestRepName = l.rep_name;
      }
    }

    await supabase.from('lp_prospects').update({
      total_lead_count: leads.length,
      latest_lead_date: latestLeadDate,
      latest_disposition: latestDisposition,
      latest_rep_name: latestRepName,
      has_appointment: leads.some(l => l.appointment_set),
      has_demo: leads.some(l => l.demo_completed),
      has_sale: leads.some(l => l.closed_won),
      total_job_value: leads.reduce((sum, l) => sum + (parseFloat(l.job_value) || 0), 0) || null,
      synced_at: new Date().toISOString(),
    }).eq('lp_prospect_id', lpProspectId);
  } catch (err) {
    console.warn(`[Sync] Prospect aggregate refresh failed for ${lpProspectId}: ${err.message}`);
  }
}
