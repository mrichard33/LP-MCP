/**
 * Tests — recording→call join, team classification, and the read-only guard
 * scripts/test-ci-recordings.js
 *
 * THE TRAPS THESE GUARD:
 *
 * 1. THE JOIN CAN BE AMBIGUOUS AND MUST SAY SO. The Call ID is not in the
 *    filename, so recordings match on campaign + ANI + time. Repeat dials to
 *    one number minutes apart are routine — one number showed five files in
 *    sixteen minutes — so two candidates inside the window is a NORMAL case.
 *    Picking one anyway files a customer's conversation under a stranger.
 * 2. CAMPAIGN MUST MATCH EXACTLY. Near-duplicate campaign directories differ
 *    only by case ('Magazine - CLiPP' vs 'Magazine - Clipp'). Folding merges
 *    two campaigns.
 * 3. THE ADAPTER MUST NEVER WRITE. nas1 is ETG's archive, is the system of
 *    record for every recording the business has, and our account holds
 *    rwxrwxrwx over it. Mutating operations must refuse — permanently, and
 *    whatever the config says.
 *
 * No network. Run: node --test scripts/test-ci-recordings.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchRecordingToCall,
  candidateDistanceSeconds,
  describeRecording,
  classifyTeam,
  assertReadOnly,
  refuseMutation,
  createSftpAdapter,
  createManualAdapter,
  sha256Hex,
  FORBIDDEN_OPS,
} from '../src/ci/recordings.js';
import { bestRecordingForCall } from '../src/ci/worker.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});

/** A parsed recording, as describeRecording would produce it. */
function rec({ ani = '9419203087', campaignDir = 'Main Number', at = '2026-08-05T21:30:12Z', duration = null, path = '/Five9/Recordings/Main Number/8_5_2026/f.wav' } = {}) {
  return { ani, campaignDir, recordedAt: new Date(at), durationSeconds: duration, sourcePath: path, sourceFilename: 'f.wav' };
}

/** A ci_calls row. */
function call({ id = 'call-1', ani = '9419203087', campaign = 'Main Number', start = '2026-08-05T21:30:00Z', duration = 135 } = {}) {
  return { id, ani, campaign, call_start: start, duration_seconds: duration };
}

// ─── candidate scoring ──────────────────────────────────────────────────────

test('a candidate is disqualified unless campaign AND ANI both match', () => {
  assert.equal(typeof candidateDistanceSeconds(rec(), call()), 'number');
  assert.equal(candidateDistanceSeconds(rec({ campaignDir: 'Other' }), call()), null);
  assert.equal(candidateDistanceSeconds(rec({ ani: '7275550000' }), call()), null);
});

test('campaign comparison is EXACT — case-differing near-duplicates never match', () => {
  assert.equal(candidateDistanceSeconds(rec({ campaignDir: 'Magazine - CLiPP' }), call({ campaign: 'Magazine - Clipp' })), null);
  assert.equal(typeof candidateDistanceSeconds(rec({ campaignDir: 'Magazine - CLiPP' }), call({ campaign: 'Magazine - CLiPP' })), 'number');
});

test('ANI compares on the last 10 digits, so formatting differences still match', () => {
  assert.equal(candidateDistanceSeconds(rec({ ani: '9419203087' }), call({ ani: '+1 (941) 920-3087' })), 12);
});

// ─── the never-guess rules ──────────────────────────────────────────────────

test('exactly one candidate inside the window links with a method and confidence', () => {
  const m = matchRecordingToCall(rec(), [call()], { windowSeconds: 180 });
  assert.equal(m.call.id, 'call-1');
  assert.equal(m.method, 'campaign_ani_time');
  assert.ok(m.confidence > 0.5 && m.confidence <= 1);
  assert.equal(m.reason, 'single_candidate');
});

test('a candidate outside the window does not link', () => {
  const m = matchRecordingToCall(rec({ at: '2026-08-05T21:40:00Z' }), [call()], { windowSeconds: 180 });
  assert.equal(m.call, null);
  assert.equal(m.reason, 'no_candidate');
});

test('a clearly nearer candidate wins when the gap is decisive', () => {
  const near = call({ id: 'near', start: '2026-08-05T21:30:00Z' });   // 12s away
  const far = call({ id: 'far', start: '2026-08-05T21:32:30Z' });     // 138s away
  const m = matchRecordingToCall(rec(), [near, far], { windowSeconds: 180 });
  assert.equal(m.call.id, 'near');
  assert.equal(m.reason, 'nearest_by_time');
});

// THIS is the case the design exists for: five files to one number inside
// sixteen minutes is real, observed traffic.
test('two indistinguishably-close candidates stay UNLINKED rather than guessed', () => {
  const a = call({ id: 'a', start: '2026-08-05T21:30:00Z', duration: 100 });
  const b = call({ id: 'b', start: '2026-08-05T21:30:20Z', duration: 100 });
  const m = matchRecordingToCall(rec({ at: '2026-08-05T21:30:10Z' }), [a, b], { windowSeconds: 180 });
  assert.equal(m.call, null, 'must not pick one');
  assert.equal(m.reason, 'ambiguous');
  assert.equal(m.method, null);
  assert.equal(m.confidence, null);
});

test('duration breaks a time-tie only when it is itself decisive', () => {
  const a = call({ id: 'a', start: '2026-08-05T21:30:00Z', duration: 30 });
  const b = call({ id: 'b', start: '2026-08-05T21:30:20Z', duration: 300 });
  // Recording is 300s long → matches b, and by a wide margin.
  const m = matchRecordingToCall(rec({ at: '2026-08-05T21:30:10Z', duration: 300 }), [a, b], { windowSeconds: 180 });
  assert.equal(m.call.id, 'b');
  assert.equal(m.reason, 'nearest_by_duration');

  // Durations equally close → still ambiguous.
  const c = call({ id: 'c', start: '2026-08-05T21:30:00Z', duration: 100 });
  const d = call({ id: 'd', start: '2026-08-05T21:30:20Z', duration: 102 });
  const m2 = matchRecordingToCall(rec({ at: '2026-08-05T21:30:10Z', duration: 101 }), [c, d], { windowSeconds: 180 });
  assert.equal(m2.call, null);
  assert.equal(m2.reason, 'ambiguous');
});

test('a recording with no parsed timestamp never links', () => {
  const m = matchRecordingToCall({ ...rec(), recordedAt: null }, [call()], { windowSeconds: 180 });
  assert.equal(m.call, null);
});

test('closer in time yields higher confidence', () => {
  const near = matchRecordingToCall(rec({ at: '2026-08-05T21:30:00Z' }), [call()], { windowSeconds: 180 });
  const far = matchRecordingToCall(rec({ at: '2026-08-05T21:32:00Z' }), [call()], { windowSeconds: 180 });
  assert.ok(near.confidence > far.confidence);
});

// ─── the inverse: one call, several recordings ──────────────────────────────

test('one call with two equally-plausible recordings stays unlinked', () => {
  const c = call();
  const r1 = rec({ at: '2026-08-05T21:30:05Z', path: '/Five9/Recordings/Main Number/8_5_2026/a.wav' });
  const r2 = rec({ at: '2026-08-05T21:30:07Z', path: '/Five9/Recordings/Main Number/8_5_2026/b.wav' });
  const best = bestRecordingForCall(c, [r1, r2], 180);
  assert.equal(best.recording, null);
  assert.equal(best.reason, 'ambiguous');
});

test('one call with a single recording links it', () => {
  const best = bestRecordingForCall(call(), [rec()], 180);
  assert.equal(best.recording.sourcePath, '/Five9/Recordings/Main Number/8_5_2026/f.wav');
});

test('no candidates at all is distinct from ambiguous', () => {
  assert.equal(bestRecordingForCall(call(), [], 180).reason, 'no_candidate');
});

// ─── describeRecording: parse + classify in one pass ────────────────────────

test('a real transfer-leg path describes fully, with a fixed-EST timestamp', () => {
  const d = describeRecording({
    fullPath: '/Five9/Recordings/Canvass Confirmation - Inbound/8_5_2026/9419203087 by  @ 4_30_12 PM_Transfer to Lightfire.wav',
    fileBytes: 180_000,
    cfg: CFG,
  });
  assert.equal(d.campaignDir, 'Canvass Confirmation - Inbound');
  assert.equal(d.ani, '9419203087');
  assert.equal(d.agentUsername, '');
  assert.equal(d.ivrModule, 'Transfer to Lightfire');
  assert.equal(d.recordedAt.toISOString(), '2026-08-05T21:30:12.000Z');
  assert.equal(d.excluded, false);
});

test('test-module and sub-floor files describe as excluded WITH a reason', () => {
  const testModule = describeRecording({
    fullPath: '/Five9/Recordings/Main Number/8_14_2026/9419203087 by  @ 9_00_01 AM_ThirdPartyTransfer.wav',
    fileBytes: 4_900, cfg: CFG,
  });
  assert.equal(testModule.excluded, true);
  assert.equal(testModule.excludedReason, 'test_module', 'name wins over size');

  const tiny = describeRecording({
    fullPath: '/Five9/Recordings/Main Number/8_5_2026/9419203087 by x @ 9_00_01 AM.wav',
    fileBytes: 1_700, cfg: CFG,
  });
  assert.equal(tiny.excluded, true);
  assert.equal(tiny.excludedReason, 'below_min_bytes');
});

test('an unparseable path describes as null rather than a partial row', () => {
  assert.equal(describeRecording({ fullPath: '/Five9/Recordings/Main Number/8_5_2026/garbage.wav', fileBytes: 99_999, cfg: CFG }), null);
});

// ─── team classification ────────────────────────────────────────────────────

const TRANSFER_TARGETS = [{ dnis: '4075126443', team: 'lightfire', label: 'Transfer to Lightfire' }];

test('IVR module beats the agent and campaign maps', () => {
  const agentMap = new Map([['300000002234619', { team: 'reece' }]]);
  const t = classifyTeam(
    { ivrModule: 'Transfer to Lightfire', agentFive9Id: '300000002234619', campaign: 'Main Number' },
    { transferTargets: TRANSFER_TARGETS, agentMap },
  );
  assert.deepEqual(t, { team: 'lightfire', source: 'ivr_module' });
});

test('the label must match the module string exactly — a description matches nothing', () => {
  const wrongLabel = [{ dnis: '4075126443', team: 'lightfire', label: 'LightFire canvass-confirmation transfer leg' }];
  const t = classifyTeam({ ivrModule: 'Transfer to Lightfire' }, { transferTargets: wrongLabel });
  assert.deepEqual(t, { team: 'unknown', source: 'none' },
    'this is why ci_transfer_target_map.label is the module string, not prose');
});

test('without a module, the agent map then the campaign map decide', () => {
  const agentMap = new Map([['a1', { team: 'reece' }]]);
  const campaignMap = new Map([['Canvass Confirmation - Inbound', { team: 'lightfire' }]]);
  assert.deepEqual(classifyTeam({ agentFive9Id: 'a1' }, { agentMap }), { team: 'reece', source: 'agent_map' });
  assert.deepEqual(
    classifyTeam({ campaign: 'Canvass Confirmation - Inbound' }, { campaignMap }),
    { team: 'lightfire', source: 'campaign_map' },
  );
});

test('the agent map resolves by LOGIN — the only id the report and filenames share', () => {
  // Verified live 2026-08-21: no agent-id column exists in the Call Log, and a
  // recording filename carries the username too. Keyed on the numeric id, this
  // branch never fires and every agent call falls to the campaign map.
  const agentMap = new Map([['swalker1', { team: 'lightfire' }]]);
  assert.deepEqual(
    classifyTeam({ agentUsername: 'swalker1' }, { agentMap }),
    { team: 'lightfire', source: 'agent_map' },
  );
  // The module still outranks it.
  assert.deepEqual(
    classifyTeam(
      { ivrModule: 'Transfer to Lightfire', agentUsername: 'swalker1' },
      { agentMap, transferTargets: [{ label: 'Transfer to Lightfire', team: 'lightfire' }] },
    ),
    { team: 'lightfire', source: 'ivr_module' },
  );
});

test("an agent mapped 'unknown' does not satisfy classification — it falls through", () => {
  const agentMap = new Map([['a1', { team: 'unknown' }]]);
  const campaignMap = new Map([['Main Number', { team: 'reece' }]]);
  assert.deepEqual(
    classifyTeam({ agentFive9Id: 'a1', campaign: 'Main Number' }, { agentMap, campaignMap }),
    { team: 'reece', source: 'campaign_map' },
  );
});

test("nothing known yields 'unknown', never a guessed team", () => {
  assert.deepEqual(classifyTeam({}, {}), { team: 'unknown', source: 'none' });
});

// ─── the read-only guard ────────────────────────────────────────────────────

test('assertReadOnly throws when the guard is disarmed', () => {
  assert.doesNotThrow(() => assertReadOnly(parseConfig({})));
  assert.doesNotThrow(() => assertReadOnly(parseConfig({ CI_SFTP_READONLY: 'true' })));
  assert.throws(() => assertReadOnly(parseConfig({ CI_SFTP_READONLY: 'false' })), /refusing to operate with writes enabled/);
});

test('every mutating operation refuses, and names why', () => {
  const adapter = createSftpAdapter({ cfg: parseConfig({}) });
  for (const op of FORBIDDEN_OPS) {
    assert.equal(typeof adapter[op], 'function', `${op} must exist so reaching for it is an explained refusal`);
    assert.throws(() => adapter[op](), /refused|system of record/i, `${op} must refuse`);
  }
  assert.throws(() => refuseMutation('delete'), /list\+download only/);
});

test('list and fetch refuse outright when the guard is disarmed', async () => {
  const adapter = createSftpAdapter({ cfg: parseConfig({ CI_SFTP_READONLY: 'false' }) });
  await assert.rejects(adapter.list({ campaign: 'Main Number', date: '8_5_2026' }), /refusing to operate/);
  await assert.rejects(adapter.fetch({ sourcePath: '/Five9/Recordings/x/8_5_2026/f.wav' }), /refusing to operate/);
});

test('the adapter lists a date folder without ever writing, and skips non-wav', async () => {
  const listed = [];
  const client = {
    async list(dir) {
      listed.push(dir);
      return [
        { name: '9419203087 by mgiraldo @ 4_30_12 PM.wav', size: 180_000, type: '-' },
        { name: 'notes.txt', size: 10, type: '-' },
        { name: 'subdir', size: 0, type: 'd' },
      ];
    },
  };
  const adapter = createSftpAdapter({ cfg: parseConfig({ CI_SFTP_PASSWORD: 'x' }), clientFactory: () => client });
  const out = await adapter.list({ campaign: 'Main Number', date: '8_5_2026', client });
  assert.deepEqual(listed, ['/Five9/Recordings/Main Number/8_5_2026'], 'unpadded date dir, exact campaign');
  assert.equal(out.length, 1, 'only the .wav');
  assert.equal(out[0].ani, '9419203087');
});

test("a missing date folder is empty, not an error — no calls that day is normal", async () => {
  const client = { async list() { const e = new Error('No such file'); throw e; } };
  const adapter = createSftpAdapter({ cfg: parseConfig({ CI_SFTP_PASSWORD: 'x' }), clientFactory: () => client });
  assert.deepEqual(await adapter.list({ campaign: 'Main Number', date: '8_5_2026', client }), []);
});

test("the vendor's Owner directory is never listed", async () => {
  let called = false;
  const client = { async list() { called = true; return []; } };
  const adapter = createSftpAdapter({ cfg: parseConfig({ CI_SFTP_PASSWORD: 'x' }), clientFactory: () => client });
  assert.deepEqual(await adapter.list({ campaign: 'Owner', date: '8_5_2026', client }), []);
  assert.equal(called, false, 'must not even reach the server');
});

test('list requires a campaign — an unqualified crawl would walk ~1,025 date folders', async () => {
  const adapter = createSftpAdapter({ cfg: parseConfig({ CI_SFTP_PASSWORD: 'x' }), clientFactory: () => ({}) });
  await assert.rejects(adapter.list({}), /requires a campaign/);
});

test('connecting without a password fails before any network call', async () => {
  const adapter = createSftpAdapter({ cfg: parseConfig({}) });
  await assert.rejects(adapter.fetch({ sourcePath: '/x/y/z.wav' }), /CI_SFTP_PASSWORD is not set/);
});

// ─── manual adapter + hashing ───────────────────────────────────────────────

test('the manual adapter returns supplied bytes and rejects empty uploads', async () => {
  const m = createManualAdapter();
  const buf = Buffer.from('RIFFfake-wav-bytes');
  assert.equal((await m.fetch({ buffer: buf })).equals(buf), true);
  await assert.rejects(m.fetch({ buffer: Buffer.alloc(0) }), /non-empty buffer/);
  await assert.rejects(m.fetch({}), /non-empty buffer/);
  assert.deepEqual(await m.list(), []);
});

test('content hashing is stable — the same bytes give the same storage path', () => {
  const a = sha256Hex(Buffer.from('same'));
  const b = sha256Hex(Buffer.from('same'));
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, sha256Hex(Buffer.from('different')));
});
