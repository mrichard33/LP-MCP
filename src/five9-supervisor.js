/**
 * Five9 Supervisor Web Services client — src/five9-supervisor.js
 *
 * Real-time floor telemetry: live agent states, ACD queue status, and live
 * campaign statistics. This is a DIFFERENT API from the Admin SOAP service in
 * src/five9-admin.js — different endpoint, different namespace, and, unlike
 * Admin, it is SESSION-BASED.
 *
 *   Admin      https://api.five9.com/wsadmin/v13/AdminWebService
 *              stateless, one call = one answer
 *   Supervisor https://api.five9.com/wssupervisor/v13/SupervisorWebService
 *              setSessionParameters FIRST, then getStatistics
 *
 * Auth: HTTP Basic, same FIVE9_USERNAME / FIVE9_PASSWORD service account.
 * Requires the Supervisor role with "CanUseSupervisorSoapApi" enabled —
 * verified true on svc-reece-api 2026-07-30.
 *
 * READ-ONLY. setSessionParameters mutates only our own API session (view
 * window, timezone, rolling period). It touches no campaign, list, agent, or
 * contact state. Supervisor CAN start/stop campaigns; those methods are
 * deliberately NOT implemented here — campaign control stays in
 * src/five9/admin-writes.js behind create_agent_action + approve_action +
 * FIVE9_WRITES_ENABLED, so there is exactly one gated write path.
 *
 * SESSION NOTE: Five9 allows a limited number of concurrent supervisor
 * sessions per user. We hold one, refresh it on a TTL, and pass
 * forceLogoutSession so a stale session from a crashed process is reclaimed
 * rather than blocking every subsequent call.
 *
 * Env (Railway, all optional — sane defaults below):
 *   FIVE9_SUPERVISOR_WSDL_URL     endpoint override
 *   FIVE9_SUPERVISOR_TIMEOUT_MS   per-call timeout, default 25000
 *   FIVE9_SUPERVISOR_SHIFT_START  shift start hour in ET, default 8
 */

import { escapeXml, returnBlocks, parseXmlBlock, asArray } from './five9-admin.js';

const ENDPOINT = process.env.FIVE9_SUPERVISOR_WSDL_URL
  || 'https://api.five9.com/wssupervisor/v13/SupervisorWebService';

const TIMEOUT_MS = parseInt(process.env.FIVE9_SUPERVISOR_TIMEOUT_MS || '25000', 10);
const SESSION_TTL_MS = 10 * 60 * 1000;

/** Statistic types this client accepts. Unknown values fail closed. */
export const STATISTIC_TYPES = [
  'AgentState',
  'AgentStatistics',
  'ACDStatus',
  'CampaignState',
  'OutboundCampaignStatistics',
  'InboundCampaignStatistics',
  'AutodialCampaignStatistics',
  'ListState',
];

function credsConfigured() {
  return Boolean(process.env.FIVE9_USERNAME && process.env.FIVE9_PASSWORD);
}

function authHeader() {
  const u = process.env.FIVE9_USERNAME || '';
  const p = process.env.FIVE9_PASSWORD || '';
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

function decodeXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * America/New_York UTC offset in milliseconds, DST-aware (negative west of
 * UTC). Five9 wants the supervisor view's timezone as an ms offset, and the
 * business runs ET — a hardcoded -5h would silently shift every timestamp by
 * an hour for eight months of the year.
 */
export function etOffsetMs(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value])
  );
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asIfUtc - (date.getTime() - date.getMilliseconds());
}

/** Low-level Supervisor SOAP call. Returns raw XML on success. */
async function supervisorSoapCall(method, innerXml = '') {
  if (!credsConfigured()) {
    throw new Error('Five9 credentials not configured (FIVE9_USERNAME / FIVE9_PASSWORD Railway env vars)');
  }

  const envelope =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:ser="http://service.supervisor.ws.five9.com/">' +
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
      ? `Five9 supervisor API timeout after ${TIMEOUT_MS}ms (${method})`
      : `Five9 supervisor API network error (${method}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(text);
  if (fault) {
    const msg = decodeXml(fault[1]).trim();
    if (/permission|not authorized|role/i.test(msg)) {
      throw new Error(`Five9 supervisor ${method}: ${msg} — the API user needs the Supervisor role with "CanUseSupervisorSoapApi" enabled`);
    }
    const err = new Error(`Five9 supervisor ${method} fault: ${msg}`);
    // Session faults are recoverable: the caller re-establishes and retries once.
    err.sessionFault = /session|not set|setSessionParameters|expired|login/i.test(msg);
    throw err;
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Five9 supervisor: HTTP 401 — bad FIVE9_USERNAME/FIVE9_PASSWORD');
    }
    throw new Error(`Five9 supervisor ${method}: HTTP ${res.status}`);
  }
  return text;
}

/* ---- Session ----------------------------------------------------------- */

let sessionSetAt = 0;

/**
 * setSessionParameters — establishes the supervisor view window. Must run
 * before getStatistics. Idempotent; safe to re-issue.
 */
export async function setSessionParameters({
  rollingPeriod = 'Minutes30',
  statisticsRange = 'CurrentDay',
  forceLogout = true,
} = {}) {
  const shiftHour = parseInt(process.env.FIVE9_SUPERVISOR_SHIFT_START || '8', 10);
  const shiftStartMs = Math.max(0, Math.min(23, shiftHour)) * 3600 * 1000;
  const inner =
    '<viewSettings>' +
    `<forceLogoutSession>${forceLogout ? 'true' : 'false'}</forceLogoutSession>` +
    '<idleTimeOut>1800</idleTimeOut>' +
    `<rollingPeriod>${escapeXml(rollingPeriod)}</rollingPeriod>` +
    `<statisticsRange>${escapeXml(statisticsRange)}</statisticsRange>` +
    `<shiftStart>${shiftStartMs}</shiftStart>` +
    `<timeZone>${etOffsetMs()}</timeZone>` +
    '</viewSettings>';
  await supervisorSoapCall('setSessionParameters', inner);
  sessionSetAt = Date.now();
  return {
    ok: true,
    rollingPeriod,
    statisticsRange,
    shiftStartHourEt: shiftHour,
    timeZoneOffsetMs: etOffsetMs(),
  };
}

async function ensureSession(opts) {
  if (Date.now() - sessionSetAt < SESSION_TTL_MS) return false;
  await setSessionParameters(opts);
  return true;
}

/* ---- Statistics -------------------------------------------------------- */

/**
 * normalizeStatistics — Five9 returns a header/rows envelope similar to the
 * report API. Shapes vary a little by statistic type, so we probe the two
 * known layouts and ALWAYS keep the parsed block available under `raw` when
 * asked, rather than throwing away data we failed to recognize.
 */
export function normalizeStatistics(rawBlock) {
  const raw = rawBlock || {};
  const columns = asArray(raw.columns?.values?.data ?? raw.columns?.data ?? raw.header?.values?.data);
  const rowContainer = raw.values ?? raw.records ?? raw.rows;
  const rows = asArray(rowContainer?.values ?? rowContainer)
    .map(r => asArray(r?.values?.data ?? r?.data ?? r))
    .filter(r => r.length);
  return { columns, rows };
}

/** Zip columns + rows into objects when the shapes line up. */
function toObjects(columns, rows) {
  if (!columns.length) return null;
  return rows.map(r => {
    const o = {};
    columns.forEach((c, i) => { o[c] = r[i] ?? null; });
    return o;
  });
}

/**
 * getStatistics — live supervisor statistics for one statistic type.
 * Establishes/refreshes the session automatically and retries once on a
 * session fault (another process may have taken the session).
 */
export async function getStatistics(statisticType, { includeRaw = false, session } = {}) {
  const type = String(statisticType || '').trim();
  if (!STATISTIC_TYPES.includes(type)) {
    throw new Error(`Unknown statisticType "${type}". Supported: ${STATISTIC_TYPES.join(', ')}`);
  }

  await ensureSession(session);

  let xml;
  try {
    xml = await supervisorSoapCall('getStatistics', `<statisticType>${escapeXml(type)}</statisticType>`);
  } catch (err) {
    if (!err.sessionFault) throw err;
    await setSessionParameters(session);
    xml = await supervisorSoapCall('getStatistics', `<statisticType>${escapeXml(type)}</statisticType>`);
  }

  const block = returnBlocks(xml)[0];
  if (!block) {
    return { statisticType: type, columns: [], rows: [], row_count: 0, observed_at: new Date().toISOString() };
  }
  const parsed = parseXmlBlock(block);
  const { columns, rows } = normalizeStatistics(parsed);
  const out = {
    statisticType: type,
    observed_at: new Date().toISOString(),
    columns,
    row_count: rows.length,
    rows,
  };
  const objects = toObjects(columns, rows);
  if (objects) out.records = objects;
  if (includeRaw) out.raw = parsed;
  return out;
}

/** Force a fresh session — use when statistics look stale or a fault repeats. */
export async function resetSession(opts) {
  sessionSetAt = 0;
  return setSessionParameters({ ...opts, forceLogout: true });
}
