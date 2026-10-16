/**
 * POST /webhook/siro — src/siro/webhook.js (2026-10-16, Siro PR 1)
 *
 * Siro posts integrations.recordingProcessed and integrations.recordingLinked
 * (docs/siro-reference.md §3). They arrive in either order and every payload
 * carries both flags; we act only when BOTH are true.
 *
 *   - EVERY request passes TWO checks first, in every mode, or gets 401
 *     (the user, 2026-10-16; an unsigned POST must read 401, never 404/503):
 *       a. the svix signature against SIRO_WEBHOOK_SECRET on the RAW body
 *          (express.raw is mounted on this path ahead of the global parsers
 *          in src/index.js);
 *       b. the header x-reece-webhook-key equals SIRO_WEBHOOK_HEADER_KEY,
 *          compared in constant time.
 *     Either variable unset refuses everything (fail closed). Neither secret
 *     nor the header value is ever logged.
 *   - siro_webhook_events is keyed on svix-id: a redelivery is answered 200
 *     and does no work (CANON.K.072).
 *   - The answer goes out first; the fetch / match / store runs after it in
 *     trackBackground so a deploy drains it.
 *   - SIRO_WEBHOOK_MODE off | shadow (default: verify, store, fetch, upsert;
 *     emit nothing, queue nothing) | live.
 */
import crypto from 'node:crypto';
import express from 'express';
import { Webhook } from 'svix';
import supabaseDefault from '../supabase.js';
import { trackBackground } from '../graceful-shutdown.js';
import { processRecording } from './ingest.js';
import { siroConfig, siroModes } from './config.js';

export function siroRawBodyParser() {
  return express.raw({ type: '*/*', limit: '1mb' });
}

/** Pure: should this payload be acted on? */
export function readyToAct(payload) {
  return payload?.recordingProcessed === true && payload?.recordingLinked === true;
}

export const HEADER_KEY_NAME = 'x-reece-webhook-key';

/** Constant-time compare of the shared header key. Never logs either value. */
export function headerKeyMatches(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  // Hash both to a fixed length so timingSafeEqual never sees unequal sizes.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Both checks; either variable unset fails closed. */
export function verifySiroRequest(rawBody, headers, { secret, headerKey }) {
  if (!secret || !headerKey) return { ok: false, status: 401, error: 'webhook not configured' };
  if (!headerKeyMatches(headers[HEADER_KEY_NAME], headerKey)) return { ok: false, status: 401, error: 'bad or missing header key' };
  return verifySiroSignature(rawBody, headers, secret);
}

export function verifySiroSignature(rawBody, headers, secret) {
  if (!secret) return { ok: false, status: 401, error: 'SIRO_WEBHOOK_SECRET unset' };
  if (!Buffer.isBuffer(rawBody)) return { ok: false, status: 400, error: 'raw body missing' };
  if (!headers['svix-id'] || !headers['svix-timestamp'] || !headers['svix-signature']) {
    return { ok: false, status: 401, error: 'signature headers missing' };
  }
  try {
    const payload = new Webhook(secret).verify(rawBody.toString('utf8'), {
      'svix-id': headers['svix-id'],
      'svix-timestamp': headers['svix-timestamp'],
      'svix-signature': headers['svix-signature'],
    });
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 401, error: 'bad signature' };
  }
}

export function makeSiroWebhookHandler({ env = process.env, deps = {} } = {}) {
  return async (req, res) => {
    const supabase = deps.supabase || supabaseDefault;
    const track = deps.trackBackground || trackBackground;
    const mode = siroModes(env).webhook;
    const cfg = siroConfig(env);
    const v = verifySiroRequest(req.body, req.headers || {}, { secret: cfg.webhookSecret, headerKey: cfg.webhookHeaderKey });
    if (!v.ok) {
      console.warn(`[Siro] webhook refused: ${v.error}`);
      return res.status(v.status).json({ ok: false, error: v.error });
    }
    if (mode === 'off') return res.status(200).json({ ok: true, mode: 'off' });
    const p = v.payload || {};
    const svixId = String(req.headers['svix-id'] || '');
    const recordingId = p.recordingId ? String(p.recordingId) : '';
    if (!recordingId) return res.status(200).json({ ok: true, ignored: 'no_recording_id' });

    const { error: insErr } = await supabase.from('siro_webhook_events').insert({
      svix_id: svixId,
      recording_id: recordingId,
      event_type: String(p.eventType || 'unknown'),
      processed_flag: p.recordingProcessed === true,
      linked_flag: p.recordingLinked === true,
    });
    if (insErr) {
      if (insErr.code === '23505') return res.status(200).json({ ok: true, duplicate: true });
      console.warn(`[Siro] webhook event store failed: ${insErr.message}`);
      // Siro retries a 5xx; the poll backstop covers anything lost.
      return res.status(500).json({ ok: false, error: 'store_failed' });
    }
    if (!readyToAct(p)) return res.status(200).json({ ok: true, waiting: 'processed_and_linked' });

    res.status(200).json({ ok: true, accepted: true, mode });
    track((async () => {
      let error = null;
      try {
        const out = await processRecording(recordingId, {
          source: 'webhook', mode, flags: { processed: true, linked: true }, env, deps,
        });
        console.log(`[Siro] webhook ${recordingId}: ${out.result}`);
        if (/failed|not_found|unreadable|no_database/.test(out.result)) error = out.error || out.result;
      } catch (err) {
        error = err.message;
        console.error(`[Siro] webhook processing threw: ${err.message}`);
      }
      await supabase.from('siro_webhook_events').update({ handled: !error, error })
        .eq('svix_id', svixId);
    })());
  };
}

export function registerSiroWebhookRoutes(app, env = process.env) {
  app.post('/webhook/siro', makeSiroWebhookHandler({ env }));
  const cfg = siroConfig(env);
  console.log(`[Siro] webhook route mounted mode=${siroModes(env).webhook}`);
  if (!cfg.webhookSecret || !cfg.webhookHeaderKey) {
    console.warn(`[Siro] webhook refuses every request (401): ${[!cfg.webhookSecret && 'SIRO_WEBHOOK_SECRET', !cfg.webhookHeaderKey && 'SIRO_WEBHOOK_HEADER_KEY'].filter(Boolean).join(' and ')} unset`);
  }
}
