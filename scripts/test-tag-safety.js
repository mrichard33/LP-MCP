/**
 * Tag-write safety regression tests — scripts/test-tag-safety.js
 *
 * Locks in the invariants that protect contact tags from being clobbered, and
 * the no-op call-reduction behavior:
 *   1. add_tag is ADDITIVE — only POST (+ DELETE for same-namespace conflicts),
 *      NEVER PUT (a PUT would replace the whole tag array and wipe existing tags).
 *   2. exclusivity DELETE targets ONLY same-prefix tags — adding stage:* must
 *      never touch entry:* / buyer:* / appt:*.
 *   3. add_tag when the tag is already present + no conflicts → no_op, zero writes.
 *   4. remove_tag explicit mode with none of the requested tags present → no_op,
 *      zero DELETEs.
 *
 * Mechanism: the GHL layer bottoms out at global fetch() inside ghlFetch
 * (src/actions/helpers.js). We stub globalThis.fetch to return controlled
 * contact data and record every {method, path, body}, then assert on the
 * recorded calls. No module-mock flags required. The rate limiter's bucket
 * starts full (fast path), so the handful of calls here resolve immediately.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before importing the modules that read it at load time.
process.env.GHL_API_KEY = 'test-key';

// ─── fetch stub ────────────────────────────────────────────────────────
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
  // Record GHL contact calls only. Since 2026-07-23 (suppression hardening
  // Phase 4) tag handlers also write through to contact_tag_snapshot via a
  // Supabase RPC (fail-soft, POST /rest/v1/rpc/...); that call is not a GHL
  // tag write and must not count against the additive-write invariants.
  if (pathname.startsWith('/contacts')) {
    calls.push({ method, path: pathname, body });
  }
  if (method === 'GET') return jsonRes({ contact: currentContact });
  return jsonRes({ ok: true });
};

const { executeAddTag, executeRemoveTag } = await import('../src/actions/handlers/tags.js');

// ─── helpers ───────────────────────────────────────────────────────────
function reset(tags) {
  calls = [];
  currentContact = { id: 'c1', tags: [...tags] };
}
function ctx() {
  return { _contactCache: new Map() };
}
const writes = () => calls.filter((c) => c.method === 'POST' || c.method === 'DELETE');
const byMethod = (m) => calls.filter((c) => c.method === m);

// ─── tests ─────────────────────────────────────────────────────────────
test('add_tag is additive: only POST (+ same-namespace DELETE), never PUT', async () => {
  reset(['stage:old']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'stage:new' } }, ctx());

  assert.equal(byMethod('PUT').length, 0, 'must never issue a PUT (PUT replaces the whole array)');
  const posts = byMethod('POST');
  assert.equal(posts.length, 1, 'exactly one POST');
  assert.deepEqual(posts[0].body, { tags: ['stage:new'] });
  const deletes = byMethod('DELETE');
  assert.equal(deletes.length, 1, 'one DELETE for the conflicting stage');
  assert.deepEqual(deletes[0].body, { tags: ['stage:old'] });
});

test('exclusivity DELETE targets only same-prefix tags (never unrelated namespaces)', async () => {
  reset(['stage:old', 'entry:foo', 'buyer:x', 'appt:y']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'stage:new' } }, ctx());

  assert.equal(byMethod('PUT').length, 0);
  const deletes = byMethod('DELETE');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body, { tags: ['stage:old'] }, 'only stage:* removed; entry/buyer/appt untouched');
});

test('add_tag when tag already present + no conflicts → no_op, zero writes', async () => {
  reset(['stage:new']);
  const r = await executeAddTag({ target_id: 'c1', action_payload: { tag: 'stage:new' } }, ctx());

  assert.equal(r.action, 'no_op');
  assert.equal(writes().length, 0, 'no POST/DELETE when the tag is already present');
});

test('remove_tag explicit mode with none present → no_op, zero DELETEs', async () => {
  reset(['stage:new']);
  const r = await executeRemoveTag(
    { target_id: 'c1', action_payload: { tags: ['intent:a', 'intent:b'] } },
    ctx(),
  );

  assert.equal(r.action, 'no_op');
  assert.equal(byMethod('DELETE').length, 0, 'no DELETE when none of the requested tags are present');
});

test('remove_tag explicit mode deletes only the present subset', async () => {
  reset(['keep:a', 'drop:b']);
  await executeRemoveTag(
    { target_id: 'c1', action_payload: { tags: ['drop:b', 'absent:z'] } },
    ctx(),
  );

  const deletes = byMethod('DELETE');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body, { tags: ['drop:b'] }, 'only the present tag is deleted');
});

test('add_tag reuses one GET across immutability + exclusivity + present checks', async () => {
  reset(['stage:old']);
  await executeAddTag({ target_id: 'c1', action_payload: { tag: 'stage:new' } }, ctx());

  assert.equal(byMethod('GET').length, 1, 'a single contact read serves all add_tag checks');
});
