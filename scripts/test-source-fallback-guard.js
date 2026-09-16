/**
 * source:* fallback-guard regression tests — scripts/test-source-fallback-guard.js
 *
 * 2026-09-16 (issue #949) — `source:unknown` was evicting correct paid-vendor
 * attribution. Live example, contact RuUeUK82fcV5MYv4q5AU (2026-09-15 22:33),
 * whose GHL record reads source: "HomeBuddy":
 *
 *   { "step": "add_source",
 *     "result": { "tag_applied": "source:unknown",
 *                 "removed_conflicting": ["source:internet",
 *                                         "source:internet-homebuddy"] } }
 *
 * 707 contacts in 30 days. source:internet-modernize lost 434 times,
 * my-home-pros 147, homebuddy 84, plus angi, lead-gurus and mvp-marketing.
 * Only 3 events in the same window wrote a real source tag over another, so
 * ~99% of these swaps were pure loss — straight into revenue-by-source.
 *
 * The MVI v2.8 guard already existed and already said the right thing ("a
 * fallback carries no routing information, so it must never evict a specific
 * sibling that does"). It just never covered `source:`, because
 * NAMESPACE_FALLBACK_VALUES registered only `active-entry:`. The fix is one
 * table entry; these tests are what stop it being dropped again.
 *
 * Real observed tag values are used deliberately — a test that passes on
 * source:foo/source:bar would not have caught this.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';

// ─── fetch stub (same shape as scripts/test-tag-safety.js) ─────────────
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
  if (pathname.startsWith('/contacts')) calls.push({ method, path: pathname, body });
  if (method === 'GET') return jsonRes({ contact: currentContact });
  return jsonRes({ ok: true });
};

const { executeAddTag, applyTagsBatched, decideTagWrite, NAMESPACE_FALLBACK_VALUES } =
  await import('../src/actions/handlers/tags.js');

function reset(tags) {
  calls = [];
  currentContact = { id: 'c1', tags: [...tags] };
}
const of = (m) => calls.filter((c) => c.method === m);
const posted = () => of('POST').flatMap((c) => c.body?.tags || []);
const deleted = () => of('DELETE').flatMap((c) => c.body?.tags || []);

// ─── 1. the defect itself ──────────────────────────────────────────────

test('source: is registered as a fallback namespace', () => {
  assert.equal(NAMESPACE_FALLBACK_VALUES['source:'], 'source:unknown',
    'without this entry the v2.8 guard never runs for source:* and vendor attribution is silently overwritten');
});

test('source:unknown must not evict a specific vendor tag (issue #949)', async () => {
  reset(['source:internet-homebuddy']);
  const r = await executeAddTag({ target_id: 'c1', action_payload: { tag: 'source:unknown' } });

  assert.equal(r.action, 'no_op');
  assert.equal(r.fallback_blocked, true);
  assert.deepEqual(r.existing_in_namespace, ['source:internet-homebuddy']);
  assert.equal(of('DELETE').length, 0,
    'the DELETE is the attribution loss — HomeBuddy paid for this lead and the tag is how we know');
  assert.equal(of('POST').length, 0, 'and nothing is written over it');
});

test('the exact live case: two source tags present, source:unknown incoming', async () => {
  // Contact RuUeUK82fcV5MYv4q5AU carried both the generic parent and the vendor
  // tag. Before the fix BOTH were deleted and replaced with source:unknown.
  reset(['source:internet', 'source:internet-homebuddy']);
  const r = await applyTagsBatched('c1', ['source:unknown'], { currentTags: currentContact.tags });

  assert.equal(deleted().length, 0, 'neither tag may be removed');
  assert.equal(posted().length, 0);
  assert.equal(r[0].fallback_blocked, true);
});

// ─── 2. the other three transitions must be unaffected ─────────────────

test('a specific source tag still swaps out the fallback', async () => {
  reset(['source:unknown']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'source:internet-modernize' } });

  assert.deepEqual(deleted(), ['source:unknown'],
    'attribution must still be able to IMPROVE — the guard is one-directional');
  assert.ok(posted().includes('source:internet-modernize'));
});

test('source:unknown still beats an empty namespace', async () => {
  reset([]);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'source:unknown' } });

  assert.ok(posted().includes('source:unknown'),
    'unknown is a reportable state; refusing to write it would just hide the lead');
});

test('source:unknown onto source:unknown is a no-op', async () => {
  reset(['source:unknown']);
  const r = await executeAddTag({ target_id: 'c1', action_payload: { tag: 'source:unknown' } });
  assert.equal(r.action, 'no_op');
  assert.equal(calls.length, 1, 'one read, no writes');
});

test('one specific source tag still evicts another', async () => {
  reset(['source:internet-angi']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'source:reece-chatbot' } });

  assert.deepEqual(deleted(), ['source:internet-angi'],
    'ordinary source:* exclusivity is untouched — only the fallback direction changed');
});

// ─── 3. both write paths agree ─────────────────────────────────────────

test('the batched path enforces the guard identically', async () => {
  const cases = [
    { tags: ['source:internet-my-home-pros'], tag: 'source:unknown', verdict: 'no_op' },
    { tags: ['source:unknown'], tag: 'source:internet-my-home-pros', verdict: 'write' },
    { tags: [], tag: 'source:unknown', verdict: 'write' },
    { tags: ['source:unknown'], tag: 'source:unknown', verdict: 'no_op' },
  ];
  for (const c of cases) {
    assert.equal(decideTagWrite(c.tags, c.tag, 'c1').verdict, c.verdict,
      `decideTagWrite(${JSON.stringify(c.tags)}, "${c.tag}") should be ${c.verdict}`);

    reset(c.tags);
    const batched = await applyTagsBatched('c1', [c.tag], { currentTags: c.tags });
    const isNoOp = batched[0].action === 'no_op';
    assert.equal(isNoOp, c.verdict === 'no_op',
      `applyTagsBatched must agree with executeAddTag on ${JSON.stringify(c.tags)} + "${c.tag}"`);
  }
});

test('a routing-tags write protects source while still setting the other three', async () => {
  // The real four-tag shape from handleEnsureRoutingTags on a vendor contact.
  reset(['source:internet-homebuddy']);
  const r = await applyTagsBatched(
    'c1',
    ['entry:other', 'active-entry:other', 'intent-bucket:other', 'source:unknown'],
    { currentTags: currentContact.tags },
  );

  assert.ok(posted().includes('entry:other'), 'routing tags still land');
  assert.ok(posted().includes('active-entry:other'));
  assert.ok(posted().includes('intent-bucket:other'));
  assert.ok(!posted().includes('source:unknown'), 'but the vendor tag is not overwritten');
  assert.equal(deleted().length, 0);
  assert.equal(r[3].fallback_blocked, true);
});

// ─── 4. the pre-existing entry must not regress ────────────────────────

test('active-entry: fallback behavior is unchanged', async () => {
  reset(['active-entry:ppc']);
  const blocked = await executeAddTag({ target_id: 'c1', action_payload: { tag: 'active-entry:other' } });
  assert.equal(blocked.fallback_blocked, true, 'the original v2.8 entry still works');

  reset(['active-entry:other']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'active-entry:ppc' } });
  assert.deepEqual(deleted(), ['active-entry:other'], 'and still swaps in the other direction');
});

test('a namespace with no fallback entry is unaffected', async () => {
  reset(['buyer:cash']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'buyer:finance' } });
  assert.deepEqual(deleted(), ['buyer:cash'],
    'registering source: must not accidentally change every other exclusive namespace');
});
