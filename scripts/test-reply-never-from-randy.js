/**
 * test-reply-never-from-randy.js — a reply to a Randy-signed email is never
 * SENT as Randy. 2026-09-02, lGQ0WjsMU2zmoq9MsVJH action 406588: voice was
 * Mark's, sender was Randy's mailbox.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.AGENTIC_REPLY_FROM_EMAIL = 'mark@getreecewindows.com';
process.env.AGENTIC_REPLY_FROM_USER_ID = 'MARK_USER';
process.env.AGENTIC_NEVER_REPLY_FROM = 'founder@reecewindows.com';

import test from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('../src/send-message-handler.js');
const { resolveEmailSender, isRandyMailbox } = _internal;

test('Randy mailboxes are recognized by local part and by deny list', () => {
  for (const a of ['randy@getreecewindows.com', 'Randy@send.getreecewindows.com', 'randy.reece@reecewindows.com', 'randy_r@x.com', 'founder@reecewindows.com']) {
    assert.equal(isRandyMailbox(a), true, a);
  }
  for (const a of ['mark@getreecewindows.com', 'randyfan@gmail.com', 'brandy@reecewindows.com', '', null]) {
    assert.equal(isRandyMailbox(a), false, String(a));
  }
});

test('reply to a Randy broadcast → rep mailbox, rep user, originator dropped', () => {
  const s = resolveEmailSender({ inboundTo: 'randy@getreecewindows.com', originatorUserId: 'RANDY_USER', threadSenderType: { type: 'randy', name: 'Randy' } });
  assert.deepEqual(s, { emailFrom: 'mark@getreecewindows.com', userId: 'MARK_USER', reason: 'randy_thread_rerouted' });
});

test('either signal alone is enough', () => {
  assert.equal(resolveEmailSender({ inboundTo: 'randy@getreecewindows.com', originatorUserId: 'RANDY_USER' }).reason, 'randy_thread_rerouted');
  assert.equal(resolveEmailSender({ inboundTo: 'team@getreecewindows.com', originatorUserId: 'RANDY_USER', threadSenderType: { type: 'randy' } }).reason, 'randy_thread_rerouted');
});

test('a rep thread keeps v3.11/v3.14 continuity byte-for-byte', () => {
  const s = resolveEmailSender({ inboundTo: 'mark@send.getreecewindows.com', originatorUserId: 'MARK_USER', threadSenderType: { type: 'person', name: 'Mark' } });
  assert.deepEqual(s, { emailFrom: 'mark@send.getreecewindows.com', userId: 'MARK_USER', reason: 'inbound_mailbox_continuity' });
});

test('a company-signed thread from a non-Randy mailbox keeps continuity', () => {
  const s = resolveEmailSender({ inboundTo: 'team@getreecewindows.com', originatorUserId: 'TEAM_USER', threadSenderType: { type: 'company' } });
  assert.equal(s.reason, 'inbound_mailbox_continuity');
  assert.equal(s.emailFrom, 'team@getreecewindows.com');
});

test('nothing known → GHL default, unchanged', () => {
  assert.deepEqual(resolveEmailSender({}), { emailFrom: null, userId: null, reason: 'ghl_default' });
});
