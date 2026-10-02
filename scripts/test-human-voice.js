/**
 * Guards for src/agentic/human-voice.js. Every input below is a line a live
 * reply actually carried in the 2026-10-02 audit, or the case that must be
 * left alone.
 *
 * Run: node --test scripts/test-human-voice.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { humanizeReply } = await import('../src/agentic/human-voice.js');
const { HUMAN_VOICE_RULES } = await import('../src/prompts/response-generator/banned.js');

const h = (t, o) => humanizeReply(t, o);

test('em dash after a stock opener becomes a period', () => {
  const r = h('Got it—old windows can let a lot of heat in. How long has that been going on?');
  assert.equal(r.text, 'Got it. Old windows can let a lot of heat in. How long has that been going on?');
  assert.deepEqual(r.changes, ['em_dash']);
});

test('em dash before a new clause becomes a period; inside a phrase, a comma', () => {
  assert.equal(h('Fogging is usually a sign the seal has failed — they\'re not repairable. Is it one window or several?').text,
    'Fogging is usually a sign the seal has failed. They\'re not repairable. Is it one window or several?');
  assert.equal(h('Two options coming up — which works better for you?').text, 'Two options coming up. Which works better for you?');
  assert.equal(h('We do — vinyl single-hung, double-hung and sliders. Which room is it?').text,
    'We do, vinyl single-hung, double-hung and sliders. Which room is it?');
});

test('stacked stock openers collapse to the first', () => {
  const r = h('Got it. Great question. We serve Houston too. What\'s your zip?');
  assert.equal(r.text, 'Got it. We serve Houston too. What\'s your zip?');
  assert.deepEqual(r.changes, ['stacked_opener']);
});

test('throat-clearing lead-ins are cut and the question stands alone', () => {
  assert.equal(h('Just to understand what\'s on your mind — what made you start looking at windows?').text, 'What made you start looking at windows?');
  assert.equal(h('Just so I know what happened, did the rep show up?').text, 'Did the rep show up?');
});

test('self-commentary is dropped', () => {
  assert.equal(h('That\'s something worth knowing upfront. What\'s the best number to reach you?').text, 'What\'s the best number to reach you?');
  assert.equal(h('It\'s worth noting that we utilize vinyl frames. Want us to set up a visit?').text, 'We use vinyl frames. Want us to set up a visit?');
});

test('a "— Name" sign-off and an en dash range are left alone', () => {
  for (const t of ['Sounds good, talk soon.\n— Randy', 'Thanks, Rick. — Randy', 'Install takes 3–5 days. Does that work?']) {
    const r = h(t);
    assert.equal(r.text, t);
    assert.deepEqual(r.changes, []);
  }
  assert.equal(h('Got it — the slider. How long has it been sticking? — Randy').text, 'Got it. The slider. How long has it been sticking? — Randy');
});

test('a LOCKED KB line keeps its em dashes verbatim', () => {
  const keepText = 'BIG DOMINO (locked): Protected before the storm — documented after it.';
  const t = 'Here is how we put it: protected before the storm — documented after it. Want to see how?';
  assert.equal(h(t, { keepText }).text, t);
  assert.notEqual(h(t).text, t, 'without the locked line it is fixed');
});

test('never empties a reply and never loses its question', () => {
  assert.equal(h('Got it. Great question.').text, 'Got it.');
  const q = h('Just to understand — ?').text;
  assert.ok(q.includes('?') && /\w/.test(q), q);
  assert.equal(h('').text, '');
  assert.equal(h('Plain reply with nothing to fix. Which day works?').changes.length, 0);
});

test('the prompt rules carry the same bans', () => {
  for (const s of ['No em dashes', 'Great question', 'Just to understand', 'THEIR words', 'One question per message']) {
    assert.ok(HUMAN_VOICE_RULES.includes(s), s);
  }
  assert.ok(!HUMAN_VOICE_RULES.includes('—'), 'the rules do not model the habit they ban');
});

// 2026-10-02 simulation: questions ended with a period.
test('restoreQuestionMark: the last sentence gets its "?" back; statements stay', async () => {
  const { restoreQuestionMark } = await import('../src/agentic/human-voice.js');
  assert.equal(restoreQuestionMark("What's giving you the most trouble with the windows right now.").text, "What's giving you the most trouble with the windows right now?");
  assert.equal(restoreQuestionMark('Got it. When works better for you, a weekday or the weekend.').text, 'Got it. When works better for you, a weekday or the weekend?');
  assert.equal(restoreQuestionMark('Is that right. — Reece Team').text, 'Is that right? — Reece Team');
  assert.equal(restoreQuestionMark('We will call you at 657-242-0815. Sound good.').text, 'We will call you at 657-242-0815. Sound good?');
  for (const keep of ['Our team will call. What I can do is set that up.', "When you're ready, our team will call.", 'Would love to help.', 'Have a great day.', 'Thanks for reaching out.']) {
    assert.equal(restoreQuestionMark(keep).changed, false, keep);
  }
});
