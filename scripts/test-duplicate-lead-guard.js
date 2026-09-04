/**
 * Tests — Duplicate-lead guard (src/duplicate-lead-guard.js)
 * scripts/test-duplicate-lead-guard.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-duplicate-lead-guard.js
 *
 * Covers the three things that can silently break this guard:
 *   1. blockingReason() classification — the metrics split live_appointment
 *      vs recent_sale, so a misclassification hides one of the two causes.
 *   2. The fail-OPEN contract. This guard suppresses customer messaging; if a
 *      Supabase error ever started returning a truthy "block" instead of null,
 *      every cancellation would stop routing to S5.2 (~700 contacts/30d).
 *      The fail-open path is the whole safety argument, so it is asserted
 *      directly against an injected failing client rather than assumed.
 *   3. (2026-09-03) That a fail-open is LOUD. A fail-open nobody can see is
 *      indistinguishable from a guard that works, which is exactly how contact
 *      eqjK58AwEZ1juYJH6szE got an S5.2 rescue text on a live appointment: the
 *      guard's last suppression event was 2026-09-02 21:32 and nothing said so.
 *      Every error path must emit exactly one duplicate_lead_guard_unavailable.
 *
 * The injected clients below model the CURRENT transport: two plain
 * .eq/.in/.gte queries each terminating in .limit(1) and resolving to an ARRAY.
 * The previous single .or() + .maybeSingle() shape is gone deliberately — both
 * a parse failure in the nested .or() string and maybeSingle()'s multiple-rows
 * error resolved to the same silent `return null`, which is a pass.
 */

// Supabase client construction in src/supabase.js reads env at import time.
// Set harmless dummies so the module graph loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { blockingReason, findBlockingLiveLead, findBlockingLiveLeadWith } from '../src/duplicate-lead-guard.js';

/**
 * Client stand-in for the two-query transport. `results` is the ordered list of
 * outcomes for the successive .from() calls: [clause (a), clause (b)]. Each
 * entry is either a { data, error } object or a function to invoke (to throw).
 */
function clientReturning(...results) {
  let call = 0;
  const chain = {};
  const self = () => chain;
  for (const m of ['select', 'eq', 'in', 'gte', 'order']) chain[m] = self;
  chain.limit = async () => {
    const r = results[call - 1] ?? { data: [], error: null };
    return typeof r === 'function' ? r() : r;
  };
  return {
    from: () => {
      call += 1;
      const r = results[call - 1];
      if (typeof r === 'function') r(); // allow a throw at .from() time
      return chain;
    },
    get callCount() { return call; },
  };
}

/** Collects emitted events so the fail-open reporting can be asserted. */
function emitSpy() {
  const events = [];
  const fn = async (e) => { events.push(e); };
  fn.events = events;
  return fn;
}

const empty = { data: [], error: null };

// ─── blockingReason classification ─────────────────────────────────────────

test('blockingReason classifies a live Set/Cnf appointment', () => {
  assert.equal(blockingReason({ disposition_code: 'Set' }), 'live_appointment');
  assert.equal(blockingReason({ disposition_code: 'Cnf' }), 'live_appointment');
});

test('blockingReason classifies a recent sale', () => {
  assert.equal(blockingReason({ disposition_code: 'Sale' }), 'recent_sale');
  assert.equal(blockingReason({ disposition_code: 'Sold' }), 'recent_sale');
});

test('blockingReason does not guess on an unexpected disposition', () => {
  assert.equal(blockingReason({ disposition_code: 'CXL' }), 'unknown');
  assert.equal(blockingReason({}), 'unknown');
  assert.equal(blockingReason(null), 'unknown');
});

test('a missing contact_id never blocks', async () => {
  assert.equal(await findBlockingLiveLead(null), null);
  assert.equal(await findBlockingLiveLead(''), null);
  assert.equal(await findBlockingLiveLead(undefined), null);
});

// ─── Fail-open contract ────────────────────────────────────────────────────
// A regression here would turn a bounded false-positive fix into a system-wide
// messaging outage: every cancellation would stop routing to S5.2.

test('a PostgREST error response fails open (returns null, not a block)', async () => {
  const failing = clientReturning({ data: null, error: { message: 'boom' } });
  assert.equal(await findBlockingLiveLeadWith(failing, 'c1', 'DuplicateLeadGuard', { emitEvent: emitSpy() }), null);
});

test('a thrown client error fails open (returns null, not a block)', async () => {
  const throwing = {
    from: () => { throw new Error('connection reset'); },
  };
  assert.equal(await findBlockingLiveLeadWith(throwing, 'c1', 'DuplicateLeadGuard', { emitEvent: emitSpy() }), null);
});

test('a matching row is returned as the block', async () => {
  const row = {
    lp_lead_id: '571845',
    lead_source_detail: 'MVP Marketing',
    disposition_code: 'Set',
    appointment_set: true,
    appointment_date: '2099-01-01T14:00:00+00:00',
    updated_at_lp: '2026-09-01T16:20:15.323+00:00',
  };
  const ok = clientReturning({ data: [row], error: null });
  const blocking = await findBlockingLiveLeadWith(ok, 'c1');
  assert.equal(blocking.lp_lead_id, '571845');
  assert.equal(blockingReason(blocking), 'live_appointment');
});

test('no matching row means no block', async () => {
  assert.equal(await findBlockingLiveLeadWith(clientReturning(empty, empty), 'c1'), null);
});

// ─── 2026-09-03 regression cases ───────────────────────────────────────────

test('the Tom regression: a live future Cnf on another lead blocks', async () => {
  // Contact eqjK58AwEZ1juYJH6szE. Lead 572839 was Cnf with a 2026-09-04 10:00
  // appointment and the identical predicate in raw SQL returns it — yet the
  // guard returned null and S5.2 Appointment Rescue enrolled anyway.
  const tom = {
    lp_lead_id: '572839',
    disposition_code: 'Cnf',
    appointment_set: true,
    appointment_date: '2026-09-04T10:00:00+00:00',
  };
  const client = clientReturning({ data: [tom], error: null });
  const blocking = await findBlockingLiveLeadWith(client, 'eqjK58AwEZ1juYJH6szE');

  assert.notEqual(blocking, null, 'a live future appointment on another lead MUST block');
  assert.equal(blocking.lp_lead_id, '572839');
  assert.equal(blockingReason(blocking), 'live_appointment');
  assert.equal(client.callCount, 1, 'clause (a) matched — clause (b) is not needed');
});

test('clause (a) empty, clause (b) returns a Sale → recent_sale block', async () => {
  const sale = {
    lp_lead_id: '560001',
    disposition_code: 'Sale',
    appointment_set: false,
    appointment_date: null,
    updated_at_lp: '2026-08-30T12:00:00+00:00',
  };
  const client = clientReturning(empty, { data: [sale], error: null });
  const blocking = await findBlockingLiveLeadWith(client, 'c1');

  assert.notEqual(blocking, null);
  assert.equal(blocking.lp_lead_id, '560001');
  assert.equal(blockingReason(blocking), 'recent_sale');
  assert.equal(client.callCount, 2, 'clause (b) runs only after clause (a) misses');
});

test('both clauses empty → no block and NO fail-open event', async () => {
  const emit = emitSpy();
  const res = await findBlockingLiveLeadWith(
    clientReturning(empty, empty), 'c1', 'DuplicateLeadGuard', { emitEvent: emit });

  assert.equal(res, null);
  assert.equal(emit.events.length, 0, 'a clean miss is not an outage — it must stay silent');
});

test('a clause (a) error emits exactly one duplicate_lead_guard_unavailable', async () => {
  const emit = emitSpy();
  const res = await findBlockingLiveLeadWith(
    clientReturning({ data: null, error: { message: 'PGRST100 parse error' } }),
    'eqjK58AwEZ1juYJH6szE',
    'RuleGate',
    { emitEvent: emit },
  );

  assert.equal(res, null, 'fail-open remains the binding rule');
  assert.equal(emit.events.length, 1, 'the fail-open must be countable, not silent');
  const e = emit.events[0];
  assert.equal(e.event_type, 'duplicate_lead_guard_unavailable');
  assert.equal(e.event_subtype, 'live_appointment_query');
  assert.equal(e.bypass_filter, true, 'the intake filter must never swallow this');
  assert.equal(e.ghl_contact_id, 'eqjK58AwEZ1juYJH6szE');
  assert.equal(e.payload.call_site, 'RuleGate', 'the two call sites stay distinguishable');
  assert.match(e.payload.error, /PGRST100/);
});

test('a clause (a) throw emits exactly one duplicate_lead_guard_unavailable', async () => {
  const emit = emitSpy();
  const throwing = { from: () => { throw new Error('connection reset'); } };
  const res = await findBlockingLiveLeadWith(throwing, 'c1', 'ObjectionState', { emitEvent: emit });

  assert.equal(res, null);
  assert.equal(emit.events.length, 1);
  assert.equal(emit.events[0].event_type, 'duplicate_lead_guard_unavailable');
  assert.equal(emit.events[0].event_subtype, 'live_appointment_query');
  assert.equal(emit.events[0].payload.call_site, 'ObjectionState');
});

test('a clause (b) error is reported as recent_sale_query', async () => {
  const emit = emitSpy();
  const res = await findBlockingLiveLeadWith(
    clientReturning(empty, { data: null, error: { message: 'timeout' } }),
    'c1', 'DuplicateLeadGuard', { emitEvent: emit });

  assert.equal(res, null);
  assert.equal(emit.events.length, 1);
  assert.equal(emit.events[0].event_subtype, 'recent_sale_query', 'the failing stage is named');
});

test('two matching rows use the first and do not throw (kills the maybeSingle class)', async () => {
  // .maybeSingle() raised PGRST116 on a multi-row result, and that error landed
  // on the same silent `return null` as a real miss — a contact with two live
  // appointments sailed straight through the guard. .limit(1) + an array result
  // cannot produce that shape at all.
  const rows = [
    { lp_lead_id: '572839', disposition_code: 'Cnf', appointment_set: true, appointment_date: '2026-09-04T10:00:00+00:00' },
    { lp_lead_id: '571136', disposition_code: 'Set', appointment_set: true, appointment_date: '2026-09-04T14:00:00+00:00' },
  ];
  const emit = emitSpy();
  const blocking = await findBlockingLiveLeadWith(
    clientReturning({ data: rows, error: null }), 'c1', 'DuplicateLeadGuard', { emitEvent: emit });

  assert.notEqual(blocking, null, 'two live appointments must still block, not fail open');
  assert.equal(blocking.lp_lead_id, '572839', 'the first row is used');
  assert.equal(emit.events.length, 0, 'a multi-row result is not an error');
});
