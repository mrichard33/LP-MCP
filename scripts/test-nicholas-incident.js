/**
 * Incident replay: Nicholas Ferraioli — scripts/test-nicholas-incident.js
 *
 * 2026-10-07. GHL I5x7zltORikAxdEJ6nyD, LP lead 581863. His 3 PM visit was
 * cancelled on our end at 9:29 AM ("does not appear to own the home … not
 * something we can run"). That afternoon the bot asked "Before your visit…",
 * said "we serve Clearwater (33756)" when the property is 33711, and then:
 *   "Thursday, October 8 at 10:00 AM ET works."   (action 555866)
 *   "Thursday at 10 AM is holding for you."       (action 555905)
 *   "You're all set, Nicholas."                   (action 555921)
 * Nothing was booked. The customer's real messages are used, nothing else
 * from his record (the thread lives in the database, never in the repo).
 *
 * Pass criteria (handoff §5):
 *   - no outbound text confirms a date/time
 *   - the contact lands in the Callback Request queue (mocked requeue, once)
 *   - the hand-off carries the note text in its context package
 *   - nothing mentions "your visit" after the cancel
 *   - the ZIP reply says 33711
 *
 * Run: node --test scripts/test-nicholas-incident.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LP_NOTE_DQ_MODE = process.env.LP_NOTE_DQ_MODE || 'live';

const { generateResponse } = await import('../src/response-generator.js');
const { simulateSms, SCENARIOS, withPersonaLp } = await import('../src/simulator/bot-simulator.js');
const { scoreResult } = await import('../src/simulator/sim-scoring.js');
const { minimalContext } = await import('../src/live-chat/fast-lane.js');
const { applyBookingTruth, appointmentOnFile, checkBookingTruth } = await import('../src/agentic/booking-claim.js');
const { schedulingCallbackDecision, fileBotCallback } = await import('../src/agentic/bot-callback.js');
const { noteDqPackage } = await import('../src/agentic/lp-note-dq.js');
const { buildLeadFacts } = await import('../src/agentic/lead-facts.js');
const { enforceCancelledVisit } = await import('../src/agentic/cancelled-visit.js');
const { planServiceAreaTurn, resolveCoverage, coverageSentence } = await import('../src/agentic/service-area-turn.js');

const NOTE = 'CXL: This CX does not appear to own the home as of now, it looks like its a program to help veterans with affordable housing. This is not something we can run.';
const BAD_DRAFTS = [
  'Thursday, October 8 at 10:00 AM ET works.',
  'Thursday at 10 AM is holding for you.',
  "You're all set, Nicholas.",
];
const TURNS = ['Okay, can we schedule for tomorrow morning around 10:00', 'Okay 👍', 'Perfect'];
// After the fix, context.lp for his record (LP CXL outranks booking:active).
const LP = { matched: true, lead_id: '581863', appointment_set: false, appointment_cancelled: true, disposition: 'CXL', last_appointment_date: '2026-10-07T15:00:00+00:00', notes: [{ text: NOTE, entered_by: 'Massingill, Kaley' }] };
const FACTS = buildLeadFacts({ lp: LP, lpLead: { zip: '33711', city: 'Saint Petersburg', address: '747 38th St S' } });

function requeueDeps() {
  const filed = new Set();
  const calls = { requeue: [], handoff: [] };
  return {
    calls,
    deps: {
      log() {},
      alreadyFiled: async (_c, key) => filed.has(key),
      claim: async (_c, key) => { filed.add(key); },
      queueRequeue: async (contactId, notes) => { calls.requeue.push({ contactId, notes }); return { action: 'requeued', requeued: true }; },
      routeHandoff: async (args) => { calls.handoff.push(args); },
    },
  };
}

test('guard path (note check off): each historical draft is blocked and the contact is queued once', async () => {
  const appt = appointmentOnFile({ upcomingAppointments: [], lp: LP });
  assert.equal(appt, null, 'the cancelled visit is not on file');
  const { calls, deps } = requeueDeps();
  for (let i = 0; i < BAD_DRAFTS.length; i++) {
    const generated = { appointment_on_file: appt, booking_hold_backed: false, lead_first_name: 'Nicholas' };
    const out = applyBookingTruth(BAD_DRAFTS[i], generated, { result: null, teamOpen: true });
    assert.ok(out.blocked, BAD_DRAFTS[i]);
    assert.equal(out.message, 'Thanks, Nicholas. A team member will call you shortly to confirm a time that works.');
    assert.equal(checkBookingTruth(out.message).allowed, true, 'the replacement confirms nothing');
    const decision = schedulingCallbackDecision({ bookingClaimBlocked: true, recommendedAction: i === 1 ? 'continue_current' : 'callback_request', onFile: false });
    assert.equal(decision.why, 'booking_claim_blocked');
    await fileBotCallback({ contactId: 'I5x7zltORikAxdEJ6nyD', channel: 'sms', inbound: TURNS[i], firstName: 'Nicholas', why: decision.why, reason: decision.reason, nowMs: Date.parse('2026-10-07T20:44:00Z') }, deps);
  }
  assert.equal(calls.requeue.length, 1, 'one Callback Request push for the three turns');
});

test('live path: the real reply writer hands off once, books nothing, and the bot is stopped', async () => {
  const persona = SCENARIOS.cancelled_cant_run_reschedule.persona;
  const res = await simulateSms({ key: 'cancelled_cant_run_reschedule', title: 'replay', persona, turns: TURNS }, {
    nepqMode: 'live', generate: generateResponse, nowMs: Date.parse('2026-10-07T20:43:00Z'), maxAttempts: 1,
  });
  const sent = res.transcript.flatMap(t => t.bot || []);
  assert.equal(sent.length, 1, 'one hand-off, then silence (the bot is off)');
  assert.match(sent[0], /^Thanks, Nicholas\. A team member will call you (?:shortly|as soon as we open) to confirm a time that works\.$/);
  for (const text of sent) {
    assert.equal(checkBookingTruth(text).allowed, true, text);
    assert.equal(enforceCancelledVisit(text, { facts: FACTS }).changed, false, text);
  }
  const would = res.transcript.flatMap(t => t.would_do || []).map(w => w.kind);
  assert.ok(would.includes('would_stop_bot_lp_note_dq'));
  assert.ok(would.some(k => /would_file_callback_five9/.test(k)), 'Five9 callback filed');
  assert.ok(!would.some(k => /book_appointment/.test(k)), 'nothing booked');
  const score = scoreResult(res);
  assert.deepEqual(score.failures, [], JSON.stringify(score.failures));
});

test('live path: the hand-off card carries the note, the cancel and what the bot said', async () => {
  const ctx = withPersonaLp(minimalContext({ contactId: 'sim-n', contact: { firstName: 'Nicholas', phone: '+17275550142' } }), SCENARIOS.cancelled_cant_run_reschedule.persona);
  ctx.conversation_recent = [{ direction: 'inbound', text: TURNS[0] }];
  const g = await generateResponse('sim-n', 'sms', TURNS[0], { dryRun: true, simulatedContext: ctx });
  assert.equal(g.lp_note_dq.signal, 'not_owner');
  assert.equal(g.companion_action, null);
  const { calls, deps } = requeueDeps();
  await fileBotCallback({
    contactId: 'sim-n', channel: 'sms', inbound: TURNS[0], firstName: 'Nicholas', why: 'lp_note_dq', reason: 'lp_note_dq',
    extra: noteDqPackage({ noteDq: g.lp_note_dq, facts: g.lead_facts, conversation: g.lp_note_dq.conversation_tail, sent: g.message }),
  }, deps);
  assert.equal(calls.requeue.length, 1);
  assert.equal(calls.handoff.length, 1);
  assert.equal(calls.handoff[0].reason, 'lp_note_dq');
  assert.match(calls.handoff[0].extra, /not something we can run/);
  assert.match(calls.handoff[0].extra, /Appointment: CANCELLED/);
  assert.match(calls.handoff[0].extra, /Bot told them: "Thanks, Nicholas/);
});

test('"Before your visit" after the cancel is corrected', () => {
  const draft = "Nicholas, we're sorting this out directly. Before your visit, is there anything you're wondering about that I can pass along?";
  const out = enforceCancelledVisit(draft, { facts: FACTS });
  assert.doesNotMatch(out.text, /before your visit/i);
  assert.match(out.text, /Your visit was cancelled on our end/);
});

test('the ZIP reply names 33711, not 33756', () => {
  const ask = { direction: 'outbound', text: "Happy to check that for you. What's your zip code?" };
  // The two texts as one burst, and as two turns.
  for (const [trigger, conversation] of [
    ['33756\nSorry 33711', [ask]],
    ['Sorry 33711', [ask, { direction: 'inbound', text: '33756' }]],
  ]) {
    const plan = planServiceAreaTurn({ trigger, conversation, fileZip: FACTS.property.zip });
    assert.equal(plan.zip, '33711');
    const sentence = coverageSentence(resolveCoverage(plan, { zipResult: { checked: true, zip: '33711', in_service_area: true, city: 'Saint Petersburg' } }));
    assert.equal(sentence, 'Yes, we serve Saint Petersburg (33711).');
  }
});
