/**
 * Rehash ownership (Mark, 2026-10-21; Jim Anderson, 5Cp5CiWtQ2zSRlxb2XPL).
 * A rehash contact is OWNED (no bot message) when it carries rehash-owned, has
 * an upcoming Rehash Call, or its newest LP lead is Cnf / Issue / Reset with a
 * visit today or later. A failed read is never owned.
 *
 * Run: node --test scripts/test-rehash-owned.js
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
import test from 'node:test';
import assert from 'node:assert/strict';

const { rehashOwned, ownedDecision, rehashOwnedMode, isOwnedLpLead, REHASH_OWNED_SKIP_REASON } = await import('../src/agentic/rehash-owned.js');
const { postDemoInterrupt, F0_SUPPRESS_REASONS } = await import('../src/siro/f0-interrupts.js');
const { ANSWERED_OUTCOMES } = await import('../src/agentic/turn-lock.js');
const { sendStateFromRows } = await import('../src/jobs/reply-sla-watchdog.js');
const { runRehashGate, inRehash } = await import('../src/services/rehash-gate-io.js');
const { runWithSimOverrides } = await import('../src/simulator/sim-overrides.js');

const CAL = 'ncDzLgzbfKJRfhmtlWtB';
const NOW = Date.parse('2026-10-21T13:01:00Z'); // 9:01 AM ET, after LP set Jim's lead Cnf
const call = (startIso, status = 'new', calendar_id = CAL) => ({ appointment_id: 'a1', calendar_id, start_time: startIso, end_time: startIso, status });

test('a: the rehash-owned tag owns the lead', () => {
  assert.deepEqual(rehashOwned({ tags: ['rehash', 'Rehash-Owned'], appointments: [], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).reason, 'a');
});

test('b: an upcoming Rehash Call owns it; past, cancelled or another calendar does not', () => {
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-22T14:00:00Z')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).reason, 'b');
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-21T12:00:00Z')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).owned, false);
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-22T14:00:00Z', 'cancelled')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).owned, false);
  assert.equal(rehashOwned({ tags: [], appointments: [call('2026-10-22T14:00:00Z', 'new', 'otherCal')], currentLead: null, rehashCalendarId: CAL, nowMs: NOW }).owned, false);
});

test('c: the newest LP lead Cnf / Issue / Reset with a visit today or later owns it (Jim: 585044 Cnf for 10/22)', () => {
  const jim = { lp_lead_id: 585044, disposition_code: 'Cnf', appointment_date: '2026-10-22T10:00:00+00:00' };
  assert.equal(rehashOwned({ tags: [], appointments: [], currentLead: jim, rehashCalendarId: CAL, nowMs: NOW }).reason, 'c');
  for (const d of ['Issue', 'Reset']) assert.equal(isOwnedLpLead({ ...jim, disposition_code: d }, NOW), true, d);
  assert.equal(isOwnedLpLead({ ...jim, disposition_code: 'OPPFDN' }, NOW), false);
  assert.equal(isOwnedLpLead({ ...jim, appointment_date: '2026-10-20T10:00:00+00:00' }, NOW), false, 'a past visit');
});

test('unknown is never owned: a failed read with nothing else saying owned → null', () => {
  const r = rehashOwned({ tags: [], appointments: null, currentLead: undefined, rehashCalendarId: CAL, nowMs: NOW });
  assert.equal(r.owned, null);
  assert.equal(ownedDecision({ mode: 'live', owned: r }), 'send');
});

test('modes: live skips, shadow would skip, off sends; default shadow', () => {
  const owned = { owned: true, reason: 'a' };
  assert.equal(ownedDecision({ mode: 'live', owned }), 'skip');
  assert.equal(ownedDecision({ mode: 'shadow', owned }), 'would_skip');
  assert.equal(ownedDecision({ mode: 'off', owned }), 'send');
  assert.equal(rehashOwnedMode({}), 'shadow');
  assert.equal(rehashOwnedMode({ REHASH_OWNED_MODE: 'live' }), 'live');
  assert.equal(runWithSimOverrides({ rehashOwnedMode: 'live' }, () => rehashOwnedMode({})), 'live');
});

test('F.0 v2: postDemoInterrupt stops the touch, terminal, reason rehash_owned', () => {
  assert.ok(F0_SUPPRESS_REASONS.includes('rehash_owned'));
  const pd = postDemoInterrupt({ unsoldPostDemo: true, rehashActive: true, rehashOwned: true });
  assert.deepEqual(pd, { suppress: 'rehash_owned', terminal: true });
  assert.equal(postDemoInterrupt({ unsoldPostDemo: true, rehashActive: true, rehashOwned: false, siroFacts: {} }), null);
});

test('the turn is answered: no watchdog (228 / 373) and no SLA rule (371–374) re-answers it', () => {
  assert.ok(ANSWERED_OUTCOMES.has(REHASH_OWNED_SKIP_REASON));
  const st = sendStateFromRows([{ status: 'skipped', error_message: 'rehash_owned', created_at: new Date(NOW).toISOString() }], { now: NOW, inFlightMs: 120000 });
  assert.equal(st.hasHeldSend, true);
});

// ── the gate's I/O, with deps ──
const gateDeps = ({ lead = null, appts = [], manuals = [], lastBot = null } = {}) => {
  const events = [];
  return {
    events,
    deps: {
      supabase: {
        from: () => {
          const q = { select: () => q, eq: () => q, order: () => q, gte: () => q, limit: async () => ({ data: lastBot ? [{ id: 9, created_at: lastBot }] : [], error: null }) };
          return q;
        },
      },
      fetchCurrentLead: async () => lead,
      fetchRecentAndUpcomingAppointments: async () => appts,
      rehashCalendarId: () => CAL,
      manualOutbounds: async () => manuals,
      fetchRecentMessages: async () => ({ messages: [] }),
      callLLMJson: async () => ({ data: { complete: false } }),
      emitEvent: async (e) => { events.push(e); return { id: 1 }; },
      log: () => {},
    },
  };
};

test('gate: an owned rehash lead is skipped in live, marked in shadow; a pre-demo lead is untouched', async () => {
  const lead = { lp_lead_id: 585044, disposition_code: 'Cnf', appointment_date: '2026-10-22T10:00:00+00:00' };
  const live = gateDeps({ lead });
  const r = await runRehashGate({ contactId: 'c1', actionId: 1, tags: ['lp-demo-completed'], nowMs: NOW, env: { REHASH_OWNED_MODE: 'live', REHASH_PAUSE_MODE: 'off' } }, live.deps);
  assert.equal(r.verdict, 'skip');
  assert.equal(r.reason, 'rehash_owned');
  assert.deepEqual(live.events.map((e) => e.event_type), ['rehash.owned_skip']);

  const shadow = gateDeps({ lead });
  const s = await runRehashGate({ contactId: 'c1', actionId: 1, tags: ['lp-demo-completed'], nowMs: NOW, env: { REHASH_PAUSE_MODE: 'off' } }, shadow.deps);
  assert.equal(s.verdict, 'send');
  assert.ok(s.shadow?.rehash_owned_would_skip);
  assert.deepEqual(shadow.events.map((e) => e.event_type), ['rehash.owned_would_skip']);

  const pre = gateDeps({ lead: { lp_lead_id: 1, disposition_code: 'Cnf', appointment_date: '2026-10-22T10:00:00+00:00' } });
  const p = await runRehashGate({ contactId: 'c2', actionId: 2, tags: ['booking:active'], nowMs: NOW, env: { REHASH_OWNED_MODE: 'live', REHASH_PAUSE_MODE: 'live' } }, pre.deps);
  assert.equal(p.verdict, 'send', 'a pre-demo contact keeps option B, never this gate');
  assert.equal(pre.events.length, 0);
});

test('scope: Jim had no rehash tag, only lp-demo-completed, and his newest lead was Cnf; he is in scope', () => {
  assert.equal(inRehash({ tags: ['lp-demo-completed'], currentLead: { disposition_code: 'Cnf' }, env: {} }), true);
  assert.equal(inRehash({ tags: [], currentLead: { disposition_code: 'Sale', closed_won: true }, env: {} }), false, 'a sold lead never');
});

// ── 2026-10-23 (Mark, Kim Turko review): an owned lead's direct question ──
const {
  classifyOwnedInbound, finishOwnedAnswer, changeRequestLine, rehashOwnedAnswerMode, ownedAnswerFallback, coverTheRestLine,
} = await import('../src/agentic/rehash-owned-answer.js');
const { classifyOwnedQuestion, writeOwnedAnswer } = await import('../src/services/rehash-owned-answer-io.js');

test('answer-only classifier: Kim\'s email → nothing; a question or "please explain" → answer; a move → John', () => {
  assert.equal(classifyOwnedInbound('Turkokim@gmail.com').kind, 'none');
  assert.equal(classifyOwnedInbound('my email is turkokim@gmail.com').kind, 'none');
  assert.equal(classifyOwnedInbound('ok thanks').kind, 'none');
  assert.equal(classifyOwnedInbound('Thank you!').kind, 'none');
  assert.equal(classifyOwnedInbound('Sounds good 👍').kind, 'none');
  assert.equal(classifyOwnedInbound('What does the warranty cover?').kind, 'question');
  assert.equal(classifyOwnedInbound('Please explain the warranty').kind, 'question');
  assert.equal(classifyOwnedInbound('can we move it to 2?').kind, 'change_request');
  assert.equal(classifyOwnedInbound('I need to cancel the call').kind, 'change_request');
  assert.equal(classifyOwnedInbound('My husband will be on the call too').kind, 'ambiguous');
});

test('answer-only classifier: the model decides only the ambiguous; a failure is no reply (fail closed)', async () => {
  let calls = 0;
  const yes = await classifyOwnedQuestion('I was wondering about the warranty', { callLLMJson: async () => { calls++; return { data: { direct_question: true } }; } });
  assert.equal(yes.kind, 'question');
  const no = await classifyOwnedQuestion('My husband will be on the call too', { callLLMJson: async () => { calls++; return { data: { direct_question: false } }; } });
  assert.equal(no.kind, 'none');
  const boom = await classifyOwnedQuestion('My husband will be on the call too', { callLLMJson: async () => { calls++; throw new Error('timeout'); } });
  assert.equal(boom.kind, 'none');
  await classifyOwnedQuestion('What does the warranty cover?', { callLLMJson: async () => { calls++; return {}; } });
  assert.equal(calls, 3, 'the words decide a plain question: no model call');
});

test('answer-only reply: no "?", no time offer, no call to action, 1-2 sentences', () => {
  const draft = 'Great question! Our warranty covers the windows, the glass and the installation for life. Want me to send it over? I also have Thursday at 2 PM open. Let me know if you need anything.';
  const r = finishOwnedAnswer(draft, { rep: 'John', nowMs: NOW });
  assert.equal(r.used_fallback, false, r.reason);
  assert.ok(!r.text.includes('?'), r.text);
  assert.ok(!/\b2 PM\b|thursday/i.test(r.text), r.text);
  assert.ok(!/let me know/i.test(r.text), r.text);
  assert.ok((r.text.match(/[.!]/g) || []).length <= 3, r.text);
  const onlyQuestions = finishOwnedAnswer('Would you like me to explain it on a call?', { rep: 'John', nowMs: NOW });
  assert.equal(onlyQuestions.text, ownedAnswerFallback('John'));
  assert.ok(!onlyQuestions.text.includes('?'));
  const withClose = finishOwnedAnswer(`It covers the glass and frames for life. ${coverTheRestLine('John')}`, { rep: 'John', nowMs: NOW });
  assert.match(withClose.text, /John will cover the rest on your call\.$/);
});

test('a move or cancel request: "Got it, I\'ll let John know." and the #contact-rehash card, nothing booked', async () => {
  const cards = [];
  const r = await writeOwnedAnswer({ contactId: 'c1', text: 'can we move it to 2?', kind: 'change_request', rep: 'John' }, {
    notifyChange: async (a) => { cards.push(a); return { posted: true, reason: 'posted' }; },
    callLLM: async () => { throw new Error('no model for a change request'); },
  });
  assert.equal(r.message, "Got it, I'll let John know.");
  assert.ok(!r.message.includes('?'));
  assert.equal(cards.length, 1);
  assert.equal(changeRequestLine('Reece Team'), "Got it, I'll let our team know.", 'never guess a name');
});

test('gate: owned + live answer mode → a direct question goes as answer-only; the email-only reply and any proactive send skip', async () => {
  const lead = { lp_lead_id: 1, disposition_code: 'OPPFDN', appointment_date: null };
  const env = { REHASH_OWNED_MODE: 'live', REHASH_OWNED_ANSWER_MODE: 'live', REHASH_PAUSE_MODE: 'off' };
  const tags = ['rehash', 'rehash-owned'];
  const q = gateDeps({ lead });
  const a = await runRehashGate({ contactId: 'k1', actionId: 630021, tags, nowMs: NOW, env, answerable: true, inboundText: 'What does the warranty cover?' }, q.deps);
  assert.equal(a.verdict, 'send');
  assert.deepEqual({ kind: a.answerOnly.kind }, { kind: 'question' });
  assert.deepEqual(q.events.map((e) => e.event_type), ['rehash.owned_answer_only']);

  const kim = gateDeps({ lead });
  const k = await runRehashGate({ contactId: 'k1', actionId: 630021, tags, nowMs: NOW, env, answerable: true, inboundText: 'Turkokim@gmail.com' }, kim.deps);
  assert.equal(k.verdict, 'skip');
  assert.equal(k.reason, 'rehash_owned');

  const ask = gateDeps({ lead });
  const e = await runRehashGate({ contactId: 'k1', actionId: 629977, tags, nowMs: NOW, env, answerable: false, inboundText: 'What does the warranty cover?' }, ask.deps);
  assert.equal(e.verdict, 'skip', 'a rule\'s fixed text (the email ask) is never answer-only');

  const pro = gateDeps({ lead });
  const pr = await runRehashGate({ contactId: 'k1', actionId: 3, tags, nowMs: NOW, env, proactive: true, answerable: true, inboundText: 'What does the warranty cover?' }, pro.deps);
  assert.equal(pr.verdict, 'skip');

  const sh = gateDeps({ lead });
  const s = await runRehashGate({ contactId: 'k1', actionId: 4, tags, nowMs: NOW, env: { ...env, REHASH_OWNED_ANSWER_MODE: 'shadow' }, answerable: true, inboundText: 'What does the warranty cover?' }, sh.deps);
  assert.equal(s.verdict, 'skip', 'shadow answers nothing');
  assert.equal(sh.events[0].payload.would_answer_only, 'question');
  assert.equal(rehashOwnedAnswerMode({}), 'shadow');
});

test('gate: the 15-minute pause still holds an answer-only reply after a rehash rep\'s manual text', async () => {
  const lead = { lp_lead_id: 1, disposition_code: 'OPPFDN', appointment_date: null };
  const env = { REHASH_OWNED_MODE: 'live', REHASH_OWNED_ANSWER_MODE: 'live', REHASH_PAUSE_MODE: 'live' };
  const manualAt = new Date(NOW - 2 * 60 * 1000).toISOString();
  const g = gateDeps({ lead, manuals: [{ at: manualAt, user_id: 'TYcZ9DcNkuPCFYsFxRFV' }], lastBot: new Date(NOW - 60 * 60 * 1000).toISOString() });
  const r = await runRehashGate({ contactId: 'k1', actionId: 9, tags: ['rehash', 'rehash-owned'], nowMs: NOW, env, answerable: true, inboundText: 'What does the warranty cover?', inboundAt: new Date(NOW - 60 * 1000).toISOString() }, g.deps);
  assert.equal(r.verdict, 'hold');
  assert.equal(r.answerOnly, undefined);
});

test('bot gate scoring: an owned lead\'s answer-only reply passes; a question back, a time or a plain reply fails', async () => {
  const { SCENARIO_EXPECTATIONS } = await import('../src/simulator/sim-scoring.js');
  const { SCENARIOS } = await import('../src/simulator/bot-simulator.js');
  for (const k of ['rehash_owned_direct_question', 'rehash_owned_email_only', 'rehash_owned_change_request']) assert.ok(SCENARIOS[k] && SCENARIO_EXPECTATIONS[k], k);
  const run = (turns, answer = 'live') => ({ rehash_owned_mode: 'live', rehash_owned_answer_mode: answer, transcript: turns });
  const ok = run([{ turn: 1, bot: ['It covers the glass and frames for life. John will cover the rest on your call.'], rehash_gate: { answer_only: 'question' } }]);
  assert.deepEqual(SCENARIO_EXPECTATIONS.rehash_owned_direct_question(ok), []);
  const q = run([{ turn: 1, bot: ['It covers the glass. Want John to call at 2 PM?'], rehash_gate: { answer_only: 'question' } }]);
  assert.deepEqual(SCENARIO_EXPECTATIONS.rehash_owned_direct_question(q).map((f) => f.code).sort(), ['question_in_owned_answer', 'time_in_owned_answer']);
  assert.equal(SCENARIO_EXPECTATIONS.rehash_owned_direct_question(run([{ turn: 1, bot: null }]))[0].code, 'owned_question_not_answered');
  assert.equal(SCENARIO_EXPECTATIONS.rehash_owned_email_only(run([{ turn: 1, bot: ['Got it. Where are you at with it?'] }]))[0].code, 'reply_sent_to_owned_lead');
  assert.deepEqual(SCENARIO_EXPECTATIONS.rehash_owned_email_only(run([{ turn: 1, bot: null }])), []);
  assert.deepEqual(SCENARIO_EXPECTATIONS.rehash_owned_change_request(run([{ turn: 1, bot: ["Got it, I'll let John know."], rehash_gate: { answer_only: 'change_request' } }])), []);
  // Answer mode off: any reply to an owned lead still fails, as before.
  assert.equal(SCENARIO_EXPECTATIONS.rehash_owned_after_booking(run([{ turn: 1, bot: ['Sure thing.'], rehash_gate: { answer_only: 'question' } }], 'shadow'))[0].code, 'reply_sent_to_owned_lead');
});
