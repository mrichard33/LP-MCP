/**
 * bot_outcomes.framework — scripts/test-bot-outcomes-framework.js
 *
 * 2026-10-16 (framework cleanup, Phase 0): booked % and opt-out % are read per
 * framework (nepq / nepq_rehash / logistics / none) to judge the NEPQ-only
 * prompt. frameworkFor() reads the plan each reply was written under; a reply
 * whose action row is unknown is NULL, never a guess, and a failed read leaves
 * the column out of the row so a stored value is never erased.
 *
 * Run: node --test scripts/test-bot-outcomes-framework.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { frameworkFor, computeOutcome, FRAMEWORKS } = await import('../src/bot-feedback/outcomes-core.js');
const { readReplyPlans } = await import('../src/bot-feedback/outcomes.js');

test('the SMS and live-chat plans map to a framework', () => {
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: { nepq_plan: { mode: 'live', step: 'discover', post_demo: false } } }), 'nepq');
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: { nepq_plan: { mode: 'live', step: 'competitor_signed', post_demo: true } } }), 'nepq_rehash');
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: { nepq: { mode: 'live', step: 'offer_slots' } } }), 'nepq');
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: { nepq: { mode: 'live', step: 'cancel_flow' } } }), 'logistics');
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: { cancel_flow: { step: 'ask_identity' }, nepq: null } }), 'logistics');
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: { nepq_plan: { mode: 'shadow', step: 'discover' } } }), 'none');
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: { nepq_plan: null, nepq: null } }), 'none');
  assert.equal(frameworkFor({ messageType: 'nurture', executionResult: undefined }), 'none');
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: undefined }), null, 'unknown action row → null');
  for (const v of ['nepq', 'nepq_rehash', 'logistics', 'none']) assert.ok(FRAMEWORKS.includes(v));
});

test('computeOutcome writes framework only when it was read', () => {
  const context = { message_type: 'reply', message_ref: 7, ghl_contact_id: 'c', sent_at: '2026-10-10T12:00:00Z' };
  assert.equal('framework' in computeOutcome({ context }), false, 'not read → column left alone');
  assert.equal(computeOutcome({ context, framework: 'nepq' }).framework, 'nepq');
  assert.equal(computeOutcome({ context, framework: null }).framework, null);
});

function fakeDb({ rows = [], error = null } = {}) {
  const calls = [];
  return {
    calls,
    from: () => ({ select: (cols) => ({ in: async (col, ids) => { calls.push({ cols, ids }); return error ? { data: null, error } : { data: rows.filter(r => ids.includes(r.id)), error: null }; } }) }),
  };
}

test('readReplyPlans reads only reply action ids and returns null on failure', async () => {
  const db = fakeDb({ rows: [{ id: 5, nepq_plan: { mode: 'live', step: 'discover' }, nepq: null, cancel_flow: null }] });
  const plans = await readReplyPlans([{ message_type: 'reply', message_ref: '5' }, { message_type: 'nurture', message_ref: 'n-1' }, { message_type: 'reply', message_ref: 'x' }], { db });
  assert.deepEqual(db.calls[0].ids, [5]);
  assert.equal(frameworkFor({ messageType: 'reply', executionResult: plans.get('5') }), 'nepq');
  assert.equal(await readReplyPlans([{ message_type: 'reply', message_ref: '5' }], { db: fakeDb({ error: { message: 'boom' } }) }), null);
});
