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
import { isTransferLeg } from './discovery.js';
import { formatPhoneLine } from './notes.js';
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
  /**
   * The folder is FULL and we could not read a single filename in it.
   *
   * Deliberately NOT folded into CAMPAIGN_DIR_EMPTY, because the two are the
   * same value at every call site — adapter.list() drops a file it cannot
   * parse and returns `[]`, exactly as it does for a folder holding nothing.
   * Collapsing them is what let a filename-format change read as "Five9 stopped
   * recording" and sent an investigation at four causes that were all innocent.
   */
  FILENAME_UNPARSEABLE: 'filename_unparseable',
  /** It is right there and should have matched — the matcher, not retrieval. */
  PRESENT_SHOULD_HAVE_MATCHED: 'present_should_have_matched',
  /**
   * VENDOR-SIDE AUDIO. The conversation continued on someone else's platform
   * after a transfer, and Five9 holds only its own leg. NEVER a retrieval
   * failure — no SFTP search will ever find these, so counting them as
   * `recording_missing` is what made the gap look unexplainable.
   */
  TRANSFERRED: 'transferred',
  /** We could not look. NEVER a conclusion about the archive. */
  UNKNOWN: 'unknown',
});

/** Five9's own words for it, on the call row rather than on a leg. */
const TRANSFER_DISPOSITION = /transferred to 3rd party|transferred to third party/i;

/**
 * Did this call continue on a vendor platform after a transfer? Pure.
 *
 * ── WHAT THIS IS ABOUT ─────────────────────────────────────────────────────
 * Measured 2026-08-25: of 199 calls parked on `recording_missing`, 75 carry
 * disposition 'Transferred To 3rd Party' — all on 'Main Number', averaging
 * 225 seconds, to two destinations. Add the 83 canvass-line calls and it is
 * ONE cause: real multi-minute conversations that carried on somewhere Five9
 * does not record. The audio is not missing; it was never ours.
 *
 * ── WHY THE TRANSFER LEG AND NOT "WHO OWNS THE NUMBER" ─────────────────────
 * The obvious rule — "a transfer DNIS Reece does not own" — cannot be
 * evaluated here, and pretending otherwise would bake in a wrong answer.
 * 9548008906 IS a Reece number: it is GENERAL_SERVICE_PHONE
 * (src/services/market-phone.js) and the GENERAL/JAX fallback in sql/017. Yet
 * scripts/seed-ci-maps.js deliberately leaves it out of ci_transfer_target_map
 * because "identify that destination" is still an open item. So ownership is
 * the QUESTION this report exists to answer, not an input to it.
 *
 * What is knowable from the row is whether a transfer happened, and where to.
 * Both come from Five9's own labelling: the disposition, or a leg whose
 * DIRECTION says '3rd party transfer' (isTransferLeg, discovery.js — imported
 * rather than re-written, so the two cannot drift).
 *
 * `was_transferred` alone is NOT a trigger. isTransferGroup sets it true for
 * any multi-leg group, which includes ordinary re-dials; using it here would
 * classify unrelated calls as vendor-side and hide real retrieval failures.
 * It is reported as corroboration, never as the reason.
 *
 * @returns {{transferred: boolean, reason: string|null, dnis: string|null}}
 */
/**
 * The one sentence that explains a transferred call. ONE copy: diagnoseCall
 * reaches this verdict from a listing search, diagnoseRecordingGap reaches it
 * before searching at all, and two hand-written copies of the same explanation
 * would drift the moment either was edited.
 */
export function transferDetail(dnis) {
  const shown = dnis ? ` (${formatPhoneLine(dnis) ?? dnis})` : '';
  return `call was transferred to a 3rd party${shown} — the conversation continued off Five9, `
    + 'which records only its own leg. No archive search will find this; it is not a retrieval failure.';
}

export function classifyTransfer(call) {
  const legs = Array.isArray(call?.raw_metadata?.legs) ? call.raw_metadata.legs : [];
  const transferLeg = legs.find(isTransferLeg) ?? null;
  // The destination is the TRANSFER leg's own dnis. ci_calls.dnis is the
  // PRIMARY leg's (discovery.js buildCallRow) — the number the customer
  // reached, not the one they were handed to.
  const dnis = last10(transferLeg?.dnis) ?? null;

  if (TRANSFER_DISPOSITION.test(String(call?.disposition ?? ''))) {
    return { transferred: true, reason: 'disposition', dnis };
  }
  if (transferLeg) {
    return { transferred: true, reason: 'transfer_leg', dnis };
  }
  return { transferred: false, reason: null, dnis: null };
}

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
 * @param {object} [stats]         { same, prev, next } listing reports from the
 *                                 adapter's onStats hook. OPTIONAL: without it
 *                                 this behaves exactly as before, because a
 *                                 caller that cannot see inside list() has no
 *                                 way to tell an empty folder from an unreadable
 *                                 one and must not pretend otherwise.
 */
export function diagnoseCall(call, listings, windowSeconds = 180, stats = null) {
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
        detail: `${rec.sourceFilename ?? rec.sourcePath} matched on re-run (${m.reason})`,
        wanted,
        path: rec.sourcePath ?? null,
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
        path: rec.sourcePath ?? null,
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
      path: nearest?.r?.sourcePath ?? null,
    };
  }

  // 4. WE COULD NOT READ THE FOLDER. The listing succeeded, it held .wav
  //    files, and not one of their names parsed — so list() dropped every one
  //    and returned the same `[]` an empty folder returns.
  //
  //    This is checked ahead of every remaining verdict, INCLUDING transferred,
  //    for the same reason UNKNOWN is checked first: it is a "we could not
  //    look" answer, not a finding about this call. The verdicts below all
  //    assert something about one call's audio; this one says the folder is
  //    unreadable for every call in it, and a systemic signal that gets filed
  //    under a per-call cause is a signal nobody sees. A transferred call in an
  //    unreadable folder is still transferred — but reporting that first would
  //    hide the fact that we cannot read the folder at all, which is the
  //    larger and more urgent finding.
  //
  //    Only reachable when the listing reports its own counts. Without stats
  //    this is invisible and the old empty-folder verdict stands, because a
  //    caller that cannot see inside list() must not pretend it can.
  const wavCount = Number(stats?.same?.wav ?? 0);
  if (!same.length && wavCount > 0) {
    const sample = (stats.same.unparseableNames || []).slice(0, 3);
    return {
      verdict: VERDICTS.FILENAME_UNPARSEABLE,
      detail: `${wavCount} .wav file(s) under campaign '${call.campaign}' for that date and NOT ONE parsed`
        + ' — the archive has the audio; parseRecordingFilename() no longer recognises the name'
        + (sample.length ? `. e.g. ${sample.join(' | ')}` : ''),
      wanted,
    };
  }

  // 5. Nothing found for this number anywhere we looked. BEFORE concluding
  //    retrieval failed, ask whether there was ever anything of ours to
  //    retrieve: a transferred call's conversation continued on a vendor
  //    platform and Five9 holds only its own leg.
  //
  //    This is checked HERE and not earlier on purpose. Every verdict above
  //    means "we found a file for this number" — present, a day away, or just
  //    outside the window — and each of those is recoverable. A transferred
  //    call whose Five9 leg WAS recorded is still a real finding, and letting
  //    'transferred' outrank them would hide it.
  const transfer = classifyTransfer(call);
  if (transfer.transferred) {
    return {
      verdict: VERDICTS.TRANSFERRED,
      detail: transferDetail(transfer.dnis),
      wanted,
      transfer_dnis: transfer.dnis,
      transfer_basis: transfer.reason,
    };
  }

  // 6. The folder is empty — the campaign dir is wrong, or Five9 filed the
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
  if (d.verdict === VERDICTS.FILENAME_UNPARSEABLE && share >= 0.5) {
    return `CONFIRMED: the archive HAS the audio and we cannot read the filenames. `
      + `${d.count} of ${summary.diagnosed} sit in folders holding .wav files of which none parse. `
      + `This is a filename-format change, not a missing recording — do NOT open a vendor ticket and do not `
      + `touch the timestamp arithmetic or the listing cache. Fix parseRecordingFilename() in `
      + `src/ci/filenames.js, then requeue; the audio has been there all along.`;
  }
  if (d.verdict === VERDICTS.TRANSFERRED && share >= 0.5) {
    return `${d.count} of ${summary.diagnosed} were TRANSFERRED to a 3rd party — the conversation continued off `
      + `Five9, which records only its own leg. There is NO code fix and no archive search that will find these. `
      + `Read the per-DNIS rollup below, identify each destination, and agree a feed with that vendor IN WRITING `
      + `(filename convention, timezone, audio format) before any ingest path is built.`;
  }
  if (d.verdict === VERDICTS.CAMPAIGN_DIR_EMPTY && share >= 0.5) {
    return `${d.count} of ${summary.diagnosed} have no audio under their campaign folder at all. `
      + `Either the campaign was renamed in Five9 after these calls, or recording is off for it — check Five9 config before changing any code.`;
  }
  return `MIXED — no single cause covers half the sample (largest: ${d.verdict}, ${d.count} of ${summary.diagnosed}). `
    + `Read the per-call table; these need more than one fix.`;
}

/**
 * Roll transferred calls up per destination. Pure.
 *
 * This is the deliverable, not a footnote: the destinations are unidentified
 * (scripts/seed-ci-maps.js leaves 954-800-8906 out of ci_transfer_target_map
 * precisely because "identify that destination" is still open), and volume per
 * number is what makes them worth identifying — or not.
 *
 * Minutes rather than seconds because the decision this feeds is "is there
 * enough conversation here to be worth a vendor integration".
 *
 * A transferred call whose destination could not be read is counted under
 * `unknown_destination` rather than dropped. Dropping it would understate the
 * volume, which is the one number this rollup exists to get right.
 */
export function summariseTransfers(rows) {
  const byDnis = new Map();
  for (const r of rows || []) {
    if (r?.verdict !== VERDICTS.TRANSFERRED) continue;
    const key = r.transfer_dnis || 'unknown_destination';
    if (!byDnis.has(key)) {
      byDnis.set(key, { dnis: r.transfer_dnis ?? null, calls: 0, seconds: 0, campaigns: new Set(), first: null, last: null });
    }
    const e = byDnis.get(key);
    e.calls += 1;
    if (Number.isFinite(r.duration_seconds)) e.seconds += r.duration_seconds;
    if (r.campaign) e.campaigns.add(r.campaign);
    const t = r.call_start ? new Date(r.call_start) : null;
    if (t && Number.isFinite(t.getTime())) {
      if (!e.first || t < e.first) e.first = t;
      if (!e.last || t > e.last) e.last = t;
    }
  }

  return [...byDnis.entries()]
    .map(([key, e]) => ({
      destination: e.dnis ? (formatPhoneLine(e.dnis) ?? e.dnis) : 'unknown',
      dnis: e.dnis,
      calls: e.calls,
      total_minutes: Math.round(e.seconds / 60),
      avg_seconds: e.calls ? Math.round(e.seconds / e.calls) : 0,
      campaigns: [...e.campaigns].sort(),
      first_call: e.first ? e.first.toISOString() : null,
      last_call: e.last ? e.last.toISOString() : null,
      ...(key === 'unknown_destination' ? { note: 'no transfer-leg DNIS on these rows' } : {}),
    }))
    .sort((a, b) => b.calls - a.calls);
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
    .select('id, five9_call_id, campaign, customer_phone, ani, dnis, call_start, duration_seconds, disposition, was_transferred, review_reason, raw_metadata')
    .in('review_reason', ['recording_missing', 'recording_ambiguous'])
    .order('call_start', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`ci_calls read failed: ${error.message}`);

  // TRANSFERS FIRST, over the whole selection — before the expected-recordings
  // filter, not after it.
  //
  // A transferred call whose Five9 leg produced no recording row has
  // expected_recording_count 0, so it used to fall into
  // `no_audio_correctly_parked` and never be examined at all. That phrase
  // means "nothing to recover", which is the opposite of true here: the
  // conversation happened and the audio exists, on someone else's platform.
  // Reporting it as correctly parked is how 75 real conversations stayed
  // invisible.
  //
  // classifyTransfer is pure and needs no listing, so this costs no extra SFTP
  // round trip and no extra query.
  const results = [];
  const rest = [];
  for (const call of calls || []) {
    const transfer = classifyTransfer(call);
    if (!transfer.transferred) { rest.push(call); continue; }
    results.push({
      five9_call_id: call.five9_call_id,
      call_start: call.call_start,
      campaign: call.campaign,
      duration_seconds: call.duration_seconds ?? null,
      review_reason: call.review_reason,
      expected_recordings: Number(call.raw_metadata?.expected_recording_count ?? 0),
      recordings_raw: call.raw_metadata?.recordings_raw ?? null,
      verdict: VERDICTS.TRANSFERRED,
      detail: transferDetail(transfer.dnis),
      wanted: last10(call.customer_phone || call.ani),
      transfer_dnis: transfer.dnis,
      transfer_basis: transfer.reason,
      // Corroboration only — never the reason. isTransferGroup sets this true
      // for ANY multi-leg group, re-dials included.
      was_transferred: call.was_transferred ?? null,
    });
  }

  // The report saying "audio exists" is what makes a NON-transferred call
  // recoverable. Without it there is nothing to find and the review is correct.
  const withAudio = rest.filter(
    (c) => Number(c.raw_metadata?.expected_recording_count ?? 0) > 0,
  );

  // ONE connection for the whole run. The adapter opens one per list() call
  // otherwise, and this lists up to three directories per call.
  for (const call of withAudio) {
    const listings = {};
    // What each listing DISCARDED, keyed the same way. Without this, a folder
    // of unreadable filenames and an empty folder are the same `[]` and the
    // verdict below cannot separate them.
    const stats = {};
    for (const { label, dir } of candidateDateDirs(call.call_start, cfg.recordingTzOffsetMin)) {
      try {
        listings[label] = await adapter.list({
          campaign: call.campaign,
          date: dir,
          onStats: (s) => { stats[label] = s; },
        });
      } catch (err) {
        // Leave the key ABSENT rather than setting []. An empty array means
        // "the folder is empty"; a missing key means "we could not look", and
        // diagnoseCall must be able to tell those apart.
        console.warn(`${LOG} list failed for ${call.campaign}/${dir}: ${err.message}`);
      }
    }
    const d = diagnoseCall(call, listings, cfg.recordingMatchWindowS ?? 180, stats);
    results.push({
      five9_call_id: call.five9_call_id,
      call_start: call.call_start,
      campaign: call.campaign,
      duration_seconds: call.duration_seconds ?? null,
      review_reason: call.review_reason,
      expected_recordings: Number(call.raw_metadata?.expected_recording_count ?? 0),
      recordings_raw: call.raw_metadata?.recordings_raw ?? null,
      ...d,
    });
  }

  const summary = summariseVerdicts(results);
  const transfers = summariseTransfers(results);
  const transferred = results.filter((r) => r.verdict === VERDICTS.TRANSFERRED).length;
  return {
    examined: (calls || []).length,
    transferred,
    recoverable: withAudio.length,
    // Now means what it says: no audio, AND not a transfer. The transferred
    // calls used to be counted here, which read as "nothing to recover".
    no_audio_correctly_parked: rest.length - withAudio.length,
    results,
    summary,
    transfers,
    recommendation: recommendation(summary),
    note: 'READ ONLY — nothing was re-ingested, re-queued or changed.',
  };
}

export default {
  VERDICTS, candidateDateDirs, diagnoseCall, summariseVerdicts,
  classifyTransfer, summariseTransfers, transferDetail,
  recommendation, diagnoseRecordingGap,
};
