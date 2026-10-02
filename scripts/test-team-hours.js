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
  assert.equal(nextTeamOpenLabel(MON_9PM), 'tomorrow at 9 AM ET');
  assert.equal(nextTeamOpenLabel(SUN_8AM), 'today at 9 AM ET');
  assert.equal(nextTeamOpenLabel(SAT_6PM), 'tomorrow at 9 AM ET');
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
  assert.match(out.text, /will call you tomorrow at 9 AM ET to help\./);
  assert.match(out.text, /Have you covered it\?$/);
  assert.match(enforceCallTiming('Our service team will call you today to get it scheduled.', MON_9PM).text, /call you tomorrow at 9 AM ET to get it scheduled/);
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
  assert.equal(night.fixed_line, "That's urgent. I've flagged it for our team, and someone will call you tomorrow at 9 AM ET.");
  const day = planNepqTurn({ channel: 'livechat', trigger: 'A storm broke my window and water is coming in!', nowMs: MON_11AM });
  assert.equal(day.fixed_line, LINES.handoff.emergency);
  const service = planNepqTurn({ channel: 'sms', trigger: 'You installed my windows last month and one is leaking', nowMs: SUN_4PM });
  assert.equal(service.fixed_line, "Sorry about that. I've passed this to our service team, and someone will call you tomorrow at 9 AM ET.");
});

test('planner: a call asked for outside hours gets the next opening', () => {
  assert.equal(planNepqTurn({ channel: 'sms', trigger: 'call me at 9pm tonight', nowMs: MON_11AM }).fixed_line,
    "Got it. That's outside our team's hours, so I'll have someone call you tomorrow at 9 AM ET.");
  assert.equal(planNepqTurn({ channel: 'sms', trigger: 'Just call me at 5pm today', nowMs: MON_11AM }).fixed_line,
    "Got it. I'll have someone from our team call you around 5pm today.");
  assert.equal(planNepqTurn({ channel: 'sms', trigger: 'can you have someone call me back', nowMs: MON_9PM }).fixed_line,
    "Got it. I'll have someone from our team call you tomorrow at 9 AM ET.");
});

test('a sign-off on its own line survives the rewrite', () => {
  const out = enforceCallTiming('Someone will call you in the next few minutes.\n\n— Reece Team', SAT_6PM);
  assert.equal(out.text, 'Someone will call you tomorrow at 9 AM ET.\n\n— Reece Team');
});
