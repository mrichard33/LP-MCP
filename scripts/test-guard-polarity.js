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
// 2026-10-19 (handoff v2): the new guards and checks.
const { dropSensitiveDetail } = await import('../src/siro/text-guards.js');
const { copiesSiroDraft } = await import('../src/siro/presentation-guard.js');
const { checkF0Copy } = await import('../src/siro/f0-copy-checks.js');
const { planNepqTurn: planForHint } = await import('../src/agentic/nepq-planner.js');
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
    // Phase 1 item 4 (2026-10-18): the PLAN is what changed, not the enforcer.
    // A second no after our recorded close plans no_question (post_demo_stop),
    // and with no_question the enforcer must hand the closer back untouched.
    // The KNOWN-BAD case above stays: the enforcer still appends when the plan
    // does not say no_question.
    guard: 'enforceNepqPlan (no_question plan passes unchanged)',
    mustChange: () => enforceNepqPlan(JAMES_DRAFT, POST_DEMO_PLAN).text !== JAMES_DRAFT,
    mustPass: () => {
      const r = enforceNepqPlan(JAMES_DRAFT, { ...POST_DEMO_PLAN, no_question: true });
      return r.text === JAMES_DRAFT && !(r.changes || []).length;
    },
  },
  {
    // investment_owner chat, 2026-10-22: a phone ask written with "." on a
    // discovery turn got a second question appended to it.
    guard: 'enforceNepqPlan (discovery turn: one question, no detail ask)',
    mustChange: () => {
      const r = enforceNepqPlan("For a flip, we can handle that. Let me get someone from our team to walk through the details with you. What's the best number to reach you on.", { required_move: 'consequence', recent_outbound: [], booking: { allowed: false } });
      return (r.text.match(/\?/g) || []).length === 1 && !/number|someone/i.test(r.text);
    },
    mustPass: () => enforceNepqPlan('Got it. How long has that been going on?', { required_move: 'consequence', recent_outbound: [], booking: { allowed: false } }).text === 'Got it. How long has that been going on?',
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
    // REHASH_DEAL_HINT_MODE=every (ruling 4): the hint is never "used up";
    // everything else in the offer test still strips.
    guard: 'stripOfferTalk (every mode)',
    mustChange: () => stripOfferTalk("I want to make sure you're getting the best deal possible. I can do 10% off.", { hintUsed: false }).stripped.length > 0,
    mustPass: () => stripOfferTalk("I want to make sure you're getting the best deal possible. Would a quick call help?", { hintUsed: false }).stripped.length === 0,
  },
  {
    guard: 'dropSensitiveDetail',
    mustChange: () => dropSensitiveDetail('He recently lost his wife, and wants the windows done before Christmas.') !== 'He recently lost his wife, and wants the windows done before Christmas.',
    mustPass: () => dropSensitiveDetail('He wants the windows done before the family visits for Christmas.') === 'He wants the windows done before the family visits for Christmas.',
  },
  {
    guard: 'copiesSiroDraft',
    mustChange: () => copiesSiroDraft('The lanai slider will finally stop rattling in storms once it is replaced.', 'The lanai slider will finally stop rattling in storms once it is replaced.'),
    mustPass: () => !copiesSiroDraft('Did you get a chance to look over the proposal?', 'The lanai slider will finally stop rattling in storms once it is replaced.'),
  },
  {
    guard: 'checkF0Copy (four_step)',
    mustChange: () => checkF0Copy('Hi James, sorry about your wife. Would a call help? - John', { position: 1, repFirstName: 'John', formula: 'four_step', firstName: 'James' }).length > 0,
    mustPass: () => checkF0Copy('Dana, a project like this takes some thought, and that is fair. If I could make it work better for you, would you be open to a quick call with John?', { facts: null, position: 1, repFirstName: 'John', formula: 'four_step', firstName: 'Dana', slots: { hesitation: null, affirm: 'that is fair', reframe: null, if_i_could: 'make it work better for you' } }).length === 0,
  },
  {
    guard: 'enforceNepqPlan (rehash hint)',
    mustChange: () => {
      const conv = [{ direction: 'outbound', text: 'Did you get a chance to look over the proposal?' }, { direction: 'inbound', text: 'Yes I did' }];
      const p = planForHint({ channel: 'sms', trigger: 'Yes I did', conversation: conv, slots: [], firstName: 'Monica', discipline: { booking: { allowed: false } }, postDemo: true, rehash: true, rehashRep: 'John', rehashHintMode: 'every' });
      return enforceNepqPlan('Glad you had a look. What stood out?', p).changes.includes('rehash_hint_added');
    },
    mustPass: () => {
      const conv = [{ direction: 'outbound', text: 'Did you get a chance to look over the proposal?' }, { direction: 'inbound', text: 'Yes I did' }];
      const p = planForHint({ channel: 'sms', trigger: 'Yes I did', conversation: conv, slots: [], firstName: 'Monica', discipline: { booking: { allowed: false } }, postDemo: true, rehash: true, rehashRep: 'John', rehashHintMode: 'once' });
      return !enforceNepqPlan('Glad you had a look. What stood out?', p).changes.includes('rehash_hint_added');
    },
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
    guard: 'enforceJobScope',
    // 2026-10-22: an owner who rents the home out is a lead; a tenant's turn-away stands.
    mustChange: () => enforceJobScope("Since you're renting this out, it wouldn't be the right fit for us.", { inbound: 'a house I rent out' }).changed === true,
    mustPass: () => enforceJobScope("Since you're renting this out, it wouldn't be the right fit for us.", { inbound: 'I rent this place from my landlord' }).changed === false,
  },
  {
    guard: 'enforceJobScope',
    // 2026-10-22: an owner is never told to have "the owner" reach out; with no ownership known, nothing changes.
    mustChange: () => enforceJobScope("You'd need to have the owner reach out to us directly.", { inbound: 'a house I rent out to tenants' }).changed === true,
    mustPass: () => enforceJobScope("You'd need to have the owner reach out to us directly.", {}).changed === false,
  },
  {
    guard: 'enforceJobScope',
    // 2026-10-22: the old renter script ("if you own a home in the future") aimed at an owner; a tenant keeps it.
    mustChange: () => enforceJobScope('If you own a home in the future, feel free to reach back out.', { inbound: 'a house I rent out to tenants' }).changed === true,
    mustPass: () => enforceJobScope('If you own a home in the future, feel free to reach back out.', { inbound: 'I rent this place from my landlord' }).changed === false,
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
