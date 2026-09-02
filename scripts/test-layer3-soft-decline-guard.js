/**
 * test-layer3-soft-decline-guard.js — a soft decline after a disrupted
 * appointment gets ONE reframe and a 1-week check-back, never a 90-day park.
 * 2026-09-02, contact gpPQYhCsqdGy10wU14Rp: analyzer returned
 * follow_up_scheduled / seasonal / disengagement on a lead whose no-show was
 * 1231 minutes earlier; the dispatch queued issue_hold 2160h.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSoftDeclineAfterAppointmentDisruption,
  applySoftDeclineReframe,
  SOFT_DECLINE_REFRAME_HINT,
} from '../src/services/layer3-dispatch.js';

const BRANHAM = {
  recommended_action: 'follow_up_scheduled',
  follow_up_bucket: 'seasonal',
  engagement_quality: 'disengagement',
  appointment_phase: 'past',
  appointment_minutes_delta: -1231,
  objection_type: 'timing',
};

test('the incident payload is a soft decline', () => {
  assert.equal(isSoftDeclineAfterAppointmentDisruption(BRANHAM), true);
});

test('an explicit near-term timing request is NOT touched', () => {
  for (const bucket of ['tomorrow', 'few-days', '1week', '2weeks']) {
    assert.equal(
      isSoftDeclineAfterAppointmentDisruption({ ...BRANHAM, engagement_quality: 'neutral', follow_up_bucket: bucket }),
      false, `bucket ${bucket} must run the row as written`);
  }
});

test('a vague bucket with NO recent appointment disruption is NOT touched', () => {
  assert.equal(isSoftDeclineAfterAppointmentDisruption({ ...BRANHAM, appointment_phase: 'none' }), false);
  assert.equal(isSoftDeclineAfterAppointmentDisruption({ ...BRANHAM, appointment_minutes_delta: -20000 }), false, 'older than 7 days');
  assert.equal(isSoftDeclineAfterAppointmentDisruption({ ...BRANHAM, appointment_minutes_delta: 600 }), false, 'appointment still ahead');
  assert.equal(isSoftDeclineAfterAppointmentDisruption({ ...BRANHAM, appointment_minutes_delta: undefined }), false, 'missing delta fails toward existing behavior');
});

test('disengagement alone (any bucket) counts when the disruption is recent', () => {
  assert.equal(isSoftDeclineAfterAppointmentDisruption({ ...BRANHAM, follow_up_bucket: '1week' }), true);
});

test('reframe swaps only the send_message prompt and keeps the siblings', () => {
  const row = {
    id: 18, notes: 'orig', actions: [
      { action_type: 'send_message', params: { prompt_hint: 'old', requires_ai_generation: true }, priority: 10 },
      { action_type: 'add_tag', params: { tag: 'follow-up:{{follow_up_bucket}}' } },
      { action_type: 'issue_hold', params: { hold_hours: '{{follow_up_bucket|follow_up_hold_hours}}' } },
    ],
  };
  const out = applySoftDeclineReframe(row);
  assert.equal(out.actions.length, 3);
  assert.equal(out.actions[0].params.prompt_hint, SOFT_DECLINE_REFRAME_HINT);
  assert.equal(out.actions[0].params.requires_ai_generation, true);
  assert.equal(out.actions[0].priority, 10);
  assert.deepEqual(out.actions[1], row.actions[1]);
  assert.deepEqual(out.actions[2], row.actions[2]);
  assert.equal(row.actions[0].params.prompt_hint, 'old', 'source row must not be mutated');
  assert.match(out.notes, /soft-decline reframe/);
});

test('reframe hint respects the framework gates', () => {
  assert.ok(SOFT_DECLINE_REFRAME_HINT.includes('Protection Profile Review'), 'locked Tier-1 offer name');
  assert.ok(!/!/.test(SOFT_DECLINE_REFRAME_HINT.replace(/no exclamation points/, '')), 'no exclamation points');
  assert.ok(!/Randy/.test(SOFT_DECLINE_REFRAME_HINT), 'SMS is never in Randy\'s voice');
  assert.ok(/reframe ONCE/.test(SOFT_DECLINE_REFRAME_HINT));
});
