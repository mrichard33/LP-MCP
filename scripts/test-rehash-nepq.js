/**
 * test-rehash-nepq.js — the post-demo NEPQ track and call scheduling for
 * rehash leads (handoff "Rehash bot: post-demo NEPQ + call scheduling",
 * 2026-10-11).
 *
 *   (a) "too expensive"        → "compared to what", no offer named
 *   (b) "got another quote"    → the comparison question, then the
 *                                "best deal possible" bridge
 *   (c) yes to the call + the Rehash Call calendar → two REAL openings, read
 *                                for the assigned team member
 *   (d) a hard pick            → book_appointment on Rehash Call with that
 *                                rep; no stage move, no workflow removal
 *   (e) yes + no calendar      → today's fallback (their time, the card)
 *   (f) "not interested" twice → no third ask
 *   stripOfferTalk keeps the one approved hint and still strips real offers.
 *
 * Run: node --test scripts/test-rehash-nepq.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rehashNepqTurn, rehashObjection, buildRehashNepqBlock } from '../src/agentic/rehash-nepq.js';
import { buildNepqBlock } from '../src/agentic/nepq-layer.js';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { readRehashCallSlots, rehashCallBooking, rehashRepFirstName } from '../src/agentic/rehash-slots.js';
import { isInHomeCalendarId, isGhlOnlyCalendarId } from '../src/knowledge/booking-calendar-router.js';
import { postDemoRehash } from '../src/prompts/response-generator/playbooks.js';
import * as R from '../src/agentic/rehash.js';

const { notifyRehashCall } = await import('../src/notifications/rehash-call.js');

const NOW = Date.parse('2026-10-09T16:00:00Z'); // Fri noon ET
const CAL = 'ncDzLgzbfKJRfhmtlWtB';
const JOHN = 'TYcZ9DcNkuPCFYsFxRFV';
const S = (iso, day, time, rel) => ({ iso, day, time, ...(rel ? { rel } : {}), tz: 'ET' });
const ALL = [
  S('2026-10-09T18:00:00Z', 'Fri, Oct 9', '2:00 PM', 'today'),
  S('2026-10-09T19:30:00Z', 'Fri, Oct 9', '3:30 PM', 'today'),
  S('2026-10-10T14:00:00Z', 'Sat, Oct 10', '10:00 AM', 'tomorrow'),
];
const out = (text) => ({ direction: 'outbound', text });
const inn = (text) => ({ direction: 'inbound', text });
const BRIDGE = out("I want to make sure you're getting the best deal possible. I may be able to do something for you, it's just easier on a quick call. Would that help?");
const plan = (trigger, conversation, callSlots = null) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: [], tzLabel: 'ET', firstName: 'Pat',
  discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep: 'John', callSlots,
});

// ── the track ──────────────────────────────────────────────────────────────

test('track: one stage per turn, about the proposal, never the windows', () => {
  assert.equal(rehashNepqTurn({ conversation: [], trigger: 'Hi', nowMs: NOW }).stage, 'connection');
  const conv = [out('Did you get a chance to look over the proposal?'), inn('Yes I did')];
  assert.equal(rehashNepqTurn({ conversation: conv, trigger: 'Yes I did', nowMs: NOW }).stage, 'situation');
  conv.push(out('Where are you at with it?'), inn('Still deciding'));
  assert.equal(rehashNepqTurn({ conversation: conv, trigger: 'Still deciding', nowMs: NOW }).stage, 'problem');
  conv.push(out("What's holding you back, just so I understand?"), inn('Just the timing'));
  assert.equal(rehashNepqTurn({ conversation: conv, trigger: 'Just the timing', nowMs: NOW }).stage, 'solution');
  conv.push(out('What would you need to see to feel good moving forward?'), inn('A better number honestly'));
  const t = rehashNepqTurn({ conversation: conv, trigger: 'A better number honestly', nowMs: NOW });
  assert.equal(t.stage, 'bridge');
  assert.equal(t.hintUsed, false);
});

test('the NEPQ block for a rehash lead: no new-lead stage, no visit disclosure, no windows question', () => {
  const block = buildNepqBlock({ intelligence: { buyer_stage: 1 } }, null, null, { rehash: { active: true, repName: 'John' }, conversation: [], trigger: 'Whole house probably.' });
  assert.match(block, /STAGE \(POST-DEMO REHASH\): CONNECTION/);
  assert.match(block, /look over the proposal/);
  assert.doesNotMatch(block, /STAGE: CONNECTION — they are not yet convinced/);
  assert.doesNotMatch(block, /What got you looking at the windows/);
  assert.doesNotMatch(block, /POST-BOOKING DISCLOSURE|DISCOVERY DISCIPLINE/);
  // A pre-demo lead is unchanged.
  const pre = buildNepqBlock({ intelligence: { buyer_stage: 1 } }, null, null);
  assert.match(pre, /STAGE: CONNECTION — they are not yet convinced/);
});

// ── (a) too expensive ──────────────────────────────────────────────────────

test('(a) "too expensive" → "compared to what", then the bridge; no offer named', () => {
  const conv = [out('Where are you at with the proposal?')];
  const t = rehashNepqTurn({ conversation: conv, trigger: "Honestly it's too expensive", nowMs: NOW });
  assert.equal(t.stage, 'objection');
  assert.equal(t.objection.type, 'price');
  assert.equal(t.example, 'Too expensive compared to what?');
  const block = buildRehashNepqBlock(t, { repName: 'John' });
  assert.match(block, /THIS TURN: Ask back, never rebut: "Too expensive compared to what\?"/);
  // The answer to the ask-back → the bridge.
  const next = rehashNepqTurn({ conversation: [...conv, inn("Honestly it's too expensive"), out('Too expensive compared to what?')], trigger: 'Compared to what we budgeted', nowMs: NOW });
  assert.equal(next.stage, 'bridge');
  // Whatever the model writes, a named offer is stripped.
  const s = R.stripOfferTalk('Too expensive compared to what? I could take $500 off today.');
  assert.equal(s.text, 'Too expensive compared to what?');
});

// ── (b) got another quote ──────────────────────────────────────────────────

test('(b) "got another quote" → the comparison question, then the "best deal possible" bridge', () => {
  const conv = [out('Did you get a chance to look over the proposal?')];
  const t = rehashNepqTurn({ conversation: conv, trigger: 'We got another quote that was lower', nowMs: NOW });
  assert.equal(t.objection.type, 'other_quote');
  assert.equal(t.example, 'How do they compare, out of curiosity?');
  const next = rehashNepqTurn({ conversation: [...conv, inn('We got another quote that was lower'), out('How do they compare, out of curiosity?')], trigger: 'About 3k less', nowMs: NOW });
  assert.equal(next.stage, 'bridge');
  assert.match(buildRehashNepqBlock(next), /bridge to the call with the hint, once/);
  // The bridge line itself survives the offer guard.
  assert.deepEqual(R.stripOfferTalk(BRIDGE.text), { text: BRIDGE.text, stripped: [] });
});

test('"best deal possible" is said once: the track and the guard both know', () => {
  const t = rehashNepqTurn({ conversation: [BRIDGE, inn('Maybe'), out('Sure.'), inn('What would that look like?')], trigger: 'What would that look like?', nowMs: NOW });
  assert.equal(t.hintUsed, true);
  assert.match(buildRehashNepqBlock(t), /ALREADY SAID in this conversation/);
  const again = R.stripOfferTalk("Again, I want to make sure you're getting the best deal possible. Would a call help?", { hintUsed: true });
  assert.equal(again.text, 'Would a call help?');
  assert.equal(R.bestDealHintUsed([BRIDGE]), true);
  assert.equal(R.bestDealHintUsed([inn('best deal?')]), false, 'only our own messages count');
});

// ── stripOfferTalk ─────────────────────────────────────────────────────────

test('stripOfferTalk keeps the approved hint and still strips every real offer', () => {
  for (const ok of [
    "I want to make sure you're getting the best deal possible.",
    "I just want to make sure you're getting the best deal.",
    'I want to get you the best deal for you two.',
  ]) assert.deepEqual(R.stripOfferTalk(ok), { text: ok, stripped: [] }, ok);
  for (const bad of [
    'I can do $500 off.', 'There is 10% off this week.', 'We have special pricing right now.',
    'I can get you a great deal.', 'That is a deal.', 'We can price match that.',
    "I want to make sure you're getting the best deal possible, like $500 off.",
  ]) assert.ok(R.findOfferTalk(bad).length, bad);
  assert.equal(R.stripOfferTalk('We have special pricing right now.').text, R.OFFER_HINT_LINE);
  assert.equal(R.OFFER_HINT_LINE, "I want to make sure you're getting the best deal possible, and it's easier to go over on a quick call.");
});

// ── (c) yes to the call, with the calendar ─────────────────────────────────

test('(c) yes to the call + the Rehash Call calendar → two real openings for the assigned rep', async () => {
  const seen = [];
  const slots = await readRehashCallSlots({ contactId: 'c1', timezone: 'America/New_York', env: { REHASH_CALENDAR_ID: CAL } }, {
    getOwner: async () => null,
    fetchFreeSlots: async (cal, o) => { seen.push(o.userId); return { slots: ALL, timezone: 'America/New_York' }; },
    selectOfferableSlots: (av, _p, o) => ({ slots: o.maxOffer ? av.slots : av.slots.slice(0, 2) }),
    isOpen: () => true,
  });
  assert.deepEqual(seen, [JOHN], 'read on the assigned rep (the Rehash rep by default)');
  assert.equal(slots.repName, 'John');
  const p = plan('Yes that would help', [out('Where are you at with it?'), inn('Still thinking'), BRIDGE], slots);
  assert.equal(p.step, 'rehash_offer');
  assert.deepEqual(p.slots_to_offer.map(s => s.iso), [ALL[0].iso, ALL[1].iso]);
  assert.ok(p.slots_to_offer.every(s => Date.parse(s.iso) > NOW), 'later than now');
});

// ── (d) a hard pick ────────────────────────────────────────────────────────

test('(d) a hard pick → book on Rehash Call with that rep; the confirm names them; no stage move', () => {
  const callSlots = { calendarId: CAL, rep: JOHN, repName: 'John', offer: ALL.slice(0, 2), all: ALL };
  const conv = [BRIDGE, inn('Yes'), out('I have today at 2:00 PM ET or today at 3:30 PM ET. Which works better?')];
  const p = plan('2 PM works', conv, { ...callSlots, repName: 'Tom' });
  assert.equal(p.step, 'rehash_confirm');
  assert.equal(p.rehash_pick.iso, ALL[0].iso);
  assert.equal(p.reference_line, "You're all set for today at 2:00 PM ET. Tom will call you at this number then.");
  const booking = rehashCallBooking({ slot: p.rehash_pick, calendarId: CAL, rep: JOHN, env: {} });
  assert.equal(booking.action_type, 'book_appointment');
  assert.equal(booking.action_payload.calendar_id, CAL);
  assert.equal(booking.action_payload.assigned_user_id, JOHN);
  assert.equal(booking.action_payload.start_time, ALL[0].iso);
  // No stage move and no workflow removal: the payload carries neither, and
  // rule 90 GHL_APPT_STAGE_ADVANCE is gated on the in-home calendar ids.
  assert.equal(JSON.stringify(booking).match(/stage|workflow|remove/i), null);
  const env = { REHASH_CALENDAR_ID: CAL };
  assert.equal(isInHomeCalendarId(CAL), false);
  assert.equal(isGhlOnlyCalendarId(CAL) || R.isRehashContact({ tags: ['rehash'] }), true);
  void env;
  // A confirm with no visit disclosure survives the enforcer as written.
  const e = enforceNepqPlan("You're all set for today at 2:00 PM ET. Tom will call you at this number then.", p);
  assert.doesNotMatch(e.text, /\?|visit|confirm the details/i);
});

test('rehashRepFirstName: the known Rehash rep, env names, never a guess', () => {
  assert.equal(rehashRepFirstName(JOHN, {}), 'John');
  assert.equal(rehashRepFirstName('u2', { REHASH_TEAM_USER_NAMES: 'u2:Tom Baker,u3:Ana' }), 'Tom');
  assert.equal(rehashRepFirstName('u3', { REHASH_TEAM_USER_NAMES: '{"u3":"Ana"}' }), 'Ana');
  assert.equal(rehashRepFirstName('unknown', {}), null);
  assert.equal(rehashRepFirstName(null, {}), null);
});

test('(d) the booked card names the slot and the team member', async () => {
  const state = { posts: [], events: [] };
  const d = {
    postToSlack: async (text, channel) => { state.posts.push({ text, channel }); return { ok: true, ts: '1.2' }; },
    emitEvent: async (e) => { state.events.push(e); },
    opsAlert: async () => {}, locationId: 'loc1', alreadyRequested: async () => false,
  };
  const gen = { rehash: { active: true, rep_name: 'John' }, rehash_call: { agreed: false } };
  const r = await notifyRehashCall({ contactId: 'C9', generated: gen, triggerMessage: '2 works', booked: { slot_label: 'today at 2:00 PM ET', start_time: ALL[0].iso, assignee_name: 'Tom' }, contact: { firstName: 'Pat', phone: '+13525550100' } }, d, { env: {}, nowMs: NOW });
  assert.equal(r.posted, true);
  assert.match(state.posts[0].text, /REHASH CALL BOOKED/);
  assert.match(state.posts[0].text, /When: today at 2:00 PM ET/);
  assert.match(state.posts[0].text, /With: Tom/);
  assert.match(state.events[0].idempotency_key, /^f0_rehash_call_booked_C9_/);
  assert.equal(state.events[0].payload.assignee_name, 'Tom');
});

// ── (e) yes to the call, no calendar ───────────────────────────────────────

test('(e) yes to the call + no calendar → their time in words, then the card', async () => {
  const p = plan('Yes that would help', [out('Where are you at with it?'), inn('Still thinking'), BRIDGE], null);
  // Today's fallback: no slot offered, the call stays allowed, and the reply
  // asks for their time (the prompt's SCHEDULING line); the enforcer keeps it.
  assert.equal(p.post_demo, true);
  assert.equal(p.booking.allowed, false);
  assert.deepEqual(p.slots_to_offer, []);
  assert.equal(rehashNepqTurn({ conversation: [BRIDGE], trigger: 'Yes that would help', nowMs: NOW }).stage, 'schedule');
  const ask = "Good. What's a good time today or tomorrow for John to give you a quick call?";
  assert.equal(enforceNepqPlan(ask, p).text, ask);
  const prompt = postDemoRehash('John', { callTimes: false }).join('\n');
  assert.match(prompt, /what is a good time today or tomorrow for John/);
  assert.match(prompt, /never offer a specific day or time yourself/);
  const state = { posts: [] };
  const d = { postToSlack: async (text) => { state.posts.push(text); return { ok: true, ts: '1' }; }, emitEvent: async () => {}, opsAlert: async () => {}, locationId: 'loc1', alreadyRequested: async () => false };
  await notifyRehashCall({ contactId: 'C1', generated: { rehash: { active: true, rep_name: 'John' }, rehash_call: { agreed: true, preferred_time: 'tomorrow after 3' } }, contact: { firstName: 'Pat' } }, d, { env: {} });
  assert.match(state.posts[0], /REHASH CALL REQUEST[\s\S]*Best time: tomorrow after 3/);
});

// ── (f) not interested twice ───────────────────────────────────────────────

test('(f) "not interested" twice → no third ask', () => {
  const conv = [out('Where are you at with the proposal?'), inn('Not interested'), out('Understood. If anything changes, what would you want to look at again?')];
  const first = rehashNepqTurn({ conversation: conv.slice(0, 1), trigger: 'Not interested', nowMs: NOW });
  assert.equal(first.stage, 'door_open');
  const t = rehashNepqTurn({ conversation: conv, trigger: 'No thanks', nowMs: NOW });
  assert.equal(t.stage, 'stop');
  assert.match(buildRehashNepqBlock(t), /ask NOTHING/);
  const p = plan('No thanks', conv);
  assert.equal(p.step, 'post_demo_stop');
  const e = enforceNepqPlan('Understood. Would a quick call help, just in case?', p);
  assert.doesNotMatch(e.text, /\?/);
});

test('objections: a spouse named in passing is not one; signed elsewhere and a date are the planner\'s', () => {
  assert.equal(rehashObjection('My wife liked the windows'), null);
  assert.equal(rehashObjection('I need to talk it over with my wife').type, 'spouse');
  assert.equal(rehashObjection('Need to think about it').type, 'think');
  assert.equal(rehashNepqTurn({ trigger: 'We signed with another company', nowMs: NOW }).stage, 'signed_elsewhere');
  assert.equal(rehashNepqTurn({ trigger: 'Follow up in November please', nowMs: NOW }).stage, 'follow_up_date');
});

// ── the first live simulation (2026-10-11, sim_mv3y3shp) ───────────────────

test('sim: "Thanks for checking in" gets the proposal question, not "Talk soon."', () => {
  const p = plan('Thanks for checking in', []);
  assert.equal(p.step, 'post_demo');
  assert.equal(p.rehash_question, 'Did you get a chance to look over the proposal?');
  // A bare thank-you is the ack step and asks the same thing.
  assert.equal(plan('Thank you', []).post_demo_question, 'Did you get a chance to look over the proposal?');
  const e = enforceNepqPlan('Anytime. Talk soon.', p);
  assert.equal(e.text, 'Anytime. Did you get a chance to look over the proposal?');
});

test('sim: "best deal" is not the answer to "we got another quote"', () => {
  const conv = [out('Did you get a chance to look over the proposal?')];
  const p = plan('We got another quote from a different company that was lower', conv);
  assert.equal(p.rehash_stage, 'objection');
  const e = enforceNepqPlan("How do they compare, out of curiosity? I want to make sure you're getting the best deal possible.", p);
  assert.equal(e.text, 'How do they compare, out of curiosity?');
});

test('sim: the bridge turn asks for the call', () => {
  const conv = [out('Did you get a chance to look over the proposal?'), inn('We got another quote'), out('How do they compare, out of curiosity?')];
  const p = plan('Theirs was about 3k less', conv);
  assert.equal(p.rehash_stage, 'bridge');
  const e = enforceNepqPlan("That gap matters. I want to make sure you're getting the best deal possible.", p);
  assert.match(e.text, /best deal possible\. Would a quick call help\?$/);
});

test('sim: a yes two messages after the bridge gets the real call times', () => {
  const callSlots = { calendarId: CAL, rep: JOHN, repName: 'John', offer: ALL.slice(0, 2), all: ALL };
  const conv = [BRIDGE, inn('Their warranty is shorter'), out('That gap matters.')];
  const p = plan('Yes that would help', conv, callSlots);
  assert.equal(p.step, 'rehash_offer');
  assert.equal(p.slots_to_offer.length, 2);
});

test('a post-appointment lead that is not rehash keeps the old post-demo plan (no track)', () => {
  const p = planNepqTurn({ channel: 'sms', trigger: 'Thanks for checking in', conversation: [], discipline: { booking: { allowed: false } }, nowMs: NOW, postDemo: true, rehashRep: null, rehash: false });
  assert.equal(p.rehash_stage, undefined);
  assert.notEqual(p.post_demo_question, 'Did you get a chance to look over the proposal?');
});
