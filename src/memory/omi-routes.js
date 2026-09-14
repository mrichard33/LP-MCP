/**
 * Omi ingest route — src/memory/omi-routes.js
 *
 *   POST /memory/omi/ingest
 *
 * The door n8n knocks on. Everything interesting happens in omi-ingest.js; this
 * file is the guard, and it is deliberately paranoid, because the body it
 * accepts is a recording of Mark's day.
 *
 * THREE independent secrets have to line up before a byte is read:
 *   1. Authorization: Bearer <OMI_INGEST_TOKEN>   proves the caller is our n8n
 *      relay. This is NOT MCP_AUTH_TOKEN — a webhook relay must not hold the
 *      key to every admin route on this service.
 *   2. X-Omi-Token: <OMI_WEBHOOK_TOKEN>           the token Mark put in the Omi
 *      webhook URL, relayed by n8n as a header. Proves the call started at Omi.
 *   3. X-Omi-Uid: <omi user id>                   must be listed in
 *      OMI_ALLOWED_UIDS. One recorder is allowed to write to this memory.
 * Both token comparisons are constant-time over sha256 digests, so neither the
 * value nor its length leaks through timing. An unset secret fails CLOSED.
 *
 * The first test always fails on (3) — nobody knows their Omi uid until Omi
 * sends it. That rejection is logged to claude_memory_validation_log as
 * 'omi:uid_rejected' WITH the uid, so Mark reads it out of the table and puts
 * it in OMI_ALLOWED_UIDS. Nothing else about the request is recorded.
 *
 * Also here: a 2 MB body cap (checked on the declared length AND on what was
 * actually parsed), and an in-memory per-uid rate limit. No new dependency for
 * either — one Map, one process.
 *
 * The route NEVER reads query parameters. n8n moves Omi's ?uid= and ?token=
 * into headers precisely so the secret does not end up in a URL, an access log
 * or a Railway request line.
 *
 * v1.0 — 2026-09-11. Initial (sql/101).
 */
import crypto from 'node:crypto';
import express from 'express';
import supabase from '../supabase.js';
import { guardedDb } from './omi-db.js';
import { getOmiMode, ingestOmiConversation, OmiBadRequest } from './omi-ingest.js';

export const OMI_INGEST_PATH = '/memory/omi/ingest';
const DEFAULT_MAX_BODY_BYTES = 2_000_000;
const DEFAULT_RATE_LIMIT_PER_MIN = 30;

function num(env, name, fallback, min = 1) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

export function getMaxBodyBytes(env = process.env) { return num(env, 'OMI_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 1024); }
export function getRateLimitPerMin(env = process.env) { return num(env, 'OMI_RATE_LIMIT_PER_MIN', DEFAULT_RATE_LIMIT_PER_MIN, 1); }

/**
 * The JSON body parser for this route. index.js mounts it on /memory/omi BEFORE
 * the global express.json(), whose 100 kB default would reject a real
 * conversation long before the route's own cap could answer 413 properly.
 */
export function omiBodyParser(env = process.env) {
  return express.json({ limit: getMaxBodyBytes(env) });
}

/** Constant-time compare over sha256 digests: equal-length buffers, no length leak. */
export function secretMatches(provided, expected) {
  if (!expected || !provided) return false; // unset secret fails closed
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

export function allowedUids(env = process.env) {
  return String(env.OMI_ALLOWED_UIDS || '').split(',').map((u) => u.trim()).filter(Boolean);
}

// ─── Rate limit ────────────────────────────────────────────────────────────
// Fixed one-minute window per uid. In-memory on purpose: this service runs as a
// single Railway instance and the limit exists to stop a loop, not to meter.
const buckets = new Map();

export function rateLimited(uid, { limit, now = Date.now() }) {
  const windowStart = Math.floor(now / 60_000);
  const b = buckets.get(uid);
  if (!b || b.window !== windowStart) {
    buckets.set(uid, { window: windowStart, count: 1 });
    if (buckets.size > 1000) for (const [k, v] of buckets) if (v.window < windowStart) buckets.delete(k);
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

/** Test helper — drop every counter. */
export function resetRateLimit() { buckets.clear(); }

/** Best-effort audit row. Never throws and never records a transcript. */
async function logRoute(db, row) {
  try {
    const res = await db.from('claude_memory_validation_log').insert(row);
    if (res?.error) console.warn(`[Omi] audit log skipped: ${res.error.message}`);
  } catch (err) { console.warn(`[Omi] audit log skipped: ${err.message}`); }
}

/**
 * @param {import('express').Express} app
 * @param {object} [deps]  test injection: ingest, db, env
 */
export function registerOmiRoutes(app, deps = {}) {
  const env = deps.env || process.env;
  const ingest = deps.ingest || ingestOmiConversation;
  // The guarded client is built once and is the ONLY database handle the ingest
  // ever sees (see omi-db.js). `deps.db` is already guarded in tests.
  const db = deps.db || (supabase ? guardedDb(supabase) : null);

  app.post(OMI_INGEST_PATH, async (req, res) => {
    const cfgEnv = deps.env || process.env; // re-read per request: Railway vars change without a redeploy
    const mode = getOmiMode(cfgEnv);
    if (mode === 'off') return res.status(503).json({ error: 'omi ingest disabled' });

    // The webhook is OFF until it is deliberately turned on (sql/112, 2026-09-14).
    //
    // The pull in src/jobs/omi-pull.js now covers every conversation regardless
    // of capture device, so this route is an accelerator rather than the way in.
    // Both paths share the checkpoint key sha256('omi|'+id), so running both is
    // safe — but running the webhook before the pull has been watched in shadow
    // means the first thing anyone sees of the Omi path is unattended writes.
    // Ahead of the auth checks on purpose: a disabled feature should say it is
    // disabled, not make a caller guess whether their token was wrong.
    if (String(cfgEnv.OMI_WEBHOOK_ENABLED || 'false').toLowerCase().trim() !== 'true') {
      return res.status(503).json({ error: 'omi webhook disabled' });
    }

    // 1. Our relay.
    const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secretMatches(bearer, cfgEnv.OMI_INGEST_TOKEN)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // 2. Omi's own token, relayed out of the webhook URL by n8n.
    if (!secretMatches(req.headers?.['x-omi-token'], cfgEnv.OMI_WEBHOOK_TOKEN)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // 3. The recorder.
    const uid = String(req.headers?.['x-omi-uid'] || '').trim();
    const allowed = allowedUids(cfgEnv);
    if (!uid || !allowed.includes(uid)) {
      if (db) {
        await logRoute(db, {
          check_name: 'omi:uid_rejected', mode, rows_checked: allowed.length, rows_flagged: 1,
          sample: { uid: uid || null, allowed_count: allowed.length },
          notes: allowed.length ? 'uid not in OMI_ALLOWED_UIDS' : 'OMI_ALLOWED_UIDS is empty — set it to this uid to allow the recorder',
        });
      }
      return res.status(403).json({ error: 'uid not allowed' });
    }

    // 4. Size. Declared length first (cheap), then what actually parsed.
    const maxBytes = getMaxBodyBytes(cfgEnv);
    const declared = Number(req.headers?.['content-length']);
    let actual = 0;
    try { actual = Buffer.byteLength(JSON.stringify(req.body ?? null)); } catch { actual = 0; }
    if ((Number.isFinite(declared) && declared > maxBytes) || actual > maxBytes) {
      return res.status(413).json({ error: 'payload too large', max_bytes: maxBytes });
    }

    // 5. Shape.
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be a JSON object' });
    }
    const conversationId = String(body.id ?? body.conversation_id ?? body.memory_id ?? '').trim();
    if (!conversationId) {
      return res.status(400).json({ error: 'conversation id missing — expected id, conversation_id or memory_id' });
    }

    // 6. Rate.
    if (rateLimited(uid, { limit: getRateLimitPerMin(cfgEnv) })) {
      return res.status(429).json({ error: 'rate limit exceeded', conversation_id: conversationId });
    }

    try {
      const out = await ingest(body, { db, env: cfgEnv });
      return res.json(out);
    } catch (err) {
      if (err instanceof OmiBadRequest) return res.status(400).json({ error: err.message, conversation_id: conversationId });
      console.error(`[Omi] ingest failed for conversation ${conversationId}: ${err.message}`);
      return res.status(500).json({ error: 'ingest failed', conversation_id: conversationId });
    }
  });

  console.log(
    `[Omi] Routes: POST ${OMI_INGEST_PATH} — mode=${getOmiMode(env)} ` +
    `webhook=${String(env.OMI_WEBHOOK_ENABLED || 'false').toLowerCase() === 'true' ? 'on' : 'off'} ` +
    `(Bearer OMI_INGEST_TOKEN + X-Omi-Token + X-Omi-Uid; ${allowedUids(env).length} uid(s) allowed, ` +
    `${getMaxBodyBytes(env)} byte cap, ${getRateLimitPerMin(env)}/min)`
  );
}

export default { registerOmiRoutes, omiBodyParser, OMI_INGEST_PATH };
