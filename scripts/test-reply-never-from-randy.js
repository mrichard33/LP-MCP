/**
 * test-reply-never-from-randy.js — a reply to Randy's broadcast mailbox is
 * never SENT as Randy. 2026-09-02, lGQ0WjsMU2zmoq9MsVJH action 406588: voice
 * was Mark's, sender was Randy's mailbox.
 *
 * Scope, narrowed by Mark the same day: the reroute fires ONLY when the lead
 * wrote to Randy's mailbox. A reply to a rep or to any Reece team mailbox
 * keeps v3.11/v3.14 sender continuity, even when the thread reads as
 * Randy-signed. The classifier drives the voice, never the sender.
 *
 * 2026-09-18 — WIDENED, because the 2026-09-02 fix never fired in production.
 * AGENTIC_RANDY_EMAIL held one address (the send subdomain) while the
 * broadcast went out from the apex domain, so Catherine Crosier's reply left
 * as randy@getreecewindows.com (agent_actions 475065). Randy's mailbox is now
 * a LIST whose defaults always apply, and a send-time net sits underneath the
 * resolver. Note this file previously asserted randy@send.getreecewindows.com
 * was NOT Randy — that assertion is exactly what the incident disproved.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.AGENTIC_REPLY_FROM_EMAIL = 'mark@getreecewindows.com';
process.env.AGENTIC_REPLY_FROM_USER_ID = 'MARK_USER';
// Deliberately set to ONE address that is not the one Randy actually sent
// from — the exact Railway misconfiguration behind the incident. Every default
// must still apply on top of it.
process.env.AGENTIC_RANDY_EMAIL = 'randy@send.getreecewindows.com';

import test from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('../src/send-message-handler.js');
const { resolveEmailSender, isRandyMailbox, enforceNonRandySender } = _internal;

test('every Randy mailbox is Randy — both domains, both subdomains', () => {
  for (const a of [
    'randy@getreecewindows.com',            // the incident address
    'randy@send.getreecewindows.com',
    'randy@reecewindowsmail.com',
    'randy@send.reecewindowsmail.com',
  ]) {
    assert.equal(isRandyMailbox(a), true, a);
  }
});

test('matching is case-insensitive and trims', () => {
  assert.equal(isRandyMailbox('RANDY@GetReeceWindows.com'), true);
  assert.equal(isRandyMailbox('  randy@getreecewindows.com  '), true);
  assert.equal(isRandyMailbox('Randy@Send.ReeceWindowsMail.COM'), true);
});

test('the env var ADDS to the defaults, it never replaces them', () => {
  // AGENTIC_RANDY_EMAIL above names only the send subdomain. The apex address
  // is not in it — and is still Randy. This is the incident, inverted.
  assert.equal(isRandyMailbox('randy@getreecewindows.com'), true);
});

test('no other mailbox is Randy — no prefix match, no domain match', () => {
  for (const a of [
    'randy.reece@reecewindows.com',
    'randycundiff@gmail.com',           // a real lead in the message history
    'brandy@reecewindows.com',
    'mark@getreecewindows.com',
    'mark@send.getreecewindows.com',
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

test('the incident reproduces as a PASS now — every Randy address reroutes', () => {
  for (const to of [
    'randy@getreecewindows.com',
    'randy@send.getreecewindows.com',
    'randy@reecewindowsmail.com',
    'randy@send.reecewindowsmail.com',
    'RANDY@GetReeceWindows.com',
  ]) {
    const s = resolveEmailSender({ inboundTo: to, originatorUserId: '9YNXGEOajzmH9brXcLsy' });
    assert.equal(s.reason, 'randy_thread_rerouted', to);
    assert.equal(s.emailFrom, 'mark@getreecewindows.com', to);
    assert.equal(s.userId, 'MARK_USER', to);
  }
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

// ─── send-time net ───────────────────────────────────────────────────────
// Runs on the address about to go on the wire, whatever produced it. This is
// what catches a resolver miss, a cached originator, or a path nobody has
// written yet. Both send paths (Conversations API and webhook) call it, and
// the ai-fallback send rides the same handler flow through the Conv API path.

test('the net swaps any Randy address out, whatever produced it', () => {
  for (const from of [
    'randy@getreecewindows.com',
    'randy@send.getreecewindows.com',
    'randy@reecewindowsmail.com',
    'randy@send.reecewindowsmail.com',
    'RANDY@GetReeceWindows.com',
  ]) {
    const g = enforceNonRandySender({ emailFrom: from, userId: '9YNXGEOajzmH9brXcLsy' });
    assert.equal(g.emailFrom, 'mark@getreecewindows.com', from);
    assert.equal(g.userId, 'MARK_USER', from);
    assert.equal(g.blocked, from.trim().toLowerCase(), from);
  }
});

test('the net leaves every other sender exactly as it found it', () => {
  for (const from of [
    'mark@getreecewindows.com',
    'contact@reecewindows.com',
    'randycundiff@gmail.com',
    null,
  ]) {
    const g = enforceNonRandySender({ emailFrom: from, userId: 'U1' });
    assert.equal(g.emailFrom, from, String(from));
    assert.equal(g.userId, 'U1', String(from));
    assert.equal(g.blocked, null, String(from));
  }
});

test('the net is idempotent — running it twice changes nothing', () => {
  const once = enforceNonRandySender({ emailFrom: 'randy@getreecewindows.com', userId: 'RANDY_USER' });
  const twice = enforceNonRandySender(once);
  assert.equal(twice.emailFrom, 'mark@getreecewindows.com');
  assert.equal(twice.userId, 'MARK_USER');
  assert.equal(twice.blocked, null);
});

test('the resolver and the net agree — no Randy address survives either', () => {
  for (const to of [
    'randy@getreecewindows.com',
    'randy@send.getreecewindows.com',
    'randy@reecewindowsmail.com',
    'randy@send.reecewindowsmail.com',
  ]) {
    const resolved = resolveEmailSender({ inboundTo: to, originatorUserId: 'RANDY_USER' });
    const guarded = enforceNonRandySender(resolved);
    assert.equal(isRandyMailbox(guarded.emailFrom), false, to);
    assert.equal(guarded.emailFrom, 'mark@getreecewindows.com', to);
  }
});
