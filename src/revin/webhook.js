/**
 * POST /webhooks/revin — src/revin/webhook.js (2026-10-19)
 *
 * Revin AI posts its texts, the lead's replies and status / opt-out events
 * here. Store first, answer fast, process after:
 *   - Auth: X-Revin-Secret must equal REVIN_WEBHOOK_SECRET (constant time,
 *     safeEqual). An unset secret refuses everything (fail closed). Deliberately
 *     NOT checkRequestSecret: production runs AUTH_SOFT_LAUNCH, which let a
 *     token-less request through on the VDR route (2026-10-15).
 *   - The raw bytes are kept (express.raw, 256 KB, mounted ahead of the global
 *     parsers in src/index.js); payload_hash = sha256 of those bytes, UNIQUE, so
 *     a retried delivery is one row (answered 200, duplicate).
 *   - A body we cannot parse is still stored ({ _raw_text }) and answered 200:
 *     the processing marks it, the relink job alerts. Only a failed STORE is a
 *     5xx, so Revin retries something we never kept.
 *   - Processing (src/revin/process.js) runs after the answer in
 *     trackBackground, so a deploy drains it.
 * Nothing here sends a message or creates a contact.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import supabaseDefault from '../supabase.js';
import { trackBackground } from '../graceful-shutdown.js';
import { safeEqual } from '../auth.js';
import { processRevinEvent } from './process.js';

export const REVIN_WEBHOOK_PATH = '/webhooks/revin';
export const SECRET_HEADER = 'x-revin-secret';
export const RATE_LIMIT_PER_MIN = 300;

// Headers never stored: the secret itself and anything credential-shaped.
const DROP_HEADERS = new Set([SECRET_HEADER, 'authorization', 'cookie', 'proxy-authorization']);

// type: () => true, not '*/*': a POST with no Content-Type would otherwise
// skip the parser and arrive as {} (its body lost), and Revin's headers are unknown.
export function revinRawBodyParser() {
  return express.raw({ type: () => true, limit: '256kb' });
}

// ─── Rate limit ──────────────────────────────────────────────────────────
// Fixed one-minute window per IP, in memory: one Railway instance, and the
// limit exists to stop a loop, not to meter (same shape as omi-routes.js).
const buckets = new Map();

export function rateLimited(key, { limit = RATE_LIMIT_PER_MIN, now = Date.now() } = {}) {
  const windowStart = Math.floor(now / 60_000);
  const b = buckets.get(key);
  if (!b || b.window !== windowStart) {
    buckets.set(key, { window: windowStart, count: 1 });
    if (buckets.size > 1000) for (const [k, v] of buckets) if (v.window < windowStart) buckets.delete(k);
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

/** Test helper — drop every counter. */
export function resetRateLimit() { buckets.clear(); }

/**
 * The caller's IP. This app sets no 'trust proxy', so req.ip is Railway's
 * edge for everyone; the edge appends the real client as the LAST
 * X-Forwarded-For entry (the leftmost ones are whatever the sender typed).
 */
export function clientIp(req) {
  const xff = String(req?.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : String(req?.ip || req?.socket?.remoteAddress || 'unknown');
}

/** The headers to keep, secret removed. Pure. */
export function storableHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!DROP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Raw bytes → the JSON we store. Never throws. Pure. */
export function parseBody(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : (typeof raw === 'string' ? raw : (raw == null ? '' : JSON.stringify(raw)));
  if (!text.trim()) return { payload: { _raw_text: '' }, parsed: false };
  try {
    const v = JSON.parse(text);
    return { payload: v !== null && typeof v === 'object' ? v : { _raw_text: text }, parsed: v !== null && typeof v === 'object' };
  } catch {
    return { payload: { _raw_text: text }, parsed: false };
  }
}

export function makeRevinWebhookHandler({ env = process.env, deps = {} } = {}) {
  return async (req, res) => {
    const supabase = deps.supabase || supabaseDefault;
    const track = deps.trackBackground || trackBackground;
    const process_ = deps.processRevinEvent || processRevinEvent;
    const now = deps.now || Date.now;

    if (rateLimited(clientIp(req), { now: now() })) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    const secret = env.REVIN_WEBHOOK_SECRET;
    const provided = req.headers?.[SECRET_HEADER];
    if (!secret || !safeEqual(String(provided || ''), String(secret))) {
      console.warn(`[Revin] webhook refused: ${secret ? 'bad or missing secret' : 'REVIN_WEBHOOK_SECRET unset'}`);
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const rawBytes = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
    const { payload, parsed } = parseBody(req.body);
    const payloadHash = createHash('sha256').update(rawBytes).digest('hex');

    const { data, error } = await supabase.from('revin_events_raw').insert({
      headers: storableHeaders(req.headers),
      payload,
      payload_hash: payloadHash,
      process_status: 'pending',
    }).select('id').maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(200).json({ ok: true, duplicate: true });
      console.warn(`[Revin] webhook store failed: ${error.message}`);
      return res.status(500).json({ ok: false, error: 'store_failed' });
    }
    const rawId = data?.id;
    res.status(200).json({ ok: true, id: rawId || null, parsed });
    if (rawId) {
      track((async () => {
        try {
          const out = await process_(rawId);
          console.log(`[Revin] ${rawId}: ${out.status} (${out.rows} row${out.rows === 1 ? '' : 's'})`);
        } catch (err) {
          console.error(`[Revin] processing threw: ${err.message}`);
        }
      })());
    }
  };
}

export function registerRevinWebhookRoutes(app, env = process.env) {
  app.post(REVIN_WEBHOOK_PATH, makeRevinWebhookHandler({ env }));
  if (!env.REVIN_WEBHOOK_SECRET) console.warn('[Revin] REVIN_WEBHOOK_SECRET unset — POST /webhooks/revin refuses every request');
}
