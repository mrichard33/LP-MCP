/**
 * A goodbye ends the turn — scripts/test-sign-off.js
 *
 * 2026-10-13 (Erica Hilts, nwMyouutw3Y65lYiEmsH). Her chat, replayed:
 *   10:52 "Ok I see- what's an average price including installation?"
 *   10:54 bot: every home is different + two visit times
 *   10:55 "Thank you for your time- just needing an average estimation at this
 *         time, not exact pricing. Have a good day."
 *   10:56 bot: "Understood. I'll have someone from our team call you to talk
 *         it through." (a third price ask → a filed Five9 callback)
 *   10:57 "I can call back when I have more time. Ty"
 *   10:58 bot: "No problem, Erica. I'll check back next week. Enjoy. Which
 *         works better, tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET?"
 *   10:59 "stop"
 * The reviewer's rule: on "not now", "I'll call back" or "have a good day", a
 * short warm goodbye with no times and no question, then stop. The owner's
 * rulings the same day: the decision makers asked once before the first
 * times, and a price ask answered with questions first.
 *
 * Run: node --test scripts/test-sign-off.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { isLeadSignOff, leadWillReachOut } = await import('../src/agentic/sign-off.js');
const { planNepqTurn, enforceNepqPlan, appendReferenceAsk, LINES } = await import('../src/agentic/nepq-planner.js');
const { isSignOffLine } = await import('../src/agentic/post-demo-turn.js');
const { shouldRecordPromise } = await import('../src/agentic/sms-format.js');
const { checkReply } = await import('../src/eval/reply-invariants.js');
const { optedOutOfCalls } = await import('../src/jobs/promised-callback-sweep.js');
const { readRequeueResult } = await import('../src/agentic/bot-callback.js');

const OPEN_MS = Date.parse('2026-10-13T15:00:00Z'); // a Tuesday, 11 AM ET
const SLOTS = [{ iso: '2026-10-14T14:00:00Z', day: 'Wed, Oct 14', rel: 'tomorrow', time: '10:00 AM' }, { iso: '2026-10-15T22:00:00Z', day: 'Thu, Oct 15', time: '6:00 PM' }];
const T = (...pairs) => pairs.map(([d, t]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: t }));

const OFFER_1054 = "Fair question, Erica. Every home's different, so a real number comes from measuring, not a guess. We have tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET to come measure and get you exact pricing. Which works better?";
const MSG_1055 = 'Thank you for your time- just needing an average estimation at this time, not exact pricing. Have a good day.';
const BOT_1056 = "Understood. I'll have someone from our team call you to talk it through.";
const MSG_1057 = 'I can call back when I have more time. Ty';
const DRAFT_1058 = 'No problem, Erica. I\'ll check back next week. Enjoy. Which works better, tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET?';
const ERICA = T(
  ['i', 'good morning, I was looking to purchase a bay window and am currently comparing costs. The area is about 6ft wide and 4-5 ft long'],
  ['o', 'Of course, I can help with that. Are all the other windows in your home already hurricane impact?'],
  ['i', 'no'],
  ['o', "Got it, so the bay window wouldn't be the only one needing attention eventually. What's bothering you most about the rest of them right now?"],
  ['i', 'just need price of one bay window please :) the rest are fine for now'],
  ['o', "Happy to help with that. What's got you looking into it now?"],
  ['i', 'upgrade'],
  ['o', 'Thanks for walking me through that. It sounds like we could help. The next step would be a free visit at your home. Would that work for you?'],
  ['i', 'no, I am asking if you sell just the window I do not need it installed. I just need the window.'],
  ['o', "No, we only sell windows as part of a professional install. That's what keeps the warranty and code certification valid. What's making you want to skip the install part?"],
  ['i', "Ok I see- what's an average price including installation?"],
  ['o', OFFER_1054],
);
const plan = (a) => planNepqTurn({ channel: 'sms', nowMs: OPEN_MS, firstName: 'Erica', slots: SLOTS, tzLabel: 'ET', ...a });

// ── reading a goodbye ─────────────────────────────────────────────────────

test("Erica's two messages are goodbyes; so are the reviewer's examples", () => {
  for (const t of [MSG_1055, MSG_1057, 'Have a good day', 'Not right now, thanks', 'Maybe later', "I'll get back to you", 'Thanks for your time', "I'm busy right now, I'll reach out", 'ok bye', 'Have a great weekend!! :)', 'Thanks, have a great day John', 'Have a good day ty']) {
    assert.equal(isLeadSignOff(t), true, t);
  }
});

test('not a goodbye: a question, a time, a plain thank-you, a think-it-over, a call request', () => {
  for (const t of ['Thanks!', 'ok', 'Thank you, how much is it?', 'Not today, but Thursday at 2 PM works', 'let me think about it', 'can you call me back?', 'Have a good day? What do you mean', 'yes please',
    // A goodbye word mid-message, a day that works, a long message with substance.
    'Thanks for the info, how long does install take', 'Not today, but tomorrow morning works', 'Not today but Thursday is better', 'Do you have any other time slots',
    'not right now but my doors are terrible, they leak every storm and the bills keep going up']) {
    assert.equal(isLeadSignOff(t), false, t);
  }
  assert.equal(leadWillReachOut(MSG_1057), true);
  assert.equal(leadWillReachOut(MSG_1055), false);
});

// ── the planner ───────────────────────────────────────────────────────────

test('10:55: "… Have a good day." is a goodbye, not a third price ask (no promised call)', () => {
  const p = plan({ trigger: MSG_1055, conversation: [...ERICA, ...T(['i', MSG_1055])] });
  assert.equal(p.step, 'sign_off');
  assert.equal(p.handoff, null, 'nothing filed, no call promised');
  assert.equal(p.booking.allowed, false);
  assert.equal((p.slots_to_offer || []).length, 0);
  assert.equal(p.fixed_line, LINES.sign_off('Erica'));
  assert.doesNotMatch(p.fixed_line, /\?|\d{1,2}:\d{2}/);
});

test('10:57: "I can call back when I have more time. Ty" gets a goodbye, not the same two times', () => {
  const p = plan({ trigger: MSG_1057, conversation: [...ERICA, ...T(['i', MSG_1055], ['o', BOT_1056], ['i', MSG_1057])] });
  assert.equal(p.step, 'sign_off');
  assert.equal(p.lead_will_reach_out, true);
  assert.equal((p.slots_to_offer || []).length, 0);
});

test('10:58 draft: the times, the question and our "check back" all go', () => {
  const p = plan({ trigger: MSG_1057, conversation: [...ERICA, ...T(['i', MSG_1055], ['o', BOT_1056], ['i', MSG_1057])] });
  const out = enforceNepqPlan(DRAFT_1058, p);
  assert.doesNotMatch(out.text, /\?/);
  assert.doesNotMatch(out.text, /\d{1,2}:\d{2}/);
  assert.doesNotMatch(out.text, /check back/i, 'she said SHE would call');
  assert.match(out.text, /Erica/);
  // A goodbye where WE are asked to follow up keeps our check-back line.
  const later = plan({ trigger: 'Not right now. Have a good day', conversation: T(['i', 'Not right now. Have a good day']) });
  assert.match(enforceNepqPlan("No problem. I'll check back next week. Have a great day.", later).text, /check back next week/);
});

test('a goodbye after a booking thanks them; no Reveal question', () => {
  const p = plan({ trigger: 'Thank you, have a great day', conversation: T(['o', "You're all set for tomorrow at 10:00 AM ET."], ['i', 'Thank you, have a great day']) });
  assert.equal(p.step, 'sign_off');
  assert.equal(p.fixed_line, LINES.sign_off('Erica', true));
});

test('a bare "Enjoy." is a sign-off line, and no ask is glued after one', () => {
  assert.equal(isSignOffLine('Enjoy.'), true);
  assert.equal(isSignOffLine('Enjoy!'), true);
  assert.equal(isSignOffLine('Enjoy the new windows when they come?'), false);
  const ref = 'Great. Which works better, tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET?';
  assert.equal(appendReferenceAsk("No problem, Erica. I'll check back next week. Enjoy.", ref, ['missing_time:x']), null);
  assert.ok(appendReferenceAsk('Good to hear.', ref, ['no_question']), 'a plain acknowledgment still gets the ask');
});

test('a question written as a statement ("…, right.") is dropped before the reference ask goes on', () => {
  // 2026-10-13 live sim, Erica's thread on chat.
  const ref = "Fair question. Every home is different: the price depends on the size, the style and the impact glass. What style are you thinking about, and roughly how big is the opening?";
  const draft = 'Our specialist measures everything on site and gives you exact pricing then. For now, the bay window you mentioned is 6 feet wide, right.';
  const out = appendReferenceAsk(draft, ref, ['no_question']);
  assert.equal(out, 'Our specialist measures everything on site and gives you exact pricing then. What style are you thinking about, and roughly how big is the opening?');
  assert.equal(appendReferenceAsk('The opening is 6 feet wide, correct.', ref, ['no_question']), null, 'nothing left: the backup line ships');
  assert.ok(appendReferenceAsk("That's right, it's free.", ref, ['no_question']), 'a plain statement is kept');
});

test('"We\'re here to help." after an answer leaves the offer open: the pick still books', () => {
  const offer = 'I have tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET. Which works better?';
  const p = plan({ knownOpenings: true, knownDecisionMakers: true, trigger: 'the first one', conversation: T(['o', offer], ['i', 'is it free?'], ['o', "Yes, it's free. We're here to help."], ['i', 'the first one']) });
  assert.equal(p.step, 'confirm');
});

test('a held time\'s own decision-maker question is never mistaken for the gate', () => {
  const hold = "Great, I'm holding tomorrow at 10:00 AM ET for you. Will anyone else be part of the decision?";
  const p = plan({ knownOpenings: true, trigger: 'just me', conversation: T(['o', 'I have tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET. Which works better?'], ['i', 'the first one'], ['o', hold], ['i', 'just me']) });
  assert.equal(p.step, 'collect');
});

test('our hand-off closes the open offer: the old times are never re-offered', () => {
  const p = plan({ trigger: 'ok', conversation: [...ERICA, ...T(['i', 'how much?'], ['o', BOT_1056], ['i', 'ok'])] });
  assert.notEqual(p.step, 'offer_slots');
  assert.equal((p.slots_to_offer || []).length, 0);
});

test('the same two times never go out a third time in a row', () => {
  const offer = 'I have tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET. Which works better?';
  const p = plan({ knownOpenings: true, knownDecisionMakers: true, trigger: 'my address is 12 Main St', conversation: T(['o', offer], ['i', 'hmm'], ['o', offer], ['i', 'my address is 12 Main St']) });
  assert.equal(p.step, 'ask_day');
});

test('a layer3 "NO times" script: the plan offers no times that turn', () => {
  const bridge = 'Based on what you told me, the next step would be a free visit at your home. Would that help?';
  const args = { knownOpenings: true, knownDecisionMakers: true, trigger: 'yes', conversation: T(['o', bridge], ['i', 'yes']) };
  assert.equal(plan(args).step, 'offer_slots');
  const p = plan({ ...args, directiveNoTimes: true });
  assert.equal(p.step, 'directive_no_times');
  assert.equal((p.slots_to_offer || []).length, 0);
  assert.equal(p.booking.allowed, false);
});

// ── the price play (the owner, 2026-10-13) ────────────────────────────────

test("Erica's first price ask gets the scoping question; her count was already known", () => {
  const conv = ERICA.slice(0, 5);
  const p = plan({ trigger: conv[4].text, conversation: conv });
  assert.equal(p.objection?.type, 'price');
  assert.equal(p.fixed_line, LINES.price_scope(true));
  assert.equal((p.slots_to_offer || []).length, 0);
});

// ── the decision maker, once, before the first times (the owner, 2026-10-13) ──

test('a yes to the visit: the decision-maker question, then any answer gets the times', () => {
  const bridge = 'Based on what you told me, the next step would be a free visit at your home. Would that help?';
  const first = plan({ knownOpenings: true, trigger: 'Yes', conversation: T(['o', bridge], ['i', 'Yes']) });
  assert.equal(first.step, 'qualify');
  assert.equal(first.qualify_item, 'decision_makers');
  assert.equal((first.slots_to_offer || []).length, 0);
  const ask = first.fixed_line;
  for (const [answer, known] of [['my wife', 'Yes'], ['No', 'Solo Owner'], ['just me', 'Solo Owner'], ['hmm not sure', 'Uncertain']]) {
    const p = plan({ knownOpenings: true, trigger: answer, conversation: T(['o', bridge], ['i', 'Yes'], ['o', ask], ['i', answer]) });
    assert.equal(p.step, 'offer_slots', answer);
    assert.equal(p.dm_known, known, answer);
    assert.equal(p.slots_to_offer.length, 2, answer);
  }
  // A "No" there is an answer, not a first no: a no to the times is the first.
  const p = plan({ knownOpenings: true, trigger: 'neither', conversation: T(['o', bridge], ['i', 'Yes'], ['o', ask], ['i', 'No'], ['o', 'I have tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET. Which works better?'], ['i', 'neither']) });
  assert.equal(p.handoff, null);
});

test('a lead past its demo is never asked the decision-maker question', () => {
  const bridge = 'Based on what you told me, the next step would be a free visit at your home. Would that help?';
  const p = plan({ knownOpenings: true, postDemoLead: true, trigger: 'Yes', conversation: T(['o', bridge], ['i', 'Yes']) });
  assert.notEqual(p.qualify_item, 'decision_makers');
});

// ── no promise, no repeat, no call to an opted-out lead ───────────────────

test('a goodbye never records a promised call', () => {
  assert.equal(shouldRecordPromise({ trigger: MSG_1057, plan: null }), false);
  assert.equal(shouldRecordPromise({ trigger: 'ok', plan: { step: 'sign_off' } }), false);
  assert.equal(shouldRecordPromise({ trigger: 'can you call me?', plan: { step: 'handoff' } }), true);
});

test('checkReply: times after a goodbye, and the same two times a third time', () => {
  const bad = checkReply(DRAFT_1058, { channel: 'sms', inbound: MSG_1057 });
  assert.ok(bad.violations.some(v => v.code === 'times_after_sign_off'));
  assert.equal(checkReply('Sounds good, Erica. We\'re here whenever you\'re ready. Have a great day.', { channel: 'sms', inbound: MSG_1057 }).violations.some(v => v.code === 'times_after_sign_off'), false);
  const offer = 'I have tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET. Which works better?';
  const conv = T(['o', offer], ['i', 'hmm'], ['o', `Sure. ${offer}`], ['i', 'ok']);
  assert.ok(checkReply(`Which works better, tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET?`, { channel: 'sms', inbound: 'ok', conversation: conv }).violations.some(v => v.code === 'repeat_slot_offer'));
  assert.equal(checkReply('I have Fri at 2:00 PM ET or Sat at 10:00 AM ET. Which works better?', { channel: 'sms', inbound: 'ok', conversation: conv }).violations.some(v => v.code === 'repeat_slot_offer'), false);
});

test('an opt-out cancels the promised call and the Five9 push', () => {
  assert.equal(optedOutOfCalls(['dnc-sms']), true);
  assert.equal(optedOutOfCalls(['suppress:dnc-reply']), true);
  assert.equal(optedOutOfCalls(['stop-bot']), false, 'the bot switch is not an opt-out');
  assert.equal(optedOutOfCalls([]), false);
  assert.equal(optedOutOfCalls(null), false, 'unreadable changes nothing');
  assert.deepEqual(readRequeueResult({ status: 'completed', result: { action: 'requeue_blocked_opt_out' } }), { status: 'opted_out' });
});

// 2026-10-13, the post-merge simulation of Erica's thread: the classifier read
// "I can call back when I have more time. Ty" as CALLBACK, the planner handed
// off, and the reply promised "We'll have someone from our team give you a call
// when it's a better time." (a Five9 Callback Request she never asked for).
test('the classifier\'s CALLBACK on "I can call back…" is a goodbye, not a call request', async () => {
  const { enforceSignOff } = await import('../src/agentic/sign-off.js');
  const p = plan({ trigger: MSG_1057, callbackRequested: true, conversation: [...ERICA, ...T(['i', MSG_1055], ['o', LINES.sign_off('Erica')], ['i', MSG_1057])] });
  assert.equal(p.step, 'sign_off');
  assert.equal(p.handoff, null);
  // A real call request still is one, classifier or words.
  assert.equal(plan({ trigger: 'Can someone call me back tomorrow?', conversation: T(['i', 'Can someone call me back tomorrow?']) }).handoff?.reason, 'callback_request');
  assert.equal(plan({ trigger: 'yes', callbackRequested: true, conversation: T(['i', 'yes']) }).handoff?.reason, 'callback_request');
  // The promise is dropped by both guards.
  const draft = "Sounds good, Erica. We'll have someone from our team give you a call when it's a better time.";
  const out = enforceNepqPlan(draft, p);
  assert.doesNotMatch(out.text, /give you a call/);
  const last = enforceSignOff(draft, { inbound: MSG_1057 });
  assert.equal(last.changed, true);
  assert.doesNotMatch(last.text, /give you a call/);
  // A goodbye with no "I'll call you" keeps our call line (they did not say they would call).
  assert.equal(enforceSignOff("Thanks. Someone from our team will give you a call tomorrow.", { inbound: 'Have a good day' }).changed, false);
});

// 2026-10-13, the post-merge live-chat simulation: the first price ask came back
// as "…Want to get on the calendar for that?" instead of the scoping question.
test('the first price ask must end on the scoping question, not a calendar ask', () => {
  const p = plan({ channel: 'livechat', knownOpenings: true, trigger: 'How much for 12 windows?', conversation: T(['i', 'How much for 12 windows?']) });
  const bad = 'Every home is different, so the price depends on the window sizes. Rather than guess wrong, we do a free in-home assessment. Want to get on the calendar for that?';
  const out = enforceNepqPlan(bad, p);
  assert.ok(out.failed.length, 'the calendar ask fails the reference check');
  assert.equal(out.text, LINES.price_scope(true));
  const good = 'Fair question. Every home is different, the price depends on size, style and the impact glass. What style are you thinking of, and how big are the openings?';
  assert.deepEqual(enforceNepqPlan(good, p).failed, []);
});

test('"you just said that" with no times: the decision-maker question goes alone, no name ask after it', () => {
  // 2026-10-13 bot gate (quote/livechat): "Is anyone else part of the decision
  // on this, like a spouse or partner? What's your first name?"
  const conv = T(
    ['i', 'Hi, I would like to get a quote on 12 windows and 2 sliding glass doors.'],
    ['o', 'Fair question. Every home is different: the price depends on the size, the style and the impact glass. What style are you thinking about, and roughly how big is the opening?'],
    ['i', 'I just want a good price.'],
    ['o', 'Totally fair. Every home is different, so an exact number comes from measuring. The next step would be a free visit to measure. Would that be helpful?'],
  );
  const p = planNepqTurn({ channel: 'livechat', nowMs: OPEN_MS, slots: [], tzLabel: 'ET', conversation: conv, trigger: 'you just said that.' });
  assert.equal(p.qualify_item, 'decision_makers');
  assert.equal(p.ask_contact, false);
});

test('an evening asked for before the gate questions is honored once the decision maker is answered', () => {
  // 2026-10-13 bot gate (book_it_evening_spouse, both bots): "Can someone come
  // out in the evening?" … "Just me." got tomorrow at 2 PM or Thursday at 10 AM.
  const ALL = [
    { iso: '2026-10-14T14:00:00-04:00', day: 'Wed, Oct 14', rel: 'tomorrow', time: '2:00 PM' },
    { iso: '2026-10-14T18:00:00-04:00', day: 'Wed, Oct 14', rel: 'tomorrow', time: '6:00 PM' },
    { iso: '2026-10-15T10:00:00-04:00', day: 'Thu, Oct 15', time: '10:00 AM' },
    { iso: '2026-10-15T18:00:00-04:00', day: 'Thu, Oct 15', time: '6:00 PM' },
  ];
  const conv = T(
    ['i', 'I need new windows. Can someone come out in the evening?'],
    ['o', 'We can definitely help with that. We do evening appointments. How many windows and doors are you looking to get a quote on?'],
    ['i', 'About 10 windows.'],
    ['o', 'Thanks for that. Is anyone else part of the decision on this, like a spouse or partner?'],
  );
  // The lead's "Just me." already allows a booking (the discipline read).
  const discipline = { booking: { allowed: true, reason: 'lead_answered_decision_maker_ask' }, decision_makers: { status: 'sole' } };
  const p = planNepqTurn({ channel: 'livechat', nowMs: OPEN_MS, slots: [ALL[0], ALL[2]], allSlots: ALL, tzLabel: 'ET', conversation: conv, trigger: 'Just me.', discipline });
  assert.equal(p.step, 'offer_slots');
  assert.deepEqual(p.slots_to_offer.map(s => s.time), ['6:00 PM', '6:00 PM']);
  // A time named in the answer itself still wins.
  const named = planNepqTurn({ channel: 'livechat', nowMs: OPEN_MS, slots: [ALL[0], ALL[2]], allSlots: ALL, tzLabel: 'ET', conversation: conv, trigger: 'Just me. Thursday morning works', discipline });
  assert.ok(named.slots_to_offer.some(s => s.time === '10:00 AM'), JSON.stringify(named.slots_to_offer));
});
