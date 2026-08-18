/**
 * HOT_CALL_IMMEDIATE match fix — scripts/test-hot-call-immediate-match.js
 *
 * The failing case first (handoff C1): on 2026-08-18, events 2940885 and
 * 2940982 (contact KE2VqAhWZ91iCdmwAmmx, John Czeropski) carried
 * recommended_action=callback_request + requested_fulfillment=phone_call.
 * The SMS promised "someone will ring you within the next few minutes."
 * HOT_CALL_IMMEDIATE (agent_rules id 324) never fired: its
 * payload_message_matches urgency regex required "call me now / asap /
 * immediately" wording, and John was polite. No rule fire → no LP push →
 * no dial. The engine evaluator was correct; the rule's gate was wrong.
 *
 * These tests replay the LIVE payloads of both events through the real
 * evaluator (decision-engine _internal.evaluateContextConditions):
 *   - the OLD conditions BLOCK both events (documents the defect),
 *   - the NEW conditions (sql/seeds/2026-08-18_hot_call_immediate_widen_
 *     and_requeue.sql) PASS both, urgent and calm alike,
 *   - and the widened rule still refuses everything it must refuse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { _internal } = await import('../src/decision-engine.js');
const { evaluateContextConditions } = _internal;

// ─── the rule's conditions, before and after ───────────────────────

// Live row state before the 2026-08-18 fix (agent_rules id 324, version 1).
const OLD_CONDITIONS = {
  not_has_tag: 'stop-bot',
  recommended_action_eq: 'callback_request',
  payload_message_matches: '\\b(call\\s+me\\s+now|right\\s+now|now\\s+works|call\\s+now|asap|immediately)\\b',
};

// The widened conditions (seed phase 1).
const NEW_CONDITIONS = {
  not_has_tag: 'stop-bot',
  recommended_action_eq: 'callback_request',
  payload_field_eq: { field: 'requested_fulfillment', value: 'phone_call' },
};

// ─── live event payloads (system_events, verbatim fields under test) ──

// Event 2940885, 2026-08-18T17:29:19Z — John asks for a number to call.
const EVENT_2940885_PAYLOAD = {
  channel: 'sms',
  message_text: "hi Mark what's a phone number at which I can call you?",
  call_purpose: 'general_questions',
  buyer_stage: 3,
  engagement_quality: 'meaningful',
  recommended_action: 'callback_request',
  requested_fulfillment: 'phone_call',
  fast_track_eligible: true,
  buyer_stage_confidence: 0.75,
};

// Event 2940982, 2026-08-18T17:30:57Z — the polite confirmation.
const EVENT_2940982_PAYLOAD = {
  channel: 'sms',
  message_text: 'yes and thanks',
  call_purpose: 'requested_callback',
  buyer_stage: 4,
  engagement_quality: 'meaningful',
  recommended_action: 'callback_request',
  requested_fulfillment: 'phone_call',
  fast_track_eligible: true,
  buyer_stage_confidence: 0.85,
};

/** Build an event with the contact-snapshot memo pre-resolved (tags known). */
function makeEvent(payload, tags = []) {
  return {
    id: 999001,
    event_type: 'ai.analysis_completed',
    ghl_contact_id: 'KE2VqAhWZ91iCdmwAmmx',
    payload,
    _contactSnapshot: { tags, source: 'test' },
  };
}

// ─── the defect, documented ────────────────────────────────────────

test('OLD conditions block event 2940982 ("yes and thanks") — the defect', async () => {
  const pass = await evaluateContextConditions(OLD_CONDITIONS, {}, makeEvent(EVENT_2940982_PAYLOAD), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, false);
});

test('OLD conditions block event 2940885 (polite ask for a number) — the defect', async () => {
  const pass = await evaluateContextConditions(OLD_CONDITIONS, {}, makeEvent(EVENT_2940885_PAYLOAD), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, false);
});

// ─── the fix: both live events now fire the rule ───────────────────

test('NEW conditions pass event 2940982 — the calm confirmation fires the rule', async () => {
  const pass = await evaluateContextConditions(NEW_CONDITIONS, {}, makeEvent(EVENT_2940982_PAYLOAD), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, true);
});

test('NEW conditions pass event 2940885 — the polite ask fires the rule', async () => {
  const pass = await evaluateContextConditions(NEW_CONDITIONS, {}, makeEvent(EVENT_2940885_PAYLOAD), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, true);
});

test('NEW conditions still pass the urgent variant ("call me right now")', async () => {
  const urgent = { ...EVENT_2940982_PAYLOAD, message_text: 'call me right now please', call_purpose: 'urgent' };
  const pass = await evaluateContextConditions(NEW_CONDITIONS, {}, makeEvent(urgent), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, true);
});

// ─── what the widened rule must still refuse ───────────────────────

test('NEW conditions block a non-callback classification', async () => {
  const other = { ...EVENT_2940982_PAYLOAD, recommended_action: 'fast_track_booking' };
  const pass = await evaluateContextConditions(NEW_CONDITIONS, {}, makeEvent(other), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, false);
});

test('NEW conditions block callback_request whose fulfillment is not a phone call', async () => {
  const smsFulfil = { ...EVENT_2940982_PAYLOAD, requested_fulfillment: 'sms_reply' };
  const pass = await evaluateContextConditions(NEW_CONDITIONS, {}, makeEvent(smsFulfil), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, false);
});

test('NEW conditions block when requested_fulfillment is absent (quiet block, not a wildcard pass)', async () => {
  const absent = { ...EVENT_2940982_PAYLOAD };
  delete absent.requested_fulfillment;
  const pass = await evaluateContextConditions(NEW_CONDITIONS, {}, makeEvent(absent), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, false);
});

test('NEW conditions block a stop-bot contact', async () => {
  const pass = await evaluateContextConditions(NEW_CONDITIONS, {}, makeEvent(EVENT_2940982_PAYLOAD, ['stop-bot']), { ruleKey: 'HOT_CALL_IMMEDIATE' });
  assert.equal(pass, false);
});
