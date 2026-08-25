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
import { createSftpAdapter, createManualAdapter, storeAudio, sha256Hex, describeRecording, ensureLinkToken, transcodeAndStoreMp3 } from './recordings.js';
import { CI_AUDIO_BUCKET } from '../../scripts/setup-ci-audio-bucket.js';
import { reconcileDay, pipelineHealth } from './reconcile.js';
import { auditLpNotes } from './verify.js';
import { releaseShadowSyncs } from './shadow-release.js';
import { diagnoseRecordingGap } from './recording-diagnosis.js';
import {
  runDiscoveryTick, discoverySchedulerStatus,
} from '../jobs/ci-discovery-scheduler.js';

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

/**
 * Where a reviewed call should resume, based on what it actually produced.
 *
 * Walks backwards from the last artifact: a current summary means analysis
 * succeeded, so re-run matching; a transcript means re-run analysis; a
 * recording means re-run transcription; nothing means start at the fetch.
 *
 * Deriving from artifacts rather than from review_reason means a renamed
 * reason string cannot silently send a call back to the wrong stage — and a
 * call that was reviewed for a reason unrelated to its stage (a DNC flag, say)
 * still resumes where it left off instead of re-transcribing from scratch.
 */
export async function resumeStatusFor(db, callId) {
  const has = async (table, extra = (q) => q) => {
    const { data, error } = await extra(db.from(table).select('call_id').eq('call_id', callId)).limit(1);
    if (error) throw new Error(`${table} probe failed: ${error.message}`);
    return (data || []).length > 0;
  };
  if (await has('ci_summaries', (q) => q.eq('is_current', true))) return 'analyzed';
  if (await has('ci_transcripts')) return 'transcribed';
  if (await has('ci_recordings')) return 'fetched';
  return 'discovered';
}

/**
 * Store one manually-uploaded recording against a known call.
 *
 * ══ EXTRACTED SO IT CAN BE TESTED ══
 * Same reasoning as applyResolve() below: this was inline in the POST
 * /ci/backfill handler, which reads the module-level supabase client and so
 * could not be driven from a test at all. That is exactly how it came to be
 * the ONE audio path that stored a WAV and never produced the MP3 derivative —
 * a manual upload got a link that opens and plays nothing, which is the very
 * failure sql/070 exists to fix. An untested storage path is what let that sit.
 *
 * Everything is injected, so the whole shape of what gets written is
 * assertable without a live Supabase.
 *
 * @returns {Promise<{sourcePath, sha256, bytes, mp3Bytes, mp3Error, advanced}>}
 */
export async function storeManualRecording({ db, call, buffer, five9CallId, filename = null }) {
  const manual = createManualAdapter();
  const bytes = await manual.fetch({ buffer });
  const wavName = `manual-${five9CallId}.wav`;
  const stored = await storeAudio({ callId: call.id, buffer: bytes, filename: wavName, db });

  // A manual upload is audio like any other and gets an MP3 like any other.
  // The bytes a human uploads are usually a Five9 export, i.e. the same GSM
  // 6.10 no browser decodes. Never throws — a failed transcode leaves
  // mp3_storage_path null and the route falls back to serving the WAV.
  const mp3 = await transcodeAndStoreMp3({
    callId: call.id, buffer: bytes, sha: stored.sha256, filename: wavName, db,
  });

  // source_path is the table's unique key and a manual upload has no remote
  // path, so synthesize a stable one from the content hash. Two uploads of the
  // same bytes collapse to one row; different bytes for the same call are two
  // rows, which is the honest representation.
  const sourcePath = `manual://${five9CallId}/${stored.sha256}`;
  const { error } = await db.from('ci_recordings').upsert({
    call_id: call.id,
    source: 'manual',
    source_path: sourcePath,
    source_filename: String(filename || wavName),
    file_sha256: stored.sha256,
    file_bytes: stored.bytes,
    // mime still describes the ORIGINAL. The derivative is additive and the
    // WAV remains the archival copy and the transcription input.
    mime: 'audio/wav',
    storage_path: stored.storagePath,
    mp3_storage_path: mp3.mp3StoragePath,
    mp3_bytes: mp3.mp3Bytes,
    match_method: 'manual',
    match_confidence: 1,
    excluded: false,
  }, { onConflict: 'source_path' });
  if (error) throw new Error(`ci_recordings upsert failed: ${error.message}`);

  // A manual backfill is audio like any other and gets a link too.
  await ensureLinkToken({ sourcePath, db });

  // Only advance a call that is still waiting for audio. A later-stage call
  // must not be dragged backwards by a backfill.
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
    detail: { source: 'manual', sha256: stored.sha256, bytes: stored.bytes, advanced, mp3_bytes: mp3.mp3Bytes },
  });

  return {
    sourcePath,
    sha256: stored.sha256,
    bytes: stored.bytes,
    mp3Bytes: mp3.mp3Bytes,
    mp3Error: mp3.error,
    advanced,
  };
}

/** The four things a human can decide about a reviewed call. */
export const RESOLVE_ACTIONS = new Set(['set_match', 'skip', 'retry', 'fail']);

/**
 * Apply one review resolution to one call.
 *
 * ══ THIS IS THE ONLY IMPLEMENTATION ══
 * Extracted out of the POST /ci/review/:call_id/resolve handler so the
 * endpoint and scripts/requeue-ci-review.js run the SAME code, not two
 * implementations that agree today. A bulk requeue written as its own UPDATE
 * is how `attempts = 0` gets forgotten, or a call gets sent back to the wrong
 * stage — and neither failure announces itself; the calls just quietly
 * re-fail or re-buy a transcript that already exists.
 *
 * `retry` resumes from the furthest stage the call actually reached, derived
 * from the artifacts on disk by resumeStatusFor() — not from a remembered
 * status (ci_calls has no such column) and not from review_reason, which would
 * break the moment a reason string is renamed.
 *
 * Writes ci_calls and ci_events, and ci_matches on set_match. Throws
 * BadRequest on a set_match that names no record.
 *
 * @returns {Promise<{status: string, patch: object}>}
 */
export async function applyResolve(db, call, action, { note = null, cstId = null, ldsId = null, ghlId = null } = {}) {
  if (!RESOLVE_ACTIONS.has(action)) {
    throw new BadRequest(`action must be one of ${[...RESOLVE_ACTIONS].join('|')}`);
  }
  const callId = call.id;

  let nextStatus;
  if (action === 'set_match') {
    if (cstId == null && ldsId == null && !ghlId) {
      // A "correction" that names no record is not a correction. Refusing is
      // better than writing an empty human match that later reads as an
      // authoritative decision.
      throw new BadRequest('set_match needs at least one of lp_cst_id, lp_lds_id, ghl_contact_id');
    }
    const { error: mErr } = await db.from('ci_matches').insert({
      call_id: callId,
      lp_cst_id: cstId ?? null,
      lp_lds_id: ldsId ?? null,
      ghl_contact_id: ghlId ?? null,
      method: 'human_review',
      tier: 'exact',
      confidence: 1.0,
      candidates: [],
      evidence: { note: note ?? null, resolved_via: 'POST /ci/review/:call_id/resolve' },
      decided_by: 'human',
    });
    if (mErr) throw new Error(`ci_matches insert failed: ${mErr.message}`);
    nextStatus = 'matched';
  } else if (action === 'skip') {
    nextStatus = 'skipped';
  } else if (action === 'retry') {
    nextStatus = await resumeStatusFor(db, callId);
  } else {
    nextStatus = 'failed';
  }

  const patch = {
    status: nextStatus,
    review_reason: action === 'fail' ? (note || call.review_reason) : null,
    status_detail: note ? String(note).slice(0, 500) : null,
    locked_until: null,
    locked_by: null,
    next_retry_at: null,
  };
  // A retried call starts its attempt budget over. Without this a call that
  // already burned its attempts comes straight back to 'failed' on the first
  // hiccup, and the requeue looks like it did nothing.
  if (action === 'retry') patch.attempts = 0;

  const { error: upErr } = await db.from('ci_calls').update(patch).eq('id', callId);
  if (upErr) throw new Error(`ci_calls update failed: ${upErr.message}`);

  await db.from('ci_events').insert({
    call_id: callId,
    stage: 'review',
    event: 'resolved',
    detail: { action, to: nextStatus, by: 'human', has_note: Boolean(note) },
  });

  return { status: nextStatus, patch };
}

/**
 * Fixed-window per-IP limiter for the public recording route.
 *
 * In-memory and deliberately dependency-free — the repo has no rate-limit
 * package and this needs no shared state to do its job. It is NOT a general
 * limiter and is not offered as one: its single purpose is to blunt online
 * token guessing on /ci/rec/:token.
 *
 * Note what it is worth and what it is not. A 256-bit token is not going to
 * fall to brute force at any rate, so this is defence in depth, not the
 * defence — it caps the noise, keeps a scan out of the logs, and stops one
 * host burning the signed-URL path. Per-process, so N replicas allow N × the
 * limit; that is acceptable for the same reason.
 */
export const REC_RATE_LIMIT = 30;          // requests
export const REC_RATE_WINDOW_MS = 60_000;  // per IP, per minute

export function createRateLimiter({ limit = REC_RATE_LIMIT, windowMs = REC_RATE_WINDOW_MS } = {}) {
  const hits = new Map();   // ip -> { count, resetAt }
  return function allow(ip, now = Date.now()) {
    const key = String(ip || 'unknown');
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      // Opportunistic sweep so a scan from many source addresses cannot grow
      // this map without bound.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/** How long a minted Storage signed URL stays valid. */
export const REC_SIGNED_URL_TTL_S = 300;

/** First 8 chars only — enough to correlate a log line, useless as a key. */
export function tokenPrefix(token) {
  return String(token || '').slice(0, 8);
}

/** The exact shape mintLinkToken() produces: 32 bytes of base64url. */
export const REC_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * GET /ci/rec/:token — the ONE public surface in this subsystem.
 *
 * ══ THIS HANDLER IS DELIBERATELY OUTSIDE THE AUTH GUARDS ══
 * Decision record (Mark, 2026-08-24): recording links work for anyone holding
 * them, no login, because a rep has to be able to forward a note and have the
 * link still open. Security therefore rests ENTIRELY on the token being
 * unguessable — 32 random bytes, minted in recordings.js, derived from
 * nothing. Everything below follows from that being the only defence:
 *
 *  - THE TOKEN IS THE ONLY LOOKUP KEY. No call_id, no five9_call_id, no
 *    storage path, no date. Accepting a second key would create a way in that
 *    is not the unguessable one.
 *  - UNKNOWN, EXPIRED AND PURGED ALL RETURN THE SAME BARE 404. A
 *    distinguishable "expired" or "purged" confirms the token was real, which
 *    turns a blind guess into an oracle. Same status, same body, every time —
 *    including when something fails internally.
 *  - NO LISTING, NO ENUMERATION, NO RANGES. One token, one object. There is no
 *    index route and there must never be one.
 *  - THE BUCKET STAYS PRIVATE. This mints a short-lived signed URL and
 *    redirects; ci-audio is never made public and gets no public policy.
 *    setup-ci-audio-bucket.js exits 1 on a public bucket — keep that true.
 *  - ONLY THE TOKEN PREFIX IS LOGGED. A whole token in a log line is a
 *    credential in a log line.
 *
 * A factory rather than an inline handler so the db, the limiter and the clock
 * are injectable: the guarantees above are exactly the kind that rot silently,
 * and they are only testable if this is reachable without a live Supabase.
 */
export function createRecordingHandler({
  db = null,
  allow = createRateLimiter(),
  signedTtlS = REC_SIGNED_URL_TTL_S,
  now = () => Date.now(),
} = {}) {
  return async function handleRecording(req, res) {
    // ONE bare 404 for every miss — see the oracle note above.
    const notFound = () => res.status(404).type('text/plain').send('Not found');

    const token = String(req.params?.token || '');
    const prefix = tokenPrefix(token);
    try {
      if (!allow(req.ip)) {
        console.warn(`${LOG} GET /ci/rec rate-limited ip=${req.ip} token=${prefix}…`);
        return res.status(429).type('text/plain').send('Too many requests');
      }

      // Shape check before touching the database. This tells a scanner nothing
      // it could not read in this file, and saves a query per junk request.
      if (!REC_TOKEN_RE.test(token)) return notFound();

      const client = db || supabase;
      if (!client) throw new Error('Supabase not configured');

      // DEPLOY-BEFORE-DDL GRACE, the same pattern claimBatch() uses for
      // sql/063. This is the ONE public route in the subsystem, and it fails
      // closed: an unknown column would surface as a caught error and turn
      // EVERY recording link into a 404 — a worse regression than the
      // unplayable audio this PR exists to fix. So a missing mp3 column
      // degrades to the pre-070 read instead of breaking the route, and says
      // so once per request rather than silently.
      let rec;
      let { data, error } = await client
        .from('ci_recordings')
        .select('id, call_id, storage_path, mp3_storage_path, link_expires_at, purged_at')
        .eq('link_token', token)
        .maybeSingle();
      if (error && /mp3_storage_path|column .* does not exist|42703|schema cache/i.test(error.message || '')) {
        console.warn(`${LOG} ci_recordings.mp3_storage_path is missing — serving WAVs until sql/070 is applied`);
        ({ data, error } = await client
          .from('ci_recordings')
          .select('id, call_id, storage_path, link_expires_at, purged_at')
          .eq('link_token', token)
          .maybeSingle());
      }
      if (error) throw new Error(`ci_recordings lookup failed: ${error.message}`);
      rec = data;

      if (!rec) return notFound();
      if (rec.purged_at) return notFound();
      // Gated on the WAV, deliberately, NOT on whichever object is about to be
      // served. storage_path is the original and is what "this recording still
      // exists" means; a row with no WAV has been purged or never landed, and
      // must 404 whatever the derivative column says.
      if (!rec.storage_path) return notFound();
      if (rec.link_expires_at && new Date(rec.link_expires_at).getTime() <= now()) return notFound();

      // ══ PREFER THE MP3, FALL BACK TO THE WAV ══
      // Five9's WAVs are GSM 6.10 (format tag 0x0031), which no browser will
      // decode — the link opened and nothing played. The MP3 derivative is
      // uploaded with contentType 'audio/mpeg', so the redirect carries the
      // right type from Storage. A null here is a NORMAL state (ingested
      // before sql/070, or a transcode that failed) and serving the WAV is
      // exactly the behaviour that shipped before, not a degradation.
      //
      // ONE ROUTE, ONE TOKEN. There is deliberately no ?format= — a second
      // way to name the object is a second way in that is not the token.
      const objectPath = rec.mp3_storage_path || rec.storage_path;

      const { data: signed, error: signErr } = await client.storage
        .from(CI_AUDIO_BUCKET)
        .createSignedUrl(objectPath, signedTtlS);
      if (signErr || !signed?.signedUrl) {
        throw new Error(`signed URL failed: ${signErr?.message || 'no url returned'}`);
      }

      console.log(
        `${LOG} rec token=${prefix}… → call ${rec.call_id} ` +
        `(${rec.mp3_storage_path ? 'mp3' : 'wav — not transcoded, may not play'}, signed ${signedTtlS}s)`,
      );
      return res.redirect(302, signed.signedUrl);
    } catch (err) {
      // Even an internal failure must not describe itself: an error string
      // that differs between a real and a fake token is an oracle too.
      console.error(`${LOG} GET /ci/rec/${prefix}… failed: ${err.message}`);
      return res.status(404).type('text/plain').send('Not found');
    }
  };
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
   * GET /ci/verify-notes?status=&limit=&marker= — ask LP what it actually has.
   *
   * READ ONLY, on both sides: it reads ci_syncs and it reads Lead Perfection.
   * There is no write path through this route.
   *
   * It exists as an endpoint and not only as a CLI because answering "did the
   * notes land" should never require anyone to copy LP credentials onto a
   * laptop. The deployed service already holds them; this asks it to look.
   *
   * `limit` caps PROSPECTS read, not rows returned — one GetLead covers every
   * note on a person. Default 25; `limit=0` sweeps every prospect and can take
   * minutes on a large backlog.
   */
  app.get('/ci/verify-notes', ...guards, async (req, res) => {
    try {
      const raw = req.query?.limit;
      const parsed = raw === undefined ? 25 : parseInt(raw, 10);
      // 0 (or a nonsense value paired with an explicit ?limit=) means "all" —
      // auditLpNotes reads a falsy limit as no cap.
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : null;
      res.json(await auditLpNotes({
        db: supabase,
        status: String(req.query?.status || 'synced'),
        marker: req.query?.marker ? String(req.query.marker) : null,
        limit,
      }));
    } catch (err) {
      console.error(`${LOG} GET /ci/verify-notes failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /ci/discovery/status — is the poller armed, and where is its cursor?
   *
   * The first thing to look at when calls stop arriving. Reports the cursor,
   * the quiet window, consecutive failures and the Five9 auth breaker, which is
   * the most likely reason a poller has gone quiet without erroring.
   */
  app.get('/ci/discovery/status', ...guards, (req, res) => {
    try {
      res.json(discoverySchedulerStatus());
    } catch (err) {
      console.error(`${LOG} GET /ci/discovery/status failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ci/discovery/run — pull once, now.
   *
   * Bypasses CI_DISCOVERY_ENABLED and quiet hours so the scheduler can be
   * proven working before it is armed. It deliberately does NOT bypass the
   * Five9 auth breaker: a human asking for a pull is not evidence that the
   * credential is right, and an unattended retry loop against a bad password
   * locks the account the whole floor dials on.
   */
  app.post('/ci/discovery/run', ...guards, async (req, res) => {
    try {
      res.json(await runDiscoveryTick({ force: true }));
    } catch (err) {
      console.error(`${LOG} POST /ci/discovery/run failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ci/release-shadow-syncs?execute=true&target=lp
   *
   * Gives back the write that shadow mode consumed. claimSync inserts the
   * ci_syncs row — with its idempotency key — before it knows whether the write
   * will go out, so every call processed while CALL_INTEL_LP_WRITES was false
   * permanently spent its one chance. Turning the flag on delivers nothing for
   * those calls without this.
   *
   * DRY-RUN unless ?execute=true. Read the dry run first: it lists what would be
   * released and, more importantly, what is REFUSED and why.
   *
   * See src/ci/shadow-release.js for why releasing these cannot double-post —
   * the proof is that the row was written on the branch that returns before the
   * request exists.
   */
  app.post('/ci/release-shadow-syncs', ...guards, async (req, res) => {
    try {
      const execute = String(req.query?.execute ?? '').toLowerCase() === 'true';
      const target = String(req.query?.target || 'lp');
      res.json(await releaseShadowSyncs({ db: supabase, target, execute }));
    } catch (err) {
      console.error(`${LOG} POST /ci/release-shadow-syncs failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /ci/diagnose-recordings?limit=25 — why calls with audio got no summary.
   *
   * READ ONLY on both sides: it reads ci_calls and it LISTS the recording
   * archive. Nothing is fetched, re-ingested, re-queued or changed.
   *
   * `recording_missing` is the largest review reason, and 93 of those have a
   * Call Log row saying audio EXISTS — plus 20 ambiguous, so 113 recoverable
   * summaries. Every recording that WAS ingested linked correctly (0 unlinked
   * across every campaign), so this is a retrieval gap, not a matching one.
   *
   * The verdicts name four different fixes and are deliberately not collapsed
   * into "missing". `unknown` means the archive could not be read and is never
   * counted as a cause.
   */
  app.get('/ci/diagnose-recordings', ...guards, async (req, res) => {
    try {
      const parsed = parseInt(req.query?.limit, 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
      const adapter = createSftpAdapter({ cfg: getConfig() });
      res.json(await diagnoseRecordingGap({ db: supabase, adapter, limit }));
    } catch (err) {
      console.error(`${LOG} GET /ci/diagnose-recordings failed: ${err.message}`);
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

      const out = await storeManualRecording({
        db, call, buffer: req.body, five9CallId, filename: req.query.filename,
      });

      console.log(`${LOG} backfill: call ${call.id} ← ${out.bytes}B (sha ${out.sha256.slice(0, 12)})`
        + `${out.mp3Bytes ? `, mp3 ${out.mp3Bytes}B` : ', NO mp3 (link will serve the original)'}`
        + `${out.advanced ? ' → fetched' : ' (status unchanged)'}`);
      // mp3_bytes null tells the uploader their link will serve the original
      // and may not play, instead of leaving them to discover it by clicking.
      res.json({
        ok: true, call_id: call.id, sha256: out.sha256, bytes: out.bytes, advanced: out.advanced,
        mp3_bytes: out.mp3Bytes,
        ...(out.mp3Error ? { mp3_error: out.mp3Error.slice(0, 200) } : {}),
      });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ ok: false, error: err.message });
      console.error(`${LOG} POST /ci/backfill failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /ci/review — the queue, newest first.
   *
   * Reads v_ci_review_queue (sql/061). Deliberately does NOT return transcript
   * text or note bodies: §10 keeps call content out of anything but the
   * dedicated read, and this endpoint exists to triage, not to browse
   * conversations.
   */
  app.get('/ci/review', ...guards, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
      const { data, error } = await supabase
        .from('v_ci_review_queue')
        .select('*')
        .order('call_start', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      res.json({ ok: true, count: (data || []).length, rows: data || [] });
    } catch (err) {
      console.error(`${LOG} GET /ci/review failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ci/review/:call_id/resolve { action, lp_cst_id?, lp_lds_id?,
   *                                    ghl_contact_id?, note }
   *
   * A human's ruling on a queued call. §11 actions:
   *   set_match  record the correct IDs and re-queue for sync
   *   skip       this call should never sync (wrong number, test, personal)
   *   retry      put it back at its current stage and let the worker re-run
   *   fail       give up on it, with the reason on the record
   *
   * set_match writes a ci_matches row with decided_by='human'. That row does
   * not overwrite the matcher's ('auto') — both are kept, and the human one is
   * newer, so the audit trail shows what the matcher thought AND what a person
   * decided. 'auto' and 'human' are the only two values the column's CHECK
   * admits (sql/061).
   */
  app.post('/ci/review/:call_id/resolve', ...guards, async (req, res) => {
    try {
      const callId = String(req.params.call_id || '').trim();
      if (!callId) throw new BadRequest('call_id is required');

      const { action, lp_cst_id: cstId, lp_lds_id: ldsId, ghl_contact_id: ghlId, note } = req.body || {};
      if (!RESOLVE_ACTIONS.has(action)) {
        throw new BadRequest(`action must be one of ${[...RESOLVE_ACTIONS].join('|')}`);
      }

      const { data: call, error: callErr } = await supabase
        .from('ci_calls').select('*').eq('id', callId).maybeSingle();
      if (callErr) throw new Error(callErr.message);
      if (!call) throw new BadRequest(`no ci_calls row for id ${callId}`);

      const { status: nextStatus } = await applyResolve(supabase, call, action, { note, cstId, ldsId, ghlId });

      console.log(`${LOG} review resolve: call ${callId} ${action} → ${nextStatus}`);
      res.json({ ok: true, call_id: callId, action, status: nextStatus });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ ok: false, error: err.message });
      console.error(`${LOG} POST /ci/review/:call_id/resolve failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /ci/reconcile { date }
   *
   * Completeness check for one day against the Call Log's own RECORDINGS
   * column. Idempotent: a re-run over an unchanged day records nothing new.
   */
  app.post('/ci/reconcile', ...guards, async (req, res) => {
    try {
      const date = String(req.body?.date ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest('date must be YYYY-MM-DD');
      const summary = await reconcileDay({ date });
      res.json({ ok: true, ...summary });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ ok: false, error: err.message });
      console.error(`${LOG} POST /ci/reconcile failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /ci/health — status histogram, sync counts, gaps, estimated spend.
   *
   * Reports the WRITE POSTURE alongside the counts. "Why did nothing sync?" is
   * answered by mode=shadow far more often than by a fault, and a health
   * endpoint that omits the flags invites a hunt for a bug that is not there.
   */
  app.get('/ci/health', ...guards, async (req, res) => {
    try {
      const sinceHours = Math.min(720, Math.max(1, parseInt(req.query.hours || '24', 10) || 24));
      const health = await pipelineHealth({ sinceHours });
      res.json({ ok: true, ...health });
    } catch (err) {
      console.error(`${LOG} GET /ci/health failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /ci/rec/:token — the ONE public surface in this subsystem.
   *
   * ══ THIS ROUTE IS DELIBERATELY OUTSIDE THE AUTH GUARDS ══
   * Decision record (Mark, 2026-08-24): recording links work for anyone
   * holding them, no login, because a rep has to be able to forward a note.
   * Security therefore rests ENTIRELY on the token being unguessable — 32
   * random bytes, minted in recordings.js, derived from nothing. Everything
   * below follows from that being the only defence:
   *
   *  - THE TOKEN IS THE ONLY LOOKUP KEY. No call_id, no five9_call_id, no
   *    storage path, no date. Accepting a second key would create a way in
   *    that is not the unguessable one.
   *  - UNKNOWN, EXPIRED AND PURGED ALL RETURN THE SAME BARE 404. A
   *    distinguishable "expired" or "purged" confirms the token was real,
   *    which turns a blind guess into an oracle. Same status, same body,
   *    every time.
   *  - NO LISTING, NO ENUMERATION, NO RANGES. One token, one object. There is
   *    no index route and must never be one.
   *  - THE BUCKET STAYS PRIVATE. We mint a short-lived signed URL and
   *    redirect; ci-audio itself is never made public and gets no public
   *    policy. setup-ci-audio-bucket.js exits 1 on a public bucket — keep
   *    that true.
   *  - ONLY THE TOKEN PREFIX IS LOGGED. A full token in a log line is a
   *    credential in a log line.
   */
  app.get('/ci/rec/:token', createRecordingHandler());

  const cfg = getConfig();
  console.log(
    `${LOG} Routes: POST /ci/discover, POST /ci/tick, POST /ci/backfill,` +
    ` GET /ci/review, POST /ci/review/:call_id/resolve,` +
    ` POST /ci/reconcile, GET /ci/health, GET /ci/rec/:token (PUBLIC by design)` +
    `${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}` +
    ` [mode=${cfg.mode}, sftp=${cfg.sftp.readOnly ? 'read-only' : 'WRITABLE — MISCONFIGURED'}]`,
  );
}

export const _internal = { sha256Hex, describeRecording };
export default { registerCiRoutes };
