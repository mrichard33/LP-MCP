/**
 * Batched routing-tag write regression tests — scripts/test-routing-tags-batched.js
 *
 * 2026-09-15 — GHL token starvation. POST /webhook/ghl/ensure-routing-tags cost
 * 7-11 GHL calls per request: one contact read, then four sequential
 * executeAddTag calls, each doing its OWN read plus a write. Against an empty
 * token bucket (tokens=0, queueDepth 5-23, total429s=0 — self-inflicted; GHL
 * never pushed back) every call queued separately and the route took 62-63s.
 *
 * applyTagsBatched collapses that to at most one DELETE and one POST. The
 * danger in doing so is obvious: a batched write that quietly loses the
 * namespace rules would be FASTER AND WRONG. These tests exist to make that
 * impossible to ship — speed that drops tags is a regression, not a fix.
 *
 * Locked down here:
 *   1. entry:* IMMUTABILITY survives batching (first-touch attribution wins).
 *   2. active-entry:* / source:* / intent-bucket:* EXCLUSIVITY still swaps.
 *   3. The v2.8 fallback guard still refuses to displace a specific sibling.
 *   4. A four-tag write issues EXACTLY ONE POST and AT MOST ONE DELETE.
 *   5. Nothing is read when the caller already has the tags (the whole point).
 *   6. A failed read (currentTags: null) blind-adds — a failed read is not
 *      evidence that a namespace is empty.
 *   7. The write is ADDITIVE — never PUT (PUT replaces the whole tag array).
 *   8. decideTagWrite agrees with executeAddTag, so the two paths cannot drift.
 *
 * Mechanism matches scripts/test-tag-safety.js: stub globalThis.fetch, record
 * every {method, path, body} against /contacts, assert on the recorded calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before importing the modules that read it at load time.
process.env.GHL_API_KEY = 'test-key';

// ─── fetch stub ────────────────────────────────────────────────────────
let calls = [];
let currentContact = { id: 'c1', tags: [] };
let failDelete = false;

function jsonRes(body, status = 200) {
  return {
    status,
    ok: status < 400,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const { pathname } = new URL(url);
  const method = opts.method;
  const body = opts.body ? JSON.parse(opts.body) : null;
  // Only GHL contact calls count; the fail-soft contact_tag_snapshot RPC is a
  // Supabase write, not a GHL tag write.
  if (pathname.startsWith('/contacts')) {
    calls.push({ method, path: pathname, body });
    if (method === 'DELETE' && failDelete) return jsonRes({ error: 'boom' }, 500);
  }
  if (method === 'GET') return jsonRes({ contact: currentContact });
  return jsonRes({ ok: true });
};

const { applyTagsBatched, decideTagWrite, executeAddTag } =
  await import('../src/actions/handlers/tags.js');

// ─── helpers ───────────────────────────────────────────────────────────
function reset(tags) {
  calls = [];
  failDelete = false;
  currentContact = { id: 'c1', tags: [...tags] };
}
const of = (m) => calls.filter((c) => c.method === m);
const gets = () => of('GET');
const posts = () => of('POST');
const deletes = () => of('DELETE');
/** Every tag any POST carried, flattened. */
const posted = () => posts().flatMap((c) => c.body?.tags || []);
const deleted = () => deletes().flatMap((c) => c.body?.tags || []);

// The four tags the routing-tags route writes on its inferred_and_set path.
const ROUTING_FOUR = ['entry:ppc', 'active-entry:ppc', 'intent-bucket:hot', 'source:google-ads'];

// ─── 1. call count — the actual fix ────────────────────────────────────

test('a four-tag routing write issues exactly one POST and zero reads when tags are supplied', async () => {
  reset([]);
  await applyTagsBatched('c1', ROUTING_FOUR, { currentTags: [] });

  assert.equal(gets().length, 0,
    'the caller already read the contact — re-reading it is the redundancy that cost 4-5 tokens per request');
  assert.equal(posts().length, 1,
    'four tags must go out in ONE additive POST; four POSTs is the 62s behavior this replaces');
  assert.equal(deletes().length, 0, 'nothing to swap on a contact with no tags');
  assert.deepEqual(posted().sort(), [...ROUTING_FOUR].sort(),
    'every requested tag must actually be written — speed that drops tags is a regression');
});

test('a four-tag write with conflicts issues one DELETE and one POST, not seven calls', async () => {
  reset(['active-entry:organic', 'source:seo', 'intent-bucket:cold']);
  await applyTagsBatched('c1', ROUTING_FOUR, { currentTags: currentContact.tags });

  assert.equal(deletes().length, 1, 'all three namespace swaps belong in ONE DELETE');
  assert.equal(posts().length, 1, 'all four adds belong in ONE POST');
  assert.equal(calls.length, 2, `worst case is 2 GHL calls, got ${calls.length}: ${JSON.stringify(calls)}`);
});

test('applyTagsBatched reads once when the caller has no tags to hand it', async () => {
  reset(['active-entry:organic']);
  await applyTagsBatched('c1', ROUTING_FOUR);
  assert.equal(gets().length, 1, 'exactly one read — never one per tag');
});

// ─── 2. the invariants batching could silently break ───────────────────

test('entry:* immutability survives batching — first-touch attribution still wins', async () => {
  reset(['entry:organic']);
  const results = await applyTagsBatched('c1', ROUTING_FOUR, { currentTags: currentContact.tags });

  assert.ok(!posted().includes('entry:ppc'),
    'entry:organic was already there; entry:ppc must NOT be added — attribution is write-once');
  assert.ok(!deleted().includes('entry:organic'),
    'an immutable namespace is never swapped, only left alone');
  assert.equal(results[0].action, 'no_op');
  assert.equal(results[0].immutable, true);
  assert.deepEqual(results[0].existing_in_namespace, ['entry:organic']);
  // The other three still go through — one no-op must not suppress the batch.
  assert.ok(posted().includes('active-entry:ppc'),
    'a skipped entry:* must not take the rest of the batch down with it');
});

test('active-entry:* and source:* exclusivity still swaps, in the single DELETE', async () => {
  reset(['active-entry:organic', 'source:seo']);
  await applyTagsBatched('c1', ROUTING_FOUR, { currentTags: currentContact.tags });

  assert.ok(deleted().includes('active-entry:organic'),
    'exclusivity means swap, not stack — the old active-entry must be removed');
  assert.ok(deleted().includes('source:seo'), 'same for source:*');
  assert.ok(posted().includes('active-entry:ppc') && posted().includes('source:google-ads'),
    'and the new values must land');
});

test('the exclusivity DELETE never reaches outside the namespaces being written', async () => {
  reset(['active-entry:organic', 'buyer:cash', 'stage:appt-set', 'p3:warm']);
  await applyTagsBatched('c1', ['active-entry:ppc'], { currentTags: currentContact.tags });

  assert.deepEqual(deleted(), ['active-entry:organic'],
    'batching must not turn an exclusivity swap into a blanket clear of unrelated namespaces');
});

test('the v2.8 fallback guard still refuses to displace a specific sibling', async () => {
  reset(['active-entry:ppc']);
  const results = await applyTagsBatched('c1', ['active-entry:other'], { currentTags: currentContact.tags });

  assert.equal(deletes().length, 0, 'a fallback value must never issue the DELETE that would evict a real one');
  assert.equal(posts().length, 0);
  assert.equal(results[0].fallback_blocked, true);
});

test('a tag already present with no conflicts contributes nothing to the POST', async () => {
  reset(['entry:ppc', 'active-entry:ppc', 'intent-bucket:hot', 'source:google-ads']);
  const results = await applyTagsBatched('c1', ROUTING_FOUR, { currentTags: currentContact.tags });

  assert.equal(calls.length, 0, 'a fully-tagged contact must cost ZERO GHL calls');
  assert.ok(results.every((r) => r.action === 'no_op'));
});

// ─── 3. never PUT ──────────────────────────────────────────────────────

test('the batched write is additive — it never issues a PUT', async () => {
  reset(['active-entry:organic', 'buyer:cash']);
  await applyTagsBatched('c1', ROUTING_FOUR, { currentTags: currentContact.tags });

  assert.equal(of('PUT').length, 0,
    'GHL treats PUT /contacts/{id} as a full-array replace — one PUT wipes every tag the contact has');
});

// ─── 4. read-failure semantics ─────────────────────────────────────────

test('currentTags: null blind-adds — a failed read is not evidence a namespace is empty', async () => {
  reset(['entry:organic']);
  await applyTagsBatched('c1', ['entry:ppc'], { currentTags: null });

  assert.equal(gets().length, 0, 'null means the caller already tried and failed; do not retry the read');
  assert.ok(posted().includes('entry:ppc'),
    'with no readable tags the historical behavior is a blind add, not a silent drop');
  assert.equal(deletes().length, 0, 'and namespace logic is skipped entirely, so nothing is removed');
});

test('an omitted currentTags is NOT the same as null', async () => {
  reset(['entry:organic']);
  await applyTagsBatched('c1', ['entry:ppc']);
  assert.equal(gets().length, 1, 'omitted means "you read it"; null means "the read failed"');
  assert.ok(!posted().includes('entry:ppc'), 'having read it, immutability applies');
});

// ─── 5. DELETE failure is best-effort, exactly as on the single-tag path ──

test('a failed exclusivity DELETE still adds, and reports nothing as removed', async () => {
  reset(['active-entry:organic']);
  failDelete = true;
  const results = await applyTagsBatched('c1', ['active-entry:ppc'], { currentTags: currentContact.tags });

  assert.ok(posted().includes('active-entry:ppc'), 'a failed swap must not block the add (prior behavior)');
  assert.deepEqual(results[0].removed_conflicting, [],
    'removed_conflicting must reflect what was ACTUALLY removed, or the snapshot lies about contact state');
});

// ─── 6. the two paths cannot drift ─────────────────────────────────────

test('decideTagWrite gives executeAddTag and applyTagsBatched the same verdicts', async () => {
  const cases = [
    { tags: [], tag: 'entry:ppc', verdict: 'write' },
    { tags: ['entry:organic'], tag: 'entry:ppc', verdict: 'no_op' },
    { tags: ['active-entry:organic'], tag: 'active-entry:ppc', verdict: 'write' },
    { tags: ['active-entry:ppc'], tag: 'active-entry:other', verdict: 'no_op' },
    { tags: ['source:seo'], tag: 'source:seo', verdict: 'no_op' },
    { tags: null, tag: 'entry:ppc', verdict: 'write' },
    { tags: [], tag: 'concern-expressed:', verdict: 'rejected' },
  ];
  for (const c of cases) {
    assert.equal(decideTagWrite(c.tags, c.tag, 'c1').verdict, c.verdict,
      `decideTagWrite(${JSON.stringify(c.tags)}, "${c.tag}") should be ${c.verdict}`);
  }

  // And the executor agrees, on the same input, through the real handler.
  reset(['entry:organic']);
  const r = await executeAddTag({ target_id: 'c1', action_payload: { tag: 'entry:ppc' } });
  assert.equal(r.action, 'no_op');
  assert.equal(r.immutable, true);
  assert.equal(posts().length, 0, 'both paths must refuse the same write');
});

test('a malformed tag is rejected mid-batch without taking the batch down', async () => {
  reset([]);
  const results = await applyTagsBatched('c1', ['entry:ppc', 'concern-expressed:'], { currentTags: [] });

  assert.equal(results[1].action, 'tag_construction_rejected',
    'a tag ending in ":" is a failed template interpolation and must never be written');
  assert.ok(!posted().includes('concern-expressed:'));
  assert.ok(posted().includes('entry:ppc'), 'the well-formed tag in the same batch still lands');
});

// ─── 7. result shape — callers parse step_results ──────────────────────

test('results come back one-per-input-tag in input order, in executeAddTag shape', async () => {
  reset(['active-entry:organic']);
  const results = await applyTagsBatched('c1', ROUTING_FOUR, { currentTags: currentContact.tags });

  assert.equal(results.length, 4, 'the route zips these against its step names by index');
  assert.equal(results[0].tag_applied, 'entry:ppc');
  assert.equal(results[0].contact_id, 'c1');
  assert.equal(results[1].tag_applied, 'active-entry:ppc');
  assert.equal(results[1].namespace, 'active-entry:');
  assert.deepEqual(results[1].removed_conflicting, ['active-entry:organic']);
});

test('falsy tags are skipped so callers can pass conditionals inline', async () => {
  reset([]);
  const results = await applyTagsBatched('c1', ['entry:ppc', null, undefined], { currentTags: [] });
  assert.equal(results.length, 1, 'only the real tag counts');
  assert.deepEqual(posted(), ['entry:ppc']);
});

test('an empty tag list does nothing at all', async () => {
  reset([]);
  const results = await applyTagsBatched('c1', [], { currentTags: [] });
  assert.deepEqual(results, []);
  assert.equal(calls.length, 0, 'no tags means no calls, not an empty POST');
});
