/**
 * test-fail-closed-conditions.js — Phase 5 of the 2026-07-03 rebuild
 * (pipeline-integrity breach: rules fired as wildcards when the data their
 * conditions referenced was absent or unreadable).
 *
 * Exercises the no-I/O paths of evaluateContextConditions via the _internal
 * test surface: absent numeric intelligence, unknown condition operators,
 * and absent payload fields must all evaluate FALSE (suppress the rule),
 * never pass. DB/GHL-backed conditions (lp_disposition_in, tag reads) are
 * covered by code paths that fail closed on lookup errors — verified in
 * review; they need live fixtures to unit-test and are exercised post-deploy
 * via rule.condition_failed_closed events.
 *
 * Also locks in inferChannelFromEvent's livechat mapping (channel flip fix).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { _internal } = await import('../src/decision-engine.js');
const { evaluateContextConditions, inferChannelFromEvent } = _internal;

const bareEvent = (payload = {}) => ({ id: 1, ghl_contact_id: 'c-test', payload });

// ── fail-closed on absent data ──────────────────────────────────────

test('buyer_stage_gte with NO buyer_stage anywhere → false (was: 0-coerced wildcard on lte)', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_gte: 3 }, {}, bareEvent()), false);
});

test('buyer_stage_lte with NO buyer_stage → false (the old 0 ≤ N wildcard pass)', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_lte: 3 }, {}, bareEvent()), false);
});

test('lead_score_lte with NO lead_score → false', async () => {
  assert.equal(await evaluateContextConditions({ lead_score_lte: 50 }, {}, bareEvent()), false);
});

test('days_in_stage_gte with NO days_in_current_stage → false', async () => {
  assert.equal(await evaluateContextConditions({ days_in_stage_gte: 2 }, {}, bareEvent()), false);
});

test('unknown condition operator → false (was: warn + wildcard pass)', async () => {
  assert.equal(await evaluateContextConditions({ lp_dispositon_in_typo: ['Set'] }, {}, bareEvent()), false);
});

test('payload_message_not_matches with NO message_text → false (text blocklist cannot pass unseen)', async () => {
  assert.equal(await evaluateContextConditions({ payload_message_not_matches: 'stop' }, {}, bareEvent()), false);
});

// ── data present still evaluates normally ───────────────────────────

test('buyer_stage present and satisfying → true', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_gte: 3 }, { buyer_stage: 4 }, bareEvent()), true);
});

test('buyer_stage present and failing → false', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_gte: 3 }, { buyer_stage: 2 }, bareEvent()), false);
});

test('payload field conditions still work when data is present', async () => {
  assert.equal(await evaluateContextConditions({ payload_field_not_null: 'message_id' }, {}, bareEvent({ message_id: 'abc' })), true);
  assert.equal(await evaluateContextConditions({ payload_field_not_null: 'message_id' }, {}, bareEvent({ message_id: null })), false);
  assert.equal(await evaluateContextConditions({ payload_message_not_matches: 'stop' }, {}, bareEvent({ message_text: 'hello there' })), true);
  assert.equal(await evaluateContextConditions({ payload_message_not_matches: 'stop' }, {}, bareEvent({ message_text: 'please stop' })), false);
});

test('empty/absent conditions object → true (unconditional rule unchanged)', async () => {
  assert.equal(await evaluateContextConditions(null, {}, bareEvent()), true);
  assert.equal(await evaluateContextConditions({}, {}, bareEvent()), true);
});

// ── livechat channel inference (channel-flip fix) ───────────────────

test('inferChannelFromEvent: TYPE_LIVE_CHAT → livechat (was: null → sms at send time)', () => {
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_LIVE_CHAT' } }), 'livechat');
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_WEBCHAT' } }), 'livechat');
  assert.equal(inferChannelFromEvent({ payload: { channel: 'livechat' } }), 'livechat');
});

test('inferChannelFromEvent: sms/email unchanged', () => {
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_SMS' } }), 'sms');
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_EMAIL' } }), 'email');
  assert.equal(inferChannelFromEvent({ payload: { channel: 'sms' } }), 'sms');
  assert.equal(inferChannelFromEvent({ payload: {} }), null);
});
