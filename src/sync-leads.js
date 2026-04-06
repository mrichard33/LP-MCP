// ─── Lead Processing — src/sync-leads.js ──────────────────────────
//
// Core lead upsert logic: upsertLeadOnly (Pass 1), processProspect
// (incremental/webhook), and upsertLeadFromFlat (flat LP responses).
//
// ALL LP date fields are wrapped with lpDateToEastern() for correct
// timezone storage. created_at_lp uses lpCreatedDate() which prefers
// dateentered (has time) over entrydate (midnight-zeroed).
//
// AGENTIC: Disposition changes emit system events for the Decision Engine.
//
// v7.1 — Real-time note push: After a disposition change is detected and
// child records are synced, pushLeadNotesImmediately() pushes all unpushed
// notes for that lead to GHL within seconds instead of waiting for the
// batch sync cycle (which can take 30-60 min).
//
// v7.0 — DISK I/O OPTIMIZATION: Conditional upserts skip writes when
// LP record hasn't changed (compares updated_at_lp). Removes raw_lp_data
// from lp_leads upserts (prospect blob already stored on lp_prospects).
// Adds skip counters for observability.

import supabase from './supabase.js';
import { getField, normalizePhone, loggedFirstKeys } from './sync-utils.js';
import { logSyncError } from './sync-log.js';
import { resolveSourceBucket } from './sync-sources.js';
import { lpDateToEastern, lpCreatedDate } from './lp-dates.js';
import { matchToGHL, applyGHLTag } from './ghl.js';
import { upsertProspect } from './upsert-prospect.js';
import { combineNotes } from './safe-notes.js';
import { syncCallLogs, syncNotes, syncActivities, syncJobAndMilestones } from './sync-children.js';
import { emitEvent, dispositionPriority } from './event-emitter.js';
import { pushLeadNotesImmediately } from './ghl-notes-sync.js';

// ─── Skip counter for observability ──────────────────────────────
let _skipStats = { leads: 0, prospects: 0 };
export function getSkipStats() { const s = { ..._skipStats }; _skipStats = { leads: 0, prospects: 0 }; return s; }

// ─── Build the lead row payload (DRY helper) ─────────────────────
function buildLeadRow(prospect, lead, lpLeadId, lpProspectId, bucket, tag, ghlId) {
  const apptSet = getField(lead, 'apptset', 'ApptSet');
  const sat = getField(lead, 'sat', 'Sat');
  const sold = getField(lead, 'sold', 'Sold');
  const isApptSet = apptSet === 'true' || apptSet === true;
  const isDemoCompleted = sat === 'true' || sat === true;
  const isClosedWon = sold === 'true' || sold === true;

  return {
    row: {
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
      // NOTE: raw_lp_data removed from lp_leads — prospect blob lives on lp_prospects
    },
    isApptSet,
    isDemoCompleted,
    isClosedWon,
  };
}

// ─── Pass 1 Helper — upsertLeadOnly() ────────────────────────────
//
// Extracts ONLY the lead upsert from processProspect(). Used during
// fullSync Pass 1 to commit every lp_leads row before child records.
// Does NOT emit events (too many leads during full sync).
//
// v7.0: Skips upsert if updated_at_lp hasn't changed (conditional write).

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

    // ─── CONDITIONAL WRITE: Skip if LP record hasn't changed ─────
    const newUpdatedAt = lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn'));
    if (newUpdatedAt) {
      const { data: existing } = await supabase.from('lp_leads')
        .select('updated_at_lp')
        .eq('lp_lead_id', lpLeadId).single();
      if (existing?.updated_at_lp && existing.updated_at_lp === newUpdatedAt) {
        _skipStats.leads++;
        count++;
        continue;
      }
    }

    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'), lpLeadId,
    );

    const { row } = buildLeadRow(prospect, lead, lpLeadId, lpProspectId, bucket, tag, null);

    const { error: upsertErr } = await supabase.from('lp_leads').upsert(row, { onConflict: 'lp_lead_id' });
    if (upsertErr) throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);
    count++;
  }
  return count;
}

// ─── Per-Prospect Processing — processProspect() ─────────────────
//
// Used by incrementalSync and webhook handlers. Single-pass is safe
// because lp_leads is already populated after the first full sync.
//
// AGENTIC: Detects disposition changes and emits system events.
//
// v7.1: Real-time note push after disposition change + child sync.
// v7.0: Conditional write — skips heavy upsert + child sync when
// updated_at_lp hasn't changed AND disposition hasn't changed.

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

    // ─── AGENTIC: Read existing state BEFORE upsert ──────────────
    const { data: existing } = await supabase.from('lp_leads')
      .select('ghl_tag_applied, lp_day15_triggered, disposition_code, ghl_contact_id, updated_at_lp')
      .eq('lp_lead_id', lpLeadId).single();

    const previousDisposition = existing?.disposition_code || null;
    const newDisposition = getField(lead, 'disposition', 'Disposition') || null;
    const newUpdatedAt = lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn'));
    const dispositionChanged = newDisposition && newDisposition !== previousDisposition;

    // ─── CONDITIONAL WRITE: Skip if LP record hasn't changed ─────
    // We still need to check disposition for event emission and GHL tag
    // for first-time application, but skip the heavy upsert + child sync.
    const recordUnchanged = existing?.updated_at_lp
      && newUpdatedAt
      && existing.updated_at_lp === newUpdatedAt
      && (existing.ghl_contact_id === ghlId || (!ghlId && existing.ghl_contact_id));

    if (recordUnchanged && !dispositionChanged) {
      _skipStats.leads++;
      // Still handle GHL tag if needed
      if (ghlId && !existing?.ghl_tag_applied) {
        const success = await applyGHLTag(ghlId, tag);
        if (success) {
          await supabase.from('lp_leads').update({ ghl_tag_applied: true }).eq('lp_lead_id', lpLeadId);
        }
      }
      continue;
    }

    const { row, isApptSet, isDemoCompleted, isClosedWon } = buildLeadRow(
      prospect, lead, lpLeadId, lpProspectId, bucket, tag, ghlId
    );

    const { error: upsertErr } = await supabase.from('lp_leads').upsert(row, { onConflict: 'lp_lead_id' });
    if (upsertErr) throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);

    // ─── AGENTIC: Emit disposition change event ──────────────────
    if (dispositionChanged) {
      const contactId = ghlId || existing?.ghl_contact_id || null;
      const leadName = `${getField(prospect, 'firstname', 'FirstName') || ''} ${getField(prospect, 'lastname', 'LastName') || ''}`.trim();

      await emitEvent({
        event_type: 'lp.disposition_changed',
        event_subtype: newDisposition,
        source: 'lp_sync',
        entity_type: 'lead',
        entity_id: lpLeadId,
        ghl_contact_id: contactId,
        lp_lead_id: lpLeadId,
        lp_prospect_id: lpProspectId,
        payload: {
          disposition_code: newDisposition,
          previous_disposition: previousDisposition,
          lead_name: leadName,
          rep_name: getField(lead, 'salesrepname', 'SalesRepName') || null,
          lead_source: getField(lead, 'source', 'Source') || null,
          appointment_set: isApptSet,
          demo_completed: isDemoCompleted,
          closed_won: isClosedWon,
        },
        previous_state: previousDisposition ? { disposition_code: previousDisposition } : null,
        new_state: { disposition_code: newDisposition },
        priority: dispositionPriority(newDisposition),
        idempotency_key: `disp_${lpLeadId}_${previousDisposition || 'null'}_${newDisposition}_${new Date().toISOString().slice(0, 10)}`,
      });
    }

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

    // ─── v7.1: REAL-TIME NOTE PUSH on disposition change ─────────
    // After syncNotes() has saved notes to lp_notes, immediately push
    // any unpushed notes for this lead to GHL. This eliminates the
    // 30-60 min delay from waiting for the batch pushNotesToGHL() cycle.
    if (dispositionChanged) {
      const contactId = ghlId || existing?.ghl_contact_id || null;
      if (contactId) {
        pushLeadNotesImmediately(lpLeadId, contactId).catch(err => {
          console.error(`[Sync] Real-time note push failed for lead ${lpLeadId}:`, err.message);
        });
      }
    }

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
    // NOTE: raw_lp_data removed — prospect blob lives on lp_prospects
  }, { onConflict: 'lp_lead_id' });
}
