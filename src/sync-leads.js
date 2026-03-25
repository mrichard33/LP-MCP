// ─── Lead Processing — src/sync-leads.js ──────────────────────────
//
// Core lead upsert logic: upsertLeadOnly (Pass 1), processProspect
// (incremental/webhook), and upsertLeadFromFlat (flat LP responses).
//
// ALL LP date fields are wrapped with lpDateToEastern() for correct
// timezone storage. created_at_lp uses lpCreatedDate() which prefers
// dateentered (has time) over entrydate (midnight-zeroed).

import supabase from './supabase.js';
import { getField, normalizePhone, loggedFirstKeys } from './sync-utils.js';
import { logSyncError } from './sync-log.js';
import { resolveSourceBucket } from './sync-sources.js';
import { lpDateToEastern, lpCreatedDate } from './lp-dates.js';
import { matchToGHL, applyGHLTag } from './ghl.js';
import { upsertProspect } from './upsert-prospect.js';
import { combineNotes } from './safe-notes.js';
import { syncCallLogs, syncNotes, syncActivities, syncJobAndMilestones } from './sync-children.js';

// ─── Pass 1 Helper — upsertLeadOnly() ────────────────────────────
//
// Extracts ONLY the lead upsert from processProspect(). Used during
// fullSync Pass 1 to commit every lp_leads row before child records.

export async function upsertLeadOnly(prospect) {
  const leads = getField(prospect, 'leads', 'Leads') || [];
  await upsertProspect(prospect, { leads });

  if (leads.length === 0) {
    await upsertLeadFromFlat(prospect, null);
    return 1;
  }

  let count = 0;
  for (const lead of leads) {
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
    const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));
    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'), lpLeadId,
    );

    const apptSet = getField(lead, 'apptset', 'ApptSet');
    const sat = getField(lead, 'sat', 'Sat');
    const sold = getField(lead, 'sold', 'Sold');
    const isApptSet = apptSet === 'true' || apptSet === true;
    const isDemoCompleted = sat === 'true' || sat === true;
    const isClosedWon = sold === 'true' || sold === true;

    const { error: upsertErr } = await supabase.from('lp_leads').upsert({
      lp_lead_id:         lpLeadId,
      lp_prospect_id:     lpProspectId,
      ghl_contact_id:     null,
      first_name:         getField(prospect, 'firstname', 'FirstName', 'first_name'),
      last_name:          getField(prospect, 'lastname', 'LastName', 'last_name'),
      email:              getField(prospect, 'email', 'Email'),
      phone:              normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone')),
      phone_alt:          normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2')),
      address:            getField(prospect, 'address1', 'Address1'),
      city:               getField(prospect, 'city', 'City'),
      state:              getField(prospect, 'state', 'State'),
      zip:                getField(prospect, 'zip', 'Zip'),
      lead_source:        getField(lead, 'source', 'Source'),
      lead_source_detail: getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      promoter_name:      getField(lead, 'promotername', 'PromoterName'),
      ghl_intent_bucket:  bucket,
      ghl_entry_tag:      tag,
      disposition_code:   getField(lead, 'disposition', 'Disposition'),
      rep_name:           getField(lead, 'salesrepname', 'SalesRepName'),
      appointment_set:    isApptSet,
      appointment_date:   lpDateToEastern(getField(lead, 'apptdate', 'ApptDate')),
      demo_completed:     isDemoCompleted,
      demo_date:          isDemoCompleted ? lpDateToEastern(getField(lead, 'apptdate', 'ApptDate')) : null,
      closed_won:         isClosedWon,
      job_value:          parseFloat(getField(lead, 'gsa', 'GSA', 'grossamount', 'GrossAmount') || 0) || null,
      created_at_lp:      lpCreatedDate(prospect, lead, getField),
      updated_at_lp:      lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn')),
      synced_at:          new Date().toISOString(),
      raw_lp_data:        prospect,
    }, { onConflict: 'lp_lead_id' });

    if (upsertErr) throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);
    count++;
  }
  return count;
}

// ─── Per-Prospect Processing — processProspect() ─────────────────
//
// Used by incrementalSync and webhook handlers. Single-pass is safe
// because lp_leads is already populated after the first full sync.

export async function processProspect(prospect, { skipGHL = false } = {}) {
  if (!loggedFirstKeys.has('prospect')) {
    loggedFirstKeys.add('prospect');
    console.log('[Sync] Prospect record keys:', Object.keys(prospect).join(', '));
  }

  let ghlId = null;
  if (!skipGHL) {
    try {
      ghlId = await matchToGHL({
        phone: normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone', 'Phone')),
        phone_alt: normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2', 'phone_alt')),
        email: getField(prospect, 'email', 'Email'),
      });
    } catch (err) {
      console.warn(`[Sync] GHL match failed for prospect ${prospect.cst_id}:`, err.message);
    }
  }

  const allLeads = getField(prospect, 'leads', 'Leads') || [];
  await upsertProspect(prospect, { ghlContactId: ghlId, leads: allLeads });

  const leads = allLeads;
  if (leads.length === 0) {
    await upsertLeadFromFlat(prospect, ghlId);
    return { calls: 0, notes: 0, jobs: 0, milestones: 0 };
  }

  if (!loggedFirstKeys.has('lead') && leads.length > 0) {
    loggedFirstKeys.add('lead');
    console.log('[Sync] Lead record keys:', Object.keys(leads[0]).join(', '));
  }

  let subCounts = { calls: 0, notes: 0, jobs: 0, milestones: 0 };

  for (const lead of leads) {
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'), lpLeadId,
    );
    const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));

    const { data: existing } = await supabase.from('lp_leads')
      .select('ghl_tag_applied, lp_day15_triggered')
      .eq('lp_lead_id', lpLeadId).single();

    const apptSet = getField(lead, 'apptset', 'ApptSet');
    const sat = getField(lead, 'sat', 'Sat');
    const sold = getField(lead, 'sold', 'Sold');
    const isApptSet = apptSet === 'true' || apptSet === true;
    const isDemoCompleted = sat === 'true' || sat === true;
    const isClosedWon = sold === 'true' || sold === true;

    const { error: upsertErr } = await supabase.from('lp_leads').upsert({
      lp_lead_id:         lpLeadId,
      lp_prospect_id:     lpProspectId,
      ghl_contact_id:     ghlId,
      first_name:         getField(prospect, 'firstname', 'FirstName', 'first_name'),
      last_name:          getField(prospect, 'lastname', 'LastName', 'last_name'),
      email:              getField(prospect, 'email', 'Email'),
      phone:              normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone')),
      phone_alt:          normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2')),
      address:            getField(prospect, 'address1', 'Address1'),
      city:               getField(prospect, 'city', 'City'),
      state:              getField(prospect, 'state', 'State'),
      zip:                getField(prospect, 'zip', 'Zip'),
      lead_source:        getField(lead, 'source', 'Source'),
      lead_source_detail: getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      promoter_name:      getField(lead, 'promotername', 'PromoterName'),
      ghl_intent_bucket:  bucket,
      ghl_entry_tag:      tag,
      disposition_code:   getField(lead, 'disposition', 'Disposition'),
      rep_name:           getField(lead, 'salesrepname', 'SalesRepName'),
      appointment_set:    isApptSet,
      appointment_date:   lpDateToEastern(getField(lead, 'apptdate', 'ApptDate')),
      demo_completed:     isDemoCompleted,
      demo_date:          isDemoCompleted ? lpDateToEastern(getField(lead, 'apptdate', 'ApptDate')) : null,
      closed_won:         isClosedWon,
      job_value:          parseFloat(getField(lead, 'gsa', 'GSA', 'grossamount', 'GrossAmount') || 0) || null,
      created_at_lp:      lpCreatedDate(prospect, lead, getField),
      updated_at_lp:      lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn')),
      synced_at:          new Date().toISOString(),
      raw_lp_data:        prospect,
    }, { onConflict: 'lp_lead_id' });

    if (upsertErr) throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);

    if (ghlId && !existing?.ghl_tag_applied) {
      const success = await applyGHLTag(ghlId, tag);
      if (success) {
        await supabase.from('lp_leads').update({ ghl_tag_applied: true }).eq('lp_lead_id', lpLeadId);
      }
    }

    const calls = getField(prospect, 'calls', 'Calls') || [];
    const notes = combineNotes(getField(prospect, 'notes', 'Notes'), getField(lead, 'notes', 'Notes'));
    const jobs = getField(lead, 'jobs', 'Jobs') || [];
    subCounts.calls += calls.length;
    subCounts.notes += notes.length;
    subCounts.jobs += jobs.length;
    for (const job of jobs) {
      subCounts.milestones += (getField(job, 'milestones', 'Milestones') || []).length;
    }

    await Promise.all([
      syncCallLogs(lpLeadId, ghlId, calls),
      syncNotes(lpLeadId, ghlId, notes),
      syncActivities(lpLeadId, calls, notes),
      ...jobs.map(job => syncJobAndMilestones(job, lpLeadId, ghlId)),
    ]);

    if (!existing?.lp_day15_triggered && ghlId) {
      const { checkDay15Handoff } = await import('./sync-triggers.js');
      await checkDay15Handoff(
        lpLeadId, ghlId,
        getField(lead, 'entrydate', 'EntryDate'),
        getField(lead, 'disposition', 'Disposition'),
      );
    }
  }

  return subCounts;
}

// Fallback: upsert from flat data (when LP returns non-nested response)
export async function upsertLeadFromFlat(lp, ghlId) {
  const lpLeadId = String(getField(lp, 'lds_id', 'id', 'LeadID', 'cst_id', 'ProspectID'));
  const lpProspectId = String(getField(lp, 'cst_id', 'CstID', 'ProspectID') || '');

  await supabase.from('lp_leads').upsert({
    lp_lead_id:         lpLeadId,
    lp_prospect_id:     lpProspectId,
    ghl_contact_id:     ghlId,
    first_name:         getField(lp, 'firstname', 'FirstName', 'first_name'),
    last_name:          getField(lp, 'lastname', 'LastName', 'last_name'),
    email:              getField(lp, 'email', 'Email'),
    phone:              normalizePhone(getField(lp, 'phone1', 'Phone1', 'phone', 'Phone')),
    phone_alt:          normalizePhone(getField(lp, 'phone2', 'Phone2', 'phone_alt')),
    address:            getField(lp, 'address1', 'Address1'),
    city:               getField(lp, 'city', 'City'),
    state:              getField(lp, 'state', 'State'),
    zip:                getField(lp, 'zip', 'Zip'),
    lead_source:        getField(lp, 'source', 'Source'),
    lead_source_detail: getField(lp, 'sourcesubdescr', 'SourceSubDescr'),
    disposition_code:   getField(lp, 'disposition', 'Disposition'),
    rep_name:           getField(lp, 'salesrepname', 'SalesRepName', 'rep_name'),
    created_at_lp:      lpDateToEastern(getField(lp, 'dateadded', 'DateAdded', 'entrydate', 'EntryDate')),
    updated_at_lp:      lpDateToEastern(getField(lp, 'lastchangedon', 'LastChangedOn')),
    synced_at:          new Date().toISOString(),
    raw_lp_data:        lp,
  }, { onConflict: 'lp_lead_id' });
}
