/**
 * The gate runs twice — scripts/test-gate-runs.js
 *
 * Phase 1 item 3 (2026-10-18): the Phase 0 baseline ran twice on one build
 * 5 s apart and scored 64/72 and 66/72; rehash_not_at_this_time failed turn 3
 * in one and passed in the other. A key now passes only if it passes in every
 * run; mixed is `flaky` (listed, counted apart, never WORSE on its own), and
 * the comparison and the family rates use stable results only. Also pins the
 * new-lead "Not interested" ruling's max_questions check.
 *
 * Run: node --test scripts/test-gate-runs.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { scoreRun, combineRuns, compareScorecards, formatScorecard, turnExpectationFailures, questionCount } = await import('../src/simulator/sim-scoring.js');
const { evalRunPayload, parseSimRequest } = await import('../src/tools/simulator-tools.js');

const ok = (scenario, family = 'rehash') => ({ scenario, channel: 'sms', family, transcript: [{ turn: 1, customer: 'Hi', bot: ['Thanks for reaching out.'] }] });
const bad = (scenario, family = 'rehash') => ({ scenario, channel: 'sms', family, transcript: [{ turn: 1, customer: 'Hi', bot: null }] });

test('a key passes only in every run; mixed is flaky and counted apart', () => {
  const run1 = scoreRun([ok('a'), bad('b'), ok('c', 'booking'), bad('d', 'booking')]);
  const run2 = scoreRun([ok('a'), ok('b'), ok('c', 'booking'), bad('d', 'booking')]);
  const card = combineRuns([run1, run2]);
  assert.equal(card.runs, 2);
  assert.deepEqual(card.flaky_keys, ['b/sms']);
  assert.equal(card.flaky, 1);
  assert.equal(card.stable, 3);
  assert.equal(card.passed, 2, 'a and c pass in both runs');
  assert.equal(card.pass_rate, Math.round((2 / 3) * 1000) / 1000, 'over stable keys only');
  assert.deepEqual(card.pass_rate_by_family.rehash, { conversations: 1, passed: 1, pass_rate: 1 }, 'the flaky key is not in its family rate');
  assert.deepEqual(card.run_scores, [{ passed: 2, conversations: 4 }, { passed: 3, conversations: 4 }]);
  const d = card.results.find(r => r.key === 'd/sms');
  assert.deepEqual([d.pass, d.flaky], [false, false], 'failing in every run is a stable fail');
  assert.ok(d.failures.every(f => f.run === 1 || f.run === 2), 'each failure says which run');
});

test('one run is the same scorecard as before, marked as one run', () => {
  const card = combineRuns([scoreRun([ok('a')])]);
  assert.deepEqual([card.runs, card.flaky, card.stable], [1, 0, 1]);
});

test('a flaky key is never WORSE; a stable regression still is', () => {
  const prev = combineRuns([scoreRun([ok('a'), ok('b'), ok('c')]), scoreRun([ok('a'), ok('b'), ok('c')])]);
  const cur = combineRuns([scoreRun([ok('a'), bad('b'), ok('c')]), scoreRun([ok('a'), ok('b'), ok('c')])]);
  const cmp = compareScorecards(cur, prev);
  assert.equal(cmp.worse, false, 'b flipped in one run: flaky, not a regression');
  assert.deepEqual(cmp.flaky_keys, ['b/sms']);
  const worse = combineRuns([scoreRun([ok('a'), bad('b'), ok('c')]), scoreRun([ok('a'), bad('b'), ok('c')])]);
  const cmp2 = compareScorecards(worse, prev);
  assert.equal(cmp2.worse, true);
  assert.ok(cmp2.reasons.some(r => /b\/sms passed last run and now fails/.test(r)));
  // A key flaky LAST run is not compared either.
  const cmp3 = compareScorecards(worse, cur);
  assert.ok(!cmp3.reasons.some(r => /b\/sms/.test(r)), 'last run it was flaky: no baseline to fall from');
});

test('a key flaky last run and absent from it is not reported as new', () => {
  const prev = combineRuns([scoreRun([ok('a'), bad('b')]), scoreRun([ok('a'), ok('b')])]);
  const cur = combineRuns([scoreRun([ok('a'), ok('b')]), scoreRun([ok('a'), ok('b')])]);
  assert.deepEqual(compareScorecards(cur, prev).new_keys, []);
});

test('the scorecard prints passed/stable, the flaky count and the flaky list', () => {
  const card = combineRuns([scoreRun([ok('a'), bad('b')]), scoreRun([ok('a'), ok('b')])]);
  const text = formatScorecard(card, compareScorecards(card, null));
  assert.match(text, /^Scorecard \(2 runs\): 1\/1 stable conversations pass \(100%\) · 1 flaky of 2/);
  assert.match(text, /Flaky this run \(not compared\): b\/sms/);
  assert.doesNotMatch(text, /✗ b\/sms/, 'a flaky key is not listed as a failure');
});

test('one event per gate holds every run\'s results', () => {
  const r1 = scoreRun([ok('a'), bad('b')]);
  const r2 = scoreRun([ok('a'), ok('b')]);
  const card = combineRuns([r1, r2]);
  const payload = evalRunPayload(card, null, [r1, r2]);
  assert.equal(payload.runs.length, 2);
  assert.equal(payload.runs[0].results.find(r => r.key === 'b/sms').pass, false);
  assert.equal(payload.scorecard.results.find(r => r.key === 'b/sms').flaky, true);
  assert.ok(!('runs' in evalRunPayload(r1, null, null)), 'a single run saves as before');
});

test('run_bot_eval takes runs (1-4) and turn_lock_mode', () => {
  assert.equal(parseSimRequest({ scenario: 'all', runs: 2 }).runs, 2);
  assert.throws(() => parseSimRequest({ scenario: 'all', runs: 9 }), /runs must be 1 to 4/);
  assert.equal(parseSimRequest({ scenario: 'all', turn_lock_mode: 'live' }).turnLockMode, 'live');
  assert.throws(() => parseSimRequest({ scenario: 'all', turn_lock_mode: 'on' }), /turn_lock_mode/);
});

test('max_questions: the first "Not interested" may carry ONE question (the user, 2026-10-18)', () => {
  assert.equal(questionCount('Totally fair. What changed?'), 1);
  assert.equal(questionCount('Is it the price? Or the timing?'), 2);
  const r = (text) => ({ expect: { 1: { question_allowed: true, max_questions: 1 } }, transcript: [{ turn: 1, customer: 'Not interested', bot: [text] }] });
  assert.deepEqual(turnExpectationFailures(r('No problem. Can I ask what changed?')), []);
  assert.deepEqual(turnExpectationFailures(r('No problem. Was it the price? Or the timing?')).map(f => f.code), ['too_many_questions']);
});
