/**
 * Part 9 (2026-10-03): fixes from replaying Mark's chats after #1140 went
 * live. Each test names the replay turn it comes from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test';

const { planNepqTurn, nearestToClock, typedClock, typedClockLabel, LINES } = await import('../src/agentic/nepq-planner.js');

const NOW = Date.parse('2026-10-03T00:30:00Z'); // Fri Oct 2, 8:30 PM ET
const slot = (iso, day, time, dayOfWeek, rel = null) => ({ iso, day, time, dayOfWeek, ...(rel ? { rel } : {}) });
const ALL = [
  slot('2026-10-03T18:00:00-04:00', 'Sat, Oct 3', '6:00 PM', 'Saturday', 'tomorrow'),
  slot('2026-10-03T19:00:00-04:00', 'Sat, Oct 3', '7:00 PM', 'Saturday', 'tomorrow'),
  slot('2026-10-04T10:00:00-04:00', 'Sun, Oct 4', '10:00 AM', 'Sunday'),
  slot('2026-10-04T14:00:00-04:00', 'Sun, Oct 4', '2:00 PM', 'Sunday'),
  slot('2026-10-05T14:00:00-04:00', 'Mon, Oct 5', '2:00 PM', 'Monday'),
];
const OFFERED = [ALL[0], ALL[2]];

test('typed clock helpers', () => {
  assert.equal(typedClock('Fine lets book for 2 PM.'), 14 * 60);
  assert.equal(typedClock('10:30am works'), 10 * 60 + 30);
  assert.equal(typedClock('Mark'), null);
  assert.equal(typedClockLabel('book for 2 p.m.'), '2 PM');
  assert.deepEqual(nearestToClock(ALL, 14 * 60, 'book for 2 PM', NOW).map(s => s.day), ['Sun, Oct 4', 'Mon, Oct 5']);
});

// mark522, live chat: "Fine lets book for 2 PM." with 6 PM and Sun 10 AM on
// the table was taken as a pick; the chat asked for a name, an email, and
// never booked.
test('a typed time we do not have: say so, offer the two openings nearest it', () => {
  const conv = [
    { direction: 'inbound', text: 'Well, we spoke about it in the past.' },
    { direction: 'outbound', text: "Would it be easier to pick a time when you're both home? I have tomorrow at 6:00 PM ET or Sun, Oct 4 at 10:00 AM ET." },
    { direction: 'inbound', text: 'Fine lets book for 2 PM.' },
  ];
  for (const channel of ['sms', 'livechat']) {
    const plan = planNepqTurn({ channel, trigger: 'Fine lets book for 2 PM.', conversation: conv, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
    assert.equal(plan.required_move, 'offer_slots', channel);
    assert.equal(plan.fixed_line, 'Sure. For 2 PM, I have Sun, Oct 4 at 2:00 PM ET or Mon, Oct 5 at 2:00 PM ET. Which works better?');
  }
  // No 2 PM anywhere: say it is not open, and offer the nearest.
  const no2 = ALL.filter(s => s.time !== '2:00 PM');
  const none = planNepqTurn({ channel: 'sms', trigger: 'Fine lets book for 2 PM.', conversation: conv, slots: OFFERED, allSlots: no2, tzLabel: 'ET', nowMs: NOW });
  assert.match(none.fixed_line, /^2 PM isn't open, but I have .+ or .+\. Which works better\?$/);
  // An offered time typed out is still the pick.
  const pick = planNepqTurn({ channel: 'sms', trigger: '6 PM works', conversation: [...conv.slice(0, 2), { direction: 'inbound', text: '6 PM works' }], slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(pick.required_move, 'confirm');
  // "Can't do 2 PM" is not a request for 2 PM.
  const cant = planNepqTurn({ channel: 'sms', trigger: "I can't do 2 PM", conversation: [...conv.slice(0, 2), { direction: 'inbound', text: "I can't do 2 PM" }], slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.notEqual(cant.step === 'offer_slots' && /2 PM isn't open/.test(cant.fixed_line || ''), true);
});

// 2026-10-03 replay (#1141 live): the live chat loads the two slots nearest
// the typed time, so "2 PM" WAS among them and read as a pick of an offer
// that never named 2 PM.
test('the typed time is checked against the times we offered, not the ones loaded near it', () => {
  const conv = [
    { direction: 'outbound', text: "Would it be easier to pick a time when you're both home? I have tomorrow at 6:00 PM ET or Sun, Oct 4 at 10:00 AM ET." },
    { direction: 'inbound', text: 'Fine lets book for 2 PM.' },
  ];
  const nearTwo = [ALL[2], ALL[3]]; // Sun 10 AM and Sun 2 PM: one 2 PM among them
  const plan = planNepqTurn({ channel: 'livechat', trigger: 'Fine lets book for 2 PM.', conversation: conv, slots: nearTwo, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'offer_slots');
  assert.equal(plan.fixed_line, 'Sure. For 2 PM, I have Sun, Oct 4 at 2:00 PM ET or Mon, Oct 5 at 2:00 PM ET. Which works better?');
});

test('a day and time they typed that is open is the pick, even when we offered others', () => {
  const conv = [
    { direction: 'outbound', text: 'I have tomorrow at 6:00 PM ET or Sun, Oct 4 at 10:00 AM ET. Which works better?' },
    { direction: 'inbound', text: 'Sunday at 2 PM please' },
  ];
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Sunday at 2 PM please', conversation: conv, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'confirm');
  assert.equal(plan.slots_to_offer[0].day, 'Sun, Oct 4');
  assert.equal(plan.slots_to_offer[0].time, '2:00 PM');
  assert.match(plan.last_offer, /Sun, Oct 4 at 2:00 PM/);
});

// mark522 / chat612 SMS: the model wrote the offered times its own way and
// the check could not see them, so each turn cost a re-write (15-35s) and
// then shipped the backup line.
test('a real time counts however the reply words it', async () => {
  const { slotMentionIndex, offeredSlots } = await import('../src/live-chat/cancel-flow.js');
  const sat6 = ALL[0], sat7 = ALL[1], sun10 = ALL[2], sun2 = ALL[3];
  const seen = (text) => [sat6, sat7, sun10, sun2].map(s => slotMentionIndex(text, s) >= 0);
  assert.deepEqual(seen('Does 6 or 7 PM tomorrow work for the visit?'), [true, true, false, false]);
  assert.deepEqual(seen('I have tomorrow at 6 or 7 PM. Which works?'), [true, true, false, false]);
  assert.deepEqual(seen('6 PM tomorrow or 10 AM on Sunday, which is better?'), [true, false, true, false]);
  assert.deepEqual(seen('Tomorrow evening at 6:00 or 7:00 pm?'), [true, true, false, false]);
  assert.deepEqual(seen('I have Sat, Oct 3 at 6:00 PM or Oct 4th at 10 am.'), [true, false, true, false]);
  // Never the wrong day: 2 PM here belongs to tomorrow, not Sunday.
  assert.deepEqual(seen('Sunday at 10 AM or tomorrow at 2 PM?'), [false, false, true, false]);
  // "The first one" is the first time named.
  assert.deepEqual(offeredSlots('6 PM tomorrow or 10 AM on Sunday?', [sun10, sat6]).map(s => s.time), ['6:00 PM', '10:00 AM']);
});

// 2026-10-03 (Mark): hurricane and storm language is allowed; it is core to
// what we sell. Only false urgency claims ("peak of hurricane season") go.
test('hurricane and storm language is kept in a reply', async () => {
  const { enforceNepqPlan } = await import('../src/agentic/nepq-planner.js');
  const plan = planNepqTurn({ channel: 'sms', trigger: 'I need new windows', conversation: [{ direction: 'inbound', text: 'I need new windows' }], nowMs: NOW });
  const draft = "Hurricane season tends to be when that call comes in for a lot of folks. What's going on with your current windows that got you looking?";
  assert.equal(enforceNepqPlan(draft, plan).text, draft);
});

const WED = [
  slot('2026-10-07T10:00:00-04:00', 'Wed, Oct 7', '10:00 AM', 'Wednesday'),
  slot('2026-10-07T19:00:00-04:00', 'Wed, Oct 7', '7:00 PM', 'Wednesday'),
];

// chat612 SMS: "Usually on Wednesdays" after a product question got the bridge.
test('a message that is only a day is their availability: two real times that day', () => {
  const conv = [
    { direction: 'inbound', text: 'Ok, what do you need? Also is that free?' },
    { direction: 'outbound', text: "Yes, it's free. Is it just the drafty windows, or the whole house?" },
    { direction: 'inbound', text: 'Usually on Wednesdays' },
  ];
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Usually on Wednesdays', conversation: conv, slots: OFFERED, allSlots: [...ALL, ...WED], tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'offer_slots');
  assert.match(plan.fixed_line, /^Wednesdays work\. I have Wed, Oct 7 at 10:00 AM ET or Wed, Oct 7 at 7:00 PM ET\./);
});

// chat612 SMS: an address in reply to an offer got a dead end with no question.
test('a detail instead of a pick goes back to the times; the third time asks the day', () => {
  const offer = 'I have tomorrow at 6:00 PM ET or Sun, Oct 4 at 10:00 AM ET. Which works better?';
  const conv = [{ direction: 'outbound', text: offer }, { direction: 'inbound', text: '12 Main St, Ocala FL 34470' }];
  const plan = planNepqTurn({ channel: 'sms', trigger: '12 Main St, Ocala FL 34470', conversation: conv, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'offer_slots');
  assert.match(plan.fixed_line, /tomorrow at 6:00 PM ET or Sun, Oct 4 at 10:00 AM ET/);
  const three = [
    { direction: 'outbound', text: offer }, { direction: 'inbound', text: 'Mark' },
    { direction: 'outbound', text: 'Great. Which works better, tomorrow at 6:00 PM ET or Sun, Oct 4 at 10:00 AM ET?' }, { direction: 'inbound', text: '9543792151' },
    { direction: 'outbound', text: 'Sounds good. Which one works for you, tomorrow at 6:00 PM ET or Sun, Oct 4 at 10:00 AM ET?' }, { direction: 'inbound', text: '12 Main St, Ocala FL 34470' },
  ];
  const p3 = planNepqTurn({ channel: 'sms', trigger: '12 Main St, Ocala FL 34470', conversation: three, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(p3.required_move, 'ask_day');
});

// 2026-10-03 replay (#1141 live): three SMS turns in a row got no reply
// because a planned "which works better?" was refused as a repeat of the
// already-"answered" time question.
test('a turn whose plan asks for a time reopens the time question', async () => {
  const { planAsksForTime } = await import('../src/response-generator.js');
  assert.equal(planAsksForTime({ required_move: 'offer_slots' }, 'live'), true);
  assert.equal(planAsksForTime({ required_move: 'ask_day' }, 'live'), true);
  assert.equal(planAsksForTime({ required_move: 'probe', slots_to_offer: [] }, 'live'), false);
  assert.equal(planAsksForTime({ required_move: 'offer_slots' }, 'shadow'), false);
  assert.equal(planAsksForTime(null, 'live'), false);
});

test('a re-ask names the same two times we just offered', () => {
  const conv = [
    { direction: 'outbound', text: "Sure. For 2 PM, I have Sun, Oct 4 at 2:00 PM ET or Mon, Oct 5 at 2:00 PM ET. Which works better?" },
    { direction: 'inbound', text: 'Mark' },
  ];
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Mark', conversation: conv, slots: [ALL[2], ALL[3]], allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'offer_slots');
  assert.match(plan.fixed_line, /Sun, Oct 4 at 2:00 PM ET or Mon, Oct 5 at 2:00 PM ET/);
  assert.deepEqual(plan.slots_to_offer.map(s => s.day), ['Sun, Oct 4', 'Mon, Oct 5']);
});

// 2026-10-03 replay (#1143 live): a booking offer ending "Which one works
// better?" read as the cancel flow's slot offer; "She should be able to make
// it" became a failed reschedule and a #dispatch card.
test('the cancel flow answers only inside a flow a cancel request started', async () => {
  const { planCancelTurn } = await import('../src/live-chat/cancel-flow.js');
  const thread = [
    { direction: 'inbound', text: '12 Main St, Ocala FL 34470' },
    { direction: 'outbound', text: "So we're looking at Sunday, Oct 4 at 2:00 PM ET or Monday, Oct 5 at 2:00 PM ET for you and your wife. Which one works better?" },
    { direction: 'inbound', text: 'She should be able to make it' },
  ];
  assert.equal(planCancelTurn({ body: 'She should be able to make it', thread, known: {} }), null);
  // Inside a real flow the same offer is still read as the flow's.
  const flow = [
    { direction: 'inbound', text: 'I need to cancel my appointment' },
    { direction: 'outbound', text: 'Sure. I have Sat, Oct 3 at 6:00 PM or Sun, Oct 4 at 10:00 AM ET open. Which one works better for you?' },
    { direction: 'inbound', text: 'The first one' },
  ];
  assert.equal(planCancelTurn({ body: 'The first one', thread: flow, known: {} }).step, 'pick_slot');
});

// 2026-10-03 logs: the model often wrote only an acknowledgment, and each such
// SMS turn cost a 10-35s re-write that often missed too.
test('a draft that only acknowledges keeps its words and gets the planned ask', async () => {
  const { enforceNepqPlan, appendReferenceAsk } = await import('../src/agentic/nepq-planner.js');
  const conv = [
    { direction: 'outbound', text: 'Sure. For 2 PM, I have Sun, Oct 4 at 2:00 PM ET or Mon, Oct 5 at 2:00 PM ET. Which works better?' },
    { direction: 'inbound', text: 'She should be able to make it' },
  ];
  const plan = planNepqTurn({ channel: 'sms', trigger: 'She should be able to make it', conversation: conv, slots: [ALL[3], ALL[4]], allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'offer_slots');
  const out = enforceNepqPlan('Good to hear she can make it.', plan);
  assert.deepEqual(out.failed, []);
  assert.ok(out.changes.includes('reference_ask_appended'));
  assert.match(out.text, /^Good to hear she can make it\. .*Sun, Oct 4 at 2:00 PM ET or Mon, Oct 5 at 2:00 PM ET\?$/);
  // Never over a draft that asks its own question or names another time.
  assert.equal(appendReferenceAsk('Does 3 PM work?', 'Which works better, Sun at 2:00 PM or Mon at 2:00 PM?', ['other_time']), null);
  assert.equal(appendReferenceAsk('I can do 3 PM.', 'Which works better, Sun at 2:00 PM or Mon at 2:00 PM?', ['missing_time:x']), null);
  // A bridge draft that misses "the next step" is not saved by half a line:
  // the patched text still fails the check, so the backup ships instead.
  const { checkAgainstReference } = await import('../src/agentic/nepq-planner.js');
  const bridge = 'Based on what you told me, this could work. The next step would be a free visit. Would that help?';
  const half = appendReferenceAsk('Thanks.', bridge, ['missing:name "the next step"']);
  assert.ok(checkAgainstReference(half, bridge).length > 0);
});

test('spouse and price plays read naturally worded drafts', async () => {
  const { checkAgainstReference, LINES } = await import('../src/agentic/nepq-planner.js');
  assert.deepEqual(checkAgainstReference('Makes sense. How does she feel about swapping out the old ones?', LINES.spouse_1), []);
});

// 2026-10-03 replay (#1144 live): a bare phone number built no booking
// context, the gate was skipped, and the SMS visit booked with no address.
test('the SMS visit gate cannot be cleared by a turn that skipped it', async () => {
  const { smsGateMissing } = await import('../src/response-generator.js');
  assert.deepEqual(smsGateMissing(false, null), []);
  assert.deepEqual(smsGateMissing(true, null), ['address']);
  assert.deepEqual(smsGateMissing(true, { ok: false, missing: ['address', 'zip'] }), ['address', 'zip']);
  assert.deepEqual(smsGateMissing(true, { ok: true, missing: [] }), []);
});

test('after our "You\'re all set for…" the bot never offers times again', () => {
  const conv = [
    { direction: 'outbound', text: "You're all set for Wed, Oct 7 at 10:00 AM ET, Mark. Our team will reach out to confirm the details." },
    { direction: 'inbound', text: '12 Main St, Ocala FL 34470' },
  ];
  const plan = planNepqTurn({ channel: 'sms', trigger: '12 Main St, Ocala FL 34470', conversation: conv, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.step, 'booked');
  assert.notEqual(plan.required_move, 'offer_slots');
  // A cancel after it reopens booking.
  const after = [...conv, { direction: 'outbound', text: 'Done. Your Wed, Oct 7 appointment is cancelled.' }, { direction: 'inbound', text: 'Actually can we do Thursday?' }];
  assert.notEqual(planNepqTurn({ channel: 'sms', trigger: 'Actually can we do Thursday?', conversation: after, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW }).step, 'booked');
});

// 2026-10-03 replay: a GHL calendar timeout on the "Usually on Wednesdays"
// turn sent the bridge instead, and the booking was lost.
test('a day preference with no calendar read asks the time of day, then uses both', () => {
  const conv = [
    { direction: 'outbound', text: "Yes, it's free. Is it just the drafty windows, or the whole house?" },
    { direction: 'inbound', text: 'Usually on Wednesdays' },
  ];
  const noRead = planNepqTurn({ channel: 'sms', trigger: 'Usually on Wednesdays', conversation: conv, slots: [], allSlots: [], tzLabel: 'ET', nowMs: NOW });
  assert.equal(noRead.required_move, 'ask_day');
  assert.equal(noRead.fixed_line, 'Wednesdays work. What time of day is best for you?');
  // Next turn, calendar back: "mornings" + the Wednesday they gave.
  const next = [...conv, { direction: 'outbound', text: noRead.fixed_line }, { direction: 'inbound', text: 'Mornings' }];
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Mornings', conversation: next, slots: OFFERED, allSlots: [...ALL, ...WED], tzLabel: 'ET', nowMs: NOW });
  assert.equal(plan.required_move, 'offer_slots');
  assert.match(plan.fixed_line, /Wed, Oct 7 at 10:00 AM ET/);
  // Live chat's first pass (no calendar asked for yet) still waits for the read.
  const first = planNepqTurn({ channel: 'livechat', trigger: 'Usually on Wednesdays', conversation: conv, nowMs: NOW });
  assert.equal(first.day_preference_pending, true);
  assert.notEqual(first.required_move, 'ask_day');
});

// 2026-10-03 replay (#1146 live): the SMS gate read the name as missing after
// a bare "Mark" and asked "Who should I put the visit under?" instead of booking.
test('SMS booking reads a typed name from the thread', async () => {
  const { smsBookingTurn, nameFromThread } = await import('../src/agentic/sms-booking-turn.js');
  const thread = [
    { direction: 'outbound', text: "Great, I'm holding Wed, Oct 7 at 10:00 AM ET for you. What's your first name?" },
    { direction: 'inbound', text: 'Mark' },
    { direction: 'outbound', text: "Thanks, Mark. What's the street address for the visit, including the zip code?" },
    { direction: 'inbound', text: '12 Main St, Ocala FL 34470' },
    { direction: 'outbound', text: 'Will anyone else be part of the decision?' },
    { direction: 'inbound', text: 'Just me' },
  ];
  assert.equal(nameFromThread(thread), 'Mark');
  const wed = { iso: '2026-10-07T10:00:00-04:00', day: 'Wed, Oct 7', time: '10:00 AM', dayOfWeek: 'Wednesday' };
  const plan = { required_move: 'answer', step: 'collect', held_slot: { text: "Great, I'm holding Wed, Oct 7 at 10:00 AM ET for you." }, counters: {} };
  const facts = smsBookingTurn({ plan, trigger: 'Just me', thread, slots: [wed], gateMissing: ['name'] });
  assert.equal(facts.kind, 'book');
  assert.match(facts.fallback, /, Mark\./);
  // A bare word that was not an answer to our name ask is not a name.
  assert.equal(nameFromThread([{ direction: 'outbound', text: 'Which works better?' }, { direction: 'inbound', text: 'Mark' }]), null);
});

test('an open offer makes the live chat load times before it plans', async () => {
  const { wantsSlots } = await import('../src/live-chat/fast-lane.js');
  const conv = [
    { direction: 'outbound', text: "Sure. For 2 PM, I have tomorrow at 2:00 PM ET or Mon, Oct 5 at 2:00 PM ET. Which works better?" },
    { direction: 'inbound', text: 'Mark' },
  ];
  const first = planNepqTurn({ channel: 'livechat', trigger: 'Mark', conversation: conv, nowMs: NOW });
  assert.equal(first.offer_slots_pending, true);
  assert.equal(wantsSlots(first), true);
});

// 2026-10-03 replay (#1147 live), three gaps.
test('a typed time with no offer on the table makes the live chat load times', async () => {
  const { wantsSlots } = await import('../src/live-chat/fast-lane.js');
  const conv = [
    { direction: 'outbound', text: 'The next step would be a free visit at your home.' },
    { direction: 'inbound', text: 'Fine lets book for 2 PM.' },
  ];
  const first = planNepqTurn({ channel: 'livechat', trigger: 'Fine lets book for 2 PM.', conversation: conv, nowMs: NOW });
  assert.equal(wantsSlots(first), true);
});

test('our address ask is not a coverage question', async () => {
  const { planServiceAreaTurn } = await import('../src/agentic/service-area-turn.js');
  const conv = [
    { direction: 'outbound', text: 'That looks like a phone number. What address should the team come to? The street and zip are all I need.' },
    { direction: 'inbound', text: '12 Main St, Ocala FL 34470' },
  ];
  assert.equal(planServiceAreaTurn({ trigger: '12 Main St, Ocala FL 34470', conversation: conv }).active, false);
  // A real zip ask still is.
  const zipAsk = [{ direction: 'inbound', text: 'Do you serve Ocala?' }, { direction: 'outbound', text: "Happy to check that for you. What's your zip code?" }, { direction: 'inbound', text: '34470' }];
  assert.equal(planServiceAreaTurn({ trigger: '34470', conversation: zipAsk }).active, true);
});

test('a decision-maker ask in the model\'s own words is read back', async () => {
  const { dmAnswerFromThread } = await import('../src/agentic/booking-collect.js');
  const turns = [
    { direction: 'outbound', text: "Got it, 12 Main St. Is there anyone else on the home with you, or anyone else who'd weigh in on this?" },
    { direction: 'inbound', text: 'Just me' },
  ];
  assert.equal(dmAnswerFromThread(turns), 'Solo Owner');
});
