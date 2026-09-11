/**
 * remove_from_workflow clears the enrollment tag — scripts/test-remove-from-workflow-tag-clear.js
 *
 * Covers the 2026-09-11 v2.1 fix in src/actions/handlers/workflows.js.
 *
 * THE BUG: executeRemoveFromWorkflow issued DELETE /contacts/{id}/workflow/{wfId}
 * and returned, never removing the active-<canonical_code> tag that marks the
 * contact as enrolled — the exact tag executeAddToWorkflow's v2.0 idempotency
 * guard reads. Every agentic removal therefore planted the flag that blocks the
 * next enrollment: out of the workflow, still labeled as in it, and
 * un-re-enrollable by any rule carrying a canonical_code. Reference case
 * Alfredo Fontan (VKMKhd8JQ4wsp3zMn8Lt) removed from E.2 by actions
 * 447848 / 447879 / 447891 and still carrying active-e.2 hours later.
 *
 * The last test is the regression that names the bug directly: remove from E.2,
 * then add back to E.2, and assert the add is NOT skipped_already_enrolled.
 *
 * EVERYTHING IS ASSERTED AT THE fetch BOUNDARY. node:test module mocking is
 * deliberately NOT used: `npm test` runs `node --test scripts/test-*.js` with no
 * flags, and mock.module requires --experimental-test-module-mocks, so a mocked
 * suite would break the repo's own test command. The HL workflow_registry read
 * goes through supabase-js, which issues a plain POST to
 * /rest/v1/rpc/run_sql — so the same stub covers it.
 *
 * SUPABASE_* is intentionally left unset: applyTagsToSnapshot short-circuits on a
 * null client, so the suite exercises the GHL + HL surface only.
 *
 * Run: node --test scripts/test-remove-from-workflow-tag-clear.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'test-location';
process.env.HL_SUPABASE_URL = 'https://fake-hl.supabase.co';
process.env.HL_SUPABASE_SERVICE_ROLE_KEY = 'fake-hl-key';
process.env.WORKFLOW_TAG_CLEAR_BUDGET_MS = '150';   // collapse the 20s clear budget

// ─── fetch stub (installed before import) ────────────────────────────
let calls = [];               // { method, path, body } for every GHL call
let contactTags = [];         // live tag state for GET /contacts/{id}
let registryCode = null;      // canonical_code the HL registry answers with
let registryMode = 'ok';      // 'ok' | 'error'
let tagDeleteMode = 'ok';     // 'ok' | 'throw'
let contactReadDelayMs = 0;   // stall the GET so the clear budget expires

function jsonRes(body) {
  return {
    ok: true, status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function errRes(status, text) {
  return {
    ok: false, status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => text,
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const href = String(url?.url || url);
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;

  // ── HL workflow_registry read (supabase-js rpc) ──
  if (href.includes('/rest/v1/rpc/run_sql')) {
    if (registryMode === 'error') return errRes(500, 'HL registry unavailable');
    return jsonRes(registryCode ? [{ canonical_code: registryCode }] : []);
  }

  const path = href.replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path, body });

  if (method === 'GET' && /^\/contacts\/[^/]+$/.test(path)) {
    if (contactReadDelayMs) await new Promise((r) => setTimeout(r, contactReadDelayMs));
    return jsonRes({ contact: { id: 'contact-1', tags: [...contactTags] } });
  }
  if (method === 'DELETE' && /^\/contacts\/[^/]+\/tags$/.test(path)) {
    if (tagDeleteMode === 'throw') return errRes(500, 'GHL tag DELETE exploded');
    const removing = body?.tags || [];
    contactTags = contactTags.filter((t) => !removing.includes(t));
    return jsonRes({ succeeded: true });
  }
  if (method === 'POST' && /^\/contacts\/[^/]+\/tags$/.test(path)) {
    for (const t of body?.tags || []) if (!contactTags.includes(t)) contactTags.push(t);
    return jsonRes({ succeeded: true });
  }
  // workflow enroll / remove
  if (/^\/contacts\/[^/]+\/workflow\/[^/]+$/.test(path)) {
    return jsonRes({ succeeded: true });
  }
  return jsonRes({});
};

const { executeRemoveFromWorkflow, executeAddToWorkflow, tagsToClearOnRemoval } =
  await import('../src/actions/handlers/workflows.js');

function reset({ tags = [], code = null, registry = 'ok', tagDelete = 'ok', readDelayMs = 0 } = {}) {
  calls = [];
  contactTags = [...tags];
  registryCode = code;
  registryMode = registry;
  tagDeleteMode = tagDelete;
  contactReadDelayMs = readDelayMs;
}

const E2_WF = 'e2-workflow-uuid';
const tagDeletes = () => calls.filter((c) => c.method === 'DELETE' && c.path.endsWith('/tags'));

// ═══════════════════════════════════════════════════════════════════
// tagsToClearOnRemoval — pure
// ═══════════════════════════════════════════════════════════════════

test('tagsToClearOnRemoval maps a canonical code to its active-* tag', () => {
  assert.deepEqual(tagsToClearOnRemoval('E.2'), ['active-e.2']);
  assert.deepEqual(tagsToClearOnRemoval('S2.1'), ['active-s2.1']);
});

test('tagsToClearOnRemoval returns [] when no code is resolvable', () => {
  // Clearing nothing is correct here — guessing at a tag name is not.
  assert.deepEqual(tagsToClearOnRemoval(null), []);
  assert.deepEqual(tagsToClearOnRemoval(''), []);
  assert.deepEqual(tagsToClearOnRemoval(undefined), []);
});

// ═══════════════════════════════════════════════════════════════════
// executeRemoveFromWorkflow
// ═══════════════════════════════════════════════════════════════════

test('canonical_code in the payload → the enrollment tag is cleared', async () => {
  reset({ tags: ['active-e.2', 'stage:appointment-set'] });

  const res = await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF, canonical_code: 'E.2' },
  });

  assert.equal(res.action, 'removed');
  assert.deepEqual(res.cleared_tags, ['active-e.2']);
  assert.equal(res.tag_clear_failed, false);
  assert.equal(res.canonical_code_resolved_via, 'payload');

  assert.deepEqual(tagDeletes().map((c) => c.body.tags), [['active-e.2']]);
  assert.ok(!contactTags.includes('active-e.2'), 'active-e.2 removed from GHL');
  // stage:* is a single-value namespace other workflows also write — never touched here.
  assert.ok(contactTags.includes('stage:appointment-set'), 'stage:* left alone');
});

test('workflow_id only → the code is resolved from the HL registry, then cleared', async () => {
  reset({ tags: ['active-s2.1'], code: 'S2.1' });

  const res = await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: 's21-workflow-uuid' },
  });

  assert.equal(res.action, 'removed');
  assert.deepEqual(res.cleared_tags, ['active-s2.1']);
  assert.equal(res.canonical_code_resolved_via, 'hl_registry');
  assert.equal(res.tag_clear_failed, false);
  assert.ok(!contactTags.includes('active-s2.1'));
});

test('registry returns no row → nothing cleared, removal still succeeds', async () => {
  reset({ tags: ['active-e.2'], code: null });

  const res = await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF },
  });

  assert.equal(res.action, 'removed');
  assert.deepEqual(res.cleared_tags, []);
  assert.equal(res.tag_clear_failed, false, 'no row is not a failure');
  assert.equal(res.canonical_code_resolved_via, null);
  assert.equal(tagDeletes().length, 0, 'no tag DELETE attempted');
});

test('registry read errors → nothing cleared, removal still succeeds', async () => {
  reset({ tags: ['active-e.2'], registry: 'error' });

  const res = await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF },
  });

  assert.equal(res.action, 'removed');
  assert.deepEqual(res.cleared_tags, []);
  assert.equal(res.canonical_code_resolved_via, null);
  assert.equal(tagDeletes().length, 0);
});

test('tag removal throws → removal still reports success, with tag_clear_failed', async () => {
  reset({ tags: ['active-e.2'], tagDelete: 'throw' });

  const res = await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF, canonical_code: 'E.2' },
  });

  // The GHL removal is already committed — it is never rolled back over a tag write.
  assert.equal(res.action, 'removed');
  assert.equal(res.tag_clear_failed, true);
  assert.deepEqual(res.cleared_tags, []);
  assert.equal(tagDeletes().length, 1, 'the clear was attempted');
});

test('a stalled tag clear hits its budget — removal still reports success', async () => {
  // The executor watchdog kills a handler at 60s. Unbounded, three rate-limited
  // GHL calls could push a SUCCESSFUL removal past it and turn it into a zombie
  // retry. The budget contains the stall in the part that is already fail-soft.
  reset({ tags: ['active-e.2'], readDelayMs: 400 });   // budget is 150ms here

  const started = Date.now();
  const res = await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF, canonical_code: 'E.2' },
  });

  assert.equal(res.action, 'removed');
  assert.equal(res.tag_clear_failed, true);
  assert.deepEqual(res.cleared_tags, []);
  assert.ok(Date.now() - started < 400, 'returned on the budget, not on the stalled read');
});

test('remove_all: true is unchanged — no tag clearing attempted', async () => {
  reset({ tags: ['active-e.2', 'active-s2.1'], code: 'E.2' });

  const res = await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { remove_all: true },
  });

  assert.deepEqual(res, { action: 'added_to_remove_all_workflow', contact_id: 'contact-1' });
  assert.equal(tagDeletes().length, 0);
  assert.deepEqual(contactTags, ['active-e.2', 'active-s2.1'], 'tags untouched');
});

// ═══════════════════════════════════════════════════════════════════
// The regression: removal must not block the next enrollment
// ═══════════════════════════════════════════════════════════════════

test('round trip: remove from E.2 then add back is NOT skipped_already_enrolled', async () => {
  reset({ tags: ['active-e.2'] });

  await executeRemoveFromWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF, canonical_code: 'E.2' },
  });

  const added = await executeAddToWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF, canonical_code: 'E.2' },
  });

  assert.notEqual(added.action, 'skipped_already_enrolled', 'this is the bug — re-entry was blocked');
  assert.equal(added.action, 'added_to_workflow');
  assert.equal(added.workflow_id, E2_WF);
  assert.ok(
    calls.some((c) => c.method === 'POST' && c.path === `/contacts/contact-1/workflow/${E2_WF}`),
    'the re-enrollment actually reached GHL',
  );
});

test('control: a contact still carrying active-e.2 IS skipped (guard intact)', async () => {
  reset({ tags: ['active-e.2'] });

  const added = await executeAddToWorkflow({
    target_id: 'contact-1',
    action_payload: { workflow_id: E2_WF, canonical_code: 'E.2' },
  });

  assert.equal(added.action, 'skipped_already_enrolled');
});
