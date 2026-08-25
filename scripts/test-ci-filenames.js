/**
 * Tests — recording filename/path parsing and the three-timezone conversions
 * scripts/test-ci-filenames.js
 *
 * THE TRAPS THESE GUARD, all measured against ETG's archive on 2026-08-20:
 *
 * 1. The leading number in a filename is the ANI, NOT the Five9 Call ID. An
 *    earlier handoff revision assumed a Call ID was recoverable here and the
 *    entire join was designed around it. Nothing may treat it as a call key.
 * 2. agent_username is EMPTY on transfer legs ('by  @', two spaces).
 * 3. ivr_module contains spaces and the separator is the LAST '_' before
 *    '.wav'. Splitting on the first '_' shreds the clock.
 * 4. Filename clocks are FIXED EST with NO DST. Using America/New_York would
 *    shift every August timestamp by an hour and mis-join every recording.
 * 5. Date folders are NOT zero-padded — a padded path does not exist.
 *
 * Pure modules, no env, no network. Run:
 *   node --test scripts/test-ci-filenames.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRecordingFilename,
  parseRecordingPath,
  classifyExclusion,
  isSkippedDir,
  DEFAULT_EXCLUDED_IVR_MODULES,
} from '../src/ci/filenames.js';
import {
  filenameClockToUtc,
  parseDateDir,
  dateDirFor,
  parseClockText,
  pacificWallClockToUtc,
  parsePacificReportTimestamp,
  splitWindows,
  toPacificCriteriaString,
  last4,
  last10,
} from '../src/ci/time.js';

// ─── filename parsing ───────────────────────────────────────────────────────

test('plain agent call: ANI, agent, clock, no module', () => {
  const p = parseRecordingFilename('9419203087 by mgiraldo @ 4_30_12 PM.wav');
  assert.deepEqual(p, {
    ani: '9419203087', agentUsername: 'mgiraldo', clockText: '4_30_12 PM',
    ivrModule: null,
    // Null for every pre-2026-08-22 name. The field exists on both eras so a
    // caller never has to ask which era a row came from.
    sessionId: null,
  });
});

test('transfer leg: agent is EMPTY (by  @) and the module carries spaces', () => {
  const p = parseRecordingFilename('9419203087 by  @ 4_30_12 PM_Transfer to Lightfire.wav');
  assert.equal(p.ani, '9419203087');
  assert.equal(p.agentUsername, '', 'blank agent must parse as empty string, not null or a name');
  assert.equal(p.clockText, '4_30_12 PM');
  assert.equal(p.ivrModule, 'Transfer to Lightfire');
});

test("module name containing spaces AND resembling the padded form parses whole", () => {
  const p = parseRecordingFilename('7275551234 by  @ 11_05_09 AM_Third Party Transfer.wav');
  assert.equal(p.ivrModule, 'Third Party Transfer');
  assert.equal(p.clockText, '11_05_09 AM');
});

test('single-token modules parse (the two no-space test modules)', () => {
  assert.equal(parseRecordingFilename('7275551234 by  @ 9_00_01 AM_ThirdPartyTransfer.wav').ivrModule, 'ThirdPartyTransfer');
  assert.equal(parseRecordingFilename('7275551234 by  @ 9_00_02 AM_ThirdPartyTransfer2.wav').ivrModule, 'ThirdPartyTransfer2');
});

test('an agent call with no module keeps the clock intact — the clock has underscores too', () => {
  const p = parseRecordingFilename('8135550000 by jflanders @ 12_59_59 PM.wav');
  assert.equal(p.clockText, '12_59_59 PM');
  assert.equal(p.ivrModule, null, 'no module suffix present');
});

test('the leading number is the ANI and is never treated as a call id', () => {
  const p = parseRecordingFilename('9419203087 by mgiraldo @ 4_30_12 PM.wav');
  assert.equal(p.ani, '9419203087');
  assert.equal('callId' in p, false);
  assert.equal('five9CallId' in p, false);
});

test('malformed names return null rather than a partial guess', () => {
  for (const bad of [
    '', '   ', 'not a recording.wav', 'recording.mp3',
    '9419203087 by mgiraldo 4_30_12 PM.wav',        // missing '@'
    '9419203087 by mgiraldo @ not-a-clock.wav',      // clock unparseable
    'abc by mgiraldo @ 4_30_12 PM.wav',              // ANI not numeric
  ]) {
    assert.equal(parseRecordingFilename(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

// ─── the 2026-08-22 format change ───────────────────────────────────────────
//
// Five9 began appending a session id: 32 hex characters followed by digits,
// abutting whatever precedes it with NO separator. On a transfer leg it lands
// after the module and the clock in front survives, so those files kept
// parsing. On a plain agent call there is no module segment, so it glues onto
// AM/PM and the whole name stopped parsing — 93% of volume, silently dropped
// for three days. These are the real strings, verbatim from the archive.

const NEW_TRANSFER = '9419203087 by  @ 1_49_32 PM_Transfer to LightfireCB3E712B7E084D8A9BD23381B216E482300000002866719.wav';
const NEW_AGENT = '4436170733 by cdeer @ 7_16_55 AMCB3E712B7E084D8A9BD23381B216E482300000002866719.wav';

test('the new plain-agent shape parses — the cliff', () => {
  const p = parseRecordingFilename(NEW_AGENT);
  assert.ok(p, 'this returning null IS the outage');
  assert.equal(p.ani, '4436170733');
  assert.equal(p.agentUsername, 'cdeer');
  assert.equal(p.clockText, '7_16_55 AM', 'the clock must survive the appended id');
  assert.equal(p.ivrModule, null, 'a plain agent call has no module');
  assert.equal(p.sessionId, 'CB3E712B7E084D8A9BD23381B216E482300000002866719');
});

test('the new transfer shape yields a CLEAN module, not a GUID-suffixed one', () => {
  // This is the assertion that repairs classifyTeam. ci_transfer_target_map
  // holds exactly one label, 'Transfer to Lightfire', and classifyTeam matches
  // it by EXACT equality — so while the id stayed glued to the module, not one
  // transfer leg matched the map. Before the boundary: 101 rows, 2 distinct
  // modules. After: 20 rows, 20 distinct modules.
  const p = parseRecordingFilename(NEW_TRANSFER);
  assert.ok(p);
  assert.equal(p.clockText, '1_49_32 PM');
  assert.equal(p.ivrModule, 'Transfer to Lightfire', 'exact — a prefix match would pass on the broken value');
  assert.equal(p.sessionId, 'CB3E712B7E084D8A9BD23381B216E482300000002866719');
});

test('the session id is NEVER presented as a call id', () => {
  // Verified 2026-08-25: the trailing digits are not ci_calls.five9_call_id.
  // The ranges are disjoint by ~7.4 million and nothing maps between them.
  // The module already carries this warning about the LEADING number; an
  // earlier handoff assumed a call id was recoverable and the entire join had
  // to be redesigned around the retraction.
  const p = parseRecordingFilename(NEW_TRANSFER);
  assert.equal('callId' in p, false);
  assert.equal('five9CallId' in p, false);
  assert.notEqual(p.sessionId, '300000010296218', 'must not be mistaken for the call id');
});

test('a module ENDING IN A HEX CHARACTER is not truncated', () => {
  // 'Transfer to Lightfire' ends in 'e', which is a hex digit — so a leftmost
  // scan for a 32-hex run starts one character early and returns the module as
  // 'Transfer to Lightfir'. A rightmost scan eats into the id instead, because
  // the trailing digits are hex characters too. Only the id's exact shape (32
  // hex + exactly 15 digits, ending the string) pins the boundary.
  //
  // This is the failure mode worth a test of its own: a truncated module is
  // silent. It misses ci_transfer_target_map's exact-equality lookup and
  // re-breaks classifyTeam, which is the defect this parser exists to repair.
  const p = parseRecordingFilename(NEW_TRANSFER);
  assert.equal(p.ivrModule, 'Transfer to Lightfire');
  assert.equal(p.ivrModule.length, 21, 'not 20 — the trailing e belongs to the module');
  assert.ok(/^[0-9A-F]{32}\d{15}$/.test(p.sessionId), 'and the id keeps its leading C');
});

test('a module ending in several hex characters is also intact', () => {
  const facade = '9419203087 by  @ 1_49_32 PM_Transfer to FacadeCB3E712B7E084D8A9BD23381B216E482300000002866719.wav';
  assert.equal(parseRecordingFilename(facade).ivrModule, 'Transfer to Facade');
});

test('excluded modules are matched again once the id is stripped', () => {
  // classifyExclusion compares by exact equality too, so the glued id disarmed
  // the test-module and third-party guards along with team classification.
  const suffixed = '7275551234 by  @ 11_05_09 AM_Third Party TransferCB3E712B7E084D8A9BD23381B216E482300000002866719.wav';
  const p = parseRecordingFilename(suffixed);
  assert.equal(p.ivrModule, 'Third Party Transfer');
  assert.deepEqual(
    classifyExclusion({ ivrModule: p.ivrModule, fileBytes: 350000, excludedModules: DEFAULT_EXCLUDED_IVR_MODULES }),
    { excluded: true, reason: 'test_module' },
  );
});

test('BOTH old shapes still parse byte-identically', () => {
  // The archive holds these back to ~Aug 2023 and the backfill reads them, so
  // a fix that only understands the new era would trade one outage for another.
  const oldAgent = parseRecordingFilename('4436170733 by cdeer @ 7_16_55 AM.wav');
  assert.equal(oldAgent.clockText, '7_16_55 AM');
  assert.equal(oldAgent.ivrModule, null);
  assert.equal(oldAgent.sessionId, null);

  const oldTransfer = parseRecordingFilename('9419203087 by  @ 4_30_12 PM_Transfer to Lightfire.wav');
  assert.equal(oldTransfer.clockText, '4_30_12 PM');
  assert.equal(oldTransfer.ivrModule, 'Transfer to Lightfire');
  assert.equal(oldTransfer.sessionId, null);
});

test('an UNRECOGNISED trailing blob still returns null — the refusal is the feature', () => {
  // A parser that guesses at a shape it does not know is a parser that hides
  // the next vendor change instead of surfacing it. Returning null keeps the
  // file counted as unparseable by createSftpAdapter's onStats, which is the
  // signal that made this break findable at all.
  for (const bad of [
    '4436170733 by cdeer @ 7_16_55 AMWHATEVERCAMENEXT.wav',       // no 32-hex run
    '4436170733 by cdeer @ 7_16_55 AM-CB3E712B7E084D8A.wav',      // hex run too short
    '4436170733 by cdeer @ 7_16_55 AM Transfer to X.wav',         // module without the '_'
    '4436170733 by cdeer @ 7_16_55 AMCB3E712B7E084D8A9BD23381B216E48230000000286671.wav',   // 14 digits, not 15
    '4436170733 by cdeer @ 7_16_55 AMCB3E712B7E084D8A9BD23381B216E4823000000028667199.wav', // 16 digits
  ]) {
    assert.equal(parseRecordingFilename(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

// ─── path parsing ───────────────────────────────────────────────────────────

test('full path splits into campaign dir, unpadded date dir, and filename', () => {
  const p = parseRecordingPath('/Five9/Recordings/Canvass Confirmation - Inbound/8_5_2026/9419203087 by  @ 4_30_12 PM_Transfer to Lightfire.wav');
  assert.equal(p.campaignDir, 'Canvass Confirmation - Inbound');
  assert.equal(p.dateDir, '8_5_2026');
  assert.equal(p.ani, '9419203087');
  assert.equal(p.ivrModule, 'Transfer to Lightfire');
  assert.equal(p.sourceFilename, '9419203087 by  @ 4_30_12 PM_Transfer to Lightfire.wav');
});

// Near-duplicate campaign dirs differing only by case exist on the server.
// Folding them would merge two distinct campaigns into one.
test('campaign dir is preserved verbatim, never case-folded', () => {
  const a = parseRecordingPath('/Five9/Recordings/Magazine - CLiPP/8_5_2026/9419203087 by x @ 1_00_00 PM.wav');
  const b = parseRecordingPath('/Five9/Recordings/Magazine - Clipp/8_5_2026/9419203087 by x @ 1_00_00 PM.wav');
  assert.equal(a.campaignDir, 'Magazine - CLiPP');
  assert.equal(b.campaignDir, 'Magazine - Clipp');
  assert.notEqual(a.campaignDir, b.campaignDir);
});

test('paths outside the root, or nested deeper than campaign/date/file, are rejected', () => {
  assert.equal(parseRecordingPath('/elsewhere/x/8_5_2026/9419203087 by x @ 1_00_00 PM.wav'), null);
  assert.equal(parseRecordingPath('/Five9/Recordings/Camp/8_5_2026/sub/9419203087 by x @ 1_00_00 PM.wav'), null);
  assert.equal(parseRecordingPath('/Five9/Recordings/Camp/9419203087 by x @ 1_00_00 PM.wav'), null);
});

// ─── fixed-offset clock conversion (THE hour-drift guard) ───────────────────

test('AUGUST filename clock converts at FIXED -5, with NO DST shift', () => {
  // Verified real file: '4_30_12 PM' was written at ~21:30 UTC = 16:30 EST.
  const utc = filenameClockToUtc({ dateDir: '8_5_2026', clockText: '4_30_12 PM', offsetMin: -300 });
  assert.equal(utc.toISOString(), '2026-08-05T21:30:12.000Z');

  // America/New_York in August is UTC-4, which would give 20:30:12Z. If this
  // ever equals that, DST has crept into the conversion.
  const dstWrong = new Date(Date.UTC(2026, 7, 5, 20, 30, 12)).toISOString();
  assert.notEqual(utc.toISOString(), dstWrong, 'DST must NOT be applied to filename clocks');
});

test('January and August use the SAME offset — the point of a fixed zone', () => {
  const jan = filenameClockToUtc({ dateDir: '1_5_2026', clockText: '4_30_12 PM' });
  const aug = filenameClockToUtc({ dateDir: '8_5_2026', clockText: '4_30_12 PM' });
  assert.equal(jan.getUTCHours(), 21);
  assert.equal(aug.getUTCHours(), 21, 'August must not shift by an hour');
});

test('midnight and noon meridiem edges convert correctly', () => {
  assert.equal(filenameClockToUtc({ dateDir: '8_5_2026', clockText: '12_00_00 AM' }).toISOString(), '2026-08-05T05:00:00.000Z');
  assert.equal(filenameClockToUtc({ dateDir: '8_5_2026', clockText: '12_00_00 PM' }).toISOString(), '2026-08-05T17:00:00.000Z');
});

test('unparseable fragments yield null, never a guessed instant', () => {
  assert.equal(filenameClockToUtc({ dateDir: '8_5_2026', clockText: '25_00_00 PM' }), null);
  assert.equal(filenameClockToUtc({ dateDir: '13_45_2026', clockText: '4_30_12 PM' }), null);
  assert.equal(filenameClockToUtc({ dateDir: '2_30_2026', clockText: '4_30_12 PM' }), null);
  assert.equal(filenameClockToUtc({}), null);
});

// ─── date dir ───────────────────────────────────────────────────────────────

// Strict out, tolerant in: we must WRITE unpadded because that is the only
// path that exists on the server, but rejecting a padded name on READ would
// skip real recordings if the export ever changed its formatting.
test('date dirs are written UNPADDED, and read leniently', () => {
  assert.deepEqual(parseDateDir('8_5_2026'), { year: 2026, monthIdx: 7, day: 5 });
  assert.deepEqual(parseDateDir('08_05_2026'), { year: 2026, monthIdx: 7, day: 5 }, 'padded input still parses');

  // 5 Aug 2026 17:00 UTC is 12:00 EST the same day.
  assert.equal(dateDirFor(new Date('2026-08-05T17:00:00Z')), '8_5_2026');
  // 02:00 UTC on the 6th is still 21:00 EST on the 5th — the folder is the 5th.
  assert.equal(dateDirFor(new Date('2026-08-06T02:00:00Z')), '8_5_2026');
  // Never emits a padded component, for any single-digit month or day.
  assert.equal(dateDirFor(new Date('2026-01-02T17:00:00Z')), '1_2_2026');
  assert.equal(/(^|_)0\d/.test(dateDirFor(new Date('2026-01-02T17:00:00Z'))), false, 'output must not be zero-padded');
});

test('impossible calendar dates are rejected, not rolled over', () => {
  assert.equal(parseDateDir('2_30_2026'), null);
  assert.equal(parseDateDir('13_1_2026'), null);
});

test('parseClockText rejects out-of-range and missing meridiem', () => {
  assert.deepEqual(parseClockText('4_30_12 PM'), { hour: 16, minute: 30, second: 12 });
  assert.deepEqual(parseClockText('12_00_00 AM'), { hour: 0, minute: 0, second: 0 });
  assert.equal(parseClockText('13_00_00 PM'), null);
  assert.equal(parseClockText('4_30_12'), null);
  assert.equal(parseClockText('4_60_00 PM'), null);
});

// ─── Pacific report timestamps ──────────────────────────────────────────────

test('Pacific report timestamps convert to UTC, DST-aware (unlike filenames)', () => {
  // August: Pacific is UTC-7.
  assert.equal(parsePacificReportTimestamp('2026-08-05 14:30:12').toISOString(), '2026-08-05T21:30:12.000Z');
  // January: Pacific is UTC-8. Same wall clock, DIFFERENT instant — this is
  // exactly the behaviour filename clocks must NOT have.
  assert.equal(parsePacificReportTimestamp('2026-01-05 14:30:12').toISOString(), '2026-01-05T22:30:12.000Z');
});

test('the US-style report shape parses, including meridiem edges', () => {
  assert.equal(parsePacificReportTimestamp('8/5/2026 2:30:12 PM').toISOString(), '2026-08-05T21:30:12.000Z');
  assert.equal(parsePacificReportTimestamp('08/05/2026 12:00:00 AM').toISOString(), '2026-08-05T07:00:00.000Z');
});

test('an unrecognized timestamp returns null instead of a wrong instant', () => {
  for (const bad of ['', 'yesterday', '2026-13-45 99:99:99', 'Aug 5 2026']) {
    assert.equal(parsePacificReportTimestamp(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('criteria strings are naive local datetimes with no Z and no offset', () => {
  const s = toPacificCriteriaString(new Date('2026-08-05T21:30:12Z'));
  assert.equal(s, '2026-08-05T14:30:12');
  assert.equal(/[Zz]|[+-]\d{2}:\d{2}$/.test(s), false, 'must carry no zone marker');
});

test('pacificWallClockToUtc round-trips through the criteria formatter', () => {
  const utc = pacificWallClockToUtc(2026, 7, 5, 14, 30, 12);
  assert.equal(toPacificCriteriaString(utc), '2026-08-05T14:30:12');
});

// ─── window splitting (the 5000-row cap guard) ──────────────────────────────

test('windows split to the requested size and cover the span exactly once', () => {
  const w = splitWindows(new Date('2026-08-05T00:00:00Z'), new Date('2026-08-06T00:00:00Z'), 6);
  assert.equal(w.length, 4);
  assert.equal(w[0].from.toISOString(), '2026-08-05T00:00:00.000Z');
  assert.equal(w[3].to.toISOString(), '2026-08-06T00:00:00.000Z');
  // Contiguous, no gaps and no overlap.
  for (let i = 1; i < w.length; i++) {
    assert.equal(w[i].from.getTime(), w[i - 1].to.getTime());
  }
});

test('a ragged tail becomes a short final window, not an overshoot', () => {
  const w = splitWindows(new Date('2026-08-05T00:00:00Z'), new Date('2026-08-05T07:00:00Z'), 6);
  assert.equal(w.length, 2);
  assert.equal(w[1].to.toISOString(), '2026-08-05T07:00:00.000Z');
  assert.equal(w[1].to.getTime() - w[1].from.getTime(), 60 * 60 * 1000);
});

test('empty or inverted spans yield no windows rather than looping', () => {
  assert.deepEqual(splitWindows(new Date('2026-08-05T00:00:00Z'), new Date('2026-08-05T00:00:00Z')), []);
  assert.deepEqual(splitWindows(new Date('2026-08-06T00:00:00Z'), new Date('2026-08-05T00:00:00Z')), []);
});

// ─── exclusions ─────────────────────────────────────────────────────────────

test('the three transfer-module test names are excluded BY NAME, whatever the size', () => {
  for (const mod of DEFAULT_EXCLUDED_IVR_MODULES) {
    const c = classifyExclusion({ ivrModule: mod, fileBytes: 5_000_000, excludedModules: DEFAULT_EXCLUDED_IVR_MODULES });
    assert.deepEqual(c, { excluded: true, reason: 'test_module' }, `${mod} must be excluded even when large`);
  }
});

test('sub-floor files are excluded by size; real ones are not', () => {
  assert.deepEqual(classifyExclusion({ fileBytes: 1700, minBytes: 8000 }), { excluded: true, reason: 'below_min_bytes' });
  assert.deepEqual(classifyExclusion({ fileBytes: 4900, minBytes: 8000 }), { excluded: true, reason: 'below_min_bytes' });
  assert.deepEqual(classifyExclusion({ fileBytes: 8000, minBytes: 8000 }), { excluded: false, reason: null });
  assert.deepEqual(classifyExclusion({ fileBytes: 250_000, minBytes: 8000 }), { excluded: false, reason: null });
});

test("the vendor's Owner directory is skipped", () => {
  assert.equal(isSkippedDir('Owner'), true);
  assert.equal(isSkippedDir('Main Number'), false);
  assert.deepEqual(classifyExclusion({ campaignDir: 'Owner', fileBytes: 999_999 }), { excluded: true, reason: 'owner_dir' });
});

test('a real transfer recording is NOT excluded — the module is legitimate', () => {
  const c = classifyExclusion({
    ivrModule: 'Transfer to Lightfire',
    fileBytes: 180_000,
    excludedModules: DEFAULT_EXCLUDED_IVR_MODULES,
  });
  assert.deepEqual(c, { excluded: false, reason: null });
});

// ─── PII helpers ────────────────────────────────────────────────────────────

test('last4 masks for logs and never returns the full number', () => {
  assert.equal(last4('9419203087'), 'x3087');
  assert.equal(last4('+1 (941) 920-3087'), 'x3087');
  assert.equal(last4(''), 'x????');
  assert.equal(last4(null), 'x????');
  assert.equal(last4('9419203087').includes('9419'), false, 'must not leak the prefix');
});

test('last10 normalizes for comparison and rejects short input', () => {
  assert.equal(last10('+19419203087'), '9419203087');
  assert.equal(last10('(941) 920-3087'), '9419203087');
  assert.equal(last10('12345'), null);
});
