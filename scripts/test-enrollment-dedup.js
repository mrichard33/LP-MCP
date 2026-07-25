/**
 * test-enrollment-dedup.js — cross-rule same-workflow enrollment guard.
 *
 * Exercises src/services/enrollment-dedup.js against an in-memory mock of
 * agent_actions. The guard keys on the DESTINATION workflow (not the rule name),
 * so the two views of one cancellation collapse to a single S5.2 enrollment:
 *   - a second add_to_workflow into the same workflow inside the window →
 *     duplicate (with prior_action_id);
 *   - the same enrollment OUTSIDE the window → not a duplicate;
 *   - a different workflow inside the window → not a duplicate;
 *   - any lookup error fails OPEN (enroll).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { workflowIdentity, findPriorEnrollment } = await import('../src/services/enrollment-dedup.js');

const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const S52 = '0a6a1349-0b44-429b-91e1-4c5be264cd9f';

// Stateful mock of agent_actions.
function mockClient(rows = []) {
  return {
    from() {
      const st = { filters: [], order: null, limit: null };
      const api = {
        select() { return api; },
        eq(k, v) { st.filters.push((r) => String(r[k]) === String(v)); return api; },
        neq(k, v) { st.filters.push((r) => String(r[k]) !== String(v)); return api; },
        gte(k, v) { st.filters.push((r) => r[k] && new Date(r[k]).getTime() >= new Date(v).getTime()); return api; },
        order(k, o) { st.order = { k, asc: o?.ascending === true }; return api; },
        limit(n) { st.limit = n; return api; },
        then(resolve, reject) {
          try {
            let out = rows.slice();
            for (const f of st.filters) out = out.filter(f);
            if (st.order) out.sort((a, b) => (new Date(a[st.order.k]) - new Date(b[st.order.k])) * (st.order.asc ? 1 : -1));
            if (st.limit != null) out = out.slice(0, st.limit);
            return Promise.resolve({ data: out, error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return api;
    },
  };
}

function throwingClient() {
  return { from: () => ({
    select() { return this; }, eq() { return this; }, neq() { return this; },
    gte() { return this; }, order() { return this; }, limit() { return this; },
    then(_res, rej) { return Promise.reject(new Error('boom')).then(_res, rej); },
  }) };
}

const priorRow = (createdAt, workflow_id = S52, id = 100) => ({
  id, target_id: 'C1', action_type: 'add_to_workflow', status: 'completed',
  action_payload: { workflow_id }, created_at: createdAt,
});
const incoming = (workflow_id = S52) => ({ id: 200, target_id: 'C1', action_payload: { workflow_id } });

// ═══ workflowIdentity ═════════════════════════════════════════════════
test('workflowIdentity: workflow_id wins; canonical_code fallback; null otherwise', () => {
  assert.equal(workflowIdentity({ workflow_id: S52 }), S52);
  assert.equal(workflowIdentity({ canonical_code: 'S5.2' }), 'code:S5.2');
  assert.equal(workflowIdentity({}), null);
  assert.equal(workflowIdentity(null), null);
});

// ═══ inside window → duplicate ════════════════════════════════════════
test('second enrollment into same workflow inside window → duplicate with prior_action_id', async () => {
  const rows = [priorRow(ago(2 * 3600 * 1000), S52, 100)]; // 2h ago, window 6h
  const res = await findPriorEnrollment(incoming(S52), { client: mockClient(rows), windowHours: 6 });
  assert.equal(res.duplicate, true);
  assert.equal(res.prior_action_id, 100);
  assert.equal(res.reason, 'duplicate_enrollment_window');
});

test('canonical_code path matches a prior canonical_code enrollment', async () => {
  const rows = [{ id: 101, target_id: 'C1', action_type: 'add_to_workflow', status: 'completed', action_payload: { canonical_code: 'S5.2' }, created_at: ago(3600_000) }];
  const res = await findPriorEnrollment(
    { id: 201, target_id: 'C1', action_payload: { canonical_code: 'S5.2' } },
    { client: mockClient(rows), windowHours: 6 },
  );
  assert.equal(res.duplicate, true);
  assert.equal(res.prior_action_id, 101);
});

// ═══ outside window → not a duplicate ═════════════════════════════════
test('same enrollment OUTSIDE the window → not a duplicate', async () => {
  const rows = [priorRow(ago(7 * 3600 * 1000), S52, 100)]; // 7h ago, window 6h
  const res = await findPriorEnrollment(incoming(S52), { client: mockClient(rows), windowHours: 6 });
  assert.equal(res.duplicate, false);
});

// ═══ different workflow → not a duplicate ═════════════════════════════
test('different workflow inside window → not a duplicate', async () => {
  const rows = [priorRow(ago(3600_000), 'some-other-workflow-uuid', 100)];
  const res = await findPriorEnrollment(incoming(S52), { client: mockClient(rows), windowHours: 6 });
  assert.equal(res.duplicate, false);
});

test('excludes the current action row (neq id)', async () => {
  // Only row present IS the incoming action → must not match itself.
  const rows = [priorRow(ago(60_000), S52, 200)];
  const res = await findPriorEnrollment(incoming(S52), { client: mockClient(rows), windowHours: 6 });
  assert.equal(res.duplicate, false);
});

// ═══ fail-open ════════════════════════════════════════════════════════
test('lookup throws → duplicate:false (fail-open, enrolls)', async () => {
  const res = await findPriorEnrollment(incoming(S52), { client: throwingClient(), windowHours: 6 });
  assert.equal(res.duplicate, false);
  assert.equal(res.reason, 'error_open');
});

test('no resolvable workflow identity → fail-open', async () => {
  const res = await findPriorEnrollment({ id: 200, target_id: 'C1', action_payload: {} }, { client: mockClient([]), windowHours: 6 });
  assert.equal(res.duplicate, false);
  assert.equal(res.reason, 'no_workflow_identity_open');
});
