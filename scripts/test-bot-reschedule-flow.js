/**
 * Reschedule flow — scripts/test-bot-reschedule-flow.js
 *
 * 2026-10-12 (handoff "Lead Conversation Stage", PR 5; simulator flag
 * reschedule_not_moved, batch 2 #1): an unrelated reply got "I've passed your
 * cancellation" and a cancel card; "different day" got "let me find options"
 * and no times; "the first one" was asked for a window count like a new lead.
 * With LEAD_STAGE_MODE=live: an unclear answer gets one clarifying question,
 * never a cancel; a move wins over a "no" next to it; any offer of ours that
 * names a time is the flow's slot offer, so a pick moves the appointment; the
 * stage records reschedule:offered → reschedule:moved, then back to booked.
 * The lane-level cases are in scripts/test-live-chat-fast-lane.js.
 *
 * Run: node --test scripts/test-bot-reschedule-flow.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../src/live-chat/cancel-flow.js');
const S = await import('../src/agentic/lead-stage.js');

const t = (...xs) => xs.map(([d, x]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: x }));
const OFFER = 'Thanks, Rick. I found your appointment for Thu, Oct 2, 6:00 PM ET. Would a different day work better instead of cancelling?';
const UP_TO_OFFER = [['i', 'I need to cancel my appointment'], ['o', C.ASK_IDENTITY_LINE], ['i', 'Rick Fox 352-555-0188'], ['o', OFFER]];

test('the answer to the offer: a move wins over a "no" next to it (live only)', () => {
  assert.equal(C.classifyOfferAnswer('no, a different day please', { stageLive: true }), 'reschedule');
  assert.equal(C.classifyOfferAnswer('no, a different day please'), 'cancel', 'today');
  assert.equal(C.classifyOfferAnswer('can we move it to next week', { stageLive: true }), 'reschedule');
  assert.equal(C.classifyOfferAnswer('no just cancel it', { stageLive: true }), 'cancel');
  assert.equal(C.classifyOfferAnswer('what color are the frames', { stageLive: true }), 'unclear');
});

test('the clarifying question is read back as part of the flow', () => {
  const p = C.planCancelTurn({ body: 'move it please', thread: t(...UP_TO_OFFER, ['i', 'hmm'], ['o', C.CLARIFY_LINE], ['i', 'move it please']), stageLive: true });
  assert.equal(p.step, 'after_offer');
  assert.equal(p.clarified, true);
  assert.equal(p.answer, 'reschedule');
  // Off live, the clarifying line is not ours to read.
  assert.equal(C.planCancelTurn({ body: 'move it please', thread: t(...UP_TO_OFFER, ['i', 'hmm'], ['o', C.CLARIFY_LINE], ['i', 'move it please']) }), null);
  assert.equal(C.cancelMarkerKey({ outcome: 'clarify' }), 'clarify');
  assert.ok(C.CANCEL_MARKERS.clarify[0].rx.test(C.CLARIFY_LINE));
});

test('any offer of ours that names a time is the slot offer (live); the reschedule offer itself is not', () => {
  const modelOffer = 'No problem. I can do Tue, Oct 6 at 10:00 AM or Wed, Oct 7 at 2:00 PM ET. Which works better?';
  const live = C.planCancelTurn({ body: 'The first one', thread: t(...UP_TO_OFFER, ['i', 'yes'], ['o', modelOffer], ['i', 'The first one']), stageLive: true });
  assert.equal(live.step, 'pick_slot');
  assert.equal(live.offersInFlow, 1);
  const legacy = C.planCancelTurn({ body: 'The first one', thread: t(...UP_TO_OFFER, ['i', 'yes'], ['o', modelOffer], ['i', 'The first one']) });
  assert.equal(legacy, null, 'today: out of the flow (the bug)');
  const answer = C.planCancelTurn({ body: 'yes', thread: t(...UP_TO_OFFER, ['i', 'yes']), stageLive: true });
  assert.equal(answer.step, 'after_offer', 'the appointment line (with its time) is the offer, not a slot offer');
});

test('a finished flow does not restart; a booking offer outside a cancel flow is not the flow', () => {
  const p = C.planCancelTurn({ body: 'the first one', thread: t(['o', 'I have Thu at 10:00 AM or Fri at 2:00 PM. Which works better?'], ['i', 'the first one']), stageLive: true });
  assert.equal(p, null);
});

test('the rescheduled card withdraws an earlier cancel request', () => {
  const card = C.formatCancelCard({ kind: 'rescheduled', name: 'Rick Fox', phone: '3525550188', apptHuman: 'Thu, Oct 2, 6:00 PM ET', newTimeHuman: 'Tue, Oct 6 at 10:00 AM ET' });
  assert.match(card, /WITHDRAWN: do not cancel it/);
});

test('the stage: reschedule:offered → reschedule:moved, then back to booked', () => {
  assert.equal(S.rescheduleStepFor('offered_slots'), 'offered');
  assert.equal(S.rescheduleStepFor('rescheduled'), 'moved');
  assert.equal(S.rescheduleStepFor('clarify'), null);
  let r = S.computeStage({ stored: { stage: 'booked', facts: {} }, conversation: t(['i', 'yes a different day']), reply: 'I have Tue at 10:00 AM or Wed at 2:00 PM. Which works better?', ctx: { reschedule: 'offered' } });
  assert.equal(r.stage, 'reschedule:offered');
  assert.equal(S.ghlLabelFor(r.stage), 'Reschedule');
  assert.equal(r.facts.return_to, 'booked');
  r = S.computeStage({ stored: r, conversation: t(['i', 'the first one']), reply: "You're now set for Tue at 10:00 AM.", ctx: { reschedule: 'moved' } });
  assert.equal(r.stage, 'reschedule:moved');
  r = S.computeStage({ stored: r, conversation: t(['i', 'thanks']), reply: 'You are welcome.' });
  assert.equal(r.stage, 'booked');
  const input = S.buildStageInput({ conversation: [], trigger: 'x', reschedule: 'offered' });
  assert.equal(input.ctx.reschedule, 'offered');
  assert.equal(S.buildStageInput({ reschedule: 'bogus' }).ctx.reschedule, undefined);
});
