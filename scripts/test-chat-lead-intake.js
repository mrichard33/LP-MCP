/**
 * scripts/test-chat-lead-intake.js
 *
 * Offline coverage for the chat lead intake sweep: the pure selection
 * (src/chat-lead-intake.js) and the pass (src/jobs/chat-lead-intake-sweep.js)
 * with every read and the enroll stubbed through deps.
 *
 * What these guard, in order of cost if broken:
 *   - a contact is sent at most once (chat-intake mark, same phone twice),
 *   - an opt-out / delete / suppress tag is never sent,
 *   - a failed read sends nobody,
 *   - shadow enrolls nobody and posts nothing,
 *   - the never-reached-LP monitor stops counting excluded contacts.
 *
 * Run: node --test scripts/test-chat-lead-intake.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isChatContact, selectChatLeads, buildChatCandidatesSql, chatIntakeMode,
  formatChatIntakeCard, markKey, MAX_PER_PASS,
} from '../src/chat-lead-intake.js';
import { runChatLeadIntakeSweep } from '../src/jobs/chat-lead-intake-sweep.js';
import { buildIntakeCandidatesSql, hasExcludedTag } from '../src/lead-intake-gap.js';

const NOW = Date.parse('2026-09-28T16:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

const contact = (id, over = {}) => ({
  ghl_contact_id: id, first_name: 'Pat', last_name: 'Lee',
  phone: `(239) 555-${String(1000 + Number(String(id).replace(/\D/g, '') || 0)).slice(-4)}`,
  source: 'Reece ChatBot', tags: ['entry:chatbot'], date_added: hoursAgo(3), ...over,
});

test('chat contact is recognised by source or tag', () => {
  assert.equal(isChatContact({ source: 'Reece ChatBot' }), true);
  assert.equal(isChatContact({ source: 'chat widget' }), true);
  assert.equal(isChatContact({ source: 'Facebook', tags: ['Chat-Widget'] }), true);
  assert.equal(isChatContact({ source: 'Facebook', tags: ['fb-lead'] }), false);
  assert.equal(isChatContact({}), false);
});

test('selection: age window, exclusions, already in LP, already sent', () => {
  const rows = [
    contact('c1'),
    contact('c2', { date_added: hoursAgo(0.5) }),                  // under an hour
    contact('c3', { date_added: hoursAgo(24 * 31) }),              // past the 30-day window
    contact('c4', { tags: ['entry:chatbot', 'DNC'] }),             // opt-out
    contact('c5', { tags: ['entry:chatbot', 'contact:delete'] }),
    contact('c6', { phone: '555' }),                               // no usable phone
    contact('c7'),                                                  // phone already in LP
    contact('c8'),                                                  // already sent
    contact('c9', { source: 'Facebook', tags: [] }),               // not chat
    contact('c10', { tags: ['entry:chatbot', 'stop-bot'] }),       // rep takeover ≠ opt-out
  ];
  const lpPhones = new Set(['2395551007']);
  const { send, skipped } = selectChatLeads(rows, { lpPhones, marked: new Set(['c8']), nowMs: NOW });
  assert.deepEqual(send.map((r) => r.ghl_contact_id), ['c1', 'c10']);
  assert.equal(skipped.too_new, 1);
  assert.equal(skipped.too_old, 1);
  assert.equal(skipped.excluded, 2);
  assert.equal(skipped.no_phone, 1);
  assert.equal(skipped.in_lp, 1);
  assert.equal(skipped.already_sent, 1);
  assert.equal(skipped.not_chat, 1);
});

test('selection: the same phone twice in one pass is sent once', () => {
  const { send, skipped } = selectChatLeads(
    [contact('a', { phone: '2395550001' }), contact('b', { phone: '+1 239 555 0001' })],
    { lpPhones: new Set(), marked: new Set(), nowMs: NOW });
  assert.equal(send.length, 1);
  assert.equal(skipped.in_lp, 1);
});

test('selection: capped per pass', () => {
  const rows = Array.from({ length: MAX_PER_PASS + 5 }, (_, i) => contact(`c${i}`, { phone: `23955${String(10000 + i)}` }));
  const { send, skipped } = selectChatLeads(rows, { lpPhones: new Set(), marked: new Set(), nowMs: NOW });
  assert.equal(send.length, MAX_PER_PASS);
  assert.equal(skipped.over_cap, 5);
});

test('SQL: chat filter, exclusion tags and LP id fields are all in the read', () => {
  const sql = buildChatCandidatesSql({ sinceIso: hoursAgo(168), untilIso: hoursAgo(1) });
  assert.match(sql, /ILIKE '%chat%'/);
  assert.match(sql, /'entry:chatbot'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM unnest\(coalesce\(c\.tags/);
  assert.match(sql, /'dnc'/);
  assert.match(sql, /'contact:delete'/);
  assert.match(sql, /'GmAVmW6V9sekD7pVONKr'/);
  assert.doesNotMatch(sql, /'stop-bot'/);
});

test('never-reached-LP read now skips excluded contacts', () => {
  const sql = buildIntakeCandidatesSql({ sinceIso: hoursAgo(48), untilIso: hoursAgo(24) });
  assert.match(sql, /lower\(t\.tag\) IN \(.*'suppress-outbound'/);
  assert.equal(hasExcludedTag(['Suppress-Outbound']), true);
  assert.equal(hasExcludedTag(['stop-bot', 'entry:chatbot']), false);
});

test('mode defaults to shadow; junk falls back to shadow', () => {
  assert.equal(chatIntakeMode({}), 'shadow');
  assert.equal(chatIntakeMode({ CHAT_LP_INTAKE_MODE: 'LIVE' }), 'live');
  assert.equal(chatIntakeMode({ CHAT_LP_INTAKE_MODE: 'off' }), 'off');
  assert.equal(chatIntakeMode({ CHAT_LP_INTAKE_MODE: 'yes' }), 'shadow');
});

// --- the pass --------------------------------------------------------------

function stubDeps({ candidates = [contact('c1'), contact('c2')], lpPhones = [], marked = [], enrollFails = [], hlFails = false, marksFail = false } = {}) {
  const calls = { enroll: [], marks: [], sends: [] };
  const supabase = {
    from(table) {
      assert.equal(table, 'lp_appointment_sync_marks');
      return {
        select: () => ({
          in: async (_col, keys) => (marksFail
            ? { data: null, error: { message: 'boom' } }
            : { data: keys.filter((k) => marked.map(markKey).includes(k)).map((k) => ({ dedup_key: k })), error: null }),
        }),
        upsert: async (row) => { calls.marks.push(row.dedup_key); return { error: null }; },
      };
    },
  };
  return {
    calls,
    deps: {
      hlRunSQL: async () => { if (hlFails) throw new Error('hl down'); return candidates; },
      runSQL: async () => lpPhones.map((p) => ({ phone10: p })),
      supabase,
      enroll: async ({ contactId, notify }) => {
        assert.equal(notify, false, 'the sweep posts its own card');
        calls.enroll.push(contactId);
        if (enrollFails.includes(contactId)) throw new Error('GHL 500');
        return { success: true };
      },
      send: async (text, opts) => { calls.sends.push({ text, opts }); },
    },
  };
}

test('live: enrolls, marks each contact, one ops card', async () => {
  const { deps, calls } = stubDeps();
  const r = await runChatLeadIntakeSweep({ env: { CHAT_LP_INTAKE_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 2);
  assert.deepEqual(calls.enroll, ['c1', 'c2']);
  assert.deepEqual(calls.marks, ['chat-intake:c1', 'chat-intake:c2']);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].opts.channel, 'ops');
  assert.match(calls.sends[0].text, /Chat leads sent to LP: 2/);
});

test('live: a marked contact is not sent again', async () => {
  const { deps, calls } = stubDeps({ marked: ['c1'] });
  const r = await runChatLeadIntakeSweep({ env: { CHAT_LP_INTAKE_MODE: 'live' }, nowMs: NOW, deps });
  assert.deepEqual(calls.enroll, ['c2']);
  assert.equal(r.skipped.already_sent, 1);
});

test('live: a failed enroll is reported, not marked, and the rest still go', async () => {
  const { deps, calls } = stubDeps({ enrollFails: ['c1'] });
  const r = await runChatLeadIntakeSweep({ env: { CHAT_LP_INTAKE_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.ok, false);
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(calls.marks, ['chat-intake:c2']);
  assert.match(calls.sends[0].text, /Failed: 1/);
});

test('live: nothing to send → no card', async () => {
  const { deps, calls } = stubDeps({ candidates: [] });
  const r = await runChatLeadIntakeSweep({ env: { CHAT_LP_INTAKE_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.ok, true);
  assert.equal(calls.sends.length, 0);
});

test('a failed read sends nobody', async () => {
  for (const over of [{ hlFails: true }, { marksFail: true }]) {
    const { deps, calls } = stubDeps(over);
    const r = await runChatLeadIntakeSweep({ env: { CHAT_LP_INTAKE_MODE: 'live' }, nowMs: NOW, deps });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /^read: /);
    assert.equal(calls.enroll.length, 0);
    assert.equal(calls.sends.length, 0);
  }
});

test('shadow: decides but enrolls, marks and posts nothing', async () => {
  const { deps, calls } = stubDeps();
  const r = await runChatLeadIntakeSweep({ env: {}, nowMs: NOW, deps });
  assert.equal(r.mode, 'shadow');
  assert.equal(r.would_send, 2);
  assert.equal(r.sent, 0);
  assert.equal(calls.enroll.length + calls.marks.length + calls.sends.length, 0);
});

test('off: does nothing', async () => {
  const { deps, calls } = stubDeps();
  const r = await runChatLeadIntakeSweep({ env: { CHAT_LP_INTAKE_MODE: 'off' }, nowMs: NOW, deps });
  assert.equal(r.skipped, true);
  assert.equal(calls.enroll.length, 0);
});

test('card names people by first name + initial, never a full surname', () => {
  const text = formatChatIntakeCard({ mode: 'live', sent: [{ ghl_contact_id: 'x1', first_name: 'Pat', last_name: 'Lee' }], failed: [] });
  assert.match(text, /Pat L\. · x1/);
  assert.doesNotMatch(text, /Lee/);
});
