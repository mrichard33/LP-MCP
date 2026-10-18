/**
 * test-team-hours.js — 2026-10-02 (Mark): a same-day call is promised only
 * inside team hours (9–8 weekdays, 9–5 Saturday, 9–3 Sunday, ET).
 *
 * Run: node --test scripts/test-team-hours.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { isTeamOpen, nextTeamOpenLabel, requestedCallTime, enforceCallTiming } = await import('../src/agentic/team-hours.js');
const { planNepqTurn, LINES } = await import('../src/agentic/nepq-planner.js');

// ET is UTC-4 in October.
const at = (isoEt) => Date.parse(`${isoEt}-04:00`);
const MON_11AM = at('2026-10-05T11:00:00');
const MON_9PM = at('2026-10-05T21:00:00');
const SAT_6PM = at('2026-10-03T18:00:00');
const SUN_8AM = at('2026-10-04T08:00:00');
const SUN_4PM = at('2026-10-04T16:00:00');

test('team hours: weekdays 9–8, Saturday 9–5, Sunday 9–3', () => {
  assert.equal(isTeamOpen(MON_11AM), true);
  assert.equal(isTeamOpen(at('2026-10-05T19:59:00')), true);
  assert.equal(isTeamOpen(at('2026-10-05T20:00:00')), false);
  assert.equal(isTeamOpen(at('2026-10-03T16:30:00')), true);
  assert.equal(isTeamOpen(SAT_6PM), false);
  assert.equal(isTeamOpen(at('2026-10-04T14:59:00')), true);
  assert.equal(isTeamOpen(SUN_4PM), false);
  assert.equal(isTeamOpen(SUN_8AM), false);
});

test('next opening reads as words', () => {
  // 2026-10-18 (the user): the dialer cannot call at a set hour, so no clock time.
  assert.equal(nextTeamOpenLabel(MON_9PM), 'tomorrow morning');
  assert.equal(nextTeamOpenLabel(SUN_8AM), 'this morning');
  assert.equal(nextTeamOpenLabel(SAT_6PM), 'tomorrow morning');
  assert.equal(nextTeamOpenLabel(at('2026-10-02T21:00:00'), { dayOffset: 0 }), 'tomorrow morning');
  assert.equal(nextTeamOpenLabel(MON_11AM, { fromDow: 5, fromHour: 21, dayOffset: 4 }), 'Saturday morning');
});

test('a requested call time is checked against that day', () => {
  assert.equal(requestedCallTime('call me at 9pm', MON_11AM).ok, false);
  assert.equal(requestedCallTime('call me at 5', MON_11AM).ok, true);
  assert.equal(requestedCallTime('call me tomorrow at 7am', MON_11AM).ok, false);
  assert.equal(requestedCallTime('just call me back', MON_11AM), null);
});

test('after hours, "in the next few minutes" / "today" become the next opening', () => {
  const sms = 'We do not send crews same-day, but someone from our team will call you in the next few minutes to help. Have you covered it?';
  const out = enforceCallTiming(sms, SAT_6PM);
  assert.equal(out.changed, true);
  assert.match(out.text, /will call you tomorrow morning to help\./);
  assert.match(out.text, /Have you covered it\?$/);
  assert.match(enforceCallTiming('Our service team will call you today to get it scheduled.', MON_9PM).text, /call you tomorrow morning to get it scheduled/);
});

test('a promise that already names the opening is not given it twice (bot gate, 2026-10-18)', () => {
  // The planner's own after-hours line is a fixed point of the guard: it used to
  // swap only "today" for the label, giving "today at 9 AM ET at 9 AM ET".
  const plan = planNepqTurn({ channel: 'livechat', trigger: 'Your rep never showed up yesterday', nowMs: SUN_8AM });
  assert.equal(plan.handoff.reason, 'complaint');
  assert.match(plan.fixed_line, /call you this morning\./);
  assert.equal(enforceCallTiming(plan.fixed_line, SUN_8AM).text, plan.fixed_line);
  // The model's rewording reads the opening once, with no clock time.
  assert.equal(enforceCallTiming('Someone will call you today at 9 AM to get it sorted.', SUN_8AM).text, 'Someone will call you this morning to get it sorted.');
  // The live SMS (abb3b6c): the time came BEFORE "today", and the first "today"
  // in the sentence was the flagging, not the call.
  assert.equal(
    enforceCallTiming("I'm flagging this to our team today, and someone will call you at 9 AM ET today to make it right.", SUN_8AM).text,
    "I'm flagging this to our team today, and someone will call you this morning to make it right.");
  // A stale time from a model at night is replaced as a whole, not appended to.
  assert.equal(enforceCallTiming('Someone will call you today at 3 PM to sort it out.', MON_9PM).text, 'Someone will call you tomorrow morning to sort it out.');
});

test('after hours, no call is promised at a clock time the dialer cannot keep (the user, 2026-10-18)', () => {
  // The old label, copied by a model, becomes the morning.
  assert.equal(enforceCallTiming("I've flagged this, and someone will call you tomorrow at 9 AM ET.", MON_9PM).text, "I've flagged this, and someone will call you tomorrow morning.");
  assert.equal(enforceCallTiming('A team member will reach out on Monday at 9 AM.', SAT_6PM).text, 'A team member will reach out tomorrow morning.');
  // Not a call promise: left alone.
  assert.equal(enforceCallTiming('Your visit is tomorrow at 2 PM.', MON_9PM).changed, false);
  // A requested time inside hours is passed on, not promised.
  assert.equal(planNepqTurn({ channel: 'sms', trigger: 'Just call me at 5pm today', nowMs: MON_11AM }).fixed_line,
    "Got it. I'll have someone from our team call you, and I've let them know 5pm today works best for you.");
});

test('inside hours the same promise is left alone', () => {
  const t = 'Our service team will call you today to get it scheduled.';
  assert.deepEqual(enforceCallTiming(t, MON_11AM), { text: t, changed: false });
  // Not a call promise: untouched even after hours.
  assert.equal(enforceCallTiming("Today's a great day to look at windows.", MON_9PM).changed, false);
});

test('planner: after hours the hand-offs name when someone will call', () => {
  const night = planNepqTurn({ channel: 'livechat', trigger: 'A storm broke my window and water is coming in!', nowMs: MON_9PM });
  assert.equal(night.handoff.reason, 'emergency');
  assert.equal(night.fixed_line, "That's urgent. I've flagged it for our team, and someone will call you tomorrow morning.");
  const day = planNepqTurn({ channel: 'livechat', trigger: 'A storm broke my window and water is coming in!', nowMs: MON_11AM });
  assert.equal(day.fixed_line, LINES.handoff.emergency);
  const service = planNepqTurn({ channel: 'sms', trigger: 'You installed my windows last month and one is leaking', nowMs: SUN_4PM });
  // 2026-10-03 (Mark): service tells the lead a team member will reach out.
  assert.equal(service.fixed_line, "Sorry about that. I've passed this to our service team, and a team member will reach out tomorrow morning.");
});

test('planner: a call asked for outside hours gets the next opening', () => {
  assert.equal(planNepqTurn({ channel: 'sms', trigger: 'call me at 9pm tonight', nowMs: MON_11AM }).fixed_line,
    "Got it. That's outside our team's hours, so I'll have someone call you tomorrow morning.");
  assert.equal(planNepqTurn({ channel: 'sms', trigger: 'Just call me at 5pm today', nowMs: MON_11AM }).fixed_line,
    "Got it. I'll have someone from our team call you, and I've let them know 5pm today works best for you.");
  assert.equal(planNepqTurn({ channel: 'sms', trigger: 'can you have someone call me back', nowMs: MON_9PM }).fixed_line,
    "Got it. I'll have someone from our team call you tomorrow morning.");
});

// 2026-10-03 replay: the lead's own "reach out today" is not our promise.
test('after hours, a question about why THEY reached out is left alone', () => {
  for (const t of ["What's going on with them that made you reach out today?", 'Thanks for calling today. What got you looking?', 'Did you call us today?']) {
    assert.equal(enforceCallTiming(t, MON_9PM).changed, false, t);
  }
  assert.equal(enforceCallTiming("I'll have someone call you today.", MON_9PM).text, "I'll have someone call you tomorrow morning.");
  assert.equal(enforceCallTiming('A team member will reach out tonight.', MON_9PM).text, 'A team member will reach out tomorrow morning.');
});

test('a sign-off on its own line survives the rewrite', () => {
  const out = enforceCallTiming('Someone will call you in the next few minutes.\n\n— Reece Team', SAT_6PM);
  assert.equal(out.text, 'Someone will call you tomorrow morning.\n\n— Reece Team');
});
