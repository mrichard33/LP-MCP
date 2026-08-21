/**
 * Call Intelligence worker — src/ci/worker.js
 *
 * Claims eligible ci_calls rows, advances each ONE stage per claim, and writes
 * every transition to ci_events. All state lives in Postgres, so a restart
 * mid-batch loses nothing: leases expire and the calls come back.
 *
 * ONE STAGE PER CLAIM is deliberate. A call moves discovered → fetched →
 * transcribed → … one step at a time, and each step commits before the next is
 * attempted. A crash costs one stage, not a whole pipeline run, and a stage
 * that fails repeatedly is visible in ci_calls.attempts rather than hidden
 * inside a long transaction.
 *
 * PR 2 SCOPE: the loop, the lease, backoff, event logging, and the `fetched`
 * stage (recording ingest). Transcription, analysis, matching and CRM sync are
 * PRs 3–5 — their stages are declared here but dispatch to a stub that parks
 * the call rather than pretending to work. A stage that silently no-ops would
 * look like progress in the health view.
 */

import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { getConfig, nextRetryAt } from './config.js';
import { createSftpAdapter, createManualAdapter, describeRecording, matchRecordingToCall, storeAudio, sha256Hex } from './recordings.js';
import { dateDirFor, last4 } from './time.js';

const LOG = '[CIWorker]';

/** Statuses a worker may claim. Terminal/parking states are never claimed. */
export const CLAIMABLE = ['discovered', 'fetched', 'transcribed', 'analyzed', 'matched', 'syncing'];

/** How long a claim is held before it expires and the call becomes claimable again. */
const LEASE_SECONDS = Math.max(60, parseInt(process.env.CI_WORKER_LEASE_SECONDS || '300', 10));

/** Worker identity, for locked_by — makes a stuck lease attributable. */
const WORKER_ID = `${process.env.RAILWAY_SERVICE_NAME || 'lp-mcp'}:${process.pid}`;

/**
 * Append to ci_events. Best-effort: an audit write must never be the reason a
 * stage fails, but a silent failure to audit is itself worth a warning.
 */
export async function logEvent(db, { callId, stage, event, detail }) {
  const { error } = await db.from('ci_events').insert({
    call_id: callId || null,
    stage,
    event,
    detail: detail ?? null,
  });
  if (error) console.warn(`${LOG} ci_events insert failed (${stage}/${event}): ${error.message}`);
}

/**
 * Claim a batch via the SQL function from sql/063.
 *
 * Falls back to a non-claiming SELECT when the function is missing, mirroring
 * the deploy-before-DDL grace in src/actions/index.js. In that mode rows are
 * NOT leased, so the caller must stay single-driver — which is why it warns
 * loudly rather than degrading quietly.
 */
export async function claimBatch({ db = supabase, statuses = CLAIMABLE, limit = 10, leaseSeconds = LEASE_SECONDS, worker = WORKER_ID } = {}) {
  const statusList = statuses.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(',');
  try {
    const rows = await runSQL(
      `select * from claim_ci_calls(ARRAY[${statusList}]::text[], ${Math.max(1, limit)}, ${leaseSeconds}, '${worker.replace(/'/g, "''")}')`,
    );
    return { rows: Array.isArray(rows) ? rows : [], claimed: true };
  } catch (err) {
    const missing = /does not exist|could not find|undefined function|42883|schema cache/i.test(err.message || '');
    if (!missing) throw err;
    console.warn(`${LOG} claim_ci_calls missing — falling back to non-claiming SELECT (single-driver only). Apply sql/063 to enable concurrency.`);
    const { data, error } = await db
      .from('ci_calls')
      .select('*')
      .in('status', statuses)
      .eq('eligible', true)
      .order('call_start', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`fallback claim failed: ${error.message}`);
    return { rows: data || [], claimed: false };
  }
}

/** Release a lease without advancing (used when a stage defers). */
async function releaseLease(db, callId, patch = {}) {
  const { error } = await db.from('ci_calls')
    .update({ locked_until: null, locked_by: null, updated_at: new Date().toISOString(), ...patch })
    .eq('id', callId);
  if (error) console.warn(`${LOG} lease release failed for ${callId}: ${error.message}`);
}

/**
 * Record a stage failure: bump attempts, set backoff, and park in `failed`
 * once attempts are exhausted. Backoff comes from config.nextRetryAt so PR 2
 * and PR 5 share exactly one implementation of the curve.
 */
export async function recordFailure(db, call, stage, err, cfg = getConfig()) {
  const attempts = (call.attempts || 0) + 1;
  const exhausted = attempts >= cfg.maxAttempts;
  const patch = {
    attempts,
    locked_until: null,
    locked_by: null,
    status_detail: String(err.message || err).slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  if (exhausted) {
    patch.status = 'failed';
    patch.review_reason = `${stage}_failed`;
  } else {
    patch.next_retry_at = nextRetryAt(attempts).toISOString();
  }
  const { error } = await db.from('ci_calls').update(patch).eq('id', call.id);
  if (error) console.warn(`${LOG} failure update failed for ${call.id}: ${error.message}`);
  await logEvent(db, {
    callId: call.id,
    stage,
    event: exhausted ? 'error' : 'retry',
    detail: { attempts, exhausted, message: String(err.message || err).slice(0, 500) },
  });
}

/** Park a call for human review with a reason. Terminal until resolved. */
export async function sendToReview(db, call, stage, reason, detail = null) {
  const { error } = await db.from('ci_calls').update({
    status: 'review',
    review_reason: reason,
    locked_until: null,
    locked_by: null,
    updated_at: new Date().toISOString(),
  }).eq('id', call.id);
  if (error) console.warn(`${LOG} review update failed for ${call.id}: ${error.message}`);
  await logEvent(db, { callId: call.id, stage, event: 'review', detail: detail ?? { reason } });
}

/** Advance a call to the next status and clear its lease. */
export async function advance(db, call, fromStage, toStatus, detail = null) {
  const { error } = await db.from('ci_calls').update({
    status: toStatus,
    status_detail: null,
    next_retry_at: null,
    locked_until: null,
    locked_by: null,
    updated_at: new Date().toISOString(),
  }).eq('id', call.id);
  if (error) throw new Error(`advance to ${toStatus} failed: ${error.message}`);
  await logEvent(db, { callId: call.id, stage: fromStage, event: 'transition', detail: detail ?? { to: toStatus } });
}

/**
 * Stage: discovered → fetched. Find this call's recording on the archive,
 * store the bytes, and link them.
 *
 * Three non-error outcomes, all deliberate:
 *   - no recording YET      → defer with backoff until CI_RECORDING_WAIT_HOURS
 *   - no recording EVER     → review (`recording_missing`), NOT failed; a
 *                             human may locate it, and a `failed` call is not
 *                             something anyone looks at again
 *   - recording is excluded → skipped with the exclusion reason
 */
export async function stageFetchRecording(call, { db = supabase, cfg = getConfig(), adapter, now = new Date() } = {}) {
  const sftp = adapter || createSftpAdapter({ cfg });

  if (!call.campaign) {
    await sendToReview(db, call, 'fetch', 'no_campaign', { note: 'recording lookup needs the campaign directory' });
    return { outcome: 'review', reason: 'no_campaign' };
  }

  const dateDir = dateDirFor(new Date(call.call_start), cfg.recordingTzOffsetMin);
  const candidates = await sftp.list({ campaign: call.campaign, date: dateDir });

  // Excluded files (test modules, sub-floor sizes) are never candidates — but
  // they were still recorded as rows by the crawl, so the exclusion is auditable.
  const usable = candidates.filter((c) => !c.excluded);
  const best = bestRecordingForCall(call, usable, cfg.recordingMatchWindowS);

  if (!best.recording) {
    const ageHours = (now.getTime() - new Date(call.call_start).getTime()) / 3600000;
    if (best.reason === 'ambiguous') {
      await sendToReview(db, call, 'fetch', 'recording_ambiguous', {
        candidates: usable.length,
        note: 'multiple recordings within the match window; left unlinked rather than guessed',
      });
      return { outcome: 'review', reason: 'recording_ambiguous' };
    }
    if (ageHours < cfg.recordingWaitHours) {
      await releaseLease(db, call.id, { next_retry_at: nextRetryAt(call.attempts || 0, now).toISOString() });
      return { outcome: 'deferred', reason: 'recording_not_yet_available' };
    }
    await sendToReview(db, call, 'fetch', 'recording_missing', { waited_hours: Math.round(ageHours) });
    return { outcome: 'review', reason: 'recording_missing' };
  }

  const buffer = await sftp.fetch({ sourcePath: best.recording.sourcePath });
  const stored = await storeAudio({ callId: call.id, buffer, filename: best.recording.sourceFilename, db });

  const { error } = await db.from('ci_recordings').upsert({
    call_id: call.id,
    source: 'sftp',
    source_path: best.recording.sourcePath,
    source_filename: best.recording.sourceFilename,
    campaign_dir: best.recording.campaignDir,
    date_dir: best.recording.dateDir,
    ani: best.recording.ani,
    agent_username: best.recording.agentUsername,
    ivr_module: best.recording.ivrModule,
    filename_clock_text: best.recording.clockText,
    recorded_at: best.recording.recordedAt ? best.recording.recordedAt.toISOString() : null,
    match_method: best.method,
    match_confidence: best.confidence,
    file_sha256: stored.sha256,
    file_bytes: stored.bytes,
    mime: 'audio/wav',
    storage_path: stored.storagePath,
    excluded: false,
  }, { onConflict: 'source_path' });
  if (error) throw new Error(`ci_recordings upsert failed: ${error.message}`);

  await advance(db, call, 'fetch', 'fetched', {
    source_path: best.recording.sourcePath,
    match_method: best.method,
    confidence: best.confidence,
    phone: last4(call.ani),
  });
  return { outcome: 'advanced', to: 'fetched' };
}

/**
 * Pick the recording that best fits a call, using the same never-guess rules
 * as matchRecordingToCall but oriented recording-per-call.
 */
export function bestRecordingForCall(call, recordings, windowSeconds = 180) {
  const scored = [];
  for (const rec of recordings || []) {
    const m = matchRecordingToCall(rec, [call], { windowSeconds });
    if (m.call) scored.push({ rec, method: m.method, confidence: m.confidence, reason: m.reason });
  }
  if (scored.length === 0) return { recording: null, reason: 'no_candidate' };
  if (scored.length === 1) {
    return { recording: scored[0].rec, method: scored[0].method, confidence: scored[0].confidence, reason: scored[0].reason };
  }
  // Several recordings match one call — segments of the same conversation, or
  // genuinely ambiguous. Highest confidence wins only if clearly ahead.
  scored.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  if ((scored[0].confidence ?? 0) - (scored[1].confidence ?? 0) >= 0.1) {
    return { recording: scored[0].rec, method: scored[0].method, confidence: scored[0].confidence, reason: 'best_of_several' };
  }
  return { recording: null, reason: 'ambiguous' };
}

/**
 * Stages owned by later PRs. They park the call rather than advancing it, so
 * an unfinished pipeline shows up in the health view as work waiting instead
 * of as calls quietly marked complete.
 */
const NOT_YET_IMPLEMENTED = {
  fetched: 'transcribe (PR 3)',
  transcribed: 'analyze (PR 3)',
  analyzed: 'match (PR 4)',
  matched: 'sync (PR 5)',
  syncing: 'sync completion (PR 5)',
};

/** Dispatch one claimed call to its stage handler. */
export async function advanceOne(call, { db = supabase, cfg = getConfig(), adapter, now = new Date() } = {}) {
  try {
    if (call.status === 'discovered') {
      return await stageFetchRecording(call, { db, cfg, adapter, now });
    }
    const pending = NOT_YET_IMPLEMENTED[call.status];
    if (pending) {
      // Release the lease and leave the status alone. No attempt bump: this is
      // not a failure, it is a stage that does not exist yet.
      await releaseLease(db, call.id, { next_retry_at: nextRetryAt(3, now).toISOString() });
      return { outcome: 'not_implemented', stage: pending };
    }
    await releaseLease(db, call.id);
    return { outcome: 'noop', status: call.status };
  } catch (err) {
    await recordFailure(db, call, call.status, err, cfg);
    return { outcome: 'failed', error: err.message };
  }
}

/**
 * One tick: claim a batch and advance each call one stage.
 * Guarded against overlap — a slow tick must not stack on the next interval.
 */
let ticking = false;

export async function runTick({ db = supabase, cfg = getConfig(), adapter, limit, now = new Date() } = {}) {
  if (ticking) return { ok: true, skipped: 'already_running' };
  ticking = true;
  const startedAt = Date.now();
  try {
    const batch = await claimBatch({ db, limit: limit ?? cfg.batchSize });
    if (!batch.rows.length) return { ok: true, claimed: 0 };

    const outcomes = {};
    for (const call of batch.rows) {
      const r = await advanceOne(call, { db, cfg, adapter, now });
      outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    }
    console.log(`${LOG} tick: claimed ${batch.rows.length}${batch.claimed ? '' : ' (UNLEASED fallback)'} → ${JSON.stringify(outcomes)} in ${Date.now() - startedAt}ms`);
    return { ok: true, claimed: batch.rows.length, leased: batch.claimed, outcomes, elapsed_ms: Date.now() - startedAt };
  } finally {
    ticking = false;
  }
}

/* ─── scheduler ─────────────────────────────────────────────────────────── */

const TICK_INTERVAL_MS = Math.max(30_000, parseInt(process.env.CI_TICK_INTERVAL_MS || String(5 * 60 * 1000), 10));
const WORKER_ENABLED = () => String(process.env.CI_WORKER_ENABLED || '').toLowerCase() === 'true';

let _handle = null;

/**
 * Ships DISARMED. The pipeline is inert until someone deliberately arms it,
 * which matters while stages 3–5 are still stubs — an armed worker would burn
 * SFTP and storage on calls nothing can finish.
 */
export function startCiWorkerScheduler() {
  if (_handle) return;
  if (!WORKER_ENABLED()) {
    console.log(`${LOG} scheduler DISARMED (set CI_WORKER_ENABLED=true to arm)`);
    return;
  }
  _handle = setInterval(() => {
    runTick().catch((err) => console.error(`${LOG} tick error: ${err.message}`));
  }, TICK_INTERVAL_MS);
  if (_handle.unref) _handle.unref();
  console.log(`${LOG} Scheduler armed: every ${Math.round(TICK_INTERVAL_MS / 1000)}s, batch ${getConfig().batchSize}`);
}

export function stopCiWorkerScheduler() {
  if (_handle) { clearInterval(_handle); _handle = null; }
}

export const _internal = { releaseLease, WORKER_ID, createManualAdapter, describeRecording, sha256Hex };
export default { runTick, claimBatch, advanceOne, startCiWorkerScheduler, stopCiWorkerScheduler };
