import supabase from './supabase.js';
import { getLeads, getLead, getLeadCalls, getLeadNotes, getLeadActivities, getJob, getDispositions, getLeadsUpdatedSince, getMilestones, getSources, getSubSources, getProspectData, getLeadData, testConnection } from './lp-client.js';
import { matchToGHL, applyGHLTag } from './ghl.js';
import { normalizeSourceAndTag } from './normalization.js';
import { processMilestoneTriggers } from './milestones.js';

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BATCH_SIZE = 50;

// ─── Field Mapping: LP API → Supabase ────────────────────────────
// LP API returns fields in various casings/naming conventions depending on endpoint.
// We attempt multiple field names to handle GetLead, GetProspectData, GetLeadData, etc.
function mapLeadToRow(lp) {
  // LP API field names vary by endpoint — try all known variants
  const createdAt = lp.DateAdded || lp.dateadded || lp.date_added
    || lp.created_date || lp.createdate || lp.created_at
    || lp.DateReceived || lp.datereceived || null;
  const updatedAt = lp.LastChanged || lp.lastchanged || lp.last_changed
    || lp.updated_date || lp.updatedate || lp.updated_at || lp.lastmodified || null;
  const demoDate = lp.DemoDate || lp.demo_date || lp.demodate
    || lp.ApptResultDate || lp.appointment_result_date || null;
  const appointmentDate = lp.ApptDate || lp.appointment_date || lp.appointmentdate
    || lp.appt_date || lp.SalesApptDate || null;
  const closeDate = lp.CloseDate || lp.close_date || lp.closedate
    || lp.SoldDate || lp.sold_date || null;

  // Lead/prospect ID — LP uses various field names
  const leadId = lp.ProspectID || lp.prospect_id || lp.prospectid
    || lp.IssuedLeadID || lp.issued_lead_id || lp.ils_id
    || lp.CustomerID || lp.customer_id || lp.cst_id
    || lp.id || lp.lead_id || lp.leadid;

  const row = {
    lp_lead_id: String(leadId),
    first_name: lp.FirstName || lp.first_name || lp.firstname || lp.fname || null,
    last_name: lp.LastName || lp.last_name || lp.lastname || lp.lname || null,
    email: lp.Email || lp.email || lp.EmailAddress || lp.emailaddress || null,
    phone: lp.Phone || lp.phone || lp.Phone1 || lp.phone1 || lp.HomePhone || lp.homephone || null,
    phone_alt: lp.Phone2 || lp.phone_alt || lp.phone2 || lp.CellPhone || lp.cellphone || lp.WorkPhone || lp.workphone || null,
    address: lp.Address1 || lp.address || lp.address1 || lp.street || null,
    city: lp.City || lp.city || null,
    state: lp.State || lp.state || null,
    zip: lp.Zip || lp.zip || lp.ZipCode || lp.zipcode || null,
    lead_source: lp.Source || lp.source || lp.LeadSource || lp.leadsource || null,
    lead_source_detail: lp.SourceSubDescr || lp.sourcesubdescr || lp.source_detail || lp.sourcesubdetail || null,
    disposition_code: lp.Disposition || lp.disposition || lp.DispositionCode || lp.dispositioncode || lp.disp_code || null,
    disposition_label: lp.DispositionDesc || lp.disposition_label || lp.dispositiondesc || lp.disp_label || null,
    rep_id: lp.SalesRepID || lp.rep_id || lp.repid || lp.salesperson_id || lp.ILS_ID || null,
    rep_name: lp.SalesRepName || lp.rep_name || lp.repname || lp.salesperson || null,
    call_count: lp.CallCount || lp.call_count || lp.callcount || lp.totalcalls || 0,
    last_call_date: lp.LastCallDate || lp.last_call_date || lp.lastcalldate || null,
    last_contact_date: lp.LastContactDate || lp.last_contact_date || lp.lastcontactdate || null,
    appointment_set: !!(appointmentDate || lp.AppointmentSet || lp.appointment_set || lp.appt_set),
    appointment_date: appointmentDate,
    demo_completed: !!(demoDate || lp.DemoCompleted || lp.demo_completed || lp.democompleted),
    demo_date: demoDate,
    closed_won: !!(closeDate || lp.ClosedWon || lp.closed_won || lp.sold || lp.Sold),
    close_date: closeDate,
    job_value: lp.ContractAmount || lp.contract_amount || lp.contractamount
      || lp.JobValue || lp.job_value || lp.jobvalue || null,
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

// ─── Extract leads array from LP API response ───────────────────
// LP API may return data as a direct array, or nested under various keys
function extractLeadsArray(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  // LP API may wrap results in these keys
  for (const key of ['data', 'leads', 'results', 'Result', 'Records', 'records', 'Customers', 'customers']) {
    if (Array.isArray(response[key])) return response[key];
  }
  // If it's a single object with a prospect/lead ID, wrap it
  if (response.ProspectID || response.prospect_id || response.IssuedLeadID) {
    return [response];
  }
  return [];
}

// ─── Full Sync (initial load) ────────────────────────────────────

export async function fullSync() {
  console.log('[Sync] Starting FULL sync...');
  const startTime = new Date();
  const stats = { processed: 0, inserted: 0, updated: 0, failed: 0, errors: [] };

  // Step 0: Test LP API connection
  try {
    const connStatus = await testConnection();
    console.log(`[Sync] LP API connection: auth=${connStatus.auth_status}, api=${connStatus.api_test}`);
    if (connStatus.auth_status !== 'success') {
      console.error('[Sync] LP API authentication failed — cannot sync. Check LP_SERVER_ID, LP_CLIENT_ID, LP_USERNAME, LP_PASSWORD, LP_APP_KEY env vars.');
      stats.errors.push({ fatal: 'LP API auth failed', details: connStatus.errors });
      await logSync('full', stats, startTime);
      return stats;
    }
  } catch (err) {
    console.error('[Sync] LP API connection test failed:', err.message);
    stats.errors.push({ fatal: `LP connection: ${err.message}` });
    await logSync('full', stats, startTime);
    return stats;
  }

  try {
    // Step 1: Sync dispositions reference table
    await syncDispositions();

    // Step 1b: Sync sources reference
    await syncSources();

    // Step 2: Fetch all leads (paginated via start_index)
    let startIndex = 0;
    let hasMore = true;

    while (hasMore) {
      let leadsResponse;
      try {
        leadsResponse = await getLeads({ page_size: BATCH_SIZE, start_index: startIndex });
      } catch (err) {
        console.error(`[Sync] Failed to fetch leads at index ${startIndex}:`, err.message);
        stats.errors.push({ start_index: startIndex, error: err.message });
        break;
      }

      const leads = extractLeadsArray(leadsResponse);

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
          const lid = lead.ProspectID || lead.prospect_id || lead.id || lead.lead_id;
          stats.errors.push({ lead_id: lid, error: err.message });
          console.error(`[Sync] Lead sync failed:`, err.message);
        }
      }

      console.log(`[Sync] Processed batch at index ${startIndex} (${leads.length} leads)`);

      // If we got fewer than BATCH_SIZE, we've reached the end
      if (leads.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        startIndex += leads.length;
      }
    }

    // Step 3: Process milestone triggers
    try {
      const milestoneResult = await processMilestoneTriggers();
      console.log(`[Sync] Milestones: ${milestoneResult.fired} tags fired`);
    } catch (err) {
      console.warn('[Sync] Milestone processing failed:', err.message);
    }

    // Step 4: Check Day 15 handoff condition
    try {
      await checkDay15Handoffs();
    } catch (err) {
      console.warn('[Sync] Day 15 check failed:', err.message);
    }

    // Step 5: Check lead-level triggers (demo completed, closed won, etc.)
    try {
      await checkLeadTriggers();
    } catch (err) {
      console.warn('[Sync] Lead trigger checks failed:', err.message);
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

    const leads = extractLeadsArray(updatedLeads);

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

    // Check Day 15 handoff condition
    try {
      await checkDay15Handoffs();
    } catch (err) {
      console.warn('[Sync] Day 15 check failed:', err.message);
    }

    // Check lead-level triggers
    try {
      await checkLeadTriggers();
    } catch (err) {
      console.warn('[Sync] Lead trigger checks failed:', err.message);
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
    const response = await getDispositions();
    // LP API GetSalesApptDispProd returns dispositions in various possible formats
    const items = extractLeadsArray(response);

    let synced = 0;
    for (const d of items) {
      const code = String(d.Code || d.code || d.disposition_code || d.DispositionCode || d.ID || d.id || '');
      if (!code) continue;

      await supabase.from('lp_dispositions').upsert({
        disposition_code: code,
        disposition_label: d.Description || d.description || d.Label || d.label || d.Name || d.name || d.disposition_label || '',
        category: d.Category || d.category || null,
        is_recoverable: d.is_recoverable ?? true,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'disposition_code' });
      synced++;
    }
    console.log(`[Sync] Synced ${synced} dispositions`);
  } catch (err) {
    console.warn('[Sync] Dispositions sync failed:', err.message);
  }
}

// ─── Sync sources reference data ─────────────────────────────────

async function syncSources() {
  try {
    // Fetch parent sources
    const sourcesResp = await getSources('S');
    const sources = extractLeadsArray(sourcesResp);
    console.log(`[Sync] Fetched ${sources.length} parent sources`);

    // Fetch sub-sources (sourcesubdescr)
    const subResp = await getSubSources();
    const subSources = extractLeadsArray(subResp);
    console.log(`[Sync] Fetched ${subSources.length} sub-sources`);
  } catch (err) {
    console.warn('[Sync] Sources sync failed:', err.message);
  }
}

// ─── Day 15 Handoff — Automatic Check ────────────────────────────

async function checkDay15Handoffs() {
  try {
    // Find leads ≥15 days old, not closed, no Day 15 tag yet, with a GHL contact
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const { data: eligibleLeads, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, first_name, last_name, created_at_lp, last_contact_date')
      .eq('lp_day15_triggered', false)
      .eq('closed_won', false)
      .not('ghl_contact_id', 'is', null)
      .lt('created_at_lp', fifteenDaysAgo);

    if (error) {
      console.error('[Sync] Day 15 query failed:', error.message);
      return { triggered: 0 };
    }

    let triggered = 0;

    for (const lead of (eligibleLeads || [])) {
      // Additional check: last_contact_date > 14 days ago (or null)
      if (lead.last_contact_date) {
        const lastContact = new Date(lead.last_contact_date);
        const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        if (lastContact.getTime() > fourteenDaysAgo) continue;
      }

      const success = await applyGHLTag(lead.ghl_contact_id, 'lp-day15-handoff');

      if (success) {
        await supabase.from('lp_leads')
          .update({ lp_day15_triggered: true })
          .eq('lp_lead_id', lead.lp_lead_id);

        await supabase.from('lp_trigger_log').insert({
          lp_lead_id: lead.lp_lead_id,
          ghl_contact_id: lead.ghl_contact_id,
          event: 'day15_handoff_auto',
          tag_fired: 'lp-day15-handoff',
          status: 'success',
        });
        triggered++;
      }
    }

    if (triggered > 0) {
      console.log(`[Sync] Day 15 handoff: ${triggered} leads triggered for W11.0 enrollment`);
    }
    return { triggered };
  } catch (err) {
    console.error('[Sync] Day 15 handoff check failed:', err.message);
    return { triggered: 0 };
  }
}

// ─── Lead-Level Trigger Checks ───────────────────────────────────

async function checkLeadTriggers() {
  try {
    // Check for demo_completed leads needing tag
    const { data: demoLeads } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id')
      .eq('demo_completed', true)
      .not('ghl_contact_id', 'is', null)
      .not('raw_lp_data->demo_tag_fired', 'eq', true);

    // Check for closed_won leads needing tag
    const { data: wonLeads } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id')
      .eq('closed_won', true)
      .not('ghl_contact_id', 'is', null)
      .not('raw_lp_data->won_tag_fired', 'eq', true);

    // These are best-effort — failures don't block sync
    for (const lead of (demoLeads || [])) {
      await applyGHLTag(lead.ghl_contact_id, 'lp-demo-completed');
    }
    for (const lead of (wonLeads || [])) {
      await applyGHLTag(lead.ghl_contact_id, 'deal-won');
    }
  } catch (err) {
    console.warn('[Sync] Lead trigger checks failed:', err.message);
  }
}

// ─── Webhook Handler ─────────────────────────────────────────────

export async function handleWebhookEvent(event, payload) {
  const startTime = new Date();
  const stats = { processed: 0, failed: 0, errors: [] };

  try {
    switch (event) {
      case 'lead.created':
      case 'lead.updated':
      case 'lead.disposition_changed': {
        const lead = payload.lead || payload;
        await syncSingleLead(lead);
        stats.processed++;

        // Run source normalization + Day 15 check inline
        await processMilestoneTriggers();
        break;
      }

      case 'job.status_changed': {
        const job = payload.job || payload;
        // Re-sync the lead to pick up job changes
        if (job.lead_id || job.lp_lead_id) {
          try {
            const lead = await getLead(job.lead_id || job.lp_lead_id);
            await syncSingleLead(lead);
          } catch (err) {
            stats.errors.push({ error: err.message });
          }
        }
        await processMilestoneTriggers();
        stats.processed++;
        break;
      }

      case 'call.logged':
      case 'note.added': {
        const leadId = payload.lead_id || payload.lp_lead_id;
        if (leadId) {
          try {
            const lead = await getLead(leadId);
            await syncSingleLead(lead);
            stats.processed++;
          } catch (err) {
            stats.failed++;
            stats.errors.push({ lead_id: leadId, error: err.message });
          }
        }
        break;
      }

      case 'milestone.completed': {
        // Immediate milestone fire
        const leadId = payload.lead_id || payload.lp_lead_id;
        if (leadId) {
          try {
            const lead = await getLead(leadId);
            await syncSingleLead(lead);
          } catch (err) {
            stats.errors.push({ error: err.message });
          }
        }
        await processMilestoneTriggers();
        stats.processed++;
        break;
      }

      default:
        console.warn(`[Webhook] Unknown event type: ${event}`);
    }
  } catch (err) {
    stats.failed++;
    stats.errors.push({ fatal: err.message });
    console.error(`[Webhook] Event processing failed for ${event}:`, err.message);
  }

  await logSync(`webhook_${event}`, stats, startTime);
  return stats;
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
