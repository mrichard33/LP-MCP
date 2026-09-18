/**
 * test-decision-maker-guard.js — ALL DECISION MAKERS ATTEND (Mark's ruling,
 * 2026-09-18) is enforced, not merely written in the prompt.
 *
 * Catherine Crosier wrote: "i am the main decision maker of the house hold they
 * would not make an appointment without my husband being at the appointment.
 * That is a shame you could have gotten some business bad decision on there
 * part." Generation failed and agent_actions 475065 answered her with the
 * neutral fallback copy, which engaged with none of it.
 *
 * This ruling REVERSES the ONE-LEGGER "advocate once, respect twice" policy
 * that stood until this date, under which a sole-decision-maker claim was an
 * instruction to book one person immediately. Three things had to change:
 *   1. the gate — having ASKED is no longer a pass; the answer must be
 *      favourable ("Yes" or "Solo Owner");
 *   2. the ask — an unresolved answer has its own next question;
 *   3. the fallback — a decision-maker message goes to a person, never to the
 *      generic copy.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { assertBookingPrerequisites } = await import('../src/services/identity-extraction.js');
const { resolveNextMissing, prerequisiteAskMessage, PREREQUISITE_ASK_INSTRUCTION } =
  await import('../src/appointments/prerequisite-ask.js');
const { _internal } = await import('../src/send-message-handler.js');
const { findDecisionMakerSignals } = _internal;

/** A contact with every non-decision-maker prerequisite already satisfied. */
const ready = (dm) => ({
  identity: {
    first_name: 'Catherine', last_name: 'Crosier',
    address_line1: '12 Palm Ct', city: 'Tampa', state: 'FL', postal_code: '33602',
    phone: '+18135550117', email: 'ccrosier827@att.net',
    decision_maker_question_asked: dm.asked,
    decision_maker_confirmed: dm.confirmed,
  },
  tags: [],
});

// ─── the gate ────────────────────────────────────────────────────────────

test('CASE 1 — "I\'m the main decision maker, my husband doesn\'t need to be there"', () => {
  // Maps to "No" per the Q3 SOLE-AUTHORITY rule: a partner exists and will not
  // attend. Under the OLD policy this booked one person on the spot.
  const gate = assertBookingPrerequisites(ready({ asked: true, confirmed: false }));
  assert.equal(gate.ok, false, 'the gate must hold');
  assert.ok(gate.missing.includes('decision_maker_unresolved'), gate.missing.join(','));
  // response-generator nulls availability and booking_url on !gate.ok, so no
  // slot and no booking link reach the model this turn.
  assert.equal(gate.appointment_status, 'new');
});

test('CASE 2 — "It\'s just me, I own the house alone"', () => {
  // Solo Owner is a complete decision-making unit. One person is right, and
  // the gate must NOT hold — refusing here would punish an honest answer.
  const gate = assertBookingPrerequisites(ready({ asked: true, confirmed: true }));
  assert.equal(gate.ok, true, gate.missing.join(','));
  assert.deepEqual(gate.missing, []);
  assert.equal(gate.appointment_status, 'confirmed');
});

test('never discussed still holds, and asks the FIRST question', () => {
  const gate = assertBookingPrerequisites(ready({ asked: false, confirmed: 'unknown' }));
  assert.equal(gate.ok, false);
  assert.ok(gate.missing.includes('decision_maker_question'));
  assert.ok(!gate.missing.includes('decision_maker_unresolved'), 'only one DM key at a time');
});

test('"Uncertain" is not a pass — "I\'ll see if she can make it" holds the slot', () => {
  const gate = assertBookingPrerequisites(ready({ asked: true, confirmed: false }));
  assert.equal(gate.ok, false);
});

test('exactly ONE decision-maker key is ever missing, so the next ask is unambiguous', () => {
  for (const dm of [
    { asked: false, confirmed: 'unknown' },
    { asked: true, confirmed: false },
    { asked: true, confirmed: true },
  ]) {
    const dmKeys = assertBookingPrerequisites(ready(dm)).missing
      .filter(k => k.startsWith('decision_maker'));
    assert.ok(dmKeys.length <= 1, JSON.stringify(dm) + ' → ' + dmKeys.join(','));
  }
});

// ─── the ask ─────────────────────────────────────────────────────────────

test('an unresolved answer asks ONE clarifying question and offers no slot', () => {
  const missing = assertBookingPrerequisites(ready({ asked: true, confirmed: false })).missing;
  assert.equal(resolveNextMissing(missing), 'decision_maker_unresolved');

  const msg = prerequisiteAskMessage(missing);
  assert.equal((msg.match(/\?/g) || []).length, 1, `one question mark: ${msg}`);
  assert.doesNotMatch(msg, /\d{1,2}\s*(am|pm)|monday|tuesday|wednesday|thursday|friday/i,
    'no slot may be offered while the question is open');
});

test('the instruction tells the model to acknowledge, not argue, and offers the phone call', () => {
  const instruction = PREREQUISITE_ASK_INSTRUCTION.decision_maker_unresolved;
  assert.match(instruction, /without arguing/i);
  assert.match(instruction, /15-minute phone call/i);
  assert.match(instruction, /both/i);
  assert.match(instruction, /Do NOT offer an in-home slot for one person/i);
});

test('the first decision-maker ask is one plain question', () => {
  const msg = prerequisiteAskMessage(['decision_maker_question']);
  assert.equal((msg.match(/\?/g) || []).length, 1, msg);
});

// ─── the fallback must never answer a decision-maker message ─────────────

test('Catherine Crosier\'s actual message is detected', () => {
  const inbound = 'i am the main decision maker of the house hold they would not make an appointment '
    + 'without my husband being at the appointment .\nThat is a shame  you could have gotten some '
    + 'business  bad decision on there part';
  const signals = findDecisionMakerSignals(inbound);
  assert.ok(signals.length > 0, 'the incident message must be caught');
});

test('CASE 1 and CASE 2 phrasings are both detected', () => {
  for (const inbound of [
    "I'm the main decision maker, my husband doesn't need to be there",
    "It's just me, I own the house alone",
  ]) {
    assert.ok(findDecisionMakerSignals(inbound).length > 0, inbound);
  }
});

test('the common phrasings are covered', () => {
  for (const inbound of [
    'my wife wont be there that day',
    'I need to talk to my husband first',
    'I make all the decisions here',
    "it's my call",
    'I live alone',
    "I'm the only one on the deed",
    'can we both be there at 3?',
    'she cannot be there until Friday',
  ]) {
    assert.ok(findDecisionMakerSignals(inbound).length > 0, inbound);
  }
});

test('ordinary messages are not decision-maker messages', () => {
  for (const inbound of [
    'What do impact windows cost?',
    'Can you come out Tuesday?',
    'Yes that time works, see you then',
    'Please stop texting me',
    'How long does the install take?',
    '', null, undefined,
  ]) {
    assert.deepEqual(findDecisionMakerSignals(inbound), [], String(inbound));
  }
});
