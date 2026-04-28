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

import { getToken, refreshToken, invalidateToken, getTokenStatus } from './token-manager.js';

const LP_BASE = () => (process.env.LP_API_BASE_URL || '').replace(/\/+$/, '');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// ─── Phase 1 Read Endpoints ──────────────────────────────────────

export async function getLeads(params = {}) {
  return withCircuit(() => lpPost('/api/Customers/GetLead', {
    startdate:   params.startdate  || '2020-01-01',
    enddate:     params.enddate    || new Date().toISOString().slice(0, 10),
    cst_id:      String(params.cst_id  ?? 0),
    lds_id:      String(params.lds_id  ?? 0),
    ils_id:      String(params.ils_id  ?? 0),
    PageSize:    String(params.PageSize  || 50),
    StartIndex:  String(params.StartIndex || 1),
    options:     String(params.options ?? 0),
    SortOrder:   String(params.SortOrder ?? 0),
  }));
}

// Internal: extract item array from any LP response shape
function _itemsFrom(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    return result.data || result.leads || result.results || result.items || [];
  }
  return [];
}

// Internal: raw call to /api/Leads/GetLeadData (no fallback)
async function _getLeadDataRaw(params = {}, { omitProId = false } = {}) {
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

// ─── getLeadData with auto-fallback ──────────────────────────────
// Background: starting ~2026-04-24, /api/Leads/GetLeadData began silently
// returning 0 rows for valid windows that DID contain changes. The same
// window on /api/Customers/GetLead returns full data, and
// /api/Customers/GetJobStatusChanges (also under /Customers/) returns
// thousands of milestones. Pattern strongly suggests an LP-side change to
// /api/Leads/GetLeadData (likely pro_id=0 semantics or endpoint drift).
//
// Strategy:
//   1. Try /api/Leads/GetLeadData with pro_id=0 (legacy behavior)
//   2. If first page returns 0 items, try the same call with pro_id omitted
//   3. If THAT also returns 0, fall back to /api/Customers/GetLead via getLeads()
//   4. Log which path succeeded so we can tell what's actually happening
//
// Disable via env LP_GETLEADDATA_FALLBACK=false to revert to original behavior.
//
// IMPORTANT: We only fall back when StartIndex=1 (first page). If we're
// paginating mid-stream we trust the original call's "no more pages" signal.

export async function getLeadData(params = {}) {
  const fallbackEnabled = String(process.env.LP_GETLEADDATA_FALLBACK || 'true').toLowerCase() !== 'false';
  const isFirstPage = (params.StartIndex || 1) === 1 || params.StartIndex === '1';

  // ─── Path A: Original /api/Leads/GetLeadData with pro_id=0 ────
  let result;
  try {
    result = await _getLeadDataRaw(params);
  } catch (err) {
    // Hard error on path A — re-throw, don't try fallbacks
    throw err;
  }

  if (!fallbackEnabled || !isFirstPage) return result;

  const itemsA = _itemsFrom(result);
  if (itemsA.length > 0) {
    return result;
  }

  // ─── Path B: /api/Leads/GetLeadData with pro_id OMITTED ───────
  // (Tests whether pro_id=0 is the issue specifically.)
  try {
    const resultB = await _getLeadDataRaw(params, { omitProId: true });
    const itemsB = _itemsFrom(resultB);
    if (itemsB.length > 0) {
      console.warn(`[LP] getLeadData fallback HIT path B (pro_id omitted) — ${itemsB.length} items. ` +
                   `pro_id=0 appears to be the broken parameter; consider patching the call permanently.`);
      return resultB;
    }
  } catch (err) {
    console.warn('[LP] getLeadData path B (no pro_id) failed:', err.message);
  }

  // ─── Path C: Fall back to /api/Customers/GetLead via getLeads ──
  try {
    const resultC = await getLeads({
      startdate: params.startdate,
      enddate:   params.enddate,
      PageSize:  params.PageSize,
      StartIndex: params.StartIndex,
    });
    const itemsC = _itemsFrom(resultC);
    if (itemsC.length > 0) {
      console.warn(`[LP] getLeadData fallback HIT path C (/api/Customers/GetLead) — ${itemsC.length} items. ` +
                   `Original /api/Leads/GetLeadData appears broken on LP side; sync running on fallback.`);
      return resultC;
    }
    console.warn('[LP] getLeadData all 3 paths returned 0 items — window may genuinely be empty, or LP API broken.');
    return resultC;  // Return the empty result so caller treats as "no records"
  } catch (err) {
    console.warn('[LP] getLeadData path C (getLeads fallback) failed:', err.message);
    return result;  // Return original empty result
  }
}

// Diagnostic helper used by sync-probe — runs all 3 paths in parallel,
// returns counts + first-item keys for each. Mark hits this via the
// /n8n/admin/sync-probe endpoint to see what LP actually returns.
export async function probeLeadEndpoints({ startdate, enddate, PageSize = 50 } = {}) {
  const probes = await Promise.allSettled([
    _getLeadDataRaw({ startdate, enddate, PageSize, StartIndex: 1 }),
    _getLeadDataRaw({ startdate, enddate, PageSize, StartIndex: 1 }, { omitProId: true }),
    getLeads({ startdate, enddate, PageSize, StartIndex: 1 }),
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
    path_a: summarize('GetLeadData with pro_id=0 (current behavior)', probes[0]),
    path_b: summarize('GetLeadData with pro_id omitted', probes[1]),
    path_c: summarize('GetLead (alternate endpoint, /api/Customers/GetLead)', probes[2]),
  };
}

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
 * LP requires EXACTLY these fields as form-urlencoded (no JSON, no extra fields):
 *   lds_id    — LP lead ID (NOT prospect ID)
 *   set_by    — LP employee ID of the person setting the appointment
 *   appt_date — Appointment date in MM/DD/YYYY format
 *   appt_time — Appointment time in HH:MM 24-hour format
 * 
 * Returns: { message: "Appointment set successfully.", status: null, error: null }
 * Error:   { message: "Exception Occured", error: "Cannot find column 1.", status: null }
 *          (This error means the body was sent as JSON instead of form-encoded)
 * 
 * CRITICAL: Content-Type MUST be application/x-www-form-urlencoded.
 *           lpPost() handles this automatically via URLSearchParams.
 *           NEVER send JSON body to this endpoint.
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
