/**
 * test-llm-usage.js — the usage ledger never changes what callLLM returns,
 * never throws, prices only known models, and respects the off switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const {
  recordLlmUsage, computeCostUsd, normalizeUsage, rateFor, llmUsageMode, __setLlmUsageClientForTests,
} = await import('../src/llm-usage.js');

const table = { 'claude-sonnet-4-6': { in: 3, out: 15, cache_read: 0.3, cache_write: 3.75 }, 'gpt-5.4-mini': { in: 0.25, out: 2 } };

test('rateFor: exact id, then longest prefix, else null', () => {
  assert.deepEqual(rateFor('claude-sonnet-4-6', table), table['claude-sonnet-4-6']);
  assert.deepEqual(rateFor('claude-sonnet-4-6-20260101', table), table['claude-sonnet-4-6']);
  assert.equal(rateFor('claude-opus-5', table), null);
  assert.equal(rateFor('', table), null);
});

test('computeCostUsd: per-1M math, null for unknown model', () => {
  const c = computeCostUsd({ model: 'claude-sonnet-4-6', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, table);
  assert.equal(c, 3 + 1.5);
  assert.equal(computeCostUsd({ model: 'unknown-model', inputTokens: 10, outputTokens: 10 }, table), null);
});

test('normalizeUsage: anthropic and openai shapes', () => {
  assert.deepEqual(
    normalizeUsage('anthropic', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 }),
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 2 },
  );
  assert.deepEqual(
    normalizeUsage('openai', { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } }),
    { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: null },
  );
  // OpenAI with no cache detail: the whole prompt is uncached input.
  assert.deepEqual(
    normalizeUsage('openai', { prompt_tokens: 10, completion_tokens: 5 }),
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null },
  );
  assert.deepEqual(normalizeUsage('anthropic', null), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
});

test('computeCostUsd: an OpenAI cached token is billed once, at the cached rate', () => {
  const t = normalizeUsage('openai', { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 400_000 } });
  const rates = { 'gpt-5.4-mini': { in: 0.75, out: 4.5, cache_read: 0.075 } };
  // 600k uncached at $0.75 + 400k cached at $0.075 = $0.45 + $0.03
  assert.equal(computeCostUsd({ model: 'gpt-5.4-mini', ...t }, rates), 0.48);
});

test('computeCostUsd: per_minute prices transcription by audio length', () => {
  const rates = { 'whisper-1': { per_minute: 0.006 } };
  assert.equal(computeCostUsd({ model: 'whisper-1', audioSeconds: 600 }, rates), 0.06);
  // No duration reported → no audio cost, but the model is still priced (not NULL).
  assert.equal(computeCostUsd({ model: 'whisper-1', audioSeconds: null }, rates), 0);
});

test('computeCostUsd: an embeddings usage object prices input tokens only', () => {
  const t = normalizeUsage('openai', { prompt_tokens: 500_000, total_tokens: 500_000 });
  assert.equal(t.outputTokens, null);
  assert.equal(computeCostUsd({ model: 'text-embedding-3-small', ...t }, { 'text-embedding-3-small': { in: 0.02 } }), 0.01);
});

test('recordLlmUsage: writes one row, fire-and-forget, never throws', async () => {
  const inserted = [];
  __setLlmUsageClientForTests({ from: () => ({ insert: (row) => { inserted.push(row); return Promise.resolve({ error: null }); } }) });
  const env = { LLM_PRICE_TABLE_JSON: JSON.stringify(table) };
  const row = recordLlmUsage({ fn: 'message_analyzer', group: 'decision_engine', provider: 'anthropic', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 }, latencyMs: 1234.6, ok: true }, env);
  assert.equal(row.fn, 'message_analyzer');
  assert.equal(row.latency_ms, 1235);
  assert.equal(row.cost_usd, Math.round(((100 * 3 + 50 * 15) / 1_000_000) * 1_000_000) / 1_000_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(inserted.length, 1);
});

test('recordLlmUsage: failure rows carry ok=false and a truncated error', () => {
  __setLlmUsageClientForTests({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) });
  const row = recordLlmUsage({ fn: 'x', provider: 'openai', model: 'gpt-5.4-mini', usage: null, latencyMs: 10, ok: false, error: 'e'.repeat(900) }, {});
  assert.equal(row.ok, false);
  assert.equal(row.error.length, 500);
  assert.equal(row.cost_usd, null);
});

test('recordLlmUsage: insert error is swallowed; off mode writes nothing', async () => {
  __setLlmUsageClientForTests({ from: () => ({ insert: () => Promise.reject(new Error('db down')) }) });
  assert.doesNotThrow(() => recordLlmUsage({ fn: 'x', provider: 'anthropic', model: 'm', usage: {}, latencyMs: 1 }, {}));
  await new Promise((r) => setImmediate(r));
  assert.equal(llmUsageMode({ LLM_USAGE_LOG_MODE: 'OFF' }), 'off');
  assert.equal(llmUsageMode({}), 'live');
  assert.equal(recordLlmUsage({ fn: 'x', provider: 'anthropic', model: 'm', usage: {} }, { LLM_USAGE_LOG_MODE: 'off' }), null);
});
