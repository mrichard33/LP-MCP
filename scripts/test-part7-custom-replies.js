/**
 * Part 7 (Mark, 2026-10-02): "I don't think we need any static messages sent
 * by the bot. Each message should be custom." Fixed lines are references the
 * model writes its own version of; code checks the version against the
 * reference (its real times, its question, its promise of a person, the
 * phrases the next turn reads back), and the line ships only as the backup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test';

const { referenceRules, referenceRulesText, checkAgainstReference, enforceNepqPlan, referenceRetryNote, LINES } = await import('../src/agentic/nepq-planner.js');
const { renderPlanBlock } = await import('../src/prompts/response-generator/nepq-backbone.js');
const { lpRelationship } = await import('../src/prompts/response-generator/context-frame.js');
const { alreadyRechecked, recheckHint } = await import('../src/agentic/contact-check.js');

const SLOTS = [{ day: 'Sat, Oct 3', time: '10:00 AM', tz: 'ET' }, { day: 'Sun, Oct 4', time: '6:00 PM', tz: 'ET' }];

test('the prompt shows the line as a reference with its job, never "send exactly this"', () => {
  const plan = { required_move: 'offer_slots', fixed_line: LINES.offer_slots(SLOTS, 0), slots_to_offer: SLOTS };
  const block = renderPlanBlock(plan).join('\n');
  assert.doesNotMatch(block, /Send exactly this/);
  assert.match(block, /A reference line that does this job/);
  assert.match(block, /Never copy the reference word for word/);
  assert.match(block, /Sat, Oct 3 at 10:00 AM or Sun, Oct 4 at 6:00 PM/);
});

test('reference rules come from the line itself', () => {
  const r = referenceRules(LINES.handoff.complaint);
  assert.equal(r.promisesTeam, true);
  assert.equal(r.noQuestion, true);
  assert.match(referenceRulesText(r), /someone from our team/);
  const price = referenceRules(LINES.quote_first('windows'), [], { objection: { type: 'price' } });
  assert.ok(price.markers.some(m => /every home is different/.test(m.say)), 'a price reply always says why there is no number');
});

test('checks: real times kept, no invented time, the question, the person, the read-back phrase', () => {
  const offer = LINES.offer_slots(SLOTS, 0);
  assert.deepEqual(checkAgainstReference('Evenings are easier with work, so how about Sat, Oct 3 at 10:00 AM or Sun, Oct 4 at 6:00 PM?', offer, SLOTS), []);
  assert.ok(checkAgainstReference('How about Saturday at 10 or Sunday at 6?', offer, SLOTS).some(p => p.startsWith('missing_time')));
  assert.ok(checkAgainstReference('How about Sat, Oct 3 at 10:00 AM or Sun, Oct 4 at 6:00 PM, or Monday at 9 AM?', offer, SLOTS).includes('other_time'));
  assert.ok(checkAgainstReference("Sorry to hear that. Let's sort it out.", LINES.handoff.complaint).includes('no_team_follow_up'));
  assert.deepEqual(checkAgainstReference("I'm sorry about that, Dana. I'm getting someone from our team on it right now.", LINES.handoff.complaint), []);
  assert.ok(checkAgainstReference('Got it. Which window bothers you most?', LINES.close).includes('asks_a_question'));
  assert.ok(checkAgainstReference('Sure. When should we come by?', LINES.reveal).some(p => p.startsWith('missing:')));
});

test('enforceNepqPlan: a good draft for a fixed move is kept; a bad one falls back with the reasons', () => {
  const plan = { required_move: 'objection_play', objection: { type: 'spouse', attempt: 1 }, fixed_line: LINES.spouse_1, counters: {}, booking: { allowed: false } };
  const good = enforceNepqPlan("That's fair, Dana. How does your husband feel about finally fixing the drafty bedroom windows?", plan);
  assert.deepEqual(good.failed, []);
  assert.match(good.text, /husband/);
  const bad = enforceNepqPlan('Sounds good. Anything else I can help with?', plan);
  assert.equal(bad.text, LINES.spouse_1);
  assert.ok(bad.failed.length);
  assert.match(referenceRetryNote(plan, bad.failed), /in your own words/);
});

test('a caller\'s own reference (live chat booking or hand-off line) is checked the same way', () => {
  const ref = 'Got it, Tue, Oct 6 at 10:00 AM ET. A team member will reach out to confirm the details.';
  const plan = { required_move: 'confirm', counters: {}, booking: { allowed: true }, reference_line: ref, reference_slots: [{ day: 'Tue, Oct 6', time: '10:00 AM' }] };
  assert.deepEqual(enforceNepqPlan('Thanks, Mark. Tue, Oct 6 at 10:00 AM works, and a team member will reach out to confirm the details.', plan).failed, []);
  assert.equal(enforceNepqPlan('Thanks, Mark!', plan).text, ref);
});

test('HISTORY WITH REECE tells the model a returning customer is not a new lead', () => {
  const [line] = lpRelationship({ relationship: 'returning_customer', priorSaleDate: '2021-05-04T00:00:00Z', leadCount: 3, latestDisposition: 'Set' });
  assert.match(line, /RETURNING CUSTOMER/);
  assert.match(line, /last sale 2021-05-04/);
  assert.match(line, /3 lead record/);
});

test('a re-check the model words itself still counts as asked (ask once only)', () => {
  assert.equal(alreadyRechecked(['Hmm, I think something is off there. Could you double-check that number for me?']), true);
  assert.equal(alreadyRechecked(['What day works best for you?']), false);
  assert.match(recheckHint({ kind: 'email', line: "That email doesn't look quite right. Could you double-check it for me?" }), /CONTACT RE-CHECK/);
});

// ── 2026-10-02 replay fixes (Part 7 live) ───────────────────────────────

test('a real time written the human way still counts ("Sunday at 10 AM"), and never the wrong one', async () => {
  const { slotMentionIndex, offeredSlots } = await import('../src/live-chat/cancel-flow.js');
  const sun10 = { iso: 'a', day: 'Sun, Oct 4', time: '10:00 AM', dayOfWeek: 'Sunday' };
  const sat2 = { iso: 'b', day: 'Sat, Oct 3', time: '2:00 PM', dayOfWeek: 'Saturday', rel: 'tomorrow' };
  const sun2 = { iso: 'c', day: 'Sun, Oct 4', time: '2:00 PM', dayOfWeek: 'Sunday' };
  assert.deepEqual(offeredSlots('How about Sunday at 10 AM or tomorrow at 2pm?', [sun10, sat2, sun2]).map(s => s.iso), ['a', 'b']);
  assert.equal(slotMentionIndex('Sunday at 10:30 AM', sun10), -1, 'a different time is not this slot');
  const offer = LINES.offer_slots([{ ...sun10, tz: 'ET' }, { ...sat2, tz: 'ET' }], 0);
  assert.deepEqual(checkAgainstReference('Since weekends are easier, how about Sunday at 10 AM or tomorrow at 2 PM?', offer, [sun10, sat2]), []);
});

test('a typed time that is one of our real openings is the pick, even after a day question', async () => {
  const { planNepqTurn } = await import('../src/agentic/nepq-planner.js');
  const two = [{ iso: '2026-10-03T14:00:00-04:00', day: 'Sat, Oct 3', time: '2:00 PM', dayOfWeek: 'Saturday' }, { iso: '2026-10-04T10:00:00-04:00', day: 'Sun, Oct 4', time: '10:00 AM', dayOfWeek: 'Sunday' }];
  const conv = [{ direction: 'inbound', text: 'I need to check with my wife' }, { direction: 'outbound', text: "Would it be easier to pick a time when you're both home? What day works best for you both?" }, { direction: 'inbound', text: 'Fine lets book for 2 PM.' }];
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Fine lets book for 2 PM.', conversation: conv, slots: two, tzLabel: 'ET' });
  assert.equal(plan.required_move, 'confirm');
  const after = planNepqTurn({ channel: 'sms', trigger: 'We are usually home after 2 PM', conversation: [...conv.slice(0, 2), { direction: 'inbound', text: 'We are usually home after 2 PM' }], slots: two, tzLabel: 'ET' });
  assert.notEqual(after.required_move, 'confirm', '"after 2 PM" is a preference, not a pick');
});

test('once times were offered the bot never goes back to the visit pitch, even past the discovery cap', async () => {
  const { planNepqTurn } = await import('../src/agentic/nepq-planner.js');
  const two = [{ iso: 'x', day: 'Sat, Oct 3', time: '2:00 PM', dayOfWeek: 'Saturday' }, { iso: 'y', day: 'Sun, Oct 4', time: '10:00 AM', dayOfWeek: 'Sunday' }];
  const conv = [
    { direction: 'inbound', text: 'I need new windows' }, { direction: 'outbound', text: "What's going on with them?" },
    { direction: 'inbound', text: 'old' }, { direction: 'outbound', text: 'How long has that been going on?' },
    { direction: 'inbound', text: 'years' }, { direction: 'outbound', text: 'What made you start looking now?' },
    { direction: 'inbound', text: 'moving' }, { direction: 'outbound', text: 'I have Sat, Oct 3 at 2:00 PM ET or Sun, Oct 4 at 10:00 AM ET. Which works better?' },
    { direction: 'inbound', text: 'hmm' }, { direction: 'outbound', text: 'No rush at all.' },
    { direction: 'inbound', text: 'Mark' },
  ];
  const plan = planNepqTurn({ channel: 'sms', trigger: 'Mark', conversation: conv, slots: two, tzLabel: 'ET' });
  assert.notEqual(plan.required_move, 'bridge');
});
