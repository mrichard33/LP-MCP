/**
 * 2026-10-02 (Mark's 4:16 PM chat): "Mark 954 379 215" (nine digits) was
 * taken as it was. A phone or email that cannot be right gets ONE friendly
 * re-check; numbers that are not phone attempts are never flagged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTypedPhone, checkTypedEmail, contactRecheckLine, alreadyRechecked } from '../src/agentic/contact-check.js';
import { nameFromReply } from '../src/agentic/booking-collect.js';

test('a phone missing a digit, or with one too many, is caught', () => {
  assert.equal(checkTypedPhone('Mark 954 379 215'), 'short');
  assert.equal(checkTypedPhone('call me at 954-3792'), 'short');
  assert.equal(checkTypedPhone('95437921555'), 'long');
});

test('real phones and other numbers are left alone', () => {
  for (const t of ['954-379-2150', '(954) 379-2150', '+1 954 379 2150', '19543792150', '33607-1234', '16828 Crown Bridge Dr 34470', 'tomorrow at 10:00', '12 windows and 2 doors', 'about $15000']) {
    assert.equal(checkTypedPhone(t), null, t);
  }
});

test('an email that cannot be right is caught; a good one is not', () => {
  for (const t of ['mark@gmail', 'mark gmail.com', 'markgmail.com', 'mark@@yahoo.com', 'mark at gmail dot com']) assert.equal(checkTypedEmail(t), true, t);
  for (const t of ['mark@gmail.com', 'Mark.R@company.co', 'my windows are old', '12 Main St']) assert.equal(checkTypedEmail(t), false, t);
});

test('asked once: after our re-check, the next answer is taken as it is', () => {
  const first = contactRecheckLine({ text: 'Mark 954 379 215', recentOutbound: ['what is your number?'], firstName: 'Mark' });
  assert.equal(first.kind, 'short');
  assert.match(first.line, /^Thanks, Mark\. /);
  assert.equal(alreadyRechecked([first.line]), true);
  assert.equal(contactRecheckLine({ text: '954 379 215', recentOutbound: [first.line] }), null);
  assert.equal(contactRecheckLine({ text: 'sounds good' }), null);
});

test('a first name from a reply to our name question, or "my name is"', () => {
  assert.equal(nameFromReply('Mark', { asked: true }), 'Mark');
  assert.equal(nameFromReply('it\'s maria', { asked: true }), 'Maria');
  assert.equal(nameFromReply('Mark'), null, 'unprompted single words are not names');
  assert.equal(nameFromReply("My name is Mark, and you're not able to set up a time now?"), 'Mark');
  for (const t of ['yes', 'No, just me', 'the first one', '352-555-0188']) assert.equal(nameFromReply(t, { asked: true }), null, t);
});
