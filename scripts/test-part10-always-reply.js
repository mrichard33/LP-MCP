/**
 * Part 10 (2026-10-03, Mark: "the bot stopped responding … this cannot ever
 * happen"). "Well we have hurricane shutters now." got no reply: the send-time
 * burst yield read a null boundary as id 0 and gave the reply away to the
 * lead's OLDER "Huh?". Every analysis path now carries the boundary, a missing
 * boundary never yields, and the reply SLA backstop is 3 minutes.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.SUPABASE_SERVICE_KEY ||= 'test';

import test from 'node:test';
import assert from 'node:assert/strict';

const { findNewerInbound, inboundFromReplyEvent } = await import('../src/agentic/burst-yield.js');
const { classifyReply, sendStateFromRows, runReplySlaWatchdog } = await import('../src/jobs/reply-sla-watchdog.js');
const { isCoverageQuestion, planServiceAreaTurn } = await import('../src/agentic/service-area-turn.js');
const { routePendingReply } = await import('../src/decision-engine.js');

function fakeSupabase(rows, seen = {}) {
  const q = {
    _f: [],
    select() { return q; },
    eq(k, v) { q._f.push(['eq', k, v]); return q; },
    gt(k, v) { seen.gt = [k, v]; q._f.push(['gt', k, v]); return q; },
    order() { return q; },
    async limit() {
      let out = rows;
      for (const [op, k, v] of q._f) {
        if (op === 'eq') out = out.filter(r => r[k] === v);
        if (op === 'gt') out = out.filter(r => (k === 'id' ? r.id > v : r.created_at > v));
      }
      return { data: out, error: null };
    },
  };
  return { from() { q._f = []; return q; } };
}
const EV = (id, text, at) => ({ id, ghl_contact_id: 'C1', event_type: 'ghl.reply_received', event_subtype: 'pending_analysis', created_at: at, payload: { message_text: text, message_id: `m${id}` } });

// The real thread, contact s2Omf2RcK5YBISwgHHOe, 2026-10-03 13:11–13:16Z.
const THREAD = [
  EV(4099590, 'Huh?', '2026-10-03T13:11:12Z'),
  EV(4099652, 'Oh my wife filled out some form a a while ago.', '2026-10-03T13:12:42Z'),
  EV(4099696, "She wanted to get new windows on our house that are hurricane. But I don't think your service our area.", '2026-10-03T13:14:05Z'),
  EV(4099756, 'Well we have hurricane shutters now.', '2026-10-03T13:15:46Z'),
];

test('a null last_inbound_event_id never yields to an OLDER message (the 2026-10-03 silence)', async () => {
  const seen = {};
  const payload = { last_inbound_event_id: null, last_inbound_event_created_at: null, inbound_message_keys: null, inbound_event_id: 4099756, message_id: 'm4099756' };
  const hit = await findNewerInbound({ contactId: 'C1', payload }, { supabase: fakeSupabase(THREAD, seen) });
  assert.equal(hit, null, 'the reply to "hurricane shutters" must be sent');
  assert.deepEqual(seen.gt, ['id', 4099756], 'the message this reply answers is the boundary, not id 0');
});

test('zero, empty and junk boundaries count as missing', async () => {
  for (const bad of [0, '0', '', 'abc', -5]) {
    const hit = await findNewerInbound({ contactId: 'C1', payload: { last_inbound_event_id: bad } }, { supabase: fakeSupabase(THREAD) });
    assert.equal(hit, null, `boundary ${JSON.stringify(bad)} must not yield`);
  }
  const hit = await findNewerInbound({ contactId: 'C1', payload: { last_inbound_event_created_at: 'not a date' } }, { supabase: fakeSupabase(THREAD) });
  assert.equal(hit, null);
});

test('a real newer message past the fallback boundary still yields', async () => {
  const rows = [...THREAD, EV(4099800, 'Actually can someone come Tuesday?', '2026-10-03T13:16:20Z')];
  const hit = await findNewerInbound({ contactId: 'C1', payload: { inbound_event_id: 4099756, message_id: 'm4099756' } }, { supabase: fakeSupabase(rows) });
  assert.equal(hit.id, 4099800);
});

test('the reply never yields to its own trigger message or anything before it', async () => {
  // A created_at boundary that is too early would return older rows; the own-id floor still holds.
  const payload = { last_inbound_event_created_at: '2026-10-03T13:00:00Z', inbound_event_id: 4099756 };
  const hit = await findNewerInbound({ contactId: 'C1', payload }, { supabase: fakeSupabase(THREAD) });
  assert.equal(hit, null);
});

test('inboundFromReplyEvent carries the boundary for a single reply event', () => {
  const ev = { id: 4099756, created_at: '2026-10-03T13:15:46Z', payload: { message_id: 'syn-a8', webhook_received_at: '2026-10-03T13:15:46.891Z' } };
  assert.deepEqual(inboundFromReplyEvent(ev), {
    event_id: 4099756,
    received_at: null,
    webhook_received_at: '2026-10-03T13:15:46.891Z',
    event_created_at: '2026-10-03T13:15:46Z',
    last_event_id: 4099756,
    last_event_created_at: '2026-10-03T13:15:46Z',
    message_keys: ['syn-a8'],
  });
  assert.equal(inboundFromReplyEvent(null), null);
});

test('routePendingReply passes the boundary to the analyzer', async () => {
  const db = { from: () => ({ update: () => ({ eq: async () => ({}) }) }) };
  const event = { id: 4099756, ghl_contact_id: 'C1', created_at: '2026-10-03T13:15:46Z', payload: { message_text: 'Well we have hurricane shutters now.', message_id: 'syn-a8' } };
  let inbound = null;
  await routePendingReply(event, {}, {
    claim: async () => ({ fresh: ['syn-a8'], consumed: [] }),
    analyze: async (...args) => { inbound = args[5]; return { buyer_stage: 2 }; },
    backstop: async () => {}, supabase: db, wait: true,
  });
  assert.equal(inbound.last_event_id, 4099756);
  assert.deepEqual(inbound.message_keys, ['syn-a8']);
});

// ── the backstop ─────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-03T13:19:00Z');

test('a reply still being written is in_flight, not unanswered', () => {
  const young = sendStateFromRows([{ status: 'executing', created_at: '2026-10-03T13:17:30Z' }], { now: NOW, inFlightMs: 300_000 });
  assert.deepEqual(young, { hasCompletedSend: false, hasInFlightSend: true });
  assert.equal(classifyReply({ actionTaken: 'x', tags: [], ...young }), 'in_flight');
  const stuck = sendStateFromRows([{ status: 'executing', created_at: '2026-10-03T13:10:00Z' }], { now: NOW, inFlightMs: 300_000 });
  assert.equal(stuck.hasInFlightSend, false, 'a send older than its budget is stuck, not in flight');
  assert.equal(classifyReply({ actionTaken: 'x', tags: ['agentic-active'], ...stuck }), 'unanswered');
  const skipped = sendStateFromRows([{ status: 'skipped', created_at: '2026-10-03T13:16:28Z' }], { now: NOW, inFlightMs: 300_000 });
  assert.deepEqual(skipped, { hasCompletedSend: false, hasInFlightSend: false }, 'a dropped draft is not an answer');
});

test('the watchdog flags a reply 3 minutes old with only a skipped send (the 2026-10-03 thread)', async () => {
  const reply = { id: 4099756, ghl_contact_id: 'C1', created_at: '2026-10-03T13:15:46Z', action_taken: 'deduped', payload: { message_text: 'Well we have hurricane shutters now.', channel: 'sms' } };
  const chain = (rows) => {
    const q = { eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: async () => ({ data: rows, error: null }), maybeSingle: async () => ({ data: rows[0] || null, error: null }) };
    return { select: () => q };
  };
  const db = { from: (t) => t === 'system_events' ? chain([reply])
    : t === 'agent_actions' ? chain([{ id: 538663, status: 'skipped', created_at: '2026-10-03T13:16:28Z' }])
      : chain([{ tags: ['agentic-active'] }]) };
  const emitted = [];
  const res = await runReplySlaWatchdog({ supabase: db, emitEvent: async (e) => { emitted.push(e); return { id: 1 }; }, now: () => NOW, mode: 'live', inFlightMs: 300_000 });
  assert.equal(res.sla_minutes, 3);
  assert.equal(res.unanswered, 1);
  assert.equal(emitted[0].payload.reason, 'no_send_within_sla');
});

// ── the coverage doubt in the same thread ────────────────────────────────
test('"I don\'t think you service our area" asks for the zip', () => {
  const msg = "She wanted to get new windows on our house that are hurricane. But I don't think your service our area.";
  assert.equal(isCoverageQuestion(msg), true);
  const plan = planServiceAreaTurn({ trigger: msg, conversation: [] });
  assert.equal(plan.active, true);
  assert.equal(plan.needs_zip, true);
  assert.equal(isCoverageQuestion('Do you service hurricane windows?'), false, 'a product question is not a coverage question');
});
