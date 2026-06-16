/**
 * Layer-3 suppress benign-hold gate — scripts/test-layer3-suppress-gate.js
 *
 * Locks in the Bug 1 fix (Jacqueline Virtue, fbC6JUcY9EDBrHoMiFmF): the
 * overloaded `recommended_action: "suppress"` must only drive the destructive
 * not-interested closeout when there is a GENUINE decline signal. isGenuineDecline
 * is the pure predicate the dispatch gate uses. False positives here are exactly
 * what closed a happy, booked lead as lost — so the bias is conservative.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// supabase.js reads these at import time; set harmless defaults.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const { isGenuineDecline } = await import('../src/services/layer3-dispatch.js');

test('the Jacqueline "Thank you." payload (event 1477622) is NOT a decline', () => {
  const payload = {
    buyer_stage: 5,
    objection_type: null,
    engagement_quality: 'meaningful',
    buying_signals: ['Appointment confirmed', 'Lead acknowledged'],
    recommended_action: 'suppress',
    message_text: 'Thank you.',
  };
  assert.equal(isGenuineDecline(payload), false);
});

test('objection_type not-interested IS a decline (both hyphen and underscore)', () => {
  assert.equal(isGenuineDecline({ objection_type: 'not-interested' }), true);
  assert.equal(isGenuineDecline({ objection_type: 'not_interested' }), true);
  assert.equal(isGenuineDecline({ objection_type: 'opt-out' }), true);
  assert.equal(isGenuineDecline({ objection_type: 'opt_out' }), true);
  assert.equal(isGenuineDecline({ objection_type: 'dnc' }), true);
  assert.equal(isGenuineDecline({ objection_type: 'NOT-INTERESTED' }), true); // case-insensitive
});

test('non-decline objection types are NOT a decline', () => {
  assert.equal(isGenuineDecline({ objection_type: 'price' }), false);
  assert.equal(isGenuineDecline({ objection_type: 'spouse' }), false);
  assert.equal(isGenuineDecline({ objection_type: 'timing' }), false);
});

test('engagement_quality dnc / disengagement IS a decline', () => {
  assert.equal(isGenuineDecline({ engagement_quality: 'dnc' }), true);
  assert.equal(isGenuineDecline({ engagement_quality: 'disengagement' }), true);
  assert.equal(isGenuineDecline({ engagement_quality: 'meaningful' }), false);
  assert.equal(isGenuineDecline({ engagement_quality: 'neutral' }), false);
});

test('standalone refusal phrases in message_text ARE a decline', () => {
  assert.equal(isGenuineDecline({ message_text: 'STOP' }), true);
  assert.equal(isGenuineDecline({ message_text: 'stop texting me' }), true);
  assert.equal(isGenuineDecline({ message_text: 'please unsubscribe me' }), true);
  assert.equal(isGenuineDecline({ message_text: 'do not contact me again' }), true);
  assert.equal(isGenuineDecline({ message_text: 'remove me from your list' }), true);
  assert.equal(isGenuineDecline({ message_text: 'leave me alone' }), true);
  assert.equal(isGenuineDecline({ message_text: "I'm not interested, thanks" }), true);
  assert.equal(isGenuineDecline({ message_text: 'not interested.' }), true);
});

test('ambiguous "not interested in X" is NOT a decline (conservative)', () => {
  assert.equal(isGenuineDecline({ message_text: 'not interested in the 10am slot, can we do 2pm?' }), false);
  assert.equal(isGenuineDecline({ message_text: 'I might be interested in learning more' }), false);
  assert.equal(isGenuineDecline({ message_text: 'Can we stop by at 3 instead?' }), false); // "stop by", not standalone "stop"
});

test('empty / malformed payloads are NOT a decline (fail-safe)', () => {
  assert.equal(isGenuineDecline(null), false);
  assert.equal(isGenuineDecline(undefined), false);
  assert.equal(isGenuineDecline({}), false);
  assert.equal(isGenuineDecline('nope'), false);
  assert.equal(isGenuineDecline({ message_text: '' }), false);
});
