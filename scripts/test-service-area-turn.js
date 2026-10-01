// Tests for src/agentic/service-area-turn.js — zip-first service-area answers
// (Mark's ruling 4, 2026-10-01). Pure; no database.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCoverageQuestion,
  extractZip,
  placeFromQuestion,
  planServiceAreaTurn,
  resolveCoverage,
  coverageSentence,
  coverageHint,
  guardCoverageDraft,
  firstSentenceStates,
  serviceAreaRecord,
  ZIP_ASK_LINE,
} from '../src/agentic/service-area-turn.js';

const IN = (text) => ({ direction: 'inbound', text });
const OUT = (text) => ({ direction: 'outbound', text });

test('detects coverage questions, including the three live openers of 2026-09-30', () => {
  for (const t of [
    'do you service palm coast fl area?',
    'Do you serve Houston? 77002',
    'Do you guys come to The Villages?',
    'Do you service Dallas TX',
    'are you in my area',
    'Is 32136 in your service area?',
    'what areas do you serve',
    'do you cover flagler beach',
    "Do y'all service Winston-Salem",
    'can you come out to Ocala?',
    'Do you install in Katy, TX?',
  ]) assert.equal(isCoverageQuestion(t), true, t);
});

test('does not mistake product, schedule or price talk for a coverage question', () => {
  for (const t of [
    'Do you service windows you installed?',
    'do you work on weekends?',
    'How much for 12 windows?',
    'Do you install sliding doors?',
    'Are you in business still?',
    'do you do financing?',
    'are you available tomorrow?',
    'Can you come out Tuesday?',
    '',
  ]) assert.equal(isCoverageQuestion(t), false, t);
});

test('extractZip: keyword and bare zips always; inline only for a coverage question; never prices or counts', () => {
  assert.equal(extractZip('32137'), '32137');
  assert.equal(extractZip("it's 27101."), '27101');
  assert.equal(extractZip('my zip code is 75233'), '75233');
  assert.equal(extractZip('Do you serve Houston? 77002'), null, 'inline needs loose');
  assert.equal(extractZip('Do you serve Houston? 77002', { loose: true }), '77002');
  assert.equal(extractZip('I have 15000 sq ft', { loose: true }), null);
  assert.equal(extractZip('budget is $12000', { loose: true }), null);
  assert.equal(extractZip('00000'), null);
});

test('placeFromQuestion pulls the place and drops state and "area"', () => {
  assert.equal(placeFromQuestion('do you service palm coast fl area?'), 'Palm Coast');
  assert.equal(placeFromQuestion('Do you serve Houston? 77002'), 'Houston');
  assert.equal(placeFromQuestion('Do you guys come to The Villages?'), 'The Villages');
  assert.equal(placeFromQuestion('Hi, do you serve the Jacksonville area'), 'Jacksonville');
  assert.equal(placeFromQuestion('are you in my area'), null);
});

test('plan: a coverage question with no zip in the conversation needs the zip', () => {
  const p = planServiceAreaTurn({ trigger: 'do you service palm coast fl area?', conversation: [IN('do you service palm coast fl area?')] });
  assert.equal(p.active, true);
  assert.equal(p.needs_zip, true);
  assert.equal(p.zip, null);
  assert.equal(p.place, 'Palm Coast');
  assert.equal(resolveCoverage(p).status, 'ask_zip');
});

test('plan: the zip that answers our zip ask is the zip, and the topic stays open', () => {
  const conv = [IN('do you service palm coast fl area?'), OUT(ZIP_ASK_LINE), IN('32137')];
  const p = planServiceAreaTurn({ trigger: '32137', conversation: conv });
  assert.equal(p.active, true);
  assert.equal(p.zip, '32137');
  assert.equal(p.needs_zip, false);
});

test('plan: a zip given earlier in this conversation is used, not asked for again', () => {
  const conv = [IN('my zip is 32136'), OUT('Thanks. What made you start looking?'), IN('do you serve flagler beach?')];
  const p = planServiceAreaTurn({ trigger: 'do you serve flagler beach?', conversation: conv });
  assert.equal(p.zip, '32136');
  assert.equal(p.needs_zip, false);
});

test('plan: an unrelated message is not a coverage turn', () => {
  const p = planServiceAreaTurn({ trigger: 'How long does install take?', conversation: [IN('How long does install take?')] });
  assert.equal(p.active, false);
  assert.equal(resolveCoverage(p), null);
});

test('plan: asked once and refused → never asked twice; one market answers, else a team member confirms', () => {
  const conv = [IN('do you serve palm coast?'), OUT(ZIP_ASK_LINE), IN("I'd rather not say")];
  const p = planServiceAreaTurn({ trigger: "I'd rather not say", conversation: conv });
  assert.equal(p.refused_zip, true);
  assert.equal(p.place, 'Palm Coast');
  assert.equal(resolveCoverage(p, { placeResult: { checked: true, market_codes: ['JAX'], city: 'Palm Coast' } }).status, 'place_in');
  assert.equal(resolveCoverage(p, { placeResult: { checked: true, market_codes: ['JAX', 'ORL'] } }).status, 'place_unknown');
  assert.equal(resolveCoverage(p, { placeResult: null }).status, 'place_unknown');
});

test('resolveCoverage: in, out, and a lookup that did not finish', () => {
  const p = { active: true, zip: '77002', place: 'Houston', needs_zip: false, refused_zip: false };
  const inRes = resolveCoverage(p, { zipResult: { checked: true, in_service_area: true, city: 'Houston', market_code: 'HOU' } });
  assert.deepEqual([inRes.status, inRes.market_code], ['in', 'HOU']);
  assert.equal(coverageSentence(inRes), 'Yes, we serve Houston (77002).');
  assert.equal(resolveCoverage(p, { zipResult: { checked: true, in_service_area: false } }).status, 'out');
  const unk = resolveCoverage(p, { zipResult: null });
  assert.equal(unk.status, 'unknown');
  assert.equal(coverageSentence(unk), 'Let me have a team member confirm coverage for 77002.');
});

test('guard (ask_zip): one zip question passes; a name/phone ask or a second question is replaced', () => {
  const res = { status: 'ask_zip', zip: null, place: 'Palm Coast' };
  assert.deepEqual(guardCoverageDraft("Happy to check. What's your zip code?", res).notes, []);
  for (const bad of [
    "Good question. What's your zip code?",
    "Sure. What's your name and zip code?",
    "We'd love to help. What's your zip? And the best phone number?",
    'We serve Palm Coast. When works for a visit?',
  ]) {
    const g = guardCoverageDraft(bad, res);
    assert.equal(g.notes.length, 1, bad);
    assert.equal(g.fixed, ZIP_ASK_LINE);
  }
});

test('guard (in): the first sentence must state coverage; otherwise the sentence is prepended once', () => {
  const res = { status: 'in', zip: '32137', city: 'Palm Coast' };
  assert.deepEqual(guardCoverageDraft('Yes, we serve Palm Coast (32137). What made you start looking?', res).notes, []);
  const g = guardCoverageDraft('Thanks. What made you start looking? We do serve that area.', res);
  assert.equal(g.notes.length, 1);
  assert.equal(g.fixed, 'Yes, we serve Palm Coast (32137). Thanks. What made you start looking?');
});

test('guard (out): plain no, thanks, and stop — any ask is replaced by the deterministic line', () => {
  const res = { status: 'out', zip: '75233' };
  const line = coverageSentence(res);
  assert.match(line, /doesn't serve the 75233 area/);
  assert.ok(!line.includes('?'));
  assert.deepEqual(guardCoverageDraft(line, res).notes, []);
  for (const bad of [
    "Unfortunately we don't serve 75233. What's your address so we can double-check?",
    "We don't serve 75233, but could we get your phone number?",
    'Thanks for reaching out. When would you like to book a visit?',
  ]) {
    const g = guardCoverageDraft(bad, res);
    assert.equal(g.notes.length, 1, bad);
    assert.equal(g.fixed, line);
  }
});

test('guard (unknown): leads with the team-member line', () => {
  const res = { status: 'unknown', zip: '77002' };
  assert.equal(firstSentenceStates('Let me have a team member confirm coverage for 77002. What prompted the project?', res), true);
  const g = guardCoverageDraft('Great. What prompted the project?', res);
  assert.equal(g.fixed.startsWith('Let me have a team member confirm coverage for 77002.'), true);
});

test('hint wording carries the rule for each status', () => {
  assert.match(coverageHint({ status: 'ask_zip' }), /ONLY question/);
  assert.match(coverageHint({ status: 'ask_zip' }), /Do NOT ask for their name, phone, email or address/);
  assert.match(coverageHint({ status: 'in', zip: '27101', city: 'Winston-Salem' }), /Yes, we serve Winston-Salem \(27101\)\./);
  assert.match(coverageHint({ status: 'out', zip: '75233' }), /OUTSIDE/);
  assert.equal(coverageHint(null), null);
});

test('serviceAreaRecord is the execution_result shape', () => {
  const plan = { active: true };
  assert.deepEqual(serviceAreaRecord(plan, { status: 'in', zip: '77002', place: 'Houston', market_code: 'HOU' }),
    { zip: '77002', place: 'Houston', result: 'in', market_code: 'HOU' });
  assert.equal(serviceAreaRecord({ active: false }, null), null);
});
