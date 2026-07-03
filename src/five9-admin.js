/**
 * Five9 Configuration Web Services (Admin SOAP API) client — src/five9-admin.js
 *
 * Phase A: READ-ONLY campaign visibility. No write methods exist in this
 * module yet — when they come (startCampaign/stopCampaign/resetCampaign),
 * they go behind the approve_action gate, never direct MCP calls.
 *
 * Endpoint: https://api.five9.com/wsadmin/v13/AdminWebService
 * Auth: HTTP Basic with a Five9 admin user that has the
 *   "User can use Administrator Services" role permission enabled
 *   (Roles tab → Administrator). Verified live 2026-07-03 via getCampaigns.
 *
 * Env (Railway):
 *   FIVE9_USERNAME        service account (svc-reece-api@reecewindows.com)
 *   FIVE9_PASSWORD        service account password
 *   FIVE9_ADMIN_WSDL_URL  optional override of the endpoint URL
 *
 * Response parsing: the API returns SOAP/XML. We deliberately parse with
 * small targeted extractors (no XML dependency) because the response
 * shapes we consume are flat <return> blocks of scalar tags. Every parsed
 * result also carries nothing invented — unknown tags are simply absent.
 */

const ENDPOINT = process.env.FIVE9_ADMIN_WSDL_URL
  || 'https://api.five9.com/wsadmin/v13/AdminWebService';

const TIMEOUT_MS = parseInt(process.env.FIVE9_ADMIN_TIMEOUT_MS || '20000', 10);

function credsConfigured() {
  return Boolean(process.env.FIVE9_USERNAME && process.env.FIVE9_PASSWORD);
}

function authHeader() {
  const u = process.env.FIVE9_USERNAME || '';
  const p = process.env.FIVE9_PASSWORD || '';
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

// Escape user-supplied values before embedding in the SOAP body.
function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Decode the small set of XML entities Five9 emits in text nodes.
function decodeXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Low-level SOAP call. Returns the raw XML response body on success.
 * Throws with a readable message on HTTP errors, SOAP Faults, or timeout.
 */
export async function five9SoapCall(method, innerXml = '') {
  if (!credsConfigured()) {
    throw new Error('Five9 admin credentials not configured (FIVE9_USERNAME / FIVE9_PASSWORD Railway env vars)');
  }

  const envelope =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:ser="http://service.admin.ws.five9.com/">' +
    '<soapenv:Header/><soapenv:Body>' +
    `<ser:${method}>${innerXml}</ser:${method}>` +
    '</soapenv:Body></soapenv:Envelope>';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(),
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction': '""',
      },
      body: envelope,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? `Five9 admin API timeout after ${TIMEOUT_MS}ms (${method})`
      : `Five9 admin API network error (${method}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // SOAP Faults arrive with 200 or 500 depending on layer — check the body.
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(text);
  if (fault) {
    const msg = decodeXml(fault[1]).trim();
    // Make the two known failure modes self-diagnosing for the caller.
    if (/permission/i.test(msg)) {
      throw new Error(`Five9 ${method}: ${msg} — the API user needs the "User can use Administrator Services" role permission`);
    }
    throw new Error(`Five9 ${method} fault: ${msg}`);
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(`Five9 ${method}: HTTP 401 — bad FIVE9_USERNAME/FIVE9_PASSWORD`);
    }
    throw new Error(`Five9 ${method}: HTTP ${res.status}`);
  }
  return text;
}

// Extract every <return>...</return> block from a response.
function returnBlocks(xml) {
  const blocks = [];
  const re = /<return>([\s\S]*?)<\/return>/g;
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

// Extract a single scalar tag's text from a block ('' when absent/empty).
function tag(block, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeXml(m[1]).trim() : '';
}

/**
 * getCampaigns — full campaign inventory with live state.
 * Optional client-side filters: namePattern (substring, case-insensitive),
 * type ('OUTBOUND'|'INBOUND'), state ('RUNNING'|'NOT_RUNNING').
 */
export async function getCampaigns({ namePattern, type, state } = {}) {
  const xml = await five9SoapCall('getCampaigns');
  let campaigns = returnBlocks(xml).map(b => ({
    name: tag(b, 'name'),
    state: tag(b, 'state'),
    type: tag(b, 'type'),
    mode: tag(b, 'mode'),
    profileName: tag(b, 'profileName') || null,
    description: tag(b, 'description') || null,
    trainingMode: tag(b, 'trainingMode') === 'true',
  })).filter(c => c.name);

  if (namePattern) {
    const q = String(namePattern).toLowerCase();
    campaigns = campaigns.filter(c => c.name.toLowerCase().includes(q));
  }
  if (type) campaigns = campaigns.filter(c => c.type === String(type).toUpperCase());
  if (state) campaigns = campaigns.filter(c => c.state === String(state).toUpperCase());

  return {
    count: campaigns.length,
    running: campaigns.filter(c => c.state === 'RUNNING').length,
    not_running: campaigns.filter(c => c.state === 'NOT_RUNNING').length,
    campaigns,
  };
}

/**
 * getCampaignState — live state of one campaign by exact name.
 * Uses the dedicated SOAP method; falls back to a getCampaigns scan if the
 * domain rejects it (method availability varies by VCC version).
 */
export async function getCampaignState(campaignName) {
  const name = String(campaignName || '').trim();
  if (!name) throw new Error('campaignName is required');
  try {
    const xml = await five9SoapCall('getCampaignState', `<campaignName>${escapeXml(name)}</campaignName>`);
    const m = /<return>([\s\S]*?)<\/return>/.exec(xml);
    if (m) return { name, state: decodeXml(m[1]).trim(), source: 'getCampaignState' };
  } catch (err) {
    // Fall through to inventory scan unless it's a credentials/permission problem.
    if (/401|permission|credentials/i.test(err.message)) throw err;
  }
  const { campaigns } = await getCampaigns();
  const hit = campaigns.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    return { name, state: null, error: 'campaign_not_found', source: 'getCampaigns' };
  }
  return { ...hit, source: 'getCampaigns' };
}
