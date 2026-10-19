/**
 * A post-demo decline gets one reply, never an O.0 drip beside it
 * (Mark, 2026-10-19; Thomas Geary, agent_actions 573250 / 573270).
 *
 * The context condition not_post_demo_decline on BEHAVIORAL_PRICE_OBJECTION
 * (ai.analysis_completed, text on the payload) and OBJECTION_ROUTE_POST_DEMO
 * (intent.objection_detected, empty payload: the latest inbound is read).
 *
 * Run: node --test scripts/test-post-demo-decline-no-o0.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { _internal } = await import('../src/decision-engine.js');
const { evaluateContextConditions } = _internal;
const { isPostDemoDecline } = await import('../src/agentic/post-demo-email.js');

const THOMAS = 'We will not be investing 25 % of\\npurchased value when the market value will not justify the cost.';
const COND = { not_post_demo_decline: true };

// A chainable system_events read. `rows` null = the read fails.
function fakeDb(rows) {
  const calls = [];
  const q = {
    select() { return q; }, eq(k, v) { calls.push([k, v]); return q; }, lte() { return q; }, gte() { return q; },
    order() { return q; },
    limit() { return Promise.resolve(rows === null ? { data: null, error: { message: 'boom' } } : { data: rows, error: null }); },
  };
  return { from: (t) => { calls.push(['from', t]); return q; }, calls };
}

const evt = (type, payload, tags) => {
  const e = { id: 9, event_type: type, ghl_contact_id: 'aueIFUNV3UeZpATu51hc', created_at: '2026-10-12T14:33:47Z', payload };
  if (tags !== undefined) e._contactSnapshot = tags === null ? null : { tags, source: 'test' };
  return e;
};
const opts = (db) => ({ ruleKey: 'TEST', deps: { supabase: db, emitEvent: async () => ({}) } });

test('pure: a post-demo lead plus a firm decline', () => {
  assert.equal(isPostDemoDecline({ tags: ['rehash'], text: THOMAS }), true);
  assert.equal(isPostDemoDecline({ tags: ['lp-demo-completed'], text: 'Not interested.' }), true);
  assert.equal(isPostDemoDecline({ tags: [], text: THOMAS }), false, 'not post-demo');
  assert.equal(isPostDemoDecline({ tags: ['rehash'], text: 'The price is more than we hoped.' }), false, 'a price objection, not a decline');
  assert.equal(isPostDemoDecline({ tags: ['rehash'], text: "We won't be investing until spring." }), false, 'a deferral');
});

test('BEHAVIORAL_PRICE_OBJECTION: the analysis payload text blocks O.0', async () => {
  const db = fakeDb([]);
  assert.equal(await evaluateContextConditions(COND, {}, evt('ai.analysis_completed', { message_text: THOMAS }, ['rehash']), opts(db)), false);
  assert.equal(db.calls.length, 0, 'the payload text is used, no read');
  assert.equal(await evaluateContextConditions(COND, {}, evt('ai.analysis_completed', { message_text: 'Too pricey for us right now' }, ['rehash']), opts(db)), true);
});

test('OBJECTION_ROUTE_POST_DEMO: an empty payload reads the latest inbound', async () => {
  const db = fakeDb([{ payload: { message_text: THOMAS }, created_at: '2026-10-12T14:32:31Z' }]);
  assert.equal(await evaluateContextConditions(COND, {}, evt('intent.objection_detected', {}, ['rehash', 'active-f.0']), opts(db)), false);
  assert.ok(db.calls.some(c => c[0] === 'event_type' && c[1] === 'ghl.reply_received'));
});

test('not post-demo, or no inbound to read: the rule goes on', async () => {
  assert.equal(await evaluateContextConditions(COND, {}, evt('intent.objection_detected', {}, ['stage:new-lead']), opts(fakeDb([{ payload: { message_text: THOMAS } }]))), true);
  assert.equal(await evaluateContextConditions(COND, {}, evt('intent.objection_detected', {}, ['rehash']), opts(fakeDb([]))), true);
});

test('fail closed: a failed inbound read or unreadable tags suppress the rule', async () => {
  assert.equal(await evaluateContextConditions(COND, {}, evt('intent.objection_detected', {}, ['rehash']), opts(fakeDb(null))), false);
  assert.equal(await evaluateContextConditions(COND, {}, evt('ai.analysis_completed', { message_text: THOMAS }, null), opts(fakeDb([]))), false);
});

test('no contact: not applicable (suppressed, nothing read)', async () => {
  const db = fakeDb([]);
  const e = { id: 9, event_type: 'intent.objection_detected', payload: {} };
  assert.equal(await evaluateContextConditions(COND, {}, e, opts(db)), false);
  assert.equal(db.calls.length, 0);
});
