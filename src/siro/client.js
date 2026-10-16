/**
 * Siro client — src/siro/client.js (2026-10-16, Siro PR 1)
 *
 * The ONLY module that talks to Siro. Two base URLs, two header styles, one
 * credential (docs/siro-reference.md §1):
 *   org-wide    https://functions.siro.ai/api-externalApi/v1   Authorization: Bearer <token>
 *   user-scoped https://api.siro.ai/v1                          x-siro-auth-token: <token>
 *
 * Auth: SIRO_CLIENT_ID + SIRO_CLIENT_SECRET → client credentials against
 * auth.siro.ai (cached, refreshed 60s before expires_in; there is no refresh
 * token). Without them, SIRO_API is used as a static bearer (the legacy org
 * token Siro is retiring).
 *
 * siroFetch never throws (CANON.K.070: a failure is a value the caller
 * branches on), retries once on 429/5xx after 2s, and keeps under the
 * per-credential rate with a token bucket. It logs method, path, status and
 * time — never a token, never a body (CANON.K.082: recordings are customer
 * PII). The redacted-audio link is short-lived and is never stored.
 */
import { SIRO_ORG_BASE, SIRO_USER_BASE, SIRO_TOKEN_URL, siroConfig } from './config.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── token bucket ─────────────────────────────────────────────────────────
let bucket = null;
function takeToken(ratePerMin, nowMs = Date.now()) {
  if (!bucket || bucket.rate !== ratePerMin) {
    bucket = { rate: ratePerMin, tokens: ratePerMin, at: nowMs };
  }
  const refill = ((nowMs - bucket.at) / 60_000) * ratePerMin;
  bucket.tokens = Math.min(ratePerMin, bucket.tokens + refill);
  bucket.at = nowMs;
  if (bucket.tokens >= 1) { bucket.tokens -= 1; return 0; }
  return Math.ceil(((1 - bucket.tokens) / ratePerMin) * 60_000);
}

// ── auth ─────────────────────────────────────────────────────────────────
let cachedToken = null; // { token, expiresAtMs, key }

async function getToken({ env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const cfg = siroConfig(env);
  if (cfg.clientId && cfg.clientSecret) {
    const key = cfg.clientId;
    if (cachedToken && cachedToken.key === key && cachedToken.expiresAtMs - 60_000 > nowMs) {
      return { token: cachedToken.token, kind: 'client_credentials' };
    }
    try {
      const res = await fetchImpl(SIRO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`[Siro] token request failed ${res.status}`);
        return { token: null, kind: 'client_credentials', error: `token_http_${res.status}` };
      }
      const data = await res.json();
      const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
      cachedToken = { token: data.access_token, expiresAtMs: nowMs + ttl * 1000, key };
      return { token: data.access_token, kind: 'client_credentials' };
    } catch (err) {
      console.warn(`[Siro] token request error: ${err.message}`);
      return { token: null, kind: 'client_credentials', error: 'token_unreachable' };
    }
  }
  if (cfg.legacyToken) return { token: cfg.legacyToken, kind: 'legacy_org_token' };
  return { token: null, kind: 'none', error: 'no_credentials' };
}

export function _resetSiroClientForTests() { cachedToken = null; bucket = null; }

function buildUrl(base, path, query) {
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) url.searchParams.set(k, v.join(','));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * @returns {Promise<{ok:boolean,status:number,data:any,error:string|null}>}
 */
export async function siroFetch({
  scope = 'org', method = 'GET', path, query, body, timeoutMs = 15000,
} = {}, { env = process.env, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const cfg = siroConfig(env);
  const auth = await getToken({ env, fetchImpl });
  if (!auth.token) return { ok: false, status: 0, data: null, error: auth.error || 'no_token' };

  const base = scope === 'user' ? SIRO_USER_BASE : SIRO_ORG_BASE;
  const url = buildUrl(base, path, query);
  const headers = { Accept: 'application/json' };
  if (scope === 'user') headers['x-siro-auth-token'] = auth.token;
  else headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = takeToken(cfg.ratePerMin);
    if (wait > 0) await sleepImpl(wait);
    const started = Date.now();
    let status = 0;
    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      console.log(`[Siro] ${method} ${path} ${status} ${Date.now() - started}ms`);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (res.ok) return { ok: true, status, data, error: null };
      if ((status === 429 || status >= 500) && attempt === 0) { await sleepImpl(2000); continue; }
      const msg = (data && (data.message || data.error)) || `http_${status}`;
      return { ok: false, status, data, error: String(msg).slice(0, 200) };
    } catch (err) {
      console.log(`[Siro] ${method} ${path} ERR ${Date.now() - started}ms ${err.name}`);
      if (attempt === 0) { await sleepImpl(2000); continue; }
      return { ok: false, status, data: null, error: err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
    }
  }
  return { ok: false, status: 0, data: null, error: 'unreachable' };
}

// Siro wraps lists differently across endpoints; read the rows wherever they are.
export function listRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of ['data', 'items', 'results', 'recordings', 'users', 'connections', 'records']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}
export function nextCursor(data) {
  if (!data || typeof data !== 'object') return null;
  return data.cursor || data.nextCursor || data.next_cursor || data?.pagination?.cursor
    || data?.pagination?.nextCursor || data?.meta?.cursor || null;
}

const flags = (o = {}) => ({
  showCrmLinks: o.showCrmLinks ? 'true' : undefined,
  showSummary: o.showSummary ? 'true' : undefined,
  showEntityExtractions: o.showEntityExtractions ? 'true' : undefined,
  showFollowups: o.showFollowups ? 'true' : undefined,
});
const ALL_FLAGS = { showCrmLinks: true, showSummary: true, showEntityExtractions: true, showFollowups: true };

export function getCallerIdentity(scope = 'org', deps) {
  return siroFetch({ scope, path: '/core/auth/caller-identity' }, deps);
}
export function getRecording(id, opts = ALL_FLAGS, deps) {
  return siroFetch({ scope: 'org', path: `/core/recordings/${encodeURIComponent(id)}`, query: flags(opts) }, deps);
}
export function listRecordingsUpdatedSince(iso, { cursor, limit = 100 } = {}, deps) {
  return siroFetch({
    scope: 'org',
    path: '/core/recordings',
    query: { 'updatedAt:gte': iso, cursor, limit, ...flags(ALL_FLAGS) },
  }, deps);
}
export function listRecordingsUserScoped(filters = {}, deps) {
  return siroFetch({ scope: 'user', path: '/core/recordings', query: { showCrmCustomer: 'true', ...filters } }, deps);
}
export function getUtterances(id, { cursor } = {}, deps) {
  return siroFetch({ scope: 'user', path: `/core/recordings/${encodeURIComponent(id)}/utterances`, query: { cursor } }, deps);
}
export function getFollowups(filters = {}, deps) {
  return siroFetch({ scope: 'user', path: '/core/followups', query: filters }, deps);
}
export function listUsers(deps) {
  return siroFetch({ scope: 'user', path: '/core/users' }, deps);
}
// 2026-10-16: the user-scoped API answered 404 for this path with a client app;
// the org-wide API is tried first, the user-scoped one as the fallback.
export async function listConnections(deps) {
  const org = await siroFetch({ scope: 'org', path: '/core/integrations/connections' }, deps);
  if (org.ok) return org;
  const user = await siroFetch({ scope: 'user', path: '/core/integrations/connections' }, deps);
  return user.ok ? user : org;
}
export function listConversationConfigurations(organizationId, deps) {
  return siroFetch({ scope: 'user', path: '/core/conversation-configurations', query: { organizationId } }, deps);
}
export function listScorecardInstances(organizationId, { isActive = true, conversationTypeId } = {}, deps) {
  return siroFetch({
    scope: 'user', path: '/core/scorecards/instances',
    query: { organizationId, isActive: isActive ? 'true' : undefined, conversationTypeId },
  }, deps);
}
export function getEvaluatedInstance(id, { startAt, endAt, filterBy, filterByIds } = {}, deps) {
  return siroFetch({
    scope: 'user', path: `/core/scorecards/evaluated-instances/${encodeURIComponent(id)}`,
    query: { startAt, endAt, filterBy, filterByIds },
  }, deps);
}
/** Short-lived link to the REDACTED audio. Never store it. */
export function getRecordingAudioUrl(id, deps) {
  return siroFetch({ scope: 'user', method: 'POST', path: `/core/recordings/${encodeURIComponent(id)}/signedUrl`, body: {} }, deps);
}

export const _internal = { takeToken, getToken, buildUrl };
