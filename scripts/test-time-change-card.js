/**
 * test-time-change-card.js — TIME CHANGE card ET rendering (Pilot v2 v1.4).
 *
 * The ACV_L3_RESCHEDULE_CAPTURED rule's card template interpolates
 * {{old_appt_time}} → {{new_appt_time}}; buildApptChangeContext must
 * render both in ET from UTC event-payload values, and pass through
 * values that don't parse (Layer-3 extractions may already be phrases).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { buildApptChangeContext } = await import('../src/actions/handlers/notifications.js');
const { interpolate } = await import('../src/actions/helpers.js');

test('UTC payload values render in ET (EDT)', () => {
  const ctx = buildApptChangeContext({
    old_appointment_time: '2026-07-16T18:00:00Z', // 2:00 PM EDT
    new_appointment_time: '2026-07-17T22:00:00Z', // 6:00 PM EDT
  });
  assert.equal(ctx.old_appt_time, '07/16/2026 - 2:00 PM');
  assert.equal(ctx.new_appt_time, '07/17/2026 - 6:00 PM');
});

test('card template renders old→new via the {{word}} interpolation engine', () => {
  const ctx = buildApptChangeContext({
    old_appointment_time: '2026-07-16T18:00:00Z',
    new_appointment_time: '2026-07-17T22:00:00Z',
  });
  const card = interpolate('TIME CHANGE — WAS {{old_appt_time}} → REQUESTED {{new_appt_time}}', ctx);
  assert.equal(card, 'TIME CHANGE — WAS 07/16/2026 - 2:00 PM → REQUESTED 07/17/2026 - 6:00 PM');
});

test('alternate payload keys are honored (first match wins)', () => {
  const ctx = buildApptChangeContext({
    previous_appointment_time: '2026-11-02T15:00:00Z', // 10:00 AM EST — post-fall-back
    appointment_start_time: '2026-11-02T19:00:00Z',    // 2:00 PM EST
  });
  assert.equal(ctx.old_appt_time, '11/02/2026 - 10:00 AM');
  assert.equal(ctx.new_appt_time, '11/02/2026 - 2:00 PM');
});

test('non-parseable values pass through as-is (Layer-3 phrase extraction)', () => {
  const ctx = buildApptChangeContext({
    old_appointment_time: 'Thu 2:00 PM',
    new_appointment_time: 'Friday evening',
  });
  assert.equal(ctx.old_appt_time, 'Thu 2:00 PM');
  assert.equal(ctx.new_appt_time, 'Friday evening');
});

test('missing keys → empty strings, never throws', () => {
  const ctx = buildApptChangeContext({});
  assert.equal(ctx.old_appt_time, '');
  assert.equal(ctx.new_appt_time, '');
  assert.deepEqual(buildApptChangeContext(), { old_appt_time: '', new_appt_time: '' });
});
