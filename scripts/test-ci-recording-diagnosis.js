/**
 * Tests — name the cause of 113 missing summaries, or say you could not
 * scripts/test-ci-recording-diagnosis.js
 *
 * WHAT IS AT STAKE. `recording_missing` is the largest single review reason,
 * and 93 of those calls have a Call Log row saying audio EXISTS, plus 20
 * ambiguous — 113 recoverable summaries. Every recording that WAS ingested
 * linked correctly (0 unlinked, every campaign), so the audio was never pulled
 * off the archive rather than pulled and mismatched.
 *
 * ── WHY THE VERDICTS MUST NOT COLLAPSE ─────────────────────────────────────
 * Four causes, four different fixes:
 *
 *   wrong_date_dir               widen the DIRECTORY search
 *   present_should_have_matched  the matcher or the fetch stage, not retrieval
 *   campaign_dir_empty           Five9 config — a rename, or recording off
 *   outside_window               the ±180s window itself
 *
 * Reporting all four as "missing" is what left this unexplained for weeks. Most
 * of the tests below exist to keep them apart.
 *
 * ── AND THE FIFTH, WHICH IS NOT A CAUSE ────────────────────────────────────
 * `unknown` means the archive could not be read. It must never be counted as a
 * finding and must never drive the recommendation — the same rule as the LP
 * read-back: we could not look, so we know nothing.
 *
 * The prime suspect under test: filenames use a FIXED EST −300 with no DST, so
 * during EDT a call after 8pm ET is filed under the PREVIOUS day. The fetch
 * stage lists exactly ONE directory, so that is a whole-directory miss, not a
 * near-miss it could recover from.
 *
 * No network, no SFTP — the listings are injected.
 *
 * Run: node --test scripts/test-ci-recording-diagnosis.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICTS, candidateDateDirs, diagnoseCall, summariseVerdicts,
  recommendation, diagnoseRecordingGap,
} from '../src/ci/recording-diagnosis.js';

/** A late-evening EDT call: 2026-08-21 20:30 ET = 2026-08-22 00:30 UTC. */
const LATE_CALL = {
  id: 'c1',
  five9_call_id: '300000010274880',
  campaign: 'DIAL ASAP',
  customer_phone: '4436170733',
  call_start: '2026-08-22T00:30:00.000Z',
};

/**
 * A recording as describeRecording ACTUALLY returns it.
 *
 * The fields are `sourcePath` and `sourceFilename` — see parseRecordingPath in
 * src/ci/filenames.js. This fixture previously said `fullPath`/`fileName`,
 * mirroring the diagnostic's own mistake rather than the real shape, which is
 * why every `path` in a live /ci/diagnose-recordings report came back null and
 * no test noticed.
 */
const rec = (over = {}) => ({
  sourcePath: '/Five9/Recordings/DIAL ASAP/8_21_2026/4436170733 by cdeer @ 7_30_00 PM.wav',
  sourceFilename: '4436170733 by cdeer @ 7_30_00 PM.wav',
  campaignDir: 'DIAL ASAP',
  ani: '4436170733',
  recordedAt: new Date('2026-08-22T00:30:00.000Z'),
  excluded: false,
  ...over,
});

// ─── the date folders ───────────────────────────────────────────────────────

test('the fixed EST offset files a late EDT call under the PREVIOUS day', () => {
  // 20:30 ET on Aug 21 is 00:30 UTC on Aug 22. dateDirFor(-300) shifts back
  // five hours → 19:30 on Aug 21, so the folder is 8_21_2026 while the call's
  // UTC date is the 22nd. That one-day skew is the whole suspicion.
  const dirs = candidateDateDirs(LATE_CALL.call_start, -300);
  assert.deepEqual(dirs.map((d) => d.label), ['same', 'prev', 'next']);
  assert.equal(dirs[0].dir, '8_21_2026');
  assert.equal(dirs[1].dir, '8_20_2026');
  assert.equal(dirs[2].dir, '8_22_2026');
});

test('an unparseable call_start yields no folders rather than a bogus one', () => {
  assert.deepEqual(candidateDateDirs('not a date', -300), []);
});

// ─── the verdicts, kept apart ───────────────────────────────────────────────

test('THE PRIME SUSPECT: audio one folder over is wrong_date_dir, not missing', () => {
  // The fetch stage lists exactly one directory, so it looked in an empty
  // folder and concluded the audio did not exist. Naming this correctly is the
  // difference between widening a directory search and rewriting timestamp
  // arithmetic that three prior incidents already settled.
  const d = diagnoseCall(LATE_CALL, { same: [], prev: [rec()], next: [] });
  assert.equal(d.verdict, VERDICTS.WRONG_DATE_DIR);
  assert.match(d.detail, /PREV day/);
  assert.match(d.detail, /lists only one directory/);
});

test('audio in the NEXT folder is caught too', () => {
  const d = diagnoseCall(LATE_CALL, { same: [], prev: [], next: [rec()] });
  assert.equal(d.verdict, VERDICTS.WRONG_DATE_DIR);
  assert.match(d.detail, /NEXT day/);
});

test('a file that matches where ingest looked is a MATCHER problem, not retrieval', () => {
  // Completely different investigation, so it gets its own verdict rather than
  // being folded in with the misses.
  const d = diagnoseCall(LATE_CALL, { same: [rec()], prev: [], next: [] });
  assert.equal(d.verdict, VERDICTS.PRESENT_SHOULD_HAVE_MATCHED);
  assert.ok(d.path);
});

test('the right folder with the right number but the wrong time is outside_window', () => {
  const far = rec({ recordedAt: new Date('2026-08-22T02:00:00.000Z') }); // 90 min out
  const d = diagnoseCall(LATE_CALL, { same: [far], prev: [], next: [] }, 180);
  assert.equal(d.verdict, VERDICTS.OUTSIDE_WINDOW);
  assert.match(d.detail, /window is 180s/);
});

test('a FULL folder whose filenames will not parse is NOT reported as empty', () => {
  // The whole reason this verdict exists. list() drops a file it cannot parse
  // and returns [], exactly as it does for a folder holding nothing — so
  // without the listing's own counts these two are the same value, and the
  // report tells Mark that Five9 stopped recording when it did no such thing.
  const stats = {
    same: {
      wav: 312,
      described: 0,
      unparseable: 312,
      unparseableNames: ['4436170733 by cdeer @ 7_30_00 PMB6A58CED4F52462300000002867137.wav'],
    },
  };
  const d = diagnoseCall(LATE_CALL, { same: [], prev: [], next: [] }, 180, stats);
  assert.equal(d.verdict, VERDICTS.FILENAME_UNPARSEABLE);
  assert.match(d.detail, /312 \.wav file\(s\)/);
  assert.match(d.detail, /NOT ONE parsed/);
});

test('without listing stats the empty-folder verdict is unchanged', () => {
  // A caller that cannot see inside list() must not pretend it can.
  const d = diagnoseCall(LATE_CALL, { same: [], prev: [], next: [] }, 180, null);
  assert.equal(d.verdict, VERDICTS.CAMPAIGN_DIR_EMPTY);
});

test('an empty campaign folder is a Five9 config question, not a code one', () => {
  const d = diagnoseCall(LATE_CALL, { same: [], prev: [], next: [] });
  assert.equal(d.verdict, VERDICTS.CAMPAIGN_DIR_EMPTY);
  assert.match(d.detail, /no \.wav files at all/);
});

test('a populated folder with no file for this number is its own verdict', () => {
  const other = rec({ ani: '7273302574', sourcePath: '/x/other.wav' });
  const d = diagnoseCall(LATE_CALL, { same: [other], prev: [], next: [] });
  assert.equal(d.verdict, VERDICTS.NO_FILE_FOR_NUMBER);
  assert.match(d.detail, /none for 4436170733/);
});

test('THE RULE: a listing we could not read is UNKNOWN, never a cause', () => {
  // An absent key means the read failed; an empty array means the folder is
  // empty. Collapsing those would report an SFTP outage as "the audio does not
  // exist" and send someone to fix Five9.
  const d = diagnoseCall(LATE_CALL, { prev: [rec()] });   // no `same` key at all
  assert.equal(d.verdict, VERDICTS.UNKNOWN);
  assert.match(d.detail, /could not be read/);
});

test('the number compared is the CUSTOMER\'s, on both sides', () => {
  // Five9 names files after the number DIALLED, so on an outbound call that is
  // the DNIS, not the ANI. Matching on ani would search a Reece local-presence
  // number and find nothing — the exact bug that stranded 44 calls before.
  const outbound = { ...LATE_CALL, ani: '7275550100', customer_phone: '4436170733' };
  const d = diagnoseCall(outbound, { same: [], prev: [rec()], next: [] });
  assert.equal(d.verdict, VERDICTS.WRONG_DATE_DIR);
  assert.equal(d.wanted, '4436170733');
});

// ─── the tally and the recommendation ───────────────────────────────────────

test('unknown is counted apart and never becomes the dominant cause', () => {
  const s = summariseVerdicts([
    { verdict: VERDICTS.UNKNOWN }, { verdict: VERDICTS.UNKNOWN }, { verdict: VERDICTS.UNKNOWN },
    { verdict: VERDICTS.WRONG_DATE_DIR },
  ]);
  assert.equal(s.unknown, 3);
  assert.equal(s.diagnosed, 1);
  assert.equal(s.dominant.verdict, VERDICTS.WRONG_DATE_DIR, 'unknown must never win');
});

test('a run that read nothing refuses to recommend anything', () => {
  const s = summariseVerdicts([{ verdict: VERDICTS.UNKNOWN }, { verdict: VERDICTS.UNKNOWN }]);
  assert.match(recommendation(s), /INCONCLUSIVE/);
  assert.match(recommendation(s), /change nothing/);
});

test('a confirmed date-boundary cause names the RIGHT fix, and rules out the wrong one', () => {
  const s = summariseVerdicts(Array.from({ length: 10 }, (_, i) => ({
    verdict: i < 8 ? VERDICTS.WRONG_DATE_DIR : VERDICTS.NO_FILE_FOR_NUMBER,
  })));
  const r = recommendation(s);
  assert.match(r, /CONFIRMED/);
  assert.match(r, /widen the DIRECTORY SEARCH/);
  assert.match(r, /NOT to change the timestamp arithmetic/);
});

test('no majority cause says so instead of picking one', () => {
  const s = summariseVerdicts([
    { verdict: VERDICTS.WRONG_DATE_DIR },
    { verdict: VERDICTS.CAMPAIGN_DIR_EMPTY },
    { verdict: VERDICTS.NO_FILE_FOR_NUMBER },
    { verdict: VERDICTS.OUTSIDE_WINDOW },
  ]);
  assert.match(recommendation(s), /MIXED/);
});

// ─── the run ────────────────────────────────────────────────────────────────

function fakeDb(calls) {
  const chain = {
    select() { return chain; },
    in() { return chain; },
    order() { return chain; },
    limit: async () => ({ data: calls, error: null }),
  };
  return { from: () => chain };
}

test('calls the report says have NO audio are excluded entirely', () => {
  // 44 of the 137 have no recording segments. They are correctly in review and
  // there is nothing to recover; diagnosing them would inflate the gap.
  const withAudio = { ...LATE_CALL, raw_metadata: { expected_recording_count: 1 } };
  const without = { ...LATE_CALL, id: 'c2', five9_call_id: '999', raw_metadata: { expected_recording_count: 0 } };
  return diagnoseRecordingGap({
    db: fakeDb([withAudio, without]),
    adapter: { list: async () => [] },
  }).then((out) => {
    assert.equal(out.examined, 2);
    assert.equal(out.recoverable, 1);
    assert.equal(out.no_audio_correctly_parked, 1);
    assert.equal(out.results.length, 1);
  });
});

test('a failed listing leaves the key ABSENT so the verdict stays unknown', async () => {
  const call = { ...LATE_CALL, raw_metadata: { expected_recording_count: 1 } };
  const out = await diagnoseRecordingGap({
    db: fakeDb([call]),
    adapter: { list: async () => { throw new Error('ECONNRESET'); } },
  });
  assert.equal(out.results[0].verdict, VERDICTS.UNKNOWN);
  assert.equal(out.summary.diagnosed, 0);
  assert.match(out.recommendation, /INCONCLUSIVE/);
});

test('it announces that it changed nothing, and has no write path', async () => {
  const call = { ...LATE_CALL, raw_metadata: { expected_recording_count: 1 } };
  const out = await diagnoseRecordingGap({ db: fakeDb([call]), adapter: { list: async () => [] } });
  assert.match(out.note, /READ ONLY/);
  const src = diagnoseRecordingGap.toString();
  for (const write of ['.update(', '.insert(', '.delete(', '.upsert(', 'fetch(']) {
    assert.equal(src.includes(write), false, `diagnosis must never ${write}`);
  }
});

test('an adapter is required — it must never silently diagnose nothing', async () => {
  await assert.rejects(() => diagnoseRecordingGap({ db: fakeDb([]) }), /no SFTP adapter/);
});
