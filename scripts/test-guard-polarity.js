/**
 * Guard polarity — scripts/test-guard-polarity.js
 *
 * Phase 0 (architecture review 2026-10-17; AIOS STD.065): every reply guard
 * has two fixtures, an input it MUST change and an input it MUST leave alone.
 * Before this, a guard that stopped firing, or started firing on everything,
 * still read green: the suites around it mostly pinned one side. The list
 * follows the guards that changed replies in production this month
 * (nepq.changes / redraft_guard in bot_message_context), in that order.
 *
 * Pure calls, no model, no network. A guard with no reachable must-change
 * case goes in GUARDS_WITH_NO_TRIP_CASE (for removal in Phase 3), never here
 * with a fake trip.
 *
 * Run: node --test scripts/test-guard-polarity.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { enforceOneAsk } = await import('../src/agentic/one-ask.js');
const { enforceNepqPlan, dropUnaskedCallOffer } = await import('../src/agentic/nepq-planner.js');
const { enforceSignOff } = await import('../src/agentic/sign-off.js');
const { stripOfferTalk } = await import('../src/agentic/rehash.js');
const { smsBookingTurn, enforceBookingFacts } = await import('../src/agentic/sms-booking-turn.js');
const { findUnbackedBookingClaim } = await import('../src/agentic/booking-claim.js');
const { enforceCancelledVisit } = await import('../src/agentic/cancelled-visit.js');
const { enforceJobScope } = await import('../src/agentic/job-scope.js');
const { enforceNonOwner } = await import('../src/agentic/non-owner.js');
const { findRepeatedOpener, findPhantomDecisionMaker } = await import('../src/agentic/discovery-discipline.js');
const { humanizeReply } = await import('../src/agentic/human-voice.js');
const { enforceCallTiming, enforceRehashCallTiming } = await import('../src/agentic/team-hours.js');
const { COLLECT_ASK } = await import('../src/agentic/booking-collect.js');

// The booking-facts fixture of scripts/test-part6-text-bot.js: two offered
// Saturday times, the lead picks 2 PM.
const slot = (d, h) => {
  const iso = `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00-04:00`;
  const dt = new Date(iso);
  return {
    iso,
    day: dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
    time: dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }),
    dayOfWeek: dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }),
  };
};
const OFFER = 'I have Sat, Oct 3 at 10:00 AM ET or Sat, Oct 3 at 2:00 PM ET. Which works better?';
const SLOTS = [slot(3, 10), slot(3, 14), slot(4, 18)];
const CONFIRM = { required_move: 'confirm', step: 'confirm', last_offer: OFFER, counters: {} };
const THREAD = [{ direction: 'outbound', text: OFFER }, { direction: 'inbound', text: 'Fine lets book for 2 PM' }];
const holdFacts = () => smsBookingTurn({ plan: CONFIRM, trigger: 'Fine lets book for 2 PM', thread: THREAD, slots: SLOTS, gateMissing: ['address'] });
const bookFacts = () => smsBookingTurn({ plan: CONFIRM, trigger: 'Fine lets book for 2 PM', thread: THREAD, slots: SLOTS, gateMissing: [], firstName: 'Mark' });

// The post-demo plan of the spec's live case (James, 2026-10-17).
const POST_DEMO_PLAN = { step: 'post_demo', rehash_stage: 'situation', rehash_question: 'Where are you at with it?' };
const JAMES_DRAFT = "Sounds good, James. Whenever you're ready, I'm here.";

const MON_9PM_ET = Date.parse('2026-10-13T01:00:00Z');
const MON_11AM_ET = Date.parse('2026-10-12T15:00:00Z');
const MONDAY_OPENING = { iso: '2026-10-12T14:00:00.000Z', day: 'Mon, Oct 12', dayOfWeek: 'Monday', time: '10:00 AM', tz: 'ET' };
const CANCELLED = { appointment: { status: 'cancelled', lp_disposition: 'CCC' } };
const SONYA_OPENER = 'Hi Sonya, thanks for reaching out. What are you hoping to get done with your windows or doors?';

/**
 * One row per guard. mustChange / mustPass return true when the guard behaved
 * as it must; a "finder" (returns what it found) counts a hit as a change.
 */
export const CASES = [
  {
    guard: 'enforceOneAsk',
    mustChange: () => enforceOneAsk("Yes, it's completely free. We just need your first name, best phone number, and email so we can get everything set up. No problem. What day works best for you?").changed === true,
    mustPass: () => enforceOneAsk("Got it. What's your first name?").changed === false,
  },
  {
    guard: 'enforceNepqPlan (post_demo_question_added)',
    // KNOWN-BAD: fixed in rehash closer PR. A post-demo plan that did not mark
    // the turn no_question still gets the track's next question appended to a
    // closer ("Sounds good, James. Whenever you're ready, I'm here."). This
    // records TODAY's behaviour so the fixture flips when the enforcer stops
    // appending to a closer; then move this case to mustPass.
    mustChange: () => {
      const r = enforceNepqPlan(JAMES_DRAFT, POST_DEMO_PLAN);
      return r.changes.includes('post_demo_question_added') && r.text.endsWith('Where are you at with it?');
    },
    mustPass: () => {
      const r = enforceNepqPlan(JAMES_DRAFT, { ...POST_DEMO_PLAN, no_question: true });
      return !r.changes.includes('post_demo_question_added') && !r.text.includes('?');
    },
  },
  {
    guard: 'enforceSignOff',
    mustChange: () => enforceSignOff("Sounds good, Erica. We'll have someone from our team give you a call when it's a better time.", { inbound: 'I can call back when I have more time. Ty' }).changed === true,
    mustPass: () => enforceSignOff('Thanks. Someone from our team will give you a call tomorrow.', { inbound: 'Have a good day' }).changed === false,
  },
  {
    guard: 'dropUnaskedCallOffer',
    mustChange: () => dropUnaskedCallOffer("That makes sense. A quick call would let us figure out what's happening. What's bothering you most?").changed === true,
    mustPass: () => dropUnaskedCallOffer("That makes sense. A quick call would let us figure out what's happening. What's bothering you most?", { leadWantsCall: true }).changed === false,
  },
  {
    guard: 'stripOfferTalk',
    mustChange: () => stripOfferTalk('Totally fair. I can take $1,500 off if you sign this week. Would a quick call help?').stripped.length > 0,
    mustPass: () => stripOfferTalk('Would a quick call help?').stripped.length === 0,
  },
  {
    guard: 'enforceBookingFacts',
    mustChange: () => enforceBookingFacts('Booked! See you Saturday.', bookFacts()).fallback_used === true,
    mustPass: () => {
      const draft = `Perfect, Mark. I'm holding Sat, Oct 3 at 2:00 PM ET for you. ${COLLECT_ASK.address}`;
      const r = enforceBookingFacts(draft, holdFacts());
      return r.fallback_used === false && r.message === draft;
    },
  },
  {
    guard: 'findUnbackedBookingClaim',
    mustChange: () => findUnbackedBookingClaim('Thursday at 10 AM is holding for you.') != null,
    mustPass: () => findUnbackedBookingClaim('What day works best for you?') === null,
  },
  {
    guard: 'enforceCancelledVisit',
    mustChange: () => enforceCancelledVisit('See you tomorrow!', { facts: CANCELLED }).changed === true,
    mustPass: () => enforceCancelledVisit('See you tomorrow!', { facts: { appointment: { status: 'set' } } }).changed === false,
  },
  {
    guard: 'enforceJobScope',
    mustChange: () => enforceJobScope('Yes, we do commercial work too. What got you looking?', {}).changed === true,
    mustPass: () => enforceJobScope("We don't work on commercial properties.", {}).changed === false,
  },
  {
    guard: 'enforceNonOwner',
    mustChange: () => enforceNonOwner(OFFER, { thread: [], inbound: "I'm renting, my landlord would have to okay it" }).changed === true,
    mustPass: () => enforceNonOwner(OFFER, { thread: [], inbound: 'hi' }).changed === false,
  },
  {
    guard: 'findRepeatedOpener',
    mustChange: () => findRepeatedOpener("Hi Sonya. What's going on with your windows that made you reach out?", SONYA_OPENER).length === 1,
    mustPass: () => findRepeatedOpener('Hi Sonya. Which room gives you the most trouble?', SONYA_OPENER).length === 0,
  },
  {
    guard: 'findPhantomDecisionMaker',
    mustChange: () => findPhantomDecisionMaker('Would a day this week work for both of you?', { status: 'unknown', ask_allowed: true }).length === 1,
    mustPass: () => findPhantomDecisionMaker('Would Tuesday at 10 work for you?', { status: 'unknown', ask_allowed: true }).length === 0,
  },
  {
    guard: 'humanizeReply',
    mustChange: () => humanizeReply('Got it—old windows can let a lot of heat in. How long has that been going on?').changes.length > 0,
    mustPass: () => humanizeReply("Got it. What's your first name?").changes.length === 0,
  },
  {
    guard: 'enforceCallTiming',
    mustChange: () => enforceCallTiming("I'll have someone call you today.", MON_9PM_ET).changed === true,
    mustPass: () => enforceCallTiming("I'll have someone call you today.", MON_11AM_ET).changed === false,
  },
  {
    guard: 'enforceRehashCallTiming',
    mustChange: () => enforceRehashCallTiming("Sorry about that, Monica. We're having someone call you back right now. — Reece Team", { nextOpening: MONDAY_OPENING }).changed === true,
    mustPass: () => enforceRehashCallTiming('Thanks, Monica.', { nextOpening: MONDAY_OPENING }).changed === false,
  },
];

/** Guards with no reachable must-change case (none today): Phase 3 removes them. */
export const GUARDS_WITH_NO_TRIP_CASE = Object.freeze([]);

for (const c of CASES) {
  test(`${c.guard}: changes what it must`, () => assert.equal(c.mustChange(), true));
  test(`${c.guard}: leaves the clean input alone`, () => assert.equal(c.mustPass(), true));
}

test('every guard on the Phase 0 list has both cases', () => {
  const listed = [
    'enforceOneAsk', 'enforceNepqPlan', 'enforceSignOff', 'dropUnaskedCallOffer', 'stripOfferTalk',
    'enforceBookingFacts', 'findUnbackedBookingClaim', 'enforceCancelledVisit', 'enforceJobScope',
    'enforceNonOwner', 'findRepeatedOpener', 'findPhantomDecisionMaker', 'humanizeReply',
    'enforceCallTiming', 'enforceRehashCallTiming',
  ];
  const covered = new Set(CASES.map(c => c.guard.split(' ')[0]));
  for (const g of listed) assert.ok(covered.has(g) || GUARDS_WITH_NO_TRIP_CASE.includes(g), `${g} has no polarity case`);
  for (const c of CASES) {
    assert.equal(typeof c.mustChange, 'function', c.guard);
    assert.equal(typeof c.mustPass, 'function', c.guard);
  }
});
