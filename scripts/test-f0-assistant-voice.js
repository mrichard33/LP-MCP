// F.0 v2 texts as the rehash rep's virtual assistant (the user, 2026-10-24;
// F0_TEXT_VOICE=assistant): "I" is the assistant, never the rep; the first text
// says whose assistant is writing; the price offer is the rep's; the last text
// signs " - John's assistant". Version-4 prompt rows; the emails stay the team's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkF0Copy } from '../src/siro/f0-copy-checks.js';
import { f0FallbackText } from '../src/siro/f0-text-fallback.js';
import { f0FormulaAllows } from '../src/nurture/nurture-prompt-selector.js';
import { siroModes } from '../src/siro/config.js';

const check = (t, position) => checkF0Copy(t, { formula: 'four_step', voice: 'assistant', position, callWith: 'John', firstName: 'Carla' });

test('assistant checks: a good first text passes', () => {
  assert.deepEqual(check("Carla, this is John's assistant at Reece. Wanting the numbers to fit after the new AC makes sense. John may be able to fit this into your budget at a better price. Would a quick call with John be worth it?", 1), []);
});

test('assistant checks: never the rep, never the assistant\'s own price offer, the first text introduces', () => {
  const f = check("Carla, I'm John. If I could get you a better price, would a quick call with John help?", 2);
  assert.ok(f.includes('claims_to_be_rep'), f.join());
  assert.ok(f.includes('assistant_price_offer'), f.join());
  assert.ok(check('Carla, wanting the numbers to fit makes sense. John may be able to get you a better deal. Would a quick call with John help?', 1).includes('assistant_not_introduced'));
  assert.ok(!check("Carla, the door is still open. John's assistant here. Could a short call with John help find a way to fit your budget?", 4).includes('claims_to_be_rep'));
});

test('assistant checks: the last text signs as the assistant, never as John', () => {
  assert.deepEqual(check("Carla, I will leave it here for now. If anything changes, I am a text away. - John's assistant", 5), []);
  assert.ok(check('Carla, I will leave it here for now. - John', 5).includes('signed_as_person'));
  assert.ok(check('Carla, I will leave it here for now.', 5).includes('missing_signature'));
});

test('assistant fallback texts pass their own checks; no rep name reads as the team', () => {
  for (let pos = 1; pos <= 5; pos++) {
    const t = f0FallbackText({ position: pos, firstName: 'Carla', callWith: 'John', voice: 'assistant' });
    assert.deepEqual(check(t, pos), [], t);
    assert.doesNotMatch(t, /\b(?:he|him|his|she|her)\b/i, 'no pronoun for the rep');
  }
  assert.equal(f0FallbackText({ position: 5, firstName: 'Carla', callWith: '', voice: 'assistant' }),
    f0FallbackText({ position: 5, firstName: 'Carla', callWith: '' }));
});

test('the picker reads version 4 only in the assistant voice', () => {
  const ctx = (voice) => ({ siro: { formula: 'four_step', text_voice: voice } });
  const row = (version) => ({ channel: 'sms', version });
  const F0 = { workflow_code: 'F.0' };
  assert.ok(f0FormulaAllows(row(4), F0, ctx('assistant')));
  assert.ok(!f0FormulaAllows(row(3), F0, ctx('assistant')));
  assert.ok(!f0FormulaAllows(row(4), F0, ctx('team')));
  assert.ok(f0FormulaAllows(row(3), F0, ctx('team')));
  assert.ok(!f0FormulaAllows(row(4), F0, { siro: { formula: 'v1' } }));
  assert.equal(siroModes({ F0_TEXT_VOICE: 'assistant' }).f0TextVoice, 'assistant');
});
