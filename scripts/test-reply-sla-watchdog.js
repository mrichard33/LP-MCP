/**
 * test-reply-sla-watchdog.js — a reply the bot owns with no completed send
 * past the SLA is flagged; deliberate silence, non-agentic contacts, consent
 * blocks and unreadable snapshots are NOT.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, slaReason, runReplySlaWatchdog } from '../src/jobs/reply-sla-watchdog.js';

test('answered wins over everything', () => {
  assert.equal(classifyReply({ actionTaken: 'combined_into_reply_buffer (n=1)', tags: ['agentic-active'], hasCompletedSend: true }), 'answered');
});

test('deliberate silence is never flagged', () => {
  assert.equal(classifyReply({ actionTaken: 'bot_silenced: stop_bot', tags: ['agentic-active'], hasCompletedSend: false }), 'silenced');
  assert.equal(classifyReply({ actionTaken: 'skipped: dedup', tags: ['agentic-active'], hasCompletedSend: false }), 'silenced');
});

test('ownership + consent gates mirror the always-respond policy', () => {
  assert.equal(classifyReply({ actionTaken: 'x', tags: ['lp-inbound'], hasCompletedSend: false }), 'not_agentic');
  assert.equal(classifyReply({ actionTaken: 'x', tags: ['agentic-active', 'stop-bot'], hasCompletedSend: false }), 'consent_blocked');
  assert.equal(classifyReply({ actionTaken: 'x', tags: ['agentic-active', 'DNC-SMS'], hasCompletedSend: false }), 'consent_blocked');
  // operational suppressors do NOT block a direct reply → still unanswered
  assert.equal(classifyReply({ actionTaken: 'x', tags: ['agentic-active', 'suppress-outbound', 'cooling-active'], hasCompletedSend: false }), 'unanswered');
});

test('unreadable snapshot is unknown, not unanswered ("I could not tell" must not page)', () => {
  assert.equal(classifyReply({ actionTaken: 'x', tags: null, hasCompletedSend: false }), 'unknown');
});

test('shadow and live emit different reasons', () => {
  assert.equal(slaReason('shadow'), 'no_send_within_sla_shadow');
  assert.equal(slaReason('live'), 'no_send_within_sla');
});

test('end-to-end: one unanswered reply → one idempotent emit', async () => {
  const NOW = Date.parse('2026-09-02T15:00:00Z');
  const reply = { id: 3336354, ghl_contact_id: 'gpPQYhCsqdGy10wU14Rp', created_at: '2026-09-02T14:31:10Z', action_taken: 'combined_into_reply_buffer (n=1)', payload: { message_text: "I'm not going to bother with the windows for now. Thank you", channel: 'sms' } };
  const emitted = [];
  const chain = (rows) => {
    const q = { eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: async () => ({ data: rows, error: null }), maybeSingle: async () => ({ data: rows[0] || null, error: null }) };
    return { select: () => q };
  };
  const db = { from: (t) => t === 'system_events' ? chain([reply]) : t === 'agent_actions' ? chain([]) : chain([{ tags: ['agentic-active'] }]) };
  const res = await runReplySlaWatchdog({ supabase: db, emitEvent: async (e) => { emitted.push(e); return { id: 1 }; }, now: () => NOW, mode: 'shadow' });
  assert.equal(res.unanswered, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event_type, 'agentic.reply_unanswered');
  assert.equal(emitted[0].payload.reason, 'no_send_within_sla_shadow');
  assert.equal(emitted[0].idempotency_key, 'reply_sla_3336354');
  assert.equal(emitted[0].bypass_filter, true);
});

// 2026-09-21 — the self-heal rules (AGENTIC_REPLY_SLA_*) read these three off
// the payload. message_preview alone could not drive payload_message_matches:
// it truncates at 100 chars, so an opt-out further into a long message is
// invisible to the regex. inbound_at is what lets the recovery reply skip
// itself when a rep (or the re-analysis) already answered.
test('the payload carries full message_text, channel and inbound_at', async () => {
  const NOW = Date.parse('2026-09-02T15:00:00Z');
  const long = 'Thanks for reaching out. '.repeat(6) + 'Please take me off your list.';
  const reply = {
    id: 3336355, ghl_contact_id: 'gpPQYhCsqdGy10wU14Rp', created_at: '2026-09-02T14:31:10Z',
    action_taken: 'combined_into_reply_buffer (n=1)',
    payload: { message_text: long, channel: 'sms' },
  };
  const emitted = [];
  const chain = (rows) => {
    const q = { eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: async () => ({ data: rows, error: null }), maybeSingle: async () => ({ data: rows[0] || null, error: null }) };
    return { select: () => q };
  };
  const db = { from: (t) => t === 'system_events' ? chain([reply]) : t === 'agent_actions' ? chain([]) : chain([{ tags: ['agentic-active'] }]) };
  await runReplySlaWatchdog({ supabase: db, emitEvent: async (e) => { emitted.push(e); return { id: 1 }; }, now: () => NOW, mode: 'shadow' });

  const p = emitted[0].payload;
  assert.equal(p.message_text, long, 'the whole message must survive, not the 100-char preview');
  assert.ok(!p.message_preview.includes('take me off'), 'the preview truncates — that is the point');
  assert.ok(p.message_text.includes('take me off'), 'the opt-out must be visible to payload_message_matches');
  assert.equal(p.channel, 'sms');
  assert.equal(p.inbound_at, '2026-09-02T14:31:10Z');
  assert.equal(p.message_preview.length, 100, 'message_preview stays as it was for existing consumers');
});

test('message_text is capped at 1000 chars so the payload stays a payload', async () => {
  const NOW = Date.parse('2026-09-02T15:00:00Z');
  const reply = {
    id: 3336356, ghl_contact_id: 'c1', created_at: '2026-09-02T14:31:10Z',
    action_taken: 'combined_into_reply_buffer (n=1)', payload: { message_text: 'x'.repeat(5000) },
  };
  const emitted = [];
  const chain = (rows) => {
    const q = { eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: async () => ({ data: rows, error: null }), maybeSingle: async () => ({ data: rows[0] || null, error: null }) };
    return { select: () => q };
  };
  const db = { from: (t) => t === 'system_events' ? chain([reply]) : t === 'agent_actions' ? chain([]) : chain([{ tags: ['agentic-active'] }]) };
  await runReplySlaWatchdog({ supabase: db, emitEvent: async (e) => { emitted.push(e); return { id: 1 }; }, now: () => NOW, mode: 'shadow' });
  assert.equal(emitted[0].payload.message_text.length, 1000);
});

test('a missing channel is null, not the string "undefined"', async () => {
  const NOW = Date.parse('2026-09-02T15:00:00Z');
  const reply = {
    id: 3336357, ghl_contact_id: 'c1', created_at: '2026-09-02T14:31:10Z',
    action_taken: 'combined_into_reply_buffer (n=1)', payload: { message_text: 'hi' },
  };
  const emitted = [];
  const chain = (rows) => {
    const q = { eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: async () => ({ data: rows, error: null }), maybeSingle: async () => ({ data: rows[0] || null, error: null }) };
    return { select: () => q };
  };
  const db = { from: (t) => t === 'system_events' ? chain([reply]) : t === 'agent_actions' ? chain([]) : chain([{ tags: ['agentic-active'] }]) };
  await runReplySlaWatchdog({ supabase: db, emitEvent: async (e) => { emitted.push(e); return { id: 1 }; }, now: () => NOW, mode: 'shadow' });
  assert.equal(emitted[0].payload.channel, null);
});

// 2026-10-19 (Thomas Geary, 10/12): an email held 6–15 minutes on purpose is in
// flight, never "customer waiting".
test('a held email row 10 minutes old is in flight, not unanswered', async () => {
  const { sendStateFromRows } = await import('../src/jobs/reply-sla-watchdog.js');
  const now = Date.parse('2026-10-12T14:43:00Z');
  const created = '2026-10-12T14:33:19Z';
  const ready = '2026-10-12T14:46:30Z';
  const held = [{ status: 'pending', created_at: created, error_message: 'deferred: email_min_delay', retry_at: ready, email_ready_at: ready }];
  const st = sendStateFromRows(held, { now, inFlightMs: 180_000 });
  assert.equal(st.hasInFlightSend, true);
  assert.equal(classifyReply({ actionTaken: null, tags: ['agentic-active'], ...st }), 'in_flight');
  // Just claimed at the ready time and being written: still in flight.
  const writing = [{ status: 'executing', created_at: created, email_ready_at: ready }];
  assert.equal(sendStateFromRows(writing, { now: Date.parse(ready) + 60_000, inFlightMs: 180_000 }).hasInFlightSend, true);
  // Long past its ready time: stuck, the backstop pages.
  assert.equal(sendStateFromRows(writing, { now: Date.parse(ready) + 600_000, inFlightMs: 180_000 }).hasInFlightSend, false);
  // A row held for something else keeps the old clock.
  const other = [{ status: 'pending', created_at: created, error_message: 'deferred: agentic_cooldown', retry_at: ready }];
  assert.equal(sendStateFromRows(other, { now, inFlightMs: 180_000 }).hasInFlightSend, false);
});
