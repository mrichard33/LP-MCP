/**
 * scripts/test-kb-embed-prewarm.js — reply-path embedding policy (2026-09-16)
 *
 * Guards the fix for the semantic-tier timeouts. Over 13 days of production
 * audit rows, 41 of 217 semantic lookups died as "timed out after 1500ms" —
 * 23% of the exemplar tier and 4% of the live Tier 2. Cause: the ~770ms query
 * embed ran INSIDE each tier's 1500ms box, under a retry policy sized for the
 * background ingest sweeps.
 *
 * Covered here, with no network and no env (CLAUDE.md deps seam):
 *   1. fast mode makes exactly ONE request — a retry can never land inside the
 *      tier budget, and the abandoned work used to keep retrying for ~60s
 *   2. batch callers keep the resilient 3-attempt policy, unchanged
 *   3. the final attempt does not sleep its backoff before giving up
 *   4. prewarmQueryEmbedding is inert when every semantic mode is off
 *      (the "all flags off == byte-identical to before" guarantee)
 *   5. a failed prewarm neither throws nor leaves an unhandled rejection
 *
 * Run: node --test scripts/test-kb-embed-prewarm.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-used';

const { embed, deps } = await import('../src/knowledge/openai-embeddings.js');
const { prewarmQueryEmbedding } = await import('../src/knowledge/kb-retriever.js');

const realFetch = deps.fetch;
function stubFetch(handler) {
  const calls = [];
  deps.fetch = async (url, init) => { calls.push({ url, init }); return handler(calls.length); };
  return calls;
}
function restore() { deps.fetch = realFetch; }

const okResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { total_tokens: 4 }, model: 'test' }),
});
const rateLimited = () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate limited' });

test('fast mode makes exactly one request and does not retry a 429', async (t) => {
  t.after(restore);
  const calls = stubFetch(() => rateLimited());
  await assert.rejects(embed('will these hold up in a cat 4', { fast: true }), /429/);
  assert.equal(calls.length, 1, 'reply path must not retry inside the tier budget');
});

test('fast mode returns the embedding on a clean call', async (t) => {
  t.after(restore);
  const calls = stubFetch(() => okResponse());
  const res = await embed('hurricane rated windows', { fast: true });
  assert.deepEqual(res.embedding, [0.1, 0.2]);
  assert.equal(calls.length, 1);
});

test('batch callers keep the resilient multi-attempt policy', async (t) => {
  t.after(restore);
  const calls = stubFetch((n) => (n < 3 ? rateLimited() : okResponse()));
  const res = await embed('a background sweep input');   // no opts = batch policy
  assert.deepEqual(res.embedding, [0.1, 0.2]);
  assert.equal(calls.length, 3, 'background sweeps must still absorb a transient 429');
});

test('the final attempt gives up without sleeping its backoff', async (t) => {
  t.after(restore);
  stubFetch(() => rateLimited());
  const started = Date.now();
  await assert.rejects(embed('x', { fast: true }), /429/);
  assert.ok(Date.now() - started < 400, 'fast mode must fail immediately, not after a backoff sleep');
});

test('prewarmQueryEmbedding is inert when every semantic mode is off', () => {
  const saved = { ...process.env };
  for (const k of ['KB_FAQ_SEMANTIC_MODE', 'KB_VECTOR_MODE', 'KB_EXEMPLAR_MODE', 'KB_CALL_MOMENTS_MODE']) {
    process.env[k] = 'off';
  }
  try {
    assert.equal(prewarmQueryEmbedding('will these hold up in a cat 4'), null);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('prewarmQueryEmbedding returns null for empty or non-string text', () => {
  const saved = process.env.KB_FAQ_SEMANTIC_MODE;
  process.env.KB_FAQ_SEMANTIC_MODE = 'shadow';
  try {
    assert.equal(prewarmQueryEmbedding(''), null);
    assert.equal(prewarmQueryEmbedding('   '), null);
    assert.equal(prewarmQueryEmbedding(undefined), null);
  } finally {
    if (saved === undefined) delete process.env.KB_FAQ_SEMANTIC_MODE;
    else process.env.KB_FAQ_SEMANTIC_MODE = saved;
  }
});

test('a failed prewarm neither throws nor leaves an unhandled rejection', async (t) => {
  t.after(restore);
  stubFetch(() => { throw new Error('network down'); });
  const saved = process.env.KB_FAQ_SEMANTIC_MODE;
  process.env.KB_FAQ_SEMANTIC_MODE = 'shadow';

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const getter = prewarmQueryEmbedding('a question that will fail to embed');
    assert.equal(typeof getter, 'function', 'a getter is still handed back for buildKbPack');
    // The memo rejects; the tier awaiting it must see a normal rejection.
    await assert.rejects(getter(), /network down/);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], 'prewarm must attach its own catch at kickoff');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (saved === undefined) delete process.env.KB_FAQ_SEMANTIC_MODE;
    else process.env.KB_FAQ_SEMANTIC_MODE = saved;
  }
});
