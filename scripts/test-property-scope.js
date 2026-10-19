/**
 * test-property-scope.js — homes we cannot work on (2026-10-05):
 *  - manufactured or mobile homes (agent_actions 546914: "Yes, we work on
 *    manufactured homes.");
 *  - buildings taller than two stories (agent_actions 547004: "Yes, we install
 *    impact windows and doors in condos … Is this for all nine floors?").
 *
 * Run: node --test scripts/test-property-scope.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforcePropertyScope, mentionsManufacturedHome, mentionsTallBuilding, SCOPE_ANSWER, SCOPE_LINE, HEIGHT_ANSWER, HEIGHT_LINE } from '../src/agentic/property-scope.js';

test('the live reply that shipped is replaced with the no', () => {
  const r = enforcePropertyScope('Yes, we work on manufactured homes. What prompted you to look at windows right now?', {
    inbound: 'do you work on manufactured homes?',
  });
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'manufactured_home:lead_asked');
  assert.equal(r.text, SCOPE_ANSWER);
});

test('a yes that never names the home type is still a yes', () => {
  for (const draft of ['Absolutely! What got you looking?', 'We sure do. When would be a good time?']) {
    const r = enforcePropertyScope(draft, { inbound: 'Do you install windows in mobile homes' });
    assert.equal(r.text, SCOPE_ANSWER, draft);
  }
  for (const inbound of ['I have a double wide, can you help?', 'It is a single-wide in a trailer park', 'mobile/manufactured home ok?']) {
    assert.equal(enforcePropertyScope('Sure thing! Tell me more.', { inbound }).text, SCOPE_ANSWER, inbound);
  }
});

test('a correct no is left alone', () => {
  const ok = "Sorry, we don't work on manufactured homes. We focus on single-family homes, townhomes, and condos.";
  const r = enforcePropertyScope(ok, { inbound: 'do you work on manufactured homes?' });
  assert.equal(r.changed, false);
  assert.equal(r.text, ok);
  assert.equal(enforcePropertyScope('Unfortunately mobile homes are outside what we do.', { inbound: 'mobile home?' }).changed, false);
});

test('an unprompted claim in a reply becomes the scope line, the rest stays', () => {
  const r = enforcePropertyScope('We work on all kinds of homes, from condos to mobile homes. What got you looking?', { inbound: 'hi, I need new windows' });
  assert.equal(r.reason, 'manufactured_home:claimed_in_reply');
  assert.equal(r.text, `${SCOPE_LINE} What got you looking?`);
  const widened = enforcePropertyScope('No problem, we do manufactured homes, not just houses.', { inbound: 'ok' });
  assert.equal(widened.text, SCOPE_LINE);
});

test('nothing to do when nobody mentions it', () => {
  const draft = 'Our vinyl frames are reinforced, and the manufacturer rates them 3 times stronger than aluminum. Want to see them?';
  assert.equal(enforcePropertyScope(draft, { inbound: 'is vinyl strong?' }).changed, false);
  assert.equal(enforcePropertyScope('Text me on my mobile, the home number is old.', { inbound: 'call my mobile' }).changed, false);
});

test('a lead saying the home is NOT one raises nothing', () => {
  const draft = 'Got it, a single-family house. What got you looking?';
  assert.equal(enforcePropertyScope(draft, { inbound: "It's not a mobile home, it's a regular house" }).changed, false);
});

test('mentionsManufacturedHome', () => {
  assert.equal(mentionsManufacturedHome('manufactured housing'), true);
  assert.equal(mentionsManufacturedHome('trailer home'), true);
  assert.equal(mentionsManufacturedHome('the manufacturer warranty'), false);
  assert.equal(mentionsManufacturedHome('my mobile number'), false);
  assert.equal(mentionsManufacturedHome('modular home'), false); // not ruled on
});

// ── Buildings taller than two stories ──────────────────────────────────

test('the 9-story condo reply that shipped is replaced with the no', () => {
  const r = enforcePropertyScope('Yes, we serve Flagler Beach (32136). Yes, we install impact windows and doors in condos. A few things help me point you in the right direction. Is this for all nine floors, or specific units?', {
    inbound: 'Do you service a 9 story condominium?',
  });
  assert.equal(r.reason, 'over_two_stories:lead_asked');
  assert.equal(r.text, HEIGHT_ANSWER);
});

test('the building counts, not the unit', () => {
  for (const inbound of ["I'm on the 7th floor", 'we are on the third floor of our condo', 'It is a high-rise on the beach', 'mid rise building, 5 floors', 'penthouse unit', 'Our building is more than two stories', 'floor 12', 'a three-story townhouse']) {
    assert.equal(enforcePropertyScope('Great! What got you looking?', { inbound }).text, HEIGHT_ANSWER, inbound);
  }
});

test('one or two stories is a normal lead', () => {
  for (const inbound of ['I live on the 2nd floor', 'two story house', 'single story ranch', 'ground floor condo in a 2 story building', 'I have 3 windows on the floor level', 'We need 4 floor-to-ceiling windows', '2 32 in, 1 52 in, 2 36 in', '14671 Bonaire Blvd. #703', '10 am this Thursday', "It's not a high-rise, just two stories"]) {
    const draft = 'Got it. What got you looking?';
    assert.equal(enforcePropertyScope(draft, { inbound }).changed, false, inbound);
  }
});

test('a reply that already states the limit is left alone', () => {
  for (const ok of ['Sorry, we only work on buildings two stories or lower.', "Unfortunately a 9-story building is outside what we do.", 'We install in buildings up to two stories, so that one is not a fit.']) {
    assert.equal(enforcePropertyScope(ok, { inbound: 'Do you service a 9 story condominium?' }).changed, false, ok);
  }
});

test('an unprompted height claim in a reply becomes the line', () => {
  const r = enforcePropertyScope('We handle everything from ranch homes to high-rise condos. What got you looking?', { inbound: 'hi' });
  assert.equal(r.reason, 'over_two_stories:claimed_in_reply');
  assert.equal(r.text, `${HEIGHT_LINE} What got you looking?`);
});

test('both at once get both answers', () => {
  const r = enforcePropertyScope('Sure!', { inbound: 'I have a mobile home and a condo on the 5th floor' });
  assert.equal(r.text, `${SCOPE_ANSWER} ${HEIGHT_ANSWER}`);
});

test('mentionsTallBuilding', () => {
  assert.equal(mentionsTallBuilding('10 stories'), true);
  assert.equal(mentionsTallBuilding('3rd floor'), true);
  assert.equal(mentionsTallBuilding('second floor'), false);
  assert.equal(mentionsTallBuilding('one story home'), false);
});

test('leadRaisesScope reads every message the lead sent, and a denial raises nothing (2026-10-13)', async () => {
  const { leadRaisesScope } = await import('../src/agentic/property-scope.js');
  assert.equal(leadRaisesScope(['hi', 'we live in a double wide', 'Tuesday works']), true);
  assert.equal(leadRaisesScope(['My condo is on the 5th floor']), true);
  assert.equal(leadRaisesScope(["it's not a mobile home, it's a house", '2 story house']), false);
});

// 2026-10-19 (Sam, IMWge24jxc0xO0ppy7OR): his rep had been to the high-rise.
test('past the demo: the lead raising a high-rise gets no "we only do two stories"', async () => {
  const { POST_DEMO_SCOPE_LINE } = await import('../src/agentic/property-scope.js');
  const inbound = "I'm waiting for Chris to give me a list of high-rises that your company has done in the past.";
  const draft = "Thanks, Sam. I'll have our team look into that and reach out.";
  assert.equal(enforcePropertyScope(draft, { inbound }).changed, true, 'before the demo the limit still answers');
  assert.equal(enforcePropertyScope(draft, { inbound, pastDemo: true }).changed, false);
  // The real bad draft is dropped, never sent.
  const bad = enforcePropertyScope(HEIGHT_ANSWER, { inbound, pastDemo: true });
  assert.equal(bad.reason, 'post_demo_dropped');
  assert.equal(bad.text, POST_DEMO_SCOPE_LINE);
  // A claim is dropped too, and the rest of the reply stays.
  const claim = enforcePropertyScope('We do high-rise condos all the time. I will check with Chris.', { inbound, pastDemo: true });
  assert.equal(claim.text, 'I will check with Chris.');
  assert.equal(enforcePropertyScope('Sorry, we only work on buildings two stories or lower. Anything else?', { inbound: 'hi', pastDemo: true }).text, 'Anything else?');
});
