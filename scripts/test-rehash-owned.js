/**
 * Rehash ownership (Mark, 2026-10-21; Jim Anderson, 5Cp5CiWtQ2zSRlxb2XPL).
 * A rehash contact is OWNED (no bot message) when it carries rehash-owned, has
 * an upcoming Rehash Call, or its newest LP lead is Cnf / Issue / Reset with a
 * visit today or later. A failed read is never owned.
 *
 * Run: node --test scripts/test-rehash-owned.js
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
import test from 'node:test';
import assert from 'node:assert/strict';

const { rehashOwned, ownedDecision, rehashOwnedMode, isOwnedLpLead, REHASH_OWNED_SKIP_REASON } = await import('../src/agentic/rehash-owned.js');
const { postDemoInterrupt, F0_SUPPRESS_REASONS } = await import('../src/siro/f0-interrupts.js');
const { ANSWERED_OUTCOMES } = await import('../src/agentic/turn-lock.js');
const { sendStateFromRows } = await import('../src/jobs/reply-sla-watchdog.js');
const { runRehashGate, inRehash } = await import('../src/services/rehash-gate-io.js');
const { runWithSimOverrides } = await import('../src/simulator/sim-overrides.js');

const CAL = 'ncDzLgzbfKJRfhmtlWtB';
const NOW = Date.parse('2026-10-21T13:01:00Z'); // 9:01 AM ET, after LP set Jim's lead Cnf
const call = (startIso, status = 'new', calendar_id = CAL) => ({ appointment_id: 'a1', calendar_id, start_time: startIso, end_time: startIso, status });

test('a: the rehash-owned tag owns the lead', () => {
  assert.deepEqual(rehashOwned({ tags: ['rehash', 'Rehash-Owned'], appointments: [], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).reason, 'a');
});

test('b: an upcoming Rehash Call owns it; past, cancelled or another calendar does not', () => {
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-22T14:00:00Z')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).reason, 'b');
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-21T12:00:00Z')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).owned, false);
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-22T14:00:00Z', 'cancelled')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).owned, false);
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-22T14:00:00Z', 'new', 'otherCal')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).owned, false);
});

test('c: the newest LP lead Cnf / Issue / Reset with a visit today or later owns it (Jim: 585044 Cnf for 10/22)', () => {
  const jim = { lp_lead_id: 585044, disposition_code: 'Cnf', appointment_date: '2026-10-22T10:00:00+00:00' };
  assert.equal(rehashOwned({ tags: [], appointments: [], currentLead: jim, rehashCalendarId: CAL, nowMs: NOW }).reason, 'c');
  for (const d of ['Issue', 'Reset']) assert.equal(isOwnedLpLead({ ...jim, disposition_code: d }, NOW), true, d);
  assert.equal(isOwnedLpLead({ ...jim, disposition_code: 'OPPFDN' }, NOW), false);
  assert.equal(isOwnedLpLead({ ...jim, appointment_date: '2026-10-20T10:00:00+00:00' }, NOW), false, 'a past visit');
});

test('unknown is never owned: a failed read with nothing else saying owned → null', () => {
  const r = rehashOwned({ tags: [], appointments: null, currentLead: undefined, rehashCalendarId: CAL, nowMs: NOW });
  assert.equal(r.owned, null);
  assert.equal(ownedDecision({ mode: 'live', owned: r }), 'send');
});

test('modes: live skips, shadow would skip, off sends; default shadow', () => {
  const owned = { owned: true, reason: 'a' };
  assert.equal(ownedDecision({ mode: 'live', owned }), 'skip');
  assert.equal(ownedDecision({ mode: 'shadow', owned }), 'would_skip');
  assert.equal(ownedDecision({ mode: 'off', owned }), 'send');
  assert.equal(rehashOwnedMode({}), 'shadow');
  assert.equal(rehashOwnedMode({ REHASH_OWNED_MODE: 'live' }), 'live');
  assert.equal(runWithSimOverrides({ rehashOwnedMode: 'live' }, () => rehashOwnedMode({})), 'live');
});

test('F.0 v2: postDemoInterrupt stops the touch, terminal, reason rehash_owned', () => {
  assert.ok(F0_SUPPRESS_REASONS.includes('rehash_owned'));
  const pd = postDemoInterrupt({ unsoldPostDemo: true, rehashActive: true, rehashOwned: true });
  assert.deepEqual(pd, { suppress: 'rehash_owned', terminal: true });
  assert.equal(postDemoInterrupt({ unsoldPostDemo: true, rehashActive: true, rehashOwned: false, siroFacts: {} }), null);
});

test('the turn is answered: no watchdog (228 / 373) and no SLA rule (371–374) re-answers it', () => {
  assert.ok(ANSWERED_OUTCOMES.has(REHASH_OWNED_SKIP_REASON));
  const st = sendStateFromRows([{ status: 'skipped', error_message: 'rehash_owned', created_at: new Date(NOW).toISOString() }], { now: NOW, inFlightMs: 120000 });
  assert.equal(st.hasHeldSend, true);
});

// ── the gate's I/O, with deps ──
const gateDeps = ({ lead = null, appts = [], manuals = [], lastBot = null } = {}) => {
  const events = [];
  return {
    events,
    deps: {
      supabase: {
        from: () => {
          const q = { select: () => q, eq: () => q, order: () => q, gte: () => q, limit: async () => ({ data: lastBot ? [{ id: 9, created_at: lastBot }] : [], error: null }) };
          return q;
        },
      },
      fetchCurrentLead: async () => lead,
      fetchRecentAndUpcomingAppointments: async () => appts,
      rehashCalendarId: () => CAL,
      manualOutbounds: async () => manuals,
      fetchRecentMessages: async () => ({ messages: [] }),
      callLLMJson: async () => ({ data: { complete: false } }),
      emitEvent: async (e) => { events.push(e); return { id: 1 }; },
      log: () => {},
    },
  };
};

test('gate: an owned rehash lead is skipped in live, marked in shadow; a pre-demo lead is untouched', async () => {
  const lead = { lp_lead_id: 585044, disposition_code: 'Cnf', appointment_date: '2026-10-22T10:00:00+00:00' };
  const live = gateDeps({ lead });
  const r = await runRehashGate({ contactId: 'c1', actionId: 1, tags: ['lp-demo-completed'], nowMs: NOW, env: { REHASH_OWNED_MODE: 'live', REHASH_PAUSE_MODE: 'off' } }, live.deps);
  assert.equal(r.verdict, 'skip');
  assert.equal(r.reason, 'rehash_owned');
  assert.deepEqual(live.events.map((e) => e.event_type), ['rehash.owned_skip']);

  const shadow = gateDeps({ lead });
  const s = await runRehashGate({ contactId: 'c1', actionId: 1, tags: ['lp-demo-completed'], nowMs: NOW, env: { REHASH_PAUSE_MODE: 'off' } }, shadow.deps);
  assert.equal(s.verdict, 'send');
  assert.ok(s.shadow?.rehash_owned_would_skip);
  assert.deepEqual(shadow.events.map((e) => e.event_type), ['rehash.owned_would_skip']);

  const pre = gateDeps({ lead: { lp_lead_id: 1, disposition_code: 'Cnf', appointment_date: '2026-10-22T10:00:00+00:00' } });
  const p = await runRehashGate({ contactId: 'c2', actionId: 2, tags: ['booking:active'], nowMs: NOW, env: { REHASH_OWNED_MODE: 'live', REHASH_PAUSE_MODE: 'live' } }, pre.deps);
  assert.equal(p.verdict, 'send', 'a pre-demo contact keeps option B, never this gate');
  assert.equal(pre.events.length, 0);
});

test('scope: Jim had no rehash tag, only lp-demo-completed, and his newest lead was Cnf; he is in scope', () => {
  assert.equal(inRehash({ tags: ['lp-demo-completed'], currentLead: { disposition_code: 'Cnf' }, env: {} }), true);
  assert.equal(inRehash({ tags: [], currentLead: { disposition_code: 'Sale', closed_won: true }, env: {} }), false, 'a sold lead never');
});
