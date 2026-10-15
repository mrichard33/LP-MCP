/**
 * 2026-10-15 (Guest Visitor pkjiz, cuOfA4m6K74hhaFtodLV, live chat).
 *
 * "spouse and were available Saturday 11am - 2pm" was read as an exact 11 AM
 * pick, so the window was dropped and the chat offered 10 AM on two Saturdays a
 * week apart. Then "24th", "24th" and "October 24th" were not read as a pick:
 * the bot asked "which works better?", then "What day works best?", then
 * offered the same two times again, and never reached the name.
 *
 * Mark: "The bot should have responded with something like, 'Unfortunately, I
 * do not have that time, but I have a 2:00 or I have a 10:00.'"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test';

const { planNepqTurn } = await import('../src/agentic/nepq-planner.js');
const { parseDayPreference, slotsForPreference, preferenceOfferLine, parseTimeRange } = await import('../src/agentic/day-preference.js');
const { pickSlot, slotDateMentioned } = await import('../src/live-chat/cancel-flow.js');

const NOW = Date.parse('2026-10-15T13:35:00Z'); // Thu Oct 15, 9:35 AM ET
const slot = (iso, day, time) => ({ iso, day, time, dayOfWeek: 'Saturday' });
const ALL = [
  slot('2026-10-17T10:00:00-04:00', 'Sat, Oct 17', '10:00 AM'),
  slot('2026-10-17T14:00:00-04:00', 'Sat, Oct 17', '2:00 PM'),
  slot('2026-10-17T18:00:00-04:00', 'Sat, Oct 17', '6:00 PM'),
  slot('2026-10-24T10:00:00-04:00', 'Sat, Oct 24', '10:00 AM'),
  slot('2026-10-24T14:00:00-04:00', 'Sat, Oct 24', '2:00 PM'),
];
const OFFERED = [ALL[0], ALL[3]];
const OFFER = 'Perfect. I have Sat, Oct 17 at 10:00 AM ET or Sat, Oct 24 at 10:00 AM ET. What day works best for the visit?';

test('a clock range is a window, not a pick', () => {
  assert.deepEqual(parseTimeRange('Saturday 11am - 2pm'), { after: 11, before: 14 });
  assert.deepEqual(parseTimeRange('between 11 and 2'), { after: 11, before: 14 });
  assert.deepEqual(parseTimeRange('1-4pm'), { after: 13, before: 16 });
  assert.equal(parseTimeRange('10-24'), null, 'a date with a dash is not a range');
  assert.equal(parseTimeRange('8 windows'), null);
  const pref = parseDayPreference('spouse and were available Saturday 11am - 2pm');
  assert.deepEqual(pref.days, [6]);
  assert.equal(pref.after, 11);
  assert.equal(pref.before, 14);
  // An exact time is still a pick.
  assert.equal(parseDayPreference('Saturday at 2 PM'), null);
});

test('nothing in their window: the two openings nearest it, on their day, said plainly', () => {
  const pref = parseDayPreference('spouse and were available Saturday 11am - 2pm');
  const picked = slotsForPreference(ALL, pref, { nowMs: NOW });
  assert.equal(picked.matched, false);
  assert.deepEqual(picked.slots.map(s => `${s.day} ${s.time}`), ['Sat, Oct 17 2:00 PM', 'Sat, Oct 17 10:00 AM']);
  const line = preferenceOfferLine(pref, picked, 'ET');
  assert.match(line, /^Unfortunately I don't have anything open for Saturday between 11 and 2, but I have Sat, Oct 17 at 2:00 PM ET or Sat, Oct 17 at 10:00 AM ET\./);
  // The offer stays readable by SLOT_OFFER_RX / offeredSlots ("I have … or …").
  assert.match(line, /I have .+ or .+/);
});

test('a window with a real opening inside it still matches', () => {
  const pref = parseDayPreference('Saturday between 1pm and 3pm');
  const picked = slotsForPreference(ALL, pref, { nowMs: NOW });
  assert.equal(picked.matched, true);
  assert.equal(picked.slots[0].time, '2:00 PM');
});

test('a calendar date picks the offered slot on that date', () => {
  for (const t of ['24th', 'October 24th', 'the 24th', 'Oct 24', '10/24', '24']) {
    assert.equal(pickSlot(t, OFFERED)?.day, 'Sat, Oct 24', t);
  }
  assert.equal(pickSlot('17th', OFFERED)?.day, 'Sat, Oct 17');
  assert.equal(slotDateMentioned('I have 24 windows', ALL[3]), false, 'a count is not a date');
  assert.equal(slotDateMentioned('$24th', ALL[3]), false);
});

test('the planner reads "24th" and "October 24th" as a pick of the open offer, not a re-ask', () => {
  for (const reply of ['24th', 'October 24th']) {
    const conv = [
      { direction: 'inbound', text: 'spouse and were available Saturday 11am - 2pm' },
      { direction: 'outbound', text: OFFER },
      { direction: 'inbound', text: reply },
    ];
    const plan = planNepqTurn({ knownOpenings: true, knownDecisionMakers: true, channel: 'livechat', trigger: reply, conversation: conv, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
    assert.equal(plan.required_move, 'confirm', reply);
  }
  // After our "What day works best?", a date is a day, not a vague answer.
  const conv2 = [
    { direction: 'outbound', text: OFFER },
    { direction: 'inbound', text: '24th' },
    { direction: 'outbound', text: 'No problem. What day works best for you?' },
    { direction: 'inbound', text: 'October 24th' },
  ];
  const plan2 = planNepqTurn({ knownOpenings: true, knownDecisionMakers: true, channel: 'livechat', trigger: 'October 24th', conversation: conv2, slots: OFFERED, allSlots: ALL, tzLabel: 'ET', nowMs: NOW });
  assert.notEqual(plan2.step, 'ask_day', 'never asks the day again after they gave a date');
});
