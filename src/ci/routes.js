/**
 * Call Intelligence routes — src/ci/routes.js
 *
 * PR 2 endpoints: /ci/discover, /ci/tick, /ci/backfill. The review and health
 * surfaces (§11) land with PRs 4 and 6.
 *
 * House pattern (src/jobs/capacity-bands.js): export
 * registerCiRoutes(app, authenticate), build a `guards` array so the module
 * works with or without middleware, spread it per route, try/catch each
 * handler, and log the registered routes — including a loud marker when no
 * auth was supplied.
 */

import express from 'express';

import supabase from '../supabase.js';
import { getConfig } from './config.js';
import { discoverCalls } from './discovery.js';
import { runTick } from './worker.js';
import { createManualAdapter, storeAudio, sha256Hex, describeRecording } from './recordings.js';

const LOG = '[CIRoutes]';

/** Typed validation error → 400, matching the BadRequest idiom. */
export class BadRequest extends Error {}

/**
 * Parse a window bound. Accepts an ISO datetime or a plain YYYY-MM-DD date.
 * Rejects anything else rather than letting `new Date()` produce Invalid Date
 * and pulling a nonsense window.
 */
export function parseBound(value, label) {
  const s = String(value ?? '').trim();
  if (!s) throw new BadRequest(`${label} is required`);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw new BadRequest(`${label} is not a valid date/datetime`);
  return d;
}

/** Guard the discovery span so one call cannot crawl a year by accident. */
export const MAX_DISCOVER_DAYS = 31;

export function assertSpan(from, to) {
  if (to.getTime() <= from.getTime()) throw new BadRequest('to must be after from');
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_DISCOVER_DAYS) {
    throw new BadRequest(`window is ${Math.round(days)} days; the cap is ${MAX_DISCOVER_DAYS} — split the backfill`);
  }
}

export function registerCiRoutes(app, authenticate) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];

  // Audio bodies: WAV, raw bytes. Route-scoped because the global
  // express.json() sits at its default 100 KB and must stay there.
  const rawAudio = express.raw({ type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'], limit: '64mb' });

  /**
   * POST /ci/discover { from, to, window_hours? }
   * Pull the Call Log for a window and upsert ci_calls. Idempotent.
   */
  app.post('/ci/discover', ...guards, async (req, res) => {
    try {
      const from = parseBound(req.body?.from, 'from');
      const to = parseBound(req.body?.to, 'to');
      assertSpan(from, to);
      const windowHours = Math.max(1, Math.min(12, parseInt(req.body?.window_hours ?? '6', 10) || 6));
      res.json(await discoverCalls({ from, to, windowHours }));
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ ok: false, error: err.message });
      console.error(`${LOG} POST /ci/discover failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ci/tick — claim a batch and advance each call one stage.
   * Also driven by the internal interval; the endpoint is the n8n
   * belt-and-suspenders trigger.
   */
  app.post('/ci/tick', ...guards, async (req, res) => {
    try {
      const limit = req.body?.limit ? Math.max(1, Math.min(100, parseInt(req.body.limit, 10) || 0)) : undefined;
      res.json(await runTick({ limit }));
    } catch (err) {
      console.error(`${LOG} POST /ci/tick failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ci/backfill?five9_call_id=... — manual audio for a known call.
   *
   * For gaps the crawl cannot close: a recording that never landed, or one
   * whose filename will not parse. The bytes go to the same bucket and the
   * same table as an SFTP pull, with source='manual' so the provenance
   * difference stays visible forever.
   */
  app.post('/ci/backfill', ...guards, rawAudio, async (req, res) => {
    try {
      const five9CallId = String(req.query.five9_call_id || req.query.call_id || '').trim();
      if (!five9CallId) throw new BadRequest('five9_call_id query parameter is required');
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new BadRequest('POST the raw WAV bytes as the request body (Content-Type: audio/wav)');
      }

      const db = supabase;
      if (!db) throw new Error('Supabase not configured');

      const { data: call, error: callErr } = await db
        .from('ci_calls').select('*').eq('five9_call_id', five9CallId).maybeSingle();
      if (callErr) throw new Error(`ci_calls lookup failed: ${callErr.message}`);
      if (!call) throw new BadRequest(`no ci_calls row for five9_call_id ${five9CallId} — discover it first`);

      const manual = createManualAdapter();
      const buffer = await manual.fetch({ buffer: req.body });
      const stored = await storeAudio({ callId: call.id, buffer, filename: `manual-${five9CallId}.wav`, db });

      // source_path is the table's unique key and a manual upload has no
      // remote path, so synthesize a stable one from the content hash. Two
      // uploads of the same bytes collapse to one row; different bytes for the
      // same call are two rows, which is the honest representation.
      const sourcePath = `manual://${five9CallId}/${stored.sha256}`;
      const { error } = await db.from('ci_recordings').upsert({
        call_id: call.id,
        source: 'manual',
        source_path: sourcePath,
        source_filename: String(req.query.filename || `manual-${five9CallId}.wav`),
        file_sha256: stored.sha256,
        file_bytes: stored.bytes,
        mime: 'audio/wav',
        storage_path: stored.storagePath,
        match_method: 'manual',
        match_confidence: 1,
        excluded: false,
      }, { onConflict: 'source_path' });
      if (error) throw new Error(`ci_recordings upsert failed: ${error.message}`);

      // Only advance a call that is still waiting for audio. A later-stage
      // call must not be dragged backwards by a backfill.
      let advanced = false;
      if (call.status === 'discovered' || call.status === 'review') {
        const { error: updErr } = await db.from('ci_calls').update({
          status: 'fetched',
          review_reason: null,
          next_retry_at: null,
          locked_until: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        }).eq('id', call.id);
        if (updErr) throw new Error(`ci_calls advance failed: ${updErr.message}`);
        advanced = true;
      }

      await db.from('ci_events').insert({
        call_id: call.id,
        stage: 'fetch',
        event: 'transition',
        detail: { source: 'manual', sha256: stored.sha256, bytes: stored.bytes, advanced },
      });

      console.log(`${LOG} backfill: call ${call.id} ← ${stored.bytes}B (sha ${stored.sha256.slice(0, 12)})${advanced ? ' → fetched' : ' (status unchanged)'}`);
      res.json({ ok: true, call_id: call.id, sha256: stored.sha256, bytes: stored.bytes, advanced });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ ok: false, error: err.message });
      console.error(`${LOG} POST /ci/backfill failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  const cfg = getConfig();
  console.log(
    `${LOG} Routes: POST /ci/discover, POST /ci/tick, POST /ci/backfill` +
    `${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}` +
    ` [mode=${cfg.mode}, sftp=${cfg.sftp.readOnly ? 'read-only' : 'WRITABLE — MISCONFIGURED'}]`,
  );
}

export const _internal = { sha256Hex, describeRecording };
export default { registerCiRoutes };
