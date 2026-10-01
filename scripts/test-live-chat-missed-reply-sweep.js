/**
 * Guards for the live chat missed-reply sweep (2026-10-01): the visitor's
 * phone number got no reply because GHL merged the guest contact into an
 * existing one and never sent us the message.
 *
 * Run: node --test scripts/test-live-chat-missed-reply-sweep.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { planMissedReplies, phoneFromText, sweepMessageKey } = await import('../src/live-chat/missed-replies.js');
const { runLiveChatMissedReplySweep, sweepMode } = await import('../src/jobs/live-chat-missed-reply-sweep.js');

const GUEST = 'rqdJd7kNmqAiupY6jGHM';
const MERGED = 'hZOcPk6XmMvWVvjZJ7mz';
const CONV = '9mseX9uT7DoEZ6ncnwwu';
const at = (hms) => `2026-10-01T${hms}Z`;

// The real rows and mirror messages from the ljloa chat (20:01–20:09Z).
const ROWS = [
  { target_id: GUEST, conversation_id: CONV, created_at: at('20:01:07') },
  { target_id: GUEST, conversation_id: CONV, created_at: at('20:02:18') },
  { target_id: GUEST, conversation_id: CONV, created_at: at('20:03:15') },
  { target_id: GUEST, conversation_id: CONV, created_at: at('20:06:21') },
];
const MSGS = [
  { ghl_message_id: 'SrHq', ghl_conversation_id: CONV, ghl_contact_id: MERGED, body: 'Hi there! Do you service my area?', sent_at: at('20:01:04') },
  { ghl_message_id: 'Htqk', ghl_conversation_id: CONV, ghl_contact_id: MERGED, body: '27101', sent_at: at('20:02:05') },
  { ghl_message_id: 'TTdp', ghl_conversation_id: CONV, ghl_contact_id: MERGED, body: 'Yes, how much?', sent_at: at('20:06:18') },
  { ghl_message_id: 'pL5I', ghl_conversation_id: CONV, ghl_contact_id: MERGED, body: '9543792151', sent_at: at('20:06:50') },
];

test('the phone-number message is the one missed; answered ones are left alone', () => {
  const plan = planMissedReplies({ rows: ROWS, messages: MSGS, nowMs: Date.parse(at('20:07:40')) });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].message.ghl_message_id, 'pL5I');
  assert.deepEqual(plan[0].contactCandidates, [MERGED, GUEST]);
  assert.deepEqual(plan[0].rowContacts, [GUEST]);
});

test('too fresh to call missed: the webhook may still be answering it', () => {
  assert.equal(planMissedReplies({ rows: ROWS, messages: MSGS, nowMs: Date.parse(at('20:07:10')) }).length, 0);
});

test('a reply after it — in any conversation for the merged contact — means answered', () => {
  const rows = [...ROWS, { target_id: MERGED, conversation_id: 'conv-merged', created_at: at('20:09:06') }];
  assert.equal(planMissedReplies({ rows, messages: MSGS, nowMs: Date.parse(at('20:10:00')) }).length, 0);
});

test('messages from before the lane answered this chat are never swept', () => {
  const old = [{ ghl_message_id: 'old', ghl_conversation_id: CONV, ghl_contact_id: GUEST, body: 'hello from yesterday', sent_at: at('19:50:00') }];
  assert.equal(planMissedReplies({ rows: ROWS, messages: old, nowMs: Date.parse(at('20:07:40')) }).length, 0);
});

test('phoneFromText / sweepMessageKey', () => {
  assert.equal(phoneFromText('9543792151'), '9543792151');
  assert.equal(phoneFromText('call me at (954) 379-2151 please'), '9543792151');
  assert.equal(phoneFromText('27101'), null);
  assert.equal(sweepMessageKey('pL5I'), 'livechat_sweep_pL5I');
});

function deps({ contacts = {}, phoneHit = null } = {}) {
  const state = { inbound: [], ops: [], fetched: [] };
  return {
    state,
    d: {
      runSQL: async () => ROWS,
      hlRunSQL: async () => MSGS,
      fetchContact: async (id) => { state.fetched.push(id); if (contacts[id]) return contacts[id]; throw new Error('Contact not found'); },
      searchByPhone: async () => phoneHit,
      lane: { processInbound: async (inbound) => { state.inbound.push(inbound); return { outcome: 'sent' }; } },
      opsAlert: async (t) => { state.ops.push(t); },
      log: { log() {}, warn() {} },
      _alerted: new Set(),
    },
  };
}
const ENV = { LIVE_CHAT_FAST_LANE_MODE: 'live' };
const NOW = Date.parse(at('20:07:40'));

test('the merged contact gets the reply, in its own conversation (looked up by the lane)', async () => {
  const { state, d } = deps({ contacts: { [MERGED]: { id: MERGED } } });
  const out = await runLiveChatMissedReplySweep({ env: ENV, nowMs: NOW, deps: d });
  assert.equal(out.redriven, 1);
  assert.deepEqual(state.inbound, [{ contactId: MERGED, conversationId: null, messageId: 'livechat_sweep_pL5I', body: '9543792151', dateAdded: at('20:06:50') }]);
});

test('the mirror still names the deleted guest: found by the phone in the message', async () => {
  const { state, d } = deps({ phoneHit: { id: MERGED } });
  await runLiveChatMissedReplySweep({ env: ENV, nowMs: NOW, deps: d });
  assert.equal(state.inbound[0].contactId, MERGED);
});

test('nobody to reply to: one ops line, once', async () => {
  const { state, d } = deps();
  await runLiveChatMissedReplySweep({ env: ENV, nowMs: NOW, deps: d });
  await runLiveChatMissedReplySweep({ env: ENV, nowMs: NOW, deps: d });
  assert.equal(state.inbound.length, 0);
  assert.equal(state.ops.length, 1);
  assert.match(state.ops[0], /A person needs to answer this chat/);
});

test('off when the lane is off or the sweep is switched off', async () => {
  assert.deepEqual(await runLiveChatMissedReplySweep({ env: { LIVE_CHAT_FAST_LANE_MODE: 'off' }, deps: {} }), { skipped: true });
  assert.deepEqual(await runLiveChatMissedReplySweep({ env: { ...ENV, LIVE_CHAT_MISSED_SWEEP_MODE: 'off' }, deps: {} }), { skipped: true });
  assert.equal(sweepMode({}), 'on');
});
