/**
 * test-property-scope.js — we do not work on manufactured or mobile homes
 * (2026-10-05, agent_actions 546914: "Yes, we work on manufactured homes.").
 *
 * Run: node --test scripts/test-property-scope.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforcePropertyScope, mentionsManufacturedHome, SCOPE_ANSWER, SCOPE_LINE } from '../src/agentic/property-scope.js';

test('the live reply that shipped is replaced with the no', () => {
  const r = enforcePropertyScope('Yes, we work on manufactured homes. What prompted you to look at windows right now?', {
    inbound: 'do you work on manufactured homes?',
  });
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'lead_asked');
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
  assert.equal(r.reason, 'claimed_in_reply');
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
