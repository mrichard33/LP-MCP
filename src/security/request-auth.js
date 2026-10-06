/**
 * request-auth — one staged, constant-time secret check for every webhook and
 * operator route (2026-10-06, AI OS batch 1, PR 3; CANON.STD.016, SEC.003).
 *
 * WHY STAGED. An audit on 2026-10-06 found routes that run OPEN when their
 * secret is unset (/webhook/lp, the canvass / affiliate / confirmation
 * webhooks, the GHL behavioral routes, rest-api's HMAC, the IME and internal
 * routes, the LP report ingest), webhooks that accept the secret in the URL
 * (`?secret=`, which lands in proxy and access logs), plain `!==` compares,
 * and AUTH_SOFT_LAUNCH=true in production letting every unauthenticated
 * operator request through. Six of those secrets are unset in Railway and
 * three GHL appointment handlers still send `?secret=`. Flipping straight to
 * fail-closed would cut live senders off, so:
 *
 *   AUTH_ENFORCE_MODE=log (default) — behaviour is exactly what it was. Each
 *     request that WOULD be rejected under enforce writes one
 *     `security.auth_would_reject` system_events row
 *     {route, reason: missing_token | soft_launch | query_secret | bad_secret
 *     | secret_unset}, deduped per route+reason per hour. Never the secret,
 *     never the body.
 *   AUTH_ENFORCE_MODE=enforce — an unset secret is 503, a missing or wrong
 *     header secret is 401, a query-string secret is ignored (then missing),
 *     and AUTH_SOFT_LAUNCH is ignored.
 *
 * Flip to enforce only after a week of zero would-reject rows from legitimate
 * senders, with every secret set and every sender on a header.
 */

import { safeEqual } from '../auth.js';

export const AUTH_REASONS = Object.freeze([
  'missing_token', 'soft_launch', 'query_secret', 'bad_secret', 'secret_unset',
]);

/** 'log' unless AUTH_ENFORCE_MODE is exactly enforce (any case). */
export function authEnforceMode(env = process.env) {
  return String(env.AUTH_ENFORCE_MODE || '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'log';
}

/** First non-empty header among `names` (Express lowercases header keys). */
export function headerValue(req, names) {
  for (const n of names) {
    const v = req?.headers?.[String(n).toLowerCase()];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** The token from `Authorization: Bearer <token>`, else null. */
export function bearerToken(req) {
  const auth = req?.headers?.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7) || null;
}

function querySecret(req) {
  const q = req?.query?.secret;
  return typeof q === 'string' && q.length > 0 ? q : null;
}

/**
 * The decision, pure. `provided` is the header value; `queryProvided` the
 * `?secret=` value. In log mode the old "header || query" order is kept, so a
 * request that passed yesterday passes today.
 *
 * @returns {{ allow: boolean, status: number|null, reason: string|null, wouldReject: boolean }}
 */
export function decideSecret({ secret, provided = null, queryProvided = null, mode = 'log' }) {
  const enforce = mode === 'enforce';
  if (typeof secret !== 'string' || secret.length === 0) {
    return enforce
      ? { allow: false, status: 503, reason: 'secret_unset', wouldReject: true }
      : { allow: true, status: null, reason: 'secret_unset', wouldReject: true };
  }
  if (provided) {
    return safeEqual(provided, secret)
      ? { allow: true, status: null, reason: null, wouldReject: false }
      : { allow: false, status: 401, reason: 'bad_secret', wouldReject: true };
  }
  if (queryProvided) {
    if (enforce) return { allow: false, status: 401, reason: 'query_secret', wouldReject: true };
    return safeEqual(queryProvided, secret)
      ? { allow: true, status: null, reason: 'query_secret', wouldReject: true }
      : { allow: false, status: 401, reason: 'bad_secret', wouldReject: true };
  }
  return { allow: false, status: 401, reason: 'missing_token', wouldReject: true };
}

// ─── would-reject telemetry ─────────────────────────────────────────

const DEDUPE_MS = 60 * 60 * 1000;
const lastRecorded = new Map();

/** Test seam: forget what has been recorded this process. */
export function resetAuthRecordState() { lastRecorded.clear(); }

async function insertSystemEvent(row) {
  const { default: supabase } = await import('../supabase.js');
  if (!supabase) return;
  await supabase.from('system_events').insert(row);
}

/**
 * Record one would-reject per route+reason per hour. Fire-and-forget: it
 * never throws and never delays the request. The hour bucket also goes in the
 * idempotency key so two replicas do not double-count the same hour.
 */
export function recordAuthWouldReject({ route, reason, mode = 'log', method = null }, deps = {}) {
  if (!route || !AUTH_REASONS.includes(reason)) return false;
  const now = deps.now ?? Date.now();
  const key = `${route}|${reason}`;
  const last = lastRecorded.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  lastRecorded.set(key, now);
  const bucket = Math.floor(now / DEDUPE_MS);
  const row = {
    event_type: 'security.auth_would_reject',
    event_subtype: reason,
    source: 'lp_mcp',
    entity_type: 'system',
    entity_id: String(route).slice(0, 200),
    payload: { route, reason, mode, enforced: mode === 'enforce', method },
    priority: 'low',
    idempotency_key: `auth_would_reject:${route}:${reason}:${bucket}`,
    event_timestamp: new Date(now).toISOString(),
    // Telemetry, not work: no rule consumes it, so the engine never picks it up.
    processed: true,
    processed_by: 'request_auth',
    processed_at: new Date(now).toISOString(),
  };
  const insert = deps.insert ?? insertSystemEvent;
  Promise.resolve()
    .then(() => insert(row))
    .catch((err) => console.warn(`[Auth] would-reject record failed for ${route}: ${err?.message}`));
  return true;
}

/**
 * The whole check for a shared-secret webhook. Returns the decision; the
 * caller sends its own rejection body (some GHL routes answer 200 on purpose).
 *
 * @param {object} req
 * @param {{ route: string, secret: string|null|undefined, headers: string[],
 *           bearer?: boolean, allowQuery?: boolean, mode?: string,
 *           record?: Function }} opts
 */
export function checkRequestSecret(req, { route, secret, headers = [], bearer = false, allowQuery = false, mode, record = recordAuthWouldReject }) {
  const m = mode ?? authEnforceMode();
  const provided = (bearer ? bearerToken(req) : null) ?? headerValue(req, headers);
  const decision = decideSecret({
    secret,
    provided,
    queryProvided: allowQuery ? querySecret(req) : null,
    mode: m,
  });
  if (decision.wouldReject) record({ route, reason: decision.reason, mode: m, method: req?.method || null });
  return decision;
}

/** The JSON body for a refusal. Never echoes what was sent. */
export function rejectionBody(decision) {
  return decision.status === 503
    ? { error: 'auth_not_configured', detail: 'this endpoint has no secret configured and refuses all requests' }
    : { error: 'unauthorized', detail: 'send the shared secret in the documented header' };
}

// ─── boot report ────────────────────────────────────────────────────

/** Secrets the routes above depend on. Names only, never values. */
export const REQUIRED_SECRETS = Object.freeze([
  'MCP_AUTH_TOKEN',
  'N8N_WEBHOOK_SECRET',
  'GHL_WEBHOOK_SECRET',
  'WEBHOOK_SECRET',
  'AFFILIATE_WEBHOOK_SECRET',
  'CANVASSING_WEBHOOK_SECRET',
  'CANVASS_CONFIRMATION_WEBHOOK_SECRET',
  'LP_REPORT_INGEST_SECRET',
  'MESSAGE_ENGINE_TOKEN',
  'ADMIN_API_TOKEN',
]);

/** Names of the required secrets that are unset. Pure. */
export function unsetRequiredSecrets(env = process.env) {
  return REQUIRED_SECRETS.filter((n) => !String(env[n] ?? '').trim());
}

/** One boot line: the mode, soft launch, and the NAMES of unset secrets. */
export function logAuthBootReport(env = process.env, log = (m) => console.warn(m)) {
  const mode = authEnforceMode(env);
  const unset = unsetRequiredSecrets(env);
  const soft = env.AUTH_SOFT_LAUNCH === 'true';
  log(`[Auth] AUTH_ENFORCE_MODE=${mode}${soft ? ` AUTH_SOFT_LAUNCH=true${mode === 'enforce' ? ' (ignored under enforce)' : ''}` : ''}`
    + (unset.length
      ? ` | unset secrets: ${unset.join(', ')} — ${mode === 'enforce' ? 'their routes answer 503' : 'their routes run open (would reject under enforce)'}`
      : ' | every required secret is set'));
  return { mode, unset, softLaunch: soft };
}
