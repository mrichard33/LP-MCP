/**
 * Tests — the browser-playable MP3 derivative
 * scripts/test-ci-mp3.js
 *
 * THE TRAPS THESE GUARD:
 *
 * 1. THE ORIGINAL WAV IS THE TRANSCRIPTION INPUT. Whisper accepts Five9's GSM
 *    6.10 WAV; transcribe.js reads storage_path. Repointing anything at the
 *    derivative, or removing the original once a derivative exists, silently
 *    changes what gets transcribed — or loses the archival copy outright.
 * 2. A FAILED TRANSCODE MUST NOT FAIL THE FETCH STAGE. A call whose audio will
 *    not convert still needs its transcript, its match and its note. Losing a
 *    playable link is a bad afternoon; losing the note is the pipeline not
 *    working.
 * 3. THE PURGE MUST TAKE BOTH OBJECTS. Deleting the WAV and leaving the MP3
 *    keeps the recording we promised to delete, in the MORE playable format.
 * 4. THE ROUTE'S 404 SEMANTICS MUST NOT MOVE. Unknown, expired and purged all
 *    return the same bare 404; adding a second object must not add a way to
 *    tell them apart, and must not add a second lookup key.
 *
 * The one test that needs a real encoder is skipped, loudly, when ffmpeg is
 * absent — everything else runs anywhere.
 *
 * Run: node --test scripts/test-ci-mp3.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  transcodeToMp3,
  transcodeAndStoreMp3,
  storeMp3,
  ffmpegAvailable,
  logFfmpegStatus,
  purgeExpiredAudio,
  MP3_SAMPLE_RATE,
  MP3_BITRATE,
} from '../src/ci/recordings.js';
import { createRecordingHandler } from '../src/ci/routes.js';
import { parseWav } from '../src/ci/wav.js';
import { parseConfig } from '../src/ci/config.js';
import { needsMp3, selectCandidates, parseArgs } from './backfill-ci-mp3.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A REAL Five9-shaped recording: WAVE format tag 0x0031 (GSM 6.10), 8 kHz,
 * 1 channel, with a fact chunk — the exact shape read off a fetched production
 * file. 1 second, so it costs nothing to keep in the repo.
 */
const GSM_FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures/ci-audio/five9-gsm610.wav'));

const FFMPEG = await ffmpegAvailable();

// ─── the fixture is what we say it is ───────────────────────────────────────

test('the fixture really is GSM 6.10, 8 kHz, mono, with a fact chunk', () => {
  assert.equal(GSM_FIXTURE.toString('ascii', 0, 4), 'RIFF');
  assert.equal(GSM_FIXTURE.toString('ascii', 8, 12), 'WAVE');

  const chunks = [];
  let o = 12;
  let fmt = null;
  while (o + 8 <= GSM_FIXTURE.length) {
    const id = GSM_FIXTURE.toString('ascii', o, o + 4);
    const size = GSM_FIXTURE.readUInt32LE(o + 4);
    chunks.push(id);
    if (id === 'fmt ') {
      fmt = {
        formatTag: GSM_FIXTURE.readUInt16LE(o + 8),
        channels: GSM_FIXTURE.readUInt16LE(o + 10),
        sampleRate: GSM_FIXTURE.readUInt32LE(o + 12),
      };
    }
    if (id === 'data') break;
    o = o + 8 + size + (size % 2);
  }

  assert.equal(fmt.formatTag, 0x0031, 'GSM 6.10');
  assert.equal(fmt.channels, 1, 'mono — there is no second channel to diarize');
  assert.equal(fmt.sampleRate, 8000);
  assert.ok(chunks.includes('fact'), 'a fact chunk sits between fmt and data');
});

/*
 * This is WHY the link did not play, stated as an assertion.
 *
 * Our own reader cannot even describe the file: GSM 6.10 declares
 * wBitsPerSample = 0 in its fmt chunk (the samples are 33-byte frames, not
 * fixed-width words), so parseWav bails at 'degenerate_fmt' before it ever
 * reaches the PCM/float support check. A browser makes the same refusal for
 * the same reason — there is nothing here to decode without a GSM decoder.
 *
 * channelCount() therefore falls back to 1 and transcribe.js sends the whole
 * file, which is the correct existing behaviour and unchanged by this PR. It
 * also settles the stereo question left open in sql/061: the header says
 * 1 channel, so there is no second channel to diarize.
 */
test('our own WAV reader cannot decode the Five9 format — as every browser cannot', async () => {
  const info = parseWav(GSM_FIXTURE);
  assert.equal(info.ok, false, 'not parseable as PCM or float');
  assert.equal(info.reason, 'degenerate_fmt', 'GSM declares bitsPerSample = 0');

  const { channelCount } = await import('../src/ci/wav.js');
  assert.equal(channelCount(GSM_FIXTURE), 1, 'unparseable falls back to mono, whole-file transcription');
});

// ─── the transcode ──────────────────────────────────────────────────────────

test('a GSM 6.10 fixture converts to a valid MP3', { skip: FFMPEG.ok ? false : `ffmpeg not available (${FFMPEG.error})` }, async () => {
  const mp3 = await transcodeToMp3(GSM_FIXTURE);

  assert.ok(Buffer.isBuffer(mp3) && mp3.length > 0, 'bytes came back');

  // An MP3 begins with either an ID3v2 tag or a frame sync (11 set bits).
  const id3 = mp3.toString('ascii', 0, 3) === 'ID3';
  const sync = mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0;
  assert.ok(id3 || sync, 'starts with an ID3 tag or an MPEG frame sync');

  // It must not still be a RIFF file — that would mean ffmpeg passed it through.
  assert.notEqual(mp3.toString('ascii', 0, 4), 'RIFF');

  // Find the first frame header and read its version/layer bits. 44.1 kHz puts
  // this in MPEG-1 Layer III, which is the point: encoding at the source's
  // native 8 kHz would yield MPEG-2.5, whose decoder support is exactly what is
  // unreliable in Safari and QuickTime.
  let at = -1;
  for (let i = 0; i + 1 < mp3.length; i++) {
    if (mp3[i] === 0xff && (mp3[i + 1] & 0xe0) === 0xe0) { at = i; break; }
  }
  assert.ok(at >= 0, 'a frame sync exists somewhere in the output');
  const versionBits = (mp3[at + 1] >> 3) & 0x03;
  const layerBits = (mp3[at + 1] >> 1) & 0x03;
  assert.equal(versionBits, 0b11, 'MPEG-1, not MPEG-2.5 — the widely-decodable family');
  assert.equal(layerBits, 0b01, 'Layer III');
});

test('the encoder targets mono at a browser-safe sample rate', () => {
  assert.equal(MP3_SAMPLE_RATE, 44100, 'MPEG-1 territory; 8000 would be MPEG-2.5');
  assert.equal(MP3_BITRATE, '64k');
});

test('the transcode is deterministic enough to be idempotent on a re-run', { skip: FFMPEG.ok ? false : 'ffmpeg not available' }, async () => {
  const a = await transcodeToMp3(GSM_FIXTURE);
  const b = await transcodeToMp3(GSM_FIXTURE);
  assert.equal(a.length, b.length, 'same input, same output size');
});

test('an empty or non-buffer input is refused before ffmpeg is started', async () => {
  await assert.rejects(() => transcodeToMp3(Buffer.alloc(0)), /non-empty buffer/);
  await assert.rejects(() => transcodeToMp3(null), /non-empty buffer/);
  await assert.rejects(() => transcodeToMp3('not a buffer'), /non-empty buffer/);
});

test('a missing ffmpeg binary rejects with a named error rather than hanging', async () => {
  await assert.rejects(
    () => transcodeToMp3(GSM_FIXTURE, { bin: '/nonexistent/ffmpeg-does-not-exist', timeoutMs: 5000 }),
    (err) => /ffmpeg/i.test(err.message),
  );
});

test('garbage in rejects — ffmpeg exits non-zero and we surface it', { skip: FFMPEG.ok ? false : 'ffmpeg not available' }, async () => {
  await assert.rejects(
    () => transcodeToMp3(Buffer.from('this is definitely not a wav file, at all, ever')),
    (err) => /ffmpeg exited|no output/i.test(err.message),
  );
});

// ─── ffmpeg presence is reported, never fatal ───────────────────────────────

test('ffmpegAvailable resolves a verdict and never throws', async () => {
  const missing = await ffmpegAvailable({ bin: '/nonexistent/ffmpeg-does-not-exist' });
  assert.equal(missing.ok, false);
  assert.ok(missing.error, 'it says why');
  assert.equal(missing.version, null);
});

/*
 * Trap 2, at startup. A missing ffmpeg costs playable links and nothing else:
 * the WAV is still fetched, transcribed, analyzed, matched and synced, and the
 * route falls back to serving it. Refusing to boot over that would trade a
 * working pipeline for a convenience.
 */
test('a missing ffmpeg logs loudly at startup and does NOT throw', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const status = await logFfmpegStatus({ bin: '/nonexistent/ffmpeg-does-not-exist' });
    assert.equal(status.ok, false);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ffmpeg NOT FOUND/);
  assert.match(warnings[0], /apk add ffmpeg/, 'it says how to fix it');
});

// ─── storage ────────────────────────────────────────────────────────────────

/** Supabase storage double that records every upload. */
function storageDb({ uploadError = null } = {}) {
  const uploads = [];
  return {
    uploads,
    storage: {
      from(bucket) {
        return {
          upload: async (p, buf, opts) => {
            uploads.push({ bucket, path: p, bytes: buf.length, contentType: opts?.contentType, upsert: opts?.upsert });
            return uploadError ? { error: { message: uploadError } } : { error: null };
          },
        };
      },
    },
  };
}

test('the MP3 is stored as audio/mpeg beside its WAV, in the SAME private bucket', async () => {
  const db = storageDb();
  const out = await storeMp3({ callId: 'call-1', buffer: Buffer.from('fake mp3 bytes'), sha: 'deadbeef', db });

  assert.equal(out.storagePath, 'call-1/deadbeef.mp3');
  assert.equal(db.uploads.length, 1);
  assert.equal(db.uploads[0].bucket, 'ci-audio', 'the same private bucket, not a new one');
  assert.equal(db.uploads[0].contentType, 'audio/mpeg', 'so the redirect serves the right type');
  assert.equal(db.uploads[0].upsert, true, 'a re-run overwrites one object rather than littering');
});

/*
 * Trap 1. The derivative is keyed on the SOURCE WAV's sha, so the two objects
 * sit side by side under the same name and differ only by extension. They must
 * never be the same object.
 */
test('the MP3 path pairs with the WAV path and never collides with it', async () => {
  const db = storageDb();
  await storeMp3({ callId: 'call-1', buffer: Buffer.from('x'), sha: 'abc123', db });
  const mp3Path = db.uploads[0].path;
  const wavPath = 'call-1/abc123.wav';   // what storeAudio() writes for the same bytes
  assert.notEqual(mp3Path, wavPath);
  assert.equal(mp3Path.replace(/\.mp3$/, ''), wavPath.replace(/\.wav$/, ''));
});

// ─── a failed transcode never fails the stage ───────────────────────────────

/*
 * Trap 2, and the contract the fetch stage depends on. transcodeAndStoreMp3
 * NEVER throws: every failure path returns nulls, the row keeps
 * mp3_storage_path null, and the route serves the WAV.
 */
test('a failed transcode returns nulls instead of throwing', async () => {
  const db = storageDb();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  let out;
  try {
    out = await transcodeAndStoreMp3({
      callId: 'call-1',
      buffer: GSM_FIXTURE,
      sha: 'abc',
      filename: 'unconvertible.wav',
      db,
      opts: { bin: '/nonexistent/ffmpeg-does-not-exist', timeoutMs: 5000 },
    });
  } finally {
    console.warn = realWarn;
  }

  assert.equal(out.mp3StoragePath, null);
  assert.equal(out.mp3Bytes, null);
  assert.ok(out.error, 'the reason is reported to the caller');
  assert.equal(db.uploads.length, 0, 'nothing was stored');
  assert.match(warnings.join(''), /will still be transcribed/, 'the log says the pipeline continues');
});

test('a failed UPLOAD is swallowed the same way a failed transcode is', { skip: FFMPEG.ok ? false : 'ffmpeg not available' }, async () => {
  const db = storageDb({ uploadError: 'bucket exploded' });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const out = await transcodeAndStoreMp3({ callId: 'c1', buffer: GSM_FIXTURE, sha: 'abc', db });
    assert.equal(out.mp3StoragePath, null);
    assert.ok(out.error);
  } finally {
    console.warn = realWarn;
  }
});

test('a successful transcode reports the path and the byte count', { skip: FFMPEG.ok ? false : 'ffmpeg not available' }, async () => {
  const db = storageDb();
  const out = await transcodeAndStoreMp3({ callId: 'call-9', buffer: GSM_FIXTURE, sha: 'sha9', db });
  assert.equal(out.mp3StoragePath, 'call-9/sha9.mp3');
  assert.ok(out.mp3Bytes > 0);
  assert.equal(out.error, null);
  assert.equal(db.uploads[0].contentType, 'audio/mpeg');
});

// ─── the route prefers MP3 and falls back to WAV ────────────────────────────

function resDouble() {
  const out = { statusCode: 200, body: null, redirectedTo: null, contentType: null };
  const res = {
    status(c) { out.statusCode = c; return res; },
    type(t) { out.contentType = t; return res; },
    send(b) { out.body = b; return res; },
    json(b) { out.body = b; return res; },
    redirect(code, url) { out.statusCode = code; out.redirectedTo = url; return res; },
  };
  return { res, out };
}

function routeDb({ row = null, bucketOps = [] } = {}) {
  return {
    from() {
      const chain = { select() { return chain; }, eq() { return chain; }, maybeSingle: async () => ({ data: row, error: null }) };
      return chain;
    },
    storage: {
      from(bucket) {
        return {
          createSignedUrl: async (p, ttl) => {
            bucketOps.push({ op: 'sign', bucket, path: p, ttl });
            return { data: { signedUrl: `https://signed.example/${p}` }, error: null };
          },
        };
      },
    },
  };
}

const TOKEN = 'a'.repeat(43);

test('the route serves the MP3 when one exists', async () => {
  const ops = [];
  const handler = createRecordingHandler({
    db: routeDb({
      row: { id: 'r1', call_id: 'c1', storage_path: 'c1/abc.wav', mp3_storage_path: 'c1/abc.mp3', link_expires_at: '2099-01-01T00:00:00Z', purged_at: null },
      bucketOps: ops,
    }),
    allow: () => true,
  });
  const { res, out } = resDouble();
  await handler({ params: { token: TOKEN }, ip: '1.2.3.4' }, res);

  assert.equal(out.statusCode, 302);
  assert.equal(ops[0].path, 'c1/abc.mp3', 'the playable object, not the GSM WAV');
  assert.equal(ops[0].bucket, 'ci-audio', 'still private, still signed');
});

test('the route falls back to the WAV when there is no MP3', async () => {
  const ops = [];
  const handler = createRecordingHandler({
    db: routeDb({
      row: { id: 'r1', call_id: 'c1', storage_path: 'c1/abc.wav', mp3_storage_path: null, link_expires_at: '2099-01-01T00:00:00Z', purged_at: null },
      bucketOps: ops,
    }),
    allow: () => true,
  });
  const { res, out } = resDouble();
  await handler({ params: { token: TOKEN }, ip: '1.2.3.4' }, res);

  assert.equal(out.statusCode, 302);
  assert.equal(ops[0].path, 'c1/abc.wav', 'exactly the behaviour that shipped before');
});

/*
 * Trap 4. The gate is storage_path — the ORIGINAL — not whichever object is
 * about to be served. A row with no WAV is purged or never landed and must 404
 * whatever the derivative column says.
 */
test('a purged row 404s even if a stale mp3 path is still on it', async () => {
  const ops = [];
  const handler = createRecordingHandler({
    db: routeDb({
      row: { id: 'r1', call_id: 'c1', storage_path: null, mp3_storage_path: 'c1/abc.mp3', link_expires_at: '2099-01-01T00:00:00Z', purged_at: null },
      bucketOps: ops,
    }),
    allow: () => true,
  });
  const { res, out } = resDouble();
  await handler({ params: { token: TOKEN }, ip: '1.2.3.4' }, res);

  assert.equal(out.statusCode, 404);
  assert.equal(out.body, 'Not found');
  assert.equal(ops.length, 0, 'nothing was signed');
});

/*
 * Deploy-before-DDL. This is the ONE public route in the subsystem and it fails
 * closed — an unknown column surfaces as a caught error and would turn EVERY
 * recording link into a 404, which is a worse regression than the unplayable
 * audio this PR fixes. So a missing mp3 column must degrade to the pre-070
 * read, not break the route.
 */
test('a missing mp3 column degrades to serving the WAV, it does NOT 404 every link', async () => {
  const ops = [];
  let attempt = 0;
  const db = {
    from() {
      const chain = {
        select(cols) { chain._cols = cols; return chain; },
        eq() { return chain; },
        maybeSingle: async () => {
          attempt += 1;
          if (chain._cols.includes('mp3_storage_path')) {
            return { data: null, error: { message: 'column ci_recordings.mp3_storage_path does not exist' } };
          }
          return {
            data: { id: 'r1', call_id: 'c1', storage_path: 'c1/abc.wav', link_expires_at: '2099-01-01T00:00:00Z', purged_at: null },
            error: null,
          };
        },
      };
      return chain;
    },
    storage: {
      from(bucket) {
        return {
          createSignedUrl: async (p, ttl) => {
            ops.push({ bucket, path: p, ttl });
            return { data: { signedUrl: `https://signed.example/${p}` }, error: null };
          },
        };
      },
    },
  };

  const realWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  const { res, out } = resDouble();
  try {
    await createRecordingHandler({ db, allow: () => true })({ params: { token: TOKEN }, ip: '1.2.3.4' }, res);
  } finally {
    console.warn = realWarn;
  }

  assert.equal(attempt, 2, 'it retried without the new column');
  assert.equal(out.statusCode, 302, 'the link still works');
  assert.equal(ops[0].path, 'c1/abc.wav');
  assert.match(warnings.join(''), /sql\/070/, 'and it says what is missing');
});

test('unknown, expired and purged still return the SAME bare 404 — no new oracle', async () => {
  const cases = [
    { label: 'unknown', row: null },
    { label: 'purged', row: { id: 'r', call_id: 'c', storage_path: null, mp3_storage_path: null, purged_at: '2026-01-01T00:00:00Z' } },
    { label: 'expired', row: { id: 'r', call_id: 'c', storage_path: 'c/a.wav', mp3_storage_path: 'c/a.mp3', link_expires_at: '2000-01-01T00:00:00Z', purged_at: null } },
  ];
  const bodies = new Set();
  const codes = new Set();
  for (const c of cases) {
    const handler = createRecordingHandler({ db: routeDb({ row: c.row }), allow: () => true });
    const { res, out } = resDouble();
    await handler({ params: { token: TOKEN }, ip: '1.2.3.4' }, res);
    codes.add(out.statusCode);
    bodies.add(out.body);
  }
  assert.deepEqual([...codes], [404], 'one status for every miss');
  assert.equal(bodies.size, 1, 'one body for every miss — the MP3 must not distinguish them');
});

// ─── the purge takes both objects ───────────────────────────────────────────

/** Supabase double for purgeExpiredAudio: rows in, removals + patch out. */
function purgeDb(rows) {
  const state = { removed: null, patch: null, ids: null };
  return {
    state,
    from() {
      const chain = {
        select() { return chain; },
        not() { return chain; },
        is() { return chain; },
        lt() { return chain; },
        limit: async () => ({ data: rows, error: null }),
        update(p) { state.patch = p; return chain; },
        in: async (_col, ids) => { state.ids = ids; return { error: null }; },
      };
      return chain;
    },
    storage: {
      from() {
        return { remove: async (paths) => { state.removed = paths; return { error: null }; } };
      },
    },
  };
}

/*
 * Trap 3. Purging the WAV and leaving the MP3 keeps the recording we promised
 * to delete, in the MORE playable of the two formats, behind a token that is
 * about to be nulled anyway.
 */
test('the purge removes BOTH objects and nulls the token', async () => {
  const db = purgeDb([{ id: 'r1', storage_path: 'c1/a.wav', mp3_storage_path: 'c1/a.mp3' }]);
  const out = await purgeExpiredAudio({ db, cfg: parseConfig({ CI_AUDIO_RETENTION_DAYS: '30' }) });

  assert.equal(out.purged, 1);
  assert.deepEqual(db.state.removed.sort(), ['c1/a.mp3', 'c1/a.wav']);
  assert.equal(db.state.patch.storage_path, null);
  assert.equal(db.state.patch.mp3_storage_path, null, 'or the route prefers an object that is gone');
  assert.equal(db.state.patch.mp3_bytes, null);
  assert.equal(db.state.patch.link_token, null, 'the link dies with the audio');
  assert.ok(db.state.patch.purged_at, 'the row still records that the file existed');
});

test('the purge handles a row that never got an MP3 without passing a null path', async () => {
  const db = purgeDb([
    { id: 'r1', storage_path: 'c1/a.wav', mp3_storage_path: null },
    { id: 'r2', storage_path: 'c2/b.wav', mp3_storage_path: 'c2/b.mp3' },
  ]);
  const out = await purgeExpiredAudio({ db, cfg: parseConfig({ CI_AUDIO_RETENTION_DAYS: '30' }) });

  assert.equal(out.purged, 2);
  assert.equal(db.state.removed.includes(null), false, 'a null path would fail the whole batch');
  assert.equal(db.state.removed.length, 3);
});

// ─── the backfill ───────────────────────────────────────────────────────────

test('the backfill is dry-run unless --execute is passed', () => {
  assert.equal(parseArgs([]).execute, false);
  assert.equal(parseArgs(['--limit=5']).execute, false);
  assert.equal(parseArgs(['--execute']).execute, true);
  assert.equal(parseArgs(['--limit=5']).limit, 5);
  assert.equal(parseArgs(['--limit=0']).limit, null);
});

test('the backfill SKIPS rows that already have an MP3 — it is idempotent', () => {
  assert.equal(needsMp3({ storage_path: 'c/a.wav', mp3_storage_path: null, purged_at: null }), true);
  assert.equal(needsMp3({ storage_path: 'c/a.wav', mp3_storage_path: 'c/a.mp3', purged_at: null }), false);
});

/*
 * A purged row's bytes are gone. Re-creating a derivative of audio we
 * deliberately deleted would resurrect it past its retention window.
 */
test('the backfill never touches a purged row or one with no WAV', () => {
  assert.equal(needsMp3({ storage_path: 'c/a.wav', mp3_storage_path: null, purged_at: '2026-01-01T00:00:00Z' }), false);
  assert.equal(needsMp3({ storage_path: null, mp3_storage_path: null, purged_at: null }), false);
  assert.equal(needsMp3({}), false);
  assert.equal(needsMp3(null), false);
});

test('selectCandidates filters a page down to exactly the workable rows', () => {
  const rows = [
    { id: 'a', storage_path: 'c/a.wav', mp3_storage_path: null, purged_at: null },
    { id: 'b', storage_path: 'c/b.wav', mp3_storage_path: 'c/b.mp3', purged_at: null },
    { id: 'c', storage_path: 'c/c.wav', mp3_storage_path: null, purged_at: '2026-01-01T00:00:00Z' },
    { id: 'd', storage_path: null, mp3_storage_path: null, purged_at: null },
  ];
  assert.deepEqual(selectCandidates(rows).map((r) => r.id), ['a']);
  assert.deepEqual(selectCandidates([]), []);
  assert.deepEqual(selectCandidates(null), []);
});

// ─── the WAV is never the thing that changes ────────────────────────────────

/*
 * Trap 1, stated directly. transcribe.js's audio loader reads storage_path and
 * nothing else — if that ever becomes mp3_storage_path, Whisper starts
 * receiving a lossy re-encode of a lossy codec, and no test elsewhere would
 * notice.
 */
test('the transcription loader still reads storage_path, never the MP3', async () => {
  const { createStorageAudioLoader } = await import('../src/ci/transcribe.js');
  const asked = [];
  const db = {
    storage: {
      from() {
        return {
          download: async (p) => {
            asked.push(p);
            return { data: { arrayBuffer: async () => GSM_FIXTURE.buffer.slice(GSM_FIXTURE.byteOffset, GSM_FIXTURE.byteOffset + GSM_FIXTURE.length) }, error: null };
          },
        };
      },
    },
  };
  const loadAudio = createStorageAudioLoader({ db });
  await loadAudio({ id: 'r1', storage_path: 'c1/abc.wav', mp3_storage_path: 'c1/abc.mp3' });

  assert.deepEqual(asked, ['c1/abc.wav'], 'the ORIGINAL, which is what Whisper accepts');
});

test('a recording row with an MP3 still carries its untouched WAV path', () => {
  // The shape the fetch stage upserts: the derivative is ADDITIVE.
  const row = { storage_path: 'c1/abc.wav', mp3_storage_path: 'c1/abc.mp3', mime: 'audio/wav' };
  assert.equal(row.storage_path, 'c1/abc.wav');
  assert.equal(row.mime, 'audio/wav', 'mime still describes the original');
  assert.notEqual(row.storage_path, row.mp3_storage_path);
});

// ─── the manual upload path gets an MP3 too ─────────────────────────────────

/**
 * Supabase double for storeManualRecording: captures the ci_recordings upsert,
 * the storage uploads, the ci_calls patch and the ci_events row.
 */
function manualDb() {
  const state = { uploads: [], upsert: null, callPatch: null, event: null, tokenUpdate: null };
  return {
    state,
    from(table) {
      const chain = {
        upsert: async (row) => { if (table === 'ci_recordings') state.upsert = row; return { error: null }; },
        update(p) { if (table === 'ci_calls') state.callPatch = p; else state.tokenUpdate = p; return chain; },
        insert: async (row) => { if (table === 'ci_events') state.event = row; return { error: null }; },
        eq() { return chain; },
        is() { return chain; },
        select: async () => ({ data: [{ link_token: 't' }], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
    },
    storage: {
      from(bucket) {
        return {
          upload: async (p, buf, opts) => {
            state.uploads.push({ bucket, path: p, bytes: buf.length, contentType: opts?.contentType });
            return { error: null };
          },
        };
      },
    },
  };
}

/*
 * THE GAP THIS CLOSES. POST /ci/backfill is the one path a HUMAN uses to fix a
 * recording the crawl could not find. It stored the WAV and produced no MP3, so
 * the link it handed back opened and played nothing — the exact failure sql/070
 * exists to fix, on the exact path someone reaches for when something is
 * already wrong. It went unnoticed because the handler read the module-level
 * supabase client and so could not be tested at all.
 */
test('a MANUAL upload gets an MP3 derivative, not just a WAV', { skip: FFMPEG.ok ? false : 'ffmpeg not available' }, async () => {
  const { storeManualRecording } = await import('../src/ci/routes.js');
  const db = manualDb();
  const out = await storeManualRecording({
    db,
    call: { id: 'call-m1', status: 'review' },
    buffer: GSM_FIXTURE,
    five9CallId: '300000010259677',
  });

  assert.ok(out.mp3Bytes > 0, 'an MP3 was produced');
  assert.equal(out.mp3Error, null);

  // Both objects stored, in the same private bucket, with the right types.
  const wav = db.state.uploads.find((u) => u.path.endsWith('.wav'));
  const mp3 = db.state.uploads.find((u) => u.path.endsWith('.mp3'));
  assert.ok(wav, 'the original is still stored');
  assert.ok(mp3, 'and so is the derivative');
  assert.equal(wav.contentType, 'audio/wav');
  assert.equal(mp3.contentType, 'audio/mpeg');
  assert.equal(wav.bucket, 'ci-audio');
  assert.equal(mp3.bucket, 'ci-audio');

  // And the row points at both.
  assert.equal(db.state.upsert.storage_path, wav.path);
  assert.equal(db.state.upsert.mp3_storage_path, mp3.path);
  assert.equal(db.state.upsert.mp3_bytes, out.mp3Bytes);
  assert.equal(db.state.upsert.mime, 'audio/wav', 'mime still describes the original');
  assert.equal(db.state.upsert.source, 'manual');
});

test('a manual upload whose audio will not convert still stores and still advances', async () => {
  const { storeManualRecording } = await import('../src/ci/routes.js');
  const db = manualDb();
  const realWarn = console.warn;
  console.warn = () => {};
  let out;
  try {
    out = await storeManualRecording({
      db,
      call: { id: 'call-m2', status: 'review' },
      buffer: Buffer.from('not audio at all'),
      five9CallId: '300000010259678',
    });
  } finally {
    console.warn = realWarn;
  }

  // The WAV is stored and the call still advances — losing the playable copy
  // must never cost the call its transcript.
  assert.equal(db.state.upsert.mp3_storage_path, null);
  assert.equal(db.state.upsert.mp3_bytes, null);
  assert.ok(db.state.upsert.storage_path, 'the original is still stored');
  assert.equal(out.advanced, true, 'the call still moves to fetched');
  assert.equal(db.state.callPatch.status, 'fetched');
});

test('a manual upload never drags a later-stage call backwards', async () => {
  const { storeManualRecording } = await import('../src/ci/routes.js');
  const db = manualDb();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const out = await storeManualRecording({
      db,
      call: { id: 'call-m3', status: 'completed' },
      buffer: Buffer.from('not audio at all'),
      five9CallId: '300000010259679',
    });
    assert.equal(out.advanced, false);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(db.state.callPatch, null, 'ci_calls was not touched');
});
