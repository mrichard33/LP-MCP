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
