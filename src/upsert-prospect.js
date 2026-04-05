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

  // ─── CONDITIONAL WRITE: Skip if LP record hasn't changed ───────
  const newLastChanged = getField(prospect, 'lastchanged', 'LastChanged', 'last_changed');
  if (newLastChanged) {
    try {
      const { data: existing } = await supabase.from('lp_prospects')
        .select('last_changed, ghl_contact_id')
        .eq('lp_prospect_id', lpProspectId).single();

      if (existing?.last_changed
          && existing.last_changed === newLastChanged
          && (existing.ghl_contact_id === ghlContactId || (!ghlContactId && existing.ghl_contact_id))) {
        _prospectSkips++;
        return lpProspectId;
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
