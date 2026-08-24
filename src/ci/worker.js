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
import { createSftpAdapter, createManualAdapter, describeRecording, matchRecordingToCall, storeAudio, sha256Hex, ensureLinkToken, linkableRecording } from './recordings.js';
import { dateDirFor, last4, last10 } from './time.js';
import { transcribeCall, createOpenAITranscriber, createStorageAudioLoader } from './transcribe.js';
import { analyzeTranscript } from './analyze.js';
import { matchCall, loadCanvasserPhones } from './match.js';
import { loadAgentMap } from './discovery.js';
import { resolveAgentLabel } from './teams.js';
import { syncCall } from './sync.js';

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

  // Issue the shareable link token. Conditional on link_token being null, so a
  // re-fetch of this recording does NOT rotate a token already pasted into a
  // CRM note. Never throws — a missing link costs the note one line.
  await ensureLinkToken({ sourcePath: best.recording.sourcePath, db, cfg });

  await advance(db, call, 'fetch', 'fetched', {
    source_path: best.recording.sourcePath,
    match_method: best.method,
    confidence: best.confidence,
    phone: last4(call.ani),
  });
  return { outcome: 'advanced', to: 'fetched' };
}

/**
 * Insert a ci_summaries row as the current one.
 *
 * ci_summaries_current_uq is `UNIQUE (call_id) WHERE is_current`, so a re-run
 * MUST demote the existing row before inserting or the insert violates the
 * index. Demote-then-insert (never delete): the superseded analysis stays as
 * the audit trail of what the pipeline previously believed about this call,
 * which is the whole reason the table is append-only with a current flag
 * instead of one mutable row.
 *
 * Not a transaction — PostgREST gives us no cross-statement one. The failure
 * mode is therefore "demoted but not inserted", i.e. a call with no current
 * summary. That is loud and recoverable (the stage re-runs and inserts one);
 * the opposite order would risk violating the index and failing the insert
 * every time, which is neither.
 */
export async function insertCurrentSummary(db, callId, row) {
  const { error: demoteErr } = await db
    .from('ci_summaries')
    .update({ is_current: false })
    .eq('call_id', callId)
    .eq('is_current', true);
  if (demoteErr) throw new Error(`ci_summaries demote failed: ${demoteErr.message}`);

  const { error } = await db.from('ci_summaries').insert({ ...row, is_current: true });
  if (error) throw new Error(`ci_summaries insert failed: ${error.message}`);
}

/**
 * Stage: fetched → transcribed.
 *
 * A call can own several recording files (holds split one conversation into
 * segments); transcribeCall orders and concatenates them. The audio object is
 * NOT purged here — §6 purges after the transcript is committed AND the
 * retention window has passed, which is purgeExpiredAudio's job, not this
 * stage's. Deleting it here would destroy the only copy we control the moment
 * a transcript we might still reject is written.
 */
export async function stageTranscribe(call, { db = supabase, cfg = getConfig(), transcriber, loadAudio, now = new Date() } = {}) {
  const { data: recordings, error } = await db
    .from('ci_recordings')
    .select('*')
    .eq('call_id', call.id)
    .eq('excluded', false);
  if (error) throw new Error(`ci_recordings read failed: ${error.message}`);

  if (!recordings || recordings.length === 0) {
    // Reached 'fetched' with nothing linked — an inconsistency, not a retry
    // case. A human should see why rather than the worker spinning on backoff.
    await sendToReview(db, call, 'transcribe', 'no_recording_rows', { note: 'call is fetched but has no usable ci_recordings' });
    return { outcome: 'review', reason: 'no_recording_rows' };
  }

  const row = await transcribeCall(call, recordings, {
    transcriber: transcriber || createOpenAITranscriber(),
    loadAudio: loadAudio || createStorageAudioLoader({ db }),
    cfg,
  });

  const { error: insErr } = await db
    .from('ci_transcripts')
    .upsert(row, { onConflict: 'call_id' });
  if (insErr) throw new Error(`ci_transcripts upsert failed: ${insErr.message}`);

  await advance(db, call, 'transcribe', 'transcribed', {
    diarization: row.diarization_method,
    audio_seconds: row.audio_seconds,
    low_confidence: row.low_confidence,
    segments: Array.isArray(row.segments) ? row.segments.length : 0,
    phone: last4(call.ani),
  });
  return { outcome: 'advanced', to: 'transcribed', low_confidence: row.low_confidence };
}

/**
 * Stage: transcribed → analyzed.
 *
 * An invalid AI output after MAX_ANALYSIS_ATTEMPTS is a REVIEW outcome, not a
 * failure: retrying it on backoff would burn tokens re-asking a model that has
 * already declined to answer in the required shape twice. §7 names the reason
 * `ai_output_invalid`.
 *
 * A valid analysis that trips a review trigger still gets STORED and still
 * advances — the summary is real and a reviewer needs to read it. The call
 * then goes to review carrying its flags, rather than being discarded.
 */
/**
 * The name to print for this call's agent, resolved against the agent map.
 *
 * ci_agent_map.agent_name is seeded from the Five9 user record and can be an
 * ADMINISTRATIVE label — live example, 'Mark R (Keep Old Edwin Account)' —
 * which has no business on a customer record. display_name (sql/069) overrides
 * it; NULL means "use agent_name".
 *
 * Used at BOTH stageAnalyze and stageSync so the summary and the note header
 * name the agent identically. A header and a summary naming the same agent
 * differently reads as two people on one call.
 *
 * Falls back to the call row alone when no map was threaded in, which is the
 * pre-sql/069 behaviour. Pure: the map is an argument, never a read.
 */
export function agentLabelFor(call, agentMap) {
  const key = String(call?.agent_username ?? '').trim().toLowerCase();
  const row = (key && typeof agentMap?.get === 'function') ? agentMap.get(key) : null;
  return resolveAgentLabel({
    displayName: row?.display_name,
    agentName: call?.agent_name ?? row?.agent_name,
    agentUsername: call?.agent_username,
  });
}

export async function stageAnalyze(call, { db = supabase, cfg = getConfig(), callJson, now = new Date(), agentMap = null } = {}) {
  const { data: transcript, error } = await db
    .from('ci_transcripts')
    .select('*')
    .eq('call_id', call.id)
    .maybeSingle();
  if (error) throw new Error(`ci_transcripts read failed: ${error.message}`);
  if (!transcript) {
    await sendToReview(db, call, 'analyze', 'no_transcript', { note: 'call is transcribed but has no ci_transcripts row' });
    return { outcome: 'review', reason: 'no_transcript' };
  }

  const result = await analyzeTranscript(call, transcript, {
    cfg,
    // The SAME label the note header will print — see agentLabelFor().
    agentLabel: agentLabelFor(call, agentMap),
    ...(callJson ? { callJson } : {}),
  });

  if (!result.ok) {
    await sendToReview(db, call, 'analyze', result.reason, {
      attempts: result.attempts,
      // The schema errors, not the model's text — a rejected response can
      // contain transcript fragments, and §-logging keeps content out of logs.
      errors: (result.errors || []).slice(0, 10),
    });
    return { outcome: 'review', reason: result.reason };
  }

  await insertCurrentSummary(db, call.id, result.row);

  const flags = result.row.review_flags || [];
  if (flags.length > 0) {
    await sendToReview(db, call, 'analyze', flags[0], { review_flags: flags, outcome: result.row.outcome });
    return { outcome: 'review', reason: flags[0], review_flags: flags };
  }

  await advance(db, call, 'analyze', 'analyzed', {
    outcome: result.row.outcome,
    confidence: result.row.outcome_confidence,
    attempts: result.attempts,
    phone: last4(call.ani),
  });
  return { outcome: 'advanced', to: 'analyzed' };
}

/**
 * Stage: analyzed → matched.
 *
 * Records the decision in ci_matches EVEN WHEN it resolves to nothing. An
 * unmatched call with no ci_matches row is indistinguishable from a call the
 * matcher never reached; a row with tier 'none' says "we looked, and this is
 * what we found", which is what reconciliation and the review queue need.
 *
 * `decided_by` is 'system' here. The review endpoint writes 'human' rows for
 * the same call, and the newest row wins — that is how a human correction
 * survives a re-run of this stage.
 */
export async function stageMatch(call, { db = supabase, cfg = getConfig(), now = new Date(), canvasserPhones } = {}) {
  const { data: summary, error: sumErr } = await db
    .from('ci_summaries')
    .select('*')
    .eq('call_id', call.id)
    .eq('is_current', true)
    .maybeSingle();
  if (sumErr) throw new Error(`ci_summaries read failed: ${sumErr.message}`);

  const { data: campaignRow, error: campErr } = await db
    .from('ci_campaign_map')
    .select('*')
    .eq('campaign', call.campaign)
    .maybeSingle();
  if (campErr) throw new Error(`ci_campaign_map read failed: ${campErr.message}`);

  // The roster is normally loaded ONCE per tick and threaded in. A direct
  // call to this stage (the review endpoint, a test) loads it here instead —
  // it must never be skipped, because an absent roster silently disarms the
  // guard and the call phone-matches to the canvasser.
  const roster = canvasserPhones ?? await loadCanvasserPhones(db);

  const result = await matchCall(call, {
    db, analysis: summary?.output ?? null, campaignRow, cfg, canvasserPhones: roster,
  });

  const { error: insErr } = await db.from('ci_matches').insert({
    call_id: call.id,
    lp_cst_id: result.lp.prospectId ?? null,
    lp_lds_id: result.target.rectype === 'ils' ? result.target.recid : (result.lp.leadId ?? null),
    ghl_contact_id: result.ghl.ghlContactId ?? null,
    method: result.lp.method,
    tier: result.lp.tier,
    confidence: TIER_CONFIDENCE[result.lp.tier] ?? null,
    // Candidates are kept so a reviewer sees what the matcher was choosing
    // between. Trimmed to identity fields — this table is not a copy of LP.
    candidates: (result.lp.candidates || []).slice(0, 20).map((c) => ({
      lp_prospect_id: c.lp_prospect_id ?? null,
      lp_lead_id: c.lp_lead_id ?? null,
      last_activity_at: c.last_activity_at ?? null,
      appointment_date: c.appointment_date ?? null,
    })),
    evidence: {
      reason: result.lp.reason,
      note_target: result.target,
      ghl: { tier: result.ghl.tier, method: result.ghl.method, reason: result.ghl.reason },
      canvass_strategy: campaignRow?.match_strategy ?? null,
      // WHICH canvasser the ANI hit. Without this a reviewer sees only that
      // the call was withheld, with no way to confirm the roster was right.
      // All matches are listed — 11 numbers belong to two Pro IDs.
      ...(result.lp.canvassers?.length
        ? {
          canvasser_ani: {
            phone_last10: last10(call.customer_phone || call.ani),
            pro_id: result.lp.canvassers[0].pro_id,
            name: result.lp.canvassers[0].name,
            market: result.lp.canvassers[0].market,
            matched: result.lp.canvassers,
          },
        }
        : {}),
    },
    decided_by: 'system',
  });
  if (insErr) throw new Error(`ci_matches insert failed: ${insErr.message}`);

  if (result.review) {
    await sendToReview(db, call, 'match', result.review, {
      lp_tier: result.lp.tier,
      candidates: (result.lp.candidates || []).length,
      phone: last4(call.ani),
    });
    return { outcome: 'review', reason: result.review, tier: result.lp.tier };
  }

  await advance(db, call, 'match', 'matched', {
    lp_tier: result.lp.tier,
    ghl_tier: result.ghl.tier,
    rectype: result.target.rectype,
    phone: last4(call.ani),
  });
  return { outcome: 'advanced', to: 'matched', tier: result.lp.tier };
}

/** Confidence stamped on a ci_matches row, by tier. Ordinal, not probability. */
const TIER_CONFIDENCE = { exact: 1.0, high: 0.9, probable: 0.6, ambiguous: 0.3, none: 0 };

/**
 * Stage: matched → completed.
 *
 * Reads the NEWEST ci_matches row for the call, which is how a human
 * correction outranks the matcher: the review endpoint appends a
 * decided_by='human' row, and this picks that one up on the retry.
 *
 * Completion is not conditional on a CRM accepting the note. A call whose
 * writes were skipped (shadow, or a tier below the threshold) is still
 * COMPLETED — the pipeline did everything it was asked to. Only a genuine
 * delivery failure holds the call back for retry, and only until attempts run
 * out. Treating "shadow skipped" as incomplete would park every call in the
 * subsystem for as long as the flags stay off, which is the normal state.
 */
export async function stageSync(call, { db = supabase, cfg = getConfig(), lpClient, ghlClient, now = new Date(), agentMap = null } = {}) {
  const { data: match, error: mErr } = await db
    .from('ci_matches')
    .select('*')
    .eq('call_id', call.id)
    .order('decided_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (mErr) throw new Error(`ci_matches read failed: ${mErr.message}`);
  if (!match) {
    await sendToReview(db, call, 'sync', 'no_match_row', { note: 'call is matched but has no ci_matches row' });
    return { outcome: 'review', reason: 'no_match_row' };
  }

  const { data: summary, error: sErr } = await db
    .from('ci_summaries')
    .select('*')
    .eq('call_id', call.id)
    .eq('is_current', true)
    .maybeSingle();
  if (sErr) throw new Error(`ci_summaries read failed: ${sErr.message}`);
  if (!summary) {
    await sendToReview(db, call, 'sync', 'no_summary', { note: 'call is matched but has no current ci_summaries row' });
    return { outcome: 'review', reason: 'no_summary' };
  }

  // The recording link, composed once and given to BOTH targets so the two
  // CRMs cannot end up quoting different URLs for the same call. A failure
  // here is not a sync failure: the note still goes, minus the link line.
  let link = null;
  try {
    const { data: recs, error: recErr } = await db
      .from('ci_recordings')
      .select('link_token, link_expires_at, recorded_at, fetched_at, purged_at')
      .eq('call_id', call.id)
      .eq('excluded', false);
    if (recErr) throw new Error(recErr.message);
    const { recording, extra } = linkableRecording(recs || []);
    if (recording) {
      link = {
        token: recording.link_token,
        expiresAt: recording.link_expires_at,
        extraSegments: extra,
        linkBase: cfg.recordingLinkBase,
      };
    }
  } catch (err) {
    console.warn(`${LOG} call=${call.id} recording link unavailable: ${err.message}`);
  }

  const result = await syncCall(call, summary, match, {
    db, cfg, lpClient, ghlClient, link, agentLabel: agentLabelFor(call, agentMap),
  });

  // A target that failed and has NOT exhausted its attempts gets another go.
  const retryable = ['lp', 'ghl'].filter((t) => result[t]?.failed && !result[t]?.terminal);
  if (retryable.length > 0) {
    await releaseLease(db, call.id, { next_retry_at: nextRetryAt(call.attempts || 0, now).toISOString() });
    return { outcome: 'deferred', reason: `sync_retry_${retryable.join('_')}`, result };
  }

  const terminal = ['lp', 'ghl'].filter((t) => result[t]?.terminal);
  if (terminal.length > 0) {
    await sendToReview(db, call, 'sync', 'sync_failed', {
      targets: terminal,
      phone: last4(call.ani),
    });
    return { outcome: 'review', reason: 'sync_failed', result };
  }

  await advance(db, call, 'sync', 'completed', {
    lp: describeSync(result.lp),
    ghl: describeSync(result.ghl),
    phone: last4(call.ani),
  });
  return { outcome: 'advanced', to: 'completed', result };
}

/** One-word outcome per target, for the event log. */
function describeSync(r) {
  if (!r) return 'none';
  if (r.synced) return 'synced';
  if (r.shadow) return 'shadow';
  if (r.skipped) return `skipped:${r.reason}`;
  if (r.failed) return 'failed';
  return 'unknown';
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
const NOT_YET_IMPLEMENTED = {};

/** Dispatch one claimed call to its stage handler. */
export async function advanceOne(call, { db = supabase, cfg = getConfig(), adapter, transcriber, loadAudio, callJson, lpClient, ghlClient, now = new Date(), canvasserPhones, agentMap } = {}) {
  try {
    if (call.status === 'discovered') {
      return await stageFetchRecording(call, { db, cfg, adapter, now });
    }
    if (call.status === 'fetched') {
      return await stageTranscribe(call, { db, cfg, transcriber, loadAudio, now });
    }
    if (call.status === 'transcribed') {
      return await stageAnalyze(call, { db, cfg, callJson, now, agentMap });
    }
    if (call.status === 'analyzed') {
      return await stageMatch(call, { db, cfg, now, canvasserPhones });
    }
    if (call.status === 'matched') {
      return await stageSync(call, { db, cfg, lpClient, ghlClient, now, agentMap });
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

export async function runTick({ db = supabase, cfg = getConfig(), adapter, transcriber, loadAudio, callJson, lpClient, ghlClient, limit, now = new Date(), canvasserPhones, agentMap } = {}) {
  if (ticking) return { ok: true, skipped: 'already_running' };
  ticking = true;
  const startedAt = Date.now();
  try {
    const batch = await claimBatch({ db, limit: limit ?? cfg.batchSize });
    if (!batch.rows.length) return { ok: true, claimed: 0 };

    // ONE roster read per tick, not one per call — every call in the batch
    // checks the same ~850 rows. Loaded here rather than lazily inside the
    // match stage so a batch of ten matching calls costs one query, not ten.
    // A read failure fails the tick loudly: silently continuing with no
    // roster would disarm the guard and phone-match canvassers as customers.
    const roster = canvasserPhones ?? await loadCanvasserPhones(db);
    // ONE agent-map read per tick, like the roster. It supplies the
    // display_name override (sql/069) for the note header AND the analyzer's
    // identity line — both must print the SAME label.
    const agents = agentMap ?? await loadAgentMap(db);

    const outcomes = {};
    for (const call of batch.rows) {
      const r = await advanceOne(call, { db, cfg, adapter, transcriber, loadAudio, callJson, lpClient, ghlClient, now, canvasserPhones: roster, agentMap: agents });
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
