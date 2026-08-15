/**
 * test-recovery-verification.js — the duplicate-risk guard must not drop replies.
 *
 * On a retry, executeSendMessage asks "did my previous attempt already
 * deliver?" so it cannot double-send. That guard had two opposite failure
 * modes, and BOTH ended with the lead getting nothing:
 *
 *   Fails closed — an unreadable GHL response threw, which increments
 *   retry_count; at max_retries the action was marked `failed` and the reply
 *   was dropped. Seen in production: action 313767.
 *
 *   Fails open — `landed` was true for ANY outbound since action.created_at.
 *   On a deferred action that window is hours, so an unrelated nurture email
 *   or a rep's manual reply satisfied it and the action completed as
 *   `verified_already_sent` without ever sending. Worse than the first,
 *   because it looks like success.
 *
 * The authoritative duplicate check is the Supabase sent marker
 * (acquireAgenticSlot → 'already_sent'), which runs BEFORE this handler. This
 * guard is a second net for the narrow delivered-but-marker-never-written
 * race, so it can afford to be lenient rather than drop replies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { classifyPriorSend, recoveryAnchorMs } =
  await import('../src/send-message-handler.js');

const T = (iso) => Date.parse(iso);
const ANCHOR = T('2026-08-14T12:00:00Z');

const out = (iso, extra = {}) => ({ direction: 'outbound', dateAdded: iso, ...extra });
const inb = (iso, extra = {}) => ({ direction: 'inbound', dateAdded: iso, ...extra });

// ── recoveryAnchorMs — anchor to the PRIOR ATTEMPT, not queue time ──

test('anchors to executed_at (the prior attempt) when present', () => {
  const action = { created_at: '2026-08-14T02:00:00Z', executed_at: '2026-08-14T12:00:00Z' };
  assert.equal(recoveryAnchorMs(action), T('2026-08-14T12:00:00Z'));
});

test('falls back to created_at on the first attempt', () => {
  assert.equal(
    recoveryAnchorMs({ created_at: '2026-08-14T02:00:00Z' }),
    T('2026-08-14T02:00:00Z')
  );
});

test('unparseable timestamps produce NaN so the caller bails to unverifiable', () => {
  assert.ok(Number.isNaN(recoveryAnchorMs({ created_at: 'nonsense' })));
  assert.ok(Number.isNaN(recoveryAnchorMs({})));
  assert.ok(Number.isNaN(recoveryAnchorMs(null)));
});

// ── the fails-open bug: unrelated traffic must not read as "my send" ──

test('an outbound BEFORE the anchor is not my send', () => {
  // The 313767 shape: action queued 02:09, deferred, retried at 12:00. A
  // nurture that went out at 03:00 must NOT count as "my reply landed".
  const messages = [out('2026-08-14T03:00:00Z')];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }), 'not_landed');
});

test('an outbound after the anchor on the SAME channel is my send', () => {
  const messages = [out('2026-08-14T12:00:30Z', { messageType: 'TYPE_EMAIL' })];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }), 'landed');
});

test('an outbound on a DIFFERENT channel does not satisfy the send', () => {
  // An SMS must never mark a pending email send as delivered.
  const messages = [out('2026-08-14T12:00:30Z', { messageType: 'TYPE_SMS' })];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }), 'not_landed');
});

test('inbound messages never count, whatever the timing', () => {
  const messages = [inb('2026-08-14T12:05:00Z', { messageType: 'TYPE_EMAIL' })];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }), 'not_landed');
});

test('exactly at the anchor counts (>=, not >)', () => {
  const messages = [out('2026-08-14T12:00:00Z', { messageType: 'TYPE_EMAIL' })];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }), 'landed');
});

// ── channel leniency where we genuinely don't know ──────────────────

test('no requested channel → time-only match (pre-existing behavior)', () => {
  const messages = [out('2026-08-14T12:00:30Z', { messageType: 'TYPE_SMS' })];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: null }), 'landed');
});

test('a message whose channel is unreadable does not get vetoed', () => {
  // Fail toward "landed" on an unknown message channel: suppressing a possible
  // duplicate is safer than re-sending one.
  const messages = [out('2026-08-14T12:00:30Z')]; // no messageType/type
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }), 'landed');
});

test('livechat matches livechat', () => {
  const messages = [out('2026-08-14T12:00:30Z', { messageType: 'TYPE_LIVE_CHAT' })];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'livechat' }), 'landed');
});

// ── unverifiable — the input shapes that used to throw and drop ─────

test('empty / missing / malformed message list → unverifiable', () => {
  for (const messages of [[], null, undefined, 'not-an-array', {}]) {
    assert.equal(
      classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }),
      'unverifiable',
      `expected unverifiable for ${JSON.stringify(messages)}`
    );
  }
});

test('an unparseable anchor → unverifiable, never a false landed', () => {
  const messages = [out('2026-08-14T12:00:30Z')];
  for (const since of [NaN, undefined, null]) {
    assert.equal(classifyPriorSend({ messages, since, channel: 'email' }), 'unverifiable');
  }
});

test('no args at all → unverifiable', () => {
  assert.equal(classifyPriorSend(), 'unverifiable');
});

// ── messages that are only inbound still read as not_landed ─────────

test('a conversation with only inbound traffic is not_landed, not unverifiable', () => {
  // We CAN see the conversation; there is simply no outbound. That is a real
  // answer, and it must proceed to send rather than defer.
  const messages = [inb('2026-08-14T12:01:00Z'), inb('2026-08-14T12:02:00Z')];
  assert.equal(classifyPriorSend({ messages, since: ANCHOR, channel: 'email' }), 'not_landed');
});
