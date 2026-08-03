/**
 * test-llm-empty-completion.js — a 200 with no text is an ERROR, not an empty string.
 *
 * 2026-08-03 incident. DECISION_ENGINE_MODEL_ANTHROPIC / CUSTOMER_FACING_MODEL_ANTHROPIC
 * pointed at a model that, at max_tokens:500, returned HTTP 200 with no
 * `type:"text"` block. callAnthropic filtered content for text blocks, joined
 * them, and returned text:''. message-analyzer's callClaude then did
 * JSON.parse('') and threw "Unexpected end of JSON input" — an error naming
 * neither the model nor the cause, four frames from the actual fault. The
 * agentic responder answered nobody for seven hours and it read as a parser bug.
 *
 * The guard must name the model, the stop/finish reason and max_tokens, so the
 * same misconfiguration is diagnosable from a single log line. Both providers
 * are covered on purpose: a reasoning model that exhausts max_completion_tokens
 * before emitting content fails identically, and flipping a group to OpenAI
 * must not reintroduce the silent-empty-string path.
 */

// Supabase client construction in src/supabase.js reads env at import time.
// llm-client.js does not import it, but keep the guard for consistency with
// the rest of the suite in case the module graph grows.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.ANTHROPIC_API_KEY ||= 'test_anthropic_key';
process.env.OPENAI_API_KEY ||= 'test_openai_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { callLLM } = await import('../src/llm-client.js');

const realFetch = globalThis.fetch;

/** Stub fetch with a single canned 200 JSON body. */
function stubFetch(body) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// Force provider/model per test via the per-function env override contract
// documented at the top of src/llm-client.js (<FN>_PROVIDER / <FN>_MODEL_*).
function useAnthropic(model) {
  process.env.TESTFN_PROVIDER = 'anthropic';
  process.env.TESTFN_MODEL_ANTHROPIC = model;
}

function useOpenAI(model) {
  process.env.TESTFN_PROVIDER = 'openai';
  process.env.TESTFN_MODEL_OPENAI = model;
}

test.afterEach(() => {
  restoreFetch();
  delete process.env.TESTFN_PROVIDER;
  delete process.env.TESTFN_MODEL_ANTHROPIC;
  delete process.env.TESTFN_MODEL_OPENAI;
});

test('anthropic: empty content array throws, naming model / stop_reason / max_tokens', async () => {
  useAnthropic('claude-empty-test');
  stubFetch({ content: [], stop_reason: 'max_tokens', usage: {} });

  await assert.rejects(
    () => callLLM({ fn: 'testfn', user: 'hi', maxTokens: 500 }),
    (err) => {
      assert.match(err.message, /claude-empty-test/, 'must name the model');
      assert.match(err.message, /stop_reason=max_tokens/, 'must name the stop reason');
      assert.match(err.message, /max_tokens=500/, 'must name the token budget');
      assert.match(err.message, /blocks=\[none\]/, 'must report the block types returned');
      return true;
    },
  );
});

test('anthropic: non-text blocks only (the real 2026-08-03 shape) throws', async () => {
  useAnthropic('claude-thinking-only');
  stubFetch({
    content: [{ type: 'thinking', thinking: '...' }],
    stop_reason: 'max_tokens',
  });

  await assert.rejects(
    () => callLLM({ fn: 'testfn', user: 'hi', maxTokens: 500 }),
    (err) => {
      assert.match(err.message, /claude-thinking-only/);
      assert.match(err.message, /blocks=\[thinking\]/, 'must surface what WAS returned');
      return true;
    },
  );
});

test('anthropic: whitespace-only text is still empty', async () => {
  useAnthropic('claude-whitespace');
  stubFetch({ content: [{ type: 'text', text: '   \n  ' }], stop_reason: 'end_turn' });

  await assert.rejects(() => callLLM({ fn: 'testfn', user: 'hi', maxTokens: 500 }),
    /returned no text content/);
});

test('anthropic: a normal completion still returns its text', async () => {
  useAnthropic('claude-ok');
  stubFetch({
    content: [{ type: 'text', text: '{"ok":true}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2 },
  });

  const res = await callLLM({ fn: 'testfn', user: 'hi', maxTokens: 500 });
  assert.equal(res.text, '{"ok":true}');
  assert.equal(res.provider, 'anthropic');
  assert.equal(res.model, 'claude-ok');
});

test('openai: empty content throws, naming model / finish_reason / max_tokens', async () => {
  useOpenAI('gpt-empty-test');
  stubFetch({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });

  await assert.rejects(
    () => callLLM({ fn: 'testfn', user: 'hi', maxTokens: 500 }),
    (err) => {
      assert.match(err.message, /gpt-empty-test/, 'must name the model');
      assert.match(err.message, /finish_reason=length/, 'must name the finish reason');
      assert.match(err.message, /max_tokens=500/, 'must name the token budget');
      return true;
    },
  );
});

test('openai: missing choices entirely throws rather than returning empty', async () => {
  useOpenAI('gpt-no-choices');
  stubFetch({});

  await assert.rejects(() => callLLM({ fn: 'testfn', user: 'hi', maxTokens: 500 }),
    /returned no content/);
});

test('openai: a normal completion still returns its text', async () => {
  useOpenAI('gpt-ok');
  stubFetch({
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { total_tokens: 3 },
  });

  const res = await callLLM({ fn: 'testfn', user: 'hi', maxTokens: 500 });
  assert.equal(res.text, '{"ok":true}');
  assert.equal(res.provider, 'openai');
});
