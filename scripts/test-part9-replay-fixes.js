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

test('no hurricane-season pressure in a reply', async () => {
  const { enforceNepqPlan } = await import('../src/agentic/nepq-planner.js');
  const plan = planNepqTurn({ channel: 'sms', trigger: 'I need new windows', conversation: [{ direction: 'inbound', text: 'I need new windows' }], nowMs: NOW });
  const out = enforceNepqPlan("Hurricane season tends to be when that call comes in for a lot of folks. What's going on with your current windows that got you looking?", plan);
  assert.equal(out.text, "What's going on with your current windows that got you looking?");
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
