/**
 * "Not interested" gets one "what changed?", then a warm close (Mark, 2026-09-24).
 *
 * Run: node --test scripts/test-not-interested.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { isNotInterested, alreadyAskedWhy, notInterestedTurn } = await import('../src/agentic/not-interested.js');
const P = await import('../src/prompts/response-generator/index.js');

test('recognizes the ways leads say it', () => {
  for (const t of [
    'Not interested',
    "I'm no longer interested, thanks",
    'not really interested right now',
    "It's not for us",
    'Count me out',
  ]) assert.ok(isNotInterested(t), t);
});

test('a bare "no thanks" and ordinary replies are not a decline of the company', () => {
  for (const t of ['No thanks, Tuesday does not work', 'Sounds interesting!', 'Are you interested in my old windows?', '']) {
    assert.equal(isNotInterested(t), false, t);
  }
});

const ASKED = [
  { direction: 'inbound', text: 'Not interested' },
  { direction: 'outbound', text: 'No problem, Dana. Just so I know, what changed?' },
];

test('first time: ask what changed; second time: close', () => {
  assert.equal(notInterestedTurn('not interested', []), 'ask');
  assert.equal(notInterestedTurn('still not interested', ASKED), 'close');
});

test('only our own question counts, not the lead saying it', () => {
  assert.equal(alreadyAskedWhy([{ direction: 'inbound', text: 'what changed is my budget' }]), false);
  assert.equal(alreadyAskedWhy(null), false);
});

test('a reply that gives a reason is left to the normal objection handling', () => {
  assert.equal(notInterestedTurn('The price was too high', ASKED), null);
});

test('the prompt block names the exact line for each turn', () => {
  const ask = P.notInterestedTurnBlock('ask').join('\n');
  assert.match(ask, /turn 1/);
  assert.match(ask, /what changed\?/);
  const close = P.notInterestedTurnBlock('close').join('\n');
  assert.match(close, /turn 2/);
  assert.match(close, /If anything changes, just text me here/);
  assert.doesNotMatch(close, /what changed\?"/);
});

// 2026-10-19 (Thomas Geary, LP Prospect 461733, Mark's ruling): a firm decline
// with a reason is a decline. agent_actions 573254 answered his email as a live
// objection and closed on a question.
const THOMAS = 'Thank you. She did a great job. And would be a great long term investment to your company. We will not be investing 25 % of\\npurchased value when the market value will not justify the cost. You have an above average product with exceptional installation.\\nCongratulations on the longevity of your family owned business.\\n';

test('a reasoned decline counts: Thomas and the other firm wordings', () => {
  for (const t of [
    THOMAS,
    "We won't be moving forward with the project.",
    "We've decided not to go ahead.",
    "We're going to pass.",
    "We'll pass on this one, thanks.",
    "Honestly the cost doesn't justify it.",
    'Not worth it for us right now.',
    "I'm not moving forward.",
  ]) assert.ok(isNotInterested(t), t);
});

test('never a decline: a question, a deferral, a scheduling miss, a pass-along', () => {
  for (const t of [
    'So we will not be investing in the impact glass?',
    "We won't be investing until spring.",
    'We will not be home Tuesday, can we do Thursday',
    'We will not be home Tuesday.',
    "I'll pass this along to my wife.",
    'The price was too high',
  ]) assert.equal(isNotInterested(t), false, t);
});

test('a reasoned decline never gets the "what changed?" turn: it already said why', () => {
  assert.equal(notInterestedTurn(THOMAS, []), null);
  assert.equal(notInterestedTurn('Not interested', []), 'ask');
});
