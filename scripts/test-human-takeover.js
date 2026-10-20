/**
 * A person's text pauses the bot — scripts/test-human-takeover.js (Mark, 2026-10-19, ruling 5)
 * Run: node --test scripts/test-human-takeover.js
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { isManualOutbound, takeoverDecision, humanTakeoverMode, HUMAN_TAKEOVER_SKIP_REASON } = await import('../src/agentic/human-takeover.js');
const { newestManualOutbound } = await import('../src/services/human-takeover-io.js');
const { sendStateFromRows, classifyReply } = await import('../src/jobs/reply-sla-watchdog.js');
const { claimTurn, releaseTurn, memoryTurnLockStore } = await import('../src/agentic/turn-lock-io.js');
const { releaseOutcomeFor, ANSWERED_OUTCOMES } = await import('../src/agentic/turn-lock.js');
const { runWithSimOverrides } = await import('../src/simulator/sim-overrides.js');

// A minimal query builder: eq / gt / gte / order / limit over seeded rows.
function fakeDb(tables) {
  return {
    from(name) {
      const rows = (tables[name] || []).map(r => ({ ...r }));
      const filters = [];
      let order = null;
      let lim = Infinity;
      const q = {
        select() { return q; },
        eq(c, v) { filters.push(r => r[c] === v); return q; },
        gt(c, v) { filters.push(r => String(r[c]) > String(v)); return q; },
        gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return q; },
        order(c, { ascending = true } = {}) { order = [c, ascending]; return q; },
        limit(n) { lim = n; return q; },
        then(res) {
          let out = rows.filter(r => filters.every(f => f(r)));
          if (order) out.sort((a, b) => (String(a[order[0]]) < String(b[order[0]]) ? -1 : 1) * (order[1] ? 1 : -1));
          return Promise.resolve({ data: out.slice(0, lim), error: null }).then(res);
        },
      };
      return q;
    },
  };
}

const C = 'gxMVJgLkjFCVxTTLnn8A';
const INBOUND_AT = '2026-10-19T19:48:00.000Z';
const ev = (id, at, payload) => ({ id, event_type: 'contact.outbound_message', ghl_contact_id: C, created_at: at, payload: { direction: 'outbound', source: 'app', ...payload } });
const send = (mid, body, at = '2026-10-19T19:49:12.000Z', status = 'completed') => ({ id: Math.random(), action_type: 'send_message', target_id: C, status, created_at: at, execution_result: { message_id: mid, sent_body: body } });

test('a rep text is manual; ours by id, ours by text, a drip and an unreadable one are not', () => {
  assert.equal(isManualOutbound({ payload: { direction: 'outbound', source: 'app', messageId: 'r1', userId: 'TYcZ9DcNkuPCFYsFxRFV', body: 'Hey Pam, John here. Can I swing by Thursday?' } }), true);
  assert.equal(isManualOutbound({ payload: { direction: 'outbound', source: 'app', messageId: 'b1' }, botMessageIds: ['b1'] }), false);
  assert.equal(isManualOutbound({ payload: { direction: 'outbound', source: 'app', messageId: 'b2', body: 'Glad it was that clear, Pam. Where are things landing for you now?' }, botBodies: ['Glad it was that clear, Pam. Where are things landing for you now?'] }), false);
  assert.equal(isManualOutbound({ payload: { direction: 'outbound', source: 'workflow', messageId: 'w1', body: 'Drip text' } }), false);
  assert.equal(isManualOutbound({ payload: { direction: 'outbound', source: 'bulk_actions', messageId: 'w2' } }), false);
  assert.equal(isManualOutbound({ payload: { direction: 'outbound', source: 'app', messageId: 'a1', userId: '3K6HtoPyBLWeQrrnSnCD', body: 'Hi' }, aiSenderUserId: '3K6HtoPyBLWeQrrnSnCD' }), false);
  assert.equal(isManualOutbound({ payload: { direction: 'inbound', source: 'app', messageId: 'i1', body: 'Hi' } }), false);
  // Unreadable: never "manual".
  assert.equal(isManualOutbound({ payload: null }), null);
  assert.equal(isManualOutbound({ payload: { source: 'app' } }), null);
  assert.equal(isManualOutbound({ payload: { direction: 'outbound', source: 'app', messageId: 'x9' } }), null);
});

test('the decision: live skips, shadow would skip, off / none / unknown send', () => {
  const manual = { at: '2026-10-19T19:51:51Z', message_id: 'r1' };
  assert.equal(takeoverDecision({ mode: 'live', manual }), 'skip');
  assert.equal(takeoverDecision({ mode: 'shadow', manual }), 'would_skip');
  assert.equal(takeoverDecision({ mode: 'off', manual }), 'send');
  assert.equal(takeoverDecision({ mode: 'live', manual: null }), 'send');
  assert.equal(takeoverDecision({ mode: 'live', manual: undefined }), 'send');
  assert.equal(HUMAN_TAKEOVER_SKIP_REASON, 'human_replied');
});

test('a pending reply after a manual text: the read finds the person (body read from GHL once)', async () => {
  const supabase = fakeDb({
    system_events: [ev(1, '2026-10-19T19:49:15.486Z', { messageId: 'VAF7', userId: '3K6Hto' }), ev(2, '2026-10-19T19:51:51.460Z', { messageId: 'ZfIJ', userId: 'TYcZ9DcNkuPCFYsFxRFV' })],
    agent_actions: [send('VAF7', 'Glad it was that clear, Pam. Where are things landing for you now?')],
  });
  const reads = [];
  const ghlFetch = async (_m, path) => { reads.push(path); return { message: { body: 'Pam, John here. I can come by Thursday afternoon to go over it.' } }; };
  const m = await newestManualOutbound(C, INBOUND_AT, { supabase, ghlFetch, env: {} });
  assert.equal(m.message_id, 'ZfIJ');
  assert.equal(m.user_id, 'TYcZ9DcNkuPCFYsFxRFV');
  assert.deepEqual(reads, ['/conversations/messages/ZfIJ']);
  assert.equal(takeoverDecision({ mode: 'live', manual: m }), 'skip');
  assert.equal(takeoverDecision({ mode: 'shadow', manual: m }), 'would_skip');
});

test('the bot\'s own send never reads as manual, by id or by text', async () => {
  const supabase = fakeDb({
    system_events: [ev(1, '2026-10-19T19:49:15Z', { messageId: 'VAF7' }), ev(2, '2026-10-19T19:50:00Z', { messageId: 'OTHERID' })],
    agent_actions: [send('VAF7', 'Glad it was that clear, Pam. Where are things landing for you now?'), send(null, 'Sounds good, Pam. I will be here whenever you are ready to talk.')],
  });
  const ghlFetch = async () => ({ message: { body: 'Sounds good, Pam. I will be here whenever you are ready to talk.' } });
  assert.equal(await newestManualOutbound(C, INBOUND_AT, { supabase, ghlFetch, env: {} }), null);
});

test('the next inbound is answered normally: a text before its boundary does not count', async () => {
  const supabase = fakeDb({ system_events: [ev(2, '2026-10-19T19:51:51Z', { messageId: 'ZfIJ', body: 'John here, call me back.' })], agent_actions: [] });
  assert.equal(await newestManualOutbound(C, '2026-10-19T19:55:00.000Z', { supabase, ghlFetch: async () => ({}), env: {} }), null);
});

test('unknown is never manual: a failed body read, a send in flight, a failed query', async () => {
  const supabase = fakeDb({ system_events: [ev(2, '2026-10-19T19:51:51Z', { messageId: 'ZfIJ' })], agent_actions: [] });
  assert.equal(await newestManualOutbound(C, INBOUND_AT, { supabase, ghlFetch: async () => { throw new Error('429'); }, env: {} }), undefined);
  const inflight = fakeDb({
    system_events: [ev(2, '2026-10-19T19:51:51Z', { messageId: 'ZfIJ', body: 'A text nobody recorded yet.' })],
    agent_actions: [send(null, null, new Date(Date.now() - 30_000).toISOString(), 'executing')],
  });
  assert.equal(await newestManualOutbound(C, INBOUND_AT, { supabase: inflight, ghlFetch: async () => ({}), env: {}, nowMs: Date.now() }), undefined);
  const broken = { from: () => { throw new Error('down'); } };
  assert.equal(await newestManualOutbound(C, INBOUND_AT, { supabase: broken, log: () => {} }), undefined);
});

test('the SLA watchdog holds a human_replied skip (rules 371-374 never re-answer it)', () => {
  const s = sendStateFromRows([{ status: 'skipped', error_message: 'human_replied', created_at: '2026-10-19T19:52:00Z' }], { now: Date.parse('2026-10-19T20:00:00Z'), inFlightMs: 60_000 });
  assert.equal(s.hasHeldSend, true);
  assert.equal(classifyReply({ actionTaken: 'x', tags: ['agentic-active'], hasCompletedSend: false, hasHeldSend: true }), 'silenced');
});

test('the turn lock reads human_replied as answered: a watchdog (228 / 373) loses the turn', async () => {
  assert.ok(ANSWERED_OUTCOMES.has('human_replied'));
  assert.equal(releaseOutcomeFor({ skipped: true, reason: 'human_replied' }), 'human_replied');
  const store = memoryTurnLockStore();
  const deps = { store, log: () => {}, warn: () => {} };
  const a = { contactId: C, turnKey: 'msg:m1', channel: 'sms' };
  await claimTurn({ ...a, ownerRule: 'AGENTIC_RESPOND_POST_CHATBOT', ownerActionId: 1 }, deps);
  await releaseTurn({ ...a, ownerActionId: 1, outcome: 'human_replied' }, deps);
  const watchdog = await claimTurn({ ...a, ownerRule: 'AGENTIC_REPLY_SLA_RECOVER', ownerActionId: 2 }, deps);
  assert.equal(watchdog.claimed, false);
  assert.equal(watchdog.skip_reason, 'already_answered');
});

test('the mode: shadow by default, a gate run can force live', async () => {
  assert.equal(humanTakeoverMode({}), 'shadow');
  assert.equal(humanTakeoverMode({ HUMAN_TAKEOVER_MODE: 'live' }), 'live');
  assert.equal(humanTakeoverMode({ HUMAN_TAKEOVER_MODE: 'yes' }), 'shadow');
  await runWithSimOverrides({ humanTakeoverMode: 'live' }, async () => assert.equal(humanTakeoverMode({}), 'live'));
});

test('the send asking is not "in flight" against itself', async () => {
  const self = { ...send(null, null, new Date(Date.now() - 5_000).toISOString(), 'executing'), id: 777 };
  const supabase = fakeDb({ system_events: [ev(2, '2026-10-19T19:51:51Z', { messageId: 'ZfIJ', body: 'John here, I can call you Thursday.' })], agent_actions: [self] });
  const m = await newestManualOutbound(C, INBOUND_AT, { supabase, ghlFetch: async () => ({}), env: {}, excludeActionId: 777 });
  assert.equal(m?.message_id, 'ZfIJ');
});
