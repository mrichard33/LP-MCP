/**
 * Call Intelligence — self-hosted transcription (reece-speech-api).
 *
 * The engine flag decides whether every call is paid for or free, and the
 * speech transcriber must look EXACTLY like the OpenAI one to everything after
 * it. These tests pin both: the flag's coercion (typos land on openai, the
 * behaviour that already works), the job create → poll → map contract read
 * from reece-speech-api main on 2026-09-28, and the engine label on the
 * stored row. No network, no env stubbing — fetch, sleep and the clock are
 * injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig } from '../src/ci/config.js';
import {
  createSpeechApiTranscriber,
  createOpenAITranscriber,
  selectTranscriber,
  mapSpeechResult,
  jobStateOf,
  jobIdOf,
  speechAuthHeaders,
  transcribeCall,
} from '../src/ci/transcribe.js';
import { buildWav, channelCount } from '../src/ci/wav.js';

const URL = 'https://speech.example';
const KEY = 'test-key';
const JOB = '6f1b2c3d-0000-4000-8000-000000000001';

function json(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function doneJob(result) {
  return { job_id: JOB, status: 'done', chunks_total: 1, chunks_done: 1, chunks: [], result, error: null };
}

/**
 * A scripted fake of the service. `polls` is the sequence of GET answers; every
 * request is recorded so tests can assert what was sent.
 */
function fakeService({ create = json(202, { job_id: JOB, status: 'queued', chunks_total: 1 }), polls = [] } = {}) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body });
    if ((init.method || 'GET') === 'POST') return typeof create === 'function' ? create(calls) : create;
    const next = polls[Math.min(i, polls.length - 1)];
    i += 1;
    return next;
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

function speech(extra = {}) {
  return createSpeechApiTranscriber({ baseUrl: URL, apiKey: KEY, sleep: noSleep, ...extra });
}

const FINISHED = doneJob({
  text: ' Good morning, this is Mark with Reece Windows. ',
  language: 'en',
  duration: 184.6,
  model: 'small',
  segments: [
    { start: 0.0, end: 4.8, text: ' Good morning, ' },
    { start: 4.8, end: 7.25, text: 'this is Mark with Reece Windows.' },
  ],
});

// ─── 1. the flag ────────────────────────────────────────────────────────────

test('CI_TRANSCRIBE_ENGINE: unset, openai and typos all mean openai', () => {
  for (const v of [undefined, '', 'openai', 'OpenAI ', 'speeech', 'self-hosted']) {
    const env = v === undefined ? {} : { CI_TRANSCRIBE_ENGINE: v };
    assert.equal(parseConfig(env).transcribeEngine, 'openai', `value ${JSON.stringify(v)}`);
  }
});

test('CI_TRANSCRIBE_ENGINE: only speech (any case, padded) selects the speech engine', () => {
  assert.equal(parseConfig({ CI_TRANSCRIBE_ENGINE: 'speech' }).transcribeEngine, 'speech');
  assert.equal(parseConfig({ CI_TRANSCRIBE_ENGINE: ' SPEECH ' }).transcribeEngine, 'speech');
});

test('speech settings: defaults, trailing slash trimmed, poll floor respects the rate limit', () => {
  const d = parseConfig({}).speech;
  assert.equal(d.url, null);
  assert.equal(d.apiKey, null);
  assert.equal(d.timeoutMs, 240000);
  assert.equal(d.pollMs, 5000);
  assert.equal(d.language, 'auto');
  assert.equal(d.modelLabel, 'faster-whisper-small-int8');

  const s = parseConfig({ CI_SPEECH_API_URL: ' https://x.example// ', CI_SPEECH_POLL_MS: '10', CI_SPEECH_TIMEOUT_MS: '5' }).speech;
  assert.equal(s.url, 'https://x.example');
  assert.equal(s.pollMs, 1000);
  assert.equal(s.timeoutMs, 10000);
});

// ─── 2. selection ───────────────────────────────────────────────────────────

test('selectTranscriber: openai config goes to api.openai.com', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return json(200, { text: 'hi', segments: [], language: 'en', duration: 3 });
  };
  const t = selectTranscriber(parseConfig({}), { apiKey: 'sk-test', fetchImpl });
  await t({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null, model: 'whisper-1' });
  assert.deepEqual(seen, ['https://api.openai.com/v1/audio/transcriptions']);
});

test('selectTranscriber: speech config POSTs to {url}/v1/jobs', async () => {
  const cfg = parseConfig({ CI_TRANSCRIBE_ENGINE: 'speech', CI_SPEECH_API_URL: URL + '/', CI_SPEECH_API_KEY: KEY });
  const svc = fakeService({ polls: [json(200, FINISHED)] });
  const t = selectTranscriber(cfg, { fetchImpl: svc.fetchImpl, sleep: noSleep });
  await t({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null });
  assert.equal(svc.calls[0].method, 'POST');
  assert.equal(svc.calls[0].url, `${URL}/v1/jobs`);
  assert.equal(svc.calls.some((c) => c.url.includes('openai')), false);
});

// ─── 3. happy path ──────────────────────────────────────────────────────────

test('a job that goes queued → processing → done maps to the OpenAI result shape', async () => {
  const svc = fakeService({
    polls: [
      json(200, { job_id: JOB, status: 'queued', result: null, error: null }),
      json(200, { job_id: JOB, status: 'processing', result: null, error: null }),
      json(200, FINISHED),
    ],
  });
  const out = await speech({ fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: '/a/b/call.wav', channel: null });

  assert.deepEqual(out, {
    text: 'Good morning, this is Mark with Reece Windows.',
    segments: [
      { start: 0, end: 4.8, text: 'Good morning,' },
      { start: 4.8, end: 7.25, text: 'this is Mark with Reece Windows.' },
    ],
    language: 'en',
    audio_seconds: 185,
    confidence: null,
    low_confidence: false,
  });

  // create + 3 polls, the Bearer header the service checks, and the form it reads.
  assert.equal(svc.calls.length, 4);
  assert.equal(svc.calls[1].url, `${URL}/v1/jobs/${JOB}`);
  assert.deepEqual(svc.calls[0].headers, { Authorization: `Bearer ${KEY}` });
  assert.deepEqual(svc.calls[1].headers, { Authorization: `Bearer ${KEY}` });
  const form = svc.calls[0].body;
  assert.equal(form.get('language'), 'auto');
  assert.equal(form.get('timestamps'), 'true');
  assert.equal(form.get('audio').name, 'call.wav');
});

test('429 and 503 while polling are transient; the job is still collected', async () => {
  const svc = fakeService({
    polls: [json(429, { detail: 'Rate limit exceeded' }), json(503, { detail: 'Model is still loading' }), json(200, FINISHED)],
  });
  const out = await speech({ fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null });
  assert.equal(out.text, 'Good morning, this is Mark with Reece Windows.');
});

test('a 404 poll (job forgotten by a service restart) throws instead of polling on', async () => {
  const svc = fakeService({ polls: [json(404, { detail: 'Job not found' })] });
  await assert.rejects(
    speech({ fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null }),
    /poll failed \(404\).*Job not found/,
  );
  assert.equal(svc.calls.length, 2);
});

test('a failed create throws with the status and detail', async () => {
  const svc = fakeService({ create: json(415, { detail: 'not a supported audio format' }) });
  await assert.rejects(
    speech({ fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null }),
    /create failed \(415\).*not a supported audio format/,
  );
});

// ─── 4. stereo ──────────────────────────────────────────────────────────────

test('stereo: each channel is its own job, carrying a mono file', async () => {
  const stereo = buildWav(Buffer.from([1, 1, 2, 2, 3, 3, 4, 4]), { channels: 2 });
  const svc = fakeService({ polls: [json(200, FINISHED)] });
  const t = speech({ fetchImpl: svc.fetchImpl });
  await t({ buffer: stereo, filename: 'a.wav', channel: 0 });
  await t({ buffer: stereo, filename: 'a.wav', channel: 1 });

  const posts = svc.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  for (const p of posts) {
    const sent = Buffer.from(await p.body.get('audio').arrayBuffer());
    assert.equal(channelCount(sent), 1);
  }
});

test('stereo: a buffer that cannot be split is sent whole, with a warning', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const raw = Buffer.from('not a wav file at all');
    const svc = fakeService({ polls: [json(200, FINISHED)] });
    await speech({ fetchImpl: svc.fetchImpl })({ buffer: raw, filename: 'x/odd.wav', channel: 1 });
    const sent = Buffer.from(await svc.calls[0].body.get('audio').arrayBuffer());
    assert.deepEqual(sent, raw);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.some((w) => /could not split channel 1 of x\/odd\.wav/.test(w)), true);
});

// ─── 5. job failure ─────────────────────────────────────────────────────────

test('a job the service reports failed throws with the service error text', async () => {
  const svc = fakeService({
    polls: [json(200, { job_id: JOB, status: 'failed', result: null, error: 'chunk 0 failed after 3 attempts: RuntimeError: boom' })],
  });
  await assert.rejects(
    speech({ fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null }),
    /speech job .* failed: chunk 0 failed after 3 attempts: RuntimeError: boom/,
  );
});

test('an unknown status throws on the first poll rather than burning the timeout', async () => {
  const svc = fakeService({ polls: [json(200, { job_id: JOB, status: 'completed' })] });
  await assert.rejects(
    speech({ fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null }),
    /unknown status "completed"/,
  );
  assert.equal(svc.calls.length, 2);
});

// ─── 6. timeout ─────────────────────────────────────────────────────────────

test('timeout: once the clock passes timeoutMs it throws and polls no more', async () => {
  let now = 0;
  const svc = fakeService({ polls: [json(200, { job_id: JOB, status: 'processing' })] });
  const t = createSpeechApiTranscriber({
    baseUrl: URL,
    apiKey: KEY,
    timeoutMs: 10000,
    pollMs: 5000,
    fetchImpl: svc.fetchImpl,
    clock: () => now,
    sleep: async (ms) => { now += ms; },
  });
  await assert.rejects(t({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null }), /timed out after 10s/);
  // Polls at t=5000 and t=10000 (not yet PAST the deadline); the wait to
  // t=15000 crosses it and the loop throws before sending a third.
  assert.equal(svc.calls.filter((c) => c.method === 'GET').length, 2);
});

// ─── 7. missing config ──────────────────────────────────────────────────────

test('missing URL or key throws before any request', async () => {
  const svc = fakeService();
  await assert.rejects(
    createSpeechApiTranscriber({ baseUrl: null, apiKey: KEY, fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null }),
    /CI_SPEECH_API_URL is not configured/,
  );
  await assert.rejects(
    createSpeechApiTranscriber({ baseUrl: URL, apiKey: null, fetchImpl: svc.fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null }),
    /CI_SPEECH_API_KEY is not configured/,
  );
  assert.equal(svc.calls.length, 0);
});

// ─── 8. the stored row says which engine made it ────────────────────────────

const CALL = { id: 'call-1' };
const RECS = [{ id: 'r1', source_path: 'a.wav', recorded_at: '2026-09-28T14:00:00Z' }];
const loadAudio = async () => ({ buffer: Buffer.from('x'), channels: 1, audio_seconds: 10 });
const fixedTranscriber = async () => ({
  text: 'one two three four five six', segments: [{ start: 0, end: 2, text: 'one two three four five six' }],
  language: 'en', audio_seconds: 10, confidence: null, low_confidence: false,
});

test('transcribeCall labels a self-hosted row reece-speech-api + the model label', async () => {
  const cfg = parseConfig({ CI_TRANSCRIBE_ENGINE: 'speech', CI_SPEECH_MODEL_LABEL: 'fw-small-test' });
  const row = await transcribeCall(CALL, RECS, { transcriber: fixedTranscriber, loadAudio, cfg });
  assert.equal(row.engine, 'reece-speech-api');
  assert.equal(row.engine_model, 'fw-small-test');
});

test('transcribeCall labels an OpenAI row openai + CI_TRANSCRIBE_MODEL, as before', async () => {
  const cfg = parseConfig({ CI_TRANSCRIBE_MODEL: 'whisper-1' });
  const row = await transcribeCall(CALL, RECS, { transcriber: fixedTranscriber, loadAudio, cfg });
  assert.equal(row.engine, 'openai');
  assert.equal(row.engine_model, 'whisper-1');
});

// ─── 9. regression: the OpenAI path is unchanged ────────────────────────────

test('the OpenAI transcriber still returns the same shape', async () => {
  const fetchImpl = async () => json(200, {
    text: ' hello there ', language: 'en', duration: 12.4,
    segments: [{ start: 0, end: 1.5, text: ' hello ' }, { start: 1.5, text: 'there' }],
  });
  const out = await createOpenAITranscriber({ apiKey: 'sk-test', fetchImpl })({ buffer: Buffer.from('x'), filename: 'a.wav', channel: null, model: 'whisper-1' });
  assert.deepEqual(out, {
    text: 'hello there',
    segments: [{ start: 0, end: 1.5, text: 'hello' }, { start: 1.5, end: 1.5, text: 'there' }],
    language: 'en',
    audio_seconds: 12,
    confidence: null,
    low_confidence: false,
  });
});

// ─── contract helpers ───────────────────────────────────────────────────────

test('contract helpers match the service exactly', () => {
  assert.deepEqual(speechAuthHeaders('k'), { Authorization: 'Bearer k' });
  assert.equal(jobIdOf({ job_id: 'abc', status: 'queued' }), 'abc');
  assert.equal(jobIdOf({ id: 'abc' }), null);
  assert.equal(jobStateOf({ status: 'queued' }), 'pending');
  assert.equal(jobStateOf({ status: 'processing' }), 'pending');
  assert.equal(jobStateOf({ status: 'done' }), 'done');
  assert.equal(jobStateOf({ status: 'failed' }), 'failed');
  assert.throws(() => jobStateOf({}), /unknown status null/);
  // A done job with no segments (timestamps off) still maps cleanly.
  assert.deepEqual(mapSpeechResult(doneJob({ text: 'hi', language: null, duration: null, segments: [] })), {
    text: 'hi', segments: [], language: null, audio_seconds: null, confidence: null, low_confidence: false,
  });
});
