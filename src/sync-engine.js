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
import { matchToGHL, applyGHLTag, resetGHLState } from './ghl.js';
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

// ─── Case-insensitive field extraction ──────────────────────────
// LP API returns inconsistent casing (phone1, Phone1, PHONE1, etc.).
// Try exact keys first, then case-insensitive fallback.
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

// Track whether we've logged the first record's keys for each entity type
const loggedFirstKeys = new Set();

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

// Known source → bucket mappings. Add new entries here as Ryan classifies them.
const DEFAULT_SOURCE_MAPPINGS = {
  'Canvass':       { bucket: 'canvassing',  tag: 'entry:canvassing' },
  'Home Show':     { bucket: 'event',       tag: 'entry:event' },
  'RV Show':       { bucket: 'event',       tag: 'entry:event' },
  'Modernize':     { bucket: 'internet',    tag: 'entry:internet' },
  'Priceless':     { bucket: 'affiliate',   tag: 'entry:affiliate' },
};

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

    // Insert skeleton rows for each sub-source — gives Ryan classifiable rows
    let inserted = 0;
    for (const s of subArr) {
      const key = s.key || s.Key || s.value || s.Value;
      if (!key) continue;
      // Check if a known default mapping exists
      const defaultMap = DEFAULT_SOURCE_MAPPINGS[key];
      const { error } = await supabase.from('lp_source_mapping').upsert({
        lp_source_subdetail: key,
        lp_source_raw: null,
        ghl_intent_bucket: defaultMap?.bucket || 'unmapped',
        ghl_entry_tag: defaultMap?.tag || 'entry:unmapped',
      }, { onConflict: 'lp_source_subdetail,lp_source_raw', ignoreDuplicates: true }).catch(() => ({}));
      if (!error) inserted++;
    }

    // Also seed known defaults for unmapped sources seen in logs
    for (const [sourceKey, mapping] of Object.entries(DEFAULT_SOURCE_MAPPINGS)) {
      await supabase.from('lp_source_mapping').upsert({
        lp_source_subdetail: sourceKey,
        lp_source_raw: null,
        ghl_intent_bucket: mapping.bucket,
        ghl_entry_tag: mapping.tag,
      }, { onConflict: 'lp_source_subdetail,lp_source_raw', ignoreDuplicates: false }).catch(() => {});
    }

    if (inserted > 0) console.log(`[Sync] Source mapping: ${inserted} skeleton rows ensured`);
  } catch (err) {
    console.warn('[Sync] Source enumeration failed:', err.message);
  }
}

// ─── Sync Dispositions ───────────────────────────────────────────

async function syncDispositions() {
  try {
    const response = await getDispositions();
    const items = extractArray(response);

    // Log the raw response shape for debugging
    if (items.length === 0) {
      console.log('[Sync] Dispositions raw response:', JSON.stringify(response)?.slice(0, 500));
    } else {
      console.log('[Sync] Dispositions sample:', JSON.stringify(items[0]));
    }

    let synced = 0;
    for (const d of items) {
      // LP may return {key, value} format like sources, or {Code, Description}, or other shapes
      const code = String(d.key || d.Key || d.Code || d.code || d.disposition_code || d.DispositionCode || d.ID || d.id || '');
      if (!code) continue;

      await supabase.from('lp_dispositions').upsert({
        disposition_code: code,
        disposition_label: d.value || d.Value || d.Description || d.description || d.Label || d.label || d.Name || d.name || '',
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

// ─── Backfill Dispositions From Lead Data ────────────────────────
// LP reference endpoint only returns configured dispositions (usually 2).
// The remaining codes exist on lead records — scan and backfill.

async function backfillDispositionsFromLeads() {
  try {
    const { data } = await supabase
      .from('lp_leads')
      .select('disposition_code')
      .not('disposition_code', 'is', null);
    if (!data || data.length === 0) return;

    const codes = [...new Set(data.map(r => r.disposition_code).filter(Boolean))];
    let added = 0;
    for (const code of codes) {
      const { data: existing } = await supabase
        .from('lp_dispositions')
        .select('disposition_code')
        .eq('disposition_code', code)
        .maybeSingle();
      if (!existing) {
        await supabase.from('lp_dispositions').upsert({
          disposition_code: code,
          disposition_label: code, // placeholder until manually labeled
          synced_at: new Date().toISOString(),
        }, { onConflict: 'disposition_code' });
        added++;
      }
    }
    if (added > 0) console.log(`[Sync] Backfilled ${added} dispositions from lead data (total codes: ${codes.length})`);
  } catch (err) {
    console.warn('[Sync] Disposition backfill failed:', err.message);
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

// Track already-logged unmapped sources to avoid log spam
const loggedUnmappedSources = new Set();

async function logUnmappedSource(sourceSubdetail, sourceRaw) {
  try {
    if (!sourceSubdetail && !sourceRaw) return;
    const key = `${sourceSubdetail || ''}|${sourceRaw || ''}`;
    // Only log each unique combo once per sync cycle
    if (!loggedUnmappedSources.has(key)) {
      loggedUnmappedSources.add(key);
      console.log(`[Sync] Unmapped source: subdetail="${sourceSubdetail}", raw="${sourceRaw}"`);
    }
    await supabase.from('lp_unmapped_sources').upsert({
      source_subdetail: sourceSubdetail || null,
      source_raw: sourceRaw || null,
    }, { onConflict: 'source_subdetail,source_raw' }).catch(() => {});
  } catch (err) {
    // Non-critical
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
  // Log prospect keys once for diagnostic purposes
  if (!loggedFirstKeys.has('prospect')) {
    loggedFirstKeys.add('prospect');
    console.log('[Sync] Prospect record keys:', Object.keys(prospect).join(', '));
  }

  // 1. Match to GHL contact (phone primary → alt phone → email)
  let ghlId = null;
  try {
    ghlId = await matchToGHL({
      phone: normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone', 'Phone')),
      phone_alt: normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2', 'phone_alt')),
      email: getField(prospect, 'email', 'Email'),
    });
  } catch (err) {
    console.warn(`[Sync] GHL match failed for prospect ${prospect.cst_id}:`, err.message);
  }

  // 2. Process each lead record under this prospect
  const leads = getField(prospect, 'leads', 'Leads') || [];
  if (leads.length === 0) {
    // Some endpoints return flat data — treat the prospect itself as a lead
    await upsertLeadFromFlat(prospect, ghlId);
    return { calls: 0, notes: 0, jobs: 0, milestones: 0 };
  }

  // Log lead keys once
  if (!loggedFirstKeys.has('lead') && leads.length > 0) {
    loggedFirstKeys.add('lead');
    console.log('[Sync] Lead record keys:', Object.keys(leads[0]).join(', '));
  }

  let subCounts = { calls: 0, notes: 0, jobs: 0, milestones: 0 };

  for (const lead of leads) {
    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'),
    );

    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
    const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));

    // 3. Check existing state
    const { data: existing } = await supabase
      .from('lp_leads')
      .select('ghl_tag_applied, lp_day15_triggered')
      .eq('lp_lead_id', lpLeadId)
      .single();

    // 4. Upsert core lead record
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
      appointment_date:   getField(lead, 'apptdate', 'ApptDate'),
      demo_completed:     isDemoCompleted,
      demo_date:          isDemoCompleted ? getField(lead, 'apptdate', 'ApptDate') : null,
      closed_won:         isClosedWon,
      job_value:          parseFloat(getField(lead, 'gsa', 'GSA', 'grossamount', 'GrossAmount') || 0) || null,
      created_at_lp:      getField(lead, 'entrydate', 'EntryDate'),
      updated_at_lp:      getField(lead, 'lastchangedon', 'LastChangedOn'),
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
    const calls = getField(prospect, 'calls', 'Calls') || [];
    subCounts.calls += calls.length;
    await syncCallLogs(lpLeadId, ghlId, calls);

    // 7. Sync notes from prospect.notes[] + lead.notes[]
    const notes = [...(getField(prospect, 'notes', 'Notes') || []), ...(getField(lead, 'notes', 'Notes') || [])];
    subCounts.notes += notes.length;
    await syncNotes(lpLeadId, ghlId, notes);

    // 8. Sync jobs + milestones from lead.jobs[]
    const jobs = getField(lead, 'jobs', 'Jobs') || [];
    subCounts.jobs += jobs.length;
    for (const job of jobs) {
      const milestones = getField(job, 'milestones', 'Milestones') || [];
      subCounts.milestones += milestones.length;
      await syncJobAndMilestones(job, lpLeadId, ghlId);
    }

    // 9. Day 15 handoff check
    if (!existing?.lp_day15_triggered && ghlId) {
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
async function upsertLeadFromFlat(lp, ghlId) {
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
    created_at_lp:      getField(lp, 'entrydate', 'EntryDate', 'dateadded'),
    updated_at_lp:      getField(lp, 'lastchangedon', 'LastChangedOn'),
    synced_at:          new Date().toISOString(),
    raw_lp_data:        lp,
  }, { onConflict: 'lp_lead_id' });
}

// ─── Call Log Sync ───────────────────────────────────────────────

async function syncCallLogs(lpLeadId, ghlContactId, calls) {
  // Log first call record keys for diagnostic purposes
  if (calls.length > 0 && !loggedFirstKeys.has('call')) {
    loggedFirstKeys.add('call');
    console.log('[Sync] Call record keys:', Object.keys(calls[0]).join(', '));
  }

  for (const call of calls) {
    const callId = String(getField(call, 'id', 'call_id', 'CallID') || `${lpLeadId}-${getField(call, 'calldate', 'CallDate', 'date') || Math.random()}`);
    try {
      await supabase.from('lp_call_logs').upsert({
        lp_call_id:        callId,
        lp_lead_id:        lpLeadId,
        ghl_contact_id:    ghlContactId || null,
        call_date:         getField(call, 'calldate', 'CallDate', 'date', 'call_date'),
        call_duration_sec: getField(call, 'duration', 'Duration', 'call_duration', 'callduration'),
        call_result:       getField(call, 'resultcode', 'ResultCode', 'result', 'callresult', 'CallResult'),
        call_direction:    getField(call, 'calltype', 'CallType', 'direction', 'call_direction'),
        rep_id:            getField(call, 'emp_id', 'EmpID', 'empid', 'rep_id'),
        rep_name:          getField(call, 'agentname', 'AgentName', 'rep_name', 'agent_name'),
        call_notes:        getField(call, 'notes', 'Notes', 'call_notes', 'CallNotes'),
        recording_url:     getField(call, 'recording_url', 'RecordingURL', 'recordingurl', 'recording'),
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
  // Log first note record keys for diagnostic purposes
  if (notes.length > 0 && !loggedFirstKeys.has('note')) {
    loggedFirstKeys.add('note');
    console.log('[Sync] Note record keys:', Object.keys(notes[0]).join(', '));
  }

  for (const note of notes) {
    const noteId = String(getField(note, 'id', 'note_id', 'NoteID') || `${lpLeadId}-${getField(note, 'date', 'Date', 'enteredon') || Math.random()}`);
    try {
      await supabase.from('lp_notes').upsert({
        lp_note_id:          noteId,
        lp_lead_id:          lpLeadId,
        ghl_contact_id:      ghlContactId || null,
        note_body:           getField(note, 'notes', 'Notes', 'body', 'text', 'note_body', 'NoteBody', 'content', 'Content'),
        note_type:           getField(note, 'rectype', 'RecType', 'type', 'note_type'),
        note_category:       getField(note, 'category', 'Category'),
        created_by_rep_name: getField(note, 'enteredby', 'EnteredBy', 'rep_name', 'entered_by'),
        created_at_lp:       getField(note, 'date', 'Date', 'enteredon', 'EnteredOn', 'created_at'),
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
  // Log first job record keys for diagnostic purposes
  if (!loggedFirstKeys.has('job')) {
    loggedFirstKeys.add('job');
    console.log('[Sync] Job record keys:', Object.keys(job).join(', '));
  }

  const jobId = String(getField(job, 'id', 'job_id', 'JobID'));

  // Upsert job record
  try {
    await supabase.from('lp_jobs').upsert({
      lp_job_id:       jobId,
      lp_lead_id:      lpLeadId,
      ghl_contact_id:  ghlContactId || null,
      job_status:      getField(job, 'jobstatus', 'JobStatus', 'job_status'),
      job_value:       parseFloat(getField(job, 'grossamount', 'GrossAmount', 'gsa', 'GSA') || 0) || null,
      rep_name:        getField(job, 'salesrepname', 'SalesRepName', 'rep_name'),
      created_at_lp:   getField(job, 'entrydate', 'EntryDate'),
      updated_at_lp:   getField(job, 'lastchangedon', 'LastChangedOn'),
      synced_at:       new Date().toISOString(),
      raw_lp_data:     job,
    }, { onConflict: 'lp_job_id' });
  } catch (err) {
    console.warn(`[Sync] Job upsert failed for ${jobId}:`, err.message);
  }

  // Process each milestone
  const milestones = getField(job, 'milestones', 'Milestones') || [];

  // Log first milestone record keys
  if (milestones.length > 0 && !loggedFirstKeys.has('milestone')) {
    loggedFirstKeys.add('milestone');
    console.log('[Sync] Milestone record keys:', Object.keys(milestones[0]).join(', '));
  }

  for (const ms of milestones) {
    const mdtId = getField(ms, 'mdt_id', 'MDT_ID', 'MdtId');
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
        datetype:        getField(ms, 'datetype', 'DateType'),
        est_date:        getField(ms, 'estdate', 'EstDate', 'est_date'),
        act_date:        getField(ms, 'actdate', 'ActDate', 'act_date'),
        entered_by:      getField(ms, 'enteredby', 'EnteredBy', 'entered_by'),
        entered_on:      getField(ms, 'enteredon', 'EnteredOn', 'entered_on'),
        synced_at:       new Date().toISOString(),
      }, { onConflict: 'lp_job_id, mdt_id', ignoreDuplicates: false });
    } catch (err) {
      console.warn(`[Sync] Milestone upsert failed for job ${jobId} mdt ${mdtId}:`, err.message);
      continue;
    }

    // Fire GHL tag when act_date populates for first time
    const actDate = getField(ms, 'actdate', 'ActDate', 'act_date');
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
  const stats = { processed: 0, inserted: 0, updated: 0, failed: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, errors: [] };
  resetGHLState(); // Give GHL a fresh chance each sync cycle
  loggedFirstKeys.clear(); // Reset diagnostic key logging for this cycle

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

    // Step 1b: Enumerate sources for mapping table (inserts skeleton rows)
    await populateSourceMapping();

    // Step 2: Paginated lead fetch via GetLead
    // LP times out on large date ranges — break into yearly windows
    // Newest first — current leads validate the pipeline before backfilling history
    const today = new Date();
    const START_YEAR = 2015; // Pull all history from this year
    const currentYear = today.getFullYear();

    for (let year = currentYear; year >= START_YEAR; year--) {
      const windowStart = `${year}-01-01`;
      const windowEnd = year === currentYear
        ? today.toISOString().slice(0, 10)
        : `${year}-12-31`;

      console.log(`[Sync] Fetching leads for ${windowStart} to ${windowEnd}...`);
      let startIndex = 1; // 1-based per LP API

      while (true) {
        let result;
        try {
          result = await getLeads({
            startdate:  windowStart,
            enddate:    windowEnd,
            PageSize:   PAGE_SIZE,
            StartIndex: startIndex,
          });
        } catch (err) {
          console.error(`[Sync] Failed to fetch leads (${windowStart}, index ${startIndex}):`, err.message);
          stats.errors.push({ year, start_index: startIndex, error: err.message });
          break;
        }

        const prospects = extractArray(result);
        if (prospects.length === 0) break;

        for (const prospect of prospects) {
          try {
            const subCounts = await processProspect(prospect);
            stats.processed++;
            stats.inserted++;
            if (subCounts) {
              stats.calls += subCounts.calls;
              stats.notes += subCounts.notes;
              stats.jobs += subCounts.jobs;
              stats.milestones += subCounts.milestones;
            }
          } catch (err) {
            stats.failed++;
            const pid = prospect.cst_id || prospect.CstID || prospect.ProspectID;
            stats.errors.push({ prospect_id: pid, error: err.message });
            await logSyncError(pid, err);
          }
        }

        console.log(`[Sync] [${year}] Processed records ${startIndex}–${startIndex + prospects.length - 1} (cumulative: ${stats.processed} leads, ${stats.calls} calls, ${stats.notes} notes, ${stats.jobs} jobs)`);

        if (prospects.length < PAGE_SIZE) break;
        startIndex += PAGE_SIZE;
        await sleep(RATE_LIMIT_SLEEP_MS);
      }
    }

    // Step 2b: Backfill dispositions from actual lead data
    await backfillDispositionsFromLeads();

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
  console.log(`[Sync] Full sync complete — ${stats.processed} leads, ${stats.calls} calls, ${stats.notes} notes, ${stats.jobs} jobs, ${stats.milestones} milestones, ${stats.failed} failed (${Math.round(duration / 1000)}s)`);
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
  resetGHLState();

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
