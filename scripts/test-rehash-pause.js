/**
 * A rehash rep's manual message pauses the bot 15 minutes (Mark, 2026-10-21).
 * Jim Anderson's thread, 2026-10-21 (UTC; ET = UTC − 4). John Manieri's manual
 * messages (contact.outbound_message events, our own sends removed): 12:40:42,
 * 12:43:02, 12:50:10, 12:50:57, 12:51:13, 12:54:07, 12:55:58. Jim's inbounds:
 * 12:42:45, 12:50:27, 12:50:50, 12:54:18, 12:56:28. LP set his lead Cnf, and
 * a Rehash Call was on the calendar, before 13:01.
 *
 * Run: node --test scripts/test-rehash-pause.js
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  pauseDecision, pauseOutcome, manualReadSinceMs, teamManuals, rehashPauseMode, rehashPauseMinutes, rehashPauseMaxRestarts,
} = await import('../src/agentic/rehash-pause.js');
const { runRehashGate } = await import('../src/services/rehash-gate-io.js');
const { sendStateFromRows } = await import('../src/jobs/reply-sla-watchdog.js');
const { ANSWERED_OUTCOMES } = await import('../src/agentic/turn-lock.js');

const JOHN = 'TYcZ9DcNkuPCFYsFxRFV';
const T = (hms) => Date.parse(`2026-10-21T${hms}Z`);
const iso = (hms) => new Date(T(hms)).toISOString();
const m = (hms, user_id = JOHN) => ({ at: iso(hms), user_id, message_id: `m-${hms}` });
const JOHNS = ['12:40:42', '12:43:02', '12:50:10', '12:50:57', '12:51:13', '12:54:07', '12:55:58'].map((h) => m(h));
const upTo = (hms) => JOHNS.filter((x) => Date.parse(x.at) <= T(hms));
const TEAM = [JOHN];

test('Jim, 8:42: John texted at 8:40, so the inbound is held 15 minutes from the inbound', () => {
  const d = pauseDecision({ manuals: upTo('12:42:50'), teamUserIds: TEAM, inboundMs: T('12:42:45'), nowMs: T('12:42:50') });
  assert.equal(d.action, 'hold');
  assert.equal(new Date(d.retryAtMs).toISOString(), iso('12:57:45'));
  assert.equal(d.restarts, 0);
});

test('Jim, 8:50:27 inbound: the inbound is later than John\'s 8:50:10 text, so it is the anchor', () => {
  const d = pauseDecision({ manuals: upTo('12:50:30'), teamUserIds: TEAM, inboundMs: T('12:50:27'), nowMs: T('12:50:30') });
  assert.equal(d.action, 'hold');
  assert.equal(new Date(d.anchorMs).toISOString(), iso('12:50:27'));
});

test('restarts: when the 8:42 row fires at 8:57:45, John\'s 8:55:58 text restarts it', () => {
  const prior = { anchor_ms: T('12:42:45'), restarts: 0 };
  const d = pauseDecision({ manuals: upTo('12:57:45'), teamUserIds: TEAM, inboundMs: T('12:42:45'), nowMs: T('12:57:45'), prior });
  assert.equal(d.action, 'hold');
  assert.equal(d.restarted, true);
  assert.equal(d.restarts, 1);
  assert.equal(new Date(d.retryAtMs).toISOString(), iso('13:10:58'));
});

test('15 quiet minutes with no newer team message → fire', () => {
  const prior = { anchor_ms: T('12:55:58'), restarts: 1 };
  const d = pauseDecision({ manuals: upTo('13:11:00'), teamUserIds: TEAM, inboundMs: T('12:42:45'), nowMs: T('13:11:00'), prior });
  assert.equal(d.action, 'fire');
  assert.equal(pauseOutcome({ mode: 'live', decision: d }), 'fire');
});

test('restart cap → handed off, silent', () => {
  const prior = { anchor_ms: T('12:40:00'), restarts: 12 };
  const d = pauseDecision({ manuals: [m('12:45:00')], teamUserIds: TEAM, inboundMs: T('12:39:00'), nowMs: T('12:46:00'), prior, maxRestarts: 12 });
  assert.equal(d.action, 'handed_off');
  assert.equal(pauseOutcome({ mode: 'live', decision: d }), 'skip');
});

test('no manual message in scope → a normal turn; a non-team user never pauses a rehash lead', () => {
  assert.equal(pauseDecision({ manuals: [], teamUserIds: TEAM, inboundMs: T('12:42:45'), nowMs: T('12:42:50') }).action, 'none');
  assert.equal(pauseDecision({ manuals: [m('12:40:42', 'someoneElse')], teamUserIds: TEAM, inboundMs: T('12:42:45'), nowMs: T('12:42:50') }).action, 'none');
  assert.equal(teamManuals([m('12:40:42', 'x'), m('12:41:00')], TEAM).length, 1);
});

test('the read window: after our last bot send, or 15 minutes before now, whichever is earlier', () => {
  assert.equal(manualReadSinceMs({ lastBotSendMs: T('12:00:00'), nowMs: T('13:00:00'), minutes: 15 }), T('12:00:00'));
  assert.equal(manualReadSinceMs({ lastBotSendMs: T('12:55:00'), nowMs: T('13:00:00'), minutes: 15 }), T('12:45:00'));
});

test('modes: shadow would hold and sends, off sends; a proactive send while paused is dropped, never held', () => {
  const hold = { action: 'hold' };
  assert.equal(pauseOutcome({ mode: 'shadow', decision: hold }), 'would_hold');
  assert.equal(pauseOutcome({ mode: 'off', decision: hold }), 'send');
  assert.equal(pauseOutcome({ mode: 'live', decision: hold, proactive: true }), 'skip');
  assert.equal(rehashPauseMode({}), 'shadow');
  assert.equal(rehashPauseMinutes({}), 15);
  assert.equal(rehashPauseMaxRestarts({}), 12);
});

test('the watchdog: a held rehash reply is in flight until its retry, and the closed outcomes are answered', () => {
  const now = T('12:50:00');
  const st = sendStateFromRows([{ status: 'pending', created_at: iso('12:42:50'), error_message: 'deferred: rehash_paused', retry_at: iso('12:57:45') }], { now, inFlightMs: 120000 });
  assert.equal(st.hasInFlightSend, true);
  for (const o of ['conversation_complete', 'rehash_handed_off']) assert.ok(ANSWERED_OUTCOMES.has(o), o);
  assert.equal(sendStateFromRows([{ status: 'skipped', error_message: 'conversation_complete', created_at: iso('12:42:50') }], { now, inFlightMs: 120000 }).hasHeldSend, true);
});

// ── the gate with deps: one send row's whole life ──
function harness({ lead = null, appts = [], manuals = [], thread = [], model = null } = {}) {
  const events = [];
  const supabase = {
    from: () => {
      const q = { select: () => q, eq: () => q, order: () => q, gte: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    },
  };
  return {
    events,
    deps: {
      supabase,
      fetchCurrentLead: async () => lead,
      fetchRecentAndUpcomingAppointments: async () => appts,
      rehashCalendarId: () => 'cal',
      manualOutbounds: async () => manuals,
      fetchRecentMessages: async () => ({ messages: thread }),
      callLLMJson: async () => ({ data: model }),
      emitEvent: async (e) => { events.push(e); return { id: 1 }; },
      log: () => {},
    },
  };
}
const LIVE = { REHASH_PAUSE_MODE: 'live', REHASH_OWNED_MODE: 'live', REHASH_TEAM_USER_IDS: JOHN };
const OPPFDN = { lp_lead_id: 581000, disposition_code: 'OPPFDN', appointment_date: '2026-10-16T10:00:00+00:00' };

test('gate: Jim\'s 8:42 reply is held (deferred), then dropped as owned once LP had him Cnf', async () => {
  const first = harness({ lead: OPPFDN, manuals: upTo('12:42:50') });
  const r1 = await runRehashGate({ contactId: 'jim', actionId: 1, tags: ['lp-demo-completed'], inboundAt: iso('12:42:45'), nowMs: T('12:42:50'), env: LIVE }, first.deps);
  assert.equal(r1.verdict, 'hold');
  assert.equal(r1.reason, 'rehash_paused');
  assert.equal(r1.retryAt, iso('12:57:45'));
  assert.deepEqual(first.events.map((e) => e.event_type), ['rehash.pause_started']);

  const cnf = { lp_lead_id: 585044, disposition_code: 'Cnf', appointment_date: '2026-10-22T10:00:00+00:00' };
  const later = harness({ lead: cnf, manuals: JOHNS });
  const r2 = await runRehashGate({ contactId: 'jim', actionId: 1, tags: ['lp-demo-completed'], inboundAt: iso('12:42:45'), nowMs: T('13:11:00'), priorPause: r1.pause, env: LIVE }, later.deps);
  assert.equal(r2.verdict, 'skip');
  assert.equal(r2.reason, 'rehash_owned');
});

const ghl = (direction, body, at, userId = null) => ({ id: `g-${at}`, direction, body, dateAdded: iso(at), userId, source: 'app' });

test('gate: John texts, the lead says "sounds good see you tomorrow", 15 quiet minutes → conversation_complete, no send', async () => {
  const manuals = [m('12:40:00')];
  const h = harness({ lead: OPPFDN, manuals, thread: [ghl('outbound', 'We can come by tomorrow at 10am', '12:40:00', JOHN), ghl('inbound', 'sounds good see you tomorrow', '12:41:00')] });
  const prior = { anchor_ms: T('12:41:00'), restarts: 0, since_ms: T('12:00:00'), started_at: iso('12:41:05') };
  const r = await runRehashGate({ contactId: 'c', actionId: 3, tags: ['rehash'], inboundAt: iso('12:41:00'), nowMs: T('12:56:30'), priorPause: prior, env: LIVE }, h.deps);
  assert.equal(r.verdict, 'skip');
  assert.equal(r.reason, 'conversation_complete');
  assert.ok(h.events.some((e) => e.event_type === 'rehash.pause_fired' && e.payload.outcome === 'conversation_complete'));
});

test('gate: John texts, the lead asks "what time again?", 15 quiet minutes → the reply goes', async () => {
  const h = harness({ lead: OPPFDN, manuals: [m('12:40:00')], thread: [ghl('outbound', 'We can come by tomorrow', '12:40:00', JOHN), ghl('inbound', 'what time again?', '12:41:00')] });
  const prior = { anchor_ms: T('12:41:00'), restarts: 0, since_ms: T('12:00:00'), started_at: iso('12:41:05') };
  const r = await runRehashGate({ contactId: 'c', actionId: 4, tags: ['rehash'], inboundAt: iso('12:41:00'), nowMs: T('12:56:30'), priorPause: prior, env: LIVE }, h.deps);
  assert.equal(r.verdict, 'send');
  assert.equal(r.firedPause.outcome, 'open');
});

test('gate: words that decide nothing go to the model; low confidence stays open', async () => {
  const h = harness({ lead: OPPFDN, manuals: [m('12:40:00')], thread: [ghl('outbound', 'Talked to the GM', '12:40:00', JOHN), ghl('inbound', 'Actually, we are meeting Tomorrow at 10am...', '12:41:00')], model: { complete: true, confidence: 0.3 } });
  const prior = { anchor_ms: T('12:41:00'), restarts: 0, since_ms: T('12:00:00'), started_at: iso('12:41:05') };
  const r = await runRehashGate({ contactId: 'c', actionId: 5, tags: ['rehash'], inboundAt: iso('12:41:00'), nowMs: T('12:56:30'), priorPause: prior, env: LIVE }, h.deps);
  assert.equal(r.verdict, 'send');
  assert.equal(r.firedPause.completion_ambiguous, true);
});

test('gate: no manual message → a normal turn; shadow marks would_hold and sends', async () => {
  const none = harness({ lead: OPPFDN, manuals: [] });
  assert.equal((await runRehashGate({ contactId: 'c', actionId: 6, tags: ['rehash'], inboundAt: iso('12:42:45'), nowMs: T('12:42:50'), env: LIVE }, none.deps)).verdict, 'send');
  const sh = harness({ lead: OPPFDN, manuals: [m('12:40:42')] });
  const r = await runRehashGate({ contactId: 'c', actionId: 7, tags: ['rehash'], inboundAt: iso('12:42:45'), nowMs: T('12:42:50'), env: { REHASH_TEAM_USER_IDS: JOHN } }, sh.deps);
  assert.equal(r.verdict, 'send');
  assert.equal(r.shadow.rehash_pause_would_hold.decision, 'hold');
});

test('gate: an unreadable manual read never pauses', async () => {
  const h = harness({ lead: OPPFDN });
  h.deps.manualOutbounds = async () => undefined;
  assert.equal((await runRehashGate({ contactId: 'c', actionId: 8, tags: ['rehash'], inboundAt: iso('12:42:45'), nowMs: T('12:42:50'), env: LIVE }, h.deps)).verdict, 'send');
});
