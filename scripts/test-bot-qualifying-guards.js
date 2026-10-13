/**
 * Qualifying guards — scripts/test-bot-qualifying-guards.js
 *
 * 2026-10-12 (handoff "Lead Conversation Stage", PR 3):
 *   - a renter was offered times twice (batch 3 T3): src/agentic/non-owner.js,
 *     active in every mode (no single-leg visits);
 *   - "can renters get a quote?" and a morning-run opener were read as price
 *     objections (batch 3 #2): quote ≠ price, LEAD_STAGE_MODE=live;
 *   - zip 10001 was declined on SMS and "good chance we can help" in live chat
 *     (batch 2 #3): one decline, both bots, active;
 *   - the competitor case never reached times (batch 3 T4/#5): the NEPQ
 *     disarm, live; claims about another company's code compliance stripped.
 * The live-chat lane cases are in scripts/test-live-chat-fast-lane.js.
 *
 * Run: node --test scripts/test-bot-qualifying-guards.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { enforceNonOwner, isNonOwner, NON_OWNER_LINE } = await import('../src/agentic/non-owner.js');
const P = await import('../src/agentic/nepq-planner.js');
const SA = await import('../src/agentic/service-area-turn.js');
const { serviceAreaOutside } = await import('../src/prompts/response-generator/framing.js');

const thread = (...xs) => xs.map(([d, t]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: t }));
const OFFER = "Makes sense, you'll want to get his okay first. I have Thu, Oct 15 at 10:00 AM ET or Fri, Oct 16 at 2:00 PM ET. Which works better?";

// ── renter / non-owner (active) ──────────────────────────────────────────

test('a renter who says it now gets the non-owner line: no times, no question', () => {
  const r = enforceNonOwner(OFFER, { thread: [], inbound: "I'm renting, my landlord would have to okay it" });
  assert.equal(r.changed, true);
  assert.equal(r.text, NON_OWNER_LINE);
  assert.doesNotMatch(r.text, /\?|AM|PM|!/);
  assert.match(r.text, /don't work on rental units/);
  // 2026-10-13: the owner of a rental cannot book either, so the tenant is
  // never sent to the owner.
  assert.doesNotMatch(r.text, /owner is welcome|reach out/);
});

test('a landlord gets the same no (the user, 2026-10-13: no rental units at all)', () => {
  for (const inbound of ['we rent it out to tenants', 'It is an Airbnb we own', 'my tenants say the windows leak']) {
    const r = enforceNonOwner(OFFER, { thread: [], inbound });
    assert.equal(r.text, NON_OWNER_LINE, inbound);
    assert.equal(isNonOwner([], inbound), true, inbound);
  }
  // A reply that already says no is left alone.
  const no = "Sorry, we don't work on rental units, so we can't set up a visit for a home that's rented out.";
  assert.equal(enforceNonOwner(no, { thread: [], inbound: 'we rent it out' }).changed, false);
  // Said earlier: the time offer goes.
  const later = enforceNonOwner(OFFER, { thread: thread(['i', 'we rent it out'], ['o', 'Thanks for telling me.']), inbound: 'so can you come by?' });
  assert.doesNotMatch(later.text, /AM|PM/);
  // A former rental they live in now is a normal home.
  assert.equal(isNonOwner([], 'we used to rent it out but we live there now'), false);
});

test('said earlier: the answer stays, the time offer goes', () => {
  const r = enforceNonOwner('The visit takes about an hour. I have Thu, Oct 15 at 10:00 AM ET or Fri, Oct 16 at 2:00 PM ET. Which works better?',
    { thread: thread(['i', 'We are tenants here'], ['o', 'Thanks for telling me.']), inbound: 'how long is a visit?' });
  assert.equal(r.text, 'The visit takes about an hour.');
});

test('an owner, or nothing said: untouched', () => {
  for (const inbound of ['we own the house', 'my windows leak', 'it is an investment property we are fixing up']) {
    const r = enforceNonOwner(OFFER, { thread: [], inbound });
    assert.equal(r.changed, false, inbound);
  }
  assert.equal(isNonOwner([], 'can renters get a quote?'), true);
  assert.equal(isNonOwner(thread(['i', 'I rent']), 'actually my husband and I own it, sorry'), false);
});

// ── quote ≠ price (live) ─────────────────────────────────────────────────

test('a plain quote request is the info-request play when live; a price word is still price', () => {
  const plan = (t, stageLive) => P.planNepqTurn({ channel: 'sms', trigger: t, conversation: [], stageLive });
  assert.equal(plan('Hi, can I get a quote on my windows?', false).objection?.type, 'price', 'today');
  const live = plan('Hi, can I get a quote on my windows?', true);
  assert.equal(live.objection, null);
  assert.equal(live.info_request, true);
  assert.equal(live.booking.allowed, false);
  assert.match(live.fixed_line, /Just so we get you the right thing, what are you hoping to see\?/);
  assert.equal((live.fixed_line.match(/\?/g) || []).length, 1);
  assert.equal(plan('how much for 12 windows?', true).objection?.type, 'price');
  assert.equal(plan('I just need a quote', true).objection?.type, 'price', 'insist keeps the price play');
  assert.equal(P.isPriceAsk('can I get a quote?', { quoteIsPrice: false }), false);
  assert.equal(P.isPriceAsk('can I get a quote?'), true);
});

test('the info-request play is said once', () => {
  const convo = thread(['i', 'can I get a quote?'], ['o', P.LINES.info_request], ['i', 'new windows for the front'], ['o', 'Got it. What is going on with the old ones?']);
  const p = P.planNepqTurn({ channel: 'sms', trigger: 'can I get a quote for that?', conversation: convo, stageLive: true });
  assert.notEqual(p.info_request, true);
});

// ── service area parity (active) ─────────────────────────────────────────

test('one decline line, no exclamation point, used by the coverage turn', () => {
  assert.equal(SA.outOfAreaLine('10001'), "Sorry, Reece doesn't serve the 10001 area. Thank you for checking with us.");
  assert.equal(SA.coverageSentence({ status: 'out', zip: '10001' }), SA.outOfAreaLine('10001'));
  assert.doesNotMatch(SA.outOfAreaLine('10001'), /!/);
  const prompt = serviceAreaOutside('10001').join('');
  assert.match(prompt, /Sorry, Reece doesn't serve the 10001 area\. Thank you for checking with us\./);
  assert.doesNotMatch(prompt, /someone from the team reach out|UNIVERSAL FALLBACK/);
});

test('zipInText reads a zip typed outside a coverage question', () => {
  assert.equal(SA.zipInText('my zip is 10001'), '10001');
  assert.equal(SA.zipInText('10001'), '10001');
  assert.equal(SA.zipInText('I need windows at 55 Main St, New York NY 10001'), '10001');
  assert.equal(SA.zipInText('I have 12 windows'), null);
  assert.equal(SA.zipInText('about 10000 dollars'), null);
});

// ── competitor (live) ────────────────────────────────────────────────────

test('competitor: the disarm, then how they would decide; no consequence after it', () => {
  const p = P.planNepqTurn({ channel: 'sms', trigger: 'We already went with another company', conversation: [], stageLive: true });
  assert.equal(p.objection?.type, 'competitor');
  assert.equal(p.booking.allowed, false);
  assert.match(p.fixed_line, /maybe nothing would change that/);
  assert.match(p.fixed_line, /How would you then decide\?$/);
  assert.doesNotMatch(p.fixed_line, /storm|hurricane|code|season/i);
  const after = P.planNepqTurn({ channel: 'sms', trigger: 'probably the warranty', conversation: thread(['i', 'We already went with another company'], ['o', P.LINES.competitor]), stageLive: true });
  assert.equal(after.criteria_reply, true);
  assert.equal(after.counters.consequence_used, true, 'no consequence move after the competitor play');
  const twice = P.planNepqTurn({ channel: 'sms', trigger: 'like I said, we went with another company', conversation: thread(['i', 'We already went with another company'], ['o', P.LINES.competitor]), stageLive: true });
  assert.equal(twice.handoff?.reason, 'repeat_objection');
  assert.equal(P.planNepqTurn({ channel: 'sms', trigger: 'We already went with another company', conversation: [] }).objection?.type, undefined, 'off when not live');
});

test('claims about another company\'s code compliance are stripped', () => {
  const out = P.dropUnsafeSentences(['Totally fair.', "Some installers aren't up to code, and their windows may not be installed to code.", 'Suppose we both meet your criteria.', 'How would you decide?']);
  const text = out.sentences.join(' ');
  assert.deepEqual(out.changes, ['unapproved_claim']);
  assert.doesNotMatch(text, /to code/);
  assert.match(text, /How would you decide\?/);
  assert.equal(P.CLAIMS_RX.test('Our windows meet the Florida Building Code.'), false);
});
