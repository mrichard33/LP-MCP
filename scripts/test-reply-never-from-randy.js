/**
 * test-reply-never-from-randy.js — a reply to Randy's broadcast mailbox is
 * never SENT as Randy. 2026-09-02, lGQ0WjsMU2zmoq9MsVJH action 406588: voice
 * was Mark's, sender was Randy's mailbox.
 *
 * Scope, narrowed by Mark the same day: the reroute fires ONLY when the lead
 * wrote to Randy's mailbox. A reply to a rep or to any Reece team mailbox
 * keeps v3.11/v3.14 sender continuity, even when the thread reads as
 * Randy-signed. The classifier drives the voice, never the sender.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.AGENTIC_REPLY_FROM_EMAIL = 'mark@getreecewindows.com';
process.env.AGENTIC_REPLY_FROM_USER_ID = 'MARK_USER';

import test from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('../src/send-message-handler.js');
const { resolveEmailSender, isRandyMailbox } = _internal;

test("only Randy's broadcast mailbox is Randy's — exact match, case-insensitive", () => {
  assert.equal(isRandyMailbox('randy@getreecewindows.com'), true);
  assert.equal(isRandyMailbox('RANDY@GetReeceWindows.com'), true);
  assert.equal(isRandyMailbox('  randy@getreecewindows.com  '), true);
});

test('no other mailbox is Randy — no prefix match, no domain match', () => {
  for (const a of [
    'randy@send.getreecewindows.com',   // different mailbox, not configured
    'randy.reece@reecewindows.com',
    'randycundiff@gmail.com',           // a real lead in the message history
    'brandy@reecewindows.com',
    'mark@getreecewindows.com',
    'contact@reecewindows.com',
    'info@reecewindows.com',
    'careers@reecewindows.com',
    'agreements@reecewindows.com',
    'w.needham@reecewindows.com',
    '', null, undefined,
  ]) {
    assert.equal(isRandyMailbox(a), false, String(a));
  }
});

test('reply to Randy → rep mailbox, rep user, originator dropped', () => {
  const s = resolveEmailSender({ inboundTo: 'randy@getreecewindows.com', originatorUserId: 'RANDY_USER' });
  assert.deepEqual(s, { emailFrom: 'mark@getreecewindows.com', userId: 'MARK_USER', reason: 'randy_thread_rerouted' });
});

test('a Randy-SIGNED thread to a team mailbox is NOT rerouted — the address decides', () => {
  const s = resolveEmailSender({ inboundTo: 'contact@reecewindows.com', originatorUserId: 'TEAM_USER' });
  assert.deepEqual(s, { emailFrom: 'contact@reecewindows.com', userId: 'TEAM_USER', reason: 'inbound_mailbox_continuity' });
});

test('the thread-sender classifier has no say over the sender', () => {
  // Passing the old v3.15 verdict must not change the outcome for any mailbox.
  for (const to of ['mark@send.getreecewindows.com', 'contact@reecewindows.com', 'info@reecewindows.com']) {
    const s = resolveEmailSender({ inboundTo: to, originatorUserId: 'U1', threadSenderType: { type: 'randy' } });
    assert.equal(s.reason, 'inbound_mailbox_continuity', to);
    assert.equal(s.emailFrom, to);
    assert.equal(s.userId, 'U1');
  }
});

test('a rep thread keeps v3.11/v3.14 continuity byte-for-byte', () => {
  const s = resolveEmailSender({ inboundTo: 'mark@send.getreecewindows.com', originatorUserId: 'MARK_USER' });
  assert.deepEqual(s, { emailFrom: 'mark@send.getreecewindows.com', userId: 'MARK_USER', reason: 'inbound_mailbox_continuity' });
});

test('nothing known → GHL default, unchanged', () => {
  assert.deepEqual(resolveEmailSender({}), { emailFrom: null, userId: null, reason: 'ghl_default' });
});
