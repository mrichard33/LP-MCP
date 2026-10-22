/**
 * Did the rehash rep finish the conversation? (Mark, 2026-10-21)
 * Deterministic both ways; anything the words do not decide is ambiguous and
 * OPEN (a wrong silence costs more than a wrong reply).
 *
 * Run: node --test scripts/test-conversation-complete.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationComplete, readLeadMessage, readModelVerdict, completionPrompt } from '../src/agentic/conversation-complete.js';

const lead = (text) => ({ direction: 'inbound', text });
const john = (text) => ({ direction: 'outbound', text, manual: true });
const bot = (text) => ({ direction: 'outbound', text });

test('Jim Anderson: John set the time, Jim closed it → complete', () => {
  const thread = [
    john('jim this is john … can we have our GM reduce the price at your place tomorrow any time'),
    lead('We have an opportunity to talk with you at 10am tomorrow. Does that work for you?'),
    john('yes call 7275579775'),
    john('we will see u both at your place 10m tomorrow'),
    lead('Actually, we are meeting Tomorrow at 10am...'),
    lead('No need to call, just show up ...'),
    john('yes'),
    lead('See you tomorrow'),
  ];
  const v = conversationComplete({ thread });
  assert.equal(v.complete, true);
  assert.equal(v.ambiguous, false);
});

test('the lead closed: "sounds good see you tomorrow" → complete', () => {
  assert.equal(conversationComplete({ thread: [john('We can come by tomorrow at 10'), lead('sounds good see you tomorrow')] }).complete, true);
});

test('the lead left something open → open', () => {
  for (const t of ['what time again?', 'Ok but the price is still too much', 'Can you move it to Friday', 'We are comparing it to the other proposals']) {
    const v = conversationComplete({ thread: [john('We can come by tomorrow at 10'), lead(t)] });
    assert.equal(v.complete, false, t);
    assert.equal(v.ambiguous, false, t);
  }
});

test('the rep spoke last → complete (the floor is theirs)', () => {
  assert.equal(conversationComplete({ thread: [lead('what time?'), john('10am tomorrow, see you then')] }).complete, true);
});

test('words that decide nothing → ambiguous, open', () => {
  const v = conversationComplete({ thread: [bot('Hi Jim'), lead('Actually, we are meeting Tomorrow at 10am...')] });
  assert.equal(v.complete, false);
  assert.equal(v.ambiguous, true);
  assert.equal(readLeadMessage('Actually, we are meeting Tomorrow at 10am...'), null);
});

test('the model: low confidence or unreadable is open', () => {
  assert.equal(readModelVerdict({ complete: true, confidence: 0.9 }).complete, true);
  assert.equal(readModelVerdict({ complete: true, confidence: 0.4 }).complete, false);
  assert.equal(readModelVerdict(null).complete, false);
  assert.match(completionPrompt([john('hi'), lead('ok')]), /Team member: hi\nHomeowner: ok/);
});
