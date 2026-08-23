/**
 * Call Intelligence — reconciliation — src/ci/reconcile.js
 *
 * §6/§15. Answers one question for a given day: did every call that HAS a
 * recording actually get one ingested?
 *
 * ── WHY THIS EXISTS RATHER THAN TRUSTING THE PIPELINE ──────────────────────
 * The worker only knows about calls it managed to process. A call that was
 * never discovered, or whose fetch stage failed in a way that left no row, is
 * invisible to every health view in the system — the pipeline reports itself
 * healthy precisely because the missing work is missing. Reconciliation reads
 * the AUTHORITATIVE source instead: the Call Log's own RECORDINGS column,
 * captured at discovery into raw_metadata.recording_segments. If Five9 says a
 * call had audio and we hold none, that is a gap, whatever the pipeline thinks.
 *
 * ── WHAT IS NOT A GAP ──────────────────────────────────────────────────────
 * Three cases legitimately have no audio, and calling them gaps would bury the
 * real ones in noise:
 *
 *   - the call log recorded no segments at all — nothing was ever recorded;
 *   - the recording exists but was EXCLUDED on purpose (a transfer-module test
 *     call, or a file under CI_MIN_RECORDING_BYTES);
 *   - a transfer leg from BEFORE CI_TRANSFER_RECORDING_ENABLED_FROM. Recording
 *     was not switched on for the canvass transfer module until Mark enabled
 *     it, so every transfer leg before that date has no audio by design. With
 *     the date unset this exemption does NOT apply — an unset cutoff must not
 *     silently excuse every transfer leg ever.
 *
 * ── IDEMPOTENCE ────────────────────────────────────────────────────────────
 * Reconciliation is expected to be re-run over the same day (§12 schedules it
 * daily, and a human re-runs it while investigating). A second run over an
 * unchanged day must record NOTHING new — otherwise the gap log inflates on
 * every run and the counts stop meaning anything. Gaps are therefore written
 * only when no gap event already exists for that call.
 */

import supabase from '../supabase.js';
import { getConfig } from './config.js';
import { last4 } from './time.js';

const LOG = '[CIReconcile]';

/** The ci_events stage/event pair that marks a reconciliation gap. */
export const GAP_STAGE = 'reconcile';
export const GAP_EVENT = 'gap';

/**
 * Does the Call Log say this call had audio?
 * Segments are the authority; expected_recording_count is a convenience copy.
 */
export function expectedSegments(call) {
  const segs = call?.raw_metadata?.recording_segments;
  if (Array.isArray(segs)) return segs.length;
  const n = Number(call?.raw_metadata?.expected_recording_count);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Is this call exempt from the transfer-recording cutoff?
 *
 * Returns false when the cutoff is unset — an absent configuration must never
 * be the thing that excuses a gap. It is only an exemption once Mark has told
 * us the date recording was actually switched on.
 */
export function beforeTransferRecording(call, cfg = getConfig()) {
  if (!call?.was_transferred) return false;
  const from = cfg.transferRecordingEnabledFrom;
  if (!from) return false;
  const cutoff = new Date(/^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from}T00:00:00Z` : from);
  if (Number.isNaN(cutoff.getTime())) return false;
  return new Date(call.call_start).getTime() < cutoff.getTime();
}

/**
 * Classify one call against its ingested recordings.
 *
 * Pure — the caller supplies the recordings — so every branch is testable
 * without a database.
 *
 * @returns {{gap: boolean, reason: string}}
 */
export function classifyCall(call, recordings, cfg = getConfig()) {
  const expected = expectedSegments(call);
  if (expected === 0) return { gap: false, reason: 'no_segments_expected' };

  const rows = recordings || [];
  if (rows.some((r) => r.excluded === true) && !rows.some((r) => !r.excluded)) {
    return { gap: false, reason: 'excluded_on_purpose' };
  }
  if (rows.some((r) => !r.excluded && r.storage_path)) {
    return { gap: false, reason: 'ingested' };
  }
  if (beforeTransferRecording(call, cfg)) {
    return { gap: false, reason: 'transfer_leg_before_recording_enabled' };
  }
  return { gap: true, reason: rows.length === 0 ? 'no_recording_ingested' : 'recording_row_without_audio' };
}

/** Has a gap already been recorded for this call? Keeps re-runs silent. */
export async function hasExistingGap(db, callId) {
  const { data, error } = await db
    .from('ci_events')
    .select('id')
    .eq('call_id', callId)
    .eq('stage', GAP_STAGE)
    .eq('event', GAP_EVENT)
    .limit(1);
  if (error) throw new Error(`gap lookup failed: ${error.message}`);
  return (data || []).length > 0;
}

/**
 * Reconcile one day.
 *
 * @param {object} opts
 * @param {string} opts.date  YYYY-MM-DD (UTC day of call_start)
 * @returns {Promise<{date, examined, gaps, recorded, skipped: object}>}
 */
export async function reconcileDay({ db = supabase, cfg = getConfig(), date, limit = 5000 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error(`reconcileDay needs a YYYY-MM-DD date (got ${JSON.stringify(date)})`);
  }
  const from = `${date}T00:00:00.000Z`;
  const to = `${date}T23:59:59.999Z`;

  const { data: calls, error } = await db
    .from('ci_calls')
    .select('id, five9_call_id, call_start, campaign, ani, was_transferred, raw_metadata, status')
    .gte('call_start', from)
    .lte('call_start', to)
    .limit(limit);
  if (error) throw new Error(`ci_calls read failed: ${error.message}`);

  const rows = calls || [];
  const summary = { date, examined: rows.length, gaps: 0, recorded: 0, skipped: {} };
  const bump = (k) => { summary.skipped[k] = (summary.skipped[k] || 0) + 1; };

  for (const call of rows) {
    const { data: recs, error: rErr } = await db
      .from('ci_recordings')
      .select('id, excluded, excluded_reason, storage_path')
      .eq('call_id', call.id);
    if (rErr) throw new Error(`ci_recordings read failed: ${rErr.message}`);

    const verdict = classifyCall(call, recs || [], cfg);
    if (!verdict.gap) {
      bump(verdict.reason);
      continue;
    }
    summary.gaps++;

    // Idempotence: a re-run over an unchanged day records nothing new.
    if (await hasExistingGap(db, call.id)) {
      bump('gap_already_recorded');
      continue;
    }

    const { error: insErr } = await db.from('ci_events').insert({
      call_id: call.id,
      stage: GAP_STAGE,
      event: GAP_EVENT,
      detail: {
        reason: verdict.reason,
        expected_segments: expectedSegments(call),
        campaign: call.campaign,
        // §10: last-4 only, never the full number.
        phone: last4(call.ani),
        five9_call_id: call.five9_call_id,
        status_at_reconcile: call.status,
      },
    });
    if (insErr) throw new Error(`gap insert failed: ${insErr.message}`);
    summary.recorded++;
  }

  console.log(`${LOG} ${date}: examined ${summary.examined}, gaps ${summary.gaps}, newly recorded ${summary.recorded}`);
  return summary;
}

/**
 * Pipeline health: the status histogram, sync counts, review backlog, and the
 * estimated model spend implied by the stored token usage.
 *
 * Cost is ESTIMATED and labelled as such. Token prices change and are not
 * fetched here, so the number is directional — enough to notice a tenfold jump
 * in spend, not to reconcile a bill.
 */
export async function pipelineHealth({ db = supabase, cfg = getConfig(), sinceHours = 24 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600000).toISOString();

  const { data: statuses, error: hErr } = await db.from('v_ci_pipeline_health').select('*');
  if (hErr) throw new Error(`health view read failed: ${hErr.message}`);

  const { data: syncs, error: sErr } = await db
    .from('ci_syncs')
    .select('target, status')
    .gte('created_at', since);
  if (sErr) throw new Error(`ci_syncs read failed: ${sErr.message}`);

  const syncCounts = {};
  for (const s of syncs || []) {
    const k = `${s.target}:${s.status}`;
    syncCounts[k] = (syncCounts[k] || 0) + 1;
  }

  const { data: usageRows, error: uErr } = await db
    .from('ci_summaries')
    .select('usage')
    .gte('created_at', since);
  if (uErr) throw new Error(`ci_summaries usage read failed: ${uErr.message}`);

  const tokens = (usageRows || []).reduce((acc, r) => {
    const u = r.usage || {};
    acc.input += Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
    acc.output += Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
    return acc;
  }, { input: 0, output: 0 });

  const { count: gapCount } = await db
    .from('ci_events')
    .select('id', { count: 'exact', head: true })
    .eq('stage', GAP_STAGE)
    .eq('event', GAP_EVENT)
    .gte('created_at', since);

  return {
    mode: cfg.mode,
    writes: { lp: cfg.lpWrites, ghl: cfg.ghlWrites, ghl_create: cfg.ghlCreate, allow_probable: cfg.allowProbable },
    window_hours: sinceHours,
    statuses: statuses || [],
    syncs: syncCounts,
    reconciliation_gaps: gapCount ?? 0,
    tokens,
    // Named 'estimated_' so nobody reads it as billing truth.
    estimated_analysis_tokens_per_day: sinceHours > 0 ? Math.round(((tokens.input + tokens.output) / sinceHours) * 24) : 0,
  };
}

export default { reconcileDay, pipelineHealth, classifyCall, expectedSegments, beforeTransferRecording };
