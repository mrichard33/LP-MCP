// ─── Sync Engine — src/sync-engine.js ─────────────────────────────
//
// v5.0 — Runs inside the Railway service alongside the MCP server.
// All LP calls go through src/lp-client.js (token + retry managed there).
//
// Boot sequence:
//   1. Pre-warm LP token
//   2. 5-second delay for server init
//   3. Full sync via POST /api/Customers/GetLead (date-range paginated)
//   4. Every 15 min: incremental via GetLeadData + GetJobStatusChanges
//
// LP GetLead response structure (prospect-level):
//   { cst_id, firstname, lastname, email, phone1, altphones[], address1,
//     city, state, zip, leads: [{ id, source, sourcesubdescr, promotername,
//     disposition, salesrepname, entrydate, lastchangedon, apptset, apptdate,
//     sat, sold, gsa, jobs: [{ id, jobstatus, grossamount, milestones: [{
//     mdt_id, datetype, estdate, actdate, enteredby, enteredon }] }],
//     notes: [] }], calls: [], notes: [] }

import supabase from './supabase.js';
import { getToken, startTokenRefreshSchedule } from './token-manager.js';
import {
  getLeads, getLeadData, getJobStatusChanges, getDispositions,
  getSources, getSubSources, getLead, lpPost, testConnection,
} from './lp-client.js';
import { matchToGHL, applyGHLTag } from './ghl.js';
import { normalizeSourceAndTag } from './normalization.js';
import { processMilestoneTriggers } from './milestones.js';

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PAGE_SIZE = 50;
const RATE_LIMIT_SLEEP_MS = 300; // LP monitors for excessive use

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '') || null;
}

// ─── Extract array from LP API response ──────────────────────────
// LP may return a direct array, or nested under various keys.
function extractArray(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  for (const key of ['data', 'leads', 'results', 'Result', 'Records', 'records', 'Customers', 'customers']) {
    if (Array.isArray(response[key])) return response[key];
  }
  // Single object with prospect ID — wrap it
  if (response.cst_id || response.ProspectID || response.prospect_id) {
    return [response];
  }
  return [];
}

// ─── Sync Log ────────────────────────────────────────────────────

async function logSync(opts) {
  const completed = new Date();
  try {
    await supabase.from('lp_sync_log').insert({
      sync_type:         opts.sync_type,
      records_processed: opts.records_processed || 0,
      records_inserted:  opts.records_inserted  || 0,
      records_updated:   opts.records_updated   || 0,
      records_failed:    opts.records_failed    || 0,
      error_details:     opts.errors?.length > 0 ? opts.errors : null,
      started_at:        opts.started_at.toISOString(),
      completed_at:      completed.toISOString(),
      duration_ms:       opts.duration_ms || (completed - opts.started_at),
    });
  } catch (err) {
    console.error('[Sync] Failed to write sync log:', err.message);
  }
}

async function logSyncError(entityId, err) {
  console.error(`[Sync] Entity ${entityId} failed:`, err.message);
}

async function getLastSyncTimestamp() {
  try {
    const { data } = await supabase
      .from('lp_sync_log')
      .select('completed_at')
      .gt('records_processed', 0)              // Ignore 0-record syncs (failed v4 runs)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();                          // Returns null on 0 rows instead of throwing
    return data?.completed_at ? new Date(data.completed_at) : null;
  } catch (err) {
    console.error('[Sync] Failed to read sync log:', err.message);
    return null;  // Treat errors as "never synced" → triggers full sync
  }
}

// ─── Source Enumeration — Run before first sync ──────────────────

async function populateSourceMapping() {
  try {
    // Get all sub-sources (sourcesubdescr values) — PRIMARY lookup key
    const subSources = await getSubSources();
    const subArr = extractArray(subSources);
    console.log(`[Sync] Sub-sources from LP: ${subArr.length} values`);

    // Get all parent sources — FALLBACK when subdetail is empty
    const sources = await getSources('s');
    const srcArr = extractArray(sources);
    console.log(`[Sync] Parent sources from LP: ${srcArr.length} values`);

    // Log for manual review — Ryan classifies each into a bucket
    if (subArr.length > 0) {
      console.log('[Sync] Sub-source sample:', JSON.stringify(subArr.slice(0, 5)));
    }
    if (srcArr.length > 0) {
      console.log('[Sync] Parent source sample:', JSON.stringify(srcArr.slice(0, 5)));
    }
  } catch (err) {
    console.warn('[Sync] Source enumeration failed:', err.message);
  }
}

// ─── Sync Dispositions ───────────────────────────────────────────

async function syncDispositions() {
  try {
    const response = await getDispositions();
    const items = extractArray(response);

    let synced = 0;
    for (const d of items) {
      const code = String(d.Code || d.code || d.disposition_code || d.DispositionCode || d.ID || d.id || '');
      if (!code) continue;

      await supabase.from('lp_dispositions').upsert({
        disposition_code: code,
        disposition_label: d.Description || d.description || d.Label || d.label || d.Name || d.name || '',
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

// ─── Source Normalization — resolveSourceBucket() ─────────────────

async function resolveSourceBucket(sourcesubdescr, source) {
  // Try sourcesubdescr first (primary intent signal)
  if (sourcesubdescr) {
    const { data } = await supabase.from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_subdetail', sourcesubdescr).single();
    if (data) return { bucket: data.ghl_intent_bucket, tag: data.ghl_entry_tag };
  }
  // Fall back to parent source field
  if (source) {
    const { data } = await supabase.from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_raw', source).is('lp_source_subdetail', null).single();
    if (data) return { bucket: data.ghl_intent_bucket, tag: data.ghl_entry_tag };
  }
  // Default — log for mapping review
  await logUnmappedSource(sourcesubdescr, source);
  return { bucket: 'other', tag: 'entry:other' };
}

async function logUnmappedSource(sourceSubdetail, sourceRaw) {
  try {
    if (!sourceSubdetail && !sourceRaw) return;
    await supabase.from('lp_unmapped_sources').upsert({
      source_subdetail: sourceSubdetail || null,
      source_raw: sourceRaw || null,
    }, { onConflict: 'source_subdetail,source_raw' }).catch(() => {
      // Table may not exist yet — that's OK
    });
  } catch (err) {
    // Non-critical — just log
    console.warn(`[Sync] Unmapped source: subdetail="${sourceSubdetail}", raw="${sourceRaw}"`);
  }
}

// ─── Milestone Tag Map (mdt_id → GHL tag) ────────────────────────

const MDT_TAG_MAP = {
  R: 'lp-milestone-rtp',          M: 'lp-milestone-measure',
  O: 'lp-milestone-quoted',       H: 'lp-milestone-hoa-approved',
  K: 'lp-milestone-ordered',      U: 'lp-milestone-permit-submit',
  P: 'lp-milestone-permit-issued', V: 'lp-milestone-recv-windows',
  E: 'lp-milestone-recv-doors',   G: 'lp-milestone-recv-all',
  S: 'lp-milestone-install-start', F: 'lp-milestone-install-end',
  C: 'lp-milestone-completion',   I: 'lp-milestone-insp-set',
  B: 'lp-milestone-insp-passed',  X: 'lp-milestone-snap-trim',
};

// ─── Per-Prospect Processing — processProspect() ─────────────────
//
// The LP GetLead response nests everything under a prospect record:
// contact info at top level, leads[] array inside, each lead has jobs[]
// with milestones[] inside.

async function processProspect(prospect) {
  // 1. Match to GHL contact (phone primary → alt phone → email)
  let ghlId = null;
  try {
    ghlId = await matchToGHL({
      phone: normalizePhone(prospect.phone1 || prospect.Phone1 || prospect.phone),
      phone_alt: normalizePhone(prospect.altphones?.[0]?.phone || prospect.Phone2 || prospect.phone_alt),
      email: prospect.email || prospect.Email || null,
    });
  } catch (err) {
    console.warn(`[Sync] GHL match failed for prospect ${prospect.cst_id}:`, err.message);
  }

  // 2. Process each lead record under this prospect
  const leads = prospect.leads || prospect.Leads || [];
  if (leads.length === 0) {
    // Some endpoints return flat data — treat the prospect itself as a lead
    await upsertLeadFromFlat(prospect, ghlId);
    return;
  }

  for (const lead of leads) {
    const { bucket, tag } = await resolveSourceBucket(
      lead.sourcesubdescr || lead.SourceSubDescr,
      lead.source || lead.Source,
    );

    const lpLeadId = String(lead.id || lead.lds_id || lead.LeadID);
    const lpProspectId = String(prospect.cst_id || prospect.CstID || prospect.prospectid);

    // 3. Check existing state
    const { data: existing } = await supabase
      .from('lp_leads')
      .select('ghl_tag_applied, lp_day15_triggered')
      .eq('lp_lead_id', lpLeadId)
      .single();

    // 4. Upsert core lead record
    const { error: upsertErr } = await supabase.from('lp_leads').upsert({
      lp_lead_id:         lpLeadId,
      lp_prospect_id:     lpProspectId,
      ghl_contact_id:     ghlId,
      first_name:         prospect.firstname || prospect.FirstName || null,
      last_name:          prospect.lastname  || prospect.LastName  || null,
      email:              prospect.email      || prospect.Email     || null,
      phone:              normalizePhone(prospect.phone1 || prospect.Phone1),
      phone_alt:          normalizePhone(prospect.altphones?.[0]?.phone || prospect.Phone2),
      address:            prospect.address1   || prospect.Address1  || null,
      city:               prospect.city       || prospect.City      || null,
      state:              prospect.state      || prospect.State     || null,
      zip:                prospect.zip        || prospect.Zip       || null,
      lead_source:        lead.source         || lead.Source        || null,
      lead_source_detail: lead.sourcesubdescr || lead.SourceSubDescr || null,
      promoter_name:      lead.promotername   || lead.PromoterName  || null,
      ghl_intent_bucket:  bucket,
      ghl_entry_tag:      tag,
      disposition_code:   lead.disposition    || lead.Disposition   || null,
      rep_name:           lead.salesrepname   || lead.SalesRepName  || null,
      appointment_set:    lead.apptset === 'true' || lead.apptset === true,
      appointment_date:   lead.apptdate       || lead.ApptDate      || null,
      demo_completed:     lead.sat === 'true'  || lead.sat === true,
      demo_date:          (lead.sat === 'true' || lead.sat === true) ? (lead.apptdate || lead.ApptDate) : null,
      closed_won:         lead.sold === 'true' || lead.sold === true,
      job_value:          parseFloat(lead.gsa || lead.GSA) || null,
      created_at_lp:      lead.entrydate      || lead.EntryDate     || null,
      updated_at_lp:      lead.lastchangedon  || lead.LastChangedOn || null,
      synced_at:          new Date().toISOString(),
      raw_lp_data:        prospect,
    }, { onConflict: 'lp_lead_id' });

    if (upsertErr) {
      throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);
    }

    // 5. Apply GHL entry:* tag (once, additive — NEVER use PUT)
    if (ghlId && !existing?.ghl_tag_applied) {
      const success = await applyGHLTag(ghlId, tag);
      if (success) {
        await supabase.from('lp_leads')
          .update({ ghl_tag_applied: true })
          .eq('lp_lead_id', lpLeadId);
      }
    }

    // 6. Sync call logs from prospect.calls[] array
    const calls = prospect.calls || prospect.Calls || [];
    await syncCallLogs(lpLeadId, ghlId, calls);

    // 7. Sync notes from prospect.notes[] + lead.notes[]
    const notes = [...(prospect.notes || prospect.Notes || []), ...(lead.notes || lead.Notes || [])];
    await syncNotes(lpLeadId, ghlId, notes);

    // 8. Sync jobs + milestones from lead.jobs[]
    for (const job of lead.jobs || lead.Jobs || []) {
      await syncJobAndMilestones(job, lpLeadId, ghlId);
    }

    // 9. Day 15 handoff check
    if (!existing?.lp_day15_triggered && ghlId) {
      await checkDay15Handoff(
        lpLeadId, ghlId,
        lead.entrydate || lead.EntryDate,
        lead.disposition || lead.Disposition,
      );
    }
  }
}

// Fallback: upsert from flat data (when LP returns non-nested response)
async function upsertLeadFromFlat(lp, ghlId) {
  const lpLeadId = String(lp.lds_id || lp.id || lp.LeadID || lp.cst_id || lp.ProspectID);
  const lpProspectId = String(lp.cst_id || lp.CstID || lp.ProspectID || '');

  await supabase.from('lp_leads').upsert({
    lp_lead_id:         lpLeadId,
    lp_prospect_id:     lpProspectId,
    ghl_contact_id:     ghlId,
    first_name:         lp.firstname  || lp.FirstName  || lp.first_name || null,
    last_name:          lp.lastname   || lp.LastName   || lp.last_name  || null,
    email:              lp.email      || lp.Email      || null,
    phone:              normalizePhone(lp.phone1 || lp.Phone1 || lp.phone || lp.Phone),
    phone_alt:          normalizePhone(lp.phone2 || lp.Phone2 || lp.phone_alt),
    address:            lp.address1   || lp.Address1   || null,
    city:               lp.city       || lp.City       || null,
    state:              lp.state      || lp.State      || null,
    zip:                lp.zip        || lp.Zip        || null,
    lead_source:        lp.source     || lp.Source     || null,
    lead_source_detail: lp.sourcesubdescr || lp.SourceSubDescr || null,
    disposition_code:   lp.disposition || lp.Disposition || null,
    rep_name:           lp.salesrepname || lp.SalesRepName || lp.rep_name || null,
    created_at_lp:      lp.entrydate  || lp.EntryDate  || lp.dateadded || null,
    updated_at_lp:      lp.lastchangedon || lp.LastChangedOn || null,
    synced_at:          new Date().toISOString(),
    raw_lp_data:        lp,
  }, { onConflict: 'lp_lead_id' });
}

// ─── Call Log Sync ───────────────────────────────────────────────

async function syncCallLogs(lpLeadId, ghlContactId, calls) {
  for (const call of calls) {
    const callId = String(call.id || call.call_id || call.CallID || `${lpLeadId}-${call.calldate || call.CallDate}-${Math.random()}`);
    try {
      await supabase.from('lp_call_logs').upsert({
        lp_call_id:        callId,
        lp_lead_id:        lpLeadId,
        ghl_contact_id:    ghlContactId || null,
        call_date:         call.calldate     || call.CallDate    || call.date || null,
        call_duration_sec: call.duration     || call.Duration    || null,
        call_result:       call.resultcode   || call.ResultCode  || call.result || null,
        call_direction:    call.calltype     || call.CallType    || null,  // A=Outbound, I=Inbound
        rep_id:            call.emp_id       || call.EmpID       || null,
        rep_name:          call.agentname    || call.AgentName   || call.rep_name || null,
        call_notes:        call.notes        || call.Notes       || null,
        recording_url:     call.recording_url || call.RecordingURL || null,
        synced_at:         new Date().toISOString(),
        raw_lp_data:       call,
      }, { onConflict: 'lp_call_id' });
    } catch (err) {
      console.warn(`[Sync] Call upsert failed for ${callId}:`, err.message);
    }
  }
}

// ─── Notes Sync ──────────────────────────────────────────────────

async function syncNotes(lpLeadId, ghlContactId, notes) {
  for (const note of notes) {
    const noteId = String(note.id || note.note_id || note.NoteID || `${lpLeadId}-${note.date || note.Date}-${Math.random()}`);
    try {
      await supabase.from('lp_notes').upsert({
        lp_note_id:          noteId,
        lp_lead_id:          lpLeadId,
        ghl_contact_id:      ghlContactId || null,
        note_body:           note.notes    || note.Notes   || note.body    || note.text || null,
        note_type:           note.rectype  || note.RecType || note.type    || null,
        note_category:       note.category || note.Category || null,
        created_by_rep_name: note.enteredby || note.EnteredBy || note.rep_name || null,
        created_at_lp:       note.date      || note.Date     || note.enteredon || null,
        synced_at:           new Date().toISOString(),
        raw_lp_data:         note,
      }, { onConflict: 'lp_note_id' });
    } catch (err) {
      console.warn(`[Sync] Note upsert failed for ${noteId}:`, err.message);
    }
  }
}

// ─── Job + Milestone Sync — syncJobAndMilestones() ───────────────

async function syncJobAndMilestones(job, lpLeadId, ghlContactId) {
  const jobId = String(job.id || job.job_id || job.JobID);

  // Upsert job record
  try {
    await supabase.from('lp_jobs').upsert({
      lp_job_id:       jobId,
      lp_lead_id:      lpLeadId,
      ghl_contact_id:  ghlContactId || null,
      job_status:      job.jobstatus   || job.JobStatus   || null,
      job_value:       parseFloat(job.grossamount || job.GrossAmount || job.gsa) || null,
      rep_name:        job.salesrepname || job.SalesRepName || null,
      created_at_lp:   job.entrydate   || job.EntryDate   || null,
      updated_at_lp:   job.lastchangedon || job.LastChangedOn || null,
      synced_at:       new Date().toISOString(),
      raw_lp_data:     job,
    }, { onConflict: 'lp_job_id' });
  } catch (err) {
    console.warn(`[Sync] Job upsert failed for ${jobId}:`, err.message);
  }

  // Process each milestone
  for (const ms of job.milestones || job.Milestones || []) {
    const mdtId = ms.mdt_id || ms.MDT_ID || ms.MdtId;
    if (!mdtId) continue;

    // Check existing state
    const { data: existing } = await supabase.from('lp_job_milestones')
      .select('act_date, ghl_tag_fired')
      .eq('lp_job_id', jobId).eq('mdt_id', mdtId).single();

    // Upsert milestone row
    try {
      await supabase.from('lp_job_milestones').upsert({
        lp_job_id:       jobId,
        lp_lead_id:      lpLeadId,
        ghl_contact_id:  ghlContactId || null,
        mdt_id:          mdtId,
        datetype:        ms.datetype    || ms.DateType   || null,
        est_date:        ms.estdate     || ms.EstDate    || null,
        act_date:        ms.actdate     || ms.ActDate    || null,
        entered_by:      ms.enteredby   || ms.EnteredBy  || null,
        entered_on:      ms.enteredon   || ms.EnteredOn  || null,
        synced_at:       new Date().toISOString(),
      }, { onConflict: 'lp_job_id, mdt_id', ignoreDuplicates: false });
    } catch (err) {
      console.warn(`[Sync] Milestone upsert failed for job ${jobId} mdt ${mdtId}:`, err.message);
      continue;
    }

    // Fire GHL tag when act_date populates for first time
    const actDate = ms.actdate || ms.ActDate;
    const justCompleted = actDate && !existing?.act_date;
    const tagNotFired   = !existing?.ghl_tag_fired;

    if (justCompleted && tagNotFired && ghlContactId) {
      const tag = MDT_TAG_MAP[mdtId];
      if (tag) {
        const success = await applyGHLTag(ghlContactId, tag);
        if (success) {
          await supabase.from('lp_job_milestones')
            .update({ ghl_tag_fired: true })
            .eq('lp_job_id', jobId).eq('mdt_id', mdtId);
          console.log(`[Sync] Milestone tag fired: ${tag} for contact ${ghlContactId}`);
        }
      }
    }
  }
}

// ─── Day 15 Handoff Check ────────────────────────────────────────

async function checkDay15Handoff(lpLeadId, ghlContactId, entryDate, disposition) {
  if (!entryDate || !ghlContactId) return;
  // Only fire if lead is old enough and not closed
  const daysSinceEntry = (Date.now() - new Date(entryDate).getTime()) / 86400000;
  if (daysSinceEntry < 15) return;
  // Don't fire for won deals
  const closedDispositions = ['sold', 'won', 'closed'];
  if (disposition && closedDispositions.some(d => disposition.toLowerCase().includes(d))) return;

  const success = await applyGHLTag(ghlContactId, 'lp-day15-handoff');
  if (success) {
    await supabase.from('lp_leads')
      .update({ lp_day15_triggered: true })
      .eq('lp_lead_id', lpLeadId);
    console.log(`[Sync] Day 15 handoff fired for lead ${lpLeadId}`);
  }
}

// ─── Bulk Day 15 + Lead-Level Trigger Checks ─────────────────────

async function checkDay15Handoffs() {
  try {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86400000).toISOString();
    const { data: eligibleLeads, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, created_at_lp, last_contact_date')
      .eq('lp_day15_triggered', false)
      .eq('closed_won', false)
      .not('ghl_contact_id', 'is', null)
      .lt('created_at_lp', fifteenDaysAgo);

    if (error) { console.error('[Sync] Day 15 query failed:', error.message); return; }

    let triggered = 0;
    for (const lead of (eligibleLeads || [])) {
      if (lead.last_contact_date) {
        const lastContact = new Date(lead.last_contact_date);
        if (lastContact.getTime() > Date.now() - 14 * 86400000) continue;
      }
      const success = await applyGHLTag(lead.ghl_contact_id, 'lp-day15-handoff');
      if (success) {
        await supabase.from('lp_leads')
          .update({ lp_day15_triggered: true })
          .eq('lp_lead_id', lead.lp_lead_id);
        triggered++;
      }
    }
    if (triggered > 0) {
      console.log(`[Sync] Day 15 handoff: ${triggered} leads triggered`);
    }
  } catch (err) {
    console.error('[Sync] Day 15 check failed:', err.message);
  }
}

async function checkLeadTriggers() {
  try {
    // demo_completed leads needing tag
    const { data: demoLeads } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id')
      .eq('demo_completed', true)
      .not('ghl_contact_id', 'is', null)
      .not('raw_lp_data->demo_tag_fired', 'eq', true);

    // closed_won leads needing tag
    const { data: wonLeads } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id')
      .eq('closed_won', true)
      .not('ghl_contact_id', 'is', null)
      .not('raw_lp_data->won_tag_fired', 'eq', true);

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

// ─── Full Sync — runFullSync() ───────────────────────────────────
//
// Pulls ALL LP leads via POST /api/Customers/GetLead with date range.
// Pagination: StartIndex (1-based) + PageSize.

export async function fullSync() {
  console.log('[Sync] Starting FULL sync...');
  const startedAt = new Date();
  const stats = { processed: 0, inserted: 0, updated: 0, failed: 0, errors: [] };

  // Step 0: Test LP API connection
  try {
    const connStatus = await testConnection();
    console.log(`[Sync] LP API connection: auth=${connStatus.auth_status}, api=${connStatus.api_test}`);
    if (connStatus.auth_status !== 'success') {
      console.error('[Sync] LP API authentication FAILED — check LP_API_BASE_URL, LP_USERNAME, LP_PASSWORD, LP_CLIENT_ID, LP_APP_KEY');
      stats.errors.push({ fatal: 'LP API auth failed', details: connStatus.errors });
      await logSync({ sync_type: 'full', ...stats, started_at: startedAt });
      return stats;
    }
  } catch (err) {
    console.error('[Sync] LP API connection test failed:', err.message);
    stats.errors.push({ fatal: `LP connection: ${err.message}` });
    await logSync({ sync_type: 'full', ...stats, started_at: startedAt });
    return stats;
  }

  try {
    // Step 1: Sync dispositions reference
    await syncDispositions();

    // Step 1b: Enumerate sources for mapping table
    await populateSourceMapping();

    // Step 2: Paginated lead fetch via GetLead
    let startIndex = 1; // 1-based per LP API
    const today = new Date().toISOString().slice(0, 10);

    while (true) {
      let result;
      try {
        result = await getLeads({
          startdate:  '2020-01-01',
          enddate:    today,
          PageSize:   PAGE_SIZE,
          StartIndex: startIndex,
        });
      } catch (err) {
        console.error(`[Sync] Failed to fetch leads at index ${startIndex}:`, err.message);
        stats.errors.push({ start_index: startIndex, error: err.message });
        break;
      }

      const prospects = extractArray(result);
      if (prospects.length === 0) break;

      for (const prospect of prospects) {
        try {
          await processProspect(prospect);
          stats.processed++;
          stats.inserted++;
        } catch (err) {
          stats.failed++;
          const pid = prospect.cst_id || prospect.CstID || prospect.ProspectID;
          stats.errors.push({ prospect_id: pid, error: err.message });
          await logSyncError(pid, err);
        }
      }

      console.log(`[Sync] Processed records ${startIndex}–${startIndex + prospects.length - 1}`);

      if (prospects.length < PAGE_SIZE) break;
      startIndex += PAGE_SIZE;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    // Step 3: Process milestone triggers
    try {
      const milestoneResult = await processMilestoneTriggers();
      console.log(`[Sync] Milestones: ${milestoneResult.fired} tags fired`);
    } catch (err) {
      console.warn('[Sync] Milestone processing failed:', err.message);
    }

    // Step 4: Day 15 handoff check
    try { await checkDay15Handoffs(); } catch (err) {
      console.warn('[Sync] Day 15 check failed:', err.message);
    }

    // Step 5: Lead-level triggers
    try { await checkLeadTriggers(); } catch (err) {
      console.warn('[Sync] Lead trigger checks failed:', err.message);
    }

  } catch (err) {
    console.error('[Sync] Full sync failed:', err.message);
    stats.errors.push({ fatal: err.message });
  }

  const duration = Date.now() - startedAt.getTime();
  await logSync({ sync_type: 'full', ...stats, started_at: startedAt, duration_ms: duration });
  console.log(`[Sync] Full sync complete — ${stats.processed} processed, ${stats.failed} failed (${duration}ms)`);
  return stats;
}

// ─── Incremental Sync — Two-Part ─────────────────────────────────
//
// Part 1: Changed leads via POST /api/Leads/GetLeadData (date range)
// Part 2: Job status changes via POST /api/Customers/GetJobStatusChanges

export async function incrementalSync() {
  console.log('[Sync] Starting incremental sync...');
  const startedAt = new Date();
  const stats = { processed: 0, inserted: 0, updated: 0, failed: 0, errors: [] };

  try {
    const lastSyncTime = await getLastSyncTimestamp();
    if (!lastSyncTime) {
      console.log('[Sync] No previous sync found — running full sync instead');
      return fullSync();
    }

    const since = lastSyncTime.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // ── Part 1: Changed leads via GetLeadData ──
    let startIndex = 1;
    while (true) {
      let leads;
      try {
        leads = await getLeadData({
          startdate:  since,
          enddate:    today,
          PageSize:   PAGE_SIZE,
          StartIndex: startIndex,
        });
      } catch (err) {
        console.error('[Sync] GetLeadData failed:', err.message);
        stats.errors.push({ part: 'leads', error: err.message });
        break;
      }

      const items = extractArray(leads);
      if (items.length === 0) break;

      for (const lead of items) {
        try {
          // Fetch full prospect record for each changed lead
          const cstId = lead.cst_id || lead.CstID || lead.prospectid || lead.ProspectID;
          if (cstId) {
            const fullResult = await getLead(cstId);
            const fullProspects = extractArray(fullResult);
            if (fullProspects.length > 0) {
              await processProspect(fullProspects[0]);
              stats.processed++;
              stats.updated++;
            }
          }
        } catch (err) {
          stats.failed++;
          await logSyncError(lead.cst_id || lead.id, err);
        }
      }

      if (items.length < PAGE_SIZE) break;
      startIndex += PAGE_SIZE;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    // ── Part 2: Job status changes ──
    startIndex = 1;
    while (true) {
      let jobs;
      try {
        jobs = await getJobStatusChanges({
          startdate: since,
          enddate:   today,
          PageSize:  PAGE_SIZE,
          StartIndex: startIndex,
        });
      } catch (err) {
        console.error('[Sync] GetJobStatusChanges failed:', err.message);
        stats.errors.push({ part: 'jobs', error: err.message });
        break;
      }

      const items = extractArray(jobs);
      if (items.length === 0) break;

      for (const job of items) {
        try {
          await syncJobAndMilestones(job, job.lds_id || job.lp_lead_id, null);
          stats.processed++;
        } catch (err) {
          stats.failed++;
          await logSyncError(job.job_id || job.JobID, err);
        }
      }

      if (items.length < PAGE_SIZE) break;
      startIndex += PAGE_SIZE;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    // Post-sync triggers
    try { await processMilestoneTriggers(); } catch (err) {
      console.warn('[Sync] Milestone processing failed:', err.message);
    }
    try { await checkDay15Handoffs(); } catch (err) {
      console.warn('[Sync] Day 15 check failed:', err.message);
    }
    try { await checkLeadTriggers(); } catch (err) {
      console.warn('[Sync] Lead trigger checks failed:', err.message);
    }

  } catch (err) {
    console.error('[Sync] Incremental sync failed:', err.message);
    stats.errors.push({ fatal: err.message });
  }

  const duration = Date.now() - startedAt.getTime();
  await logSync({ sync_type: 'incremental', ...stats, started_at: startedAt, duration_ms: duration });
  console.log(`[Sync] Incremental sync complete — ${stats.processed} processed, ${stats.failed} failed (${duration}ms)`);
  return stats;
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
        const prospect = payload.lead || payload;
        await processProspect(prospect);
        stats.processed++;
        await processMilestoneTriggers();
        break;
      }

      case 'job.status_changed': {
        const job = payload.job || payload;
        const cstId = job.cst_id || job.lead_id || job.lp_lead_id;
        if (cstId) {
          try {
            const result = await getLead(cstId);
            const prospects = extractArray(result);
            if (prospects[0]) await processProspect(prospects[0]);
          } catch (err) { stats.errors.push({ error: err.message }); }
        }
        await processMilestoneTriggers();
        stats.processed++;
        break;
      }

      case 'call.logged':
      case 'note.added': {
        const cstId = payload.cst_id || payload.lead_id || payload.lp_lead_id;
        if (cstId) {
          try {
            const result = await getLead(cstId);
            const prospects = extractArray(result);
            if (prospects[0]) await processProspect(prospects[0]);
            stats.processed++;
          } catch (err) {
            stats.failed++;
            stats.errors.push({ cst_id: cstId, error: err.message });
          }
        }
        break;
      }

      case 'milestone.completed': {
        const cstId = payload.cst_id || payload.lead_id;
        if (cstId) {
          try {
            const result = await getLead(cstId);
            const prospects = extractArray(result);
            if (prospects[0]) await processProspect(prospects[0]);
          } catch (err) { stats.errors.push({ error: err.message }); }
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
    console.error(`[Webhook] Processing failed for ${event}:`, err.message);
  }

  await logSync({ sync_type: `webhook_${event}`, ...stats, started_at: startTime });
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

  // Run initial sync after 5-second delay (let server boot first)
  setTimeout(async () => {
    try {
      // Pre-warm LP token
      console.log('[Sync] Pre-warming LP token...');
      await getToken();
      console.log('[Sync] LP token acquired');

      // Start proactive token refresh schedule
      startTokenRefreshSchedule();

      // Check if we should force a full sync (set FORCE_FULL_SYNC=true in Railway to trigger)
      const forceFullSync = process.env.FORCE_FULL_SYNC === 'true';
      if (forceFullSync) {
        console.log('[Sync] FORCE_FULL_SYNC=true — running full sync regardless of history');
        await fullSync();
      } else {
        const lastSync = await getLastSyncTimestamp();
        if (lastSync) {
          console.log(`[Sync] Last successful sync: ${lastSync.toISOString()} — running incremental`);
          await incrementalSync();
        } else {
          console.log('[Sync] No successful sync found — running initial full sync');
          await fullSync();
        }
      }
    } catch (err) {
      console.error('[Sync] Initial sync failed:', err.message);
      // If it's an auth error, log clearly
      if (err.message.includes('Token') || err.message.includes('auth') || err.message.includes('401')) {
        console.error('[Sync] LP authentication failed. Verify these Railway env vars:');
        console.error('  LP_API_BASE_URL, LP_USERNAME, LP_PASSWORD, LP_CLIENT_ID, LP_APP_KEY');
      }
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
