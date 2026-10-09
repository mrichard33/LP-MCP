/**
 * A DNC lift removes only a DNC-made stop-bot — scripts/test-stop-bot-origin.js
 *
 * 2026-10-08 (the user): rule 14 adds stop-bot on an LP DNC, and every lift
 * removed it, including a stop-bot a person, the hard-DQ stop, an LP-note DQ
 * or Bot Review had put there. src/consent/stop-bot-origin.js.
 *
 * Run: node --test scripts/test-stop-bot-origin.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  stopBotRemovableByLift, filterLiftRemoval, isDncLiftRemoval, botOffTag, hasBotOffTag, readStopBotAdds,
} = await import('../src/consent/stop-bot-origin.js');

const LIFT = { rule_applied: 'SLACK_DNC_LIFT', action_payload: { tags: ['dnc', 'stop-bot', 'lp-dnc'], bypass_suppression: true } };
const DNC_ADD = { rule: 'LP_DISP_DNC', at: '2026-09-01T10:00:00Z' };

test('a lift removes a stop-bot the LP DNC put there', () => {
  const r = filterLiftRemoval(LIFT, ['dnc', 'stop-bot', 'lp-dnc'], { currentTags: ['dnc', 'stop-bot'], adds: [DNC_ADD] });
  assert.equal(r.kept, false);
  assert.deepEqual(r.tags, ['dnc', 'stop-bot', 'lp-dnc']);
});

test('a lift keeps a stop-bot with a bot-off reason, and still removes the DNC tags', () => {
  for (const reason of ['dq', 'lp-note', 'review']) {
    const r = filterLiftRemoval(LIFT, ['dnc', 'stop-bot', 'lp-dnc'], { currentTags: ['dnc', 'stop-bot', botOffTag(reason)], adds: [DNC_ADD] });
    assert.equal(r.kept, true, reason);
    assert.deepEqual(r.tags, ['dnc', 'lp-dnc']);
    assert.equal(r.reason, 'bot_off_reason_tag');
  }
});

test('a lift keeps a stop-bot added after the DNC by something else', () => {
  const adds = [DNC_ADD, { rule: 'DQ_HARD_STOP', at: '2026-10-01T10:00:00Z' }];
  assert.equal(stopBotRemovableByLift({ tags: ['stop-bot'], adds }).removable, false);
  // …but the DNC's own later add wins over an older non-DNC one.
  assert.equal(stopBotRemovableByLift({ tags: ['stop-bot'], adds: [{ rule: 'OPS_MANUAL_STOP_BOT', at: '2026-06-04T00:00:00Z' }, DNC_ADD] }).removable, true);
});

test('a stop-bot with no record (a person added it in GHL) stays; a failed read stays', () => {
  assert.deepEqual(stopBotRemovableByLift({ tags: ['stop-bot'], adds: [] }), { removable: false, reason: 'no_dnc_origin_on_record' });
  assert.deepEqual(stopBotRemovableByLift({ tags: ['stop-bot'], adds: null }), { removable: false, reason: 'origin_unreadable' });
});

test('only a lift is filtered; any other removal is untouched', () => {
  assert.equal(isDncLiftRemoval({ rule_applied: 'DNC_LIFT_ON_REENGAGEMENT_LP', action_payload: { tag: 'stop-bot' } }), true);
  assert.equal(isDncLiftRemoval({ rule_applied: 'CONSENT_RENEWAL_ON_REENTRY', action_payload: {} }), true);
  assert.equal(isDncLiftRemoval({ rule_applied: 'BOT_REVIEW_RESUME', action_payload: { tag: 'stop-bot' } }), false);
  const plain = filterLiftRemoval({ rule_applied: 'MANUAL' }, ['stop-bot'], { currentTags: ['stop-bot', 'bot-off:dq'], adds: [] });
  assert.equal(plain.kept, false);
  assert.deepEqual(plain.tags, ['stop-bot']);
});

test('bot-off tags are recognised however they are cased', () => {
  assert.equal(botOffTag('LP note'), 'bot-off:lp-note');
  assert.equal(hasBotOffTag(['Bot-Off:DQ']), true);
  assert.equal(hasBotOffTag(['stop-bot']), false);
});

test('readStopBotAdds reads add_tag rows and dq_hard_stop rows that added stop-bot', async () => {
  const rows = [
    { action_type: 'add_tag', rule_applied: 'LP_DISP_DNC', action_payload: { tag: 'stop-bot' }, executed_at: '2026-09-01T10:00:00Z' },
    { action_type: 'add_tag', rule_applied: 'X', action_payload: { tag: 'lp-dnc' }, executed_at: '2026-09-01T10:00:00Z' },
    { action_type: 'dq_hard_stop', rule_applied: 'DQ_HARD_STOP', action_payload: {}, execution_result: { added_tags: ['stop-bot', 'bot-off:dq'] }, executed_at: '2026-10-01T10:00:00Z' },
  ];
  const q = { select() { return q; }, eq() { return q; }, in() { return q; }, order() { return q; }, limit: async () => ({ data: rows, error: null }) };
  const adds = await readStopBotAdds('c1', { supabase: { from: () => q } });
  assert.deepEqual(adds.map(a => a.rule), ['LP_DISP_DNC', 'DQ_HARD_STOP']);
  const bad = { select() { return bad; }, eq() { return bad; }, in() { return bad; }, order() { return bad; }, limit: async () => ({ data: null, error: { message: 'down' } }) };
  assert.equal(await readStopBotAdds('c1', { supabase: { from: () => bad } }), null);
});
