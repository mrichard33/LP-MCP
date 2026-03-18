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
const PAGE_SIZE = 200;
const RATE_LIMIT_SLEEP_MS = 150; // LP monitors for excessive use
const REACTIVATION_CUTOFF = '2024-01-01T00:00:00Z'; // Bug 8: Don't trigger Day 15 for leads before this date

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Bug 2: Mutex to prevent overlapping sync processes
let syncInProgress = false;

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

// ─── Sync Log (one row per entity_type, live progress) ──────────

const ENTITY_TYPES = ['leads', 'calls', 'notes', 'jobs', 'milestones', 'activities', 'dispositions', 'sources', 'ghl_backfill'];

// Create a "running" row for an entity and return its id
async function syncLogStart(entityType, syncType) {
  try {
    const { data, error } = await supabase.from('lp_sync_log').insert({
      entity_type:    entityType,
      sync_type:      syncType,
      status:         'running',
      records_synced: 0,
      started_at:     new Date().toISOString(),
    }).select('id').single();
    if (error) throw error;
    return data?.id;
  } catch (err) {
    console.error(`[Sync] Failed to create sync log for ${entityType}:`, err.message);
    return null;
  }
}

// Update records_synced count (call after each page/batch for live progress)
async function syncLogProgress(logId, count) {
  if (!logId) return;
  try {
    await supabase.from('lp_sync_log').update({
      records_synced: count,
    }).eq('id', logId);
  } catch (_) {
    // Non-fatal — don't break sync over a progress update
  }
}

// Mark entity sync as completed (skips if already completed/failed)
async function syncLogComplete(logId, count, errorMessage) {
  if (!logId) return;
  try {
    await supabase.from('lp_sync_log').update({
      status:         errorMessage ? 'failed' : 'completed',
      records_synced: count,
      error_message:  errorMessage || null,
      completed_at:   new Date().toISOString(),
    }).eq('id', logId).eq('status', 'running'); // Only update if still running
  } catch (err) {
    console.error('[Sync] Failed to complete sync log:', err.message);
  }
}

// Mark entity sync as failed
async function syncLogFail(logId, count, errorMessage) {
  await syncLogComplete(logId, count, errorMessage || 'Unknown error');
}

// Helper: create log rows for all entity types at once, returns { leads: id, calls: id, ... }
async function syncLogStartAll(syncType, entityTypes = ENTITY_TYPES) {
  const ids = {};
  await Promise.all(entityTypes.map(async (et) => {
    ids[et] = await syncLogStart(et, syncType);
  }));
  return ids;
}

async function logSyncError(entityId, err) {
  console.error(`[Sync] Entity ${entityId} failed:`, err.message);
}

async function getLastSyncTimestamp() {
  try {
    const { data } = await supabase
      .from('lp_sync_log')
      .select('completed_at')
      .eq('entity_type', 'leads')              // Leads entity is the primary sync indicator
      .eq('status', 'completed')
      .gt('records_synced', 0)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.completed_at ? new Date(data.completed_at) : null;
  } catch (err) {
    console.error('[Sync] Failed to read sync log:', err.message);
    return null;  // Treat errors as "never synced" → triggers full sync
  }
}

// ─── Source Enumeration — Run before first sync ──────────────────

// Known source → bucket mappings. Add new entries here as Ryan classifies them.
const DEFAULT_SOURCE_MAPPINGS = {
  // Canvassing (includes events/shows — in-person lead gen)
  'Canvass':            { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'Home Show':          { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'RV Show':            { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'Tampa Home Show':    { bucket: 'canvassing',          tag: 'entry:canvassing' },
  // Internet / Digital → estimate-calculator bridge
  'Modernize':          { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Lead Gurus':         { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  // Affiliates / Partners → referral bridge
  'Priceless':          { bucket: 'referral',            tag: 'entry:referral' },
  // Referrals
  'Employee Referral':  { bucket: 'referral',            tag: 'entry:referral' },
  'Previous Customer':  { bucket: 'referral',            tag: 'entry:referral' },
  // Self-generated → referral bridge
  'Self Generated':     { bucket: 'referral',            tag: 'entry:referral' },
  // Bug 5: Historical unmapped sources → other
  'Old Sub Source':     { bucket: 'other',               tag: 'entry:other' },
  'Old Source':         { bucket: 'other',               tag: 'entry:other' },
  // Chatbot / website → estimate-calculator bridge
  'Reece ChatBot':      { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  // Internet lead gen / marketplaces → estimate-calculator bridge
  'HomeBuddy':          { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Socius Marketing':   { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'GeoTarget':          { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Thinxmg':            { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Fave Marketing':     { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Porch':              { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Contractor Appointment': { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  // Referral platforms
  'GetTheReferral.Com': { bucket: 'referral',            tag: 'entry:referral' },
  'Job Sign':           { bucket: 'referral',            tag: 'entry:referral' },
  'Customer Referral':  { bucket: 'referral',            tag: 'entry:referral' },
  // Canvassing territories
  'Canvasser, Old Ft Myers': { bucket: 'canvassing',     tag: 'entry:canvassing' },
  'Canvasser, Old St Pete':  { bucket: 'canvassing',     tag: 'entry:canvassing' },
  // Broadcast / media → other
  'Radio':              { bucket: 'other',               tag: 'entry:other' },
  '92.5':               { bucket: 'other',               tag: 'entry:other' },
  'Peacock':            { bucket: 'other',               tag: 'entry:other' },
  'Direct':             { bucket: 'other',               tag: 'entry:other' },
  'Resource Living':    { bucket: 'other',               tag: 'entry:other' },
};

async function populateSourceMapping() {
  // Seed DEFAULT_SOURCE_MAPPINGS into lp_source_mapping table.
  // NOTE: Previously called getSubSources() (type='b') and getSources('s') from LP,
  // but those endpoints return branch office codes and numeric IDs — not actual
  // sourcesubdescr values. Real source discovery now happens in
  // backfillSourceMappingsFromLeads() after Pass 1 commits all lead rows.
  try {
    let defaultsSeeded = 0;
    for (const [sourceKey, mapping] of Object.entries(DEFAULT_SOURCE_MAPPINGS)) {
      const { data: existing } = await supabase.from('lp_source_mapping')
        .select('id')
        .eq('lp_source_subdetail', sourceKey)
        .maybeSingle();
      if (existing) {
        // Update existing row with latest mapping
        await supabase.from('lp_source_mapping')
          .update({ ghl_intent_bucket: mapping.bucket, ghl_entry_tag: mapping.tag, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
        defaultsSeeded++;
      } else {
        const { error } = await supabase.from('lp_source_mapping').insert({
          lp_source_subdetail: sourceKey,
          lp_source_raw: null,
          ghl_intent_bucket: mapping.bucket,
          ghl_entry_tag: mapping.tag,
        });
        if (error) {
          console.warn(`[Sync] Failed to seed default mapping "${sourceKey}":`, error.message);
        } else {
          defaultsSeeded++;
        }
      }
    }
    // Bug 9: Also create lp_source_raw fallback rows for each default mapping
    // so leads with sourcesubdescr=null but matching source still resolve correctly
    let rawFallbacks = 0;
    for (const [sourceKey, mapping] of Object.entries(DEFAULT_SOURCE_MAPPINGS)) {
      const { data: existingRaw } = await supabase.from('lp_source_mapping')
        .select('id')
        .eq('lp_source_raw', sourceKey)
        .is('lp_source_subdetail', null)
        .maybeSingle();
      if (!existingRaw) {
        const { error } = await supabase.from('lp_source_mapping').insert({
          lp_source_subdetail: null,
          lp_source_raw: sourceKey,
          ghl_intent_bucket: mapping.bucket,
          ghl_entry_tag: mapping.tag,
        });
        if (!error) rawFallbacks++;
      }
    }

    console.log(`[Sync] Source mapping: ${defaultsSeeded}/${Object.keys(DEFAULT_SOURCE_MAPPINGS).length} defaults seeded, ${rawFallbacks} raw fallbacks added`);
    return defaultsSeeded + rawFallbacks;
  } catch (err) {
    console.warn('[Sync] Source enumeration failed:', err.message);
    return 0;
  }
}

// ─── Backfill Source Mappings From Lead Data ─────────────────────
// After Pass 1 commits all lp_leads rows, discover actual source values
// and create skeleton mapping rows for any not already in lp_source_mapping.
// This replaces the broken LP API calls (GetLeadsSourceSubPromoter type=b/s)
// that returned branch codes and numeric IDs instead of real source names.

async function backfillSourceMappingsFromLeads() {
  try {
    // Get all distinct source combinations from committed lead data
    const allSources = new Map(); // key = subdetail, value = raw
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data } = await supabase
        .from('lp_leads')
        .select('lead_source_detail, lead_source')
        .not('lead_source_detail', 'is', null)
        .range(offset, offset + pageSize - 1);
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (r.lead_source_detail && !allSources.has(r.lead_source_detail)) {
          allSources.set(r.lead_source_detail, r.lead_source);
        }
      }
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    if (allSources.size === 0) {
      console.log('[Sync] Source backfill: no source data found in lp_leads');
      return 0;
    }

    let added = 0;
    for (const [subdetail, raw] of allSources) {
      // Check if already mapped
      const { data: existing } = await supabase.from('lp_source_mapping')
        .select('id, ghl_intent_bucket')
        .eq('lp_source_subdetail', subdetail)
        .maybeSingle();
      if (!existing) {
        // Create skeleton row — will default to 'other' in resolveSourceBucket
        // until manually classified
        const { error } = await supabase.from('lp_source_mapping').insert({
          lp_source_subdetail: subdetail,
          lp_source_raw: raw,
          ghl_intent_bucket: 'unmapped',
          ghl_entry_tag: 'entry:unmapped',
          notes: 'Auto-discovered from lead data — needs classification',
        });
        if (!error) added++;
      }
    }

    console.log(`[Sync] Source backfill: ${added} new mappings from ${allSources.size} distinct sources in lp_leads`);
    return added;
  } catch (err) {
    console.warn('[Sync] Source backfill from leads failed:', err.message);
    return 0;
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
    return synced;
  } catch (err) {
    console.warn('[Sync] Dispositions sync failed:', err.message);
    return 0;
  }
}

// Bug 7: Known disposition code → human-readable label map
// Extended format: { label, category, recoverable } for codes from LP briefing.
// Legacy string-only entries kept for backward compat with codes not in briefing.
const KNOWN_DISPOSITION_LABELS = {
  // ── Codes from LP briefing (with category + is_recoverable) ──
  'Sale':     { label: 'Contract Signed',            category: 'closed_won',  recoverable: false },
  'Data':     { label: 'No Contact / Raw Lead',      category: 'active',      recoverable: true },
  'OPPFDN':   { label: 'Opportunity Found',          category: 'active',      recoverable: true },
  'CXL':      { label: 'Cancelled',                  category: 'closed_lost', recoverable: true },
  'CCC':      { label: 'Cannot Contact',             category: 'deferred',    recoverable: true },
  'PM':       { label: 'Pending Measure',            category: 'active',      recoverable: false },
  '1Leg':     { label: 'One Leg Present',            category: 'active',      recoverable: true },
  'Set':      { label: 'Appointment Set',            category: 'active',      recoverable: false },
  'Cnf':      { label: 'Appointment Confirmed',      category: 'active',      recoverable: false },
  'NS':       { label: 'No Show',                    category: 'active',      recoverable: true },
  'FDNS':     { label: 'Final Demo No Show',         category: 'active',      recoverable: true },
  'DNC':      { label: 'Do Not Contact',             category: 'dead',        recoverable: false },
  'Verif':    { label: 'Needs Verification',         category: 'active',      recoverable: true },
  'SW':       { label: 'Sold — Written Up',          category: 'closed_won',  recoverable: false },
  'NI':       { label: 'Not Interested',             category: 'closed_lost', recoverable: true },
  'NOP NOP':  { label: 'No Opportunity — No Opp',    category: 'closed_lost', recoverable: false },
  'BO':       { label: 'Be Back / Follow Up',        category: 'active',      recoverable: true },
  'NIS':      { label: 'Not Interested — Shown',     category: 'closed_lost', recoverable: true },
  'NOP ITM':  { label: 'No Opp — In The Market',     category: 'active',      recoverable: true },
  'NOP MPR':  { label: 'No Opp — Must Price Right',  category: 'active',      recoverable: true },
  'No Demo':  { label: 'Demo Not Completed',         category: 'active',      recoverable: true },
  'OPP NOI':  { label: 'Opportunity — Not Int Now',  category: 'deferred',    recoverable: true },
  'NG':       { label: 'No Good / Bad Lead',         category: 'dead',        recoverable: false },
  // ── Legacy codes (string-only, no category info) ──
  'NH':  'No Home',
  'DK':  'Door Knock - No Answer',
  'CB':  'Call Back',
  'AP':  'Appointment Set',
  'DM':  'Demo Completed',
  'RS':  'Reschedule',
  'SL':  'Sold',
  'CN':  'Cancelled',
  'NQ':  'Not Qualified',
  'WR':  'Wrong Number',
  'DC':  'Disconnected',
  'BZ':  'Busy',
  'NA':  'No Answer',
  'AM':  'Answering Machine',
  'LM':  'Left Message',
  'RF':  'Referral',
  'HU':  'Hung Up',
  'PI':  'Price Inquiry',
  'CC':  'Credit Check',
  'OT':  'Other',
};

// ─── Backfill Dispositions From Lead Data ────────────────────────
// LP reference endpoint only returns configured dispositions (usually 2).
// The remaining codes exist on lead records — scan and backfill.

async function backfillDispositionsFromLeads() {
  try {
    // Use RPC or paginated query to get ALL distinct disposition codes
    // Supabase default limit is 1000 rows — we need distinct values only
    let allCodes = new Set();
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data } = await supabase
        .from('lp_leads')
        .select('disposition_code')
        .not('disposition_code', 'is', null)
        .range(offset, offset + pageSize - 1);
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (r.disposition_code) allCodes.add(r.disposition_code);
      }
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    if (allCodes.size === 0) return;
    const codes = [...allCodes];

    let added = 0;
    for (const code of codes) {
      const { data: existing } = await supabase
        .from('lp_dispositions')
        .select('disposition_code')
        .eq('disposition_code', code)
        .maybeSingle();
      if (!existing) {
        const known = KNOWN_DISPOSITION_LABELS[code];
        const label = typeof known === 'string' ? known : known?.label || code;
        const category = typeof known === 'object' ? known.category : null;
        const recoverable = typeof known === 'object' ? known.recoverable : true;
        await supabase.from('lp_dispositions').upsert({
          disposition_code: code,
          disposition_label: label,
          category: category,
          is_recoverable: recoverable,
          synced_at: new Date().toISOString(),
        }, { onConflict: 'disposition_code' });
        added++;
      }
    }
    console.log(`[Sync] Disposition backfill: ${added} new from lead data (${codes.length} unique codes found in lp_leads)`);
    if (codes.length <= 50) {
      console.log(`[Sync] Disposition codes found: ${codes.join(', ')}`);
    }
  } catch (err) {
    console.warn('[Sync] Disposition backfill failed:', err.message);
  }
}

// ─── Source Normalization — resolveSourceBucket() ─────────────────

async function resolveSourceBucket(sourcesubdescr, source, lpLeadId) {
  // Try sourcesubdescr first (primary intent signal)
  if (sourcesubdescr) {
    const { data, error } = await supabase.from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_subdetail', sourcesubdescr)
      .maybeSingle();
    if (error) console.warn(`[Sync] Source lookup error for subdetail="${sourcesubdescr}":`, error.message);
    if (data && data.ghl_intent_bucket !== 'unmapped') {
      return { bucket: data.ghl_intent_bucket, tag: data.ghl_entry_tag };
    }
  }
  // Fall back to parent source field
  if (source) {
    const { data, error } = await supabase.from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_raw', source)
      .is('lp_source_subdetail', null)
      .maybeSingle();
    if (error) console.warn(`[Sync] Source lookup error for raw="${source}":`, error.message);
    if (data && data.ghl_intent_bucket !== 'unmapped') {
      return { bucket: data.ghl_intent_bucket, tag: data.ghl_entry_tag };
    }
  }
  // Default — log for mapping review
  await logUnmappedSource(sourcesubdescr, source, lpLeadId);
  return { bucket: 'other', tag: 'entry:other' };
}

// Track already-logged unmapped sources to avoid log spam
const loggedUnmappedSources = new Set();

async function logUnmappedSource(sourceSubdetail, sourceRaw, lpLeadId) {
  try {
    if (!sourceSubdetail && !sourceRaw) return;
    const key = `${sourceSubdetail || ''}|${sourceRaw || ''}`;
    // Only log each unique combo once per sync cycle
    if (!loggedUnmappedSources.has(key)) {
      loggedUnmappedSources.add(key);
      console.log(`[Sync] Unmapped source: subdetail="${sourceSubdetail}", raw="${sourceRaw}"`);
    }
    // Check if row exists — upsert with partial unique index needs care
    const { data: existing } = await supabase.from('lp_unmapped_sources')
      .select('id, lead_count')
      .eq('source_subdetail', sourceSubdetail || '')
      .eq('source_raw', sourceRaw || '')
      .maybeSingle();
    if (existing) {
      await supabase.from('lp_unmapped_sources')
        .update({
          lead_count: (existing.lead_count || 0) + 1,
          sample_lp_lead_id: lpLeadId || existing.sample_lp_lead_id,
        })
        .eq('id', existing.id);
    } else {
      await supabase.from('lp_unmapped_sources').insert({
        source_subdetail: sourceSubdetail || null,
        source_raw: sourceRaw || null,
        lead_count: 1,
        sample_lp_lead_id: lpLeadId || null,
      });
    }
  } catch (err) {
    // Non-critical — don't break sync for mapping analytics
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

// ─── Pass 1 Helper — upsertLeadOnly() ─────────────────────────────
//
// Extracts ONLY the lead upsert from processProspect(). Used during
// fullSync Pass 1 to commit every lp_leads row before child records
// are processed in Pass 2. This eliminates foreign key race conditions.

async function upsertLeadOnly(prospect) {
  const leads = getField(prospect, 'leads', 'Leads') || [];
  if (leads.length === 0) {
    // Flat data — upsert as-is (same as processProspect fallback)
    await upsertLeadFromFlat(prospect, null);
    return 1;
  }

  let count = 0;
  for (const lead of leads) {
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
    const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));

    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'),
      lpLeadId,
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
      ghl_contact_id:     null, // GHL matching deferred to Pass 2 / backfill
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
    count++;
  }
  return count;
}

// ─── Per-Prospect Processing — processProspect() ─────────────────
//
// The LP GetLead response nests everything under a prospect record:
// contact info at top level, leads[] array inside, each lead has jobs[]
// with milestones[] inside.
//
// Used by incrementalSync and webhook handlers (single-pass is safe
// because lp_leads is already populated after the first full sync).

async function processProspect(prospect, { skipGHL = false } = {}) {
  // Log prospect keys once for diagnostic purposes
  if (!loggedFirstKeys.has('prospect')) {
    loggedFirstKeys.add('prospect');
    console.log('[Sync] Prospect record keys:', Object.keys(prospect).join(', '));
  }

  // 1. Match to GHL contact (phone primary → alt phone → email)
  //    Skipped during initial full sync data load — backfilled afterward
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
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));

    const { bucket, tag } = await resolveSourceBucket(
      getField(lead, 'sourcesubdescr', 'SourceSubDescr'),
      getField(lead, 'source', 'Source'),
      lpLeadId,
    );
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

    // 6-8. Sync sub-entities in parallel (calls, notes, activities, jobs)
    const calls = getField(prospect, 'calls', 'Calls') || [];
    const notes = [...(getField(prospect, 'notes', 'Notes') || []), ...(getField(lead, 'notes', 'Notes') || [])];
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

// ─── Pass 2 — syncAllChildRecords() ──────────────────────────────
//
// Reads committed lead rows from lp_leads (Pass 1 guaranteed they exist),
// fetches the full LP prospect for each, and syncs all child tables:
// calls, notes, activities, jobs, milestones, GHL tags, Day 15.
//
// Because every lp_leads row is already committed, there is zero risk
// of foreign key violations on child record inserts.

async function syncAllChildRecords(logIds, counts) {
  let offset = 0;
  const pageSize = 100;
  let totalProcessed = 0;

  while (true) {
    const { data: leads, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_tag_applied, ghl_entry_tag, lp_day15_triggered, created_at_lp')
      .range(offset, offset + pageSize - 1)
      .order('created_at_lp', { ascending: false });

    if (error) throw error;
    if (!leads || leads.length === 0) break;

    for (const lead of leads) {
      try {
        // Fetch full LP record for this prospect
        const result = await getLead(lead.lp_prospect_id);
        const prospects = extractArray(result);
        if (!prospects[0]) continue;
        const prospect = prospects[0];

        // Match to GHL contact
        const ghlId = lead.ghl_contact_id || await (async () => {
          try {
            return await matchToGHL({
              phone: normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone', 'Phone')),
              phone_alt: normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2', 'phone_alt')),
              email: getField(prospect, 'email', 'Email'),
            });
          } catch (_) { return null; }
        })();

        // Apply GHL entry tag (once, additive)
        if (ghlId && !lead.ghl_tag_applied && lead.ghl_entry_tag) {
          const success = await applyGHLTag(ghlId, lead.ghl_entry_tag);
          if (success) {
            await supabase.from('lp_leads')
              .update({ ghl_contact_id: ghlId, ghl_tag_applied: true })
              .eq('lp_lead_id', lead.lp_lead_id);
          }
        } else if (ghlId && !lead.ghl_contact_id) {
          // Store GHL match even if no tag to apply
          await supabase.from('lp_leads')
            .update({ ghl_contact_id: ghlId })
            .eq('lp_lead_id', lead.lp_lead_id);
        }

        // Sync child records for each lead under this prospect
        const prospectLeads = getField(prospect, 'leads', 'Leads') || [];
        const calls = getField(prospect, 'calls', 'Calls') || [];

        for (const lpLead of prospectLeads) {
          const lpLeadId = String(getField(lpLead, 'id', 'lds_id', 'LeadID'));
          const notes = [...(getField(prospect, 'notes', 'Notes') || []), ...(getField(lpLead, 'notes', 'Notes') || [])];
          const jobs = getField(lpLead, 'jobs', 'Jobs') || [];

          // Sync calls, notes, activities in parallel
          await Promise.all([
            syncCallLogs(lpLeadId, ghlId, calls),
            syncNotes(lpLeadId, ghlId, notes),
            syncActivities(lpLeadId, calls, notes),
            ...jobs.map(job => syncJobAndMilestones(job, lpLeadId, ghlId)),
          ]);

          counts.calls      += calls.length;
          counts.notes      += notes.length;
          counts.jobs       += jobs.length;
          for (const job of jobs) {
            counts.milestones += (getField(job, 'milestones', 'Milestones') || []).length;
          }
          counts.activities += calls.length + notes.length;
        }

        // Day 15 handoff check
        if (!lead.lp_day15_triggered && ghlId) {
          const firstLead = prospectLeads[0];
          if (firstLead) {
            await checkDay15Handoff(
              lead.lp_lead_id, ghlId,
              getField(firstLead, 'entrydate', 'EntryDate'),
              getField(firstLead, 'disposition', 'Disposition'),
            );
          }
        }

        totalProcessed++;
      } catch (err) {
        console.error(`[Sync P2] Failed lead ${lead.lp_lead_id}:`, err.message);
        await logSyncError(lead.lp_lead_id, err);
      }

      await sleep(200); // rate limit buffer between LP calls
    }

    // Flush progress after each page
    if (logIds) {
      await Promise.all([
        syncLogProgress(logIds.calls,      counts.calls),
        syncLogProgress(logIds.notes,      counts.notes),
        syncLogProgress(logIds.jobs,       counts.jobs),
        syncLogProgress(logIds.milestones, counts.milestones),
        syncLogProgress(logIds.activities, counts.activities),
      ]);
    }

    console.log(`[Sync P2] Processed ${totalProcessed} contacts (offset ${offset})`);
    offset += pageSize;
  }

  console.log(`[Sync P2] Done — ${totalProcessed} contacts fully processed`);
  return totalProcessed;
}

// ─── Call Log Sync ───────────────────────────────────────────────

async function syncCallLogs(lpLeadId, ghlContactId, calls) {
  // Log first call record keys for diagnostic purposes
  if (calls.length > 0 && !loggedFirstKeys.has('call')) {
    loggedFirstKeys.add('call');
    console.log('[Sync] Call record keys:', Object.keys(calls[0]).join(', '));
  }

  for (const call of calls) {
    // LP call keys: calldatetime, phone, resultcode, resultdescr, calltype, calltypedescr, agent, agentname
    // No id field — generate from lead + datetime + agent
    const callDatetime = getField(call, 'calldatetime', 'calldate', 'CallDate', 'date', 'call_date');
    const callId = String(getField(call, 'id', 'call_id', 'CallID') || `${lpLeadId}-${callDatetime || ''}-${getField(call, 'agent', 'agentname') || Math.random()}`);
    try {
      await supabase.from('lp_call_logs').upsert({
        lp_call_id:        callId,
        lp_lead_id:        lpLeadId,
        ghl_contact_id:    ghlContactId || null,
        call_date:         callDatetime,
        call_duration_sec: getField(call, 'duration', 'Duration', 'call_duration', 'callduration'),
        call_result:       getField(call, 'resultcode', 'ResultCode', 'resultdescr', 'result'),
        call_direction:    getField(call, 'calltype', 'CallType', 'calltypedescr', 'direction'),
        rep_id:            getField(call, 'agent', 'emp_id', 'EmpID', 'empid', 'rep_id'),
        rep_name:          getField(call, 'agentname', 'AgentName', 'rep_name', 'agent_name'),
        call_notes:        getField(call, 'notes', 'Notes', 'note', 'call_notes', 'CallNotes'),
        recording_url:     getField(call, 'recording_url', 'RecordingURL', 'recordingurl', 'recording'),
        synced_at:         new Date().toISOString(),
        raw_lp_data:       call,
      }, { onConflict: 'lp_call_id' });
    } catch (err) {
      console.warn(`[Sync] Call upsert failed for ${callId}:`, err.message);
    }
  }

  // Bug 3: Update call_count and last_contact_date on parent lp_leads row
  if (calls.length > 0) {
    try {
      const { count } = await supabase.from('lp_call_logs')
        .select('*', { count: 'exact', head: true })
        .eq('lp_lead_id', lpLeadId);

      const { data: latest } = await supabase.from('lp_call_logs')
        .select('call_date')
        .eq('lp_lead_id', lpLeadId)
        .not('call_date', 'is', null)
        .order('call_date', { ascending: false })
        .limit(1)
        .single();

      await supabase.from('lp_leads').update({
        call_count: count || 0,
        last_contact_date: latest?.call_date || null,
      }).eq('lp_lead_id', lpLeadId);
    } catch (err) {
      console.warn(`[Sync] Failed to update call aggregates for lead ${lpLeadId}:`, err.message);
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
        note_body:           getField(note, 'note', 'notes', 'Notes', 'body', 'text', 'note_body', 'NoteBody', 'content', 'Content'),
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

// ─── Activity Sync — synthesize from calls + notes ───────────────

async function syncActivities(lpLeadId, calls, notes) {
  // Synthesize activity rows from call logs and notes
  for (const call of calls) {
    const callDatetime = getField(call, 'calldatetime', 'calldate', 'CallDate', 'date', 'call_date');
    const activityId = `call-${lpLeadId}-${callDatetime || ''}-${getField(call, 'agent', 'agentname') || ''}`;
    try {
      await supabase.from('lp_activities').upsert({
        lp_activity_id:  activityId,
        lp_lead_id:      lpLeadId,
        activity_type:   'call',
        activity_detail: getField(call, 'resultdescr', 'resultcode', 'ResultCode', 'result') || 'Call logged',
        rep_id:          getField(call, 'agent', 'emp_id', 'EmpID', 'empid', 'rep_id'),
        rep_name:        getField(call, 'agentname', 'AgentName', 'rep_name', 'agent_name'),
        activity_date:   callDatetime,
        synced_at:       new Date().toISOString(),
        raw_lp_data:     call,
      }, { onConflict: 'lp_activity_id' });
    } catch (err) {
      // Non-critical — call_logs table is the source of truth
    }
  }

  for (const note of notes) {
    const noteDate = getField(note, 'date', 'Date', 'enteredon', 'EnteredOn', 'created_at');
    const noteId = `note-${lpLeadId}-${noteDate || ''}-${getField(note, 'enteredby', 'EnteredBy') || ''}`;
    try {
      await supabase.from('lp_activities').upsert({
        lp_activity_id:  noteId,
        lp_lead_id:      lpLeadId,
        activity_type:   getField(note, 'rectype', 'RecType', 'type', 'note_type') || 'note',
        activity_detail: (getField(note, 'note', 'notes', 'Notes', 'body', 'text') || '').slice(0, 500),
        rep_id:          null,
        rep_name:        getField(note, 'enteredby', 'EnteredBy', 'rep_name', 'entered_by'),
        activity_date:   noteDate,
        synced_at:       new Date().toISOString(),
        raw_lp_data:     note,
      }, { onConflict: 'lp_activity_id' });
    } catch (err) {
      // Non-critical — notes table is the source of truth
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
  // Bug 8: Skip leads created before the reactivation cutoff
  if (new Date(entryDate).getTime() < new Date(REACTIVATION_CUTOFF).getTime()) return;
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
      .lt('created_at_lp', fifteenDaysAgo)
      .gte('created_at_lp', REACTIVATION_CUTOFF); // Bug 8: Skip ancient leads

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
  // Bug 2: Prevent overlapping syncs
  if (syncInProgress) {
    console.log('[Sync] Already running — skipped');
    return null;
  }
  syncInProgress = true;

  console.log('[Sync] Starting FULL sync...');
  const startedAt = new Date();
  resetGHLState();
  loggedFirstKeys.clear();

  // Create per-entity log rows — all start as "running"
  const logIds = await syncLogStartAll('full');
  const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
  let failed = 0;

  // Step 0: Test LP API connection
  try {
    const connStatus = await testConnection();
    console.log(`[Sync] LP API connection: auth=${connStatus.auth_status}, api=${connStatus.api_test}`);
    if (connStatus.auth_status !== 'success') {
      console.error('[Sync] LP API authentication FAILED — check LP_API_BASE_URL, LP_USERNAME, LP_PASSWORD, LP_CLIENT_ID, LP_APP_KEY');
      for (const et of ENTITY_TYPES) await syncLogFail(logIds[et], 0, 'LP API auth failed');
      return counts;
    }
  } catch (err) {
    console.error('[Sync] LP API connection test failed:', err.message);
    for (const et of ENTITY_TYPES) await syncLogFail(logIds[et], 0, err.message);
    return counts;
  }

  try {
    // Step 1: Sync dispositions reference
    const dispCount = await syncDispositions();
    await syncLogComplete(logIds.dispositions, dispCount);

    // Step 1b: Enumerate sources for mapping table
    const srcCount = await populateSourceMapping();
    await syncLogComplete(logIds.sources, srcCount);

    // ── PASS 1 — Load all contacts into lp_leads ──────────────────
    // Only upserts lp_leads rows. No calls, notes, jobs, or milestones.
    // This ensures every parent row is committed before Pass 2 inserts
    // child records, eliminating foreign key race conditions.
    console.log('[Sync] PASS 1 — Loading all contacts into lp_leads...');

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const START_YEAR = 2000; // Must go back far enough to capture all historical leads
    const currentYear = today.getFullYear();

    for (let year = currentYear; year >= START_YEAR; year--) {
      const windowStart = `${year}-01-01`;
      // LP treats enddate as exclusive — use tomorrow so today's leads are captured
      const windowEnd = year === currentYear
        ? tomorrow.toISOString().slice(0, 10)
        : `${year}-12-31`;

      console.log(`[Sync P1] Fetching leads for ${windowStart} to ${windowEnd}...`);
      let startIndex = 1;
      const yearStartedAt = new Date();
      const yearStartCount = counts.leads;

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
          console.error(`[Sync P1] Failed to fetch leads (${windowStart}, index ${startIndex}):`, err.message);
          break;
        }

        const prospects = extractArray(result);
        if (prospects.length === 0) break;

        for (const prospect of prospects) {
          try {
            const leadCount = await upsertLeadOnly(prospect);
            counts.leads += leadCount;
          } catch (err) {
            failed++;
            const pid = prospect.cst_id || prospect.CstID || prospect.ProspectID;
            await logSyncError(pid, err);
          }
        }

        // Flush live progress for leads after every page
        await syncLogProgress(logIds.leads, counts.leads);

        console.log(`[Sync P1] [${year}] Page ${Math.ceil(startIndex / PAGE_SIZE)}: ${prospects.length} prospects fetched (${counts.leads} leads total)`);

        startIndex += prospects.length;
        await sleep(RATE_LIMIT_SLEEP_MS);
      }

      // Per-year-chunk sync log entry for monitoring
      const yearLeads = counts.leads - yearStartCount;
      if (yearLeads > 0) {
        try {
          await supabase.from('lp_sync_log').insert({
            entity_type:    'leads',
            sync_type:      `full_pass1_${year}`,
            status:         'completed',
            records_synced: yearLeads,
            started_at:     yearStartedAt.toISOString(),
            completed_at:   new Date().toISOString(),
          });
        } catch (_) { /* non-fatal */ }
      }
    }

    // Bug 1: Complete leads log IMMEDIATELY after Pass 1
    try {
      await syncLogComplete(logIds.leads, counts.leads, failed > 0 ? `${failed} prospects failed` : null);
    } catch (logErr) {
      console.error('[Sync] Failed to complete leads sync log:', logErr.message);
    }

    // Diagnostic: verify actual row count in Supabase
    try {
      const { count: dbCount } = await supabase
        .from('lp_leads')
        .select('*', { count: 'exact', head: true });
      console.log(`[Sync] PASS 1 complete — ${counts.leads} leads processed, ${dbCount} rows in lp_leads table`);
    } catch (_) {
      console.log(`[Sync] PASS 1 complete — ${counts.leads} lead rows committed to lp_leads`);
    }

    // Step 2b: Backfill sources + dispositions from committed lead data
    await backfillSourceMappingsFromLeads();
    await backfillDispositionsFromLeads();

    // ── PASS 2 — Load calls, notes, jobs, milestones ────────────
    // Reads from lp_leads (guaranteed committed by Pass 1), fetches
    // full LP records, and processes all child tables.
    console.log('[Sync] PASS 2 — Loading calls, notes, jobs, milestones...');

    try {
      await syncAllChildRecords(logIds, counts);
    } catch (err) {
      console.error('[Sync P2] Child record sync failed:', err.message);
    }

    // Complete child entity logs
    try {
      await syncLogComplete(logIds.calls,      counts.calls);
      await syncLogComplete(logIds.notes,      counts.notes);
      await syncLogComplete(logIds.jobs,       counts.jobs);
      await syncLogComplete(logIds.milestones, counts.milestones);
      await syncLogComplete(logIds.activities, counts.activities);
    } catch (logErr) {
      console.error('[Sync] Failed to complete child sync logs:', logErr.message);
    }

    console.log(`[Sync] PASS 2 complete — ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${counts.milestones} milestones`);

    // Step 2c: GHL backfill — match leads to GHL contacts and apply entry tags
    try {
      const { data: unmatchedLeads } = await supabase.from('lp_leads')
        .select('lp_lead_id, phone, phone_alt, email, ghl_entry_tag, ghl_tag_applied')
        .is('ghl_contact_id', null)
        .not('phone', 'is', null)
        .limit(5000);

      if (unmatchedLeads && unmatchedLeads.length > 0) {
        console.log(`[Sync] GHL backfill: ${unmatchedLeads.length} leads without GHL match`);
        let matched = 0;
        for (const lead of unmatchedLeads) {
          try {
            const ghlId = await matchToGHL({
              phone: lead.phone,
              phone_alt: lead.phone_alt,
              email: lead.email,
            });
            if (ghlId) {
              matched++;
              await supabase.from('lp_leads')
                .update({ ghl_contact_id: ghlId })
                .eq('lp_lead_id', lead.lp_lead_id);
              if (!lead.ghl_tag_applied && lead.ghl_entry_tag) {
                const success = await applyGHLTag(ghlId, lead.ghl_entry_tag);
                if (success) {
                  await supabase.from('lp_leads')
                    .update({ ghl_tag_applied: true })
                    .eq('lp_lead_id', lead.lp_lead_id);
                }
              }
            }
          } catch (err) { /* non-fatal */ }
        }
        await syncLogComplete(logIds.ghl_backfill, matched);
        console.log(`[Sync] GHL backfill complete: ${matched}/${unmatchedLeads.length} matched`);
      } else {
        await syncLogComplete(logIds.ghl_backfill, 0);
      }
    } catch (err) {
      console.warn('[Sync] GHL backfill failed:', err.message);
      await syncLogFail(logIds.ghl_backfill, 0, err.message);
    }

    // Bug 10: Propagate ghl_contact_id from lp_leads to lp_job_milestones
    // so milestone triggers can fire for leads that were backfilled above
    try {
      const { data: milestonesNeedingGhl } = await supabase
        .from('lp_job_milestones')
        .select('lp_job_id, mdt_id, lp_lead_id')
        .is('ghl_contact_id', null)
        .not('lp_lead_id', 'is', null);

      if (milestonesNeedingGhl && milestonesNeedingGhl.length > 0) {
        // Get unique lead IDs and their ghl_contact_ids
        const leadIds = [...new Set(milestonesNeedingGhl.map(m => m.lp_lead_id))];
        const { data: leads } = await supabase
          .from('lp_leads')
          .select('lp_lead_id, ghl_contact_id')
          .in('lp_lead_id', leadIds)
          .not('ghl_contact_id', 'is', null);

        if (leads && leads.length > 0) {
          const ghlMap = Object.fromEntries(leads.map(l => [l.lp_lead_id, l.ghl_contact_id]));
          let propagated = 0;
          for (const ms of milestonesNeedingGhl) {
            const ghlId = ghlMap[ms.lp_lead_id];
            if (ghlId) {
              await supabase.from('lp_job_milestones')
                .update({ ghl_contact_id: ghlId })
                .eq('lp_job_id', ms.lp_job_id)
                .eq('mdt_id', ms.mdt_id);
              propagated++;
            }
          }
          if (propagated > 0) {
            console.log(`[Sync] Propagated ghl_contact_id to ${propagated} milestone rows`);
          }
        }
      }
    } catch (err) {
      console.warn('[Sync] Milestone ghl_contact_id propagation failed:', err.message);
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
    // Mark any still-running entities as failed
    for (const et of ENTITY_TYPES) {
      await syncLogFail(logIds[et], counts[et] || 0, err.message).catch(() => {});
    }
  } finally {
    // Bug 2: Always release the mutex
    syncInProgress = false;
  }

  const duration = Date.now() - startedAt.getTime();
  console.log(`[Sync] Full sync complete — ${counts.leads} leads, ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${counts.milestones} milestones, ${failed} failed (${Math.round(duration / 1000)}s)`);
  return counts;
}

// ─── Incremental Sync — Two-Part ─────────────────────────────────
//
// Part 1: Changed leads via POST /api/Leads/GetLeadData (date range)
// Part 2: Job status changes via POST /api/Customers/GetJobStatusChanges

export async function incrementalSync() {
  // Bug 2: Prevent overlapping syncs
  if (syncInProgress) {
    console.log('[Sync] Already running — skipped');
    return null;
  }
  syncInProgress = true;

  console.log('[Sync] Starting incremental sync...');
  const startedAt = new Date();
  resetGHLState();

  try {
    const lastSyncTime = await getLastSyncTimestamp();
    if (!lastSyncTime) {
      console.log('[Sync] No previous sync found — running full sync instead');
      syncInProgress = false; // Release before delegating to fullSync which acquires its own
      return fullSync();
    }

    const logIds = await syncLogStartAll('incremental', ['leads', 'calls', 'notes', 'jobs', 'milestones', 'activities']);
    const counts = { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
    let failed = 0;

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
        break;
      }

      const items = extractArray(leads);
      if (items.length === 0) break;

      for (const lead of items) {
        try {
          const cstId = lead.cst_id || lead.CstID || lead.prospectid || lead.ProspectID;
          if (cstId) {
            const fullResult = await getLead(cstId);
            const fullProspects = extractArray(fullResult);
            if (fullProspects.length > 0) {
              const sub = await processProspect(fullProspects[0]);
              counts.leads++;
              if (sub) {
                counts.calls      += sub.calls;
                counts.notes      += sub.notes;
                counts.jobs       += sub.jobs;
                counts.milestones += sub.milestones;
                counts.activities += sub.calls + sub.notes;
              }
            }
          }
        } catch (err) {
          failed++;
          await logSyncError(lead.cst_id || lead.id, err);
        }
      }

      await Promise.all([
        syncLogProgress(logIds.leads,      counts.leads),
        syncLogProgress(logIds.calls,      counts.calls),
        syncLogProgress(logIds.notes,      counts.notes),
        syncLogProgress(logIds.jobs,       counts.jobs),
        syncLogProgress(logIds.milestones, counts.milestones),
        syncLogProgress(logIds.activities, counts.activities),
      ]);

      startIndex += items.length;
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
        break;
      }

      const items = extractArray(jobs);
      if (items.length === 0) break;

      for (const job of items) {
        try {
          await syncJobAndMilestones(job, job.lds_id || job.lp_lead_id, null);
          counts.jobs++;
          const milestones = getField(job, 'milestones', 'Milestones') || [];
          counts.milestones += milestones.length;
        } catch (err) {
          failed++;
          await logSyncError(job.job_id || job.JobID, err);
        }
      }

      await Promise.all([
        syncLogProgress(logIds.jobs,       counts.jobs),
        syncLogProgress(logIds.milestones, counts.milestones),
      ]);

      startIndex += items.length;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    // Complete all entity logs
    const errorMsg = failed > 0 ? `${failed} records failed` : null;
    await Promise.all([
      syncLogComplete(logIds.leads,      counts.leads,      errorMsg),
      syncLogComplete(logIds.calls,      counts.calls),
      syncLogComplete(logIds.notes,      counts.notes),
      syncLogComplete(logIds.jobs,       counts.jobs),
      syncLogComplete(logIds.milestones, counts.milestones),
      syncLogComplete(logIds.activities, counts.activities),
    ]);

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

    const duration = Date.now() - startedAt.getTime();
    console.log(`[Sync] Incremental sync complete — ${counts.leads} leads, ${counts.calls} calls, ${counts.notes} notes, ${counts.jobs} jobs, ${failed} failed (${Math.round(duration / 1000)}s)`);
    return counts;

  } catch (err) {
    console.error('[Sync] Incremental sync failed:', err.message);
    return { leads: 0, calls: 0, notes: 0, jobs: 0, milestones: 0, activities: 0 };
  } finally {
    // Bug 2: Always release the mutex
    syncInProgress = false;
  }
}

// ─── Webhook Handler ─────────────────────────────────────────────

export async function handleWebhookEvent(event, payload) {
  // Map webhook event → entity_type for the log
  const entityMap = {
    'lead.created': 'leads', 'lead.updated': 'leads', 'lead.disposition_changed': 'leads',
    'job.status_changed': 'jobs', 'call.logged': 'calls', 'note.added': 'notes',
    'milestone.completed': 'milestones',
  };
  const entityType = entityMap[event] || 'leads';
  const logId = await syncLogStart(entityType, `webhook_${event}`);
  let synced = 0;

  try {
    switch (event) {
      case 'lead.created':
      case 'lead.updated':
      case 'lead.disposition_changed': {
        const prospect = payload.lead || payload;
        await processProspect(prospect);
        synced++;
        await processMilestoneTriggers();
        break;
      }

      case 'job.status_changed': {
        const job = payload.job || payload;
        const cstId = job.cst_id || job.lead_id || job.lp_lead_id;
        if (cstId) {
          const result = await getLead(cstId);
          const prospects = extractArray(result);
          if (prospects[0]) await processProspect(prospects[0]);
        }
        await processMilestoneTriggers();
        synced++;
        break;
      }

      case 'call.logged':
      case 'note.added': {
        const cstId = payload.cst_id || payload.lead_id || payload.lp_lead_id;
        if (cstId) {
          const result = await getLead(cstId);
          const prospects = extractArray(result);
          if (prospects[0]) await processProspect(prospects[0]);
          synced++;
        }
        break;
      }

      case 'milestone.completed': {
        const cstId = payload.cst_id || payload.lead_id;
        if (cstId) {
          const result = await getLead(cstId);
          const prospects = extractArray(result);
          if (prospects[0]) await processProspect(prospects[0]);
        }
        await processMilestoneTriggers();
        synced++;
        break;
      }

      default:
        console.warn(`[Webhook] Unknown event type: ${event}`);
    }
    await syncLogComplete(logId, synced);
  } catch (err) {
    console.error(`[Webhook] Processing failed for ${event}:`, err.message);
    await syncLogFail(logId, synced, err.message);
  }

  return { synced };
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

// Bug 1: Mark any still-running sync logs as failed on process termination
async function markRunningLogsAsFailed() {
  try {
    await supabase.from('lp_sync_log')
      .update({
        status: 'failed',
        error_message: 'Process terminated',
        completed_at: new Date().toISOString(),
      })
      .eq('status', 'running');
    console.log('[Sync] Marked running sync logs as failed (process terminating)');
  } catch (_) {
    // Best-effort — process is shutting down
  }
}

process.on('SIGTERM', async () => {
  console.log('[Sync] SIGTERM received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsFailed();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Sync] SIGINT received — cleaning up...');
  stopSyncScheduler();
  await markRunningLogsAsFailed();
  process.exit(0);
});
