import supabase from './supabase.js';
import { getLeads, getLead, getLeadCalls, getLeadNotes, getLeadActivities, getJob, getDispositions, getLeadsUpdatedSince } from './lp-client.js';
import { matchToGHL } from './ghl.js';
import { normalizeSourceAndTag } from './normalization.js';
import { processMilestoneTriggers } from './milestones.js';

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BATCH_SIZE = 50;

// ─── Field Mapping: LP API → Supabase ────────────────────────────
function mapLeadToRow(lp) {
  const createdAt = lp.created_date || lp.createdate || lp.created_at || null;
  const updatedAt = lp.updated_date || lp.updatedate || lp.updated_at || lp.lastmodified || null;
  const demoDate = lp.demo_date || lp.demodate || lp.appointment_result_date || null;
  const appointmentDate = lp.appointment_date || lp.appointmentdate || lp.appt_date || null;
  const closeDate = lp.close_date || lp.closedate || lp.sold_date || null;

  const row = {
    lp_lead_id: String(lp.id || lp.lead_id || lp.leadid),
    first_name: lp.first_name || lp.firstname || lp.fname || null,
    last_name: lp.last_name || lp.lastname || lp.lname || null,
    email: lp.email || lp.emailaddress || null,
    phone: lp.phone || lp.phone1 || lp.homephone || null,
    phone_alt: lp.phone_alt || lp.phone2 || lp.cellphone || lp.workphone || null,
    address: lp.address || lp.address1 || lp.street || null,
    city: lp.city || null,
    state: lp.state || null,
    zip: lp.zip || lp.zipcode || null,
    lead_source: lp.source || lp.leadsource || null,
    lead_source_detail: lp.sourcesubdescr || lp.source_detail || lp.sourcesubdetail || null,
    disposition_code: lp.disposition || lp.dispositioncode || lp.disp_code || null,
    disposition_label: lp.disposition_label || lp.dispositiondesc || lp.disp_label || null,
    rep_id: lp.rep_id || lp.repid || lp.salesperson_id || null,
    rep_name: lp.rep_name || lp.repname || lp.salesperson || null,
    call_count: lp.call_count || lp.callcount || lp.totalcalls || 0,
    last_call_date: lp.last_call_date || lp.lastcalldate || null,
    last_contact_date: lp.last_contact_date || lp.lastcontactdate || null,
    appointment_set: !!(appointmentDate || lp.appointment_set || lp.appt_set),
    appointment_date: appointmentDate,
    demo_completed: !!(demoDate || lp.demo_completed || lp.democompleted),
    demo_date: demoDate,
    closed_won: !!(closeDate || lp.closed_won || lp.sold),
    close_date: closeDate,
    job_value: lp.job_value || lp.jobvalue || lp.contract_amount || lp.contractamount || null,
    created_at_lp: createdAt,
    updated_at_lp: updatedAt,
    synced_at: new Date().toISOString(),
    raw_lp_data: lp,
  };

  // Calculate days_to_demo
  if (row.demo_date && row.created_at_lp) {
    const diff = new Date(row.demo_date) - new Date(row.created_at_lp);
    row.days_to_demo = Math.round(diff / 86400000);
  }

  return row;
}

function mapCallToRow(call, lpLeadId, ghlContactId) {
  return {
    lp_call_id: String(call.id || call.call_id || call.callid),
    lp_lead_id: lpLeadId,
    ghl_contact_id: ghlContactId || null,
    call_date: call.call_date || call.calldate || call.date || null,
    call_duration_sec: call.duration || call.call_duration || call.duration_sec || null,
    call_result: call.result || call.call_result || call.outcome || null,
    call_direction: call.direction || call.call_direction || null,
    rep_id: call.rep_id || call.repid || null,
    rep_name: call.rep_name || call.repname || null,
    call_notes: call.notes || call.call_notes || null,
    recording_url: call.recording_url || call.recordingurl || null,
    synced_at: new Date().toISOString(),
    raw_lp_data: call,
  };
}

function mapNoteToRow(note, lpLeadId, ghlContactId) {
  return {
    lp_note_id: String(note.id || note.note_id || note.noteid),
    lp_lead_id: lpLeadId,
    ghl_contact_id: ghlContactId || null,
    note_body: note.body || note.note || note.text || note.content || null,
    note_type: note.type || note.note_type || null,
    created_by_rep_id: note.rep_id || note.created_by || null,
    created_by_rep_name: note.rep_name || note.created_by_name || null,
    created_at_lp: note.created_date || note.created_at || note.date || null,
    synced_at: new Date().toISOString(),
    raw_lp_data: note,
  };
}

function mapActivityToRow(activity, lpLeadId) {
  return {
    lp_activity_id: String(activity.id || activity.activity_id || activity.activityid),
    lp_lead_id: lpLeadId,
    activity_type: activity.type || activity.activity_type || null,
    activity_detail: activity.detail || activity.description || activity.activity_detail || null,
    rep_id: activity.rep_id || activity.repid || null,
    rep_name: activity.rep_name || activity.repname || null,
    activity_date: activity.date || activity.activity_date || null,
    synced_at: new Date().toISOString(),
    raw_lp_data: activity,
  };
}

// ─── Sync Logic ──────────────────────────────────────────────────

async function syncSingleLead(lpLead) {
  const row = mapLeadToRow(lpLead);

  // Upsert lead
  const { error: leadErr } = await supabase
    .from('lp_leads')
    .upsert(row, { onConflict: 'lp_lead_id' });

  if (leadErr) {
    throw new Error(`Lead upsert failed for ${row.lp_lead_id}: ${leadErr.message}`);
  }

  // Match to GHL
  let ghlContactId = null;
  try {
    ghlContactId = await matchToGHL({
      phone: row.phone,
      phone_alt: row.phone_alt,
      email: row.email,
    });
    if (ghlContactId) {
      await supabase.from('lp_leads')
        .update({ ghl_contact_id: ghlContactId })
        .eq('lp_lead_id', row.lp_lead_id);
    }
  } catch (err) {
    console.warn(`[Sync] GHL match failed for ${row.lp_lead_id}:`, err.message);
  }

  // Normalize source → intent bucket + apply GHL tag
  try {
    await normalizeSourceAndTag({
      lp_lead_id: row.lp_lead_id,
      sourcesubdescr: row.lead_source_detail,
      source: row.lead_source,
      ghl_tag_applied: false,
    }, ghlContactId);
  } catch (err) {
    console.warn(`[Sync] Normalization failed for ${row.lp_lead_id}:`, err.message);
  }

  // Sync calls, notes, activities in parallel
  const lpLeadId = row.lp_lead_id;
  await Promise.allSettled([
    syncLeadCalls(lpLeadId, ghlContactId),
    syncLeadNotes(lpLeadId, ghlContactId),
    syncLeadActivities(lpLeadId),
  ]);

  return lpLeadId;
}

async function syncLeadCalls(lpLeadId, ghlContactId) {
  try {
    const calls = await getLeadCalls(lpLeadId);
    const items = Array.isArray(calls) ? calls : calls?.data || calls?.calls || [];
    if (items.length === 0) return;

    const rows = items.map(c => mapCallToRow(c, lpLeadId, ghlContactId));
    const { error } = await supabase
      .from('lp_call_logs')
      .upsert(rows, { onConflict: 'lp_call_id' });
    if (error) console.warn(`[Sync] Call upsert failed for lead ${lpLeadId}:`, error.message);
  } catch (err) {
    // Not all leads have calls — 404 is expected
    if (err.response?.status !== 404) {
      console.warn(`[Sync] Calls fetch failed for ${lpLeadId}:`, err.message);
    }
  }
}

async function syncLeadNotes(lpLeadId, ghlContactId) {
  try {
    const notes = await getLeadNotes(lpLeadId);
    const items = Array.isArray(notes) ? notes : notes?.data || notes?.notes || [];
    if (items.length === 0) return;

    const rows = items.map(n => mapNoteToRow(n, lpLeadId, ghlContactId));
    const { error } = await supabase
      .from('lp_notes')
      .upsert(rows, { onConflict: 'lp_note_id' });
    if (error) console.warn(`[Sync] Note upsert failed for lead ${lpLeadId}:`, error.message);
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn(`[Sync] Notes fetch failed for ${lpLeadId}:`, err.message);
    }
  }
}

async function syncLeadActivities(lpLeadId) {
  try {
    const activities = await getLeadActivities(lpLeadId);
    const items = Array.isArray(activities) ? activities : activities?.data || activities?.activities || [];
    if (items.length === 0) return;

    const rows = items.map(a => mapActivityToRow(a, lpLeadId));
    const { error } = await supabase
      .from('lp_activities')
      .upsert(rows, { onConflict: 'lp_activity_id' });
    if (error) console.warn(`[Sync] Activity upsert failed for lead ${lpLeadId}:`, error.message);
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn(`[Sync] Activities fetch failed for ${lpLeadId}:`, err.message);
    }
  }
}

async function logSync(syncType, stats, startTime) {
  const completed = new Date();
  try {
    await supabase.from('lp_sync_log').insert({
      sync_type: syncType,
      records_processed: stats.processed,
      records_inserted: stats.inserted,
      records_updated: stats.updated,
      records_failed: stats.failed,
      error_details: stats.errors.length > 0 ? stats.errors : null,
      started_at: startTime.toISOString(),
      completed_at: completed.toISOString(),
      duration_ms: completed - startTime,
    });
  } catch (err) {
    console.error('[Sync] Failed to write sync log:', err.message);
  }
}

// ─── Full Sync (initial load) ────────────────────────────────────

export async function fullSync() {
  console.log('[Sync] Starting FULL sync...');
  const startTime = new Date();
  const stats = { processed: 0, inserted: 0, updated: 0, failed: 0, errors: [] };

  try {
    // Step 1: Sync dispositions reference table
    await syncDispositions();

    // Step 2: Fetch all leads (paginated)
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      let leadsResponse;
      try {
        leadsResponse = await getLeads({ page, limit: BATCH_SIZE });
      } catch (err) {
        console.error(`[Sync] Failed to fetch leads page ${page}:`, err.message);
        stats.errors.push({ page, error: err.message });
        break;
      }

      const leads = Array.isArray(leadsResponse)
        ? leadsResponse
        : leadsResponse?.data || leadsResponse?.leads || leadsResponse?.results || [];

      if (leads.length === 0) {
        hasMore = false;
        break;
      }

      for (const lead of leads) {
        try {
          await syncSingleLead(lead);
          stats.processed++;
          stats.inserted++;
        } catch (err) {
          stats.failed++;
          stats.errors.push({ lead_id: lead.id || lead.lead_id, error: err.message });
          console.error(`[Sync] Lead sync failed:`, err.message);
        }
      }

      console.log(`[Sync] Processed page ${page} (${leads.length} leads)`);

      // If we got fewer than BATCH_SIZE, we've reached the end
      if (leads.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        page++;
      }
    }

    // Step 3: Process milestone triggers
    try {
      const milestoneResult = await processMilestoneTriggers();
      console.log(`[Sync] Milestones: ${milestoneResult.fired} tags fired`);
    } catch (err) {
      console.warn('[Sync] Milestone processing failed:', err.message);
    }

  } catch (err) {
    console.error('[Sync] Full sync failed:', err.message);
    stats.errors.push({ fatal: err.message });
  }

  await logSync('full', stats, startTime);
  console.log(`[Sync] Full sync complete — ${stats.processed} processed, ${stats.failed} failed (${Date.now() - startTime}ms)`);
  return stats;
}

// ─── Incremental Sync (delta updates) ────────────────────────────

export async function incrementalSync() {
  console.log('[Sync] Starting incremental sync...');
  const startTime = new Date();
  const stats = { processed: 0, inserted: 0, updated: 0, failed: 0, errors: [] };

  try {
    // Get last sync time
    const { data: lastSync } = await supabase
      .from('lp_sync_log')
      .select('completed_at')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();

    if (!lastSync?.completed_at) {
      console.log('[Sync] No previous sync found — running full sync instead');
      return fullSync();
    }

    const since = lastSync.completed_at;
    let updatedLeads;
    try {
      updatedLeads = await getLeadsUpdatedSince(since);
    } catch (err) {
      console.error('[Sync] Failed to fetch updated leads:', err.message);
      stats.errors.push({ error: err.message });
      await logSync('incremental', stats, startTime);
      return stats;
    }

    const leads = Array.isArray(updatedLeads)
      ? updatedLeads
      : updatedLeads?.data || updatedLeads?.leads || updatedLeads?.results || [];

    for (const lead of leads) {
      try {
        await syncSingleLead(lead);
        stats.processed++;
        stats.updated++;
      } catch (err) {
        stats.failed++;
        stats.errors.push({ lead_id: lead.id || lead.lead_id, error: err.message });
      }
    }

    // Process milestone triggers
    try {
      await processMilestoneTriggers();
    } catch (err) {
      console.warn('[Sync] Milestone processing failed:', err.message);
    }

  } catch (err) {
    console.error('[Sync] Incremental sync failed:', err.message);
    stats.errors.push({ fatal: err.message });
  }

  await logSync('incremental', stats, startTime);
  console.log(`[Sync] Incremental sync complete — ${stats.processed} processed, ${stats.failed} failed`);
  return stats;
}

// ─── Sync dispositions reference data ────────────────────────────

async function syncDispositions() {
  try {
    const dispositions = await getDispositions();
    const items = Array.isArray(dispositions) ? dispositions : dispositions?.data || dispositions?.dispositions || [];

    for (const d of items) {
      await supabase.from('lp_dispositions').upsert({
        disposition_code: String(d.code || d.disposition_code || d.id),
        disposition_label: d.label || d.description || d.name || d.disposition_label || '',
        category: d.category || null,
        is_recoverable: d.is_recoverable ?? true,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'disposition_code' });
    }
    console.log(`[Sync] Synced ${items.length} dispositions`);
  } catch (err) {
    console.warn('[Sync] Dispositions sync failed:', err.message);
  }
}

// ─── Scheduler ───────────────────────────────────────────────────

let syncTimer = null;

export function startSyncScheduler() {
  if (!supabase) {
    console.warn('[Sync] Supabase not configured — sync disabled');
    return;
  }

  console.log(`[Sync] Scheduler started — incremental sync every ${SYNC_INTERVAL_MS / 60000} minutes`);

  // Run initial full sync after 5 second delay (let server boot first)
  setTimeout(async () => {
    try {
      // Check if we've ever synced
      const { data: lastSync } = await supabase
        .from('lp_sync_log')
        .select('id')
        .limit(1)
        .single();

      if (lastSync) {
        console.log('[Sync] Previous sync found — running incremental sync');
        await incrementalSync();
      } else {
        console.log('[Sync] No previous sync — running initial full sync');
        await fullSync();
      }
    } catch (err) {
      // .single() throws when no rows — that means first run
      console.log('[Sync] First run — starting full sync');
      await fullSync();
    }
  }, 5000);

  // Schedule incremental syncs
  syncTimer = setInterval(async () => {
    try {
      await incrementalSync();
    } catch (err) {
      console.error('[Sync] Scheduled sync failed:', err.message);
    }
  }, SYNC_INTERVAL_MS);
}

export function stopSyncScheduler() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log('[Sync] Scheduler stopped');
  }
}
