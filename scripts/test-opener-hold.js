/**
 * test-opener-hold.js — the opener race (2026-10-11, Javier r5hMYoAdxhAPmj9U5Mjv).
 *
 * His web-chat "Hi" landed at 20:51:40Z, GHL's welcome SMS at 20:51:49Z, and
 * the bot answered the "Hi" at 20:52:26Z with "thanks for reaching back out".
 * He had replied to nothing. Fixture 38 (Sonya) covers "Hi AFTER the opener";
 * this file covers "Hi BEFORE the opener", the false-acknowledgment guard, the
 * one approved follow-up and the job that sends it.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscipline,
  leadReplyState,
  findFalseReplyAck,
  stripFalseReplyAck,
  buildNoReplyFollowup,
  findRepeatedOpener,
  findBookingAsks,
} from '../src/agentic/discovery-discipline.js';
import { humanizeReply } from '../src/agentic/human-voice.js';
import { decideFollowup, runNoReplyFollowup, enqueueNoReplyFollowup } from '../src/jobs/no-reply-followup.js';
import { classifyReply, sendStateFromRows } from '../src/jobs/reply-sla-watchdog.js';

const WELCOME = 'Hi Javier, thanks for reaching out to Reece Windows & Doors. What are you hoping to get done with your windows or doors?';
const JAVIER = [
  { direction: 'inbound', text: 'Hi', timestamp: '2026-10-11T20:51:40.726Z' },
  { direction: 'outbound', text: WELCOME, timestamp: '2026-10-11T20:51:49.351Z' },
];
const NOW = Date.parse('2026-10-11T20:52:20Z');
const BAD_REPLY = 'Hi Javier, thanks for reaching back out. Is it more how they look, or how they work?';
const APPROVED = "Hi Javier, just making sure our text came through. Is it more about how your windows or doors look, or something that isn't working right?";

// ── 1–4: the reply state ────────────────────────────────────────────────

test('1. Javier: "Hi" before the welcome, no reply since → held', () => {
  const d = buildDiscipline({ triggerMessage: 'Hi', conversation: JAVIER, nowMs: NOW });
  assert.equal(d.version, '1.1');
  assert.equal(d.reply.replied_since_outbound, false);
  assert.equal(d.reply.trigger_predates_opener, true);
  assert.equal(d.reply.opener_ms, Date.parse('2026-10-11T20:51:49.351Z'));
  assert.equal(d.reply.trigger_ms, Date.parse('2026-10-11T20:51:40.726Z'));
});

test('2. the same thread newest-first gives the same answer (timestamps decide, not order)', () => {
  const d = buildDiscipline({ triggerMessage: 'Hi', conversation: [...JAVIER].reverse(), nowMs: NOW });
  assert.equal(d.reply.replied_since_outbound, false);
  assert.equal(d.reply.trigger_predates_opener, true);
});

test('3. Sonya (fixture 38): "Hi" AFTER the welcome is a real reply', () => {
  const conv = [
    { direction: 'outbound', text: 'Hi Sonya, thanks for reaching out. What are you hoping to get done with your windows or doors?', timestamp: '2026-09-02T15:29:40Z' },
    { direction: 'inbound', text: 'Hi', timestamp: '2026-09-02T15:30:00Z' },
  ];
  const d = buildDiscipline({ triggerMessage: 'Hi', conversation: conv, nowMs: Date.parse('2026-09-02T15:30:05Z') });
  assert.equal(d.reply.replied_since_outbound, true);
  assert.equal(d.reply.trigger_predates_opener, false);
});

test('4. no timestamps anywhere → unknown, and the hold fails open', () => {
  const conv = JAVIER.map(({ direction, text }) => ({ direction, text }));
  const d = buildDiscipline({ triggerMessage: 'Hi', conversation: conv, nowMs: NOW });
  assert.equal(d.reply.replied_since_outbound, null);
  assert.equal(d.reply.trigger_predates_opener, false);
  assert.deepEqual(findFalseReplyAck(BAD_REPLY, d.reply), []);
});

test('a GHL activity row after the lead\'s reply does not read as our unanswered message', () => {
  const conv = [
    { direction: 'outbound', text: WELCOME, timestamp: '2026-10-11T20:51:49Z' },
    { direction: 'inbound', text: 'New windows', timestamp: '2026-10-11T20:52:00Z' },
    { direction: 'outbound', text: 'Opportunity created', timestamp: '2026-10-11T20:52:05Z', messageType: 'TYPE_ACTIVITY_OPPORTUNITY' },
  ];
  assert.equal(leadReplyState({ conversation: conv, triggerMessage: 'New windows' }).replied_since_outbound, true);
});

test('a second message after the welcome releases the hold', () => {
  const conv = [...JAVIER, { direction: 'inbound', text: 'Hi', timestamp: '2026-10-11T20:52:10Z' }];
  const d = buildDiscipline({ triggerMessage: 'Hi', conversation: conv, nowMs: NOW });
  assert.equal(d.reply.trigger_predates_opener, false);
});

// ── 5–6: the false-acknowledgment guard ─────────────────────────────────

test('5. the guard fires only when the lead has not replied', () => {
  assert.equal(findFalseReplyAck(BAD_REPLY, { replied_since_outbound: false }).length, 1);
  assert.deepEqual(findFalseReplyAck(BAD_REPLY, { replied_since_outbound: true }), []);
  assert.deepEqual(findFalseReplyAck(BAD_REPLY, { replied_since_outbound: null }), []);
  assert.equal(findFalseReplyAck(BAD_REPLY, { replied_since_outbound: true, trigger_predates_opener: true }).length, 1);
  for (const s of ['Thanks for getting back to me.', 'Thank you for your reply.', 'Great to hear back from you.', 'Thanks so much for writing back.']) {
    assert.equal(findFalseReplyAck(s, { replied_since_outbound: false }).length, 1, s);
  }
  assert.deepEqual(findFalseReplyAck('Thanks for reaching out. Which room is it?', { replied_since_outbound: false }), []);
});

test('6. the deterministic strip keeps the greeting and the question', () => {
  assert.equal(stripFalseReplyAck(BAD_REPLY), 'Hi Javier. Is it more how they look, or how they work?');
  assert.equal(stripFalseReplyAck('Thanks for getting back to me.'), '');
});

// ── 7–8: the approved follow-up ─────────────────────────────────────────

test('7. the follow-up is the approved copy, verbatim', () => {
  assert.equal(buildNoReplyFollowup('javier'), APPROVED);
  assert.ok(buildNoReplyFollowup('').startsWith('Hi there,'));
  assert.ok(buildNoReplyFollowup(null).startsWith('Hi there,'));
});

test('8. the copy passes every voice and discipline check', () => {
  const copy = buildNoReplyFollowup('Javier');
  assert.ok(!copy.includes('!'));
  assert.ok(!copy.includes('—'));
  assert.equal((copy.match(/\?/g) || []).length, 1);
  assert.deepEqual(findRepeatedOpener(copy, WELCOME), []);
  assert.deepEqual(findBookingAsks(copy), []);
  assert.deepEqual(humanizeReply(copy).changes, []);
});

// ── the job's decision ──────────────────────────────────────────────────

const ROW = { id: 1, ghl_contact_id: 'r5hMYoAdxhAPmj9U5Mjv', opener_message_at: '2026-10-11T20:51:49.351Z', due_at: '2026-10-11T21:01:49.351Z', status: 'pending' };
const DUE = Date.parse('2026-10-11T21:02:00Z');
const OK_TAGS = ['agentic-active'];

test('job: a quiet lead gets the follow-up', () => {
  const d = decideFollowup({ row: ROW, conversation: JAVIER, tags: OK_TAGS, nowMs: DUE, firstName: 'Javier' });
  assert.equal(d.action, 'send');
  assert.equal(d.text, APPROVED);
});

test('job: skip reasons', () => {
  const replied = [...JAVIER, { direction: 'inbound', text: 'Doors', timestamp: '2026-10-11T20:55:00Z' }];
  assert.equal(decideFollowup({ row: ROW, conversation: replied, tags: OK_TAGS, nowMs: DUE }).reason, 'lead_replied');
  const sent = [...JAVIER, { direction: 'outbound', text: 'Hi, Ana from Reece here.', timestamp: '2026-10-11T20:55:00Z' }];
  assert.equal(decideFollowup({ row: ROW, conversation: sent, tags: OK_TAGS, nowMs: DUE }).reason, 'we_sent_since');
  assert.equal(decideFollowup({ row: ROW, conversation: JAVIER, tags: ['agentic-active', 'stop-bot'], nowMs: DUE }).reason, 'dnd_or_opt_out');
  assert.equal(decideFollowup({ row: ROW, conversation: JAVIER, tags: ['agentic-active', 'dnc-sms'], nowMs: DUE }).reason, 'dnd_or_opt_out');
  assert.equal(decideFollowup({ row: ROW, conversation: JAVIER, tags: ['agentic-active', 'suppress-outbound'], nowMs: DUE }).reason, 'suppressed');
  assert.equal(decideFollowup({ row: ROW, conversation: JAVIER, tags: OK_TAGS, appointment: { appointment_id: 'a1' }, nowMs: DUE }).reason, 'booked');
});

test('job: quiet hours move the follow-up, never drop it', () => {
  const d = decideFollowup({ row: ROW, conversation: JAVIER, tags: OK_TAGS, nowMs: DUE, inQuietHours: true, nextWindowIso: '2026-10-12T12:00:00.000Z' });
  assert.deepEqual([d.action, d.due_at], ['defer', '2026-10-12T12:00:00.000Z']);
});

test('job: an unreadable thread waits, then gives up an hour past due', () => {
  assert.equal(decideFollowup({ row: ROW, conversation: null, tags: OK_TAGS, nowMs: DUE }).action, 'wait');
  assert.equal(decideFollowup({ row: ROW, conversation: JAVIER, tags: null, nowMs: DUE }).action, 'wait');
  assert.equal(decideFollowup({ row: ROW, conversation: null, tags: null, nowMs: DUE + 2 * 3600_000 }).reason, 'unreadable');
});

// ── the job's I/O, through the deps seam ────────────────────────────────

function fakeDb(rows) {
  const state = { rows: rows.map(r => ({ ...r })), updates: [] };
  const table = () => {
    const q = { filters: [], patch: null };
    const api = {
      select() { return api; },
      update(patch) { q.patch = patch; return api; },
      eq(k, v) { q.filters.push([k, v]); return api; },
      lte() { return api; },
      order() { return api; },
      limit() { return api; },
      then(resolve) {
        const hit = state.rows.filter(r => q.filters.every(([k, v]) => r[k] === v));
        if (q.patch) { hit.forEach(r => Object.assign(r, q.patch)); state.updates.push(q.patch); }
        resolve({ data: hit.map(r => ({ ...r })), error: null });
      },
    };
    return api;
  };
  return { from: table, state };
}

test('job: does nothing unless OPENER_HOLD_MODE=live', async () => {
  const r = await runNoReplyFollowup({ mode: 'shadow' });
  assert.equal(r.skipped, true);
});

test('job: live sends once and records the send', async () => {
  const db = fakeDb([ROW]);
  const sent = [];
  const r = await runNoReplyFollowup({
    mode: 'live', supabase: db, now: () => DUE,
    readContact: async () => ({ conversation: JAVIER, tags: OK_TAGS, firstName: 'Javier', appointment: null }),
    queueSend: async (row, text) => { sent.push(text); return 991; },
    inQuietHours: () => false,
  });
  assert.equal(r.sent, 1);
  assert.deepEqual(sent, [APPROVED]);
  assert.equal(db.state.rows[0].status, 'sent');
  assert.equal(db.state.rows[0].sent_message_id, '991');
  // A second pass finds nothing pending: one follow-up per welcome text.
  const again = await runNoReplyFollowup({ mode: 'live', supabase: db, now: () => DUE, readContact: async () => { throw new Error('should not read'); }, queueSend: async () => { throw new Error('should not send'); } });
  assert.equal(again.sent, 0);
});

test('enqueue: shadow row, due 10 minutes after the welcome; a missing table never throws', async () => {
  let upserted = null;
  const events = [];
  const db = { from: () => ({ upsert(row) { upserted = row; return { select: async () => ({ data: [{ id: 1 }], error: null }) }; } }) };
  const d = buildDiscipline({ triggerMessage: 'Hi', conversation: JAVIER, nowMs: NOW });
  const r = await enqueueNoReplyFollowup({ contactId: 'r5hMYoAdxhAPmj9U5Mjv', discipline: d, mode: 'shadow' }, { supabase: db, emitEvent: async (e) => { events.push(e); return { id: 1 }; } });
  assert.equal(r.queued, true);
  assert.equal(upserted.status, 'shadow');
  assert.equal(upserted.due_at, '2026-10-11T21:01:49.351Z');
  assert.equal(events[0].event_type, 'opener_hold');

  const missing = { from: () => ({ upsert() { return { select: async () => ({ data: null, error: { code: '42P01', message: 'relation "agentic_no_reply_followups" does not exist' } }) }; } }) };
  const r2 = await enqueueNoReplyFollowup({ contactId: 'x', discipline: d, mode: 'live' }, { supabase: missing, emitEvent: async () => null });
  assert.equal(r2.queued, false);
});

// ── the reply SLA watchdog leaves a held reply alone ────────────────────

test('reply SLA: a reply held by the opener race is deliberate silence, never paged', () => {
  const state = sendStateFromRows([{ status: 'skipped', error_message: 'opener_hold', created_at: '2026-10-11T20:52:20Z' }], { now: DUE, inFlightMs: 120000 });
  assert.equal(state.hasHeldSend, true);
  assert.equal(classifyReply({ actionTaken: 'x', tags: OK_TAGS, ...state }), 'silenced');
  const other = sendStateFromRows([{ status: 'skipped', error_message: 'outbound_lock_held', created_at: '2026-10-11T20:52:20Z' }], { now: DUE, inFlightMs: 120000 });
  assert.equal(classifyReply({ actionTaken: 'x', tags: OK_TAGS, ...other }), 'unanswered');
});
