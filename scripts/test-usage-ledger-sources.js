/**
 * test-usage-ledger-sources.js — the two AI costs that bypass callLLM reach
 * llm_usage_log (2026-10-07):
 *   - embeddings (src/knowledge/openai-embeddings.js): one row per request,
 *     labelled with the caller's fn, none for a retried 429 (not billed);
 *   - the PAID OpenAI call transcriber (src/ci/transcribe.js): one row per
 *     request carrying the audio duration;
 *   - the self-hosted speech transcriber: NO row (free per call; the user's
 *     ruling) — a ci_transcribe row means the engine went back to paid OpenAI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY ||= 'test_openai_key';
delete process.env.LLM_USAGE_LOG_MODE;
process.env.LLM_PRICE_TABLE_JSON = JSON.stringify({ 'text-embedding-3-small': { in: 0.02 }, 'whisper-1': { per_minute: 0.006 } });

const { __setLlmUsageClientForTests } = await import('../src/llm-usage.js');
const emb = await import('../src/knowledge/openai-embeddings.js');
const { createOpenAITranscriber, createSpeechApiTranscriber } = await import('../src/ci/transcribe.js');

const rows = [];
__setLlmUsageClientForTests({ from: () => ({ insert: (row) => { rows.push(row); return Promise.resolve({ error: null }); } }) });

const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const embedOk = (n) => json({
  model: 'text-embedding-3-small',
  data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [0.1, 0.2] })),
  usage: { prompt_tokens: 42 * n, total_tokens: 42 * n },
});

test('embed: one ledger row with the caller label, input tokens, ok', async () => {
  rows.length = 0;
  emb.deps.fetch = async () => embedOk(1);
  await emb.embed('do you sell aluminum windows?', { fast: true, fn: 'embeddings:faq' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fn, 'embeddings:faq');
  assert.equal(rows[0].group_name, 'embeddings');
  assert.equal(rows[0].model, 'text-embedding-3-small');
  assert.equal(rows[0].input_tokens, 42);
  assert.equal(rows[0].output_tokens, null);
  assert.equal(rows[0].ok, true);
  // 42 tokens × $0.02/1M = $0.00000084, stored to 6 decimals (numeric(12,6)).
  assert.equal(rows[0].cost_usd, 0.000001);
});

test('embedBatch: default label, and a retried 429 writes no extra row', async () => {
  rows.length = 0;
  let calls = 0;
  emb.deps.fetch = async () => (++calls === 1 ? json({}, 429) : embedOk(2));
  await emb.embedBatch(['a', 'b']);
  assert.equal(calls, 2);
  assert.equal(rows.length, 1, 'one row per logical request, not per attempt');
  assert.equal(rows[0].fn, 'embeddings');
  assert.equal(rows[0].input_tokens, 84);
});

test('embed: a request that finally fails writes one ok=false row and still throws', async () => {
  rows.length = 0;
  emb.deps.fetch = async () => json({ error: 'bad' }, 400);
  await assert.rejects(() => emb.embed('x', { fast: true, fn: 'embeddings:kb_search' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].fn, 'embeddings:kb_search');
});

test('OpenAI transcriber: one row with the audio duration', async () => {
  rows.length = 0;
  const transcribe = createOpenAITranscriber({
    apiKey: 'k',
    fetchImpl: async () => json({ text: 'hello', segments: [], language: 'en', duration: 125.4 }),
  });
  await transcribe({ buffer: Buffer.from('RIFF'), filename: 'a.wav', channel: null, model: 'whisper-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fn, 'ci_transcribe');
  assert.equal(rows[0].group_name, 'call_intelligence');
  assert.equal(rows[0].model, 'whisper-1');
  assert.equal(rows[0].ok, true);
  // 125.4 s × $0.006/min = $0.01254
  assert.equal(rows[0].cost_usd, 0.01254);
});

test('OpenAI transcriber: a rejected request writes ok=false and still throws', async () => {
  rows.length = 0;
  const transcribe = createOpenAITranscriber({ apiKey: 'k', fetchImpl: async () => json({ error: 'nope' }, 500) });
  await assert.rejects(() => transcribe({ buffer: Buffer.from('RIFF'), filename: 'a.wav', channel: null, model: 'whisper-1' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
});

test('speech (free) transcriber: writes no ledger row', async () => {
  rows.length = 0;
  let n = 0;
  const transcribe = createSpeechApiTranscriber({
    baseUrl: 'http://speech.local',
    apiKey: 'k',
    pollMs: 1000,
    sleep: async () => {},
    fetchImpl: async () => (++n === 1
      ? json({ job_id: 'j1', status: 'queued' }, 202)
      : json({ job_id: 'j1', status: 'done', result: { text: 'hi', segments: [], language: 'en', duration: 60 } })),
  });
  const out = await transcribe({ buffer: Buffer.from('RIFF'), filename: 'a.wav', channel: null });
  assert.equal(out.text, 'hi');
  assert.equal(rows.length, 0);
});
