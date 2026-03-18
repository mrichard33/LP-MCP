import axios from 'axios';

// ─── Lead Perfection API Client ──────────────────────────────────
//
// The LP API is an ASP.NET Web API. Key differences from typical REST:
//   - Auth: OAuth2 password grant to /token endpoint
//   - All data endpoints use POST (not GET)
//   - Body is application/x-www-form-urlencoded (not JSON)
//   - Endpoint paths: /api/Customers/GetLead, /api/Leads/GetLeadData, etc.
//   - Base URL: https://{server_id}.leadperfection.com
//
// Required env vars:
//   LP_SERVER_ID  — e.g. 'api' (production) or 'apitest' (sandbox)
//   LP_CLIENT_ID  — client identifier
//   LP_USERNAME   — API user
//   LP_PASSWORD   — API password
//   LP_APP_KEY    — application key from LP

const LP_SERVER_ID = process.env.LP_SERVER_ID || '';
const LP_CLIENT_ID = process.env.LP_CLIENT_ID || '';
const LP_USERNAME  = process.env.LP_USERNAME || '';
const LP_PASSWORD  = process.env.LP_PASSWORD || '';
const LP_APP_KEY   = process.env.LP_APP_KEY || '';

// Support legacy LP_API_BASE_URL if set, otherwise construct from server ID
const LP_BASE_URL = process.env.LP_API_BASE_URL
  ? process.env.LP_API_BASE_URL.replace(/\/+$/, '')
  : LP_SERVER_ID
    ? `https://${LP_SERVER_ID}.leadperfection.com`
    : '';

// ─── Token Management ────────────────────────────────────────────

let accessToken = null;
let tokenExpiry = 0;

async function authenticate() {
  if (!LP_BASE_URL) {
    throw new Error('LP API not configured — set LP_SERVER_ID or LP_API_BASE_URL');
  }

  const tokenUrl = `${LP_BASE_URL}/token`;
  console.log(`[LP Client] Authenticating to ${tokenUrl}...`);

  try {
    const response = await axios.post(tokenUrl, new URLSearchParams({
      grant_type: 'password',
      username: LP_USERNAME,
      password: LP_PASSWORD,
      clientid: LP_CLIENT_ID,
      appkey: LP_APP_KEY,
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
      },
      timeout: 30000,
    });

    accessToken = response.data.access_token;
    // Token expires_in is in seconds; refresh 60s early
    const expiresIn = response.data.expires_in || 3600;
    tokenExpiry = Date.now() + (expiresIn - 60) * 1000;

    console.log(`[LP Client] Authenticated successfully (token expires in ${expiresIn}s)`);
    return accessToken;
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    throw new Error(`LP authentication failed: ${detail}`);
  }
}

async function getToken() {
  if (!accessToken || Date.now() >= tokenExpiry) {
    await authenticate();
  }
  return accessToken;
}

// Force re-auth (e.g. after 401)
function invalidateToken() {
  accessToken = null;
  tokenExpiry = 0;
}

// ─── LP API Request Helper ───────────────────────────────────────

async function lpPost(endpoint, params = {}) {
  const token = await getToken();
  const url = `${LP_BASE_URL}${endpoint}`;

  try {
    const response = await axios.post(url, new URLSearchParams(params).toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
      },
      timeout: 30000,
    });
    return response.data;
  } catch (err) {
    // If 401, invalidate token and retry once
    if (err.response?.status === 401) {
      console.warn('[LP Client] Got 401 — re-authenticating...');
      invalidateToken();
      const newToken = await getToken();
      const retryResponse = await axios.post(url, new URLSearchParams(params).toString(), {
        headers: {
          'Authorization': `Bearer ${newToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': '*/*',
        },
        timeout: 30000,
      });
      return retryResponse.data;
    }
    throw err;
  }
}

// ─── Retry + Circuit Breaker ─────────────────────────────────────

async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.pow(4, attempt) * 1000; // 1s, 4s, 16s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

let consecutiveFailures = 0;
let circuitOpen = false;
const CIRCUIT_THRESHOLD = 10;

function checkCircuit() {
  if (circuitOpen) {
    throw new Error('Circuit breaker OPEN — LP API has failed 10 consecutive times. Sync paused.');
  }
}

function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpen = false;
}

function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_THRESHOLD) {
    circuitOpen = true;
  }
}

export function resetCircuit() {
  consecutiveFailures = 0;
  circuitOpen = false;
}

export function getCircuitStatus() {
  return { consecutiveFailures, circuitOpen };
}

// ─── Wrapped LP API Calls ────────────────────────────────────────

/**
 * Fetch leads (paginated) using GetLead (Customers API).
 * Params: start_date, end_date, page_size, start_index, options, sort_order
 */
export async function getLeads(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Customers/GetLead', {
      start_date: params.start_date || '',
      end_date: params.end_date || '',
      cst_id: params.cst_id || '',
      lds_id: params.lds_id || '',
      ils_id: params.ils_id || '',
      page_size: String(params.limit || params.page_size || 50),
      start_index: String(params.start_index || ((params.page || 1) - 1) * (params.limit || 50)),
      options: params.options || '',
      sort_order: params.sort_order || '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Fetch prospect data (paginated) — alternative lead endpoint with more fields.
 */
export async function getProspectData(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Customers/GetProspectData', {
      start_date: params.start_date || '',
      end_date: params.end_date || '',
      cst_id: params.cst_id || '',
      lds_id: params.lds_id || '',
      ils_id: params.ils_id || '',
      page_size: String(params.limit || params.page_size || 50),
      start_index: String(params.start_index || ((params.page || 1) - 1) * (params.limit || 50)),
      options: params.options || '',
      sort_order: params.sort_order || '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Fetch a single lead/customer by prospect ID.
 */
export async function getLead(leadId) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Customers/GetCustomersByProspectID', {
      prospect_id: String(leadId),
      job_number: '',
      first_name: '',
      last_name: '',
      phone: '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Fetch leads updated since a timestamp — use GetLead with date range.
 */
export async function getLeadsUpdatedSince(since) {
  checkCircuit();
  try {
    const sinceDate = typeof since === 'string' ? since : new Date(since).toISOString().split('T')[0];
    const now = new Date().toISOString().split('T')[0];
    const result = await withRetry(() => lpPost('/api/Customers/GetLead', {
      start_date: sinceDate,
      end_date: now,
      cst_id: '',
      lds_id: '',
      ils_id: '',
      page_size: '500',
      start_index: '0',
      options: '',
      sort_order: '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Add call history for a customer (via Customers API).
 */
export async function getLeadCalls(leadId) {
  // LP doesn't have a "get calls" endpoint per se — calls come embedded in lead data.
  // Return empty array; call data is extracted from the lead response in processLead().
  return [];
}

/**
 * Get notes — LP notes are added via SalesApi/AddNotes but no "list notes" endpoint is documented.
 * Return empty array; notes will be synced from lead data if available.
 */
export async function getLeadNotes(leadId) {
  return [];
}

/**
 * Get activities — no separate endpoint documented. Return empty array.
 */
export async function getLeadActivities(leadId) {
  return [];
}

/**
 * Get job details using SalesApi.
 */
export async function getJob(jobId) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/SalesApi/GetSalesJobDetail', {
      job_id: String(jobId),
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Get milestones using Customers API.
 * Params: start_date, end_date, date_mode, mdt_id, etc.
 */
export async function getMilestones(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Customers/GetMilestones', {
      start_date: params.start_date || '',
      end_date: params.end_date || '',
      date_mode: params.date_mode || '',
      mdt_id: params.mdt_id || '',
      cst_id: params.cst_id || '',
      lds_id: params.lds_id || '',
      ils_id: params.ils_id || '',
      page_size: String(params.page_size || 100),
      start_index: String(params.start_index || 0),
      options: params.options || '',
      sort_order: params.sort_order || '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Get job status changes (Customers API) — useful for incremental sync.
 */
export async function getJobStatusChanges(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Customers/GetJobStatusChanges', {
      start_date: params.start_date || '',
      end_date: params.end_date || '',
      cst_id: params.cst_id || '',
      job_id: params.job_id || '',
      jbs_id: params.jbs_id || '',
      format_: params.format || '',
      page_size: String(params.page_size || 100),
      start_index: String(params.start_index || 0),
      options: params.options || '',
      sort_order: params.sort_order || '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Get sales appointments (Customers API).
 */
export async function getSalesAppointments(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Customers/GetSalesAppointments', {
      start_date: params.start_date || '',
      end_date: params.end_date || '',
      cst_id: params.cst_id || '',
      lds_id: params.lds_id || '',
      ils_id: params.ils_id || '',
      page_size: String(params.page_size || 100),
      start_index: String(params.start_index || 0),
      options: params.options || '',
      sort_order: params.sort_order || '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Get disposition/source reference data.
 * Uses GetSalesApptDispProd with data_type to get dispositions, products, etc.
 */
export async function getDispositions() {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/SalesApi/GetSalesApptDispProd', {
      data_type: 'D',  // D = dispositions
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Get source/sub-source reference data.
 * type: S=Sources, P=Promoters, B=Sub-sources, R=Referral sources
 */
export async function getSources(type = 'S') {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Leads/GetLeadsSourceSubPromoter', {
      type,
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Get sub-sources (sourcesubdescr values).
 */
export async function getSubSources() {
  return getSources('B');
}

/**
 * Get lead inbound info (Leads API) — another way to pull lead data.
 */
export async function getInboundLeadInfo(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Leads/GetInboundLeadInfo', {
      startdate: params.start_date || '',
      enddate: params.end_date || '',
      pro_id: params.pro_id || '',
      lognumber: params.lognumber || '',
      PageSize: String(params.page_size || 50),
      StartIndex: String(params.start_index || 0),
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/**
 * Get full lead data with milestones (Leads API).
 */
export async function getLeadData(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpPost('/api/Leads/GetLeadData', {
      startdate: params.start_date || '',
      enddate: params.end_date || '',
      ils_id: params.ils_id || '',
      milestones: params.milestones || '',
      option1: params.option1 || '',
      option2: params.option2 || '',
      option3: params.option3 || '',
      option4: params.option4 || '',
      option5: params.option5 || '',
    }));
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

// ─── Diagnostic Helper ───────────────────────────────────────────

export async function testConnection() {
  const status = {
    base_url: LP_BASE_URL || '(not configured)',
    server_id: LP_SERVER_ID || '(not set)',
    client_id: LP_CLIENT_ID ? '***configured***' : '(not set)',
    username: LP_USERNAME ? '***configured***' : '(not set)',
    password: LP_PASSWORD ? '***configured***' : '(not set)',
    app_key: LP_APP_KEY ? '***configured***' : '(not set)',
    auth_status: 'untested',
    api_test: 'untested',
    errors: [],
  };

  // Test 1: Authentication
  try {
    invalidateToken();
    await authenticate();
    status.auth_status = 'success';
  } catch (err) {
    status.auth_status = 'failed';
    status.errors.push(`Auth: ${err.message}`);
    return status;
  }

  // Test 2: Try a simple API call
  try {
    await lpPost('/api/SalesApi/GetSalesApptDispProd', { data_type: 'D' });
    status.api_test = 'success';
  } catch (err) {
    status.api_test = 'failed';
    status.errors.push(`API test: ${err.response?.status} ${err.message}`);
  }

  return status;
}
