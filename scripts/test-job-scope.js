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

// ── owners of rentals and investments are leads; a tenant is not (the user, 2026-10-20) ──

test('an owner who rents the home out, runs an Airbnb, invests or flips is not blocked', () => {
  for (const t of [
    'We rent it out to tenants',
    'We have it on Airbnb',
    'It is a short-term rental',
    "It's an investment property",
    'We are flipping this house',
    "It's a fix and flip",
    'The house is a rental, we rent it out to tenants',
  ]) {
    assert.equal(J.jobScopeFromThread([], t).block, null, t);
    assert.equal(J.enforceJobScope(OFFER, { thread: [], inbound: t }).changed, false, t);
  }
});

test('a tenant is turned away by the non-owner guard with the tenant line', async () => {
  const { TENANT_LINE } = await import('../src/agentic/non-owner.js');
  const inbound = "I'm renting, my landlord would have to okay it";
  const scope = J.enforceJobScope(OFFER, { thread: [], inbound });
  assert.equal(scope.changed, false);
  assert.equal(enforceNonOwner(scope.text, { thread: [], inbound }).text, TENANT_LINE);
  for (const t of ["I'm renting", 'help with my rent', 'my rent is $1,200', 'Can renters get a quote?']) assert.ok(J.TENANT_RX.test(t), t);
  for (const t of ['We rent it out', 'my rental property', 'I picked up a rental car', 'we use a property manager']) assert.ok(!J.TENANT_RX.test(t), t);
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

test('a stated count under the minimum gets the friendly check, never the rule first', () => {
  // The user, 2026-10-13: "I would like to get a quote on replacing 1 24x36
  // window" → "Of course, I can help with that. Are all the other windows in
  // your home already hurricane impact?"
  for (const inbound of ['I would like to get a quote on replacing 1 24x36 window', 'I would like to get a quote on replacing 1 window', 'I just need one window replaced', 'only two windows', 'one 36" window please']) {
    const r = J.enforceJobScope(OFFER, { thread: [], inbound });
    assert.equal(r.text, J.MINIMUM_CHECK_LINE, inbound);
    assert.equal(r.reason, 'minimum_check', inbound);
    assert.doesNotMatch(r.text, /minimum/);
    assert.equal((r.text.match(/\?/g) || []).length, 1);
  }
  // A door named: the doors version.
  for (const inbound of ['I need a new front door', '2 doors']) {
    assert.equal(J.enforceJobScope(OFFER, { thread: [], inbound }).text, J.MINIMUM_CHECK_DOORS_LINE, inbound);
  }
});

test('a symptom is not a scope: "my window is foggy" is never checked', () => {
  for (const inbound of ['my window is foggy inside', 'the front door sticks', 'How much for a window?']) {
    const r = J.enforceJobScope(OFFER, { thread: [], inbound });
    assert.equal(r.changed, false, inbound);
  }
});

test('"the rest are already impact" means this is the whole job: the minimum, no times', () => {
  const t = thread(['i', 'I would like a quote on replacing 1 window'], ['o', J.MINIMUM_CHECK_LINE]);
  for (const inbound of ['Yes', 'Yeah they are all impact already', 'Yes, the other 10 windows are impact', 'No, but I only want to replace this one for now', 'just this one']) {
    const r = J.enforceJobScope(OFFER, { thread: t, inbound });
    assert.equal(r.text, J.BELOW_MINIMUM_LINE, inbound);
    assert.equal(r.block, 'below_minimum', inbound);
  }
  assert.match(J.BELOW_MINIMUM_LINE, /3-opening minimum, any mix of windows and doors, or one sliding glass door/);
});

test('"the others are old" is a bigger job: the normal flow, never asked twice', () => {
  const t = thread(['i', 'I would like a quote on replacing 1 window'], ['o', J.MINIMUM_CHECK_LINE]);
  for (const inbound of ['No', 'No, the rest are original from 1990', 'Not yet, maybe all of them eventually', 'Hmm, I am not sure']) {
    const r = J.enforceJobScope(OFFER, { thread: t, inbound });
    assert.equal(r.changed, false, inbound);
    assert.equal(J.jobScopeBlocks(t, inbound), false, inbound);
  }
});

test('the other wording works the same: "Does your home only have 1 window?"', () => {
  const t = thread(['i', 'quote on 1 window'], ['o', 'Yeah, I can help you with that. Does your home only have 1 window?']);
  assert.equal(J.jobScopeFromThread(t, 'No, lol').block, null);
  assert.equal(J.jobScopeFromThread(t, 'No, but I just want this one done').block, 'below_minimum');
});

test('a model that asks "any other windows or doors?" reads a NO as the whole job', () => {
  const t = thread(['i', 'I just need one window replaced'], ['o', "Our minimum is three windows or doors. Are there any other windows or doors you'd want us to look at?"]);
  assert.equal(J.jobScopeFromThread(t, 'No, just that one').block, 'below_minimum');
  assert.equal(J.jobScopeFromThread(t, 'Actually also the slider').block, null);
});

test('counts across messages: "2 windows", then "and a door" meets it', () => {
  const t = thread(['i', 'I need 2 windows replaced'], ['o', 'Got it.']);
  assert.equal(J.jobScopeFromThread(t, 'and a front door too').check, false);
});

test('a model-worded minimum ask stands', () => {
  const r = J.enforceJobScope('Sure, I can help with that. Are the other windows in your home already impact?', { thread: [], inbound: 'just one window' });
  assert.equal(r.changed, false);
});

// ── our own claims ────────────────────────────────────────────────────────

test('a draft that says we do commercial work, or work with renters, is corrected', () => {
  assert.equal(J.enforceJobScope('Yes, we do commercial work too. What got you looking?', {}).text, 'We only work on homes, not commercial properties. What got you looking?');
  assert.equal(J.enforceJobScope('Sure, we work with renters all the time.', {}).text, 'We work with homeowners, so the owner would need to be part of it.');
  // An owner who rents the home out is a lead (2026-10-20): that is true now.
  assert.equal(J.enforceJobScope('Sure, we work with landlords all the time.', {}).changed, false);
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

test('checkReply passes a time offered to a landlord (an owner, 2026-10-20), fails one to a commercial lead', () => {
  const conversation = thread(['i', 'We rent it out to tenants']);
  assert.ok(!checkReply(OFFER, { channel: 'sms', inbound: 'We rent it out to tenants', conversation }).violations.some(v => v.code === 'job_scope'));
  const office = thread(['i', 'It is for our office building']);
  assert.ok(checkReply(OFFER, { channel: 'sms', inbound: 'It is for our office building', conversation: office }).violations.some(v => v.code === 'job_scope'));
});

test('checkReply with no thread checks our claims only', () => {
  const r = checkReply(OFFER, { channel: 'livechat', inbound: 'it is for our church' });
  assert.ok(!r.violations.some(v => v.code === 'job_scope'));
  assert.ok(r.skipped.includes('job_scope_lead_side'));
  assert.ok(checkReply('We also have non-impact options.', { channel: 'livechat' }).violations.some(v => v.code === 'job_scope'));
});

test('every fixed line is dash-free and has at most one question', () => {
  for (const line of [J.COMMERCIAL_LINE, J.MINIMUM_CHECK_LINE, J.MINIMUM_CHECK_DOORS_LINE, J.BELOW_MINIMUM_LINE]) {
    assert.doesNotMatch(line, /[—–]/);
    assert.ok((line.match(/\?/g) || []).length <= 1);
  }
});

// ── the count question (the user, 2026-10-13) ──────────────────────────────

test('the gate asks the count once, in the user\'s wording, between the zip and the decision makers', async () => {
  const P = await import('../src/agentic/nepq-planner.js');
  assert.equal(P.nextQualifyItem({ homeowner: 'yes', zip: '33908' }, []), 'openings');
  assert.deepEqual([...P.QUALIFY_LINES.openings], ['How many windows and doors are you looking to get a quote on?', 'How many windows and doors are you looking to have us come measure?']);
  // Asked once and not answered: never asked again (an unknown count never blocks).
  assert.equal(P.nextQualifyItem({ homeowner: 'yes', zip: '33908' }, [{ text: 'How many windows and doors are you looking to get a quote on?' }]), 'decision_makers');
  // Known from the thread: skipped.
  assert.equal(P.nextQualifyItem({ homeowner: 'yes', zip: '33908', openings_known: true }, []), 'decision_makers');
});

test('a count in any form makes it known; "we need windows" does not', () => {
  assert.equal(J.openingsKnown([], 'about 12 windows'), true);
  assert.equal(J.openingsKnown([], 'the whole house'), true);
  assert.equal(J.openingsKnown([], 'just the slider'), true);
  assert.equal(J.openingsKnown([], 'we need new windows'), false);
  const asked = thread(['o', 'How many windows and doors are you looking to get a quote on?']);
  assert.equal(J.openingsKnown(asked, 'about 10'), true);
  assert.equal(J.openingsKnown(asked, 'not sure yet'), false);
});

test('"1" in reply to the count question gets the friendly check next', () => {
  const asked = thread(['i', 'I want a quote'], ['o', 'How many windows and doors are you looking to get a quote on?']);
  assert.equal(J.enforceJobScope(OFFER, { thread: asked, inbound: '1' }).text, J.MINIMUM_CHECK_LINE);
  assert.equal(J.enforceJobScope(OFFER, { thread: asked, inbound: 'just 2' }).text, J.MINIMUM_CHECK_LINE);
  assert.equal(J.enforceJobScope(OFFER, { thread: asked, inbound: 'about 10' }).changed, false);
  assert.equal(J.enforceJobScope(OFFER, { thread: asked, inbound: '3' }).changed, false);
  // A time is not a count.
  assert.equal(J.enforceJobScope(OFFER, { thread: asked, inbound: '2 pm works' }).changed, false);
});

// ── saving the count (the user, 2026-10-13: "We have a custom field in GHL") ──

test('the stated count becomes Window Count / Door Count writes (a slider is a door)', () => {
  const W = J.WINDOW_COUNT_FIELD_ID, D = J.DOOR_COUNT_FIELD_ID;
  assert.deepEqual(J.openingsToSave([], 'I would like a quote on replacing 1 24x36 window'), [{ id: W, field_value: 1 }]);
  assert.deepEqual(J.openingsToSave([], '12 windows and 2 doors'), [{ id: W, field_value: 12 }, { id: D, field_value: 2 }]);
  assert.deepEqual(J.openingsToSave([], 'I need to replace our sliding glass door'), [{ id: D, field_value: 1 }]);
  assert.deepEqual(J.openingsToSave([], 'two sliding glass doors and 3 windows'), [{ id: W, field_value: 3 }, { id: D, field_value: 2 }]);
  const asked = thread(['o', 'How many windows and doors are you looking to get a quote on?']);
  assert.deepEqual(J.openingsToSave(asked, 'about 10'), [{ id: W, field_value: 10 }]);
  // Nothing to save: a symptom, a bare plural, the whole house, a time.
  for (const t of ['my window is foggy', 'we need new windows', 'all the windows in the house']) assert.deepEqual(J.openingsToSave([], t), [], t);
  assert.deepEqual(J.openingsToSave(asked, '2 pm works'), []);
  // Only the NEWEST message: an earlier count is not written again.
  assert.deepEqual(J.openingsToSave(thread(['i', '5 windows'], ['o', 'Got it.']), 'what time works?'), []);
  assert.equal(W, 'h9FJTUbmUHIuD6JKmpXv');
  assert.equal(D, 'j7l1KWmDgoJqy7SINjQs');
});

test('a count already on the contact skips the count question', async () => {
  const P = await import('../src/agentic/nepq-planner.js');
  const f = P.stageFactsNow({ stage: 'problem', facts: { homeowner: 'yes', zip: '33908' } }, [], null, true);
  assert.equal(f.openings_known, true);
  assert.equal(P.nextQualifyItem(f, []), 'decision_makers');
});

// ── the count question in every mode; a lead who had the visit is qualified (the user, 2026-10-13) ──

test('no stored stage: a yes to the bridge asks the count once, then the answer gets the times', async () => {
  const P = await import('../src/agentic/nepq-planner.js');
  const SL = [{ iso: '2026-10-06T14:00:00Z', day: 'Tue, Oct 6', time: '10:00 AM' }, { iso: '2026-10-07T18:00:00Z', day: 'Wed, Oct 7', time: '2:00 PM' }];
  const bridge = 'Based on what you told me, the next step would be a free visit at your home. Would that help?';
  const ask = 'How many windows and doors are you looking to get a quote on?';
  const first = P.planNepqTurn({ channel: 'sms', trigger: 'Yes please', conversation: thread(['o', bridge], ['i', 'Yes please']), slots: SL, tzLabel: 'ET' });
  assert.equal(first.qualify_item, 'openings');
  assert.equal(first.booking.allowed, false);
  assert.match(first.fixed_line, /How many windows and doors/);
  // 2026-10-13 (the owner): then the decision makers, once; any answer gets the times.
  const answered = P.planNepqTurn({ channel: 'sms', trigger: 'About 12', conversation: thread(['o', bridge], ['i', 'Yes please'], ['o', ask], ['i', 'About 12']), slots: SL, tzLabel: 'ET' });
  assert.equal(answered.qualify_item, 'decision_makers');
  assert.equal((answered.slots_to_offer || []).length, 0);
  const dmAsk = answered.fixed_line;
  const timed = P.planNepqTurn({ channel: 'sms', trigger: 'Just me', conversation: thread(['o', bridge], ['i', 'Yes please'], ['o', ask], ['i', 'About 12'], ['o', dmAsk], ['i', 'Just me']), slots: SL, tzLabel: 'ET' });
  assert.equal(timed.step, 'offer_slots');
  assert.equal(timed.dm_known, 'Solo Owner');
  assert.match(timed.fixed_line, /I have Tue, Oct 6 at 10:00 AM ET or Wed, Oct 7 at 2:00 PM ET/);
  // "1" is under the minimum: no times, the guard asks the friendly check.
  const one = P.planNepqTurn({ channel: 'sms', trigger: '1', conversation: thread(['o', bridge], ['i', 'Yes please'], ['o', ask], ['i', '1']), slots: SL, tzLabel: 'ET' });
  assert.equal(one.step, 'not_eligible');
  assert.equal(one.booking.allowed, false);
  // Known count (a Window Count on the contact): times straight away.
  const known = P.planNepqTurn({ channel: 'sms', trigger: 'Yes please', conversation: thread(['o', bridge], ['i', 'Yes please']), slots: SL, tzLabel: 'ET', knownOpenings: true, knownDecisionMakers: true });
  assert.equal(known.step, 'offer_slots');
});

test('a lead past its demo (postDemoLead) is never asked the count or the qualifying questions', async () => {
  const P = await import('../src/agentic/nepq-planner.js');
  const SL = [{ iso: '2026-10-06T14:00:00Z', day: 'Tue, Oct 6', time: '10:00 AM' }, { iso: '2026-10-07T18:00:00Z', day: 'Wed, Oct 7', time: '2:00 PM' }];
  const bridge = 'Based on what you told me, the next step would be a free visit at your home. Would that help?';
  const p = P.planNepqTurn({ channel: 'sms', trigger: 'Yes please', conversation: thread(['o', bridge], ['i', 'Yes please']), slots: SL, tzLabel: 'ET', postDemoLead: true });
  assert.notEqual(p.qualify_item, 'openings');
  assert.notEqual(p.step, 'not_eligible');
  // A stated single window is not checked either.
  const one = P.planNepqTurn({ channel: 'sms', trigger: 'Just one window', conversation: thread(['o', bridge], ['i', 'Just one window']), slots: SL, tzLabel: 'ET', postDemoLead: true });
  assert.notEqual(one.step, 'not_eligible');
  // Even with the stored stage driving the plan, no gate item.
  const staged = P.planNepqTurn({ channel: 'sms', trigger: 'Yes please', conversation: thread(['o', bridge], ['i', 'Yes please']), slots: SL, tzLabel: 'ET', stage: { stage: 'problem', facts: {} }, postDemoLead: true });
  assert.notEqual(staged.step, 'qualify');
  // The bots run the guard with no thread for such a lead: nothing declined, our claims still fixed.
  assert.equal(J.enforceJobScope(OFFER, {}).changed, false);
  assert.equal(J.enforceJobScope('We also have non-impact options.', {}).text, 'Every window and door we sell is hurricane impact-rated.');
});

test('a count after the noun is the count (live dry run, 2026-10-15)', () => {
  // "I need new impact windows, about 10 of them." got "How many windows and doors…?" right after "Ten windows".
  const t = 'Hi, I need new impact windows, about 10 of them. I own the house.';
  assert.equal(J.openingsIn(t).windows, 10);
  assert.equal(J.openingsKnown([], t), true);
  assert.deepEqual(J.openingsToSave([], t), [{ id: J.WINDOW_COUNT_FIELD_ID, field_value: 10 }]);
  assert.equal(J.openingsIn('doors, 2 of them').doors, 2);
  assert.equal(J.openingsIn('10 windows, all 10 of them').windows, 10, 'never counted twice');
  // Not a count: no number, or the number in another sentence.
  assert.equal(J.openingsKnown([], 'windows, some of them are foggy'), false);
  assert.equal(J.openingsKnown([], 'windows. 10 of them are mine.'), false);
  // Under the minimum still gets the one friendly check.
  assert.equal(J.jobScopeFromThread([], 'I need windows, just 1 of them').check, true);
});

test('an owner who rents the home out is never turned away (landlord_lead, live chat, 2026-10-22)', async () => {
  const { TENANT_LINE, NON_OWNER_LINE } = await import('../src/agentic/non-owner.js');
  const LIVE = "Got it. We work with homeowners on their primary residences. Since you're renting this out, it wouldn't be the right fit for us. If you own a home you live in, we'd be happy to help.";
  const landlord = 'Hi, I need new windows on a house I rent out to tenants';
  const r = J.enforceJobScope(LIVE, { thread: [], inbound: landlord });
  assert.equal(r.changed, true);
  assert.equal(r.text, 'Got it. We work with homeowners, and that includes homes you rent out.');
  assert.doesNotMatch(r.text, /primary|right fit|live in/i);
  assert.match(r.reason, /owner_rental_declined/);
  for (const d of ["We don't work on investment properties.", 'Unfortunately, rentals aren’t a good fit for us.', "Sorry, we can't take on flips."]) {
    assert.equal(J.enforceJobScope(d, {}).text, 'We work with homeowners, and that includes homes you rent out.', d);
  }
  // A tenant (or a property manager) is the real turn-away: never rewritten.
  assert.equal(J.enforceJobScope(LIVE, { thread: [], inbound: 'I rent this place and my landlord will not fix the windows' }).changed, false);
  assert.equal(J.enforceJobScope(LIVE, { thread: [], inbound: "I'm the property manager for the building owner" }).changed, false);
  // Our own lines and ordinary replies are fixed points.
  for (const l of [TENANT_LINE, NON_OWNER_LINE, J.COMMERCIAL_LINE, J.BELOW_MINIMUM_LINE, 'Do you own the home?',
    'Happy to help with the rental. How many windows and doors are you looking to get a quote on?',
    "We don't need the landlord there, just you. How many windows?"]) {
    assert.equal(J.enforceJobScope(l, {}).changed, false, l);
  }
});
