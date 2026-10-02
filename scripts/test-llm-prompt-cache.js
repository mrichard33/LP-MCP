/**
 * test-llm-prompt-cache.js — a static system prompt is sent cacheable.
 *
 * 2026-10-02 review: the reply writer's ~20k-token system prompt and the
 * analyzer's ~9k went uncached on every call. `cacheSystem: true` sends the
 * system as one text block with cache_control; without it the body is
 * unchanged (a varying prompt must not pay the cache-write premium).
 *
 * Run: node --test scripts/test-llm-prompt-cache.js
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.ANTHROPIC_API_KEY ||= 'test_anthropic_key';
process.env.LLM_PROVIDER = 'anthropic';

import test from 'node:test';
import assert from 'node:assert/strict';

const { callLLM } = await import('../src/llm-client.js');
const realFetch = globalThis.fetch;

function stub() {
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const body = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return sent;
}
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.LLM_MODEL_ANTHROPIC; });

test('cacheSystem: the system prompt goes as one cacheable text block', async () => {
  process.env.LLM_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001';
  const sent = stub();
  const out = await callLLM({ fn: 'live_chat', system: 'STATIC PROMPT', user: 'hi', maxTokens: 100, cacheSystem: true });
  assert.deepEqual(sent[0].system, [{ type: 'text', text: 'STATIC PROMPT', cache_control: { type: 'ephemeral' } }]);
  assert.equal(out.usage.cache_read_input_tokens, 20000);
});

test('without cacheSystem the body is unchanged', async () => {
  process.env.LLM_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001';
  const sent = stub();
  await callLLM({ fn: 'live_chat', system: 'VARYING PROMPT', user: 'hi', maxTokens: 100 });
  assert.equal(sent[0].system, 'VARYING PROMPT');
});

test('reply-lock TTL is derived from the reply writer budget, never below 120s', async () => {
  const { lockTtlSec } = await import('../src/services/agentic-reply-locks.js');
  assert.equal(lockTtlSec({}, () => 62_000), 154, 'a thinking-model turn fits inside the lock');
  assert.equal(lockTtlSec({}, () => 30_000), 120);
  assert.equal(lockTtlSec({ LOCK_TTL_SEC: '300' }, () => 62_000), 300);
});
