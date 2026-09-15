/**
 * test-llm-sampling-params.js — a model that removed `temperature` must not be
 * sent one, and must never be fatal if it is.
 *
 * 2026-09-15 incident. Anthropic REMOVED the sampling parameters (temperature /
 * top_p / top_k) on the newer families — Opus 5, Opus 4.8, Opus 4.7, Sonnet 5,
 * Fable 5/5.1, Mythos 5/5.1. Sending one is a hard 400. LLM_MODEL_ANTHROPIC was
 * repointed at such a model and memory-recommend, which asks for `temperature: 0`
 * to get deterministic JSON, died at the API boundary on EVERY card: 130
 * consecutive failures, 0 written, the recommendation engine dead for ~11 hours.
 * Nothing was louder than rows in claude_memory_validation_log.
 *
 * The OpenAI half of this guard had existed since GPT-5 shipped
 * (openAIUsesCompletionTokens); the Anthropic half was never written.
 *
 * Two mechanisms, tested separately on purpose:
 *   the model list  — keeps the common case off the error path entirely;
 *   the one retry   — the list is hardcoded and WILL fall behind, because every
 *                     new family removes these parameters. The retry is what
 *                     makes the next removal a log line instead of an outage.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.ANTHROPIC_API_KEY ||= 'test_anthropic_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { callLLM } = await import('../src/llm-client.js');

const realFetch = globalThis.fetch;
const OK_BODY = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };

/**
 * Records every request body. `replies` is consulted per call index, so a test
 * can hand back a 400 first and a 200 second.
 */
function stubFetch(replies) {
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    return {
      ok: r.status === 200,
      status: r.status,
      json: async () => r.body ?? OK_BODY,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? OK_BODY)),
    };
  };
  return sent;
}

function withModel(model) {
  process.env.LLM_MODEL_ANTHROPIC = model;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LLM_MODEL_ANTHROPIC;
});

test('a model that removed sampling params is never sent temperature', async () => {
  withModel('claude-opus-5');
  const sent = stubFetch([{ status: 200 }]);

  await callLLM({ fn: 'sampling_probe', user: 'hi', maxTokens: 50, temperature: 0 });

  assert.equal(sent.length, 1, 'no retry should be needed — the list caught it');
  assert.ok(!('temperature' in sent[0]), `temperature must be absent, got ${JSON.stringify(sent[0])}`);
});

test('a model that still accepts sampling params keeps temperature', async () => {
  // Opus 4.6 / Sonnet 4.6 / Haiku 4.5 and older still take it. Dropping it for
  // everyone would silently make deterministic callers non-deterministic.
  withModel('claude-sonnet-4-6');
  const sent = stubFetch([{ status: 200 }]);

  await callLLM({ fn: 'sampling_probe', user: 'hi', maxTokens: 50, temperature: 0 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].temperature, 0);
});

test('an unlisted model that rejects temperature retries ONCE without it and succeeds', async () => {
  // The forward-compatibility path: a family released after this code was written.
  withModel('claude-something-new-9');
  const sent = stubFetch([
    { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' } } },
    { status: 200 },
  ]);

  const out = await callLLM({ fn: 'sampling_probe', user: 'hi', maxTokens: 50, temperature: 0 });

  assert.equal(sent.length, 2, 'exactly one retry');
  assert.equal(sent[0].temperature, 0, 'first attempt carries it');
  assert.ok(!('temperature' in sent[1]), 'retry drops it');
  assert.equal(out.text, 'ok');
});

test('a 400 that is NOT about sampling is not retried and surfaces as-is', async () => {
  // Otherwise every unrelated 400 costs a second call and the real error is
  // reported from the wrong attempt.
  withModel('claude-something-new-9');
  const sent = stubFetch([
    { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be >= 1' } } },
  ]);

  await assert.rejects(
    () => callLLM({ fn: 'sampling_probe', user: 'hi', maxTokens: 50, temperature: 0 }),
    /Anthropic API 400.*max_tokens/s,
  );
  assert.equal(sent.length, 1, 'no retry for an unrelated 400');
});

test('a caller that never asked for temperature is unaffected on any model', async () => {
  withModel('claude-opus-5');
  const sent = stubFetch([{ status: 200 }]);

  await callLLM({ fn: 'sampling_probe', user: 'hi', maxTokens: 50 });

  assert.equal(sent.length, 1);
  assert.ok(!('temperature' in sent[0]));
});
