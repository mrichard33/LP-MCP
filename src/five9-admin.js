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
 * ── THE AUTH BREAKER ────────────────────────────────────────────────────────
 *
 * Five9 LOCKS the API account after repeated failed logins, and every call
 * here carries HTTP Basic credentials — so one wrong password does not fail
 * once, it fails once PER CALL.
 *
 * 2026-08-25: the account was locked. The amplifier was
 * jobs/five9-config-snapshot.js, which makes one SOAP read per campaign plus
 * profiles, lists, skills, dispositions, users and VCC — ~37 sequential calls,
 * each wrapped in an attempt() that records the error and CONTINUES. A single
 * stale credential therefore became ~37 failed logins within seconds, which is
 * precisely how an account gets locked. (scripts/test-five9-admin-reads.js was
 * spending live attempts too; fixed separately.)
 *
 * So the breaker: the FIRST auth-shaped rejection trips it, and every
 * subsequent call fails immediately WITHOUT touching the network. One bad
 * password now costs exactly one failed login, not thirty-seven.
 *
 * It does NOT auto-reset on a timer. A timer would re-arm the very loop this
 * exists to stop — the snapshot would retry tomorrow and spend another burst.
 * The credential has to actually change, and changing it in Railway restarts
 * the service, which clears this by construction. resetFive9AuthBreaker() is
 * exported for an operator who has just fixed the password and wants the
 * current process to pick it up without a redeploy.
 *
 * Only AUTH failures trip it. A timeout, a 500 or an oversize refusal are not
 * credential problems and must not disable the integration.
 */
let authBreaker = null;

/** Does this rejection mean "your credentials are wrong or locked out"? */
export function isFive9AuthFailure(message) {
  return /user name or password|account is locked|invalid (?:login|credentials)|not authorized to (?:log ?in|use)|authentication fail/i
    .test(String(message || ''));
}

/** Current breaker state, for the health view and the admin tools. */
export function five9AuthBreakerStatus() {
  return authBreaker
    ? { open: true, since: authBreaker.at, reason: authBreaker.message }
    : { open: false };
}

/**
 * Re-arm Five9 calls after the credential has been corrected. Deliberately
 * manual — see above.
 */
export function resetFive9AuthBreaker() {
  const was = authBreaker;
  authBreaker = null;
  if (was) console.warn(`[Five9] auth breaker RESET (was open since ${was.at})`);
  return { reset: Boolean(was), was };
}

function tripAuthBreaker(message) {
  if (authBreaker) return;
  authBreaker = { at: new Date().toISOString(), message: String(message).slice(0, 300) };
  console.error(
    `[Five9] AUTH BREAKER OPEN — refusing all further Five9 admin calls to protect the account`
    + ` from lockout. Fix FIVE9_USERNAME / FIVE9_PASSWORD, then redeploy (or call`
    + ` resetFive9AuthBreaker). Cause: ${authBreaker.message}`,
  );
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
  if (authBreaker) {
    // No fetch. This is the whole point: the 2nd..37th call of a snapshot run
    // must not reach Five9 once the 1st has already been told the credential
    // is bad.
    throw new Error(
      `Five9 ${method}: auth breaker OPEN since ${authBreaker.at} — not retrying to avoid locking the account.`
      + ` Fix FIVE9_USERNAME / FIVE9_PASSWORD and redeploy. Original cause: ${authBreaker.message}`,
    );
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
    // A credential rejection arrives as a SOAP Fault with 200, not a 401 —
    // which is why the 401 branch below never caught the 2026-08-25 lockout.
    if (isFive9AuthFailure(msg)) tripAuthBreaker(`${method}: ${msg}`);
    throw new Error(`Five9 ${method} fault: ${msg}`);
  }
  if (!res.ok) {
    if (res.status === 401) {
      tripAuthBreaker(`${method}: HTTP 401`);
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

/**
 * getDNISList — Five9's selectUnassigned is a FILTER, not an include-all flag.
 *
 * selectUnassigned=false returns the ASSIGNED numbers only; it does NOT return
 * every DNIS in the domain, which is what this docstring used to claim. The two
 * modes return disjoint sets and you need both to see the whole inventory.
 *
 * Measured against the live domain 2026-08-14:
 *   selectUnassigned=false → 266 numbers, including 2394930774 (assigned to
 *                            "Canvass Confirmation - Inbound")
 *   selectUnassigned=true  →   2 numbers, 9548337877 and 5995670260,
 *                            NEITHER of which appears in the 266
 *
 * The practical trap: reading the no-argument list as "every number we own"
 * silently omits the spares, so a number can look absent from the domain when
 * it is merely unassigned. Union the two calls, or use getDnisMap, which reads
 * the assigned side by walking campaigns and the spare side from
 * selectUnassigned=true — independent readings, neither derived by subtraction.
 */
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

export const REDACTED = '[REDACTED]';

/**
 * redactPasswords — replace every non-empty `password` value with [REDACTED],
 * anywhere in the structure. Pure; never mutates its input.
 *
 * WHY A RECURSIVE WALK AND NOT THREE NAMED FIELDS. getVCCConfiguration returns
 * each server block TWICE: once promoted to the top level, and again inside
 * `raw`, which is the whole parsed SOAP block. A redaction that only walked
 * the three named top-level keys would ship as fixed and still hand over both
 * live passwords through raw.recordingsServer.password. Walking the structure
 * also covers any fourth copy Five9 adds later without anyone re-deriving this.
 *
 * EMPTY STRINGS ARE LEFT ALONE, deliberately. Blanket-redacting would turn
 * reportsServer.password ("" — Reece runs no Reports Server, by design) into
 * "[REDACTED]", which reads as "a password is set here" and is simply false.
 * Leaving "" intact keeps the distinction the caller actually needs: an empty
 * value means unset, [REDACTED] means set-but-not-shown. It also keeps the
 * config-snapshot change log able to catch a blank→configured transition,
 * which is a real posture change worth seeing. The cost — a password ROTATION
 * is invisible, since both sides are [REDACTED] — is accepted: storing the
 * credential to make rotations diffable is the thing this exists to prevent.
 */
function redactPasswordValue(v) {
  if (typeof v === 'string') return v === '' ? '' : REDACTED;
  // parseXmlBlock collapses repeated sibling elements into an array, so a
  // <password> that ever appeared twice in one block would arrive as
  // ['secret', ...] and walk straight past a string-only check.
  if (Array.isArray(v)) return v.map(redactPasswordValue);
  // Anything else (null, a number, a nested object) is left to the ordinary
  // walk rather than coerced: a non-string here means Five9 changed the shape,
  // and flattening it to "[REDACTED]" would hide that.
  return redactPasswords(v);
}

export function redactPasswords(value) {
  if (Array.isArray(value)) return value.map(redactPasswords);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'password' ? redactPasswordValue(v) : redactPasswords(v);
  }
  return out;
}

/**
 * getVCCConfiguration — domain-level configuration. Surfaced because it is
 * the only API view of recording/transcript servers and the domain dialing
 * rules; modifyVCCConfiguration exists but is deliberately not implemented.
 *
 * Passwords are redacted HERE, at the source, rather than at each call site.
 * Before 2026-08-21 this returned recordingsServer and transcriptsServer
 * passwords in cleartext to every caller — the MCP read tool put both into
 * any transcript that asked for domain config. Redacting in the reader means
 * a future consumer is safe by default instead of safe by remembering.
 * Nothing needs the real value: the one credential the fleet actually uses
 * (the nas1 recordings SFTP) is supplied by CI_SFTP_PASSWORD, not read back
 * from here — see src/ci/config.js.
 */
export async function getVCCConfiguration() {
  const xml = await five9SoapCall('getVCCConfiguration');
  const block = returnBlocks(xml)[0];
  if (!block) return { error: 'vcc_configuration_unavailable' };
  const raw = redactPasswords(parseXmlBlock(block));
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

/* ====================================================================== *
 * Phase H PR4 (2026-08-21) — config-read surface.
 *
 * Every reader below is *name pattern in, list out* and is reached through
 * ONE MCP tool (five9_get_config), not one tool per operation. LP-MCP was
 * already at 112 tools before this tranche and tool-selection accuracy
 * degrades as that list grows — a cost paid on every LP-MCP call, including
 * LP sync and GHL work that never touches Five9. Thirteen operations behind
 * one `entity_type` discriminator is the whole point; see
 * src/tools/five9-tools.js.
 *
 * The SINGULAR variants of these (getSkill, getDisposition, getUserInfo,
 * getUserGeneralInfo, getSkillInfo, getAgentGroup) are deliberately NOT
 * wrapped. Each takes an exact name where the plural takes a pattern, and
 * exactNamePattern() already converts a name into an anchored, escaped
 * pattern — so a singular wrapper would be zero new capability at the cost
 * of a tool slot. Recorded as `skip` in OP_CLASSIFICATION.
 * ====================================================================== */

// Every pattern reader here takes a Five9-side REGEX, not a substring. An
// omitted pattern means ".*" (list everything), which is what each of these
// operations does with an empty argument anyway.
const patternXml = (field, value) =>
  `<${field}>${escapeXml(String(value ?? '.*'))}</${field}>`;

/**
 * getWebConnectors — agent-desktop web connectors.
 *
 * SECURITY-RELEVANT READ. A connector posts live call and contact data from
 * the agent desktop to whatever URL it names, so this reader is also the
 * read-before-write for five9_modify_web_connector and the evidence
 * Guardrail 13 checks. The four keyValuePair blocks (constants,
 * postConstants, variables, postVariables) are normalized to arrays because
 * a SECOND destination can hide in any of them — a check that reads only
 * `url` is not a check.
 */
export async function getWebConnectors({ namePattern } = {}) {
  const xml = await five9SoapCall('getWebConnectors', patternXml('namePattern', namePattern));
  const connectors = returnBlocks(xml).map(parseXmlBlock).map(c => ({
    name: c.name || null,
    description: c.description || null,
    url: c.url || null,
    trigger: c.trigger || null,
    postMethod: c.postMethod === 'true',
    executeInBrowser: c.executeInBrowser === 'true',
    addWorksheet: c.addWorksheet === 'true',
    agentApplication: c.agentApplication || null,
    ctiWebServices: c.ctiWebServices || null,
    startPageText: c.startPageText || null,
    clearTriggerDispositions: c.clearTriggerDispositions === 'true',
    triggerDispositions: asArray(c.triggerDispositions),
    constants: asArray(c.constants),
    postConstants: asArray(c.postConstants),
    variables: asArray(c.variables),
    postVariables: asArray(c.postVariables),
    raw: c,
  })).filter(c => c.name);
  return { count: connectors.length, connectors };
}

/** getWebConnector — exact-name lookup built on the pattern reader. */
export async function getWebConnector(name) {
  const target = String(name || '').trim();
  if (!target) return null;
  const { connectors } = await getWebConnectors({ namePattern: exactNamePatternRegex(target) });
  return connectors.find(c => c.name.toLowerCase() === target.toLowerCase()) || null;
}

/**
 * exactNamePatternRegex — anchored, escaped pattern for an exact name.
 * Duplicated deliberately from admin-writes.exactUserPattern rather than
 * imported: five9-admin.js is the LOWER layer (admin-writes imports from
 * here, not the reverse), and an import back up would be a cycle.
 */
export function exactNamePatternRegex(name) {
  return `^${String(name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/** getSkillsInfo — skills with their full info block (pattern reader). */
export async function getSkillsInfo({ namePattern } = {}) {
  const xml = await five9SoapCall('getSkillsInfo', patternXml('skillNamePattern', namePattern));
  const skills = returnBlocks(xml).map(parseXmlBlock);
  return { count: skills.length, skills };
}

/** getAgentGroups — agent group inventory (pattern reader). */
export async function getAgentGroups({ namePattern } = {}) {
  const xml = await five9SoapCall('getAgentGroups', patternXml('groupNamePattern', namePattern));
  const groups = returnBlocks(xml).map(parseXmlBlock);
  return { count: groups.length, groups };
}

/**
 * getCallVariables — call variables, optionally scoped to one group.
 * groupName is a SECOND filter, not a pattern: Five9 takes it as an exact
 * group name and omits it entirely when absent.
 */
export async function getCallVariables({ namePattern, groupName } = {}) {
  const group = String(groupName ?? '').trim();
  const xml = await five9SoapCall('getCallVariables',
    patternXml('namePattern', namePattern) +
    (group ? `<groupName>${escapeXml(group)}</groupName>` : ''));
  const variables = returnBlocks(xml).map(parseXmlBlock);
  return { count: variables.length, variables };
}

/** getCallVariableGroups — call variable group inventory (pattern reader). */
export async function getCallVariableGroups({ namePattern } = {}) {
  const xml = await five9SoapCall('getCallVariableGroups', patternXml('namePattern', namePattern));
  const groups = returnBlocks(xml).map(parseXmlBlock);
  return { count: groups.length, groups };
}

/** getDialingRules — dialing rule inventory (pattern reader). */
export async function getDialingRules({ namePattern } = {}) {
  const xml = await five9SoapCall('getDialingRules', patternXml('namePattern', namePattern));
  const rules = returnBlocks(xml).map(parseXmlBlock);
  return { count: rules.length, rules };
}

/** getContactFields — the Five9 contact DB schema (pattern reader). */
export async function getContactFields({ namePattern } = {}) {
  const xml = await five9SoapCall('getContactFields', patternXml('namePattern', namePattern));
  const fields = returnBlocks(xml).map(parseXmlBlock);
  return { count: fields.length, fields };
}

/**
 * getReasonCodeByType — reason codes. `reasonCodeName` is a pattern;
 * `type` (NOT_READY / LOGOUT) is an optional enum filter, omitted when
 * absent so the call returns every type.
 */
export async function getReasonCodeByType({ namePattern, type } = {}) {
  const t = String(type ?? '').trim();
  const xml = await five9SoapCall('getReasonCodeByType',
    patternXml('reasonCodeName', namePattern) +
    (t ? `<type>${escapeXml(t)}</type>` : ''));
  const codes = returnBlocks(xml).map(parseXmlBlock);
  return { count: codes.length, codes };
}

/**
 * getCampaignStrategies — dial-pacing strategies for ONE campaign.
 * Takes an EXACT campaign name, not a pattern (schema: campaignName).
 */
export async function getCampaignStrategies(campaignName) {
  const name = String(campaignName || '').trim();
  if (!name) throw new Error('campaign_name is required for entity_type "campaign_strategy"');
  const xml = await five9SoapCall('getCampaignStrategies', `<campaignName>${escapeXml(name)}</campaignName>`);
  const strategies = returnBlocks(xml).map(parseXmlBlock);
  return { campaignName: name, count: strategies.length, strategies };
}

/** getCampaignProfileFilter — ONE profile's record filter (exact profileName). */
export async function getCampaignProfileFilter(profileName) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('profile_name is required for entity_type "campaign_profile_filter"');
  const xml = await five9SoapCall('getCampaignProfileFilter', `<profileName>${escapeXml(name)}</profileName>`);
  const blocks = returnBlocks(xml).map(parseXmlBlock);
  return { profileName: name, count: blocks.length, filter: blocks[0] ?? null, raw: blocks };
}

/** getCampaignProfileDispositions — ONE profile's dispositions (exact profileName). */
export async function getCampaignProfileDispositions(profileName) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('profile_name is required for entity_type "campaign_profile_dispositions"');
  const xml = await five9SoapCall('getCampaignProfileDispositions', `<profileName>${escapeXml(name)}</profileName>`);
  const dispositions = returnBlocks(xml).map(b => (/<[A-Za-z_]/.test(b) ? parseXmlBlock(b) : decodeXml(b).trim()));
  return { profileName: name, count: dispositions.length, dispositions };
}

/** getSpeedDialNumbers — speed dial inventory. Takes no argument. */
export async function getSpeedDialNumbers() {
  const xml = await five9SoapCall('getSpeedDialNumbers');
  const numbers = returnBlocks(xml).map(b => (/<[A-Za-z_]/.test(b) ? parseXmlBlock(b) : decodeXml(b).trim()));
  return { count: numbers.length, numbers };
}

/**
 * getCallCountersState — LIVE dialer telemetry, not configuration.
 * Takes no argument. Kept out of five9_get_config on purpose: its freshness
 * semantics are per-second, where every config read is "current until
 * somebody edits it".
 */
export async function getCallCountersState() {
  const xml = await five9SoapCall('getCallCountersState');
  const counters = returnBlocks(xml).map(parseXmlBlock);
  return { count: counters.length, counters, captured_at: new Date().toISOString() };
}

/** getCrmImportResult — job status for a CRM import (same identifier shape as list). */
export async function getCrmImportResult(identifier) {
  const xml = await five9SoapCall('getCrmImportResult', buildImportIdentifierXml(identifier));
  const block = returnBlocks(xml)[0];
  if (!block) return { identifier: String(identifier || ''), found: false, raw: null };
  const raw = parseXmlBlock(block);
  return {
    identifier: String(identifier || ''),
    found: true,
    success: String(raw.success ?? '') === 'true',
    crmRecordsInserted: num(raw.crmRecordsInserted),
    crmRecordsUpdated: num(raw.crmRecordsUpdated),
    uploadErrorsCount: num(raw.uploadErrorsCount),
    uploadDuplicatesCount: num(raw.uploadDuplicatesCount),
    failureMessage: raw.failureMessage || null,
    importTroubles: asArray(raw.importTroubles),
    raw,
  };
}

/** getDispositionsImportResult — job status for a dispositions import. */
export async function getDispositionsImportResult(identifier) {
  const xml = await five9SoapCall('getDispositionsImportResult', buildImportIdentifierXml(identifier));
  const block = returnBlocks(xml)[0];
  if (!block) return { identifier: String(identifier || ''), found: false, raw: null };
  const raw = parseXmlBlock(block);
  return {
    identifier: String(identifier || ''),
    found: true,
    success: String(raw.success ?? '') === 'true',
    uploadErrorsCount: num(raw.uploadErrorsCount),
    failureMessage: raw.failureMessage || null,
    importTroubles: asArray(raw.importTroubles),
    raw,
  };
}

/**
 * buildLookupCriteriaXml — tns:crmLookupCriteria for getContactRecords.
 * Sequence order is contactIdField then the repeated criteria, each a
 * tns:crmFieldCriterion of { field, value }.
 */
export function buildLookupCriteriaXml({ contactIdField, criteria } = {}) {
  const rows = Array.isArray(criteria) ? criteria : [];
  if (!rows.length) throw new Error('lookup_criteria requires at least one { field, value } criterion');
  for (const r of rows) {
    if (!r || !String(r.field ?? '').trim()) {
      throw new Error('each lookup criterion requires a non-empty "field"');
    }
  }
  const idField = String(contactIdField ?? '').trim();
  return '<lookupCriteria>' +
    (idField ? `<contactIdField>${escapeXml(idField)}</contactIdField>` : '') +
    rows.map(r =>
      `<criteria><field>${escapeXml(String(r.field).trim())}</field>` +
      `<value>${escapeXml(r.value ?? '')}</value></criteria>`
    ).join('') +
    '</lookupCriteria>';
}

/**
 * getContactRecords — query the Five9 contact DB by lookup criteria.
 *
 * NOT a config read and deliberately not folded into five9_get_config: it
 * takes a query, not a name pattern. LP REMAINS THE SYSTEM OF RECORD for
 * contact data — this exists to verify what Five9 currently holds, never to
 * treat Five9 as truth. (Same reasoning that makes every contact-DB WRITE
 * `denied` in OP_CLASSIFICATION: a third divergent copy is the failure mode.)
 */
export async function getContactRecords(lookupCriteria) {
  const xml = await five9SoapCall('getContactRecords', buildLookupCriteriaXml(lookupCriteria));
  const blocks = returnBlocks(xml).map(parseXmlBlock);
  return {
    count: blocks.length,
    records: blocks,
    system_of_record: 'LP — Five9 contact data is a copy, not truth',
  };
}
