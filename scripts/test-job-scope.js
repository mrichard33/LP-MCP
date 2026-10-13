/**
 * Jobs we cannot take — scripts/test-job-scope.js
 *
 * 2026-10-13 (the user): "We do not work with rental properties or any
 * commercial properties", a minimum of three openings in any mix of windows
 * and doors (or one sliding glass door on its own), and we sell only hurricane
 * impact windows and doors. src/agentic/job-scope.js, both bots, every mode.
 *
 * Run: node --test scripts/test-job-scope.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const J = await import('../src/agentic/job-scope.js');
const { checkReply } = await import('../src/eval/reply-invariants.js');
const { enforceNonOwner } = await import('../src/agentic/non-owner.js');

const thread = (...xs) => xs.map(([d, t]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: t }));
const OFFER = 'Great. I have Thu, Oct 15 at 10:00 AM ET or Fri, Oct 16 at 2:00 PM ET. Which works better?';

// ── rentals ───────────────────────────────────────────────────────────────

test('a rented-out home is a rental, whoever says it', () => {
  for (const t of [
    'We rent it out to tenants',
    "It's an investment property",
    'We have it on Airbnb',
    'It is a short-term rental',
    "I'm the property manager for the owner",
    "I'm renting, my landlord would have to okay it",
    'Can renters get a quote?',
    "It's a rental",
  ]) assert.equal(J.saysRentalProperty(t), true, t);
});

test('a home the owner lives in, or a denied rental, is not a rental', () => {
  for (const t of [
    "It's not a rental, we live there",
    'We used to rent it out but we live there now',
    'Our vacation home in Naples',
    'I own the house',
    "It's my parents' house, I don't own it",
    'I picked up a rental car',
  ]) assert.equal(J.saysRentalProperty(t), false, t);
});

test('a landlord said now gets the rental line: no times, no question', () => {
  const r = J.enforceJobScope(OFFER, { thread: [], inbound: 'The house is a rental, we rent it out to tenants' });
  assert.equal(r.text, J.RENTAL_LINE);
  assert.equal(r.block, 'rental');
  assert.doesNotMatch(r.text, /\?|AM|PM|—/);
});

test('a rental said earlier: the answer stays, the time offer goes', () => {
  const r = J.enforceJobScope('The visit takes about an hour. I have Thu, Oct 15 at 10:00 AM ET or Fri, Oct 16 at 2:00 PM ET. Which works better?',
    { thread: thread(['i', 'It is an investment property'], ['o', 'Thanks for telling me.']), inbound: 'how long is a visit?' });
  assert.equal(r.text, 'The visit takes about an hour.');
  assert.equal(r.block, 'rental');
});

test('the newest word wins: "we live there now" after a rental is a home', () => {
  const s = J.jobScopeFromThread(thread(['i', 'It was a rental'], ['o', 'Got it.'], ['i', 'We own it and we live there now']));
  assert.equal(s.block, null);
});

test('a tenant gets the same rental line from the non-owner guard (no clash)', () => {
  const inbound = "I'm renting, my landlord would have to okay it";
  const scope = J.enforceJobScope(OFFER, { thread: [], inbound });
  const owner = enforceNonOwner(scope.text, { thread: [], inbound });
  assert.equal(owner.changed, false);
  assert.equal(owner.text, J.RENTAL_LINE);
});

// ── commercial ────────────────────────────────────────────────────────────

test('commercial properties are caught', () => {
  for (const t of [
    'Do you do commercial buildings?',
    'We need windows for our office building',
    'This is for our church',
    'I manage the apartment complex',
    'Our condo association is replacing all the windows',
    'It is for my restaurant',
    'Can you quote the HOA clubhouse?',
  ]) assert.equal(J.saysCommercial(t), true, t);
});

test('a home, a home office or an ad is not commercial', () => {
  for (const t of [
    'I saw your commercial on TV',
    'My home office window leaks',
    'I own a condo in a two story building',
    'We need HOA approval first',
    'I have to go to the store, text me later',
    'after church on Sunday works',
    "It's not a business, it's our home",
  ]) assert.equal(J.saysCommercial(t), false, t);
});

test('a commercial ask gets the commercial line', () => {
  const r = J.enforceJobScope('We handle church projects. What is the best number to reach you?', { thread: [], inbound: 'We have 14 windows at our church' });
  assert.equal(r.text, J.COMMERCIAL_LINE);
  assert.equal(r.block, 'commercial');
});

// ── the minimum ───────────────────────────────────────────────────────────

test('the minimum: any three openings, or one sliding glass door', () => {
  const meets = (t) => J.meetsMinimum(J.openingsIn(t));
  assert.equal(meets('3 windows'), true);
  assert.equal(meets('2 windows and a door'), true);
  assert.equal(meets('a window and 2 doors'), true);
  assert.equal(meets('three doors'), true);
  assert.equal(meets('one sliding glass door'), true);
  assert.equal(meets('just the slider'), true);
  assert.equal(meets('12 windows'), true);
  assert.equal(meets('a few windows'), true);
  assert.equal(meets('one window'), false);
  assert.equal(meets('a couple windows'), false);
  assert.equal(meets('2 doors'), false);
  assert.equal(meets('a window and a door'), false);
  // Unknown, never a no: a bare plural or "the whole house".
  assert.equal(meets('we need windows'), null);
  assert.equal(meets('all the windows in the house'), null);
  assert.equal(meets('sliding windows'), null);
  // A garage door is not an opening we replace; it adds nothing.
  assert.equal(meets('two windows and the garage door'), false);
});

test('a stated count under the minimum gets the one check question', () => {
  for (const inbound of ['I just need one window replaced', 'I need a new front door', '2 doors', 'only two windows']) {
    const r = J.enforceJobScope(OFFER, { thread: [], inbound });
    assert.equal(r.text, J.MINIMUM_CHECK_LINE, inbound);
    assert.equal(r.reason, 'minimum_check', inbound);
    assert.match(r.text, /three windows or doors, or one sliding glass door/);
    assert.equal((r.text.match(/\?/g) || []).length, 1);
  }
});

test('a symptom is not a scope: "my window is foggy" is never checked', () => {
  for (const inbound of ['my window is foggy inside', 'the front door sticks', 'How much for a window?']) {
    const r = J.enforceJobScope(OFFER, { thread: [], inbound });
    assert.equal(r.changed, false, inbound);
  }
});

test('a no to the check is under the minimum: the decline line, no times', () => {
  const t = thread(['i', 'I just need one window replaced'], ['o', J.MINIMUM_CHECK_LINE]);
  const r = J.enforceJobScope(OFFER, { thread: t, inbound: 'No, just that one' });
  assert.equal(r.text, J.BELOW_MINIMUM_LINE);
  assert.equal(r.block, 'below_minimum');
});

test('more openings or a slider after the check: the normal flow, never asked twice', () => {
  const t = thread(['i', 'I just need one window replaced'], ['o', J.MINIMUM_CHECK_LINE]);
  for (const inbound of ['Actually also the slider', 'Yes, 3 more in the bedrooms', 'Maybe the front door too']) {
    const r = J.enforceJobScope(OFFER, { thread: t, inbound });
    assert.equal(r.changed, false, inbound);
    assert.equal(J.jobScopeBlocks(t, inbound), false, inbound);
  }
});

test('counts across messages: "2 windows", then "and a door" meets it', () => {
  const t = thread(['i', 'I need 2 windows replaced'], ['o', 'Got it.']);
  assert.equal(J.jobScopeFromThread(t, 'and a front door too').check, false);
});

test('a model-worded minimum ask stands', () => {
  const r = J.enforceJobScope('Our minimum is three windows or doors. Is there anything else you want looked at?', { thread: [], inbound: 'just one window' });
  assert.equal(r.changed, false);
});

// ── our own claims ────────────────────────────────────────────────────────

test('a draft that says we do commercial or rental work is corrected', () => {
  assert.equal(J.enforceJobScope('Yes, we do commercial work too. What got you looking?', {}).text, 'We only work on homes, not commercial properties. What got you looking?');
  assert.equal(J.enforceJobScope('Sure, we work with landlords all the time.', {}).text, "We don't work on rental properties.");
  // A sentence that already says no stands.
  assert.equal(J.enforceJobScope("We don't work on commercial properties.", {}).changed, false);
});

test('impact only: "not every window in our line is impact-rated" is corrected', () => {
  const r = J.enforceJobScope('Not every window in our line is impact-rated, so a specialist checks each opening.', {});
  assert.equal(r.text, 'Every window and door we sell is hurricane impact-rated.');
  assert.equal(J.enforceJobScope('We also have non-impact options.', {}).text, 'Every window and door we sell is hurricane impact-rated.');
  assert.equal(J.enforceJobScope('Yes, every window and door we sell is impact-rated.', {}).changed, false);
});

// ── the finished-reply check ──────────────────────────────────────────────

test('checkReply fails a time offered to a landlord, passes the rental line', () => {
  const conversation = thread(['i', 'We rent it out to tenants']);
  assert.ok(checkReply(OFFER, { channel: 'sms', inbound: 'We rent it out to tenants', conversation }).violations.some(v => v.code === 'job_scope'));
  assert.ok(!checkReply(J.RENTAL_LINE, { channel: 'sms', inbound: 'We rent it out to tenants', conversation }).violations.some(v => v.code === 'job_scope'));
});

test('checkReply with no thread checks our claims only', () => {
  const r = checkReply(OFFER, { channel: 'livechat', inbound: 'we rent it out' });
  assert.ok(!r.violations.some(v => v.code === 'job_scope'));
  assert.ok(r.skipped.includes('job_scope_lead_side'));
  assert.ok(checkReply('We also have non-impact options.', { channel: 'livechat' }).violations.some(v => v.code === 'job_scope'));
});

test('every fixed line is dash-free and has at most one question', () => {
  for (const line of [J.RENTAL_LINE, J.COMMERCIAL_LINE, J.MINIMUM_CHECK_LINE, J.BELOW_MINIMUM_LINE]) {
    assert.doesNotMatch(line, /[—–]/);
    assert.ok((line.match(/\?/g) || []).length <= 1);
  }
});
