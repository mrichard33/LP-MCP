/**
 * Trace ONE call through the fetch stage — src/ci/fetch-trace.js
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 * `/ci/diagnose-recordings` answers "which of these calls could not find its
 * audio, and roughly why". It cannot answer "the folder is 49 KB on the
 * archive and we report it empty — where did the files go", because every one
 * of its verdicts is derived from what `adapter.list()` RETURNS, and list()
 * narrows a directory three times before it returns anything.
 *
 * That is the gap this closes. It reports the numbers from INSIDE the listing:
 * how many entries the SFTP server actually sent, how many of those were .wav,
 * and how many .wav files were dropped because their names would not parse.
 *
 * ── WHY THE COUNT MUST COME FROM INSIDE list() ─────────────────────────────
 * A count taken at list()'s return is not a raw count. By then the directory
 * entries, the non-.wav files and — the one that matters — every file
 * describeRecording() could not parse have already been discarded, with no
 * error and no log. Three hundred unreadable filenames and an empty folder are
 * the same value, `[]`, and the fetch stage cannot tell them apart. So this
 * threads recordings.js's `onStats` hook through and reports what it discards.
 *
 * ── IT WRITES NOTHING ──────────────────────────────────────────────────────
 * One ci_calls SELECT and one directory listing. No fetch, no re-ingest, no
 * status change, no re-queue, no lease. If this module ever needs to change
 * state it has exceeded its scope.
 *
 * ── IT MUST MIRROR INGEST EXACTLY ──────────────────────────────────────────
 * Same dateDirFor, same adapter, same cfg, same window, and the match is
 * bestRecordingForCall — the fetch stage's own chooser, imported rather than
 * reimplemented. A trace that searches differently from the code it is tracing
 * describes a different bug, convincingly.
 */

import supabaseDefault from '../supabase.js';
import { getConfig } from './config.js';
import { listingCacheKey } from './recordings.js';
import { bestRecordingForCall } from './worker.js';
import { dateDirFor, last10, last4 } from './time.js';

const LOG = '[CIFetchTrace]';

/**
 * The DST offset this subsystem is periodically asked to switch to.
 *
 * Reported for one reason: so the trace prints the folder EDT would have
 * chosen next to the folder ingest actually chose, and the question stops
 * being re-litigated from memory. The recording export is pinned to EST
 * year-round (see src/ci/time.js) and the two agree except for calls in the
 * midnight-to-1am ET band, which is not a cliff-sized population. Nothing here
 * uses this value to look anything up.
 */
export const EDT_OFFSET_MIN = -240;

/**
 * The verdicts. These extend recording-diagnosis.js's set with the one it
 * could not express — a folder that is FULL and reads as empty.
 */
export const TRACE_VERDICTS = Object.freeze({
  /** Matched on re-run. Retrieval is fine; the call was parked for another reason. */
  WOULD_MATCH: 'would_match',
  /** The .wav files are there and NONE of their names parse. The cliff. */
  FILENAME_UNPARSEABLE: 'filename_unparseable',
  /** Some names parse and some do not — a format change mid-flight. */
  FILENAME_PARTIALLY_UNPARSEABLE: 'filename_partially_unparseable',
  /** The listing threw and was swallowed into []. Never "the folder is empty". */
  LISTING_FAILED: 'listing_failed',
  /** The server really did return nothing for that path. */
  FOLDER_EMPTY: 'folder_empty',
  /** Files parsed, but every one was classified excluded. */
  ALL_EXCLUDED: 'all_excluded',
  /** Parsed, usable, but none for this customer's number. */
  NO_FILE_FOR_NUMBER: 'no_file_for_number',
  /** A file for this number exists but falls outside the match window. */
  OUTSIDE_WINDOW: 'outside_window',
});

/**
 * Read one listing report plus the match outcome and name the cause. Pure, so
 * every branch is pinned by a test with no SFTP server in sight.
 *
 * Order matters. `unparseable` is checked BEFORE `folder_empty` precisely
 * because today the two are indistinguishable at the call site, and collapsing
 * them is what sent three days of investigation at the wrong four suspects.
 *
 * @param {object} stats   a listing report from createSftpAdapter's onStats
 * @param {object} match   bestRecordingForCall's result
 * @param {object} counts  { forNumber } — usable candidates on this number
 */
export function traceVerdict(stats, match, { forNumber = 0 } = {}) {
  if (match?.recording) {
    return {
      verdict: TRACE_VERDICTS.WOULD_MATCH,
      detail: `${match.recording.sourceFilename} matches on re-run (${match.reason}, confidence ${match.confidence})`
        + ' — this call is NOT a retrieval gap; look at the fetch stage\'s wait/backoff or at why it was parked',
    };
  }

  if (stats.listError) {
    return {
      verdict: TRACE_VERDICTS.LISTING_FAILED,
      detail: `the listing threw and was swallowed into an empty array: ${stats.listError}`
        + ' — the fetch stage cannot tell this from an empty folder',
    };
  }

  if (stats.wav > 0 && stats.described === 0) {
    return {
      verdict: TRACE_VERDICTS.FILENAME_UNPARSEABLE,
      detail: `${stats.wav} .wav file(s) in the folder and NOT ONE parsed — the folder is full and`
        + ' list() returned an empty array. The filename format no longer matches'
        + ' parseRecordingFilename(). See unparseable_sample for the shape.',
    };
  }

  if (stats.unparseable > 0) {
    return {
      verdict: TRACE_VERDICTS.FILENAME_PARTIALLY_UNPARSEABLE,
      detail: `${stats.unparseable} of ${stats.wav} .wav file(s) would not parse`
        + ' — a filename format change that only some shapes survive',
    };
  }

  if (stats.entries === 0) {
    return {
      verdict: TRACE_VERDICTS.FOLDER_EMPTY,
      detail: 'the server returned no entries at all for that path — the folder is genuinely empty or absent',
    };
  }

  if (stats.described > 0 && stats.usable === 0) {
    return {
      verdict: TRACE_VERDICTS.ALL_EXCLUDED,
      detail: `all ${stats.described} parsed file(s) were classified excluded (test module or below the byte floor)`,
    };
  }

  if (forNumber > 0) {
    return {
      verdict: TRACE_VERDICTS.OUTSIDE_WINDOW,
      detail: `${forNumber} usable file(s) carry this number but none fell inside the match window`,
    };
  }

  return {
    verdict: TRACE_VERDICTS.NO_FILE_FOR_NUMBER,
    detail: `${stats.usable} usable file(s) in the folder, none for this customer's number`,
  };
}

/** Load the call by either id. Neither column is assumed unique-or-present. */
async function loadCall(db, { callId, five9CallId }) {
  const cols = 'id, five9_call_id, campaign, customer_phone, ani, call_start, status, review_reason, attempts, raw_metadata';
  const q = db.from('ci_calls').select(cols);
  const { data, error } = callId
    ? await q.eq('id', callId).maybeSingle()
    : await q.eq('five9_call_id', five9CallId).maybeSingle();
  if (error) throw new Error(`ci_calls read failed: ${error.message}`);
  return data || null;
}

/**
 * Trace one call. READ ONLY on both sides.
 *
 * @returns {Promise<object>} the six items the handoff asked for, plus a verdict
 */
export async function traceFetch({
  db = supabaseDefault,
  cfg = getConfig(),
  adapter,
  callId = null,
  five9CallId = null,
} = {}) {
  if (!db) throw new Error('Supabase not configured');
  if (!adapter?.list) throw new Error('no SFTP adapter injected');
  if (!callId && !five9CallId) throw new Error('traceFetch requires call_id or five9_call_id');

  const call = await loadCall(db, { callId, five9CallId });
  if (!call) return { found: false, call_id: callId, five9_call_id: five9CallId };
  if (!call.campaign) {
    return {
      found: true,
      call_id: call.id,
      five9_call_id: call.five9_call_id,
      verdict: 'no_campaign',
      detail: 'the call has no campaign directory — the fetch stage parks this before it lists anything',
    };
  }

  // ITEM 1 — the directory ingest computes, and the one EDT would have picked.
  const callStart = new Date(call.call_start);
  const dateDir = dateDirFor(callStart, cfg.recordingTzOffsetMin);
  const dateDirAtEdt = dateDirFor(callStart, EDT_OFFSET_MIN);

  // ITEMS 2-4 and 6 — captured from INSIDE list(), which is the whole point.
  let stats = null;
  let listThrew = null;
  let candidates = [];
  try {
    candidates = await adapter.list({
      campaign: call.campaign,
      date: dateDir,
      onStats: (s) => { stats = s; },
    });
  } catch (err) {
    // Only a listing that does NOT match the swallowed-ENOENT pattern reaches
    // here. Recorded rather than thrown: a trace that 500s tells Mark nothing.
    listThrew = err.message;
    console.warn(`${LOG} list threw for ${call.campaign}/${dateDir}: ${err.message}`);
  }

  const usable = candidates.filter((c) => !c.excluded);
  const wanted = last10(call.customer_phone || call.ani);
  const forNumber = usable.filter((c) => last10(c.ani) === wanted).length;
  const match = bestRecordingForCall(call, usable, cfg.recordingMatchWindowS);

  const report = stats || {
    dir: `${cfg.sftp.root}/${call.campaign}/${dateDir}`,
    entries: 0, dirs: 0, nonWav: 0, wav: 0,
    unparseable: 0, unparseableNames: [], wavNames: [],
    described: 0, excluded: 0, usable: 0,
    listError: listThrew, skippedDir: false,
  };

  const { verdict, detail } = traceVerdict(report, match, { forNumber });

  return {
    found: true,
    call_id: call.id,
    five9_call_id: call.five9_call_id,
    campaign: call.campaign,
    call_start: call.call_start,
    status: call.status,
    review_reason: call.review_reason,
    // Last 4 only. §10: logs and reports carry the call id plus last-4, never
    // a full customer number.
    customer_phone_last4: last4(call.customer_phone || call.ani),

    // 1 — the date directory, and the DST alternative, side by side.
    date_dir: dateDir,
    date_dir_at_edt_offset: dateDirAtEdt,
    date_dir_offset_min: cfg.recordingTzOffsetMin,
    date_dir_differs_under_edt: dateDir !== dateDirAtEdt,

    // 2 — the absolute path handed to client.list().
    listed_path: report.dir,

    // 3 — the counts, from inside the listing.
    entries_total: report.entries,
    entries_directories: report.dirs,
    entries_non_wav: report.nonWav,
    wav_files: report.wav,
    unparseable_filenames: report.unparseable,
    described_candidates: report.described,

    // 4 — after the `excluded` filter.
    excluded_candidates: report.excluded,
    usable_candidates: report.usable,
    usable_for_this_number: forNumber,

    // 5 — cache or live, and the key this pair WOULD occupy in a tick's memo.
    // This route always calls the raw adapter, so it is live by construction;
    // the key is reported so a cache-collision theory can be checked by eye.
    listing_source: 'live',
    listing_cache_key: listingCacheKey(call.campaign, dateDir),

    // 6 — verbatim names, sampled.
    filename_sample: report.wavNames,
    unparseable_sample: report.unparseableNames,

    list_error: report.listError || listThrew,
    match_reason: match?.reason ?? null,
    match_confidence: match?.confidence ?? null,
    matched_path: match?.recording?.sourcePath ?? null,

    verdict,
    detail,
    note: 'READ ONLY — nothing was fetched, re-ingested, re-queued or changed.',
  };
}

export default { TRACE_VERDICTS, EDT_OFFSET_MIN, traceVerdict, traceFetch };
