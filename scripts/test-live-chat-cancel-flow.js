/**
 * Live chat cancel flow, pure half (src/live-chat/cancel-flow.js). The lane
 * side is in test-live-chat-fast-lane.js. 2026-10-02, "Guest Visitor tzuzq".
 *
 * Run: node --test scripts/test-live-chat-cancel-flow.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../src/live-chat/cancel-flow.js');
const t = (direction, text) => ({ direction, text });

test('isCancelRequest: the ways the tzuzq visitor said it', () => {
  for (const s of ['cancel my appt please. not buying g anything', 'please cancel the appointment', "don't waste your time coming", 'no time. do not come', "you won't be allowed in", 'call it off']) {
    assert.equal(C.isCancelRequest(s), true, s);
  }
  for (const s of ['How much for 12 windows?', 'Do you come out to Palm Coast?', 'tomorrow evening 6 pm Rick fox']) {
    assert.equal(C.isCancelRequest(s), false, s);
  }
});

test('names and phones from what the visitor typed', () => {
  assert.deepEqual(C.nameWords(['tomorrow evening 6 pm Rick fox']), ['rick', 'fox']);
  assert.deepEqual(C.nameWords(['cancel my appt please. not buying g anything']), []);
  assert.equal(C.phoneDigits('Rick Fox (352) 555-0188'), '3525550188');
  assert.equal(C.formatPhone('3525550188'), '(352) 555-0188');
  assert.equal(C.nameMatches(['rick', 'fox'], { firstName: 'Rick', lastName: 'Fox' }), true);
  assert.equal(C.nameMatches(['jane', 'doe'], { firstName: 'Rick', lastName: 'Fox' }), false);
});

test('planCancelTurn walks ask → lookup → offer answer, from the thread alone', () => {
  const ask = C.planCancelTurn({ body: 'cancel my appt', thread: [t('inbound', 'cancel my appt')] });
  assert.equal(ask.step, 'ask_identity');
  const both = C.planCancelTurn({ body: 'cancel my appt for Rick Fox 3525550188', thread: [t('inbound', 'cancel my appt for Rick Fox 3525550188')] });
  assert.deepEqual([both.step, both.phone], ['lookup', '3525550188']);
  const noPhone = C.planCancelTurn({ body: 'Rick Fox', thread: [t('inbound', 'cancel'), t('outbound', C.ASK_IDENTITY_LINE), t('inbound', 'Rick Fox')] });
  assert.equal(noPhone.step, 'ask_phone');
  const twice = C.planCancelTurn({ body: 'why', thread: [t('inbound', 'cancel'), t('outbound', C.ASK_PHONE_LINE), t('inbound', 'why')] });
  assert.equal(twice.step, 'handoff', 'asked twice, a person takes it');
  const known = C.planCancelTurn({ body: 'cancel it', thread: [t('inbound', 'cancel it')], known: { phone: '+13525550188', hasName: true } });
  assert.deepEqual([known.step, known.known], ['lookup', true]);
  const offer = C.offerLine('Rick', 'Thu, Oct 2, 6:00 PM ET');
  const after = C.planCancelTurn({ body: 'no just cancel it', thread: [t('inbound', 'cancel'), t('outbound', C.ASK_IDENTITY_LINE), t('inbound', 'Rick Fox 3525550188'), t('outbound', offer), t('inbound', 'no just cancel it')] });
  assert.deepEqual([after.step, after.answer, after.phone], ['after_offer', 'cancel', '3525550188']);
  assert.deepEqual(after.words, ['rick', 'fox']);
  const done = C.planCancelTurn({ body: 'do not come', thread: [t('inbound', 'cancel'), t('outbound', C.doneLine('Thu, Oct 2, 6:00 PM ET')), t('inbound', 'do not come')] });
  assert.equal(done, null, 'a finished flow does not restart');
});

test('classifyOfferAnswer and pickAppointment', () => {
  assert.equal(C.classifyOfferAnswer('no'), 'cancel');
  assert.equal(C.classifyOfferAnswer('just cancel it please'), 'cancel');
  assert.equal(C.classifyOfferAnswer('yes next week'), 'reschedule');
  assert.equal(C.classifyOfferAnswer('hmm what'), 'unclear');
  assert.equal(C.pickAppointment([{ appointment_id: 'a', status: 'cancelled' }, { appointment_id: 'b', status: 'confirmed' }]).appointment_id, 'b');
  assert.equal(C.pickAppointment([]), null);
});

test('the sales card tells a person what to do in LP', () => {
  const ok = C.formatCancelCard({ kind: 'cancel', ghlCancelled: true, name: 'Rick Fox', phone: '3525550188', apptHuman: 'Thu, Oct 2, 6:00 PM ET', visitorWords: 'no', contactUrl: 'https://ghl/x' });
  assert.match(ok, /^📅 LIVE CHAT CANCEL — cancel it in LP/);
  assert.match(ok, /Rick Fox asked to cancel the appointment on Thu, Oct 2, 6:00 PM ET\./);
  assert.match(ok, /GHL: ✅ cancelled by the bot\. → Cancel it in LP\./);
  const notDone = C.formatCancelCard({ kind: 'cancel', ghlCancelled: false, name: null, phone: null });
  assert.match(notDone, /NOT cancelled/);
  assert.match(notDone, /Phone: not given/);
  assert.match(C.formatCancelCard({ kind: 'reschedule', name: 'Rick', phone: '3525550188', apptHuman: 'x' }), /RESCHEDULE/);
});


// Part 8 (Mark, 2026-10-02): the model words every cancel-flow reply, so each
// step is read back by meaning. Today's lines and AI-worded ones both count.
test('planCancelTurn reads every step from an AI-worded line too', () => {
  const ask = "Sorry about that, I can help. What's the full name and phone number the appointment is under?";
  assert.equal(C.planCancelTurn({ body: 'Rick Fox', thread: [t('inbound', 'cancel'), t('outbound', ask), t('inbound', 'Rick Fox')] }).step, 'ask_phone');
  const phoneAsk = 'Got it, Rick. And the phone number the appointment is under?';
  assert.equal(C.planCancelTurn({ body: 'why', thread: [t('inbound', 'cancel'), t('outbound', phoneAsk), t('inbound', 'why')] }).step, 'handoff');
  const offer = 'Found it, Rick: Thu, Oct 2 at 6:00 PM ET. Would another day work instead of cancelling?';
  assert.equal(C.planCancelTurn({ body: 'yes', thread: [t('inbound', 'cancel'), t('outbound', offer), t('inbound', 'yes')] }).step, 'after_offer');
  const slots = 'Happy to. I can move it to Tue, Oct 6 at 10:00 AM or Wed, Oct 7 at 2:00 PM ET. Which one works better?';
  assert.equal(C.planCancelTurn({ body: 'the first', thread: [t('inbound', 'cancel'), t('outbound', slots), t('inbound', 'the first')] }).step, 'pick_slot');
  for (const fin of ['All done, Rick. Your Thu, Oct 2 visit is cancelled.', "You're now set for Tue, Oct 6 at 10:00 AM ET.", 'A team member will call you to set up a new time.', 'Our scheduling team has it and will confirm with you.']) {
    assert.equal(C.planCancelTurn({ body: 'do not come', thread: [t('inbound', 'cancel'), t('outbound', fin), t('inbound', 'do not come')] }), null, fin);
  }
  // Every step has the phrase its reply must keep, and today's lines carry it.
  assert.equal(C.cancelMarkerKey({ step: 'ask_identity' }), 'ask_identity');
  assert.equal(C.cancelMarkerKey({ outcome: 'would_reschedule' }), 'rescheduled');
  assert.equal(C.cancelMarkerKey({ outcome: 'reschedule_failed' }), 'reschedule');
  const lines = { ask_identity: C.ASK_IDENTITY_LINE, ask_phone: C.ASK_PHONE_LINE, offered_reschedule: C.offerLine('Rick', 'x'), cancelled: C.doneLine('x'), rescheduled: C.movedLine({ day: 'Tue, Oct 6', time: '10:00 AM' }), reschedule: C.rescheduleLine('3525550188'), handoff: C.HANDOFF_LINE, offered_slots: C.slotsOfferLine([{ day: 'Tue, Oct 6', time: '10:00 AM' }, { day: 'Wed, Oct 7', time: '2:00 PM' }]) };
  for (const [k, line] of Object.entries(lines)) assert.ok(C.CANCEL_MARKERS[k].every(m => m.rx.test(line)), k);
});
