// ─── Lead Perfection API Client — src/lp-client.js ───────────────
//
// ALL LP API endpoints are POST with Content-Type: application/x-www-form-urlencoded.
// Authentication is via JWT Bearer token managed by token-manager.js.
// Pagination uses StartIndex (1-based) + PageSize.
//
// LP_API_BASE_URL must be one of:
//   https://api.leadperfection.com   (Production 1 — most common)
//   https://api2.leadperfection.com  (Production 2)
//   https://api3.leadperfection.com  (Production 3)
//   https://apitest.leadperfection.com  (Test 1)
//   https://apitest2.leadperfection.com (Test 2)
//
// Token is ONLY valid on the server it was generated on.
//
// ═══════════════════════════════════════════════════════════════════
// IMPORTANT — LP API documentation status as of 2026-04-28:
// ═══════════════════════════════════════════════════════════════════
//
// /api/Leads/GetLeadData is OFFICIALLY DEPRECATED per LP's own docs:
//   "WARNING - This API call is depreciated. Although still useable,
//    no further updates or support will be provided for this call.
//    Please see Customers/GetLead for the current version."
//
// /api/Customers/GetLead is the modern replacement. Critically, it
// supports an `options` bitmask field that lets us filter on:
//   1024  - Lead Date Entered
//   2048  - Lead Last Changed Date
//   4096  - Lead Entry Date
//   8192  - Appointment Last Date Changed
//   16384 - Issued Lead Last Date changed
//   32768 - Job Last Modified On date
//   65536 - Milestone Updated On Date
//   131072 - Notes Last Update On date     ← KEY for catching new notes
//
// Comprehensive bitmask 261120 (sum of all of the above) returns any
// lead whose record OR notes OR calls OR appts OR jobs OR milestones
// changed in the window. This is the right call for incremental sync.
//
// As of 2026-04-24, /api/Leads/GetLeadData began silently returning 0
// rows for windows that DID contain changes. This client now bypasses
// it entirely and uses /api/Customers/GetLead with options=261120.

import { getToken, refreshToken, invalidateToken, getTokenStatus } from './token-manager.js';

const LP_BASE = () => (process.env.LP_API_BASE_URL || '').replace(/\/+$/, '');

// Legacy inbound-queue endpoint. Unauthenticated, JSON-body, returns
// `{"status":"OK","error":"","message":"lead added: <in1_id>"}`. Used
// by addLead() below. Override via env var if LP changes the br* path
// or provides a non-production stub.
const LP_POST_URL = () => (process.env.LP_POST_URL || 'https://lppost.leadperfection.com/br27/addlead');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Bitmask for GetLead change-window filtering ─────────────────
// 261120 = 1024+2048+4096+8192+16384+32768+65536+131072
// Captures every change we care about: lead created/modified, appts
// changed, issued leads changed, jobs modified, milestones updated,
// notes updated. Override via env var if LP changes the bit values
// or if a narrower filter becomes desired.

const GETLEAD_DEFAULT_OPTIONS = parseInt(process.env.LP_GETLEAD_OPTIONS || '261120', 10);

// ─── Core POST helper with retry + token refresh ─────────────────

export const lpPost = async (endpoint, fields = {}, retries = 3) => {
  const token = await getToken();
  const body  = new URLSearchParams(fields);
  const base  = LP_BASE();

  if (!base) {
    throw new Error('LP_API_BASE_URL not configured');
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // 120-second timeout — LP queries on large datasets can be slow
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      const res = await fetch(`${base}${endpoint}`, {
        method:  'POST',
        headers: {
          'Authorization':  `Bearer ${token}`,
          'Content-Type':   'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Token expired mid-sync — force refresh and retry
      if (res.status === 401 || res.status === 403) {
        console.warn(`[LP] Got ${res.status} — refreshing token...`);
        invalidateToken();
        const newToken = await refreshToken();
        // Retry immediately with new token
        const retryCtrl = new AbortController();
        const retryTimeout = setTimeout(() => retryCtrl.abort(), 120000);
        const retryRes = await fetch(`${base}${endpoint}`, {
          method:  'POST',
          headers: {
            'Authorization':  `Bearer ${newToken}`,
            'Content-Type':   'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: retryCtrl.signal,
        });
        clearTimeout(retryTimeout);
        if (!retryRes.ok) {
          const errText = await retryRes.text().catch(() => '');
          throw new Error(`LP API ${retryRes.status}: ${errText}`);
        }
        return await retryRes.json();
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`LP API ${res.status}: ${errText}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      // Exponential backoff: 1s, 4s, 16s
      const delay = Math.pow(4, attempt - 1) * 1000;
      console.warn(`[LP] Attempt ${attempt} failed, retrying in ${delay}ms:`, err.message);
      await sleep(delay);
    }
  }
};

// ─── Circuit Breaker ─────────────────────────────────────────────

let consecutiveFailures = 0;
let circuitOpen = false;
const CIRCUIT_THRESHOLD = 10;

function checkCircuit() {
  if (circuitOpen) {
    throw new Error('Circuit breaker OPEN — LP API has failed 10 consecutive times. Sync paused.');
  }
}
function recordSuccess() { consecutiveFailures = 0; circuitOpen = false; }
function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_THRESHOLD) circuitOpen = true;
}

export function resetCircuit() { consecutiveFailures = 0; circuitOpen = false; }
export function getCircuitStatus() { return { consecutiveFailures, circuitOpen }; }

// Wraps an LP call with circuit breaker
async function withCircuit(fn) {
  checkCircuit();
  try {
    const result = await fn();
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

// Internal: extract item array from any LP response shape
function _itemsFrom(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    return result.data || result.leads || result.results || result.items || [];
  }
  return [];
}

// ─── Phase 1 Read Endpoints ──────────────────────────────────────

/**
 * Bulk lead fetch via /api/Customers/GetLead.
 *
 * This is the MODERN, NON-DEPRECATED endpoint per LP docs.
 *
 * The `options` bitmask controls which date fields the date-range
 * filter applies to. Default is 261120 (all change types). Pass 0 for
 * "Lead Date Entered only" (legacy GetLeadData-equivalent behavior).
 *
 * Per LP docs, this endpoint returns FULL prospect data including
 * embedded notes, calls, jobs, milestones — no per-prospect re-fetch
 * needed for sync purposes (though sync-engine still does one for
 * freshness; that's a future optimization).
 */
export async function getLeads(params = {}) {
  return withCircuit(() => lpPost('/api/Customers/GetLead', {
    startdate:   params.startdate  || '2020-01-01',
    enddate:     params.enddate    || new Date().toISOString().slice(0, 10),
    cst_id:      String(params.cst_id  ?? 0),
    lds_id:      String(params.lds_id  ?? 0),
    ils_id:      String(params.ils_id  ?? 0),
    PageSize:    String(params.PageSize  || 50),
    StartIndex:  String(params.StartIndex || 1),
    options:     String(params.options ?? GETLEAD_DEFAULT_OPTIONS),
    SortOrder:   String(params.SortOrder ?? 0),
  }));
}

/**
 * Get leads with any change in the window — explicit, well-named alias
 * for getLeads with the comprehensive options bitmask. This is the
 * function sync-engine should call to find leads to sync.
 *
 * Pass `options` to override the default bitmask, or omit to use 261120.
 */
export async function getChangedLeads(params = {}) {
  return getLeads({
    startdate:  params.startdate,
    enddate:    params.enddate,
    cst_id:     params.cst_id,
    lds_id:     params.lds_id,
    ils_id:     params.ils_id,
    PageSize:   params.PageSize,
    StartIndex: params.StartIndex,
    options:    params.options ?? GETLEAD_DEFAULT_OPTIONS,
    SortOrder:  params.SortOrder,
  });
}

/**
 * Legacy alias — getLeadData() is the function sync-engine.js currently
 * imports. Per LP docs, /api/Leads/GetLeadData is officially deprecated.
 * We route this call through getChangedLeads (which uses /api/Customers/GetLead
 * with options=261120) so existing call sites keep working without a
 * sync-engine.js diff.
 *
 * If LP ever fixes the deprecated endpoint and you want to revert, set
 * env LP_USE_DEPRECATED_GETLEADDATA=true (not recommended).
 */
export async function getLeadData(params = {}) {
  if (String(process.env.LP_USE_DEPRECATED_GETLEADDATA || '').toLowerCase() === 'true') {
    return _getLeadDataDeprecated(params);
  }
  return getChangedLeads(params);
}

// ─── Deprecated/diagnostic raw GetLeadData call ──────────────────
// Kept around for the sync-probe endpoint and as an emergency
// backdoor via LP_USE_DEPRECATED_GETLEADDATA=true. Do NOT use this
// in normal sync flows — LP docs say it will not be updated/supported.

async function _getLeadDataDeprecated(params = {}, { omitProId = false } = {}) {
  const fields = {
    startdate:   params.startdate  || '',
    enddate:     params.enddate    || '',
    PageSize:    String(params.PageSize  || 50),
    StartIndex:  String(params.StartIndex || 1),
  };
  if (!omitProId) {
    fields.pro_id = String(params.pro_id ?? 0);
  }
  return withCircuit(() => lpPost('/api/Leads/GetLeadData', fields));
}

// Diagnostic helper used by /n8n/admin/sync-probe — runs all 3 paths
// (deprecated GetLeadData with pro_id=0, deprecated GetLeadData without
// pro_id, modern GetLead with bitmask) in parallel. Returns counts +
// first-item keys for each so we can verify what LP actually returns.
export async function probeLeadEndpoints({ startdate, enddate, PageSize = 50 } = {}) {
  const probes = await Promise.allSettled([
    _getLeadDataDeprecated({ startdate, enddate, PageSize, StartIndex: 1 }),
    _getLeadDataDeprecated({ startdate, enddate, PageSize, StartIndex: 1 }, { omitProId: true }),
    getLeads({ startdate, enddate, PageSize, StartIndex: 1, options: GETLEAD_DEFAULT_OPTIONS }),
  ]);

  const summarize = (label, settledResult) => {
    if (settledResult.status === 'rejected') {
      return { label, error: settledResult.reason?.message || String(settledResult.reason) };
    }
    const items = _itemsFrom(settledResult.value);
    return {
      label,
      count: items.length,
      response_shape: Array.isArray(settledResult.value) ? 'array' : (typeof settledResult.value),
      first_item_keys: items[0] ? Object.keys(items[0]).slice(0, 20) : [],
      raw_response_keys: !Array.isArray(settledResult.value) && settledResult.value
        ? Object.keys(settledResult.value)
        : [],
    };
  };

  return {
    path_a: summarize('GetLeadData with pro_id=0 (DEPRECATED per LP docs)', probes[0]),
    path_b: summarize('GetLeadData with pro_id omitted (DEPRECATED)', probes[1]),
    path_c: summarize(`GetLead with options=${GETLEAD_DEFAULT_OPTIONS} (CURRENT, used by sync)`, probes[2]),
    options_bitmask: GETLEAD_DEFAULT_OPTIONS,
    options_explanation: '261120 = Lead Created + Lead Modified + Lead Entry + Appt Changed + Issued Lead Changed + Job Modified + Milestone Updated + Notes Updated',
  };
}

// Backward-compat exports — these no longer maintain meaningful state
// but are still imported by data-freshness.js. Keep them as no-ops so
// freshness probe doesn't break.
export function getLeadPathCacheState() {
  return {
    cached_path: 'C',
    valid: true,
    note: 'Auto-fallback retired 2026-04-28 — sync now uses /api/Customers/GetLead with options bitmask permanently. See lp-client.js header for details.',
    options_bitmask: GETLEAD_DEFAULT_OPTIONS,
  };
}
export function clearLeadPathCache() { /* no-op — cache retired */ }

export async function getJobStatusChanges(params = {}) {
  return withCircuit(() => lpPost('/api/Customers/GetJobStatusChanges', {
    startdate:   params.startdate  || '',
    enddate:     params.enddate    || '',
    cst_id:      String(params.cst_id  ?? 0),
    job_id:      String(params.job_id  ?? 0),
    jbs_id:      params.jbs_id     || '',
    PageSize:    String(params.PageSize  || 50),
    StartIndex:  String(params.StartIndex || 1),
    options:     String(params.options ?? 0),
    sortorder:   String(params.sortorder ?? 1),
  }));
}

export async function getMilestones(params = {}) {
  return withCircuit(() => lpPost('/api/Customers/GetMilestones', {
    startdate:   params.startdate  || '',
    enddate:     params.enddate    || '',
    cst_id:      String(params.cst_id  ?? 0),
    lds_id:      String(params.lds_id  ?? 0),
    PageSize:    String(params.PageSize  || 100),
    StartIndex:  String(params.StartIndex || 1),
  }));
}

export async function getLeadInfo(params = {}) {
  return withCircuit(() => lpPost('/api/Customers/GetLeadInfo', {
    prospectid:  params.prospectid || '',
    jobnumber:   params.jobnumber  || '',
    lastname:    params.lastname   || '',
    phone:       params.phone      || '',
    PageSize:    String(params.PageSize  || 50),
    StartIndex:  String(params.StartIndex || 1),
  }));
}

export async function getCustomers3(params = {}) {
  return withCircuit(() => lpPost('/api/Customers/GetCustomers3', {
    phone:       params.phone      || '',
    email:       params.email      || '',
    lastname:    params.lastname   || '',
    prospectid:  params.prospectid || '',
  }));
}

export async function getLeadsSourceSubPromoter(type = 's') {
  return withCircuit(() => lpPost('/api/Leads/GetLeadsSourceSubPromoter', {
    type,
  }));
}

export async function getSalesApptDispProd(type = 'd') {
  return withCircuit(() => lpPost('/api/SalesApi/GetSalesApptDispProd', {
    type,
  }));
}

export async function getSalesJobDetail(jobId) {
  return withCircuit(() => lpPost('/api/SalesApi/GetSalesJobDetail', {
    job_id: String(jobId),
  }));
}

// ─── Convenience aliases matching sync-engine imports ────────────

export const getDispositions = () => getSalesApptDispProd('d');
export const getSources      = (type = 's') => getLeadsSourceSubPromoter(type);
export const getSubSources   = () => getLeadsSourceSubPromoter('b');

export async function getLead(cstId) {
  return withCircuit(() => lpPost('/api/Customers/GetLead', {
    startdate:   '2000-01-01',
    enddate:     new Date().toISOString().slice(0, 10),
    cst_id:      String(cstId),
    lds_id:      '0',
    ils_id:      '0',
    PageSize:    '1',
    StartIndex:  '1',
    options:     '0',
    SortOrder:   '0',
  }));
}

/**
 * Get a lead directly from LP by Lead ID (lds_id).
 * Returns the prospect record containing this lead.
 * Used by Action Executor to get the most current Prospect ID
 * directly from Lead Perfection (bypasses Supabase cache delay).
 *
 * @param {string|number} ldsId — LP Lead ID
 * @returns {Object} LP API response (array of prospect records)
 */
export async function getLeadByLdsId(ldsId) {
  return withCircuit(() => lpPost('/api/Customers/GetLead', {
    startdate:   '2000-01-01',
    enddate:     new Date().toISOString().slice(0, 10),
    cst_id:      '0',
    lds_id:      String(ldsId),
    ils_id:      '0',
    PageSize:    '1',
    StartIndex:  '1',
    options:     '0',
    SortOrder:   '0',
  }));
}

// ═══════════════════════════════════════════════════════════════════
// Phase 2 Write Endpoints
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /api/Leads/SetAppointment — Set appointment in LP for a lead.
 *
 * Per LP API docs:
 *   - lds_id    — LP lead ID (NOT prospect ID, NOT in1_id)
 *   - set_by    — LP employee ID setting the appointment
 *   - appt_date — MM/dd/yyyy format
 *   - appt_time — Standard 24-hour HH:MM format (e.g. "14:30")
 *   - Content-Type MUST be application/x-www-form-urlencoded
 *
 * The lead must be in a 'set-able' status — typically dispo'd as Data,
 * not Out Of Area, and without an existing future appointment.
 * SetAppointment will fail (return error) if any of these are violated.
 *
 * For sales-rep-specific assignment, consider /api/Leads/SetAppointmentSalesRep
 * which adds optional product_id and slr_id parameters.
 *
 * @param {string} ldsId    — LP lead ID
 * @param {string} setBy    — LP employee ID (default: 5686 = GHL system user)
 * @param {string} apptDate — Date in MM/DD/YYYY format
 * @param {string} apptTime — Time in HH:MM 24-hour format
 * @returns {Object} LP API response
 */
export async function setAppointment({ ldsId, setBy = '5686', apptDate, apptTime }) {
  if (!ldsId) throw new Error('setAppointment: ldsId (LP lead ID) is required');
  if (!apptDate) throw new Error('setAppointment: apptDate is required (MM/DD/YYYY)');
  if (!apptTime) throw new Error('setAppointment: apptTime is required (HH:MM 24h)');

  console.log(`[LP] SetAppointment: lds_id=${ldsId}, date=${apptDate}, time=${apptTime}, set_by=${setBy}`);

  const result = await withCircuit(() => lpPost('/api/Leads/SetAppointment', {
    lds_id:    String(ldsId),
    set_by:    String(setBy),
    appt_date: apptDate,
    appt_time: apptTime,
  }));

  // Check for LP error response
  if (result?.error) {
    throw new Error(`LP SetAppointment error: ${result.error} (message: ${result.message || 'none'})`);
  }

  console.log(`[LP] SetAppointment SUCCESS: lds_id=${ldsId}, response: ${JSON.stringify(result).slice(0, 200)}`);
  return result;
}

/**
 * POST to legacy lppost endpoint to add a lead to LP's inbound queue.
 *
 * Endpoint: ${LP_POST_URL} (default https://lppost.leadperfection.com/br27/addlead).
 * This is NOT the documented REST API /api/Leads/LeadAdd — it's the legacy
 * inbound-queue webhook. We use it instead of LeadAdd for two reasons:
 *
 *   1. UNAUTHENTICATED. Doesn't need the Bearer token, so it's resilient
 *      to token-manager hiccups during high-traffic intake.
 *   2. INBOUND-QUEUE PATH. LP processes leads through its inbound queue
 *      and fires the LP-Inbound Webhook callback to GHL when ready —
 *      that callback is what writes lp_lead_id, lp_prospect_id, and
 *      LP Disposition back to the GHL contact. Hitting LeadAdd on the
 *      REST API skips that callback chain.
 *
 * Critically, when both `adate` (MM/DD/YYYY) and `atime` ("10:00 AM" or
 * "14:00") are present, LP creates the appointment as part of inbound
 * processing — single round-trip for chatbot/in-session bookings where
 * the lead doesn't yet exist in LP.
 *
 * Required fields: firstname, address1, city, state, zip, phone1, email,
 * srs_id (LP SubSource ID). Without phone1 the inbound queue rejects the
 * row silently and you get back status=OK with an empty in1_id.
 *
 * Response shape:
 *   { status: "OK", error: "", message: "lead added: 384191" }
 *
 * The trailing integer is the in1_id (LP inbound queue row ID), NOT the
 * real lds_id. The real lds_id arrives via the LP-Inbound Webhook callback
 * once LP's queue processes the row (typically <60s).
 *
 * @param {Object} fields — flat object with all the LP inbound fields
 * @returns {{ status: string, error: string, message: string }}
 */
export async function addLead(fields = {}) {
  const url = LP_POST_URL();

  // Minimal validation — LP rejects the row silently if any of these
  // are missing. Surface a clean error to the caller instead.
  const required = ['firstname', 'address1', 'city', 'state', 'zip', 'phone1', 'email', 'srs_id'];
  const missing = required.filter(k => {
    const v = fields[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) {
    throw new Error(`addLead: missing required field(s): ${missing.join(', ')}`);
  }

  console.log(`[LP] addLead → ${url}: firstname=${fields.firstname}, phone1=${fields.phone1}, lognumber=${fields.lognumber || '(none)'}, adate=${fields.adate || '(none)'}, atime=${fields.atime || '(none)'}`);

  // 30-second timeout — this endpoint is fast (<2s typical). retries=2.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
        redirect: 'follow', // HTTP→HTTPS 307 redirect is normal here
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`lppost ${res.status}: ${errText.slice(0, 200)}`);
      }

      const result = await res.json();

      // LP returns { status: "OK", error: "", message: "lead added: <in1_id>" }
      // on success. On validation failure it returns status=ERROR and a
      // human-readable error string.
      if (result?.error) {
        throw new Error(`lppost addlead error: ${result.error}`);
      }
      if (result?.status && result.status.toUpperCase() !== 'OK') {
        throw new Error(`lppost addlead non-OK status: ${result.status} — ${result.message || '(no message)'}`);
      }

      console.log(`[LP] addLead SUCCESS: ${result.message || JSON.stringify(result).slice(0, 200)}`);
      return result;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`[LP] addLead attempt ${attempt} failed, retrying in 2s: ${err.message}`);
      await sleep(2000);
    }
  }
}

/**
 * Parse the in1_id (LP inbound queue ID) out of an addLead response.
 * Response message format is "lead added: 384191" — we want "384191".
 * Returns null if the message doesn't contain a parseable ID.
 *
 * @param {{ message?: string }} addLeadResponse
 * @returns {string|null}
 */
export function extractInboundLeadId(addLeadResponse) {
  if (!addLeadResponse) return null;
  const msg = String(addLeadResponse.message || '');
  const match = msg.match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

/**
 * POST /api/SalesApi/AddNotes — Add a note to a prospect, issued lead, or job.
 *
 * Per LP API docs:
 *   - rectype: 'cst' (prospect) | 'ils' (issued lead) | 'job'
 *   - recid:   ID number (cst_id / ils_id / job_id depending on rectype)
 *   - notes:   Note body text
 *   - nct_id:  Note category ID (default 1; client-specific)
 *
 * Useful for the agentic system to leave a record in LP after a tag/
 * action change so the next sales rep sees what the bot did.
 *
 * @param {Object} params
 * @param {string} params.rectype — 'cst' | 'ils' | 'job'
 * @param {string|number} params.recid — entity ID
 * @param {string} params.notes — note text
 * @param {number} [params.categoryId] — note category (default 1)
 * @returns {Object} LP API response
 */
export async function addNote({ rectype, recid, notes, categoryId = 1 }) {
  if (!['cst', 'ils', 'job'].includes(rectype)) {
    throw new Error(`addNote: rectype must be 'cst', 'ils', or 'job' (got '${rectype}')`);
  }
  if (!recid) throw new Error('addNote: recid is required');
  if (!notes) throw new Error('addNote: notes is required');

  return withCircuit(() => lpPost('/api/SalesApi/AddNotes', {
    rectype,
    recid:  String(recid),
    notes,
    nct_id: String(categoryId),
  }));
}

// ─── Diagnostic — Connection Test ────────────────────────────────

export async function testConnection() {
  const base = LP_BASE();
  const status = {
    base_url:    base || '(not configured)',
    client_id:   process.env.LP_CLIENT_ID ? '***set***' : 'MISSING',
    username:    process.env.LP_USERNAME  ? '***set***' : 'MISSING',
    password:    process.env.LP_PASSWORD  ? '***set***' : 'MISSING',
    app_key:     process.env.LP_APP_KEY   ? '***set***' : 'MISSING',
    token_status: getTokenStatus(),
    auth_status: 'untested',
    api_test:    'untested',
    errors:      [],
  };

  // Test 1: Authentication
  try {
    invalidateToken();
    await getToken();
    status.auth_status = 'success';
    status.token_status = getTokenStatus();
  } catch (err) {
    status.auth_status = 'failed';
    status.errors.push(`Auth: ${err.message}`);
    return status;
  }

  // Test 2: Try a simple API call (GetSalesApptDispProd type=d)
  try {
    const result = await lpPost('/api/SalesApi/GetSalesApptDispProd', { type: 'd' });
    status.api_test = 'success';
    status.api_test_result_count = Array.isArray(result) ? result.length : 'non-array';
  } catch (err) {
    status.api_test = 'failed';
    status.errors.push(`API: ${err.message}`);
  }

  return status;
}
