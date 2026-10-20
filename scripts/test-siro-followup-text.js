/**
 * Siro's suggested follow-up text — scripts/test-siro-followup-text.js (Mark, 2026-10-19, ruling 2)
 * Run: node --test scripts/test-siro-followup-text.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecording, followupTextFrom, FOLLOWUP_TEXT_MAX } from '../src/siro/normalize.js';
import { buildPresentationFacts, renderPresentationBlock, presentationTemplateVars } from '../src/siro/presentation-facts.js';
import { siroDraftOverlap, copiesSiroDraft } from '../src/siro/presentation-guard.js';
import { checkReply } from '../src/eval/reply-invariants.js';
import { RAW_RECORDING } from './fixtures/siro-recording.js';

const withDraft = (text, email = 'Dear Dana, the email draft.') => ({
  ...RAW_RECORDING,
  followups: [{
    ...RAW_RECORDING.followups[0],
    context: [
      ...RAW_RECORDING.followups[0].context.filter(c => !/Followup(?:Text|Email)Header/.test(c.header)),
      { header: 'FollowupEmailHeader', value: email },
      { header: 'FollowupTextHeader', value: text },
    ],
  }],
});

test('the draft is cleaned: money, discount, phone, email and sensitive sentences go', () => {
  const t = followupTextFrom(withDraft(
    'Hi Dana, this is Brian. I can offer an extra $2,000 discount this week. Call me at (352) 555-0188 or dana@example.com. '
    + 'I am so sorry for your loss. The lanai slider will finally stop rattling in storms. Want to talk it over with Mark?',
  ).followups[0]);
  assert.ok(t);
  for (const bad of ['$', '2,000', 'discount', '555-0188', 'dana@example.com', 'loss']) assert.ok(!t.includes(bad), `followup_text must not hold ${bad}: ${t}`);
  assert.match(t, /lanai slider will finally stop rattling/);
});

test('null when Siro wrote none, or nothing survives the clean', () => {
  const fu = { ...RAW_RECORDING.followups[0], context: RAW_RECORDING.followups[0].context.filter(c => c.header !== 'FollowupTextHeader') };
  assert.equal(followupTextFrom(fu), null);
  assert.equal(followupTextFrom(withDraft('Financing is 0% for 12 months at $190 a month.').followups[0]), null);
  assert.equal(followupTextFrom(withDraft('N/A').followups[0]), null);
});

test('the email draft and the thinking are never stored', () => {
  const row = normalizeRecording(withDraft('The slider stays on my mind.', 'Dear Dana, EMAIL-DRAFT-MARKER'), { source: 'poll' });
  const all = JSON.stringify(row);
  assert.ok(!all.includes('EMAIL-DRAFT-MARKER'));
  assert.ok(!all.includes('HIGH FOLLOW-UP'));
  assert.equal(row.followup_text, 'The slider stays on my mind.');
});

test('capped at 400 characters; off stores none', () => {
  const long = Array.from({ length: 60 }, () => 'The slider sticks.').join(' ');
  assert.ok(followupTextFrom(withDraft(long).followups[0]).length <= FOLLOWUP_TEXT_MAX);
  assert.equal(normalizeRecording(withDraft('The slider.'), { followupTextMode: 'off' }).followup_text, null);
});

test('the reference line shows only in live mode, and never a sensitive detail', () => {
  const row = { ...normalizeRecording(withDraft('The lanai slider will finally stop rattling.'), { source: 'poll' }), lp_lead_id: '1', processed: true };
  const facts = buildPresentationFacts([row]);
  assert.ok(!renderPresentationBlock(facts).some(l => /Siro's suggested follow-up/.test(l)));
  const live = renderPresentationBlock(facts, { followupTextLive: true });
  assert.ok(live.some(l => /^Siro's suggested follow-up \(reference for topic and tone only; write your own; never send it as written\): "The lanai slider/.test(l)));
  assert.equal(presentationTemplateVars(facts).followup_text_line, '');
  assert.match(presentationTemplateVars(facts, { followupTextLive: true }).followup_text_line, /lanai slider/);
});

test('siro_draft_copied: 60% of the reply taken from the draft fails', () => {
  const draft = 'The lanai slider will finally stop rattling in storms once it is replaced.';
  assert.ok(siroDraftOverlap('The lanai slider will finally stop rattling in storms. Want to talk?', draft) >= 0.6);
  assert.ok(copiesSiroDraft('The lanai slider will finally stop rattling in storms once replaced.', draft));
  assert.ok(!copiesSiroDraft('Did you get a chance to look over the proposal, Dana?', draft));
  const presentation = { rep_first_name: 'Brian', followup_text: draft };
  const r = checkReply('The lanai slider will finally stop rattling in storms once it is replaced. Sound good?', { channel: 'sms', presentation });
  assert.ok(r.violations.some(v => v.code === 'siro_draft_copied'));
  const ok = checkReply('Did you get a chance to look over the proposal?', { channel: 'sms', presentation });
  assert.ok(!ok.violations.some(v => v.code === 'siro_draft_copied'));
});
