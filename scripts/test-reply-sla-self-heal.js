/**
 * test-reply-sla-self-heal.js — the missed-reply self-heal (2026-09-21)
 *
 * agentic.reply_unanswered has been emitted live since 2026-09-02 with no
 * consumer: 22 misses across 18 contacts in one week. Mayra
 * (qM5QYwn5ISZ8DQOgFJpX) texted "no longer interested" on 9/18, the analyzer
 * returned ai.analysis_failed twice, nothing routed — so S5.2 emailed her on
 * 9/19, texted on 9/20, and Five9 kept dialing.
 *
 * The design decision the tests pin: RE-ANALYZE FIRST. A successful
 * re-analysis emits ai.analysis_completed and the normal rules (exits, DNC,
 * not-interested) own the outcome exactly as they would have. The generic
 * recovery reply is the fallback for when that changes nothing.
 *
 * Covers reanalyze_reply and the two params the recovery send depends on:
 *   not_before_seconds            — creates the window a rep can answer in
 *   skip_if_answered_since_inbound — uses it
 *
 * Offline and pure: every I/O seam is injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';

const { executeReanalyzeReply } = await import('../src/actions/handlers/reanalyze-reply.js');

const REPLY_EVENT = {
  id: 3701188,
  event_type: 'ghl.reply_received',
  ghl_contact_id: 'qM5QYwn5ISZ8DQOgFJpX',
  payload: {
    message_text: 'I am no longer interested, please take me off your list',
    channel: 'sms',
    message_id: 'syn-mayra-0918',
  },
};

const mockDb = (row, error = null) => ({
  from() {
    const api = {
      select() { return api; },
      eq() { return api; },
      async maybeSingle() { return { data: row, error }; },
    };
    return api;
  },
});

const action = (payload = {}) => ({
  id: 991, action_type: 'reanalyze_reply', target_id: 'qM5QYwn5ISZ8DQOgFJpX',
  action_payload: { source_event_id: REPLY_EVENT.id, ...payload },
});

// ── 1. the happy path — one attempt, real arguments ──────────────────

test('re-analyzes the ORIGINAL reply and hands the analyzer the source event id', async () => {
  const calls = [];
  const res = await executeReanalyzeReply(action(), {}, {
    supabase: mockDb(REPLY_EVENT),
    analyzeMessage: async (...args) => { calls.push(args); return { buyer_stage: 1, recommended_action: 'exit_not_interested' }; },
  });

  assert.equal(calls.length, 1, 'ONE attempt — the analyzer already failed on this message once');
  const [contactId, text, eventId, channel, messageId] = calls[0];
  assert.equal(contactId, 'qM5QYwn5ISZ8DQOgFJpX');
  assert.equal(text, REPLY_EVENT.payload.message_text, 'the analyzer sees what the person sent, not the watchdog preview');
  // The HTTP path passes null here, which is why the 9/18 failures were hard
  // to trace back to a message — ai.analysis_failed carries source_event_id.
  assert.equal(eventId, REPLY_EVENT.id, 'a second failure must still be traceable to this reply');
  assert.equal(channel, 'sms');
  assert.equal(messageId, 'syn-mayra-0918');

  assert.equal(res.reanalyzed, true);
  assert.equal(res.recommended_action, 'exit_not_interested');
});

// ── 2. a second failure is NOT an error ──────────────────────────────

test('analysis failing again reports it without throwing', async () => {
  // Throwing would leave the action retrying and spending LLM budget on
  // whatever made it fail, while the recovery and opt-out rules behind it
  // wait. Those rules are the whole point of the self-heal.
  const res = await executeReanalyzeReply(action(), {}, {
    supabase: mockDb(REPLY_EVENT),
    analyzeMessage: async () => null,
  });
  assert.equal(res.reanalyzed, false);
  assert.equal(res.reason, 'analysis_failed_again');
  assert.ok(!res.skipped, 'not a skip — the attempt genuinely happened');
});

test('a terminal analyzer skip is reported as a skip so nothing retries', async () => {
  const res = await executeReanalyzeReply(action(), {}, {
    supabase: mockDb(REPLY_EVENT),
    analyzeMessage: async () => ({ skipped: true, terminal: true, reason: 'stop_bot' }),
  });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'analyzer_stop_bot');
});

// ── 3. bad input fails loudly, missing data skips quietly ────────────

test('a missing source_event_id throws — the action cannot do its job', async () => {
  await assert.rejects(
    () => executeReanalyzeReply({ id: 1, action_payload: {} }, {}, { supabase: mockDb(null) }),
    /requires action_payload.source_event_id/,
  );
});

test('source_event_id may arrive from the event context instead of the payload', async () => {
  const res = await executeReanalyzeReply(
    { id: 1, target_id: 'c1', action_payload: {} },
    { source_event_id: REPLY_EVENT.id },
    { supabase: mockDb(REPLY_EVENT), analyzeMessage: async () => ({ buyer_stage: 2 }) },
  );
  assert.equal(res.reanalyzed, true);
});

test('a read failure throws so the executor retries', async () => {
  await assert.rejects(
    () => executeReanalyzeReply(action(), {}, { supabase: mockDb(null, { message: 'timeout' }) }),
    /could not read event/,
  );
});

test('a vanished source event skips rather than throwing forever', async () => {
  const res = await executeReanalyzeReply(action(), {}, { supabase: mockDb(null) });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'source_event_not_found');
});

test('an event with no message text skips — there is nothing to analyze', async () => {
  const res = await executeReanalyzeReply(action(), {}, {
    supabase: mockDb({ ...REPLY_EVENT, payload: { channel: 'sms' } }),
    analyzeMessage: async () => { throw new Error('must not be called'); },
  });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'source_event_has_no_message_text');
});

// 2026-09-24 — the live rule row carries the unrendered template
// "{{source_event_id}}". Every live re-analysis failed on it (4/4) because the
// literal string beat the event payload's real id in the ?? chain.
test('an unrendered {{source_event_id}} falls back to the event payload id', async () => {
  const calls = [];
  const res = await executeReanalyzeReply(
    action({ source_event_id: '{{source_event_id}}' }),
    { source_event_id: REPLY_EVENT.id },
    {
      supabase: mockDb(REPLY_EVENT),
      analyzeMessage: async (...args) => { calls.push(args); return { buyer_stage: 1, recommended_action: 'continue_current' }; },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], REPLY_EVENT.id);
  assert.equal(res.reanalyzed, true);
});

test('an unrendered placeholder with no fallback still fails loudly, not with a bad DB read', async () => {
  await assert.rejects(
    executeReanalyzeReply(action({ source_event_id: '{{source_event_id}}' }), {}, { supabase: mockDb(REPLY_EVENT) }),
    /requires action_payload\.source_event_id/,
  );
});

// ── 4. the action is registered and context-aware ────────────────────

test('reanalyze_reply is wired into the executor and gets the event payload', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  assert.equal(typeof ACTION_HANDLERS.reanalyze_reply, 'function',
    'an unregistered action_type fails as "Unknown action type" at execution, silently killing the self-heal');
});

// ── 5. not_before_seconds — the window a rep can answer in ───────────

const { decideNotBefore } = await import('../src/actions/index.js');

const queued = (createdAt, seconds) => ({
  id: 1, action_type: 'send_message', created_at: createdAt,
  action_payload: seconds === undefined ? {} : { not_before_seconds: seconds },
});

const T0 = '2026-09-21T12:00:00.000Z';
const t0 = Date.parse(T0);

test('an action without not_before_seconds is never held', () => {
  assert.equal(decideNotBefore(queued(T0), t0).retry_at, null, 'absent param');
  assert.equal(decideNotBefore(queued(T0, 0), t0).retry_at, null, 'explicit 0');
  assert.equal(decideNotBefore(queued(T0, 'abc'), t0).retry_at, null, 'junk value');
  assert.equal(decideNotBefore(queued(T0, -5), t0).retry_at, null, 'negative');
});

test('a fresh action is held until created_at + N', () => {
  const d = decideNotBefore(queued(T0, 180), t0 + 10_000);
  assert.equal(d.retry_at, '2026-09-21T12:03:00.000Z');
  assert.equal(d.seconds, 180);
});

test('the deadline is measured from created_at, not from now', () => {
  // This is the whole correctness question. A now-based check pushes the
  // deadline forward on every sweep and never converges — the action would
  // be deferred forever and the recovery reply would never send.
  const d = decideNotBefore(queued(T0, 180), t0 + 600_000); // queued 10 min ago
  assert.equal(d.retry_at, null, 'already past its window — must run NOW, not wait another 180s');
});

test('exactly at the deadline it runs', () => {
  assert.equal(decideNotBefore(queued(T0, 180), t0 + 180_000).retry_at, null);
});

test('a row with no created_at runs and says so, rather than deferring forever', () => {
  const d = decideNotBefore({ id: 1, action_payload: { not_before_seconds: 180 } }, t0);
  assert.equal(d.retry_at, null);
  assert.match(d.warn, /no created_at/);
});

test('an unparseable created_at runs and says so', () => {
  const d = decideNotBefore(queued('not-a-date', 180), t0);
  assert.equal(d.retry_at, null);
  assert.match(d.warn, /unparseable/);
});

// ── 6. skip_if_answered_since_inbound ────────────────────────────────

const { findAnswerSinceInbound } = await import('../src/send-message-handler.js');

const INBOUND_AT = '2026-09-18T21:00:00.000Z';
const inboundMs = Date.parse(INBOUND_AT);
const msg = (direction, at) => ({ direction, dateAdded: at, body: 'x' });

test('an outbound after the inbound cancels the recovery reply', () => {
  // A rep answered inside the window. The recovery reply would open with an
  // apology for a silence that no longer exists, on top of their message.
  const found = findAnswerSinceInbound([
    msg('outbound', '2026-09-18T21:02:00.000Z'),
    msg('inbound', INBOUND_AT),
  ], inboundMs);
  assert.ok(found);
  assert.equal(found.dateAdded, '2026-09-18T21:02:00.000Z');
});

test('outbounds that PRE-date the inbound do not count as an answer', () => {
  // The thread is full of what we sent before they replied. Counting those
  // would suppress every recovery reply and silently re-create the bug.
  const found = findAnswerSinceInbound([
    msg('inbound', INBOUND_AT),
    msg('outbound', '2026-09-18T20:55:00.000Z'),
    msg('outbound', '2026-09-17T09:00:00.000Z'),
  ], inboundMs);
  assert.equal(found, null);
});

test('a later INBOUND is not an answer', () => {
  const found = findAnswerSinceInbound([msg('inbound', '2026-09-18T21:05:00.000Z')], inboundMs);
  assert.equal(found, null);
});

test('junk timestamps and a missing thread are handled, not thrown on', () => {
  assert.equal(findAnswerSinceInbound([msg('outbound', 'nonsense')], inboundMs), null);
  assert.equal(findAnswerSinceInbound(null, inboundMs), null);
  assert.equal(findAnswerSinceInbound([msg('outbound', '2026-09-18T21:02:00.000Z')], NaN), null);
});
