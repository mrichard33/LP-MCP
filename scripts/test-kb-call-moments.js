/**
 * scripts/test-kb-call-moments.js — Call moments core (kb-retriever v1.12)
 *
 * Exercises src/knowledge/ci-moments-core.js with no env and no network:
 *   1. mode parsing; 2. intent policy; 3. eligibility; 4. validateMoments
 *   normalisation + PII scrub; 5. scoresFromMoments shape + fallback;
 *   6. formatter budget + header.
 *
 * Run: node --test scripts/test-kb-call-moments.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getKbCallMomentsMode,
  shouldRunCallMoments,
  isEligibleCall,
  callWon,
  validateMoments,
  scoresFromMoments,
  formatCallMomentsForPrompt,
  OBJECTION_TYPES,
  EXTRACTION_SYSTEM_PROMPT,
} from '../src/knowledge/ci-moments-core.js';

test('mode defaults to off and rejects unknown values', () => {
  assert.equal(getKbCallMomentsMode({}), 'off');
  assert.equal(getKbCallMomentsMode({ KB_CALL_MOMENTS_MODE: 'on' }), 'off');
  assert.equal(getKbCallMomentsMode({ KB_CALL_MOMENTS_MODE: ' LIVE ' }), 'live');
});

test('runs on conversational intents, not on gates or empty text', () => {
  assert.equal(shouldRunCallMoments('OBJECTION', 'too pricey'), true);
  assert.equal(shouldRunCallMoments('NOT_INTERESTED', 'no thanks'), true);
  assert.equal(shouldRunCallMoments('STOP', 'stop'), false);
  assert.equal(shouldRunCallMoments('QUESTION', ' '), false);
  assert.equal(shouldRunCallMoments(undefined, 'hi'), false);
});

test('eligibility drops skip outcomes, internal directions, unintelligible, and short transcripts', () => {
  const base = { direction: 'Outbound', outcome: 'not_interested', transcript_intelligible: true, transcript_text: 'x'.repeat(500) };
  assert.equal(isEligibleCall(base), true);
  assert.equal(isEligibleCall({ ...base, outcome: 'no_meaningful_contact' }), false);
  assert.equal(isEligibleCall({ ...base, outcome: 'dnc_request' }), false);
  assert.equal(isEligibleCall({ ...base, direction: 'Inbound Voicemail' }), false);
  assert.equal(isEligibleCall({ ...base, transcript_intelligible: false }), false);
  assert.equal(isEligibleCall({ ...base, transcript_text: 'short' }), false);
  assert.equal(isEligibleCall({ ...base, transcript_intelligible: null }), true, 'unknown intelligibility is allowed');
  assert.equal(callWon('appointment_set'), true);
  assert.equal(callWon('appointment_confirmed'), true);
  assert.equal(callWon('not_interested'), false);
});

test('validateMoments normalises kinds/types, scrubs PII, clamps lengths, drops junk', () => {
  const out = validateMoments({ moments: [
    { kind: 'Objection', objection_type: 'PRICE', customer_said: 'That is way more than the $6,000 the other guys quoted, call me at 813-555-0100', agent_said: 'Totally fair — a lot of that quote is the code work…', resolved: 'true', confidence: 1.4 },
    { kind: 'objection', objection_type: 'weather', customer_said: 'we will see after hurricane season', agent_said: null, resolved: false, confidence: 0.8 },
    { kind: 'question', customer_said: 'Does this lower my insurance?', agent_said: 'Usually yes — the wind mitigation credit…', resolved: null, confidence: 0.9 },
    { kind: 'chit_chat', customer_said: 'how are you' },
    { kind: 'question', customer_said: 'ok' },
    'garbage',
  ] });
  assert.equal(out.length, 3);
  assert.equal(out[0].objection_type, 'price');
  assert.ok(out[0].customer_said.includes('[phone]'));
  assert.equal(out[0].resolved, null, 'string "true" is not a boolean → null');
  assert.equal(out[0].confidence, 1);
  assert.equal(out[1].objection_type, 'other');
  assert.equal(out[1].agent_said, null);
  assert.equal(out[2].objection_type, null);
  assert.equal(validateMoments(null).length, 0);
  assert.equal(validateMoments({ moments: Array(10).fill({ kind: 'question', customer_said: 'what is the warranty?' }) }).length, 6);
  for (const t of ['price', 'timing', 'spouse', 'trust', 'competitor', 'diy', 'other']) assert.ok(OBJECTION_TYPES.has(t));
  assert.ok(EXTRACTION_SYSTEM_PROMPT.includes('"moments"'));
});

test('scoresFromMoments returns per-type max, excludes other, and null when too few', () => {
  const rows = [
    { objection_type: 'spouse', similarity: 0.62 },
    { objection_type: 'spouse', similarity: 0.71 },
    { objection_type: 'timing', similarity: 0.44 },
    { objection_type: 'other', similarity: 0.80 },
  ];
  assert.deepEqual(scoresFromMoments(rows, 3), { spouse: 0.71, timing: 0.44 });
  assert.equal(scoresFromMoments(rows.slice(0, 2), 3), null);
  assert.equal(scoresFromMoments([{ objection_type: 'other', similarity: 0.9 }, { objection_type: 'other', similarity: 0.8 }, { objection_type: 'other', similarity: 0.7 }], 3), null);
  assert.equal(scoresFromMoments(undefined), null);
});

test('formatter respects count and budget, labels wins, carries the no-copy header', () => {
  const rows = [
    { kind: 'objection', objection_type: 'spouse', call_won: true, resolved: true, similarity: 0.7, customer_said: 'my wife handles this', agent_said: 'Makes sense — most couples decide together. What evening are you both home?' },
    { kind: 'question', call_won: false, resolved: true, similarity: 0.6, customer_said: 'does this lower insurance?', agent_said: 'Usually — the wind mitigation credit.' },
    { kind: 'buying_signal', call_won: true, resolved: null, similarity: 0.5, customer_said: 'x', agent_said: null },
  ];
  const out = formatCallMomentsForPrompt(rows, { max: 2 });
  assert.ok(out.startsWith('FROM REAL CALLS'));
  assert.ok(out.includes('NOT the wording'));
  assert.ok(out.includes('1. [objection:spouse | call booked'));
  assert.ok(out.includes('2. [question | point resolved'));
  assert.ok(!out.includes('3. ['));
  assert.equal(formatCallMomentsForPrompt([]), '');
  assert.equal(formatCallMomentsForPrompt(rows, { maxChars: 10 }), '');
});
