/**
 * Five9 Configuration Web Services (Admin SOAP API) client — src/five9-admin.js
 *
 * Phase A+B: READ coverage — campaign inventory/state (Phase A) plus full
 * Config-API reads (Phase B): campaign configs, profiles, lists,
 * dispositions, skills, users, DNC checks, and the async report trio.
 * Phase G (2026-08-13) adds the config surface: IVR scripts, DNIS inventory
 * and ownership map, prompts, and domain configuration.
 * No write methods live in this module — Phase C writes are in
 * src/five9/admin-writes.js and execute ONLY via the approve_action gate
 * (create_agent_action → approve_action → executor), never direct MCP calls.
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
 * small targeted extractors (no XML dependency). Flat <return> blocks of
 * scalar tags go through tag(); nested blocks (campaign configs, report
 * rows) go through the one recursive extractor parseXmlBlock(). Every
 * parsed result carries nothing invented — unknown tags are simply absent.
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
// Exported for the write-side modules under src/five9/.
export function escapeXml(s) {
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
 * assertResponseSize — opt-in response ceiling, exported so it is provable
 * offline. five9SoapCall applies it twice: on the declared content-length,
 * and on the actual body text.
 *
 * 2026-08-13 Phase G: getIVRScripts has no names-only mode — every match
 * carries its full xmlDefinition — so a wide namePattern can return a body
 * far larger than anything else this client fetches. The ceiling turns that
 * into a clear error instead of a 20s timeout or a memory spike.
 *
 * WHICH OF THE TWO CHECKS ACTUALLY FIRES, measured against the live domain
 * on 2026-08-13 rather than assumed: Five9 returns LARGE getIVRScripts
 * responses with `transfer-encoding: chunked` and **no content-length at
 * all** (small responses do carry it). A missing header parses to NaN, which
 * this function deliberately treats as "unknown, not oversize" — so on the
 * exact responses the ceiling exists for, the pre-read check is a no-op and
 * the body-length check is the one doing the work.
 *
 * The pre-read check is kept because it costs nothing and does fire on the
 * ops that declare a length, but do NOT read it as a guarantee that an
 * oversized body is never buffered. For a chunked response it is: fetch
 * completes → body is read in full → then we refuse. The protection is
 * against handing a huge string onward, not against receiving it.
 */
export function assertResponseSize(method, size, maxBytes) {
  if (!maxBytes || !Number.isFinite(size) || size <= maxBytes) return;
  const err = new Error(
    `Five9 ${method}: response is ${size} bytes, over the ${maxBytes}-byte ceiling — narrow the request (e.g. a tighter name_pattern)`,
  );
  err.five9Oversize = true;
  throw err;
}

/**
 * Low-level SOAP call. Returns the raw XML response body on success.
 * Throws with a readable message on HTTP errors, SOAP Faults, or timeout.
 *
 * opts.maxBytes — optional response ceiling (see assertResponseSize).
 * Omitted by every pre-Phase-G caller, so their behaviour is unchanged.
 */
export async function five9SoapCall(method, innerXml = '', { maxBytes } = {}) {
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
    // Best-effort early refusal: only fires when the server declared a
    // length. Five9 sends large getIVRScripts responses chunked with no
    // content-length, so for those this is a no-op — see assertResponseSize.
    assertResponseSize(method, parseInt(res.headers.get('content-length') || '', 10), maxBytes);
    text = await res.text();
    // The check that actually enforces the ceiling in practice.
    assertResponseSize(method, text.length, maxBytes);
  } catch (err) {
    // The ceiling is a deliberate refusal, not a transport failure — let it
    // through verbatim rather than relabelling it a network error.
    if (err?.five9Oversize) throw err;
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
// Exported for the write-side modules under src/five9/ and offline tests.
export function returnBlocks(xml) {
  const blocks = [];
  const re = /<return>([\s\S]*?)<\/return>/g;
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

// Extract a single scalar tag's text from a block ('' when absent/empty).
// Exported for the write-side modules under src/five9/ and offline tests.
export function tag(block, name) {
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

/* ------------------------------------------------------------------------ *
 * Phase B — nested-response parsing + full Config-API read wrappers.
 * ------------------------------------------------------------------------ */

// Guard against prototype-polluting tag names in externally-supplied XML.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assignParsed(obj, key, value) {
  if (UNSAFE_KEYS.has(key)) return;
  if (!(key in obj)) { obj[key] = value; return; }
  if (Array.isArray(obj[key])) obj[key].push(value);
  else obj[key] = [obj[key], value];
}

/**
 * parseXmlBlock — THE one recursive extractor for nested <return> blocks.
 * Element-only subset (no attributes consumed, no CDATA, no mixed content):
 * exactly what Five9 wsadmin emits. Repeated sibling tags collapse to
 * arrays; leaves are decoded trimmed strings; self-closing or xsi:nil
 * elements are null. Zero XML dependencies, linear depth-counted scan.
 */
export function parseXmlBlock(xml) {
  const s = String(xml ?? '');
  const out = {};
  const openRe = /<([A-Za-z_][\w.:-]*)((?:\s[^>]*)?)(\/?)>/g;
  let pos = 0;
  while (pos < s.length) {
    openRe.lastIndex = pos;
    const m = openRe.exec(s);
    if (!m) break;
    const [full, name, attrs, selfClose] = m;
    const openEnd = m.index + full.length;
    if (selfClose === '/' || /xsi:nil\s*=\s*"true"/.test(attrs)) {
      assignParsed(out, name, null);
      pos = openEnd;
      continue;
    }
    // Find the matching close tag, depth-counting same-named nested tags.
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pairRe = new RegExp(`<${esc}(?:\\s[^>]*)?(/?)>|</${esc}>`, 'g');
    pairRe.lastIndex = openEnd;
    let depth = 1, closeStart = -1, closeEnd = -1, pm;
    while ((pm = pairRe.exec(s)) !== null) {
      if (pm[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) { closeStart = pm.index; closeEnd = pairRe.lastIndex; break; }
      } else if (pm[1] !== '/') {
        depth += 1;
      }
    }
    if (closeStart < 0) break; // malformed tail — keep what parsed cleanly
    const inner = s.slice(openEnd, closeStart);
    const value = /<[A-Za-z_]/.test(inner)
      ? parseXmlBlock(inner)
      : decodeXml(inner).trim();
    assignParsed(out, name, value);
    pos = closeEnd;
  }
  return out;
}

// Normalize a maybe-single/maybe-array/maybe-missing parsed value to an array.
export function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// Five9 timer{days,hours,minutes,seconds} (parsed strings) -> total seconds.
export function timerToSeconds(t) {
  if (!t || typeof t !== 'object') return null;
  const n = (x) => { const v = parseInt(x, 10); return Number.isFinite(v) ? v : 0; };
  return n(t.days) * 86400 + n(t.hours) * 3600 + n(t.minutes) * 60 + n(t.seconds);
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/**
 * getOutboundCampaign — full outbound campaign config plus attached lists
 * (lists come from the separate getListsForCampaign method, best-effort).
 */
export async function getOutboundCampaign(campaignName) {
  const name = String(campaignName || '').trim();
  if (!name) throw new Error('campaignName is required');
  const xml = await five9SoapCall('getOutboundCampaign', `<campaignName>${escapeXml(name)}</campaignName>`);
  const block = returnBlocks(xml)[0];
  if (!block) return { name, error: 'campaign_not_found' };
  const raw = parseXmlBlock(block);
  let lists = null; // null = lookup failed; [] = genuinely no lists attached
  try {
    const lxml = await five9SoapCall('getListsForCampaign', `<campaignName>${escapeXml(name)}</campaignName>`);
    lists = returnBlocks(lxml).map(parseXmlBlock).map(l => ({
      name: l.listName ?? null,
      priority: num(l.priority),
      dialingPriority: num(l.dialingPriority),
      dialingRatio: num(l.dialingRatio),
    }));
  } catch (err) {
    console.warn(`[FIVE9] getListsForCampaign(${name}) failed: ${err.message}`);
  }
  return {
    name: raw.name || name,
    type: raw.type || null,
    state: raw.state || null,
    mode: raw.mode || null,
    profileName: raw.profileName || null,
    description: raw.description || null,
    trainingMode: raw.trainingMode === 'true',
    dialingMode: raw.dialingMode || null,
    dialingRatio: num(raw.dialingRatio),
    callsAgentRatio: num(raw.callsAgentRatio),
    maxDroppedCallsPercentage: num(raw.maxDroppedCallsPercentage),
    maxQueueTimeSeconds: timerToSeconds(raw.maxQueueTime),
    actionOnQueueExpiration: raw.actionOnQueueExpiration ?? null,
    monitorDroppedCalls: raw.monitorDroppedCalls === 'true',
    lists,
    raw,
  };
}

/** getInboundCampaign — full inbound campaign config (normalized + raw). */
export async function getInboundCampaign(campaignName) {
  const name = String(campaignName || '').trim();
  if (!name) throw new Error('campaignName is required');
  const xml = await five9SoapCall('getInboundCampaign', `<campaignName>${escapeXml(name)}</campaignName>`);
  const block = returnBlocks(xml)[0];
  if (!block) return { name, error: 'campaign_not_found' };
  const raw = parseXmlBlock(block);
  return {
    name: raw.name || name,
    type: raw.type || null,
    state: raw.state || null,
    mode: raw.mode || null,
    profileName: raw.profileName || null,
    description: raw.description || null,
    maxNumOfLines: num(raw.maxNumOfLines),
    raw,
  };
}

/** getCampaignProfiles — profile inventory with dial settings (retries/ANI/schedule). */
export async function getCampaignProfiles() {
  const xml = await five9SoapCall('getCampaignProfiles');
  const profiles = returnBlocks(xml).map(parseXmlBlock).map(p => ({
    name: p.name || null,
    description: p.description || null,
    ANI: p.ANI ?? null,
    numberOfAttempts: num(p.numberOfAttempts),
    dialingTimeout: num(p.dialingTimeout),
    initialCallPriority: num(p.initialCallPriority),
    maxCharges: num(p.maxCharges),
    dialingSchedule: p.dialingSchedule ?? null,
    raw: p,
  }));
  return { count: profiles.length, profiles };
}

/** getListsInfo — every dialing list with its record count. */
export async function getListsInfo() {
  const xml = await five9SoapCall('getListsInfo');
  const lists = returnBlocks(xml).map(parseXmlBlock)
    .map(l => ({ name: l.name || null, size: num(l.size) }))
    .filter(l => l.name);
  return { count: lists.length, lists };
}

/** getDispositions — full disposition inventory (nested typeParameters kept raw). */
export async function getDispositions() {
  const xml = await five9SoapCall('getDispositions');
  const dispositions = returnBlocks(xml).map(parseXmlBlock);
  return { count: dispositions.length, dispositions };
}

/** getSkills — skill inventory. */
export async function getSkills() {
  const xml = await five9SoapCall('getSkills');
  const skills = returnBlocks(xml).map(parseXmlBlock).map(s => ({
    id: num(s.id),
    name: s.name || null,
    description: s.description || null,
    routeVoiceMails: s.routeVoiceMails === 'true',
  }));
  return { count: skills.length, skills };
}

/** getUsersGeneralInfo — user inventory (password field stripped defensively). */
export async function getUsersGeneralInfo(pattern = '.*') {
  const p = String(pattern || '.*');
  const xml = await five9SoapCall('getUsersGeneralInfo', `<userNamePattern>${escapeXml(p)}</userNamePattern>`);
  const users = returnBlocks(xml).map(parseXmlBlock).map(u => {
    const { password, ...rest } = u; // never surface even a masked credential field
    return rest;
  });
  return { count: users.length, users };
}

/**
 * checkDncForNumbers — the response lists ONLY numbers that ARE on the DNC;
 * we diff client-side so callers get both sides explicitly.
 */
export async function checkDncForNumbers(numbers) {
  const list = (Array.isArray(numbers) ? numbers : [numbers])
    .map(n => String(n ?? '').trim()).filter(Boolean);
  if (!list.length) throw new Error('numbers[] is required');
  const inner = list.map(n => `<numbers>${escapeXml(n)}</numbers>`).join('');
  const xml = await five9SoapCall('checkDncForNumbers', inner);
  const on_dnc = returnBlocks(xml).map(b => decodeXml(b).trim()).filter(Boolean);
  const onSet = new Set(on_dnc);
  return { checked: list.length, on_dnc, not_on_dnc: list.filter(n => !onSet.has(n)) };
}

/* ------------------------------------------------------------------------ *
 * Phase G (2026-08-13) — config-surface reads: IVR scripts, DNIS inventory,
 * prompts, and domain configuration.
 *
 * FETCH NOTE. Every element order and response wrapper below was read from
 * the live v13 schema on 2026-08-13 —
 *   https://api.five9.com/wsadmin/v13/AdminWebService?wsdl&user=x
 *   HTTP 200, 961,700 bytes, 20,205 lines
 * — using the flexible DOTALL pattern `<xs:complexType[^>]*\bname="X"` from
 * the Phase D FETCH NOTE, never the anchored one, and never read-response
 * order. Full verbatim extracts: docs/five9/phase-g-wsdl-v13.md
 *
 * Three findings drive the shapes here, and each is a silent-failure trap:
 *
 *  1. getPrompts takes NO parameters (`<xs:sequence/>`) and its response
 *     wraps results in <prompts>, NOT <return>. returnBlocks() finds nothing
 *     on this one op — hence promptBlocks() below. Name filtering is
 *     therefore client-side; there is no server-side pattern to pass.
 *
 *  2. getIVRScripts always returns the full xmlDefinition for every match.
 *     There is no names-only mode, so `includeDefinition: false` still pays
 *     the full download and only trims what we hand back. namePattern IS a
 *     Five9-side regex, so narrowing it is the only real lever on size.
 *
 *  3. getDNISList/getCampaignDNISList return bare strings in <return>, not
 *     structs — map them with decodeXml, not parseXmlBlock.
 * ------------------------------------------------------------------------ */

// Ceiling for the one op that can return an unbounded payload. A module
// constant on purpose: this phase adds no env vars.
export const MAX_IVR_RESPONSE_BYTES = 4_000_000;

// Above this many matches, returning script XML is refused outright.
export const MAX_IVR_DEFINITIONS = 3;

// Serial fan-out spacing for the DNIS map. Matches the deliberate house
// precedent in src/jobs/five9-config-snapshot.js (FIVE9_SNAPSHOT_DELAY_MS,
// 250ms): concurrent Five9 admin session limits are undisclosed, so we walk
// campaigns one at a time rather than probing them. See the note in
// src/five9/admin-writes.js.
const DNIS_MAP_DELAY_MS = 250;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * assertIvrDefinitionLimit — pure guard, exported for offline tests.
 * Script XML is large; asking for every definition at once is almost always
 * a mistake, so it is refused rather than truncated.
 */
export function assertIvrDefinitionLimit(matchCount, namePattern, limit = MAX_IVR_DEFINITIONS) {
  if (matchCount > limit) {
    throw new Error(
      `REFUSED: include_definition matched ${matchCount} scripts (ceiling ${limit}) for name_pattern "${namePattern}" — IVR script XML is large; narrow the pattern to ${limit} or fewer scripts`,
    );
  }
}

/**
 * promptBlocks — the getPrompts-only extractor. Its response element is
 * <prompts>, so returnBlocks() (which looks for <return>) returns [] here.
 * Exported so that difference stays pinned by a test.
 */
export function promptBlocks(xml) {
  const blocks = [];
  const re = /<prompts>([\s\S]*?)<\/prompts>/g;
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * getIVRScripts — IVR script inventory. namePattern is a Five9-side regex
 * (default ".*" = every script). Definitions are stripped unless asked for;
 * see finding 2 above for why that does not reduce the download.
 */
export async function getIVRScripts({ namePattern = '.*', includeDefinition = false } = {}) {
  const pattern = String(namePattern || '.*');
  const xml = await five9SoapCall(
    'getIVRScripts',
    `<namePattern>${escapeXml(pattern)}</namePattern>`,
    { maxBytes: MAX_IVR_RESPONSE_BYTES },
  );
  const parsed = returnBlocks(xml).map(parseXmlBlock).filter(s => s.name);
  if (includeDefinition) assertIvrDefinitionLimit(parsed.length, pattern);
  const scripts = parsed.map(s => ({
    name: s.name,
    description: s.description ?? null,
    ...(includeDefinition ? { xmlDefinition: s.xmlDefinition ?? null } : {}),
  }));
  return {
    count: scripts.length,
    name_pattern: pattern,
    includes_definition: includeDefinition,
    scripts,
  };
}

/** getDNISList — every DNIS in the domain, or only the unassigned spares. */
export async function getDNISList({ selectUnassigned = false } = {}) {
  const xml = await five9SoapCall(
    'getDNISList',
    `<selectUnassigned>${selectUnassigned ? 'true' : 'false'}</selectUnassigned>`,
  );
  const dnis = returnBlocks(xml).map(b => decodeXml(b).trim()).filter(Boolean);
  return { count: dnis.length, unassigned_only: selectUnassigned, dnis };
}

/** getCampaignDNISList — the DNIS assigned to one campaign. */
export async function getCampaignDNISList(campaignName) {
  const name = String(campaignName || '').trim();
  if (!name) throw new Error('campaignName is required');
  const xml = await five9SoapCall('getCampaignDNISList', `<campaignName>${escapeXml(name)}</campaignName>`);
  const dnis = returnBlocks(xml).map(b => decodeXml(b).trim()).filter(Boolean);
  return { campaign: name, count: dnis.length, dnis };
}

/* DNIS map cache — process-lifetime, with fetched_at surfaced on every read
 * so a stale answer is always self-dating, plus an explicit refresh path.
 * Mirrors the src/entry-source-map.js cache shape (invalidator + test seam).
 * A partial map is deliberately NOT cached: a campaign that errored would
 * otherwise read as "has no DNIS" for the life of the process. */
let _dnisMapCache = null;

export function invalidateDnisMap() { _dnisMapCache = null; }

export function __setDnisMapCacheForTest(value) { _dnisMapCache = value; }

/**
 * getDnisMap — which campaign owns each number, plus the unassigned spares.
 * Walks every INBOUND campaign serially (see DNIS_MAP_DELAY_MS). The
 * unassigned side comes from Five9's own selectUnassigned rather than being
 * derived by subtraction, so the two are independent readings.
 */
export async function getDnisMap({ refresh = false } = {}) {
  if (_dnisMapCache && !refresh) return _dnisMapCache;

  const { campaigns } = await getCampaigns({ type: 'INBOUND' });
  const assignments = {};
  const by_campaign = {};
  const errors = [];

  for (const [i, campaign] of campaigns.entries()) {
    if (i > 0) await sleep(DNIS_MAP_DELAY_MS);
    try {
      const { dnis } = await getCampaignDNISList(campaign.name);
      by_campaign[campaign.name] = dnis;
      for (const number of dnis) assignments[number] = campaign.name;
    } catch (err) {
      errors.push({ campaign: campaign.name, error: err.message });
    }
  }

  if (campaigns.length) await sleep(DNIS_MAP_DELAY_MS);
  const spare = await getDNISList({ selectUnassigned: true });

  const result = {
    fetched_at: new Date().toISOString(),
    inbound_campaigns: campaigns.length,
    assigned_count: Object.keys(assignments).length,
    assignments,
    by_campaign,
    unassigned_count: spare.count,
    unassigned: spare.dnis,
    ...(errors.length ? { partial: true, errors } : {}),
  };

  if (!errors.length) _dnisMapCache = result;
  return result;
}

/** getPrompts — full prompt inventory. Takes no arguments; see finding 1. */
export async function getPrompts() {
  const xml = await five9SoapCall('getPrompts');
  const prompts = promptBlocks(xml).map(parseXmlBlock).map(p => ({
    name: p.name || null,
    description: p.description ?? null,
    type: p.type || null,
    languages: asArray(p.languages),
  })).filter(p => p.name);
  return { count: prompts.length, prompts };
}

/**
 * getVCCConfiguration — domain-level configuration. Surfaced because it is
 * the only API view of recording/transcript servers and the domain dialing
 * rules; modifyVCCConfiguration exists but is deliberately not implemented.
 */
export async function getVCCConfiguration() {
  const xml = await five9SoapCall('getVCCConfiguration');
  const block = returnBlocks(xml)[0];
  if (!block) return { error: 'vcc_configuration_unavailable' };
  const raw = parseXmlBlock(block);
  return {
    domainId: raw.domainId ?? null,
    domainName: raw.domainName ?? null,
    recordingsServer: raw.recordingsServer ?? null,
    reportsServer: raw.reportsServer ?? null,
    transcriptsServer: raw.transcriptsServer ?? null,
    campaignsSettings: raw.campaignsSettings ?? null,
    miscOptions: raw.miscOptions ?? null,
    stateDialingRule: raw.stateDialingRule ?? null,
    timeZoneAssignment: raw.timeZoneAssignment ?? null,
    raw,
  };
}

/* ---- Report trio (async run → poll → fetch) ---------------------------- */

/**
 * buildReportCriteriaXml — pure builder, exported for offline tests.
 * WSDL sequence order inside reportTimeCriteria is <end> BEFORE <start>.
 */
export function buildReportCriteriaXml({ startIso, endIso } = {}) {
  if (!startIso && !endIso) return '';
  const time =
    (endIso ? `<end>${escapeXml(endIso)}</end>` : '') +
    (startIso ? `<start>${escapeXml(startIso)}</start>` : '');
  return `<criteria><time>${time}</time></criteria>`;
}

/** runReport — submits the run; returns the polling identifier. */
export async function runReport(folderName, reportName, criteriaXml = '') {
  const folder = String(folderName || '').trim();
  const report = String(reportName || '').trim();
  if (!folder || !report) throw new Error('folderName and reportName are required');
  const xml = await five9SoapCall('runReport',
    `<folderName>${escapeXml(folder)}</folderName><reportName>${escapeXml(report)}</reportName>${criteriaXml}`);
  const identifier = returnBlocks(xml).map(b => decodeXml(b).trim())[0] || '';
  if (!identifier) throw new Error('Five9 runReport: no report identifier returned');
  return { identifier };
}

/** isReportRunning — true while the run is still executing (server-side wait ≤ timeoutSec). */
export async function isReportRunning(identifier, timeoutSec = 5) {
  const id = String(identifier || '').trim();
  if (!id) throw new Error('identifier is required');
  const xml = await five9SoapCall('isReportRunning',
    `<identifier>${escapeXml(id)}</identifier><timeout>${Math.max(0, parseInt(timeoutSec, 10) || 0)}</timeout>`);
  return returnBlocks(xml).map(b => decodeXml(b).trim())[0] === 'true';
}

/** getReportResult — normalized { columns, rows } from header/records/values/data. */
export async function getReportResult(identifier) {
  const id = String(identifier || '').trim();
  if (!id) throw new Error('identifier is required');
  const xml = await five9SoapCall('getReportResult', `<identifier>${escapeXml(id)}</identifier>`);
  const block = returnBlocks(xml)[0];
  if (!block) return { identifier: id, columns: [], rows: [] };
  const raw = parseXmlBlock(block);
  const columns = asArray(raw.header?.values?.data);
  const rows = asArray(raw.records).map(r => asArray(r?.values?.data));
  return { identifier: id, columns, rows };
}

/* ------------------------------------------------------------------------ *
 * Async IMPORT job triad (2026-08-12 Phase F) — the list-import sibling of
 * the report triad above. asyncAddRecordsToList / asyncDeleteRecordsFromList
 * return a job handle rather than a result, and these are how you follow it.
 *
 * Read-only, so they live here with the rest of the Config-API readers; the
 * gated write that submits the job lives in src/five9/admin-writes.js.
 *
 * WSDL-derived 2026-08-12 (api.five9.com/wsadmin/v13/AdminWebService?wsdl).
 * The identifier wrapper is the subtle part and does NOT match the report
 * ops: reports take a FLAT <identifier> string plus <timeout>, imports take a
 * NESTED tns:importIdentifier (a complexType whose only child is itself named
 * `identifier`) plus <waitTime>:
 *
 *   <xs:complexType name="isImportRunning"><xs:sequence>
 *     <xs:element minOccurs="0" name="identifier" type="tns:importIdentifier"/>
 *     <xs:element minOccurs="0" name="waitTime" type="xs:long"/>
 *   <xs:complexType name="importIdentifier"><xs:sequence>
 *     <xs:element minOccurs="0" name="identifier" type="xs:string"/>
 *
 * Hence the double nesting below. Flattening it is an unmarshalling fault.
 * ------------------------------------------------------------------------ */

/** tns:importIdentifier wrapper (+ optional waitTime). Exported for tests. */
export function buildImportIdentifierXml(identifier, { waitTimeSec } = {}) {
  const id = String(identifier || '').trim();
  if (!id) throw new Error('identifier is required');
  const wait = Number.isFinite(Number(waitTimeSec))
    ? `<waitTime>${Math.max(0, Math.floor(Number(waitTimeSec)))}</waitTime>`
    : '';
  return `<identifier><identifier>${escapeXml(id)}</identifier></identifier>${wait}`;
}

/** isImportRunning — true while the import is still executing (server-side wait ≤ waitTimeSec). */
export async function isImportRunning(identifier, waitTimeSec = 5) {
  const xml = await five9SoapCall('isImportRunning',
    buildImportIdentifierXml(identifier, { waitTimeSec }));
  return returnBlocks(xml).map(b => decodeXml(b).trim())[0] === 'true';
}

/**
 * getListImportResult — normalized tns:listImportResult. `success`,
 * `uploadErrorsCount` and `failureMessage` come from the basicImportResult
 * base; `listRecordsDeleted` is the authoritative count of what the job
 * actually removed, and is what a bulk delete verifies against (a list-size
 * delta alone is noisy — these lists take an incremental feed and repopulate
 * at 6 AM ET). `raw` is kept so the audit event can carry importTroubles etc.
 */
export async function getListImportResult(identifier) {
  const xml = await five9SoapCall('getListImportResult',
    buildImportIdentifierXml(identifier));
  const block = returnBlocks(xml)[0];
  if (!block) return { identifier: String(identifier || ''), found: false, raw: null };
  const raw = parseXmlBlock(block);
  return {
    identifier: String(identifier || ''),
    found: true,
    success: String(raw.success ?? '') === 'true',
    listName: raw.listName || null,
    listRecordsDeleted: num(raw.listRecordsDeleted),
    listRecordsInserted: num(raw.listRecordsInserted),
    crmRecordsInserted: num(raw.crmRecordsInserted),
    crmRecordsUpdated: num(raw.crmRecordsUpdated),
    uploadErrorsCount: num(raw.uploadErrorsCount),
    uploadDuplicatesCount: num(raw.uploadDuplicatesCount),
    failureMessage: raw.failureMessage || null,
    importTroubles: asArray(raw.importTroubles),
    raw,
  };
}

/**
 * runReportAndWait — submit + poll ≤ maxWaitMs (default 55s: under the 60s
 * doctrine cap and under typical MCP client timeouts). On timeout returns
 * { identifier, done:false } so the caller resumes via getReportResult.
 */
export async function runReportAndWait({ folder, name, startIso, endIso, pollMs = 5000, maxWaitMs = 55000 } = {}) {
  const { identifier } = await runReport(folder, name, buildReportCriteriaXml({ startIso, endIso }));
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  for (;;) {
    if (!(await isReportRunning(identifier))) break;
    if (Date.now() >= deadline) {
      return { identifier, done: false, timed_out_after_ms: maxWaitMs };
    }
    const napMs = Math.min(pollMs, Math.max(250, deadline - Date.now()));
    await new Promise(r => setTimeout(r, napMs));
  }
  const result = await getReportResult(identifier);
  return { done: true, ...result };
}
