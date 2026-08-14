/**
 * test-source-event-meta.js — the source-event lookup must name its table.
 *
 * REGRESSION (2026-08-06 → 2026-08-14, PR #626): fetchSourceEventMeta was
 * written as
 *
 *     await supabase.select('event_type, created_at, payload').eq(...)
 *
 * with no .from('system_events'). `select` is not a method on the Supabase
 * client, so every call threw TypeError into a bare `catch {}` and returned
 * null. Nothing logged. Every consumer silently degraded, and the loudest was
 * the quiet-hours gate: it reads event_type to tell a fresh REPLY from a
 * bot-INITIATED send, so with null metadata it classified every reply as
 * bot-initiated and deferred it to 8 AM. Canary: contact 29Fn3GsJPb3H6hriEvR9
 * replied by email at 01:52Z and 02:09Z on 2026-08-14; both replies were
 * generated, then parked as status=pending / "deferred: quiet_hours_hold" /
 * retry_at=12:00Z, with source_event_type: null recorded in the deferral.
 *
 * The mock below is shaped like the REAL client on purpose: it exposes .from()
 * and does NOT expose .select(). Delete the .from() again and this suite fails
 * exactly the way production did, instead of passing against a forgiving stub.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { _internal } = await import('../src/send-message-handler.js');
const { fetchSourceEventMeta } = _internal;

const ROW = {
  event_type: 'ai.analysis_completed',
  created_at: '2026-08-14T02:09:13.904Z',
  payload: { recommended_action: 'advance_stage', escalation_category: null },
};

/**
 * A client with .from() and deliberately NO .select() — same shape as
 * @supabase/supabase-js, where `typeof client.select === 'undefined'`.
 */
function mockClient({ row = ROW, error = null, throwOn = null } = {}) {
  const tables = [];
  return {
    tables,
    from(table) {
      tables.push(table);
      if (throwOn === 'from') throw new Error('connection reset');
      const api = {
        select() { return api; },
        eq() { return api; },
        async maybeSingle() {
          if (throwOn === 'query') throw new Error('socket hang up');
          if (table !== 'system_events') return { data: null, error: null };
          return { data: row, error };
        },
      };
      return api;
    },
  };
}

// ── the regression itself ───────────────────────────────────────────

test('the lookup queries system_events (the missing .from() regression)', async () => {
  const client = mockClient();
  const meta = await fetchSourceEventMeta(2829276, { client });

  assert.deepEqual(client.tables, ['system_events'],
    'fetchSourceEventMeta must name its table — a bare .select() throws on the real client');
  assert.equal(meta?.event_type, 'ai.analysis_completed');
});

test('the real client shape has no top-level .select (why the bug was silent)', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const real = createClient('http://localhost:54321', 'test-key');
  assert.equal(typeof real.from, 'function');
  assert.equal(typeof real.select, 'undefined',
    'if this ever becomes a function the regression stops being detectable this way');
});

// ── it actually returns what callers need ───────────────────────────

test('returns the fields the quiet-hours gate and the back-compat reads use', async () => {
  const meta = await fetchSourceEventMeta(2829276, { client: mockClient() });
  // quiet hours reads event_type; staleness reads created_at; the
  // recommended_action/escalation_category fallbacks read payload.
  assert.equal(meta.event_type, 'ai.analysis_completed');
  assert.equal(meta.created_at, '2026-08-14T02:09:13.904Z');
  assert.equal(meta.payload.recommended_action, 'advance_stage');
});

test('a ghl.reply_received source is also a reply class', async () => {
  const client = mockClient({ row: { ...ROW, event_type: 'ghl.reply_received' } });
  const meta = await fetchSourceEventMeta(1, { client });
  assert.equal(meta.event_type, 'ghl.reply_received');
});

// ── failure paths stay soft, but no longer silent ───────────────────

test('a null/absent event id short-circuits without touching the DB', async () => {
  const client = mockClient();
  assert.equal(await fetchSourceEventMeta(null, { client }), null);
  assert.equal(await fetchSourceEventMeta(undefined, { client }), null);
  assert.equal(await fetchSourceEventMeta(0, { client }), null);
  assert.deepEqual(client.tables, [], 'no query should be issued without an id');
});

test('a missing client returns null rather than throwing', async () => {
  assert.equal(await fetchSourceEventMeta(123, { client: null }), null);
});

test('a query error returns null (fail-soft)', async () => {
  const meta = await fetchSourceEventMeta(1, {
    client: mockClient({ row: null, error: { message: 'permission denied' } }),
  });
  assert.equal(meta, null);
});

test('a thrown query returns null rather than propagating', async () => {
  assert.equal(await fetchSourceEventMeta(1, { client: mockClient({ throwOn: 'query' }) }), null);
  assert.equal(await fetchSourceEventMeta(1, { client: mockClient({ throwOn: 'from' }) }), null);
});

test('a row that does not exist returns null, not undefined', async () => {
  const meta = await fetchSourceEventMeta(1, { client: mockClient({ row: null }) });
  assert.equal(meta, null);
});
