/**
 * scripts/test-chat-return-lead.js
 *
 * The user, 2026-10-19: a lead in our system more than 15 days old who talks
 * to the website chatbot is sent back to LP with Reece ChatBot as the new
 * source. Pure rules (src/chat-return-lead.js) and the pass
 * (src/jobs/chat-return-lead-sweep.js) with every read and write stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatReturnMode, buildChatEngagementsSql, selectChats, leadStatusBlock, decideChat, seenKey, sentKey, clearNote, CHATBOT_LP_SOURCE,
} from '../src/chat-return-lead.js';
import { runChatReturnLeadSweep } from '../src/jobs/chat-return-lead-sweep.js';

const NOW = Date.parse('2026-10-19T18:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const chat = (id, { agoMin = 90, channels = 'sms' } = {}) => ({ ghl_contact_id: id, chat_started_at: iso(NOW - (agoMin + 10) * 60_000), last_chat_at: iso(NOW - agoMin * 60_000), channels });
const contact = (id, { addedDaysAgo = 60, phone = `352555${String(id).replace(/\D/g, '').padStart(4, '0')}`, tags = [] } = {}) =>
  ({ ghl_contact_id: id, first_name: 'Pat', last_name: 'Lee', phone, date_added: iso(NOW - addedDaysAgo * DAY), tags });

test('the chatbot source is SubSource 830 / Promoter 5574', () => {
  assert.equal(CHATBOT_LP_SOURCE.srsId, '830');
  assert.equal(CHATBOT_LP_SOURCE.proId, '5574');
});

test('mode: live by default (the user\'s ruling), shadow and off on request', () => {
  assert.equal(chatReturnMode({}), 'live');
  assert.equal(chatReturnMode({ CHAT_RETURN_LP_MODE: 'shadow' }), 'shadow');
  assert.equal(chatReturnMode({ CHAT_RETURN_LP_MODE: 'off' }), 'off');
});

test('engagement read counts website chats AND the SMS bot\'s answers to the lead\'s own text (2026-10-19)', () => {
  const sql = buildChatEngagementsSql({ sinceIso: iso(NOW - DAY), quietBeforeIso: iso(NOW - 3_600_000) });
  assert.match(sql, /rule_applied = 'LIVE_CHAT_FAST_LANE'/);
  assert.match(sql, /action_payload->>'channel' = 'sms'/);
  assert.match(sql, /event_type IN \('ai\.analysis_completed','agentic\.reply_unanswered'\)/, 'an answer to an inbound text, not a bot-started send');
  assert.match(sql, /NOT LIKE 'DQ\\_%'/, 'a disqualification reply never counts');
  assert.match(sql, /NOT IN \('POST_BOOKING_EMAIL_ASK'\)/);
  assert.match(sql, /status = 'completed'/);
});

test('selectChats: only contacts added 15+ days before the chat, with a phone, no opt-out, no rehash', () => {
  const contacts = new Map([
    ['c1', contact('c1')],
    ['c2', contact('c2', { addedDaysAgo: 5 })],
    ['c3', contact('c3', { phone: '' })],
    ['c4', contact('c4', { tags: ['DNC'] })],
    ['c5', contact('c5', { tags: ['rehash'] })],
  ]);
  const { check, skipped } = selectChats(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => chat(id)), { contacts, sentRecently: new Set(), seen: new Set(), recentCreate: new Set() });
  assert.deepEqual(check.map((r) => r.ghl_contact_id), ['c1']);
  assert.equal(skipped.new_contact, 1);
  assert.equal(skipped.no_phone, 1);
  assert.equal(skipped.excluded, 1);
  assert.equal(skipped.rehash, 1);
  assert.equal(skipped.no_contact, 1);
});

test('selectChats: sent recently, already decided, or sent by another path → not checked', () => {
  const contacts = new Map(['a', 'b', 'c'].map((id, i) => [id, contact(id, { phone: `35255501${i}0` })]));
  const chats = ['a', 'b', 'c'].map((id) => chat(id));
  const { check, skipped } = selectChats(chats, {
    contacts, sentRecently: new Set(['a']), seen: new Set([seenKey('b', chats[1].last_chat_at)]), recentCreate: new Set(['c']),
  });
  assert.equal(check.length, 0);
  assert.equal(skipped.already_sent, 1);
  assert.equal(skipped.already_decided, 1);
  assert.equal(skipped.sent_elsewhere, 1);
});

test('leadStatusBlock: a customer, a live visit, a recent demo', () => {
  const opts = { nowMs: NOW, todayEt: '2026-10-19' };
  assert.equal(leadStatusBlock([{ closed_won: true }], opts), 'customer');
  assert.equal(leadStatusBlock([{ disposition_code: 'Sale' }], opts), 'customer');
  assert.equal(leadStatusBlock([{ disposition_code: 'Set', appointment_date: '2026-10-22' }], opts), 'live_appointment');
  assert.equal(leadStatusBlock([{ disposition_code: 'Set', appointment_date: '2026-08-01' }], opts), null, 'a visit long past is not live');
  assert.equal(leadStatusBlock([{ disposition_code: 'OPPFDN', demo_date: iso(NOW - 20 * DAY) }], opts), 'rehash');
  assert.equal(leadStatusBlock([{ disposition_code: 'OPPFDN', demo_date: iso(NOW - 90 * DAY) }], opts), null, 'rehash ends at 30 days');
  assert.equal(leadStatusBlock([{ disposition_code: 'CXL', created_at_lp: iso(NOW - 60 * DAY) }], opts), null);
});

test('decideChat: old lead or none → send; recent lead → skip; could not tell → retry', () => {
  assert.deepEqual(decideChat({ match: { verdict: 'create_returning', why: 'old' } }), { decision: 'send', reason: 'old', returning: true });
  assert.equal(decideChat({ match: { verdict: 'create' } }).decision, 'send');
  assert.equal(decideChat({ match: { verdict: 'reuse' } }).reason, 'recent_lead');
  assert.equal(decideChat({ match: { verdict: 'unverified' } }).decision, 'retry');
  assert.equal(decideChat({ match: { verdict: 'create_returning' }, statusBlock: 'customer' }).decision, 'skip');
});

test('the clear note names Reece ChatBot as the new source', () => {
  assert.match(clearNote('512345', { prospect_id: '4401', at: '2026-08-01' }), /Reece ChatBot \(830 \/ 5574\)/);
});

// --- the pass ---------------------------------------------------------------

function stub({ chats = [chat('c1')], contacts = [contact('c1')], verdict = 'create_returning', leads = [], marks = [], stampOk = true, clearOk = true, ghlFails = false } = {}) {
  const calls = { stamp: [], clear: [], enroll: [], marks: [], match: [] };
  const supabase = {
    from() {
      const q = {
        _keys: [],
        select() { return q; },
        in(_c, keys) { q._keys = keys; return q; },
        gte() { return q; },
        then(res) { return Promise.resolve({ data: q._keys.filter((k) => marks.includes(k)).map((k) => ({ dedup_key: k })), error: null }).then(res); },
        upsert: async (row) => { calls.marks.push(row.dedup_key); return { error: null }; },
      };
      return q;
    },
  };
  return {
    calls,
    deps: {
      runSQL: async (sql) => {
        if (/LIVE_CHAT_FAST_LANE/.test(sql)) return chats;
        if (/create_lp_lead/.test(sql)) return [];
        if (/FROM lp_leads/.test(sql)) return leads;
        throw new Error(`unexpected sql ${sql.slice(0, 40)}`);
      },
      hlRunSQL: async () => contacts,
      supabase,
      ghlFetch: async () => { if (ghlFails) throw new Error('GHL 503'); return { contact: { customFields: [{ id: 'GmAVmW6V9sekD7pVONKr', value: '512345' }] } }; },
      matchLead: async (p) => { calls.match.push(p); return { verdict, lead: { lead_id: '512345' }, why: 'returning' }; },
      stampSource: async (id) => { calls.stamp.push(id); return { ok: stampOk, detail: 'x' }; },
      clearLeadId: async (id) => { calls.clear.push(id); return { ok: clearOk, detail: 'x' }; },
      enroll: async ({ contactId, notify, calendarName }) => { assert.equal(notify, false); assert.match(calendarName, /^Chatbot \(sms\)/); calls.enroll.push(contactId); return { success: true, action: 'enrolled_lead_creation_workflow' }; },
    },
  };
}

test('live: a returning lead is stamped Reece ChatBot, its old LP Lead ID cleared, then enrolled, then marked', async () => {
  const { deps, calls } = stub();
  const r = await runChatReturnLeadSweep({ env: {}, nowMs: NOW, deps });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.sent, 1);
  assert.deepEqual(calls.stamp, ['c1']);
  assert.deepEqual(calls.clear, ['c1']);
  assert.deepEqual(calls.enroll, ['c1']);
  assert.equal(calls.match[0].ghlLeadId, '512345');
  assert.ok(calls.marks.includes(sentKey('c1')));
  assert.ok(calls.marks.includes(seenKey('c1', chat('c1').last_chat_at)));
});

test('live: a stamp that does not land sends nothing', async () => {
  const { deps, calls } = stub({ stampOk: false });
  const r = await runChatReturnLeadSweep({ env: {}, nowMs: NOW, deps });
  assert.equal(r.failed, 1);
  assert.equal(calls.enroll.length, 0);
  assert.equal(calls.marks.length, 0, 'nothing marked: the next pass tries again');
});

test('live: an old LP Lead ID that will not clear sends nothing', async () => {
  const { deps, calls } = stub({ clearOk: false });
  await runChatReturnLeadSweep({ env: {}, nowMs: NOW, deps });
  assert.equal(calls.enroll.length, 0);
});

test('live: a lead from the last 15 days is the person\'s lead: nothing sent, chat marked decided', async () => {
  const { deps, calls } = stub({ verdict: 'reuse' });
  const r = await runChatReturnLeadSweep({ env: {}, nowMs: NOW, deps });
  assert.equal(r.sent, 0);
  assert.equal(calls.stamp.length, 0);
  assert.deepEqual(calls.marks, [seenKey('c1', chat('c1').last_chat_at)]);
  assert.equal(r.by_reason.recent_lead, 1);
});

test('live: a sold customer chatting is never a new lead', async () => {
  const { deps, calls } = stub({ leads: [{ phone10: '3525550001', closed_won: true }] });
  const r = await runChatReturnLeadSweep({ env: {}, nowMs: NOW, deps });
  assert.equal(calls.enroll.length, 0);
  assert.equal(r.by_reason.customer, 1);
});

test('live: a failed GHL read decides nothing and marks nothing', async () => {
  const { deps, calls } = stub({ ghlFails: true });
  const r = await runChatReturnLeadSweep({ env: {}, nowMs: NOW, deps });
  assert.equal(calls.enroll.length, 0);
  assert.equal(calls.marks.length, 0);
  assert.equal(r.by_reason['GHL 503'], 1);
});

test('shadow: decides, writes nothing', async () => {
  const { deps, calls } = stub();
  const r = await runChatReturnLeadSweep({ env: { CHAT_RETURN_LP_MODE: 'shadow' }, nowMs: NOW, deps });
  assert.equal(r.would_send, 1);
  assert.equal(calls.stamp.length + calls.clear.length + calls.enroll.length + calls.marks.length, 0);
});

test('off: does nothing', async () => {
  const { deps, calls } = stub();
  const r = await runChatReturnLeadSweep({ env: { CHAT_RETURN_LP_MODE: 'off' }, nowMs: NOW, deps });
  assert.equal(r.skipped, true);
  assert.equal(calls.enroll.length, 0);
});
