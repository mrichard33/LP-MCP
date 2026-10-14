/**
 * Rehash reply intent (John Manieri, 2026-10-14). #contact-rehash got "said yes
 * to a call" cards for leads who never agreed to a call. These are the 14 real
 * messages behind the cards of 2026-10-10..10-14: none of them is a call request.
 *
 * Run: node --test scripts/test-rehash-intent.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRehashReply, leadTextFromNotes, offeredCall, rehashIntentRoutingEnabled } from '../src/agentic/rehash-intent.js';

const REAL = [
  ['Thank you', 'ack'],
  ['Looking for a cheaper company u advertised discount for seniors  and that is fraud', 'complaint'],
  ["We're thinking through it.", 'not_now'],
  ['Thinking it through a bit more', 'not_now'],
  [leadTextFromNotes('Bot callback (sms, callback_request, callback_route). They said: "I have a few questions. The quote seems unusually high. I\'m thinking about getting a second opinion. Is there an email so I can show you a communication I received from MFSH\nPlease double check the quote for accuracy"'), 'quote_request'],
  ['Thanks for your email and follow up .\\n\\nPlease take note of requested info to Ben ...\\n\\nAs to ensure I do an apples to apples comparison of all quotations and a better informed decision ...can you also provide the\\nfollowing ...\\n\\n5. Total installed price of $29,000\\n\\nPlease itemize each window', 'quote_request'],
  ["Thanks John. No questions at the moment but I'll let you know if any come up.", 'ack'],
  [leadTextFromNotes('Bot callback (sms, callback_request, scheduling_no_booking). They said: "Bill did not receive a call"'), 'complaint'],
  ['Ok! I only got one page of it. only the price', 'quote_request'],
  ['Thinking', 'not_now'],
  ['Melody did a great job.  We learned a lot.', 'ack'],
  [leadTextFromNotes('Bot callback (sms, callback_request, callback_route). They said: "No not now I am busy tonight. Till trying to figure out the VA and social security"'), 'not_now'],
  ['Where is my guote?', 'quote_request'],
  ['I would like a copy of the estimate', 'quote_request'],
];

test('the 14 real messages: none is a call request', () => {
  for (const [text, want] of REAL) assert.equal(classifyRehashReply(text), want, text);
  assert.equal(REAL.filter(([t]) => classifyRehashReply(t) === 'call_request').length, 0);
});

const OFFER = 'Would a quick call with John help sort that out?';
const POSITIVES = [
  ['yes call me'],
  ['call me after 3'],
  ['Give me a call tomorrow'],
  ['You can call me at 4pm'],
  ['Can you call me?'],
  ['Please call'],
  ['A call would be great'],
  ['Sure, tomorrow morning works', OFFER],
  ['Yes', OFFER],
  ['ok after 5 works', OFFER],
  ['Yeah anytime is fine', OFFER],
];

test('clear call requests and yeses to our call offer are call requests', () => {
  for (const [text, lastOutbound] of POSITIVES) assert.equal(classifyRehashReply(text, { lastOutbound }), 'call_request', text);
});

test('a bare yes is a call only when our last message offered one', () => {
  assert.notEqual(classifyRehashReply('Yes'), 'call_request');
  assert.notEqual(classifyRehashReply('Sure, tomorrow morning works', { lastOutbound: 'Did the proposal make sense?' }), 'call_request');
});

test('a no to a call is never a call request', () => {
  assert.notEqual(classifyRehashReply("Don't call me"), 'call_request');
  assert.equal(classifyRehashReply('No not now', { lastOutbound: OFFER }), 'not_now');
  assert.notEqual(classifyRehashReply('Please stop calling'), 'call_request');
});

test('a quote mention with no ask is not a quote request', () => {
  assert.notEqual(classifyRehashReply('The quote seems high.'), 'quote_request');
  assert.notEqual(classifyRehashReply('Your bid was fine.'), 'quote_request');
});

// 2026-10-14: the first live reply after the deploy (an email, with its
// disclaimer tail) read as thanks and went to the digest. "Bid" is the quote.
test('"I didn\u2019t receive a bid" is a quote request, email disclaimer and all', () => {
  const said = leadTextFromNotes('Bot callback (email, callback_request, callback_route). They said: "I didn\u2019t receive a bid\\n\\n\\n\\n\\nPLEASE NOTE:   The ideas and concepts or funding contacts contained within this email are the sole and confidential property of\\nShooting Star Entertainment, LLC and or Chosen For Change and will not "');
  assert.equal(classifyRehashReply(said), 'quote_request');
  assert.equal(classifyRehashReply("I didn't get the bid"), 'quote_request');
});

test('leadTextFromNotes keeps only the quoted words; other notes pass through', () => {
  assert.equal(leadTextFromNotes('Bot callback (sms, x, y). They said: "hi there"'), 'hi there');
  assert.equal(leadTextFromNotes('plain note'), 'plain note');
  assert.equal(leadTextFromNotes(null), '');
});

test('offeredCall and the routing switch', () => {
  assert.equal(offeredCall(OFFER), true);
  assert.equal(offeredCall('Thanks, enjoy your week.'), false);
  assert.equal(rehashIntentRoutingEnabled({}), true);
  assert.equal(rehashIntentRoutingEnabled({ REHASH_INTENT_ROUTING: 'off' }), false);
});
