// F.0 v2 text fallback and the length cap (the user, 2026-10-23): a text around
// 300 characters never fails, and a text that still fails gets a generic Reece
// Team text so the workflow never ends on "Suppressed (Skip)".
import test from 'node:test';
import assert from 'node:assert/strict';
import { f0FallbackText, wantsTextFallback } from '../src/siro/f0-text-fallback.js';
import { checkF0Copy } from '../src/siro/f0-copy-checks.js';
import { closeGivesReason } from '../src/siro/f0-four-step.js';

test('fallback: only for a failed text, never for a real stop', () => {
  for (const r of ['safety_failed_after_retry', 'generation_error', 'retry_error', 'no_prompt_match']) assert.ok(wantsTextFallback(r), r);
  for (const r of ['rehash_owned', 'sold', 'f0_v2_off', 'human_replied', 'wrong_active_workflow', 'awaiting_approval', null]) assert.ok(!wantsTextFallback(r), String(r));
});

test('fallback copy: the name first, the call with the rep, a reason, one question, no price', () => {
  for (let pos = 1; pos <= 4; pos++) {
    const t = f0FallbackText({ position: pos, firstName: 'Mark', callWith: 'John' });
    assert.match(t, /^Mark, /);
    assert.match(t, /call with John/);
    assert.equal((t.match(/\?/g) || []).length, 1, t);
    assert.ok(closeGivesReason(t), t);
    assert.doesNotMatch(t, /\$|\d|%|discount|tomorrow|today/i, t);
    assert.ok(t.length <= 300, `${t.length}`);
  }
  const last = f0FallbackText({ position: 5, firstName: 'Mark', callWith: 'John' });
  assert.doesNotMatch(last, /\?/);
  assert.match(last, / - Reece Team$/);
});

test('fallback copy: no name and no rep → a capitalised opener and "our team"', () => {
  const t = f0FallbackText({ position: 2, firstName: '', callWith: '' });
  assert.match(t, /^We know/);
  assert.match(t, /call with our team/);
});

test('length: a 324-character Four-Step text no longer fails; 490 does', () => {
  const base = 'Mark, wanting time to think it over before spending the money is fair, especially on something this size. You mentioned protecting the home for the family before everyone visits for Christmas matters most. There might be a way to make the numbers work without the rush, would a quick call with John help look at it together?';
  assert.equal(base.length, 324);
  const opts = { position: 2, formula: 'four_step', repFirstName: 'John', firstName: 'Mark' };
  assert.ok(!checkF0Copy(base, opts).includes('too_long'));
  assert.ok(checkF0Copy(base.padEnd(490, 'x'), opts).includes('too_long'));
});

test('deal: "a better deal" is a reason and passes the offer test on team copy; an amount still fails', () => {
  const opts = { position: 1, formula: 'four_step', voice: 'team', callWith: 'John', repFirstName: 'John', firstName: 'Mark' };
  const ok = 'Mark, a project this size deserves some thought. Keeping the storms out of the back rooms mattered most. We may be able to get you a better deal. Would a quick call with John make sense?';
  const fails = checkF0Copy(ok, opts);
  assert.ok(!fails.includes('offer_talk'), fails.join(','));
  assert.ok(!fails.includes('no_call_reason'), fails.join(','));
  assert.ok(checkF0Copy(ok.replace('a better deal', 'a better deal, $500 off'), opts).some(f => f === 'money' || f === 'offer_talk'));
});
