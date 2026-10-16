/**
 * The GHL demo note — scripts/test-siro-demo-note.js (2026-10-16)
 * Run: node --test scripts/test-siro-demo-note.js
 *
 * The note carries the visit's prices (the user's ruling, 2026-10-16: "it
 * should be saved in our Go High Level system").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoNote, pricingLines, DEMO_NOTE_MAX } from '../src/siro/demo-note.js';
import { buildPresentationFacts, formatVisitDate } from '../src/siro/presentation-facts.js';
import { normalizeRecording } from '../src/siro/normalize.js';
import { RAW_RECORDING, FIXTURE_RECORDED_AT } from './fixtures/siro-recording.js';

const row = { ...normalizeRecording(RAW_RECORDING, { source: 'poll' }), lp_lead_id: '583321' };
const facts = buildPresentationFacts([row], { now: Date.parse(FIXTURE_RECORDED_AT) + 3_600_000 });

test('the note has the agreed layout, the prices and the recording link', () => {
  const note = buildDemoNote(facts, { pricing: row.pricing });
  const lines = note.split('\n');
  assert.equal(lines[0], `DEMO SUMMARY (Siro) — ${formatVisitDate(FIXTURE_RECORDED_AT)} — rep Brian Kowalski — outcome: open`);
  assert.match(note, /^What they want: The lanai slider sticks/m);
  assert.match(note, /^Hesitations:\n {2}- price: Strongest objection: uncertain return on investment/m);
  assert.match(note, /^ {2}- spouse: They were not ready to decide/m);
  assert.match(note, /^Main objection: Pricing \(also: Spouse\)$/m);
  assert.match(note, /^Scope discussed: Lanai slider plus 4 bedroom windows\.$/m);
  assert.match(note, /^Pricing \(from the visit\):\n {2}- First quote: \$24,500\n {2}- Final quote: \$18,400\n {2}- Overall cost: 18400\n {2}- Financing: \$500 down, about \$190 per month\.$/m);
  assert.match(note, /^Next step: Call at the end of next week .* \(follow up: In 1 Week\)$/m);
  assert.match(note, /^Siro follow-up score: 4\/5$/m);
  assert.equal(lines.at(-1), 'Recording: https://app.siro.ai/analyze/rec_abc123');
  assert.doesNotMatch(note, /583321/); // never the LP lead id
  assert.doesNotMatch(note, /Dear Dana|HIGH FOLLOW-UP|dana@example\.com|28\.18/); // drafts, thinking, email, GPS
});

test('no pricing → no pricing section; "none recorded" when the visit gave nothing; capped with the link kept', () => {
  assert.match(buildDemoNote(facts), /Pricing \(from the visit\)/); // defaults to the facts' pricing
  assert.doesNotMatch(buildDemoNote(facts, { pricing: null }), /Pricing \(from the visit\)/);
  assert.deepEqual(pricingLines(null), []);
  assert.deepEqual(pricingLines({ final_price_quote: '  ' }), []);
  const empty = { ...facts, objections: [], interests: [], questions: [], summary_lines: [], followup: {}, insights: {} };
  const note = buildDemoNote(empty);
  assert.match(note, /Hesitations: none recorded/);
  assert.match(note, /What they want: none recorded/);
  assert.match(note, /Next step: none recorded/);
  assert.match(note, /Siro follow-up score: n\/a\/5/);
  const big = buildDemoNote({ ...facts, interests: Array.from({ length: 40 }, () => 'y'.repeat(190)) });
  assert.ok(big.length <= DEMO_NOTE_MAX);
  assert.match(big, /Recording: https:\/\/app\.siro\.ai\/analyze\/rec_abc123$/);
  assert.equal(buildDemoNote(null), null);
});
