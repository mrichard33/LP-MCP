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
  const reply = { id: 3336354, ghl_contact_id: 'gpPQYhCsqdGy10wU14Rp', created_at: '2026-09-02T14:31:10Z', action_taken: 'combined_into_reply_buffer (n=1)', payload: { message_text: "I'm not going to bother with the windows for now. Thank you" } };
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
