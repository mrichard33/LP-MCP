/**
 * 2026-10-16 (Linda Darnell, wq7tGW8n2HlOxgd2gnBt): "Too expensive for me."
 * three days (4,680 minutes) after her demo was routed callback_request +
 * phone_call by the APPOINTMENT-DAY OVERRIDE, which was written for a homeowner
 * texting during or just after their own visit. The override now holds on the
 * appointment day only; a real call request still files.
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { applyAppointmentDayGate, appointmentDayOverrideApplies } = await import('../src/message-analyzer.js');
const { leadAsksForCall } = await import('../src/agentic/nepq-planner.js');

// 3:59 PM ET, 2026-10-16 (the incident's analysis time).
const NOW = Date.parse('2026-10-16T19:59:55Z');
const ctx = (lp, conversation = []) => ({ lp, conversation_recent: conversation, now: { tz: 'America/New_York' } });
const linda = () => ({ recommended_action: 'callback_request', requested_fulfillment: 'phone_call', objection_type: 'price' });
const PAST_3_DAYS = { appointment_phase: 'past', appointment_minutes_delta: -4680, appointment_days_delta: -3 };

test('past appointment (-4680 min) + "Too expensive for me." → not a callback, no phone call', () => {
  const a = applyAppointmentDayGate(linda(), 'Too expensive for me.', ctx(PAST_3_DAYS), 'wq7', { nowMs: NOW });
  assert.equal(a.recommended_action, 'deploy_objection_handler');
  assert.equal(a.requested_fulfillment, null);
  assert.equal(a.objection_type, 'price');
  // With no objection on file, the turn stays with the conversation.
  const b = applyAppointmentDayGate({ recommended_action: 'callback_request', requested_fulfillment: 'phone_call', objection_type: null }, 'ok thanks', ctx(PAST_3_DAYS), 'x', { nowMs: NOW });
  assert.equal(b.recommended_action, 'continue_current');
});

test('past appointment + "can you call me?" → callback_request still files', () => {
  const a = applyAppointmentDayGate(linda(), 'can you call me?', ctx(PAST_3_DAYS), 'wq7', { nowMs: NOW });
  assert.equal(a.recommended_action, 'callback_request');
  assert.equal(a.requested_fulfillment, 'phone_call');
});

test('past appointment + a yes to our call offer → callback_request still files', () => {
  const thread = [{ direction: 'outbound', text: 'Want someone to give you a call and go over it?' }];
  const a = applyAppointmentDayGate(linda(), 'Yes', ctx(PAST_3_DAYS, thread), 'x', { nowMs: NOW });
  assert.equal(a.recommended_action, 'callback_request');
});

test('the appointment day keeps the override: in_window, or past earlier the same day', () => {
  const sameDay = { appointment_phase: 'past', appointment_minutes_delta: -180 };
  assert.equal(applyAppointmentDayGate(linda(), 'Too expensive for me.', ctx(sameDay), 'x', { nowMs: NOW }).recommended_action, 'callback_request');
  const inWindow = { appointment_phase: 'in_window', appointment_minutes_delta: -30 };
  assert.equal(applyAppointmentDayGate(linda(), 'Where is he?', ctx(inWindow), 'x', { nowMs: NOW }).recommended_action, 'callback_request');
});

test('appointmentDayOverrideApplies: the local calendar day decides', () => {
  assert.equal(appointmentDayOverrideApplies(PAST_3_DAYS, { nowMs: NOW }), false);
  assert.equal(appointmentDayOverrideApplies({ appointment_phase: 'past', appointment_minutes_delta: -180 }, { nowMs: NOW }), true);
  // 12:30 AM ET, a 6 PM visit the evening before: yesterday, not today.
  assert.equal(appointmentDayOverrideApplies({ appointment_phase: 'past', appointment_minutes_delta: -390 }, { nowMs: Date.parse('2026-10-17T04:30:00Z') }), false);
  // No time of day: the day delta decides.
  assert.equal(appointmentDayOverrideApplies({ appointment_phase: 'past', appointment_minutes_delta: null, appointment_days_delta: 0 }, { nowMs: NOW }), true);
  assert.equal(appointmentDayOverrideApplies({ appointment_phase: 'past', appointment_minutes_delta: null, appointment_days_delta: -2 }, { nowMs: NOW }), false);
  assert.equal(appointmentDayOverrideApplies({ appointment_phase: 'scheduled', appointment_minutes_delta: 600 }, { nowMs: NOW }), false);
  assert.equal(appointmentDayOverrideApplies(null, { nowMs: NOW }), false);
});

test('routes that are not a call, and leads with no past appointment, are untouched', () => {
  const objection = { recommended_action: 'deploy_objection_handler', requested_fulfillment: null, objection_type: 'price' };
  assert.deepEqual(applyAppointmentDayGate({ ...objection }, 'Too expensive', ctx(PAST_3_DAYS), 'x', { nowMs: NOW }), objection);
  const future = { appointment_phase: 'scheduled', appointment_minutes_delta: 3000 };
  assert.equal(applyAppointmentDayGate(linda(), 'Too expensive', ctx(future), 'x', { nowMs: NOW }).recommended_action, 'callback_request');
});

test('leadAsksForCall: their own words, or a yes to our call offer; never "I can call you back"', () => {
  assert.equal(leadAsksForCall('Too expensive for me.'), false);
  assert.equal(leadAsksForCall('can you call me?'), true);
  assert.equal(leadAsksForCall('Call me tomorrow at 5'), true);
  assert.equal(leadAsksForCall('When can John call me?'), true);
  assert.equal(leadAsksForCall('Yes', 'Want someone to give you a call and go over it?'), true);
  assert.equal(leadAsksForCall('Yes', 'Does that make sense?'), false);
  assert.equal(leadAsksForCall('I can call back when I have more time'), false);
});

test('the prompt limits the override to the appointment day', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/message-analyzer.js', import.meta.url), 'utf8');
  assert.match(src, /It applies ONLY on the day of the appointment/);
  assert.match(src, /When the appointment was on an EARLIER day, this override does NOT apply/);
});
