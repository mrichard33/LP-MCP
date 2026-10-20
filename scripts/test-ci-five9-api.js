/**
 * Tests — the Five9 API recording source (2026-10-20)
 * scripts/test-ci-five9-api.js
 *
 * ETG's SFTP archive has reset every connection since 2026-09-28, so audio now
 * comes from Five9: a saved "Call Recording" report lists it, the REST API
 * downloads it. These tests hold the parts that would fail quietly:
 *
 *   - the customer number (ANI on inbound, DNIS otherwise; none when the
 *     direction is unknown and the numbers differ: never a guess)
 *   - campaign case kept exactly, and the report's Pacific clock → UTC on both
 *     sides of the DST change
 *   - the exact Call ID join beats the campaign+time join, and the legacy
 *     match names still read as matched
 *   - stored audio is always a RIFF WAV; a RIFF WAV passes through untouched
 *   - an unknown CI_RECORDING_SOURCE is sftp; an unknown engine is never speech
 *   - the adapter cannot write to Five9
 *   - calls past retention are skipped, and the per-tick download cap holds
 *   - the backlog requeue touches only SFTP-outage failures, dry run first
 *
 * No network, no Five9, no Supabase, no env read at import: every client is a
 * double and the config is parseConfig({...}).
 *
 * Run: node --test scripts/test-ci-five9-api.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

import { parseConfig } from '../src/ci/config.js';
import {
  createFive9ApiAdapter,
  createRecordingAdapter,
  resolveRecordingColumns,
  descriptorFromRow,
  customerNumberForRecording,
  dayWindowFor,
  ensureWav,
  isRiffWav,
  fixWavSizes,
  transcodeToWav,
  describeDownload,
  probeFive9Recording,
  PAST_FIVE9_RETENTION,
} from '../src/ci/five9-recordings.js';
import { parseLoginMetadata, recordingUrl, createFive9RestClient, resetFive9RestState, five9RestBreakerStatus } from '../src/ci/five9-rest.js';
import { backlogStatements, requeueFive9Backlog, countSql, updateSql } from '../src/ci/five9-backlog.js';
import { stageFetchRecording, exactRecordingForCall, bestRecordingForCall } from '../src/ci/worker.js';
import { RECORDING_MATCH_METHODS, isCampaignTimeMatch, FORBIDDEN_OPS } from '../src/ci/recordings.js';
import { buildWav, channelCount } from '../src/ci/wav.js';

const FIVE9 = parseConfig({ CI_RECORDING_SOURCE: 'five9_api', CI_FIVE9_BACKLOG_DAYS: '14' });

const COLUMNS = ['CALL ID', 'SESSION ID', 'RECORDING ID', 'CAMPAIGN', 'AGENT', 'AGENT ID', 'ANI', 'DNIS', 'TIMESTAMP', 'LENGTH', 'FILE SIZE', 'CALL TYPE'];

function row({ callId = '300000010540092', recId = 'R1', campaign = 'Main Number', agent = 'cdeer', agentId = '4321', ani = '9419203087', dnis = '8005551212', ts = 'Tue, 20 Oct 2026 09:10:20', len = '00:02:15', size = '456036', type = 'Inbound' } = {}) {
  return [callId, 'S1', recId, campaign, agent, agentId, ani, dnis, ts, len, size, type];
}

const { index: IDX } = resolveRecordingColumns(COLUMNS);

/* ─── config ────────────────────────────────────────────────────────────── */

test('CI_RECORDING_SOURCE: only the exact value five9_api selects Five9; anything else is sftp', () => {
  assert.equal(parseConfig({}).recordingSource, 'sftp');
  assert.equal(parseConfig({ CI_RECORDING_SOURCE: 'five9_api' }).recordingSource, 'five9_api');
  assert.equal(parseConfig({ CI_RECORDING_SOURCE: ' FIVE9_API ' }).recordingSource, 'five9_api');
  for (const v of ['five9', 'five9-api', 'api', 'sftp', '', 'true']) {
    assert.equal(parseConfig({ CI_RECORDING_SOURCE: v }).recordingSource, 'sftp', v);
  }
});

test('an unknown CI_TRANSCRIBE_ENGINE never selects speech by accident (unchanged)', () => {
  for (const v of [undefined, '', 'speach', 'reece-speech-api', 'whisper']) {
    assert.equal(parseConfig({ CI_TRANSCRIBE_ENGINE: v }).transcribeEngine, 'openai', String(v));
  }
  assert.equal(parseConfig({ CI_TRANSCRIBE_ENGINE: 'speech' }).transcribeEngine, 'speech');
});

test('five9Api defaults, and the backlog is capped at 30 days', () => {
  const c = parseConfig({}).five9Api;
  assert.equal(c.reportName, 'CI Call Recordings');
  assert.equal(c.reportFolder, 'Shared Reports');
  assert.equal(c.reportTz, 'America/Los_Angeles');
  assert.equal(c.maxDownloadsPerTick, 20);
  assert.equal(c.backlogDays, 30);
  assert.equal(c.recordingAgent, 'self');
  assert.equal(c.downloadParam, true);
  assert.equal(parseConfig({ CI_FIVE9_BACKLOG_DAYS: '45' }).five9Api.backlogDays, 30);
  assert.equal(parseConfig({ CI_FIVE9_BACKLOG_DAYS: '7' }).five9Api.backlogDays, 7);
});

test('the selector builds the SFTP adapter unless five9_api is chosen', () => {
  assert.equal(createRecordingAdapter({ cfg: parseConfig({}) }).name, 'sftp');
  assert.equal(createRecordingAdapter({ cfg: FIVE9 }).name, 'five9_api');
});

/* ─── report → descriptor ───────────────────────────────────────────────── */

test('columns resolve by name, AGENT and AGENT ID kept apart; missing required columns are named', () => {
  assert.equal(IDX.agentUsername, 4);
  assert.equal(IDX.agentFive9Id, 5);
  assert.equal(IDX.recordingId, 2);
  const { missing } = resolveRecordingColumns(['CAMPAIGN', 'TIMESTAMP']);
  assert.deepEqual(missing.sort(), ['callId', 'recordingId']);
});

test('customer number: ANI on inbound, DNIS on outbound, nothing when the direction is unknown and they differ', () => {
  assert.equal(customerNumberForRecording({ callType: 'Inbound', ani: '9419203087', dnis: '8005551212' }), '9419203087');
  assert.equal(customerNumberForRecording({ callType: 'Outbound', ani: '8005551212', dnis: '9419203087' }), '9419203087');
  assert.equal(customerNumberForRecording({ callType: 'Manual', ani: '8005551212', dnis: '9419203087' }), '9419203087');
  assert.equal(customerNumberForRecording({ callType: null, ani: '8005551212', dnis: '9419203087' }), null);
  assert.equal(customerNumberForRecording({ callType: null, ani: '9419203087', dnis: null }), '9419203087');
});

test('descriptor: campaign case kept, stable source path, Five9 ids carried', () => {
  const { descriptor: d } = descriptorFromRow(row({ campaign: 'Data - Hot Leads LESS than 7' }), IDX, { cfg: FIVE9, dateDir: '10_20_2026' });
  assert.equal(d.campaignDir, 'Data - Hot Leads LESS than 7');
  assert.equal(d.sourcePath, 'five9api://300000010540092/R1');
  assert.equal(d.five9CallId, '300000010540092');
  assert.equal(d.five9RecordingId, 'R1');
  assert.equal(d.agentFive9Id, '4321');
  assert.equal(d.agentUsername, 'cdeer');
  assert.equal(d.durationSeconds, 135);
  assert.equal(d.fileBytes, 456036);
  assert.equal(d.excluded, false);
});

test('report clock is Pacific: PDT in October, PST in December', () => {
  const pdt = descriptorFromRow(row({ ts: 'Tue, 20 Oct 2026 09:10:20' }), IDX, { cfg: FIVE9 }).descriptor;
  assert.equal(pdt.recordedAt.toISOString(), '2026-10-20T16:10:20.000Z');
  const pst = descriptorFromRow(row({ ts: 'Tue, 15 Dec 2026 09:10:20' }), IDX, { cfg: FIVE9 }).descriptor;
  assert.equal(pst.recordedAt.toISOString(), '2026-12-15T17:10:20.000Z');
});

test('unusable rows are rejected, never guessed', () => {
  assert.equal(descriptorFromRow(row({ ts: 'yesterday-ish' }), IDX, { cfg: FIVE9 }).reject, 'unparseable_timestamp');
  assert.equal(descriptorFromRow(row({ callId: '' }), IDX, { cfg: FIVE9 }).reject, 'no_call_id');
  assert.equal(descriptorFromRow(row({ recId: '[None]' }), IDX, { cfg: FIVE9 }).reject, 'no_recording_id');
});

test('a tiny file is excluded like the SFTP crawl excludes it', () => {
  const { descriptor } = descriptorFromRow(row({ size: '3000' }), IDX, { cfg: FIVE9 });
  assert.equal(descriptor.excluded, true);
  assert.equal(descriptor.excludedReason, 'below_min_bytes');
});

test('the day window is the fixed-offset day padded 30 minutes, never past now', () => {
  const w = dayWindowFor('10_19_2026', -300, Date.parse('2026-10-21T00:00:00Z'));
  assert.equal(w.from.toISOString(), '2026-10-19T04:30:00.000Z');
  assert.equal(w.to.toISOString(), '2026-10-20T05:30:00.000Z');
  const today = dayWindowFor('10_20_2026', -300, Date.parse('2026-10-20T18:00:00Z'));
  assert.equal(today.to.toISOString(), '2026-10-20T18:00:00.000Z');
  assert.equal(dayWindowFor('13_45_2026'), null);
});

/* ─── the adapter ───────────────────────────────────────────────────────── */

function reportDouble(rowsFor) {
  const calls = [];
  return {
    calls,
    deps: {
      sleep: async () => {},
      now: () => Date.parse('2026-10-21T00:00:00Z'),
      async runReportAndWait(args) {
        calls.push(args);
        return { done: true, columns: COLUMNS, rows: rowsFor(args, calls.length) };
      },
    },
  };
}

test('the report runs ONCE per date per tick, and campaigns are filtered in memory', async () => {
  const rep = reportDouble(() => [row({ campaign: 'Main Number' }), row({ callId: '2', recId: 'R2', campaign: 'Outbound A' })]);
  const a = createFive9ApiAdapter({ cfg: FIVE9, reportDeps: rep.deps });
  const main = await a.list({ campaign: 'Main Number', date: '10_20_2026' });
  const out = await a.list({ campaign: 'Outbound A', date: '10_20_2026' });
  const none = await a.list({ campaign: 'main number', date: '10_20_2026' });
  assert.equal(rep.calls.length, 1);
  assert.equal(main.length, 1);
  assert.equal(out.length, 1);
  assert.equal(none.length, 0, 'campaign is compared exactly, never case-folded');
  assert.equal(rep.calls[0].folder, 'Shared Reports');
  assert.equal(rep.calls[0].name, 'CI Call Recordings');
  // 10/20 00:00 EST (fixed -05:00) minus 30 min = 04:30Z = 21:30 PDT the day before.
  assert.equal(rep.calls[0].startIso, '2026-10-19T21:30:00');
});

test('a failed report is never cached, and it is a source outage (no attempt burned)', async () => {
  let n = 0;
  const a = createFive9ApiAdapter({
    cfg: FIVE9,
    reportDeps: {
      sleep: async () => {},
      async runReportAndWait() {
        n += 1;
        if (n === 1) throw new Error('Five9 SOAP fault: boom');
        return { done: true, columns: COLUMNS, rows: [row()] };
      },
    },
  });
  await assert.rejects(a.list({ campaign: 'Main Number', date: '10_20_2026' }), (err) => err.ciSourceOutage === true);
  const second = await a.list({ campaign: 'Main Number', date: '10_20_2026' });
  assert.equal(second.length, 1);
});

test('a missing required column fails loudly with the headers it saw', async () => {
  const a = createFive9ApiAdapter({
    cfg: FIVE9,
    reportDeps: { sleep: async () => {}, runReportAndWait: async () => ({ done: true, columns: ['CAMPAIGN', 'ANI'], rows: [] }) },
  });
  await assert.rejects(a.list({ campaign: 'Main Number', date: '10_20_2026' }), /missing required column.*CAMPAIGN, ANI/);
});

test('a window at the row cap is split, and seam duplicates are dropped', async () => {
  const big = Array.from({ length: 5000 }, (_, i) => row({ callId: String(i), recId: `R${i}` }));
  const rep = reportDouble((args, n) => (n === 1 ? big : [row({ callId: '1', recId: 'R1' }), row({ callId: 'x', recId: 'Rx' })]));
  const a = createFive9ApiAdapter({ cfg: FIVE9, reportDeps: rep.deps });
  const out = await a.list({ campaign: 'Main Number', date: '10_19_2026' });
  assert.equal(rep.calls.length, 3);
  assert.equal(out.length, 2);
});

test('the adapter exposes no working write method', () => {
  const a = createFive9ApiAdapter({ cfg: FIVE9 });
  for (const op of FORBIDDEN_OPS) {
    assert.throws(() => a[op](), /refused/, op);
  }
  for (const op of ['modifyVCCConfiguration', 'modifyCampaign', 'upload', 'remove']) {
    if (op in a) assert.throws(() => a[op](), /refused/);
  }
});

test('fetch downloads by recording id and converts non-RIFF bytes; the cap counts downloads', async () => {
  const cfg = parseConfig({ CI_RECORDING_SOURCE: 'five9_api', CI_FIVE9_MAX_DOWNLOADS_PER_TICK: '2' });
  const asked = [];
  const a = createFive9ApiAdapter({
    cfg,
    clientFactory: () => ({ async getRecording(args) { asked.push(args); return { buffer: Buffer.from('ID3\u0004fake mp3') }; } }),
    transcode: async () => buildWav(Buffer.alloc(1600)),
  });
  assert.equal(a.canFetch(), true);
  const wav = await a.fetch({ five9RecordingId: 'R9', five9CallId: '9', agentFive9Id: '4321' });
  assert.ok(isRiffWav(wav));
  assert.deepEqual(asked[0], { recordingId: 'R9', agentId: undefined });
  await a.fetch({ five9RecordingId: 'R10', five9CallId: '10' });
  assert.equal(a.canFetch(), false);
  assert.deepEqual(a.stats(), { reportRuns: 0, downloads: 2 });
});

test('CI_FIVE9_RECORDING_AGENT=recording sends the recording\'s agent id', async () => {
  const cfg = parseConfig({ CI_RECORDING_SOURCE: 'five9_api', CI_FIVE9_RECORDING_AGENT: 'recording' });
  const asked = [];
  const a = createFive9ApiAdapter({
    cfg,
    clientFactory: () => ({ async getRecording(args) { asked.push(args); return { buffer: buildWav(Buffer.alloc(20)) }; } }),
  });
  await a.fetch({ five9RecordingId: 'R9', agentFive9Id: '4321' });
  assert.equal(asked[0].agentId, '4321');
  await assert.rejects(a.fetch({ five9RecordingId: 'R9' }), /no agent id/);
});

/* ─── audio ─────────────────────────────────────────────────────────────── */

test('a RIFF WAV passes through byte for byte, stereo kept', async () => {
  const stereo = buildWav(Buffer.alloc(400), { channels: 2 });
  let transcoded = false;
  const r = await ensureWav(stereo, { transcode: async () => { transcoded = true; return null; } });
  assert.equal(r.converted, false);
  assert.equal(transcoded, false);
  assert.strictEqual(r.buffer, stereo);
  assert.equal(channelCount(r.buffer), 2);
});

test('non-RIFF bytes go through the transcoder', async () => {
  const r = await ensureWav(Buffer.from('ID3\u0004\u0000mp3 bytes'), { transcode: async () => buildWav(Buffer.alloc(16)) });
  assert.equal(r.converted, true);
  assert.ok(isRiffWav(r.buffer));
});

test('transcodeToWav asks ffmpeg for mono 8 kHz pcm_s16le WAV over pipes', async () => {
  let seenArgs = null;
  const wavOut = buildWav(Buffer.alloc(32));
  // Simulate ffmpeg's pipe output: data size left as a placeholder.
  wavOut.writeUInt32LE(0xffffffff, 4);
  const spawnImpl = (bin, args) => {
    seenArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end() { setImmediate(() => { child.stdout.emit('data', wavOut); child.emit('close', 0); }); },
    });
    child.kill = () => {};
    return child;
  };
  const out = await transcodeToWav(Buffer.from('ID3 mp3'), { spawnImpl });
  assert.ok(seenArgs.join(' ').includes('-ac 1 -ar 8000 -c:a pcm_s16le -f wav pipe:1'));
  assert.ok(!seenArgs.slice(0, seenArgs.indexOf('-i')).includes('-f'), 'the input format is probed, not assumed');
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size fixed from the buffer');
});

test('fixWavSizes rewrites a streamed WAV\'s data size', () => {
  const w = buildWav(Buffer.alloc(200));
  const dataAt = w.indexOf('data');
  w.writeUInt32LE(0, dataAt + 4);
  fixWavSizes(w);
  assert.equal(w.readUInt32LE(dataAt + 4), w.length - dataAt - 8);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('real ffmpeg: an MP3 becomes a mono 8 kHz WAV', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const mp3 = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '2', '-f', 'mp3', 'pipe:1']).stdout;
  assert.ok(mp3.length > 100);
  const wav = await transcodeToWav(mp3);
  assert.ok(isRiffWav(wav));
  const info = describeDownload({ status: 200, contentType: 'audio/wav', buffer: wav });
  assert.equal(info.wav_channels, 1);
  assert.equal(info.wav_sample_rate, 8000);
  assert.equal(info.wav_format_tag, 1);
});

/* ─── matching ──────────────────────────────────────────────────────────── */

const CALL = {
  id: 'call-1',
  five9_call_id: '300000010540092',
  status: 'discovered',
  campaign: 'Main Number',
  customer_phone: '9419203087',
  agent_username: 'cdeer',
  call_start: '2026-10-20T16:10:00.000Z',
  attempts: 0,
};

function desc(over = {}) {
  return descriptorFromRow(row(over), IDX, { cfg: FIVE9, dateDir: '10_20_2026' }).descriptor;
}

test('the exact Call ID wins over a nearer time-join candidate', () => {
  const exact = desc({ ts: 'Tue, 20 Oct 2026 09:12:50' }); // 170s off
  const nearer = desc({ callId: '999', recId: 'R2', ts: 'Tue, 20 Oct 2026 09:10:01' }); // same number, 1s off
  const pick = exactRecordingForCall(CALL, [nearer, exact]);
  assert.equal(pick.recording.five9RecordingId, 'R1');
  assert.equal(pick.method, 'five9_call_id');
  assert.equal(pick.confidence, 1);
  // Without the exact join, the time join would have chosen the stranger.
  assert.equal(bestRecordingForCall(CALL, [nearer, exact]).recording.five9CallId, '999');
});

test('several recordings of one call: own agent first, then the longest', () => {
  const transfer = desc({ recId: 'R2', agent: 'lightfire', len: '00:09:00' });
  const own = desc({ recId: 'R3', agent: 'CDEER', len: '00:01:00' });
  const pick = exactRecordingForCall(CALL, [transfer, own]);
  assert.equal(pick.recording.five9RecordingId, 'R3');
  assert.equal(pick.reason, 'call_id_of_several');
  const noAgent = exactRecordingForCall({ ...CALL, agent_username: null }, [own, transfer]);
  assert.equal(noAgent.recording.five9RecordingId, 'R2');
});

test('no exact hit → null, so the time join still runs', () => {
  assert.equal(exactRecordingForCall(CALL, [desc({ callId: 'other' })]), null);
  assert.equal(exactRecordingForCall({ ...CALL, five9_call_id: null }, [desc()]), null);
});

test('match names: five9_call_id added, legacy names still read as matched', () => {
  assert.ok(RECORDING_MATCH_METHODS.includes('five9_call_id'));
  assert.ok(RECORDING_MATCH_METHODS.includes('campaign_ani_time'));
  assert.ok(isCampaignTimeMatch('campaign_ani_time'));
  assert.ok(isCampaignTimeMatch('campaign_customer_time'));
});

/* ─── the fetch stage end to end, with doubles ──────────────────────────── */

function fakeDb() {
  const log = [];
  const chainFor = (table) => {
    const chain = {
      select() { return chain; }, eq() { return chain; }, is() { return chain; }, in() { return chain; },
      limit() { return chain; }, order() { return chain; },
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
      upsert: async (row, opts) => { log.push({ table, op: 'upsert', row, opts }); return { error: null }; },
      update(patch) { log.push({ table, op: 'update', patch }); return chain; },
      then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
    };
    return chain;
  };
  return {
    log,
    from: chainFor,
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  };
}

function five9Adapter(rows, { cap } = {}) {
  const cfg = parseConfig({ CI_RECORDING_SOURCE: 'five9_api', ...(cap ? { CI_FIVE9_MAX_DOWNLOADS_PER_TICK: String(cap) } : {}) });
  const fetched = [];
  const adapter = createFive9ApiAdapter({
    cfg,
    reportDeps: { sleep: async () => {}, now: () => Date.parse('2026-10-21T00:00:00Z'), runReportAndWait: async () => ({ done: true, columns: COLUMNS, rows }) },
    clientFactory: () => ({ async getRecording(a) { fetched.push(a.recordingId); return { buffer: buildWav(Buffer.alloc(8000)) }; } }),
  });
  return { cfg, adapter, fetched };
}

test('fetch stage: exact link, source five9_api, the recording id stored, advanced to fetched', async () => {
  const { cfg, adapter, fetched } = five9Adapter([row({ ts: 'Tue, 20 Oct 2026 09:12:50' }), row({ callId: '999', recId: 'R2', ts: 'Tue, 20 Oct 2026 09:10:01' })]);
  const db = fakeDb();
  const r = await stageFetchRecording(CALL, { db, cfg, adapter, now: new Date('2026-10-20T20:00:00Z') });
  assert.equal(r.outcome, 'advanced');
  assert.deepEqual(fetched, ['R1']);
  const up = db.log.find((l) => l.table === 'ci_recordings' && l.op === 'upsert');
  assert.equal(up.row.source, 'five9_api');
  assert.equal(up.row.source_path, 'five9api://300000010540092/R1');
  assert.equal(up.row.five9_recording_id, 'R1');
  assert.equal(up.row.match_method, 'five9_call_id');
  assert.equal(up.row.match_confidence, 1);
  assert.equal(up.opts.onConflict, 'source_path');
  assert.ok(db.log.some((l) => l.table === 'ci_calls' && l.patch?.status === 'fetched'));
});

test('fetch stage: a call past retention is skipped before the report runs', async () => {
  let ran = 0;
  const cfg = parseConfig({ CI_RECORDING_SOURCE: 'five9_api', CI_FIVE9_BACKLOG_DAYS: '14' });
  const adapter = createFive9ApiAdapter({ cfg, reportDeps: { runReportAndWait: async () => { ran += 1; return { done: true, columns: COLUMNS, rows: [] }; } } });
  const db = fakeDb();
  const r = await stageFetchRecording({ ...CALL, call_start: '2026-09-28T12:00:00Z' }, { db, cfg, adapter, now: new Date('2026-10-20T20:00:00Z') });
  assert.equal(r.outcome, 'skipped');
  assert.equal(r.reason, PAST_FIVE9_RETENTION);
  assert.equal(ran, 0);
  const upd = db.log.find((l) => l.table === 'ci_calls' && l.op === 'update');
  assert.equal(upd.patch.status, 'skipped');
  assert.equal(upd.patch.status_detail, 'recording_past_five9_retention');
});

test('fetch stage: past the per-tick cap the call is put back, no attempt, no listing', async () => {
  const { cfg, adapter } = five9Adapter([row(), row({ callId: '2', recId: 'R2' })], { cap: 1 });
  const db = fakeDb();
  const now = new Date('2026-10-20T20:00:00Z');
  const first = await stageFetchRecording(CALL, { db, cfg, adapter, now });
  assert.equal(first.outcome, 'advanced');
  const second = await stageFetchRecording({ ...CALL, id: 'call-2', five9_call_id: '2' }, { db, cfg, adapter, now });
  assert.deepEqual(second, { outcome: 'deferred', reason: 'download_cap' });
  assert.equal(adapter.stats().downloads, 1);
});

/* ─── REST client ───────────────────────────────────────────────────────── */

const LOGIN = {
  tokenId: 'tok', userId: '777', orgId: '137613', context: { farmId: '9' },
  metadata: { dataCenters: [{ apiUrls: [{ host: 'app-atl.five9.com', port: '443' }] }] },
};

test('login metadata names the API host; the stream path is the documented one', () => {
  const s = parseLoginMetadata(LOGIN, 'a=b');
  assert.equal(s.base, 'https://app-atl.five9.com');
  assert.equal(recordingUrl(s, { agentId: s.userId, recordingId: 'R 1' }),
    'https://app-atl.five9.com/strsvcs/rs/svc/agents/777/recordings/R%201?download=true');
  assert.equal(recordingUrl(s, { agentId: '1', recordingId: 'R', download: false }),
    'https://app-atl.five9.com/strsvcs/rs/svc/agents/1/recordings/R');
});

function resp(status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null, getSetCookie: () => (h.get('set-cookie') ? [h.get('set-cookie')] : []) },
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}

const ENV = { FIVE9_USERNAME: 'svc@example.com', FIVE9_PASSWORD: 'pw' };

test('download: logs in once, sends Bearer-token + farmId, returns the bytes', async () => {
  resetFive9RestState();
  const seen = [];
  const wav = buildWav(Buffer.alloc(20));
  const fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/auth/login')) return resp(200, LOGIN, { 'set-cookie': 'Authorization=x; Path=/' });
    return resp(200, wav, { 'content-type': 'audio/wav' });
  };
  const c = createFive9RestClient({ cfg: FIVE9, deps: { fetch, env: ENV, sleep: async () => {} } });
  const r = await c.getRecording({ recordingId: 'R1' });
  assert.equal(r.buffer.length, wav.length);
  assert.equal(seen[1].init.method, 'GET');
  assert.equal(seen[1].init.headers.Authorization, 'Bearer-tok');
  assert.equal(seen[1].init.headers.farmId, '9');
  assert.equal(seen[1].init.headers.Cookie, 'Authorization=x');
  await c.getRecording({ recordingId: 'R2' });
  assert.equal(seen.filter((s) => s.url.endsWith('/auth/login')).length, 1, 'the session is reused');
});

test('a 429 is retried, a 403 is a source outage naming the permission', async () => {
  resetFive9RestState();
  let n = 0;
  const fetch = async (url) => {
    if (url.endsWith('/auth/login')) return resp(200, LOGIN);
    n += 1;
    return n === 1 ? resp(429, 'slow down') : resp(403, 'Forbidden');
  };
  const c = createFive9RestClient({ cfg: FIVE9, deps: { fetch, env: ENV, sleep: async () => {} } });
  await assert.rejects(c.getRecording({ recordingId: 'R1' }), (err) => err.ciSourceOutage && /403/.test(err.message) && /recording access/.test(err.message));
  assert.equal(n, 2);
});

test('a refused login trips the breaker: one failed login, never a second', async () => {
  resetFive9RestState();
  let logins = 0;
  const fetch = async () => { logins += 1; return resp(401, 'Invalid user name or password'); };
  const c = createFive9RestClient({ cfg: FIVE9, deps: { fetch, env: ENV, sleep: async () => {} } });
  await assert.rejects(c.getRecording({ recordingId: 'R1' }), (err) => err.ciSourceOutage);
  await assert.rejects(c.getRecording({ recordingId: 'R2' }), /breaker open/);
  assert.equal(logins, 1);
  assert.equal(five9RestBreakerStatus().open, true);
  resetFive9RestState();
});

test('a JSON answer is not audio, and its values are never echoed', async () => {
  resetFive9RestState();
  const fetch = async (url) => (url.endsWith('/auth/login') ? resp(200, LOGIN) : resp(200, { url: 'https://secret.example/signed' }, { 'content-type': 'application/json' }));
  const c = createFive9RestClient({ cfg: FIVE9, deps: { fetch, env: ENV, sleep: async () => {} } });
  await assert.rejects(c.getRecording({ recordingId: 'R1' }), (err) => /keys: url/.test(err.message) && !/secret/.test(err.message));
  resetFive9RestState();
});

/* ─── probe ─────────────────────────────────────────────────────────────── */

test('probe: reports what each download looked like, never the audio', async () => {
  const wav = buildWav(Buffer.alloc(200), { channels: 2 });
  const out = await probeFive9Recording({
    cfg: FIVE9,
    date: '10_20_2026',
    deps: {
      now: () => Date.parse('2026-10-21T00:00:00Z'),
      reportDeps: { sleep: async () => {}, now: () => Date.parse('2026-10-21T00:00:00Z'), runReportAndWait: async () => ({ done: true, columns: COLUMNS, rows: [row()] }) },
      client: { async getRecording({ agentId }) { return agentId ? { status: 403, contentType: 'text/plain', buffer: Buffer.from('nope') } : { status: 200, contentType: 'audio/wav', buffer: wav }; } },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.recordings_in_report, 1);
  assert.equal(out.attempts.length, 3);
  assert.equal(out.attempts[0].first4, 'RIFF');
  assert.equal(out.attempts[0].wav_channels, 2);
  assert.equal(out.attempts[2].http_status, 403);
  assert.equal(out.attempts[2].body_excerpt, 'nope');
  assert.ok(!JSON.stringify(out).includes('9419203087'), 'no phone number in the probe output');
});

/* ─── backlog requeue ───────────────────────────────────────────────────── */

test('requeue: only SFTP-outage failures, split by retention, cleared details', () => {
  const st = Object.fromEntries(backlogStatements({ backlogDays: 14 }).map((s) => [s.key, s]));
  assert.match(st.failed_requeued.where, /status = 'failed' AND review_reason = 'discovered_failed'/);
  assert.match(st.failed_requeued.where, /ECONNRESET/);
  assert.match(st.failed_requeued.where, /call_start >= now\(\) - interval '14 days'/);
  assert.match(st.failed_requeued.set, /status = 'discovered', attempts = 0/);
  assert.match(st.failed_past_retention.where, /call_start < now\(\) - interval '14 days'/);
  assert.match(st.failed_past_retention.set, /recording_past_five9_retention/);
  assert.match(st.discovered_detail_cleared.where, /archive unreachable%/);
  assert.match(updateSql(st.failed_requeued), /^WITH u AS \(UPDATE ci_calls SET .* RETURNING 1\) SELECT count\(\*\)::int AS n FROM u$/);
  assert.match(countSql(st.failed_requeued), /^SELECT count\(\*\)::int AS n FROM ci_calls WHERE /);
  assert.throws(() => backlogStatements({ backlogDays: "1'; drop" }), /backlog days/);
});

test('requeue: dry run counts only; live is refused while the source is sftp', async () => {
  const sql = [];
  const runSQL = async (q) => { sql.push(q); return [{ n: 3 }]; };
  const dry = await requeueFive9Backlog({ cfg: FIVE9, runSQL });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.counts.failed_requeued, 3);
  assert.ok(sql.every((q) => q.startsWith('SELECT count')));
  const refused = await requeueFive9Backlog({ cfg: parseConfig({}), dryRun: false, runSQL });
  assert.equal(refused.ok, false);
  sql.length = 0;
  const live = await requeueFive9Backlog({ cfg: FIVE9, dryRun: false, runSQL });
  assert.equal(live.dry_run, false);
  assert.ok(sql.every((q) => q.startsWith('WITH u AS (UPDATE ci_calls')));
});
