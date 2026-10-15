/**
 * scripts/test-missed-inbound-sweep.js
 *
 * An inbound text GHL never POSTed to /webhook/ghl/reply is found and answered
 * (src/agentic/missed-inbound.js, src/jobs/missed-inbound-sweep.js, 2026-10-15).
 *
 * The regression is Jeff Clark (ySxZUqvXqSHInFgglEmL) on 2026-10-14, his real
 * rows: at 13:29 "Where is my guote?" reached the webhook (system_events
 * 4303532) and was answered; at 15:04 "Please include a copy of your warranty
 * as well. Thanks" (GHL message 7RPAbPoARIvhRc9f9hpW) never did, and no reply
 * was written.
 */

process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.REPLY_DEBOUNCE_MS = '600000';
process.env.SELF_BASE_URL = 'http://127.0.0.1:9';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { planMissedInbound, sweepMessageKey, normalizeText } = await import('../src/agentic/missed-inbound.js');
const { runMissedInboundSweep, sweepMode, bodyText } = await import('../src/jobs/missed-inbound-sweep.js');
const emitter = await import('../src/behavioral-emitter.js');

const JEFF = 'ySxZUqvXqSHInFgglEmL';
const CONV = 'xyj7mvLoKFq7aQ1JAYbX';
const WARRANTY = 'Please include a copy of your warranty as well. Thanks';

// The HL mirror's rows, as they were.
const MIRROR = [
  { ghl_message_id: '29fdjnZqWEsyhNfbugpD', ghl_contact_id: JEFF, ghl_conversation_id: CONV, type: '2', body: 'Where is my guote?', sent_at: '2026-10-14T09:29:39.132-04:00' },
  { ghl_message_id: '7RPAbPoARIvhRc9f9hpW', ghl_contact_id: JEFF, ghl_conversation_id: CONV, type: '2', body: WARRANTY, sent_at: '2026-10-14T11:04:02.869-04:00' },
];
// What LP received: only the 13:29 webhook.
const RECEIVED = [
  { ghl_contact_id: JEFF, created_at: '2026-10-14T13:29:42.714562+00:00', message_text: 'Where is my guote?' },
];
const AT_1506 = Date.parse('2026-10-14T15:06:00Z');

test("Jeff's 15:04 warranty text is flagged; his answered 13:29 text is not", () => {
  const plan = planMissedInbound({ messages: MIRROR, received: RECEIVED, nowMs: AT_1506, lookbackMs: 3 * 60 * 60 * 1000 });
  assert.deepEqual(plan, [{
    messageId: '7RPAbPoARIvhRc9f9hpW', contactId: JEFF, conversationId: CONV, messageType: 'SMS',
    body: WARRANTY, sentAt: '2026-10-14T15:04:02.869Z',
  }]);
});

test('inside the 90-second grace the webhook still has time: not flagged', () => {
  const plan = planMissedInbound({ messages: MIRROR, received: RECEIVED, nowMs: Date.parse('2026-10-14T15:05:00Z') });
  assert.equal(plan.length, 0);
});

test('a late webhook within 3 minutes counts as received', () => {
  const late = [...RECEIVED, { ghl_contact_id: JEFF, created_at: '2026-10-14T15:05:30Z', message_text: WARRANTY }];
  assert.equal(planMissedInbound({ messages: MIRROR, received: late, nowMs: AT_1506 }).length, 0);
});

test('two identical texts need two events; one event answers one', () => {
  const twice = [
    { ghl_message_id: 'a', ghl_contact_id: 'C', type: '2', body: 'Yes', sent_at: '2026-10-14T15:00:00Z' },
    { ghl_message_id: 'b', ghl_contact_id: 'C', type: '2', body: 'yes ', sent_at: '2026-10-14T15:01:00Z' },
  ];
  const one = [{ ghl_contact_id: 'C', created_at: '2026-10-14T15:00:03Z', message_text: 'Yes' }];
  assert.deepEqual(planMissedInbound({ messages: twice, received: one, nowMs: AT_1506 }).map((m) => m.messageId), ['b']);
});

test('an email matches on time alone (the webhook strips the quoted thread)', () => {
  const email = [{ ghl_message_id: 'e1', ghl_contact_id: 'C', type: '3', body: 'Sounds good\n\nOn Tue, Reece wrote: ...', sent_at: '2026-10-14T15:00:00Z' }];
  assert.equal(planMissedInbound({ messages: email, received: [{ ghl_contact_id: 'C', created_at: '2026-10-14T15:00:04Z', message_text: 'Sounds good' }], nowMs: AT_1506 }).length, 0);
  assert.equal(planMissedInbound({ messages: email, received: [], nowMs: AT_1506 })[0].messageType, 'Email');
});

test('empty bodies (an MMS photo), other channels and old messages are skipped', () => {
  const rows = [
    { ghl_message_id: 'p', ghl_contact_id: 'C', type: '2', body: '', sent_at: '2026-10-14T15:00:00Z' },
    { ghl_message_id: 'f', ghl_contact_id: 'C', type: '11', body: "That number doesn't work", sent_at: '2026-10-14T15:00:00Z' },
    { ghl_message_id: 'l', ghl_contact_id: 'C', type: '29', body: 'hi', sent_at: '2026-10-14T15:00:00Z' },
    { ghl_message_id: 'o', ghl_contact_id: 'C', type: '2', body: 'old', sent_at: '2026-10-14T13:00:00Z' },
  ];
  assert.equal(planMissedInbound({ messages: rows, received: [], nowMs: AT_1506 }).length, 0);
});

test('the warranty text is substantive (not the trivial filter)', () => {
  assert.equal(emitter._isTrivialMessageForTests(WARRANTY), false);
  assert.equal(normalizeText('  Hi   THERE '), 'hi there');
});

function sweepDeps({ claimed = new Set() } = {}) {
  const calls = [];
  const events = [];
  return {
    calls, events,
    deps: {
      log: { log: () => {}, warn: () => {} },
      hlRunSQL: async () => MIRROR,
      runSQL: async () => [{ json_agg: RECEIVED }],
      claim: async (contactId, keys) => ({ fresh: keys.filter((k) => !claimed.has(k)), consumed: keys.filter((k) => claimed.has(k)) }),
      processInboundReply: async (body, opts) => { calls.push({ body, opts }); return { response: { status: 'accepted', classification: 'pending_analysis' } }; },
      emitEvent: async (e) => { events.push(e); },
      _done: new Set(),
    },
  };
}

test('live: the missed text goes through the reply pipeline once, marked as the sweep', async () => {
  const { deps, calls, events } = sweepDeps();
  const out = await runMissedInboundSweep({ env: {}, nowMs: Date.parse('2026-10-14T15:06:00Z'), deps: { ...deps, hlRunSQL: async () => MIRROR.slice(1) } });
  assert.equal(out.redriven, 1);
  assert.deepEqual(calls[0].body, { contactId: JEFF, body: WARRANTY, messageType: 'SMS', messageId: '7RPAbPoARIvhRc9f9hpW', direction: 'inbound', dateAdded: '2026-10-14T15:04:02.869Z' });
  assert.deepEqual(calls[0].opts, { source: 'missed_inbound_sweep' });
  assert.equal(events[0].event_type, 'agentic.missed_inbound_redriven');
  const again = await runMissedInboundSweep({ env: {}, nowMs: Date.parse('2026-10-14T15:07:00Z'), deps: { ...deps, hlRunSQL: async () => MIRROR.slice(1) } });
  assert.equal(again.redriven, 0, 'never twice from one process');
});

test('a message another process already claimed is not re-driven', async () => {
  const { deps, calls } = sweepDeps({ claimed: new Set([sweepMessageKey('7RPAbPoARIvhRc9f9hpW')]) });
  await runMissedInboundSweep({ env: {}, nowMs: AT_1506, deps: { ...deps, hlRunSQL: async () => MIRROR.slice(1) } });
  assert.equal(calls.length, 0);
});

test('shadow re-drives nothing; off reads nothing; default is live', async () => {
  const { deps, calls } = sweepDeps();
  const shadow = await runMissedInboundSweep({ env: { MISSED_INBOUND_SWEEP_MODE: 'shadow' }, nowMs: AT_1506, deps: { ...deps, hlRunSQL: async () => MIRROR.slice(1) } });
  assert.equal(shadow.checked, 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(await runMissedInboundSweep({ env: { MISSED_INBOUND_SWEEP_MODE: 'off' }, deps: null }), { skipped: true, mode: 'off' });
  assert.equal(sweepMode({}), 'live');
});

test('a failed read ends the pass: no re-drive on a guess', async () => {
  const { deps, calls } = sweepDeps();
  await assert.rejects(runMissedInboundSweep({ env: {}, nowMs: AT_1506, deps: { ...deps, runSQL: async () => null } }));
  assert.equal(calls.length, 0);
});

test('an HTML email body is read as text', () => {
  assert.equal(bodyText('<div>Send the&nbsp;warranty</div><br>Thanks'), 'Send the warranty\nThanks');
  assert.equal(bodyText('plain'), 'plain');
});

test('the webhook route and the sweep share one pipeline', async () => {
  const src = readFileSync(new URL('../src/behavioral-emitter.js', import.meta.url), 'utf8');
  assert.match(src, /async function handleReply\(req, res\) \{\n  const out = await processInboundReply\(req\.body \|\| \{\}\);/);
  const out = await emitter.processInboundReply({});
  assert.equal(out.httpStatus, 400);
});
