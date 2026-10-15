/**
 * scripts/test-ai-sender.js
 *
 * A rehash contact's bot message shows in GHL as the AI user, never the rep it
 * is assigned to (src/agentic/ai-sender.js, 2026-10-15). Jeff Clark
 * (ySxZUqvXqSHInFgglEmL): the bot's 10-14 13:31 reply carried no userId, so GHL
 * credited it to John Manieri, the contact's owner.
 *
 * No network: the pure helper, the live-chat body builder, the read-back in
 * send-delivery-verify through its deps seam, and a source check that every
 * Conversations API send path passes opts (two cross-fallback calls dropped
 * them, losing fromNumber and the sender).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

const { aiSenderUserId, sendAsUserFor, senderReadBack } = await import('../src/agentic/ai-sender.js');
const { livechatSendBody } = await import('../src/send-message-handler.js');
const { verifyRecentSends } = await import('../src/services/send-delivery-verify.js');

console.warn = () => {};
console.log = () => {};

const AI = '3K6HtoPyBLWeQrrnSnCD';
const ENV = { AI_SENDER_USER_ID: AI };
// Jeff's tags at 15:04 on 10-14 (the relevant ones).
const JEFF_TAGS = ['agentic-active', 'lp-demo-completed', 'stage:post-appointment', 'rehash', 'pause-workflow', 'active-o.0'];

test('unset AI_SENDER_USER_ID turns the feature off', () => {
  assert.equal(aiSenderUserId({}), null);
  assert.deepEqual(sendAsUserFor({ tags: JEFF_TAGS, env: {} }), { userId: null, reason: 'disabled' });
});

test('a rehash contact sends as the AI user on SMS and live chat', () => {
  assert.deepEqual(sendAsUserFor({ tags: JEFF_TAGS, channel: 'sms', env: ENV }), { userId: AI, reason: 'rehash' });
  assert.deepEqual(sendAsUserFor({ tags: JEFF_TAGS, channel: 'livechat', env: ENV }), { userId: AI, reason: 'rehash' });
  assert.equal(sendAsUserFor({ tags: ['active-f.0'], env: ENV }).userId, AI, 'an F.0 post-demo lead counts');
  assert.equal(sendAsUserFor({ tags: [], fromNumber: '+17278004578', env: ENV }).userId, AI, 'the rehash line counts');
  assert.equal(sendAsUserFor({ tags: [], rehashActive: true, env: ENV }).userId, AI, "the reply writer's own rehash answer counts");
});

test('a non-rehash contact is unchanged', () => {
  assert.deepEqual(sendAsUserFor({ tags: ['agentic-active', 'stage:new-lead'], fromNumber: '+13525550188', env: ENV }), { userId: null, reason: 'not_rehash' });
});

test('email keeps its From: AI user only with an explicit emailFrom', () => {
  assert.deepEqual(sendAsUserFor({ tags: JEFF_TAGS, channel: 'email', emailFrom: 'team@mail.reecewindows.com', env: ENV }), { userId: AI, reason: 'rehash' });
  assert.deepEqual(sendAsUserFor({ tags: JEFF_TAGS, channel: 'email', emailFrom: null, env: ENV }), { userId: null, reason: 'email_no_from' });
});

test('live-chat body carries the userId only when given', () => {
  assert.equal('userId' in livechatSendBody({ contactId: 'c', conversationId: 'v', message: 'hi' }), false);
  assert.equal(livechatSendBody({ contactId: 'c', conversationId: 'v', message: 'hi', userId: AI }).userId, AI);
});

test('read-back: kept, ignored, unknown', () => {
  assert.equal(senderReadBack({ sentAs: AI, message: { userId: AI } }), 'kept');
  assert.equal(senderReadBack({ sentAs: AI, message: { userId: 'TYcZ9DcNkuPCFYsFxRFV' } }), 'ignored');
  assert.equal(senderReadBack({ sentAs: AI, message: {} }), 'unknown');
  assert.equal(senderReadBack({ sentAs: null, message: { userId: AI } }), 'unknown');
});

function verifyHarness({ sentAs, ghlUserId }) {
  const events = [];
  const updates = [];
  const rows = [{ id: 1, target_id: 'ySxZUqvXqSHInFgglEmL', executed_at: '2026-10-15T13:00:00Z', execution_result: { message_id: 'm1', ...(sentAs ? { sent_as_user_id: sentAs } : {}) } }];
  const supabase = {
    from() {
      const q = {
        select: () => q, eq: () => q, gte: () => q, lte: () => q, order: () => q,
        limit: async () => ({ data: rows, error: null }),
        update(patch) { updates.push(patch); const u = { eq: () => u, then: (res) => res({ error: null }) }; return u; },
      };
      return q;
    },
  };
  const deps = {
    supabase,
    ghlFetch: async () => ({ message: { status: 'delivered', userId: ghlUserId } }),
    emitEvent: async (e) => { events.push(e); return { id: 1 }; },
    attemptCarrierResend: async () => ({ queued: false }),
  };
  return { deps, events, updates };
}

test('verify: GHL kept the AI user → no event, readback stamped', async () => {
  const { deps, events, updates } = verifyHarness({ sentAs: AI, ghlUserId: AI });
  await verifyRecentSends(deps);
  assert.equal(events.length, 0);
  assert.equal(updates[0].execution_result.sender_readback, 'kept');
});

test('verify: GHL ignored the userId → one agentic.ai_sender_ignored, row stays completed', async () => {
  const { deps, events, updates } = verifyHarness({ sentAs: AI, ghlUserId: 'TYcZ9DcNkuPCFYsFxRFV' });
  await verifyRecentSends(deps);
  assert.deepEqual(events.map((e) => e.event_type), ['agentic.ai_sender_ignored']);
  assert.equal(updates[0].status, undefined, 'never flips the row');
  assert.equal(updates[0].execution_result.sender_readback, 'ignored');
});

test('verify: a non-rehash send records no readback', async () => {
  const { deps, events, updates } = verifyHarness({ sentAs: null, ghlUserId: 'TYcZ9DcNkuPCFYsFxRFV' });
  await verifyRecentSends(deps);
  assert.equal(events.length, 0);
  assert.equal('sender_readback' in updates[0].execution_result, false);
});

test('every Conversations API send passes opts (fromNumber + the AI sender)', () => {
  const src = readFileSync(new URL('../src/send-message-handler.js', import.meta.url), 'utf8');
  const calls = src.match(/await sendViaConversationsAPI\([^)]*\)/g) || [];
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.match(c, /,\s*opts\)$/, `drops opts: ${c}`);
});
