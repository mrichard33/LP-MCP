/**
 * A GHL cancel of an appointment left over after the demo is not a customer
 * cancel (Roberta Ritchie, 2026-10-16). Rule 107 GHL_APPT_CANCELLED_REBOOK moved
 * her P1 to Reactivation and pulled her from F.0 after a person cancelled her
 * stale 10/17 estimate, the day after her 10/16 demo (OPPFDN).
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { stalePostDemoCancel } = await import('../src/appointments/stale-post-demo-cancel.js');
const { lpWallClockToGhlStartTime } = await import('../src/appointment-dates.js');
const { _internal } = await import('../src/decision-engine.js');
const evaluateContextConditions = _internal.evaluateContextConditions;

// 10/17 00:30 ET: the evening after her demo.
const NOW = Date.parse('2026-10-17T04:30:00Z');
const ms = (stored) => Date.parse(lpWallClockToGhlStartTime(stored));
const DEMO = { lp_lead_id: '583833', lp_prospect_id: '461906', ghl_contact_id: 'roberta', disposition_code: 'OPPFDN', appointment_date: '2026-10-16T14:00:00+00:00' };
const OLD = { lp_lead_id: '579742', lp_prospect_id: '461906', ghl_contact_id: 'roberta', disposition_code: 'CXL', appointment_date: '2026-10-17T10:00:00+00:00' };
const STALE_START = ms('2026-10-17T10:00:00+00:00');

test('Roberta: the 10/17 leftover after the 10/16 demo is stale', () => {
  const v = stalePostDemoCancel({ leads: [OLD, DEMO], cancelledStartMs: STALE_START, nowMs: NOW });
  assert.deepEqual([v.stale, v.reason, v.lp_lead_id], [true, 'leftover_after_demo', '583833']);
});

test('a later visit a live lead still holds is a real cancel', () => {
  const live = { ...OLD, lp_lead_id: '579742', disposition_code: 'Set' };
  const v = stalePostDemoCancel({ leads: [live, DEMO], cancelledStartMs: STALE_START, nowMs: NOW });
  assert.deepEqual([v.stale, v.reason], [false, 'live_lead_holds_slot']);
});

test('the newest lead not post-demo, a demo over 30 days ago, or a cancel before the demo: a real cancel', () => {
  assert.equal(stalePostDemoCancel({ leads: [{ ...DEMO, disposition_code: 'Set' }], cancelledStartMs: STALE_START, nowMs: NOW }).reason, 'newest_not_post_demo');
  const oldDemo = { ...DEMO, appointment_date: '2026-09-01T14:00:00+00:00' };
  assert.equal(stalePostDemoCancel({ leads: [oldDemo], cancelledStartMs: STALE_START, nowMs: NOW }).reason, 'demo_outside_window');
  assert.equal(stalePostDemoCancel({ leads: [DEMO], cancelledStartMs: ms('2026-10-16T10:00:00+00:00'), nowMs: NOW }).reason, 'cancelled_not_after_demo');
  assert.equal(stalePostDemoCancel({ leads: [], cancelledStartMs: STALE_START, nowMs: NOW }).reason, 'no_lp_lead');
});

// ── the operator, through evaluateContextConditions ──
function leadsDb({ rows = [], error = null } = {}) {
  return {
    from() {
      const filters = [];
      const api = {
        select() { return api; }, is() { return api; },
        eq(col, v) { filters.push((r) => String(r[col] ?? '') === String(v)); return api; },
        in(col, vs) { filters.push((r) => vs.map(String).includes(String(r[col] ?? ''))); return api; },
        or() { return api; },
        limit: async () => ({ data: error ? null : rows.filter((r) => filters.every((f) => f(r))), error: error ? { message: error } : null }),
      };
      return api;
    },
  };
}
const spec = { not_stale_post_demo_cancel: true };
const evt = (payload = { appointment_id: 'w0Kt', startDate: '2026-10-17', start_time: '10:00 AM' }) =>
  ({ id: 9, ghl_contact_id: 'roberta', event_type: 'ghl.appointment_cancelled', payload });
const ctx = (db) => ({ deps: { supabase: db, emitEvent: async () => {}, nowMs: NOW } });

test('operator: Roberta is suppressed; a real cancel passes', async () => {
  assert.equal(await evaluateContextConditions(spec, {}, evt(), ctx(leadsDb({ rows: [OLD, DEMO] }))), false);
  const live = { ...OLD, disposition_code: 'Set' };
  assert.equal(await evaluateContextConditions(spec, {}, evt(), ctx(leadsDb({ rows: [live, DEMO] }))), true);
  // A pre-demo cancel (newest lead is the Set lead) passes.
  assert.equal(await evaluateContextConditions(spec, {}, evt(), ctx(leadsDb({ rows: [{ ...DEMO, disposition_code: 'Set', appointment_date: '2026-10-17T10:00:00+00:00' }] }))), true);
});

test('operator: a failed read or an unreadable start fails closed; other events never read', async () => {
  assert.equal(await evaluateContextConditions(spec, {}, evt(), ctx(leadsDb({ error: 'down' }))), false);
  assert.equal(await evaluateContextConditions(spec, {}, evt({ appointment_id: 'x' }), ctx(leadsDb({ rows: [OLD, DEMO] }))), false);
  const booked = { ...evt(), event_type: 'ghl.appointment_booked' };
  assert.equal(await evaluateContextConditions(spec, {}, booked, ctx(leadsDb({ error: 'never read' }))), true);
});
