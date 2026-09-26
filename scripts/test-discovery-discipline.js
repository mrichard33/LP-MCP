/**
 * Unit coverage for src/agentic/discovery-discipline.js — the Part A test list
 * from the 2026-09-26 handoff, as pure cases.
 *
 * Each case names the live thread it comes from where there is one:
 *   Carlos  LSZTKuLhNEPfwW2az5Ek  (colour/design → address ask, invented second DM)
 *   QA      hZOcPk6XmMvWVvjZJ7mz  (seven booking asks, spouse re-asked, "Good question")
 *   Sonya   In4V4ZMGT1w1o2cuidgw  (GHL opener re-asked seconds later)
 *
 * Run: node --test scripts/test-discovery-discipline.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  schedulingIntent,
  recentBookingAsks,
  bookingAskAllowed,
  problemProbeState,
  decisionMakerState,
  openerAlreadyAsked,
  buildDiscipline,
  findBookingAsks,
  findBannedOpeners,
  stripBannedOpener,
  findExclamations,
  stripExclamations,
  findPhantomDecisionMaker,
  findInsuranceOutcomeClaims,
  replaceInsuranceClaims,
  findRepeatedOpener,
  stripSentences,
  holdingLine,
  isLeadQuestion,
  APPROVED_INSURANCE_LINE,
  APPROVED_DECISION_MAKER_ASK,
} from '../src/agentic/discovery-discipline.js';
import { buildEstablishedFacts } from '../src/agentic/established-facts.js';
import { isDoubleBarrelled } from '../src/agentic/conversation-repetition.js';

const T0 = Date.parse('2026-09-26T15:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const out = (text, sec = 0) => ({ direction: 'outbound', channel: 'sms', timestamp: at(sec), text });
const inb = (text, sec = 0) => ({ direction: 'inbound', channel: 'sms', timestamp: at(sec), text });

// ── Fix 1: answer, then discover ────────────────────────────────────────

test('a product question with no scheduling intent forbids a booking ask', () => {
  const r = bookingAskAllowed({ triggerMessage: 'Who does the install?', conversation: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'lead_asked_a_question');
});

test('"what\'s the next step?" allows a booking ask', () => {
  for (const msg of ["What's the next step?", 'Can we do it sooner?', 'When can you come out?', 'How soon could someone come by?']) {
    assert.equal(bookingAskAllowed({ triggerMessage: msg, conversation: [] }).allowed, true, msg);
    assert.equal(schedulingIntent(msg), true, msg);
  }
});

test('"what about the warranty?" is NOT scheduling intent (the substring trap)', () => {
  assert.equal(schedulingIntent('What about the warranty?'), false);
  assert.equal(schedulingIntent('That one works for me, the double hung.'), false);
});

test('a day picked after we offered times counts as scheduling intent', () => {
  const last = 'Would Tuesday at 10 or Thursday at 2 work better for you?';
  assert.equal(schedulingIntent('Thursday at 2 works', last), true);
  assert.equal(schedulingIntent('Thursday works', null), false, 'no offer on the table, no pick');
  const r = bookingAskAllowed({ triggerMessage: 'Thursday works', conversation: [out(last)] });
  assert.equal(r.allowed, true);
});

test('four consecutive product questions get at most one booking ask across the four replies', () => {
  // Simulate the QA thread: the bot answers and closes with a time ask once,
  // then the cap holds for the next three turns even without questions.
  const convo = [
    inb('Who does the install?', 0),
    out('Our own factory-trained, Reece-certified crews handle every install. Would a day this week work?', 30),
    inb('How long does it take?', 60),
  ];
  let allowedCount = 0;
  const questions = ['How long does it take?', 'Is it vinyl or aluminum?', 'Do you handle the permit?', 'What about financing?'];
  for (const q of questions) {
    const r = bookingAskAllowed({ triggerMessage: q, conversation: convo });
    if (r.allowed) allowedCount += 1;
    convo.push(out('Answer. ' + (r.allowed ? 'What day works for you?' : 'Which window is the worst one?'), convo.length * 30));
    convo.push(inb(q, convo.length * 30));
  }
  assert.equal(allowedCount, 0, 'every one of the four was a question with no scheduling intent');
  assert.equal(recentBookingAsks(convo, 3), 0);
});

test('the hard cap: one booking ask per three bot turns, even on non-question turns', () => {
  const convo = [
    out('Great, want me to find a time this week?', 0),
    inb('Maybe.', 10),
  ];
  const r = bookingAskAllowed({ triggerMessage: 'Maybe.', conversation: convo });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'booking_ask_in_last_3_turns');
  assert.equal(r.recent_asks, 1);

  const later = [...convo, out('Understood.', 20), inb('ok', 30), out('Sure.', 40), inb('ok', 50), out('Noted.', 60), inb('So tell me more', 70)];
  assert.equal(bookingAskAllowed({ triggerMessage: 'So tell me more', conversation: later }).allowed, true);
});

test('handoff pending blocks the ask even on a scheduling question, and fast-track unlocks it', () => {
  assert.equal(bookingAskAllowed({ triggerMessage: "What's next?", conversation: [], handoffPending: true }).reason, 'handoff_pending');
  assert.equal(bookingAskAllowed({ triggerMessage: 'ok', conversation: [out('What day works?')], recommendedAction: 'fast_track_booking' }).allowed, true);
  assert.equal(bookingAskAllowed({ triggerMessage: 'ok', conversation: [], recommendedAction: 'callback_request' }).reason, 'default');
});

test('findBookingAsks catches the seven-turn close and leaves a discovery question alone', () => {
  assert.equal(findBookingAsks('Our crews handle it. Would a day this week work for both of you?').length, 1);
  assert.equal(findBookingAsks('Our crews handle it. Want to just do the 15 minute call?').length, 1);
  assert.equal(findBookingAsks('Our crews handle it. What made you start looking at this now?').length, 0);
  assert.equal(findBookingAsks('We can schedule around your work hours.').length, 0, 'a statement is not an ask');
});

test('isLeadQuestion reads a question mark or a question opener', () => {
  assert.equal(isLeadQuestion('Who does the install?'), true);
  assert.equal(isLeadQuestion('how long does it take'), true);
  assert.equal(isLeadQuestion("I'm the owner."), false);
});

// ── Fix 2: echo and probe ───────────────────────────────────────────────

test('Carlos: "I don\'t like the color and design" → probe first, no booking, no address', () => {
  const trigger = "I don't like the color and design of my door.";
  const p = problemProbeState({ triggerMessage: trigger, conversation: [out('What is going on with the door?')] });
  assert.equal(p.problem_named, trigger);
  assert.equal(p.family, 'colour and design');
  assert.equal(p.probe_done, false);
  assert.equal(p.urgent, false);
  const d = buildDiscipline({ triggerMessage: trigger, conversation: [out('What is going on with the door?')] });
  // Not a question, no prior ask → the cap does not bite, but the PROBE FIRST
  // section governs the next question; the guards reject an address/booking ask.
  assert.equal(findBookingAsks("The color and design — what don't you like about it?").length, 0);
  assert.equal(d.probe.problem_named, trigger);
});

test('after one probe answer, the transition is open (probe_done)', () => {
  const convo = [
    inb('The frames are rotting.', 0),
    out('Rotting — how long has that been going on?', 10),
    inb('A couple of years now.', 20),
  ];
  const p = problemProbeState({ triggerMessage: 'A couple of years now.', conversation: convo });
  assert.equal(p.problem_named, 'The frames are rotting.');
  assert.equal(p.probe_done, true);
});

test('a probe that quotes their own words counts as done', () => {
  const convo = [inb("They're so drafty in winter.", 0), out('Drafty where, the whole house or one room?', 10)];
  assert.equal(problemProbeState({ triggerMessage: '', conversation: convo }).probe_done, true);
});

test('a stated deadline skips the probe', () => {
  for (const msg of ['The frames are rotting and I need it done before the 24th.', 'Windows are old, need them in asap', 'Cracked slider, closing on the house by October']) {
    const p = problemProbeState({ triggerMessage: msg, conversation: [] });
    assert.ok(p.problem_named, msg);
    assert.equal(p.urgent, true, msg);
  }
});

test('a product QUESTION mentioning colour is not a named problem', () => {
  const p = problemProbeState({ triggerMessage: 'Do you have different color frames?', conversation: [] });
  assert.equal(p.problem_named, null);
});

// ── Fix 3: decision-makers ──────────────────────────────────────────────

test('"I\'m the owner" with nobody named → sole; the ledger closes decision_makers', () => {
  const trigger = "I'm the owner, it's just me.";
  const est = buildEstablishedFacts({ conversation: [inb(trigger)], lead: { decision_makers_present: null } });
  assert.ok(est.closed_questions.includes('decision_makers'), 'a volunteered sole statement closes the question');
  assert.equal(est.facts.find(f => f.key === 'decision_makers').value, 'Solo Owner');

  const dm = decisionMakerState({ conversation: [inb(trigger)], triggerMessage: trigger, established: est });
  assert.equal(dm.status, 'sole');
  assert.equal(dm.name, null);
});

test('Carlos: "I make all the decisions" is sole, and "whoever else is deciding" is a phantom', () => {
  const dm = decisionMakerState({ conversation: [inb('I make all the decisions here.')], triggerMessage: 'I make all the decisions here.' });
  assert.equal(dm.status, 'sole');
  const hits = findPhantomDecisionMaker('Understood. Whoever else is deciding can join the call too. What day works?', { ...dm, ask_allowed: false });
  assert.equal(hits.length, 1);
  assert.match(hits[0], /Whoever else/);
  // Any decision-maker question at all is a phantom for a sole owner.
  assert.equal(findPhantomDecisionMaker('Is there anyone else on the home with you?', { ...dm, ask_allowed: false }).length, 1);
  // A clean booking offer to one person is fine.
  assert.equal(findPhantomDecisionMaker('Would Tuesday at 10 work for you?', { ...dm, ask_allowed: false }).length, 0);
});

test('unknown status: "both of you" is a phantom; the approved ask is allowed exactly once', () => {
  const unknown = { status: 'unknown', name: null, ask_count: 0, feel_ask_count: 0 };
  assert.equal(findPhantomDecisionMaker('Would a day this week work for both of you?', { ...unknown, ask_allowed: true }).length, 1);
  assert.equal(findPhantomDecisionMaker(`Happy to set that up. ${APPROVED_DECISION_MAKER_ASK}`, { ...unknown, ask_allowed: true }).length, 0);
  // Not on a turn that answers an unrelated question…
  assert.equal(findPhantomDecisionMaker(`Our crews do the install. ${APPROVED_DECISION_MAKER_ASK}`, { ...unknown, ask_allowed: false }).length, 1);
  // …and not a second time.
  assert.equal(findPhantomDecisionMaker(APPROVED_DECISION_MAKER_ASK, { ...unknown, ask_count: 1, ask_allowed: true }).length, 1);
});

test('the approved decision-maker ask is not double-barrelled', () => {
  assert.equal(isDoubleBarrelled(APPROVED_DECISION_MAKER_ASK), false);
  assert.equal(isDoubleBarrelled('Would a day this week work, or is the 15 minute call easier?'), true, 'the real either/or close is still caught');
});

test('QA thread: spouse named, "she doesn\'t need to be there" → one feel-ask, then handoff on the second refusal', () => {
  const convo = [
    inb('My wife Paloma and I are looking at replacing them.', 0),
    out('Is this your call, or is anyone else weighing in on it?', 10),
    inb("I make all the decisions. She doesn't need to be there.", 20),
  ];
  const first = decisionMakerState({ conversation: convo, triggerMessage: convo[2].text });
  assert.equal(first.status, 'named_absent');
  assert.equal(first.name, 'Paloma');
  assert.equal(first.relation, 'wife');
  assert.equal(first.feel_ask_count, 0);
  assert.equal(first.ask_count, 1);

  // The bot asks once, NEPQ style.
  const withAsk = [...convo, out('How does Paloma feel about getting the windows done?', 30)];
  const asked = decisionMakerState({ conversation: withAsk, triggerMessage: convo[2].text });
  assert.equal(asked.status, 'named_absent');
  assert.equal(asked.feel_ask_count, 1);

  // She is on board → offer for both.
  const onBoard = [...withAsk, inb("She's on board, she just can't take time off.", 40)];
  assert.equal(decisionMakerState({ conversation: onBoard, triggerMessage: onBoard[4].text }).status, 'named_present');

  // Refused again → handoff, no more asks.
  const refused = [...withAsk, inb("Like I said, she doesn't need to be there. Just book it.", 40)];
  const h = decisionMakerState({ conversation: refused, triggerMessage: refused[4].text });
  assert.equal(h.status, 'handoff');
  assert.equal(h.name, 'Paloma');
  // Nothing about a second person may be asked now.
  assert.equal(findPhantomDecisionMaker('Understood. I will have someone from our team call you to sort out the visit.', h).length, 0);
});

test('a named spouse without an absence statement is treated as present', () => {
  const convo = [inb('My husband Dan and I want to do the whole house.')];
  const dm = decisionMakerState({ conversation: convo, triggerMessage: convo[0].text });
  assert.equal(dm.status, 'named_present');
  assert.equal(dm.name, 'Dan');
  // "both of you" is fine once a second person is on the record.
  assert.equal(findPhantomDecisionMaker('Would Saturday work for both of you?', dm).length, 0);
});

test('a CRM Solo Owner field wins; "my wife and I" is never a sole statement', () => {
  const est = { facts: [{ key: 'decision_makers', value: 'Solo Owner', source: 'field' }], closed_questions: ['decision_makers'] };
  assert.equal(decisionMakerState({ conversation: [], established: est }).status, 'sole');
  const two = buildEstablishedFacts({ conversation: [inb("My wife and I own the house, it's my call though.")], lead: {} });
  assert.equal(two.closed_questions.includes('decision_makers'), false);
});

test('we asked, no answer yet → asked; nothing → unknown', () => {
  assert.equal(decisionMakerState({ conversation: [out('Is this your call, or is anyone else weighing in on it?')] }).status, 'asked');
  assert.equal(decisionMakerState({ conversation: [] }).status, 'unknown');
});

// ── Fix 4: tone ─────────────────────────────────────────────────────────

test('"Good question" / "Great question" / "Happy to help" are banned openers; "Fair question —" and "Perfect," are not', () => {
  assert.equal(findBannedOpeners('Good question — a sash is the frame that holds the glass.').length, 1);
  assert.equal(findBannedOpeners('Great question. Most installs take 1 to 2 days.').length, 1);
  assert.equal(findBannedOpeners('Happy to help with that.').length, 1);
  assert.equal(findBannedOpeners('Great! We can do that.').length, 1);
  assert.equal(findBannedOpeners("Fair question — yes, I'm Reece's AI assistant.").length, 0);
  assert.equal(findBannedOpeners("Perfect, you're confirmed for Tuesday at 10.").length, 0);
  assert.equal(stripBannedOpener('Good question — a sash is the frame that holds the glass.'), 'A sash is the frame that holds the glass.');
  assert.equal(stripBannedOpener('Great question. Most installs take 1 to 2 days.'), 'Most installs take 1 to 2 days.');
});

test('exclamation marks are counted and stripped deterministically', () => {
  assert.equal(findExclamations('Great! We can do that! Really.'), 2);
  assert.equal(stripExclamations('Great! We can do that!'), 'Great. We can do that.');
  assert.equal(findExclamations(stripExclamations('Wow!!')), 0);
});

// ── Fix 5: the opener ───────────────────────────────────────────────────

test('Sonya: the GHL welcome opener 20 seconds ago is detected; the bot must not ask it again', () => {
  const opener = 'Hi Sonya, thanks for reaching out. What are you hoping to get done with your windows or doors?';
  const convo = [out(opener, -20), inb('Hi', 0)];
  const o = openerAlreadyAsked({ conversation: convo, nowMs: T0 });
  assert.equal(o.asked, true);
  assert.equal(o.age_sec, 20);
  assert.equal(findRepeatedOpener("Hi Sonya. What's going on with your windows that made you reach out?", o.text).length, 1);
  assert.equal(findRepeatedOpener('Hi Sonya. Which room gives you the most trouble?', o.text).length, 0);
  assert.equal(findRepeatedOpener("Hi Sonya. I'm here whenever you're ready.", o.text).length, 0);
});

test('an opener older than ten minutes does not count; an undated opener counts only when it is our newest message', () => {
  const opener = 'What are you hoping to get done with your windows?';
  assert.equal(openerAlreadyAsked({ conversation: [out(opener, -1200), inb('Hi', 0)], nowMs: T0 }).asked, false);
  assert.equal(openerAlreadyAsked({ conversation: [{ direction: 'outbound', text: opener }, inb('Hi', 0)], nowMs: T0 }).asked, true);
  assert.equal(openerAlreadyAsked({ conversation: [{ direction: 'outbound', text: opener }, out('Which room?'), inb('Hi', 0)], nowMs: T0 }).asked, false);
});

test('stripSentences and holdingLine give a second draft something shippable', () => {
  const msg = 'Thanks Sonya. What are you hoping to get done with your windows?';
  const repeats = findRepeatedOpener(msg, 'What are you hoping to get done with your windows or doors?');
  assert.equal(stripSentences(msg, s => repeats.includes(s)), 'Thanks Sonya.');
  assert.equal(holdingLine('Sonya'), "Hi Sonya. I'm here whenever you're ready.");
});

// ── Fix 6: insurance ────────────────────────────────────────────────────

test('predicted savings without the carrier-decides line is a violation; with it, clean; a carrier name is always a violation', () => {
  const bad = 'Many Florida homeowners see meaningful premium reductions with impact windows.';
  const r1 = findInsuranceOutcomeClaims(bad);
  assert.deepEqual(r1.violations, ['a premium reduction']);
  assert.equal(r1.paired, false);

  const paired = `${bad} ${APPROVED_INSURANCE_LINE}`;
  assert.deepEqual(findInsuranceOutcomeClaims(paired).violations, []);

  const carrier = `${APPROVED_INSURANCE_LINE} Citizens usually applies it within a cycle.`;
  const r3 = findInsuranceOutcomeClaims(carrier);
  assert.deepEqual(r3.violations, ['a named insurance carrier']);
  assert.deepEqual(r3.carriers, ['Citizens']);

  assert.equal(findInsuranceOutcomeClaims(APPROVED_INSURANCE_LINE).violations.length, 0);
  assert.equal(findInsuranceOutcomeClaims('You could lower your premium a lot.').violations.length, 1);
  assert.equal(findInsuranceOutcomeClaims('Most people save on insurance with these.').violations.length, 1);
});

test('replaceInsuranceClaims swaps the offending sentence for the approved line, once', () => {
  const msg = 'Impact windows are code-rated. Most homeowners save on insurance with them. Your premium will drop too. Want the details?';
  const fixed = replaceInsuranceClaims(msg);
  assert.equal(fixed, `Impact windows are code-rated. ${APPROVED_INSURANCE_LINE} Want the details?`);
  assert.equal(findInsuranceOutcomeClaims(fixed).violations.length, 0);
});

// ── the bundle ──────────────────────────────────────────────────────────

test('buildDiscipline: the DM ask is allowed only when a booking ask is allowed and nobody has asked', () => {
  const d1 = buildDiscipline({ triggerMessage: 'Who does the install?', conversation: [] });
  assert.equal(d1.booking.allowed, false);
  assert.equal(d1.decision_makers.status, 'unknown');
  assert.equal(d1.decision_makers.ask_allowed, false);

  const d2 = buildDiscipline({ triggerMessage: "What's the next step?", conversation: [] });
  assert.equal(d2.booking.allowed, true);
  assert.equal(d2.decision_makers.ask_allowed, true);

  const d3 = buildDiscipline({ triggerMessage: "What's the next step?", conversation: [inb("I'm the only owner.")] });
  assert.equal(d3.decision_makers.status, 'sole');
  assert.equal(d3.decision_makers.ask_allowed, false);
});

test('buildDiscipline never throws on garbage input', () => {
  const d = buildDiscipline({ triggerMessage: null, conversation: [null, 'x', {}], established: null, nowMs: NaN });
  assert.equal(typeof d.booking.allowed, 'boolean');
  assert.equal(d.opener.asked, false);
});

// ── replay-driven cases (Carlos LSZTKuLhNEPfwW2az5Ek, 2026-09-21) ────────

test('Carlos: answering our address ask mid-booking keeps the booking ask allowed', () => {
  const convo = [
    inb('The visit has to be tomorrow, and the installation on Wednesday.', 0),
    out("We can't promise Wednesday until a specialist sees the opening. What's the address, with zip, so we can get that scheduled?", 10),
  ];
  const r = bookingAskAllowed({ triggerMessage: '31700 cannon rush drive 33576 san Antonio', conversation: convo });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'lead_answered_booking_prerequisite');
});

test('Carlos: "Don\'t worry, I\'m the owner" answers the decision-maker ask and unlocks the slot offer', () => {
  const convo = [
    out('Is there anyone else on the home with you, or anyone else who\'d weigh in?', 0),
    inb('Tomorrow, whenever you like.', 10),
    out('Tomorrow works timing-wise. Can they join tomorrow, or would the 15-minute call with both of you work better?', 20),
  ];
  const r = bookingAskAllowed({ triggerMessage: "Don't worry, I'm the owner.", conversation: convo });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'lead_answered_decision_maker_ask');
});

test('Carlos: a deadline stated earlier in the thread keeps scheduling open and the probe skipped', () => {
  const convo = [
    inb('I urgently need a door for before September 24th.', 0),
    inb("I want to replace this door. I don't like the color and the design.", 10),
    out('What would need to happen to get this handled before the 24th?', 20),
    inb('I can send you the wall-to-wall measurements, and you send me some options.', 30),
  ];
  const trigger = convo[3].text;
  const p = problemProbeState({ triggerMessage: trigger, conversation: convo });
  assert.equal(p.urgent, true, 'the deadline three messages back still governs');
  const r = bookingAskAllowed({ triggerMessage: trigger, conversation: convo });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'urgent_deadline_stated');
});

test('Carlos: "to see colour options, what is your phone number?" is not a probe of the colour problem', () => {
  const convo = [
    inb("I don't like the color and the design.", 0),
    out('Understood. To connect you with a specialist and see design and color options you like, what is your name and phone number?', 10),
  ];
  assert.equal(problemProbeState({ triggerMessage: '', conversation: convo }).probe_done, false);
});

test('QA thread: the slot-menu close counts as a booking ask', () => {
  assert.equal(findBookingAsks('Tuesday, Sep 22 at 10 AM or 2 PM for the visit, which works better?').length, 1);
  assert.equal(findBookingAsks("Since our specialist prices everything on the spot, what's a time that could work for both of you?").length, 1);
  assert.equal(recentBookingAsks([out('Tuesday at 10 AM or 2 PM, which works better?')]), 1);
});

test('Sonya: stripping the repeated opener never ships a bare signature', () => {
  const opener = 'What are you hoping to get done with your windows or doors?';
  const msg = "Hi Sonya, what's going on with your windows or doors that brought you our way?\n\n— Reece Team";
  const rep = findRepeatedOpener(msg, opener);
  assert.equal(rep.length, 1);
  assert.equal(stripSentences(msg, s => rep.includes(s)), '');
});
