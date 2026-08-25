/**
 * Why 113 calls with audio never got a summary — name the cause, change nothing
 * src/ci/recording-diagnosis.js
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 * `recording_missing` is the largest single reason calls sit in the review
 * queue, and the loss is not hypothetical. Measured 2026-08-25:
 *
 *     recording_missing, report says audio EXISTS ....... 93
 *     recording_ambiguous .............................. 20
 *     ------------------------------------------------------
 *     recoverable summaries ........................... 113
 *
 *     recording_missing, report says NO audio .......... 44   (correctly parked)
 *     recordings ingested that failed to link ........... 0   (every campaign)
 *
 * Zero unlinked is the load-bearing number: every recording we DID ingest found
 * its call. So this is a RETRIEVAL gap, not a matching one — the file was never
 * pulled off the archive in the first place.
 *
 * ── WHY A DIAGNOSTIC AND NOT A FIX ─────────────────────────────────────────
 * 113 summaries is exactly the size at which a plausible-sounding guess is most
 * expensive: big enough to be worth chasing, small enough that a wrong fix goes
 * unnoticed for weeks. There are at least four causes with four different fixes
 * (below), and they are indistinguishable from the ci_calls row alone. So this
 * asks the archive and reports which one it is.
 *
 * IT WRITES NOTHING. No re-ingest, no status change, no re-queue.
 *
 * ── THE PRIME SUSPECT, STATED SO IT CAN BE KILLED ──────────────────────────
 * Recording filenames use a FIXED EST offset of −300 with no DST
 * (CI_RECORDING_TZ_OFFSET_MIN, applied by dateDirFor and filenameClockToUtc).
 * Calls are Eastern. So from March to November the filename clock runs an hour
 * behind the wall clock, and a call after 8pm ET is filed under the PREVIOUS
 * day's folder.
 *
 * The fetch stage lists exactly one directory — campaign/date — so that is not
 * a near-miss it could recover from. It is a whole-directory miss: the code
 * looks in an empty folder and concludes the audio does not exist.
 *
 * This probes date−1 and date+1 explicitly, so the suspicion becomes a count.
 *
 * ── THE SEARCH MUST MIRROR INGEST EXACTLY ──────────────────────────────────
 * It reuses candidateDistanceSeconds and matchRecordingToCall from
 * recordings.js rather than reimplementing the comparison. A diagnostic that
 * searches differently from the code it is diagnosing describes a different
 * bug, convincingly.
 */

import supabaseDefault from '../supabase.js';
import { getConfig } from './config.js';
import { candidateDistanceSeconds, matchRecordingToCall } from './recordings.js';
import { dateDirFor, last10 } from './time.js';

const LOG = '[CIRecDiag]';

/**
 * The verdicts, each naming a DIFFERENT fix. The whole point of the exercise is
 * that these do not get collapsed into "missing".
 */
export const VERDICTS = Object.freeze({
  /** Audio is in an adjacent day's folder — the DST/fixed-offset boundary. */
  WRONG_DATE_DIR: 'wrong_date_dir',
  /** The right folder exists and holds files, but none for this number. */
  NO_FILE_FOR_NUMBER: 'no_file_for_number',
  /** A file for this number exists nearby in time, but outside ±windowSeconds. */
  OUTSIDE_WINDOW: 'outside_window',
  /** The campaign folder itself is absent or empty for that date. */
  CAMPAIGN_DIR_EMPTY: 'campaign_dir_empty',
  /** It is right there and should have matched — the matcher, not retrieval. */
  PRESENT_SHOULD_HAVE_MATCHED: 'present_should_have_matched',
  /** We could not look. NEVER a conclusion about the archive. */
  UNKNOWN: 'unknown',
});

/**
 * The three date folders a call could plausibly be filed under. Pure.
 *
 * dateDirFor applies the fixed −300 offset, so `same` is what ingest actually
 * looked in. The neighbours are what the DST drift would put it in.
 */
export function candidateDateDirs(callStart, offsetMin) {
  const d = callStart instanceof Date ? callStart : new Date(callStart);
  if (!Number.isFinite(d.getTime())) return [];
  const day = 86400000;
  return [
    { label: 'same', dir: dateDirFor(d, offsetMin) },
    { label: 'prev', dir: dateDirFor(new Date(d.getTime() - day), offsetMin) },
    { label: 'next', dir: dateDirFor(new Date(d.getTime() + day), offsetMin) },
  ];
}

/**
 * Turn one call plus what the archive actually holds into a verdict. Pure, so
 * every branch is testable without an SFTP server.
 *
 * @param {object} call            ci_calls row (campaign, customer_phone, call_start)
 * @param {object} listings        { same: [rec], prev: [rec], next: [rec] } — a
 *                                 MISSING key means that listing failed, which
 *                                 is different from an empty array
 * @param {number} windowSeconds   the ingest match window
 */
export function diagnoseCall(call, listings, windowSeconds = 180) {
  const wanted = last10(call?.customer_phone || call?.ani);
  const same = listings?.same;
  const prev = listings?.prev;
  const next = listings?.next;

  if (!Array.isArray(same)) {
    // We could not read the folder ingest reads. Everything below would be a
    // guess, and a guess here is what sends someone to fix the wrong thing.
    return { verdict: VERDICTS.UNKNOWN, detail: 'the campaign/date listing could not be read', wanted };
  }

  // 1. Would it have matched, right where ingest looked? If so the defect is in
  //    the matcher or the call row, not in retrieval — a completely different
  //    investigation, so it gets its own verdict rather than a shrug.
  for (const rec of same) {
    const m = matchRecordingToCall(rec, [call], { windowSeconds });
    if (m.call) {
      return {
        verdict: VERDICTS.PRESENT_SHOULD_HAVE_MATCHED,
        detail: `${rec.fileName ?? rec.fullPath} matched on re-run (${m.reason})`,
        wanted,
        path: rec.fullPath ?? null,
      };
    }
  }

  // 2. THE PRIME SUSPECT. Is the audio simply filed a day either side? The
  //    fetch stage lists exactly one directory, so this is invisible to it.
  for (const [label, list] of [['prev', prev], ['next', next]]) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (last10(rec.ani) !== wanted) continue;
      const seconds = candidateDistanceSeconds({ ...rec, campaignDir: call.campaign }, call);
      return {
        verdict: VERDICTS.WRONG_DATE_DIR,
        detail: `audio for this number is in the ${label.toUpperCase()} day's folder`
          + `${seconds == null ? '' : `, ${Math.round(seconds)}s from call_start`}`
          + ' — ingest lists only one directory, so it never saw this',
        wanted,
        path: rec.fullPath ?? null,
      };
    }
  }

  // 3. Right folder, right number, wrong time — a genuine window problem.
  const sameNumber = same.filter((r) => last10(r.ani) === wanted);
  if (sameNumber.length) {
    const nearest = sameNumber
      .map((r) => ({ r, s: candidateDistanceSeconds({ ...r, campaignDir: call.campaign }, call) }))
      .filter((x) => x.s != null)
      .sort((a, b) => a.s - b.s)[0];
    return {
      verdict: VERDICTS.OUTSIDE_WINDOW,
      detail: nearest
        ? `nearest file for this number is ${Math.round(nearest.s)}s away, window is ${windowSeconds}s`
        : 'files exist for this number but none could be timed',
      wanted,
      path: nearest?.r?.fullPath ?? null,
    };
  }

  // 4. The folder is empty — the campaign dir is wrong, or Five9 filed the
  //    audio somewhere else entirely.
  if (!same.length) {
    return {
      verdict: VERDICTS.CAMPAIGN_DIR_EMPTY,
      detail: `no .wav files at all under campaign '${call.campaign}' for that date`,
      wanted,
    };
  }

  return {
    verdict: VERDICTS.NO_FILE_FOR_NUMBER,
    detail: `${same.length} file(s) in the folder, none for ${wanted}`,
    wanted,
  };
}

/**
 * Roll the verdicts into the table that decides the fix. Pure.
 *
 * `unknown` is counted separately and never folded into a cause — a run that
 * could not reach the archive must not read as "nothing found".
 */
export function summariseVerdicts(rows) {
  const counts = {};
  for (const r of rows || []) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const read = (rows || []).length - (counts[VERDICTS.UNKNOWN] || 0);
  const dominant = Object.entries(counts)
    .filter(([k]) => k !== VERDICTS.UNKNOWN)
    .sort((a, b) => b[1] - a[1])[0] ?? null;
  return {
    counts,
    diagnosed: read,
    unknown: counts[VERDICTS.UNKNOWN] || 0,
    dominant: dominant ? { verdict: dominant[0], count: dominant[1] } : null,
  };
}

/** The one sentence to act on. Pure, so the reading is pinned by a test. */
export function recommendation(summary) {
  if (!summary.diagnosed) {
    return 'INCONCLUSIVE — nothing could be read from the archive. Fix SFTP connectivity and re-run; change nothing on this.';
  }
  const d = summary.dominant;
  const share = d ? d.count / summary.diagnosed : 0;
  if (!d) return 'No verdict reached on any call — re-run with a wider --limit.';

  if (d.verdict === VERDICTS.WRONG_DATE_DIR && share >= 0.5) {
    return `CONFIRMED: the fixed EST−300 filename offset files late-evening calls under the previous day. `
      + `${d.count} of ${summary.diagnosed} are one folder away. The fix is to widen the DIRECTORY SEARCH in the fetch stage `
      + `to the adjacent day — NOT to change the timestamp arithmetic, which three prior incidents already reconciled against.`;
  }
  if (d.verdict === VERDICTS.PRESENT_SHOULD_HAVE_MATCHED && share >= 0.5) {
    return `The audio is where ingest looked and matches on re-run (${d.count} of ${summary.diagnosed}). `
      + `This is NOT a retrieval gap — investigate the fetch stage's listing or its wait/backoff, not the archive.`;
  }
  if (d.verdict === VERDICTS.CAMPAIGN_DIR_EMPTY && share >= 0.5) {
    return `${d.count} of ${summary.diagnosed} have no audio under their campaign folder at all. `
      + `Either the campaign was renamed in Five9 after these calls, or recording is off for it — check Five9 config before changing any code.`;
  }
  return `MIXED — no single cause covers half the sample (largest: ${d.verdict}, ${d.count} of ${summary.diagnosed}). `
    + `Read the per-call table; these need more than one fix.`;
}

/**
 * Diagnose the recording gap. READ ONLY, on both sides.
 *
 * Only looks at calls the Call Log says HAVE audio — a call with no recording
 * segments is correctly in review and there is nothing to recover.
 */
export async function diagnoseRecordingGap({
  db = supabaseDefault,
  cfg = getConfig(),
  adapter,
  limit = 25,
} = {}) {
  if (!db) throw new Error('Supabase not configured');
  if (!adapter?.list) throw new Error('no SFTP adapter injected');

  const { data: calls, error } = await db
    .from('ci_calls')
    .select('id, five9_call_id, campaign, customer_phone, ani, call_start, review_reason, raw_metadata')
    .in('review_reason', ['recording_missing', 'recording_ambiguous'])
    .order('call_start', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`ci_calls read failed: ${error.message}`);

  // The report saying "audio exists" is what makes a call recoverable. Without
  // it there is nothing to find and the review is correct.
  const withAudio = (calls || []).filter(
    (c) => Number(c.raw_metadata?.expected_recording_count ?? 0) > 0,
  );

  const results = [];
  // ONE connection for the whole run. The adapter opens one per list() call
  // otherwise, and this lists up to three directories per call.
  for (const call of withAudio) {
    const listings = {};
    for (const { label, dir } of candidateDateDirs(call.call_start, cfg.recordingTzOffsetMin)) {
      try {
        listings[label] = await adapter.list({ campaign: call.campaign, date: dir });
      } catch (err) {
        // Leave the key ABSENT rather than setting []. An empty array means
        // "the folder is empty"; a missing key means "we could not look", and
        // diagnoseCall must be able to tell those apart.
        console.warn(`${LOG} list failed for ${call.campaign}/${dir}: ${err.message}`);
      }
    }
    const d = diagnoseCall(call, listings, cfg.recordingMatchWindowS ?? 180);
    results.push({
      five9_call_id: call.five9_call_id,
      call_start: call.call_start,
      campaign: call.campaign,
      review_reason: call.review_reason,
      expected_recordings: Number(call.raw_metadata?.expected_recording_count ?? 0),
      recordings_raw: call.raw_metadata?.recordings_raw ?? null,
      ...d,
    });
  }

  const summary = summariseVerdicts(results);
  return {
    examined: (calls || []).length,
    recoverable: withAudio.length,
    no_audio_correctly_parked: (calls || []).length - withAudio.length,
    results,
    summary,
    recommendation: recommendation(summary),
    note: 'READ ONLY — nothing was re-ingested, re-queued or changed.',
  };
}

export default {
  VERDICTS, candidateDateDirs, diagnoseCall, summariseVerdicts,
  recommendation, diagnoseRecordingGap,
};
