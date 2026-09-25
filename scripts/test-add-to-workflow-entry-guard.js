/**
 * add_to_workflow entry guard — scripts/test-add-to-workflow-entry-guard.js
 *
 * Covers the 2026-09-25 v2.3 change in src/actions/handlers/workflows.js.
 *
 * INTAKE_ROUTE_BACKSTOP_E0 (rule 383) guarded only on active-e.0, which E.0
 * removes ~2 minutes into its run, so a lead I.LP-IN had already routed to
 * E.5 / the entry bridge / a booked stage was posted to E.0 a second time
 * (20 of 185 E.0 entrants twice in 3 days, 2026-09-22..24). The rule now names
 * the downstream tags; the handler checks them on the live contact.
 * Asserted at the fetch boundary, like test-add-to-workflow-custom-data.js.
 *
 * Run: node --test scripts/test-add-to-workflow-entry-guard.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'test-location';

let posts = [];
let liveTags = [];
let readFails = false;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url?.url || url);
  if (href.startsWith('https://hooks.example/')) posts.push({ href, body: opts.body });
  if (readFails && !href.startsWith('https://hooks.example/')) {
    return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => 'down' };
  }
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ contact: { id: 'contact-1', tags: liveTags } }),
    text: async () => '{}',
  };
};

const { executeAddToWorkflow, entryGuardMatch } = await import('../src/actions/handlers/workflows.js');

// The guard rule 383 carries after sql/seeds/2026-09-25_intake_backstop_e0_guard.sql.
const GUARD = {
  skip_if_any_tag: ['active-e.5', 'active-e.7', 'active-w07', 'stage:entry-bridge', 'lp-route:appt-confirmed'],
  skip_if_tag_prefix: ['stage:'],
  skip_allow_tags: ['stage:new-lead'],
};

const backstop = () => ({
  target_id: 'contact-1',
  action_payload: {
    webhook_url: 'https://hooks.example/e0',
    canonical_code: 'E.0',
    format: 'json_custom_data',
    ...GUARD,
  },
});

test('entryGuardMatch: active-<code> still wins first (v2.0 unchanged)', () => {
  assert.deepEqual(entryGuardMatch(['active-e.0', 'active-e.5'], { activeTag: 'active-e.0', payload: GUARD }), {
    reason: 'already_enrolled', tag: 'active-e.0',
  });
});

test('entryGuardMatch: exact tag, prefix, allow-list, case', () => {
  assert.equal(entryGuardMatch(['active-e.5'], { payload: GUARD }).tag, 'active-e.5');
  assert.equal(entryGuardMatch(['Stage:Booked-Estimate'], { payload: GUARD }).tag, 'stage:booked-estimate');
  assert.equal(entryGuardMatch(['stage:new-lead', 'ap-intake-created'], { payload: GUARD }), null);
  assert.equal(entryGuardMatch([], { payload: GUARD }), null);
  assert.equal(entryGuardMatch(['stage:booked'], { payload: {} }), null, 'no guard configured = no skip');
});

test('an already-routed lead is NOT posted to E.0 again', async () => {
  posts = []; liveTags = ['ap-intake-created', 'stage:entry-bridge']; readFails = false;
  const res = await executeAddToWorkflow(backstop());
  assert.equal(res.action, 'skipped_entry_guard');
  assert.equal(res.guard_tag, 'stage:entry-bridge');
  assert.equal(posts.length, 0);
});

test('a genuinely new lead (stage:new-lead only) IS posted', async () => {
  posts = []; liveTags = ['ap-intake-created', 'stage:new-lead']; readFails = false;
  const res = await executeAddToWorkflow(backstop());
  assert.equal(res.route, 'B');
  assert.equal(posts.length, 1);
});

test('a failed tag read fails OPEN — never blocks a first enrollment', async () => {
  posts = []; liveTags = ['stage:entry-bridge']; readFails = true;
  const res = await executeAddToWorkflow(backstop());
  assert.equal(res.route, 'B');
  assert.equal(posts.length, 1);
});
