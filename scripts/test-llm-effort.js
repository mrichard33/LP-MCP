/**
 * test-llm-effort.js — <FN>_EFFORT sends Anthropic `output_config.effort` for
 * that function only, and nothing changes while it is unset.
 *
 * 2026-10-07: the reply writer on claude-sonnet-5 ran at the API's default
 * effort, thought for 28–60s+ per SMS, and twice hit the 60s floor in a row
 * (agent_actions 554455 shipped the ai-fallback copy). The knob exists so the
 * reply writer can think less without touching any other function.
 */
process.env.ANTHROPIC_API_KEY ||= 'test_anthropic_key';
process.env.LLM_USAGE_LOG_MODE = 'off'; // the ledger shares the stubbed fetch

import test from 'node:test';
import assert from 'node:assert/strict';

const { callLLM, resolveEffort, anthropicSupportsEffort } = await import('../src/llm-client.js');

const realFetch = globalThis.fetch;
const OK_BODY = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };

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

const EFFORT_VARS = ['RESPONSE_GENERATOR_EFFORT', 'CUSTOMER_FACING_EFFORT', 'MESSAGE_ANALYZER_EFFORT', 'LLM_MODEL_ANTHROPIC'];
test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of EFFORT_VARS) delete process.env[k];
});

test('resolveEffort: per-fn beats group; unset is null; unknown is ignored', () => {
  const m = 'claude-sonnet-5';
  assert.equal(resolveEffort('response_generator', m, {}), null);
  assert.equal(resolveEffort('response_generator', m, { CUSTOMER_FACING_EFFORT: 'low' }), 'low');
  assert.equal(resolveEffort('response_generator', m, { CUSTOMER_FACING_EFFORT: 'low', RESPONSE_GENERATOR_EFFORT: 'Medium' }), 'medium');
  assert.equal(resolveEffort('message_analyzer', m, { RESPONSE_GENERATOR_EFFORT: 'medium' }), null, 'another fn is untouched');
  assert.equal(resolveEffort('response_generator', m, { RESPONSE_GENERATOR_EFFORT: 'fast' }), null);
});

test('resolveEffort: only for models that accept effort', () => {
  for (const m of ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5-1']) {
    assert.ok(anthropicSupportsEffort(m), m);
  }
  for (const m of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'gpt-5.4-mini']) {
    assert.ok(!anthropicSupportsEffort(m), m);
  }
  assert.equal(resolveEffort('response_generator', 'claude-haiku-4-5', { RESPONSE_GENERATOR_EFFORT: 'low' }), null);
});

test('callLLM: unset sends no output_config (behaviour unchanged)', async () => {
  process.env.LLM_MODEL_ANTHROPIC = 'claude-sonnet-5';
  const sent = stubFetch([{ status: 200 }]);
  await callLLM({ fn: 'response_generator', user: 'hi' });
  assert.ok(!('output_config' in sent[0]));
});

test('callLLM: RESPONSE_GENERATOR_EFFORT=medium sends output_config.effort for that fn only', async () => {
  process.env.LLM_MODEL_ANTHROPIC = 'claude-sonnet-5';
  process.env.RESPONSE_GENERATOR_EFFORT = 'medium';
  const sent = stubFetch([{ status: 200 }]);
  await callLLM({ fn: 'response_generator', user: 'hi' });
  await callLLM({ fn: 'message_analyzer', user: 'hi' });
  assert.deepEqual(sent[0].output_config, { effort: 'medium' });
  assert.ok(!('output_config' in sent[1]));
});

test('callLLM: a 400 naming effort retries once without it and succeeds', async () => {
  process.env.LLM_MODEL_ANTHROPIC = 'claude-sonnet-5';
  process.env.RESPONSE_GENERATOR_EFFORT = 'xhigh';
  const sent = stubFetch([
    { status: 400, body: '{"type":"error","error":{"message":"output_config.effort: xhigh is not supported"}}' },
    { status: 200 },
  ]);
  const out = await callLLM({ fn: 'response_generator', user: 'hi' });
  assert.equal(out.text, 'ok');
  assert.equal(sent.length, 2);
  assert.ok(!('output_config' in sent[1]));
});

test('callLLM: an unrelated 400 is not retried', async () => {
  process.env.LLM_MODEL_ANTHROPIC = 'claude-sonnet-5';
  process.env.RESPONSE_GENERATOR_EFFORT = 'low';
  const sent = stubFetch([{ status: 400, body: '{"error":{"message":"messages: at least one message is required"}}' }]);
  await assert.rejects(() => callLLM({ fn: 'response_generator', user: 'hi' }), /Anthropic API 400/);
  assert.equal(sent.length, 1);
});
