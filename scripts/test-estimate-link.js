import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEstimateLinkRequest,
  hasCompletedEstimate,
  ensureEstimateLink,
  getEstimatePdfMergeTag,
} from '../src/knowledge/estimate-link.js';

const TAG = '{{trigger_link.uyGlZ6ydYUmAqeWysREJ}}';

test('merge tag is the View Calculator Estimate trigger link', () => {
  assert.equal(getEstimatePdfMergeTag(), TAG);
});

test('detects estimate requests', () => {
  for (const s of [
    'Did not get estimate\n\n\n\n',           // 441204 exact inbound
    "I didn't get my estimate",
    'can you resend the estimate?',
    'where is my quote',
    'the pdf wont open',
    'I need my estimate',
  ]) assert.equal(detectEstimateLinkRequest(s), true, s);
  for (const s of ['Saturday works', 'How much are impact doors?', 'Not interested', '']) {
    assert.equal(detectEstimateLinkRequest(s), false, s);
  }
});

test('eligibility requires a completed estimate tag', () => {
  assert.equal(hasCompletedEstimate(['estimator-completed']), true);
  assert.equal(hasCompletedEstimate(['completed:wec']), true);
  assert.equal(hasCompletedEstimate(['active-entry:estimate-calculator']), false);
  assert.equal(hasCompletedEstimate([]), false);
});

test('REGRESSION 441204: link inserted after the lead-in line', () => {
  const body = 'Michael,\n\nThanks for letting us know. Here is a direct link to your estimate PDF so you have it on hand:\n\nThe figure you saw online is a starting point based on what you entered.\n\nOne thing that helps us get that scheduled correctly - will anyone else be part of the decision, or will it just be you for the visit?';
  const r = ensureEstimateLink(body, { eligible: true, requested: true });
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'inserted_after_leadin');
  assert.match(r.text, /on hand:\n\{\{trigger_link\.uyGlZ6ydYUmAqeWysREJ\}\}\n\nThe figure/);
});

test('inline colon lead-in', () => {
  const r = ensureEstimateLink('Here is your estimate link: The figure is a starting point.', { eligible: true });
  assert.equal(r.reason, 'inserted_inline');
  assert.ok(r.text.includes(`link:\n${TAG}\n\nThe figure`));
});

test('requested but not mentioned → appended', () => {
  const r = ensureEstimateLink('Sorry about that, Michael.', { eligible: true, requested: true });
  assert.equal(r.reason, 'appended');
  assert.ok(r.text.endsWith(`Your estimate: ${TAG}`));
});

test('no-ops', () => {
  const withTag = `Here is your estimate link:\n${TAG}`;
  assert.equal(ensureEstimateLink(withTag, { eligible: true, requested: true }).changed, false);
  assert.equal(ensureEstimateLink('Here is your estimate link:', { eligible: false, requested: true }).changed, false);
  assert.equal(ensureEstimateLink('Does Saturday at 10 work?', { eligible: true, requested: false }).changed, false);
});

test('kill switch', () => {
  process.env.ESTIMATE_LINK_GUARD = 'off';
  assert.equal(ensureEstimateLink('Here is your estimate link:', { eligible: true, requested: true }).changed, false);
  delete process.env.ESTIMATE_LINK_GUARD;
});
