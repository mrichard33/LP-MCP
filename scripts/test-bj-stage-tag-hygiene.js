/**
 * bj: stage exclusivity + empty-namespace tag hygiene —
 * scripts/test-bj-stage-tag-hygiene.js
 *
 * Victor Lopez incident (2026-07-04): his record carried BOTH
 * bj:stage-4-negotiating AND bj:stage-5-committed, plus a malformed
 * empty-value tag `concern-expressed:` (trailing colon).
 *
 * Locks in:
 *   1. bj:stage-* is an exclusive namespace — adding stage-5 removes
 *      stage-4 (DELETE then POST, never PUT).
 *   2. Exclusivity never touches other bj-adjacent or unrelated tags.
 *   3. A tag ending in ':' (empty namespace value) is rejected before any
 *      write — both in executeAddTag and the ghl.js applyGHLTag backstop.
 *
 * Same fetch-stub mechanism as scripts/test-tag-safety.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';

let calls = [];
let currentContact = { id: 'c1', tags: [] };

function jsonRes(body) {
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const { pathname } = new URL(url);
  const method = opts.method;
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path: pathname, body });
  if (method === 'GET') return jsonRes({ contact: currentContact });
  return jsonRes({ ok: true });
};

const { executeAddTag, NAMESPACE_EXCLUSIVE_PREFIXES } = await import('../src/actions/handlers/tags.js');

function reset(tags) {
  calls = [];
  currentContact = { id: 'c1', tags: [...tags] };
}
const ctx = () => ({ _contactCache: new Map() });
const byMethod = (m) => calls.filter((c) => c.method === m);

test('bj:stage- is registered as an exclusive namespace', () => {
  assert.ok(NAMESPACE_EXCLUSIVE_PREFIXES.includes('bj:stage-'));
});

test('adding bj:stage-5 removes bj:stage-4 (DELETE + POST, never PUT)', async () => {
  reset(['bj:stage-4-negotiating', 'chatbot', 'intent-hot']);
  const result = await executeAddTag(
    { target_id: 'c1', action_payload: { tag: 'bj:stage-5-committed' } },
    ctx(),
  );

  assert.equal(byMethod('PUT').length, 0, 'never PUT (tag-wipe hazard)');
  const deletes = byMethod('DELETE');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body, { tags: ['bj:stage-4-negotiating'] });
  const posts = byMethod('POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { tags: ['bj:stage-5-committed'] });
  assert.deepEqual(result.removed_conflicting, ['bj:stage-4-negotiating']);
});

test('bj:stage exclusivity never touches unrelated tags', async () => {
  reset(['bj:stage-3-comparing', 'bj:stage-4-negotiating', 'buyer:committed', 'stage:qualified', 'entry:chatbot']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'bj:stage-5-committed' } }, ctx());

  const deleted = byMethod('DELETE').flatMap((c) => c.body.tags);
  assert.deepEqual(deleted.sort(), ['bj:stage-3-comparing', 'bj:stage-4-negotiating']);
  assert.ok(!deleted.includes('buyer:committed'));
  assert.ok(!deleted.includes('stage:qualified'));
  assert.ok(!deleted.includes('entry:chatbot'));
});

test('empty namespace value ("concern-expressed:") is rejected with zero writes', async () => {
  reset(['chatbot']);
  const result = await executeAddTag(
    { target_id: 'c1', action_payload: { tag: 'concern-expressed:' } },
    ctx(),
  );
  assert.equal(result.action, 'tag_construction_rejected');
  assert.equal(result.skipped, true);
  assert.equal(calls.length, 0, 'no GHL calls at all for a malformed tag');
});

test('applyGHLTag backstop also refuses empty-namespace tags', async () => {
  const { applyGHLTag } = await import('../src/ghl.js');
  const ok = await applyGHLTag('c1', 'bj:stage-:');
  assert.equal(ok, false);
  const ok2 = await applyGHLTag('c1', 'concern-expressed:');
  assert.equal(ok2, false);
});
