/**
 * Five9 REST session + recording download — src/ci/five9-rest.js
 *
 * 2026-10-20. ETG's archive (nas1) has reset every SFTP connection since
 * 2026-09-28, so Call Intelligence pulls audio from Five9 itself. The SOAP
 * Admin API (src/five9-admin.js) can REPORT on recordings but cannot serve
 * their bytes; the Agent/Supervisor REST API can. This module is the only code
 * that talks to that REST API, and it does two things: log in, and GET one
 * recording's bytes.
 *
 * ══ PATHS COME FROM FIVE9, NOT FROM GUESSES ══
 * Login is POST {login host}/appsvcs/rs/svc/auth/login with
 * { passwordCredentials, appKey, policy: 'AttachExisting' }. The API host is
 * whatever the login's metadata names (dataCenters[0].apiUrls[0]); it is never
 * assumed. Requests carry `Authorization: Bearer-<tokenId>`, `farmId` and the
 * login's cookies. The recording stream is the "call recording stream"
 * resource, GET /strsvcs/rs/svc/agents/{agentId}/recordings/{recordingId}
 * (Five9 Developer Program's Agent/Supervisor REST pack: config.py
 * CONTEXT_PATHS.agent_str, agent_methods.py GetCallRecording). Which agent id
 * that path wants, and whether `download=true` is needed, are settings
 * (CI_FIVE9_RECORDING_AGENT, CI_FIVE9_DOWNLOAD_PARAM) set from what
 * GET /ci/five9-recording-probe actually returns, not from a reading of docs.
 *
 * ══ READ ONLY ══
 * Login and GET. There is no method here that changes anything in Five9, and
 * none may be added: no campaign, VCC, report or user call. The handoff's rule
 * is list + download only, and GoCloud's FTP feed must stay exactly as it is.
 *
 * ══ THE ACCOUNT MUST NOT GET LOCKED ══
 * Five9 locked this account on 2026-08-25 after a burst of failed logins (see
 * the auth breaker in src/five9-admin.js). The same credential logs in here,
 * so the first auth-shaped refusal trips a breaker of its own and every later
 * download fails WITHOUT a login attempt until the process restarts (changing
 * the credential in Railway restarts it). The session is reused across ticks,
 * so a healthy worker logs in about once per SESSION_REUSE_MS, not per call.
 */

import { isFive9AuthFailure } from '../five9-admin.js';

const LOG = '[CIFive9Rest]';

/** Reuse a login this long before logging in again. */
export const SESSION_REUSE_MS = 15 * 60 * 1000;

/** A single recording larger than this is refused rather than buffered. */
export const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

/** Retries for 429 / 5xx / network on one download (so up to 4 tries). */
export const DOWNLOAD_RETRIES = 3;

/** The stream service, per Five9's own REST pack. */
export const STREAM_CONTEXT = '/strsvcs/rs/svc';

const APP_KEY = 'lp-mcp-ci-recordings';

/**
 * An error the worker treats as a SOURCE outage, not this call's failure: the
 * call keeps its attempts and every fetch pauses (src/ci/archive-outage.js).
 * An auth refusal, a permission refusal or Five9 being down is not something
 * one call caused, and before 2026-09-27 treating it as one parked 16,771
 * calls as permanently failed.
 */
export function sourceOutageError(message, extra = {}) {
  const err = new Error(message);
  err.ciSourceOutage = true;
  Object.assign(err, extra);
  return err;
}

/* ─── module state: one session, one breaker ────────────────────────────── */

let cachedSession = null; // { base, userId, tokenId, farmId, cookie, at }
let authBreaker = null;   // { at, message }

export function five9RestBreakerStatus() {
  return authBreaker ? { open: true, since: authBreaker.at, reason: authBreaker.message } : { open: false };
}

/** Test-only, and for an operator who just fixed the credential. */
export function resetFive9RestState() {
  cachedSession = null;
  authBreaker = null;
}

function tripBreaker(message) {
  if (authBreaker) return;
  authBreaker = { at: new Date().toISOString(), message: String(message).slice(0, 300) };
  console.error(
    `${LOG} AUTH BREAKER OPEN: no further Five9 REST logins until the process restarts, `
    + `to protect the account from lockout. Cause: ${authBreaker.message}`,
  );
}

/* ─── pure helpers ──────────────────────────────────────────────────────── */

/**
 * Read what a login response tells us: the API host and the session's
 * identity. Pure. Throws (not an outage) when the shape is not a login.
 */
export function parseLoginMetadata(body, cookie = '') {
  const api = body?.metadata?.dataCenters?.[0]?.apiUrls?.[0];
  const tokenId = body?.tokenId;
  const userId = body?.userId;
  const farmId = body?.context?.farmId;
  if (!api?.host || !tokenId || !userId || !farmId) {
    throw sourceOutageError(
      `Five9 REST login answered without a session (keys: ${Object.keys(body || {}).join(', ') || 'none'})`,
    );
  }
  const port = api.port && String(api.port) !== '443' ? `:${api.port}` : '';
  return {
    base: `https://${api.host}${port}`,
    host: api.host,
    userId: String(userId),
    orgId: body?.orgId != null ? String(body.orgId) : null,
    farmId: String(farmId),
    tokenId: String(tokenId),
    cookie,
  };
}

/** Collapse Set-Cookie headers into one Cookie header value. Pure. */
export function cookieHeaderFrom(headers) {
  const list = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers?.get?.('set-cookie') ? [headers.get('set-cookie')] : []);
  return list
    .map((c) => String(c).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

/** The recording URL for a session. Pure, so the probe and tests can show it. */
export function recordingUrl(session, { agentId, recordingId, download = true }) {
  const a = encodeURIComponent(String(agentId));
  const r = encodeURIComponent(String(recordingId));
  return `${session.base}${STREAM_CONTEXT}/agents/${a}/recordings/${r}${download ? '?download=true' : ''}`;
}

function authHeaders(session) {
  return {
    Authorization: `Bearer-${session.tokenId}`,
    farmId: session.farmId,
    ...(session.cookie ? { Cookie: session.cookie } : {}),
  };
}

const isRetryable = (status) => status === 429 || (status >= 500 && status <= 599);

/* ─── the client ────────────────────────────────────────────────────────── */

/**
 * @param {object} opts.cfg   parsed CI config (cfg.five9Api)
 * @param {object} [opts.deps] { fetch, sleep, env, now }
 */
export function createFive9RestClient({ cfg, deps = {} } = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const api = cfg?.five9Api || {};

  async function login({ force = false } = {}) {
    if (authBreaker) {
      throw sourceOutageError(`Five9 REST auth breaker open since ${authBreaker.at}: ${authBreaker.message}`);
    }
    if (!force && cachedSession && now() - cachedSession.at < SESSION_REUSE_MS) return cachedSession;

    const username = env.FIVE9_USERNAME;
    const password = env.FIVE9_PASSWORD;
    if (!username || !password) {
      throw sourceOutageError('FIVE9_USERNAME / FIVE9_PASSWORD are not set');
    }

    let res;
    try {
      res = await fetchImpl(api.loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          passwordCredentials: { username, password },
          appKey: APP_KEY,
          policy: 'AttachExisting',
        }),
      });
    } catch (err) {
      throw sourceOutageError(`Five9 REST login could not connect: ${err.message}`);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = text.slice(0, 300);
      // 401 at login, or a body that reads as a credential problem: one
      // refusal, then no more attempts. A 403 here is a permission the user
      // lacks, which retrying cannot fix either.
      if (res.status === 401 || res.status === 403 || isFive9AuthFailure(detail)) {
        tripBreaker(`login HTTP ${res.status}: ${detail || 'no body'}`);
      }
      throw sourceOutageError(`Five9 REST login HTTP ${res.status}: ${detail || 'no body'}`, { httpStatus: res.status });
    }

    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    const session = parseLoginMetadata(body, cookieHeaderFrom(res.headers));
    cachedSession = { ...session, at: now() };
    console.log(`${LOG} logged in (api host ${session.host})`);
    return cachedSession;
  }

  /**
   * Download one recording's bytes. Never throws on a non-2xx when
   * `{ raw: true }` (the probe wants the status); otherwise:
   *   401 → one re-login and retry, then an outage error
   *   403 → an outage error naming the missing permission
   *   429 / 5xx / network → backoff retries, then an outage error
   *   404 → a plain error: this recording, not the source, is the problem
   */
  async function getRecording({ agentId, recordingId, download = api.downloadParam !== false, raw = false } = {}) {
    if (!recordingId) throw new Error('getRecording requires a recordingId');
    let session = await login();
    let relogged = false;

    for (let attempt = 0; ; attempt++) {
      const aid = agentId ?? session.userId;
      const url = recordingUrl(session, { agentId: aid, recordingId, download });
      let res;
      try {
        res = await fetchImpl(url, { method: 'GET', headers: { ...authHeaders(session), Accept: '*/*' } });
      } catch (err) {
        if (attempt < DOWNLOAD_RETRIES) { await sleep(1000 * 2 ** attempt); continue; }
        throw sourceOutageError(`Five9 recording download could not connect: ${err.message}`);
      }

      if (res.status === 401 && !relogged) {
        relogged = true;
        cachedSession = null;
        session = await login({ force: true });
        continue;
      }

      if (isRetryable(res.status) && attempt < DOWNLOAD_RETRIES) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(30_000, retryAfter * 1000)
          : 1000 * 2 ** attempt;
        await res.arrayBuffer?.().catch(() => {});
        await sleep(waitMs);
        continue;
      }

      const contentType = res.headers?.get?.('content-type') || null;
      const declared = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) {
        throw new Error(`recording ${recordingId} is ${declared} bytes, over the ${MAX_RECORDING_BYTES}-byte limit`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());

      if (raw) return { status: res.status, contentType, buffer, url, agentIdUsed: String(aid) };

      if (res.ok) {
        // A JSON answer is not audio. Say what came back (keys only, never the
        // values: they could carry a signed URL or a token).
        if (/json/i.test(contentType || '')) {
          let keys = '';
          try { keys = Object.keys(JSON.parse(buffer.toString('utf8')) || {}).join(', '); } catch { /* not JSON after all */ }
          throw sourceOutageError(`Five9 answered recording ${recordingId} with JSON, not audio (keys: ${keys || 'none'})`);
        }
        if (!buffer.length) throw new Error(`Five9 returned an empty body for recording ${recordingId}`);
        return { buffer, contentType, status: res.status };
      }

      const detail = buffer.toString('utf8').slice(0, 300);
      if (res.status === 401) {
        if (isFive9AuthFailure(detail)) tripBreaker(`recording download HTTP 401: ${detail}`);
        throw sourceOutageError(`Five9 refused the session for recordings (HTTP 401): ${detail || 'no body'}`, { httpStatus: 401 });
      }
      if (res.status === 403) {
        throw sourceOutageError(
          `Five9 refused recording access (HTTP 403) for ${env.FIVE9_USERNAME || 'the API user'}: ${detail || 'no body'}. `
          + 'The user needs recording access (supervisor permission to listen to / download call recordings).',
          { httpStatus: 403 },
        );
      }
      if (isRetryable(res.status)) {
        throw sourceOutageError(`Five9 recording download HTTP ${res.status} after ${DOWNLOAD_RETRIES} retries: ${detail}`, { httpStatus: res.status });
      }
      throw new Error(`Five9 recording ${recordingId} HTTP ${res.status}: ${detail || 'no body'}`);
    }
  }

  return { login, getRecording };
}

export default { createFive9RestClient, sourceOutageError, five9RestBreakerStatus, resetFive9RestState };
