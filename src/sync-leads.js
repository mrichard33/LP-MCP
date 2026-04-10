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
// v8.0 — active-entry:* tag management. After processing all leads for
//   a prospect, determines the NEWEST lead's source and applies the
//   corresponding active-entry:* tag to the GHL contact. Removes all
//   stale active-entry:* tags first. This ensures routing decisions
//   (appointment type, calendar, messaging) always use the most recent
//   entry source, not a stale one from an older LP lead.
//
// v7.1 — Real-time note push after disposition change.
// v7.0 — DISK I/O OPTIMIZATION: Conditional upserts.

import supabase from './supabase.js';
import { getField, normalizePhone, loggedFirstKeys } from './sync-utils.js';
import { logSyncError } from './sync-log.js';
import { resolveSourceBucket } from './sync-sources.js';
import { lpDateToEastern, lpCreatedDate } from './lp-dates.js';
import { matchToGHL, applyGHLTag, removeGHLTags } from './ghl.js';
import { upsertProspect } from './upsert-prospect.js';
import { combineNotes } from './safe-notes.js';
import { syncCallLogs, syncNotes, syncActivities, syncJobAndMilestones } from './sync-children.js';
import { emitEvent, dispositionPriority } from './event-emitter.js';
import { pushLeadNotesImmediately } from './ghl-notes-sync.js';

// ─── Skip counter for observability ──────────────────────────────
let _skipStats = { leads: 0, prospects: 0 };
export function getSkipStats() { const s = { ..._skipStats }; _skipStats = { leads: 0, prospects: 0 }; return s; }

// ─── active-entry:* constants ────────────────────────────────────
// All possible active-entry:* tags. Used for removal before applying new one.
const ALL_ACTIVE_ENTRY_TAGS = [
  'active-entry:risk-report',
  'active-entry:estimate-calculator',
  'active-entry:chatbot',
  'active-entry:canvassing',
  'active-entry:referral',
  'active-entry:other',
  'active-entry:high-intent-digital',
  'active-entry:unmapped',
];

// Convert entry:X tag to active-entry:X
function toActiveEntryTag(entryTag) {
  if (!entryTag || !entryTag.startsWith('entry:')) return 'active-entry:other';
  return entryTag.replace('entry:', 'active-entry:');
}

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
    },
    isApptSet,
    isDemoCompleted,
    isClosedWon,
  };
}

// ─── Pass 1 Helper — upsertLeadOnly() ────────────────────────────
// Used during fullSync Pass 1. Does NOT emit events or manage active-entry tags.

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
// AGENTIC: Detects disposition changes and emits system events.
// v8.0: Manages active-entry:* tag based on newest LP lead source.

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

  // ─── v8.0: Track each lead's tag + creation date for active-entry resolution ──
  const leadSourceTracker = [];

  for (const lead of leads) {
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'), lpLeadId,
    );
    const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));

    // Track for active-entry:* resolution after the loop
    const createdAt = lpCreatedDate(prospect, lead, getField);
    leadSourceTracker.push({ lpLeadId, tag, createdAt });

    // ─── AGENTIC: Read existing state BEFORE upsert ──────────────
    const { data: existing } = await supabase.from('lp_leads')
      .select('ghl_tag_applied, lp_day15_triggered, disposition_code, ghl_contact_id, updated_at_lp')
      .eq('lp_lead_id', lpLeadId).single();

    const previousDisposition = existing?.disposition_code || null;
    const newDisposition = getField(lead, 'disposition', 'Disposition') || null;
    const newUpdatedAt = lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn'));
    const dispositionChanged = newDisposition && newDisposition !== previousDisposition;

    const recordUnchanged = existing?.updated_at_lp
      && newUpdatedAt
      && existing.updated_at_lp === newUpdatedAt
      && (existing.ghl_contact_id === ghlId || (!ghlId && existing.ghl_contact_id));

    if (recordUnchanged && !dispositionChanged) {
      _skipStats.leads++;
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

    // Apply permanent entry:* tag (attribution — never removed)
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

  // ═════════════════════════════════════════════════════════════════
  // v8.0: ACTIVE-ENTRY TAG MANAGEMENT
  //
  // After processing all leads, find the NEWEST lead's source and
  // apply its active-entry:* tag to the GHL contact. This ensures
  // routing decisions always use the most recent entry source.
  //
  // Example: Annette enters as estimate-calculator (2025), then
  // re-enters as canvassing (2026). Newest lead = canvassing.
  // GHL gets active-entry:canvassing. LP Inbound routes to WE.
  // ═════════════════════════════════════════════════════════════════
  if (ghlId && leadSourceTracker.length > 0) {
    try {
      // Sort by created_at descending — newest first
      leadSourceTracker.sort((a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

      const newestTag = leadSourceTracker[0].tag;
      const activeTag = toActiveEntryTag(newestTag);

      // Remove all stale active-entry:* tags, then apply the current one
      const tagsToRemove = ALL_ACTIVE_ENTRY_TAGS.filter(t => t !== activeTag);
      if (tagsToRemove.length > 0) {
        await removeGHLTags(ghlId, tagsToRemove);
      }
      await applyGHLTag(ghlId, activeTag);

      if (leadSourceTracker.length > 1) {
        console.log(`[Sync] active-entry:* set to ${activeTag} for ${ghlId} (${leadSourceTracker.length} LP leads, newest=${leadSourceTracker[0].lpLeadId})`);
      }
    } catch (err) {
      console.error(`[Sync] active-entry:* tag management failed for ${ghlId}:`, err.message);
      // Non-critical — don't break sync
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // v9.0: EMAIL ENRICHMENT CHECK
  //
  // After processing all leads, check if LP has a high-confidence email
  // for this prospect. If so, emit an enrichment event for the Decision
  // Engine to process (which will update the GHL contact's email).
  // ═════════════════════════════════════════════════════════════════
  if (ghlId) {
    try {
      const { findBestEmailForProspect } = await import('./email-scorer.js');
      const prospectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));
      const firstName = getField(prospect, 'firstname', 'FirstName', 'first_name');
      const lastName = getField(prospect, 'lastname', 'LastName', 'last_name');

      const bestEmail = await findBestEmailForProspect(prospectId, { firstName, lastName });

      if (bestEmail && bestEmail.score >= 75) {
        const idempKey = `email_enrich_${ghlId}_${bestEmail.email}_${new Date().toISOString().slice(0, 10)}`;

        await emitEvent({
          event_type: 'email.enrichment_available',
          event_subtype: bestEmail.score >= 85 ? 'high_confidence' : 'medium_confidence',
          source: 'lp_sync',
          entity_type: 'contact',
          entity_id: ghlId,
          ghl_contact_id: ghlId,
          lp_prospect_id: prospectId,
          payload: {
            candidate_email: bestEmail.email,
            confidence_score: bestEmail.score,
            scoring_reasons: bestEmail.reasons,
            source_lead_id: bestEmail.sourceLeadId,
            prospect_first_name: firstName,
            prospect_last_name: lastName,
          },
          priority: 'normal',
          idempotency_key: idempKey,
        });
      }
    } catch (err) {
      console.error(`[Sync] Email enrichment check failed for ${ghlId}:`, err.message);
      // Non-critical — don't break sync
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
  }, { onConflict: 'lp_lead_id' });
}
