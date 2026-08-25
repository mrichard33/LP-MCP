/**
 * Tests — the fetch-stage trace and the listing counts it depends on
 * scripts/test-ci-fetch-trace.js
 *
 * WHAT THESE GUARD, measured against the live pipeline on 2026-08-25:
 *
 * 1. adapter.list() narrows a directory THREE times and every narrowing is
 *    silent. A folder of 312 unreadable filenames and an empty folder are the
 *    same return value, `[]`. These assert the counts that separate them.
 * 2. The Five9 recording filename format changed over the 2026-08-22/23
 *    weekend: a session GUID is now appended. On a TRANSFER leg it lands after
 *    the last '_', inside the ivr_module token, and the clock in front of it
 *    survives — so those files still parse. On a plain agent call there is no
 *    module segment and the GUID glues onto 'AM'/'PM', so the clock does not
 *    parse and the file is dropped. That asymmetry is why exactly two
 *    campaigns kept ingesting while the rest reported empty folders.
 * 3. The recording export is FIXED EST (-300) with NO DST. Asserted here as a
 *    disproof, not an aspiration: a 20:30 ET call resolves to the same folder
 *    under -300 as the archive actually uses. Three investigations have now
 *    proposed switching this to America/New_York; the arithmetic says no.
 * 4. A listing that throws ENOENT is swallowed into [] and must still be
 *    reported, or "the folder is not there" reads as "the folder is empty".
 *
 * NO ENV, NO NETWORK, NO CREDENTIALS. FIVE9_USERNAME and FIVE9_PASSWORD are
 * never read — five failed logins lock the account the floor dials on. The
 * SFTP client is a stub and the adapter never connects. Run:
 *   node --test scripts/test-ci-fetch-trace.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSftpAdapter, STATS_SAMPLE } from '../src/ci/recordings.js';
import { traceVerdict, TRACE_VERDICTS, EDT_OFFSET_MIN } from '../src/ci/fetch-trace.js';
import { parseRecordingFilename } from '../src/ci/filenames.js';
import { dateDirFor } from '../src/ci/time.js';

/** Config as deployed, minus anything that would reach the network. */
const CFG = {
  recordingTzOffsetMin: -300,
  recordingMatchWindowS: 180,
  minRecordingBytes: 8000,
  sftp: { root: '/Five9/Recordings', readOnly: true, password: 'unused-stub' },
};

/** A stub SFTP client. Never connects; `list` returns what it is handed. */
const stubClient = (entries, err = null) => ({
  async list() {
    if (err) throw err;
    return entries;
  },
  async end() {},
});

const file = (name, size = 350000) => ({ type: '-', name, size });

/* ─── the real filenames, verbatim from the archive ──────────────────────── */

// Ingested 2026-08-20, before the change. Module has no GUID.
const OLD_TRANSFER = '9419203087 by  @ 4_30_12 PM_Transfer to Lightfire.wav';
// Ingested 2026-08-25, after the change. Same shape plus a session GUID.
const NEW_TRANSFER = '9419203087 by  @ 1_49_32 PM_Transfer to LightfireCB3E712B7E084D8A9BD23381B216E482300000002866719.wav';
// A plain agent call, old format. 93% of all prior volume looked like this.
const OLD_AGENT = '4436170733 by cdeer @ 7_16_55 AM.wav';
// The same call under the new format: no '_module' segment, so the GUID
// appends straight onto the clock.
const NEW_AGENT = '4436170733 by cdeer @ 7_16_55 AMCB3E712B7E084D8A9BD23381B216E482300000002866719.wav';

/* ─── the filename asymmetry ─────────────────────────────────────────────── */

test('a transfer-leg filename survives the appended session GUID', () => {
  // The GUID lands after the LAST '_', so the clock in front of it is intact
  // and the module token simply absorbs it. This is why Canvass Confirmation -
  // Inbound and Dispatch never stopped ingesting.
  const parsed = parseRecordingFilename(NEW_TRANSFER);
  assert.ok(parsed, 'the transfer-leg name should still parse');
  assert.equal(parsed.clockText, '1_49_32 PM');
  assert.equal(parsed.ani, '9419203087');
  assert.equal(parsed.agentUsername, '');
  assert.match(parsed.ivrModule, /^Transfer to Lightfire/);
});

test('a plain agent-call filename does NOT survive it — this is the cliff', () => {
  assert.ok(parseRecordingFilename(OLD_AGENT), 'the old shape parsed');
  assert.equal(
    parseRecordingFilename(NEW_AGENT),
    null,
    'with no module segment the GUID glues onto AM/PM and the clock stops parsing',
  );
});

test('the old transfer shape still parses — the fix must not regress it', () => {
  const parsed = parseRecordingFilename(OLD_TRANSFER);
  assert.ok(parsed);
  assert.equal(parsed.ivrModule, 'Transfer to Lightfire');
});

/* ─── the listing counts ─────────────────────────────────────────────────── */

test('list() reports what it silently discarded', async () => {
  const entries = [
    { type: 'd', name: 'nested' },
    file('notes.txt'),
    file(NEW_TRANSFER),
    file(NEW_AGENT),
    file(NEW_AGENT.replace('4436170733', '7273302574')),
  ];
  let stats = null;
  const adapter = createSftpAdapter({ cfg: CFG });
  const out = await adapter.list({
    campaign: 'Main Number',
    date: '8_25_2026',
    client: stubClient(entries),
    onStats: (s) => { stats = s; },
  });

  // The return value is unchanged: one parseable file out of five entries.
  assert.equal(out.length, 1);

  assert.ok(stats, 'onStats must fire');
  assert.equal(stats.dir, '/Five9/Recordings/Main Number/8_25_2026');
  assert.equal(stats.entries, 5);
  assert.equal(stats.dirs, 1);
  assert.equal(stats.nonWav, 1);
  assert.equal(stats.wav, 3);
  assert.equal(stats.described, 1);
  // THE NUMBER THE WHOLE INVESTIGATION TURNS ON.
  assert.equal(stats.unparseable, 2);
  assert.equal(stats.unparseableNames.length, 2);
  assert.equal(stats.unparseableNames[0], NEW_AGENT);
  assert.equal(stats.listError, null);
});

test('a folder where NOTHING parses returns [] exactly like an empty one', async () => {
  const entries = [file(NEW_AGENT), file(NEW_AGENT.replace('4436', '7273'))];
  let stats = null;
  const adapter = createSftpAdapter({ cfg: CFG });
  const out = await adapter.list({
    campaign: 'Main Number', date: '8_25_2026',
    client: stubClient(entries), onStats: (s) => { stats = s; },
  });
  // Indistinguishable at the call site — which is the defect.
  assert.deepEqual(out, []);
  // Distinguishable in the report — which is the fix.
  assert.equal(stats.wav, 2);
  assert.equal(stats.described, 0);
  assert.equal(stats.unparseable, 2);
});

test('the verbatim filename samples are capped', async () => {
  const entries = Array.from({ length: 12 }, (_, i) =>
    file(NEW_AGENT.replace('4436170733', `44361707${String(i).padStart(2, '0')}`)));
  let stats = null;
  const adapter = createSftpAdapter({ cfg: CFG });
  await adapter.list({
    campaign: 'Main Number', date: '8_25_2026',
    client: stubClient(entries), onStats: (s) => { stats = s; },
  });
  assert.equal(stats.wav, 12);
  assert.equal(stats.unparseable, 12);
  assert.equal(stats.unparseableNames.length, STATS_SAMPLE);
  assert.equal(stats.wavNames.length, STATS_SAMPLE);
});

test('a swallowed ENOENT is reported rather than passing as an empty folder', async () => {
  let stats = null;
  const adapter = createSftpAdapter({ cfg: CFG });
  const out = await adapter.list({
    campaign: 'Main Number', date: '8_25_2026',
    client: stubClient(null, new Error('list: No such file /Five9/Recordings/Main Number/8_25_2026')),
    onStats: (s) => { stats = s; },
  });
  assert.deepEqual(out, [], 'the swallow-to-[] behaviour is unchanged in this PR');
  assert.match(stats.listError, /No such file/);
  assert.equal(stats.entries, 0);
});

test('a listing that throws for any other reason still propagates', async () => {
  const adapter = createSftpAdapter({ cfg: CFG });
  await assert.rejects(
    () => adapter.list({
      campaign: 'Main Number', date: '8_25_2026',
      client: stubClient(null, new Error('Permission denied')),
    }),
    /Permission denied/,
  );
});

test('onStats is optional and a throwing one cannot fail the listing', async () => {
  const adapter = createSftpAdapter({ cfg: CFG });
  const entries = [file(NEW_TRANSFER)];

  const withoutHook = await adapter.list({
    campaign: 'Main Number', date: '8_25_2026', client: stubClient(entries),
  });
  assert.equal(withoutHook.length, 1, 'no hook, no behaviour change');

  const withBadHook = await adapter.list({
    campaign: 'Main Number', date: '8_25_2026', client: stubClient(entries),
    onStats: () => { throw new Error('a reporter bug'); },
  });
  assert.equal(withBadHook.length, 1, 'a diagnostic must never cost a recording');
});

/* ─── the fixed EST offset, asserted as a disproof ───────────────────────── */

test('a 20:30 ET call resolves to the SAME folder under -300 and -240', () => {
  // 20:30 ET on 2026-08-25 is 00:30 UTC on the 26th. -300 shifts back to
  // 19:30 on the 25th; -240 to 20:30 on the 25th. Same day, same folder.
  const callStart = new Date('2026-08-26T00:30:00.000Z');
  assert.equal(dateDirFor(callStart, -300), '8_25_2026');
  assert.equal(dateDirFor(callStart, EDT_OFFSET_MIN), '8_25_2026');
});

test('the two offsets disagree only in the midnight-to-1am ET band', () => {
  // 00:30 ET on the 26th = 04:30 UTC. -300 puts it at 23:30 on the 25th;
  // -240 at 00:30 on the 26th. One hour a day, not a cliff — and -300 is what
  // the archive itself uses, verified by a fetched file whose 2_53_02 PM clock
  // in 8_25_2026 stored recorded_at 19:53:02Z, exactly five hours apart.
  const midnightish = new Date('2026-08-26T04:30:00.000Z');
  assert.equal(dateDirFor(midnightish, -300), '8_25_2026');
  assert.equal(dateDirFor(midnightish, EDT_OFFSET_MIN), '8_26_2026');
});

/* ─── the verdicts ───────────────────────────────────────────────────────── */

const stats = (over = {}) => ({
  dir: '/Five9/Recordings/Main Number/8_25_2026',
  entries: 0, dirs: 0, nonWav: 0, wav: 0,
  unparseable: 0, unparseableNames: [], wavNames: [],
  described: 0, excluded: 0, usable: 0,
  listError: null, skippedDir: false,
  ...over,
});

test('a full folder that parsed nothing is filename_unparseable, never empty', () => {
  const v = traceVerdict(
    stats({ entries: 313, wav: 312, unparseable: 312, unparseableNames: [NEW_AGENT] }),
    { recording: null },
  );
  assert.equal(v.verdict, TRACE_VERDICTS.FILENAME_UNPARSEABLE);
  assert.match(v.detail, /NOT ONE parsed/);
});

test('a partially-parsing folder is called out separately', () => {
  const v = traceVerdict(
    stats({ entries: 300, wav: 300, unparseable: 288, described: 12, usable: 12 }),
    { recording: null },
  );
  assert.equal(v.verdict, TRACE_VERDICTS.FILENAME_PARTIALLY_UNPARSEABLE);
  assert.match(v.detail, /288 of 300/);
});

test('a genuinely empty folder keeps its own verdict', () => {
  const v = traceVerdict(stats(), { recording: null });
  assert.equal(v.verdict, TRACE_VERDICTS.FOLDER_EMPTY);
});

test('a swallowed listing error is never reported as an empty folder', () => {
  const v = traceVerdict(stats({ listError: 'No such file' }), { recording: null });
  assert.equal(v.verdict, TRACE_VERDICTS.LISTING_FAILED);
  assert.match(v.detail, /cannot tell this from an empty folder/);
});

test('a call whose audio matches on re-run is not a retrieval gap', () => {
  const v = traceVerdict(
    stats({ entries: 40, wav: 40, described: 40, usable: 40 }),
    {
      recording: { sourceFilename: OLD_TRANSFER, sourcePath: `/x/${OLD_TRANSFER}` },
      reason: 'single_candidate',
      confidence: 0.894,
    },
  );
  assert.equal(v.verdict, TRACE_VERDICTS.WOULD_MATCH);
  assert.match(v.detail, /NOT a retrieval gap/);
});

test('a parsed folder with every file excluded says so', () => {
  const v = traceVerdict(
    stats({ entries: 6, wav: 6, described: 6, excluded: 6, usable: 0 }),
    { recording: null },
  );
  assert.equal(v.verdict, TRACE_VERDICTS.ALL_EXCLUDED);
});

test('files for this number that fell outside the window are their own verdict', () => {
  const v = traceVerdict(
    stats({ entries: 40, wav: 40, described: 40, usable: 40 }),
    { recording: null },
    { forNumber: 2 },
  );
  assert.equal(v.verdict, TRACE_VERDICTS.OUTSIDE_WINDOW);
});

test('a populated folder with nothing for this number is no_file_for_number', () => {
  const v = traceVerdict(
    stats({ entries: 40, wav: 40, described: 40, usable: 40 }),
    { recording: null },
    { forNumber: 0 },
  );
  assert.equal(v.verdict, TRACE_VERDICTS.NO_FILE_FOR_NUMBER);
});
