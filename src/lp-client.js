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
import { LP_EMP } from './lp-source-ids.js';

const LP_BASE = () => (process.env.LP_API_BASE_URL || '').replace(/\/+$/, '');

// Legacy inbound-queue endpoint. Unauthenticated, JSON-body, returns
// `{"status":"OK","error":"","message":"lead added: <in1_id>"}`. This
// is the PRIMARY path for addLead as of 2026-05-02 — it is proven to
// preserve srs_id and pro_id attribution. Override via env var if LP
// changes the br* path or provides a non-production stub.
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

// LP_TIMEOUT — tagged error so interactive callers (e.g. the appointment
// resolver) can distinguish "LP was too slow to answer" from "LP answered
// that there is no such lead." Critical: a swallowed timeout must NOT be
// treated as not-found, or a real-but-slow lead gets wrongly routed to the
// no-lead enroll path and duplicated.
export class LpTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LpTimeoutError';
    this.code = 'LP_TIMEOUT';
  }
}

const RESOLVE_FAST_TIMEOUT_MS = parseInt(process.env.LP_RESOLVE_FAST_TIMEOUT_MS || '12000', 10);

// `opts.fast` → single attempt, short timeout, no retry/backoff. For
// interactive/tool callers that must fail fast instead of riding the
// 120s × 3-retry sync budget (which can run ~360s+ before throwing).
export const lpPost = async (endpoint, fields = {}, retries = 3, opts = {}) => {
  const token = await getToken();
  const body  = new URLSearchParams(fields);
  const base  = LP_BASE();

  if (!base) {
    throw new Error('LP_API_BASE_URL not configured');
  }

  const fast = opts.fast === true;
  const perCallTimeoutMs = fast ? RESOLVE_FAST_TIMEOUT_MS : 120000;
  const effectiveRetries = fast ? 1 : retries;

  for (let attempt = 1; attempt <= effectiveRetries; attempt++) {
    try {
      // Fast callers get a short timeout; sync callers keep the 120s budget
      // for large dataset queries.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), perCallTimeoutMs);

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
      // AbortError = our timeout fired. Re-tag so callers can branch on it.
      const isAbort = err?.name === 'AbortError';
      if (isAbort && fast) {
        throw new LpTimeoutError(`LP call ${endpoint} exceeded ${perCallTimeoutMs}ms (fast path)`);
      }
      if (attempt === effectiveRetries) {
        if (isAbort) throw new LpTimeoutError(`LP call ${endpoint} timed out after ${perCallTimeoutMs}ms`);
        throw err;
      }
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

// Wraps an LP call with circuit breaker. Exported so ad-hoc callers
// (e.g. the lp_api_probe admin tool) share the same breaker instead of
// bypassing it with raw lpPost calls.
export async function withCircuit(fn) {
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
export async function getLeads(params = {}, opts = {}) {
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
  }, 3, opts));
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

export async function getCustomers3(params = {}, opts = {}) {
  return withCircuit(() => lpPost('/api/Customers/GetCustomers3', {
    phone:       params.phone      || '',
    email:       params.email      || '',
    lastname:    params.lastname   || '',
    prospectid:  params.prospectid || '',
  }, 3, opts));
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

/**
 * POST /api/SalesApi/GetSalesSchedule — per-date rep slot availability.
 *
 * VERIFIED live 2026-07-21: returns per-date
 *   { Date, SlotsPerDay, Availability: [{ SlrId, RepName, RepHomeMarket,
 *     Attributes: [], Slots: [{ SlotId 1|2|3, SlotDescr "M/A/E", TmsTime,
 *     HasApptScheduled: boolean }] }] }
 * Slots carry NO appointment id, NO lead id, NO status — the boolean is all
 * there is. Reps carry 1–3 slots (their working schedule); SlotsPerDay=3 is a
 * ceiling, not a count.
 *
 * BrnID filters by RepHomeMarket (BrnID:"FTLAU" ≡ slicing "All" by
 * RepHomeMarket) — callers should make ONE "All" call per sweep and group
 * client-side via lp_branch_market_map rather than calling per branch.
 *
 * @param {Object} params
 * @param {string} params.StartDate — YYYY-MM-DD (ET calendar date)
 * @param {string} params.EndDate   — YYYY-MM-DD (ET calendar date)
 * @param {string|number} [params.SlrID=0] — 0 = all reps
 * @param {string} [params.BrnID='All']
 */
export async function getSalesSchedule({ StartDate, EndDate, SlrID = 0, BrnID = 'All' } = {}) {
  if (!StartDate || !EndDate) throw new Error('getSalesSchedule: StartDate and EndDate are required (YYYY-MM-DD)');
  return withCircuit(() => lpPost('/api/SalesApi/GetSalesSchedule', {
    StartDate,
    EndDate,
    SlrID:  String(SlrID),
    BrnID:  String(BrnID),
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
export async function getLeadByLdsId(ldsId, opts = {}) {
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
  }, 3, opts));
}

/**
 * POST /api/Downloads/GetLeadsByCQDID — the dialer feed for one call queue.
 *
 * Returns the leads in queue `cqdId` that are available to be dialed, one
 * row per lead: Cst_ID, Lds_ID, Cqd_ID, Phone/2/3, names, Source,
 * SubSourceDescr, Product, CurrentDisposition, NumDialingAttempts,
 * LastCallDatetime, LastCallResult. Queue membership is DERIVED lead state
 * (queues are views) — this endpoint is read-only and there is no companion
 * "put a lead in a queue" write; the only re-queue primitive is LeadAdd.
 *
 * Row windows are 1-indexed inclusive [startrow, endrow] over a contiguous
 * ROW_NUMBER — verified live 2026-08-18. LP caps pulls at 1000 rows.
 *
 * @param {number|string} cqdId    — call queue id (SalesApi/GetSalesApptDispProd type=q)
 * @param {number} [startrow=1]    — first row, 1-indexed inclusive
 * @param {number} [endrow=1000]   — last row, inclusive (max 1000-row window)
 */
export async function getLeadsByCQDID(cqdId, startrow = 1, endrow = 1000, opts = {}) {
  if (!cqdId) throw new Error('getLeadsByCQDID: cqdId is required');
  return withCircuit(() => lpPost('/api/Downloads/GetLeadsByCQDID', {
    cqd_id:   String(cqdId),
    startrow: String(startrow),
    endrow:   String(endrow),
  }, 3, opts));
}

/**
 * POST /api/Customers/GetCustomersByProspectID — minimal prospect read.
 *
 * Quick prospect search returning Prospect ID, name, address and phone.
 * This is the read-back used to VERIFY an UpdateProspectInfo write took —
 * cheap compared to the full GetLead payload.
 */
export async function getCustomersByProspectID(prospectId, opts = {}) {
  if (!prospectId) throw new Error('getCustomersByProspectID: prospectId is required');
  return withCircuit(() => lpPost('/api/Customers/GetCustomersByProspectID', {
    prospectid: String(prospectId),
  }, 3, opts));
}

/**
 * POST /api/Leads/GetInboundLeadInfo — inbound-queue status by lognumber.
 *
 * The live confirmation read after an addlead: workflow and agentic pushes
 * stamp lognumber = GHL contact ID, so the contact ID is the match key.
 * Same call check_lp_inbound exposes over MCP.
 */
export async function getInboundLeadInfo({ lognumber, startdate, enddate, pageSize = 50 } = {}, opts = {}) {
  if (!lognumber) throw new Error('getInboundLeadInfo: lognumber is required');
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const today = new Date();
  return withCircuit(() => lpPost('/api/Leads/GetInboundLeadInfo', {
    startdate:  startdate || fmt(new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)),
    enddate:    enddate || fmt(today),
    lognumber:  String(lognumber),
    PageSize:   String(pageSize),
    StartIndex: '1',
  }, 3, opts));
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
export async function setAppointment({ ldsId, setBy = LP_EMP.GHL_INTEGRATION, apptDate, apptTime }) {
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
 * POST /api/Customers/UpdateDNCStatus — Update internal DNC status on a prospect.
 *
 * Per LP API docs:
 *   - custid       — LP prospect ID (NOT lead ID, NOT in1_id)
 *   - newDncStatus — Single character code: C / M / T / E / P
 *                       C = Do Not Call
 *                       M = Do Not Mail
 *                       T = Do Not Text
 *                       E = Do Not Email
 *                       P = Do Not Promote (broadest suppression)
 *   - empid        — LP employee ID applying the DNC flag
 *   - phone        — Optional, used by LP for audit/dedup
 *   - Content-Type MUST be application/x-www-form-urlencoded
 *
 * LP returns array-wrapped response:
 *   Success: [{ "Result": 1, "Message": "..." }]
 *   Error:   [{ "Result": 0, "Message": "Error: Invalid DNC value. Customer ID does not exist. ..." }]
 *
 * Each DNC code is an INDEPENDENT flag in LP. To suppress multiple
 * channels, call this function multiple times with different codes,
 * or have the rule template emit multiple update_lp_dnc_status actions.
 *
 * Built 2026-05-01 to fix the GHL→LP DNC propagation gap. The original
 * GHL workflow webhook was failing with "Invalid DNC value. Customer ID
 * does not exist. Employee ID does not exist." — root cause was a merge-
 * field issue ({{contact.lp_prospect_id}} not resolving). This function
 * reads the prospect ID directly off the GHL contact object via the
 * action handler, bypassing the merge field entirely.
 *
 * @param {Object} params
 * @param {string|number} params.custid       — LP prospect ID
 * @param {string} params.newDncStatus        — One of: C, M, T, E, P
 * @param {string|number} [params.empid]      — LP employee ID (default 5686)
 * @param {string} [params.phone]             — Optional phone for LP audit
 * @returns {Object} LP API response (already validated for Result===1)
 */
const VALID_DNC_CODES = new Set(['C', 'M', 'T', 'E', 'P']);

// ─── DNC CLEAR code (Phase 2, 2026-07-24) ──────────────────────────────
// The single-character value UpdateDNCStatus accepts to WIPE the internal
// DNC flag (re-entry = new consent — see actions/handlers/lp-dnc.js CLEAR).
//
// ⚠ NOT probe-confirmed against production. The documented probe (candidate
// clear values "N"/""/"0"/"None", the accepted one being the clear code)
// MUTATES a live prospect's DNC on success, and the only known-DNC probe
// target on hand — prospect 447640 (Max Lesser) — is under a valid, current
// STOP revocation that must NOT be lifted. Confirm the exact value with a
// safe probe against a DISPOSABLE sandbox prospect, then set LP_DNC_CLEAR_CODE.
// Default 'N' (first UpdateDNCStatus clear candidate). A wrong value fails
// LOUD here (LP returns Result:0 / "Error:") — never a silent mis-clear.
export const LP_DNC_CLEAR_CODE = (process.env.LP_DNC_CLEAR_CODE || 'N').trim().toUpperCase();

export async function updateDncStatus({ custid, newDncStatus, empid = LP_EMP.GHL_INTEGRATION, phone }) {
  if (!custid) {
    throw new Error('updateDncStatus: custid (LP prospect ID) is required');
  }
  if (!newDncStatus) {
    throw new Error('updateDncStatus: newDncStatus is required (one of: C/M/T/E/P or CLEAR)');
  }
  const raw = String(newDncStatus).trim().toUpperCase();
  // CLEAR path — wipe the DNC flag. Accept the literal 'CLEAR' alias or the
  // configured clear code itself; both resolve to LP_DNC_CLEAR_CODE on the wire.
  const isClear = raw === 'CLEAR' || raw === LP_DNC_CLEAR_CODE;
  const code = isClear ? LP_DNC_CLEAR_CODE : raw;
  if (!isClear && !VALID_DNC_CODES.has(code)) {
    throw new Error(`updateDncStatus: invalid newDncStatus "${newDncStatus}" (must be one of: C/M/T/E/P or CLEAR)`);
  }

  console.log(`[LP] UpdateDNCStatus: custid=${custid}, code=${code}${isClear ? ' (CLEAR)' : ''}, empid=${empid}${phone ? `, phone=${phone}` : ''}`);

  const fields = {
    custid:       String(custid),
    newDncStatus: code,
    empid:        String(empid),
  };
  if (phone) fields.phone = String(phone);

  const result = await withCircuit(() => lpPost('/api/Customers/UpdateDNCStatus', fields));

  // LP returns array-wrapped responses for this endpoint — unwrap.
  const item = Array.isArray(result) ? (result[0] || {}) : (result || {});

  // Detect the documented failure shape:
  //   { "Result": 0, "Message": "Error: Invalid DNC value. Customer ID does not exist. ..." }
  const resultCode = item.Result ?? item.result ?? null;
  const message    = item.Message ?? item.message ?? '';
  const looksLikeError =
    resultCode === 0 ||
    (typeof message === 'string' && /^\s*Error\s*:/i.test(message));

  if (looksLikeError) {
    throw new Error(`LP UpdateDNCStatus error (custid=${custid}, code=${code}, empid=${empid}): ${message || '(no message)'}`);
  }

  console.log(`[LP] UpdateDNCStatus SUCCESS: custid=${custid}, code=${code}, response: ${JSON.stringify(item).slice(0, 200)}`);
  return item;
}

// ─── UpdateProspectInfo (2026-08-18 — the prospect-repair primitive) ─────
//
// LP dedupes a second LeadAdd onto the existing prospect and does NOT update
// prospect-level address from the later push (proven live on prospect 452653:
// the estimator push carried "4360 Washington Place" and the prospect kept a
// blank address). /api/Customers/UpdateProspectInfo is the ONLY way to repair
// the prospect record; a re-push never does it. Do NOT use UpdateCustomer —
// it only accepts firstname/lastname/phone.
//
// CAUTION (write semantics): UpdateProspectInfo OVERWRITES the fields you
// send. Sending an empty string over a populated LP field blanks it. So this
// wrapper only ever transmits fields with real values — enforced by
// buildProspectUpdateFields, which is exported for its own test.

export const LP_UPDATE_PROSPECT_EMPNAME = (process.env.LP_UPDATE_PROSPECT_EMPNAME || 'lpservice').trim();

const PROSPECT_UPDATABLE_FIELDS = ['firstname', 'lastname', 'address1', 'address2', 'city', 'state', 'zip', 'phone', 'email'];

/**
 * Build the field map for UpdateProspectInfo, keeping ONLY fields with real
 * (non-blank) values. Pure — unit tested in scripts/test-lp-callback-requeue.js.
 */
export function buildProspectUpdateFields(updates = {}) {
  const out = {};
  for (const key of PROSPECT_UPDATABLE_FIELDS) {
    const v = updates[key];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s === '') continue; // never send an empty string over a populated LP field
    out[key] = s;
  }
  return out;
}

/**
 * POST /api/Customers/UpdateProspectInfo — update prospect-level identity
 * fields. Caller should read back via getCustomersByProspectID to confirm
 * the write took (LP returns generic OK shapes).
 *
 * @param {Object} p
 * @param {string|number} p.custnumber — LP prospect ID (required)
 * @param {Object} p.updates          — candidate fields; blanks are stripped
 * @param {string} [p.empname]        — LP employee name (required by LP; doc default "lpservice")
 */
export async function updateProspectInfo({ custnumber, updates = {}, empname = LP_UPDATE_PROSPECT_EMPNAME } = {}) {
  if (!custnumber) throw new Error('updateProspectInfo: custnumber (LP prospect ID) is required');
  const fields = buildProspectUpdateFields(updates);
  if (Object.keys(fields).length === 0) {
    throw new Error('updateProspectInfo: no non-blank fields to update — refusing a no-op write');
  }

  console.log(`[LP] UpdateProspectInfo: custnumber=${custnumber}, fields=[${Object.keys(fields).join(', ')}], empname=${empname}`);

  const result = await withCircuit(() => lpPost('/api/Customers/UpdateProspectInfo', {
    custnumber: String(custnumber),
    ...fields,
    empname,
  }));

  const item = Array.isArray(result) ? (result[0] || {}) : (result || {});
  const resultCode = item.Result ?? item.result ?? null;
  const message    = item.Message ?? item.message ?? '';
  const looksLikeError =
    resultCode === 0 ||
    (typeof message === 'string' && /^\s*Error\s*:/i.test(message));
  if (looksLikeError) {
    throw new Error(`LP UpdateProspectInfo error (custnumber=${custnumber}): ${message || '(no message)'}`);
  }

  console.log(`[LP] UpdateProspectInfo SUCCESS: custnumber=${custnumber}, response: ${JSON.stringify(item).slice(0, 200)}`);
  return item;
}

// ═══════════════════════════════════════════════════════════════════
// addLead — LEGACY-FIRST with REST fallback (2026-05-02 reversal)
// ═══════════════════════════════════════════════════════════════════
//
// HISTORY:
//   2026-05-01: Implemented as REST-first per Mark's directive (auth'd
//   path, consistent with rest of the client). Legacy lppost was the
//   fallback.
//
//   2026-05-02: Reversed to LEGACY-FIRST after the Jeanne Jewell
//   recovery revealed two REST-path failures:
//     (a) LP REST /api/Leads/LeadAdd silently dropped srs_id and
//         pro_id attribution — the lead was created in LP but with
//         empty source/promoter columns.
//     (b) LP REST returned a response shape that extractInboundLeadId
//         couldn't parse, so the handler threw even though the lead
//         had been created.
//   The legacy lppost endpoint is the proven path used by every Reece
//   GHL workflow for years — it preserves srs_id/pro_id correctly and
//   returns the well-known `{status:"OK", message:"lead added: <id>"}`
//   shape that our parser handles.
//
// Field-name differences between paths:
//   REST       | Legacy
//   -----------|----------
//   phone      | phone1
//   productID  | productid
//   apptdate   | adate
//   appttime   | atime
//   email      | email      (BOTH ACCEPT — but LP does NOT require it)
//   srs_id     | srs_id     (BOTH ACCEPT)
//   pro_id     | pro_id     (BOTH ACCEPT)
//
// Callers should pass REST-style names. The function translates to
// legacy names automatically when calling the legacy path.
//
// Both endpoints add the lead to LP's INBOUND queue (not directly to
// the prospect table). LP processes the queue and fires the LP-Inbound
// Webhook callback to GHL when ready — that callback writes lp_lead_id,
// lp_prospect_id, and LP Disposition back to the GHL contact. So both
// paths feed into the same downstream callback chain.
//
// Both endpoints support same-session appointment creation when both
// date and time fields are present — single round-trip for chatbot
// in-session bookings.
//
// EMAIL IS OPTIONAL (2026-05-02). Mark confirmed LP accepts leads
// without an email address. The legacy path correctly omits email
// from the JSON body when blank; the REST path does the same.
//
// To opt INTO the REST-first path explicitly (for testing or migration),
// pass { _prefer_path: 'rest' }. Default is 'legacy'.

const LEGACY_FIELD_MAP = {
  phone:     'phone1',
  productID: 'productid',
  apptdate:  'adate',
  appttime:  'atime',
};

// 2026-08-15 — SETTER ON THE ADDLEAD PATH.
// setAppointment() stamps set_by = LP_EMP.GHL_INTEGRATION (5686, "Integration,
// GoHighLevel") on every appointment it sets. A lead created WITH its
// appointment through legacy addlead — the canvassing path and the chatbot
// self-heal path — passes no setter at all, so LP records whatever its own
// default is. Contact gUihunGyOa6SiGbJCJ3K went through exactly this path.
//
// The addlead field name for a setter is NOT documented and NOT confirmed.
// LP silently drops unrecognised keys, so guessing would ship a no-op that
// looks like a fix. This stays OFF until Amanda confirms the key; then set
// LP_ADDLEAD_SETTER_FIELD in Railway and it takes effect with no code change.
// Unset (the default) reproduces today's behaviour exactly.
const LP_ADDLEAD_SETTER_FIELD = (process.env.LP_ADDLEAD_SETTER_FIELD || '').trim();

function _translateToLegacy(restFields) {
  const out = {};
  for (const [k, v] of Object.entries(restFields || {})) {
    if (k.startsWith('_')) continue; // strip internal flags like _prefer_path
    const legacyKey = LEGACY_FIELD_MAP[k] || k;
    out[legacyKey] = v;
  }
  return out;
}

/**
 * Add a lead to LP's inbound queue. LEGACY-FIRST with REST fallback.
 *
 * Required fields (caller should provide REST naming):
 *   firstname, address1, city, state, zip, phone, srs_id
 *
 * Optional fields:
 *   email     — LP accepts leads without email; field is omitted when blank
 *   pro_id    — promoter ID for source attribution
 *   apptdate  + appttime — both must be set together or both omitted
 *   lognumber, User1, sender, productID, proddescr, notes, HasConsent,
 *   ConsentDate, TextOptIn, EmailOptIn, lastname
 *
 * Returns the LP response, normalized to a shape that includes:
 *   { ...originalResponse, _path: 'legacy' | 'rest' }
 *
 * Caller can use extractInboundLeadId() to parse the in1_id out.
 *
 * @param {Object} fields — REST-named field map. Optional `_prefer_path`
 *   key ('legacy' | 'rest') controls which path is tried first; default
 *   is 'legacy'.
 * @returns {Object} LP API response with _path indicator
 */
export async function addLead(fields = {}) {
  // Validate required fields up-front. EMAIL IS NOT REQUIRED — LP accepts
  // leads without email. Per Mark's correction 2026-05-02.
  const required = ['firstname', 'address1', 'city', 'state', 'zip', 'phone', 'srs_id'];
  const missing = required.filter(k => {
    const v = fields[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) {
    throw new Error(`addLead: missing required field(s): ${missing.join(', ')}`);
  }

  // Both apptdate and appttime must be set together or both omitted.
  if ((fields.apptdate && !fields.appttime) || (!fields.apptdate && fields.appttime)) {
    throw new Error('addLead: apptdate and appttime must both be set or both empty');
  }

  // Strip blank optional fields so they don't get serialized as empty
  // strings into the LP request body. LP's tolerance for empty strings
  // varies by endpoint — safer to omit.
  const cleanFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s === '') continue; // skip blanks (especially email, pro_id)
    cleanFields[k] = String(v);
  }

  const preferPath = (fields._prefer_path === 'rest') ? 'rest' : 'legacy';
  delete cleanFields._prefer_path;

  // Optional legacy-path retry budget. Default 2 preserves the historical
  // behavior for every existing caller; the canvassing webhook passes 3.
  const attempts = Math.max(1, Number(fields._attempts) || 2);
  delete cleanFields._attempts;

  // 2026-08-15 — stamp the GHL integration as the setter when the lead is
  // being created WITH an appointment. No-op unless LP_ADDLEAD_SETTER_FIELD
  // names a key LP actually accepts. An explicit caller-supplied value wins.
  if (LP_ADDLEAD_SETTER_FIELD && cleanFields.apptdate && cleanFields.appttime
      && !cleanFields[LP_ADDLEAD_SETTER_FIELD]) {
    cleanFields[LP_ADDLEAD_SETTER_FIELD] = String(LP_EMP.GHL_INTEGRATION);
    console.log(`[LP] addLead: stamping setter ${LP_ADDLEAD_SETTER_FIELD}=${LP_EMP.GHL_INTEGRATION} (Integration, GoHighLevel)`);
  }

  console.log(`[LP] addLead → trying ${preferPath.toUpperCase()} path first: firstname=${cleanFields.firstname}, phone=${cleanFields.phone}, srs_id=${cleanFields.srs_id}, pro_id=${cleanFields.pro_id || '(none)'}, email=${cleanFields.email || '(none)'}, lognumber=${cleanFields.lognumber || '(none)'}, apptdate=${cleanFields.apptdate || '(none)'}, appttime=${cleanFields.appttime || '(none)'}`);

  if (preferPath === 'legacy') {
    return _addLeadLegacyFirst(cleanFields, attempts);
  }
  return _addLeadRestFirst(cleanFields, attempts);
}

/**
 * Legacy-first ordering: try lppost, fall back to REST on failure.
 * This is the default path as of 2026-05-02.
 */
async function _addLeadLegacyFirst(cleanFields, attempts = 2) {
  // ─── PATH 1: Legacy lppost (preferred) ──────────────────────────
  let legacyErr = null;
  try {
    const result = await _callLegacyAddLead(cleanFields, attempts);
    return { ...(result || {}), _path: 'legacy' };
  } catch (err) {
    legacyErr = err;
    console.warn(`[LP] addLead LEGACY failed (${err.message.slice(0, 200)}) — falling back to REST /api/Leads/LeadAdd`);
  }

  // ─── PATH 2: REST fallback ──────────────────────────────────────
  try {
    const restResult = await _callRestLeadAdd(cleanFields);
    return { ...(restResult || {}), _path: 'rest', _legacy_error: legacyErr?.message?.slice(0, 200) };
  } catch (restErr) {
    throw new Error(`addLead failed: LEGACY=${legacyErr?.message?.slice(0, 150) || 'unknown'}; REST=${restErr.message.slice(0, 150)}`);
  }
}

/**
 * REST-first ordering: try /api/Leads/LeadAdd, fall back to lppost.
 * Available via { _prefer_path: 'rest' } for explicit opt-in.
 */
async function _addLeadRestFirst(cleanFields, attempts = 2) {
  // ─── PATH 1: REST ────────────────────────────────────────────────
  let restErr = null;
  try {
    const restResult = await _callRestLeadAdd(cleanFields);
    return { ...(restResult || {}), _path: 'rest' };
  } catch (err) {
    restErr = err;
    console.warn(`[LP] addLead REST failed (${err.message.slice(0, 200)}) — falling back to legacy lppost`);
  }

  // ─── PATH 2: Legacy fallback ────────────────────────────────────
  try {
    const result = await _callLegacyAddLead(cleanFields, attempts);
    return { ...(result || {}), _path: 'legacy', _rest_error: restErr?.message?.slice(0, 200) };
  } catch (legacyErr) {
    throw new Error(`addLead failed: REST=${restErr?.message?.slice(0, 150) || 'unknown'}; LEGACY=${legacyErr.message.slice(0, 150)}`);
  }
}

/**
 * Single-attempt REST call to /api/Leads/LeadAdd. Throws on any
 * non-success indicator (status≠OK, error string set, exception).
 */
async function _callRestLeadAdd(cleanFields) {
  // Strip internal _ flags before forwarding.
  const restFields = {};
  for (const [k, v] of Object.entries(cleanFields)) {
    if (k.startsWith('_')) continue;
    restFields[k] = String(v);
  }
  const restResult = await withCircuit(() => lpPost('/api/Leads/LeadAdd', restFields));

  const restHasError =
    (restResult?.error && String(restResult.error).trim() !== '') ||
    (restResult?.status && String(restResult.status).toUpperCase() !== 'OK');
  if (restHasError) {
    throw new Error(`REST LeadAdd returned error: status="${restResult?.status}", error="${restResult?.error}", message="${restResult?.message}"`);
  }

  console.log(`[LP] addLead REST SUCCESS: ${(restResult?.message || JSON.stringify(restResult)).slice(0, 200)}`);
  return restResult || {};
}

/**
 * Legacy lppost call with retries. Default 2 attempts (historical
 * behavior); backoff is exponential (2s, 4s, 8s, ...) on transient
 * failures (network, 5xx). Throws on any final failure.
 */
async function _callLegacyAddLead(cleanFields, attempts = 2) {
  const legacyFields = _translateToLegacy(cleanFields);
  const url = LP_POST_URL();

  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyFields),
        redirect: 'follow', // HTTP→HTTPS 307 is normal here
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`lppost ${res.status}: ${errText.slice(0, 200)}`);
      }

      const result = await res.json();

      if (result?.error && String(result.error).trim() !== '') {
        throw new Error(`lppost addlead error: ${result.error}`);
      }
      if (result?.status && String(result.status).toUpperCase() !== 'OK') {
        throw new Error(`lppost addlead non-OK status: ${result.status} — ${result.message || '(no message)'}`);
      }

      console.log(`[LP] addLead LEGACY SUCCESS: ${(result.message || JSON.stringify(result)).slice(0, 200)}`);
      return result || {};
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) {
        throw new Error(`lppost addlead failed after ${attempts} attempt(s): ${err.message.slice(0, 200)}`);
      }
      const backoffMs = 2000 * 2 ** (attempt - 1);
      console.warn(`[LP] addLead legacy attempt ${attempt} failed, retrying in ${backoffMs / 1000}s: ${err.message}`);
      await sleep(backoffMs);
    }
  }
  // Unreachable but keeps the type checker happy.
  throw lastErr || new Error('lppost addlead failed (unknown reason)');
}

/**
 * Parse the in1_id (LP inbound queue ID) out of an addLead response.
 * Handles both REST and legacy response shapes:
 *   - Legacy returns { status: "OK", message: "lead added: 384191" }
 *   - REST may return { id, in1_id, leadId, ... } depending on LP version
 *
 * Returns null if no parseable ID is found.
 *
 * @param {Object} addLeadResponse
 * @returns {string|null}
 */
export function extractInboundLeadId(addLeadResponse) {
  if (!addLeadResponse) return null;
  if (addLeadResponse.in1_id) return String(addLeadResponse.in1_id);
  if (addLeadResponse.id)     return String(addLeadResponse.id);
  if (addLeadResponse.leadId) return String(addLeadResponse.leadId);
  if (addLeadResponse.lead_id) return String(addLeadResponse.lead_id);
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
