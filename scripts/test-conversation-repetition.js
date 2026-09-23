/**
 * scripts/test-conversation-repetition.js
 *
 * Drives src/agentic/conversation-repetition.js against the thread that caused
 * it: GHL hZOcPk6XmMvWVvjZJ7mz, 2026-09-22, seven outbound turns that all
 * closed on the same ask.
 *
 * The module is pure, so every case here is a plain function call — no
 * supabase, no GHL, no network, no env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractClose,
  closeThemes,
  closesRepeat,
  contentTokens,
  tokenSimilarity,
  loopBreakState,
  spouseAdvocacyState,
  isSpousePitch,
  countQuestions,
  isDoubleBarrelled,
} from '../src/agentic/conversation-repetition.js';

// The seven real closes, in the order they were sent.
const REAL_OUTBOUNDS = [
  "Good question — a sash is the frame that holds the glass and moves, and a double-hung has two sashes that both slide up and down. On timing, want to just do the 15 minute call with Paloma on speaker, or find a day this week you're both around?",
  'Good question, our own factory-trained crews handle every install, never subcontractors, so the same team you meet stays accountable start to finish. On timing, would a day this week with both of you work, or is the 15 minute call with Paloma on speaker easier? — Reece Team',
  'Many Florida homeowners see meaningful premium reductions with impact windows, and we give you the documentation your carrier needs. Your carrier makes the final call. On timing, would a day this week work for both you and Paloma, or is the 15 minute call with her on speaker easier?',
  "Good question, I don't want to guess on that so let's get someone from our team to confirm payment options for you. That same call can also sort a time that works for both you and Paloma. What's a good time for a quick call?",
  'Good question. Most installs run 1 to 2 days, using our own crews start to finish, never subs. For the verification visit, what day this week works for both you and Paloma?',
  "We don't repair existing windows, only full impact-system replacement, since that's what gets you the transferable warranty and insurance documentation. Since Paloma should weigh in too, is there a day this week that works for both of you, or would the 15 minute call with her on speaker be easier?",
  'Good question, there is help out there. My Safe Florida Home offers matching grants for impact upgrades, and our team can confirm exactly what you\'d qualify for. Since that\'s worth Paloma hearing too, would the 15 minute call with her on speaker work this week?',
];

const asTurns = (bodies) => bodies.map((body, i) => ({
  direction: i % 2 === 0 ? 'outbound' : 'outbound',
  body,
}));

// ── extractClose ───────────────────────────────────────────────────

test('extractClose takes the final question, not the whole message', () => {
  assert.equal(
    extractClose(REAL_OUTBOUNDS[4]),
    'For the verification visit, what day this week works for both you and Paloma?',
  );
});

test('extractClose strips the Reece Team signature', () => {
  const close = extractClose(REAL_OUTBOUNDS[1]);
  assert.ok(!/reece team/i.test(close), `signature survived: ${close}`);
  assert.ok(close.endsWith('?'), close);
});

test('extractClose falls back to the last sentence when nothing is asked', () => {
  assert.equal(
    extractClose('Most installs run 1 to 2 days. Our own crews, never subs.'),
    'Our own crews, never subs.',
  );
});

test('extractClose is safe on empty and non-string input', () => {
  assert.equal(extractClose(''), '');
  assert.equal(extractClose(null), '');
  assert.equal(extractClose(undefined), '');
  assert.equal(extractClose(42), '');
});

// ── themes ─────────────────────────────────────────────────────────

test('every one of the seven real closes carries an actionable theme', () => {
  for (const [i, body] of REAL_OUTBOUNDS.entries()) {
    const themes = closeThemes(extractClose(body));
    const actionable = themes.filter(t => t !== 'human_handoff' && t !== 'send_info');
    assert.ok(actionable.length > 0, `outbound ${i + 1} produced no actionable theme: ${themes}`);
  }
});

test('the 15-minute call is recognised however it is worded', () => {
  assert.ok(closeThemes('Want to do the 15 minute call?').includes('call_15min'));
  assert.ok(closeThemes('Is the fifteen-minute call easier?').includes('call_15min'));
  assert.ok(closeThemes('Would a quick call work?').includes('call_15min'));
  assert.ok(closeThemes('...with her on speaker?').includes('call_15min'));
});

// ── the defect itself ──────────────────────────────────────────────

test('consecutive real closes are detected as the same ask', () => {
  // This is the regression: no two of these share a sentence, and every
  // adjacent pair must still read as a repeat.
  for (let i = 1; i < REAL_OUTBOUNDS.length; i++) {
    const a = extractClose(REAL_OUTBOUNDS[i]);
    const b = extractClose(REAL_OUTBOUNDS[i - 1]);
    assert.ok(
      closesRepeat(a, b, { drop: ['paloma'] }),
      `closes ${i} and ${i + 1} not flagged as repeats:\n  A: ${b}\n  B: ${a}`,
    );
  }
});

test('loopBreakState flags the real thread as looping and counts the run', () => {
  const state = loopBreakState({
    conversation: asTurns(REAL_OUTBOUNDS),
    leadName: 'Paloma',
    lookback: 4,
  });
  assert.equal(state.looping, true);
  assert.ok(state.repeats >= 1, `expected a repeat run, got ${state.repeats}`);
  assert.equal(state.recentCloses.length, 4);
});

test('a genuinely different close is not a repeat', () => {
  const scheduling = 'What day this week works for both you and Paloma?';
  const different = 'Out of curiosity, what made you start looking at windows now?';
  assert.equal(closesRepeat(scheduling, different, { drop: ['paloma'] }), false);
});

test('a varied thread does not trip the loop detector', () => {
  const varied = [
    'Most installs run 1 to 2 days, our own crews start to finish. What day this week works?',
    "Impact glass stays in place even when it cracks. What made you start looking now?",
    "Totally fair. What would you need to see to feel good about moving ahead?",
  ];
  const state = loopBreakState({ conversation: asTurns(varied), leadName: 'Paloma' });
  assert.equal(state.repeats, 0);
  assert.equal(state.looping, false);
});

test('escalation alone makes it looping even when the wording varies', () => {
  const varied = [
    'What made you start looking now?',
    'What would you need to see to feel good about it?',
  ];
  const state = loopBreakState({
    conversation: asTurns(varied),
    escalated: true,
  });
  assert.equal(state.looping, true);
});

test('loopBreakState is safe on an empty or one-turn conversation', () => {
  assert.deepEqual(
    loopBreakState({ conversation: [] }),
    { looping: false, repeats: 0, recentCloses: [], themes: [] },
  );
  const one = loopBreakState({ conversation: asTurns([REAL_OUTBOUNDS[0]]) });
  assert.equal(one.looping, false);
  assert.equal(one.repeats, 0);
});

test('inbound turns are never read as our closes', () => {
  const mixed = [
    { direction: 'inbound', body: 'What day works for both of you?' },
    { direction: 'inbound', body: 'What day works for both of you?' },
  ];
  assert.equal(loopBreakState({ conversation: mixed }).recentCloses.length, 0);
});

// ── spouse advocacy ────────────────────────────────────────────────

test('the real advocacy line is recognised as a pitch', () => {
  const pitch = "She doesn't have to — but the visit's a lot more useful when you can both ask questions on the spot, nothing to relay later. Want me to find a time that works for both of you?";
  assert.equal(isSpousePitch(pitch), true);
});

test('REGRESSION 2026-09-23: "works best when both" is a pitch', () => {
  // Live thread hZOcPk6XmMvWVvjZJ7mz, action 488159. The v1.0 word list looked
  // for better/easier/more useful and missed "works best", so the pitch was
  // never marked spent and the next turn repeated the both-owners framing.
  const real = "Your online estimate came to $7,385.10 for the 5 windows. Since our specialist prices everything on the spot, it works best when both you and Paloma are there, what's a time that could work for both of you?";
  assert.equal(isSpousePitch(real), true);
});

test('the follow-up turn is then blocked from repeating it', () => {
  // Action 488163, the very next reply. With 488159 recorded as the spent
  // attempt, spouseAdvocacyState must report used=true so the prompt forbids
  // a second pitch.
  const convo = asTurns([
    "Your online estimate came to $7,385.10 for the 5 windows. Since our specialist prices everything on the spot, it works best when both you and Paloma are there, what's a time that could work for both of you?",
  ]);
  const state = spouseAdvocacyState({ conversation: convo });
  assert.equal(state.used, true);
  assert.equal(state.source, 'transcript');
});

test('other natural phrasings of the same value claim are caught', () => {
  for (const s of [
    'It goes better when both of you are there.',
    'The visit is most helpful when both owners can ask questions.',
    'It works best when you and your wife are both home.',
  ]) {
    assert.equal(isSpousePitch(s), true, `missed: ${s}`);
  }
});

test('a plain scheduling ask naming two people is NOT a pitch', () => {
  // This must stay legal forever — the cap is on advocacy, not on logistics.
  assert.equal(isSpousePitch('What day this week works for both you and Paloma?'), false);
  assert.equal(isSpousePitch('Does Saturday at 10 work for you and Dana?'), false);
});

test('spouseAdvocacyState finds the pitch in our own transcript', () => {
  const convo = asTurns([
    'Most installs run 1 to 2 days.',
    "She doesn't have to be there — but the visit's a lot more useful when you're both there.",
    'What day this week works?',
  ]);
  const state = spouseAdvocacyState({ conversation: convo });
  assert.equal(state.used, true);
  assert.equal(state.source, 'transcript');
  assert.ok(state.our_words);
});

test('the CRM marker outranks the transcript', () => {
  const state = spouseAdvocacyState({ conversation: [], tags: ['spouse-advocacy-used'] });
  assert.equal(state.used, true);
  assert.equal(state.source, 'field');
});

test('advocacy is available when it has genuinely not been used', () => {
  const convo = asTurns(['Most installs run 1 to 2 days. What day works?']);
  assert.deepEqual(
    spouseAdvocacyState({ conversation: convo }),
    { used: false, source: null, our_words: null },
  );
});

test('the real thread has already spent its one advocacy attempt', () => {
  const state = spouseAdvocacyState({ conversation: asTurns(REAL_OUTBOUNDS) });
  assert.equal(state.used, true);
});

// ── NEPQ one-question rule ─────────────────────────────────────────

test('countQuestions counts asks, not punctuation', () => {
  assert.equal(countQuestions('What day works?'), 1);
  assert.equal(countQuestions('What day works? Or is a call easier?'), 2);
  assert.equal(countQuestions('Really?!'), 1);
  assert.equal(countQuestions('Wait??'), 1);
  assert.equal(countQuestions('No question here.'), 0);
  assert.equal(countQuestions(null), 0);
});

test('the four either/or closes in the real thread are caught, the three single asks are not', () => {
  // Outbounds 1, 2, 3 and 6 stack two clauses into one question. 4, 5 and 7
  // ask one thing — they are repetitive (loopBreakState catches that) but they
  // do not break the NEPQ one-question rule, and must not be flagged here.
  const flagged = REAL_OUTBOUNDS.map(m => isDoubleBarrelled(m) || countQuestions(m) > 1);
  assert.deepEqual(flagged, [true, true, true, false, false, true, false]);
});

test('isDoubleBarrelled catches the exact either/or close', () => {
  assert.equal(
    isDoubleBarrelled('On timing, would a day this week with both of you work, or is the 15 minute call with Paloma on speaker easier?'),
    true,
  );
});

test('a simple noun alternative stays legal', () => {
  // One ask, two nouns. Banning this would make the bot stilted.
  assert.equal(isDoubleBarrelled('Would morning or afternoon be better?'), false);
  assert.equal(isDoubleBarrelled('What day this week works for both of you?'), false);
});

// ── helpers ────────────────────────────────────────────────────────

test('contentTokens drops stopwords and the lead name', () => {
  const tokens = contentTokens('Would a day this week work for both you and Paloma?', { drop: ['paloma'] });
  assert.ok(!tokens.includes('paloma'));
  assert.ok(!tokens.includes('would'));
  assert.ok(tokens.includes('day'));
  assert.ok(tokens.includes('week'));
});

test('tokenSimilarity is containment, so a short close inside a long one scores high', () => {
  const short = contentTokens('What day works for both of you?');
  const long = contentTokens('On timing, what day this week works for both of you, roughly?');
  assert.ok(tokenSimilarity(short, long) >= 0.6);
  assert.equal(tokenSimilarity([], long), 0);
});
