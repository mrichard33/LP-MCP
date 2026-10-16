/**
 * The GHL demo note — scripts/test-siro-demo-note.js (2026-10-16)
 * Run: node --test scripts/test-siro-demo-note.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoNote, DEMO_NOTE_MAX } from '../src/siro/demo-note.js';
import { buildPresentationFacts } from '../src/siro/presentation-facts.js';
import { normalizeRecording } from '../src/siro/normalize.js';
import { RAW_RECORDING } from './fixtures/siro-recording.js';

const row = { ...normalizeRecording(RAW_RECORDING, { source: 'poll' }), lp_lead_id: '583321' };
const facts = buildPresentationFacts([row], { now: Date.parse('2026-10-16T14:00:00Z') });

test('the note has the agreed layout and the recording link', () => {
  const note = buildDemoNote(facts);
  const lines = note.split('\n');
  assert.equal(lines[0], 'DEMO SUMMARY (Siro) — Oct 14, 2026 — rep Brian Kowalski — outcome: not closed');
  assert.match(note, /^What they want: Storm protection/m);
  assert.match(note, /^Hesitations:\n {2}- price: customer said "The price is higher than the other quote"/m);
  assert.match(note, /^Questions asked: How long does the install take\?/m);
  assert.match(note, /^Follow-up \(Siro score 4\/5\): Call after the weekend/m);
  assert.match(note, /^Summary: /m);
  assert.equal(lines.at(-1), 'Recording: https://app.siro.ai/analyze/rec_abc123');
  assert.doesNotMatch(note, /583321/); // never the LP lead id
});

test('"none recorded" when the visit gave nothing; capped at 2,000 with the link kept', () => {
  const empty = { ...facts, objections: [], interests: [], questions: [], summary_lines: [], followup: {} };
  const note = buildDemoNote(empty);
  assert.match(note, /Hesitations: none recorded/);
  assert.match(note, /Follow-up \(Siro score n\/a\/5\): none/);
  const big = buildDemoNote({ ...facts, summary_lines: Array.from({ length: 40 }, () => 'y'.repeat(290)) });
  assert.ok(big.length <= DEMO_NOTE_MAX);
  assert.match(big, /Recording: https:\/\/app\.siro\.ai\/analyze\/rec_abc123$/);
  assert.equal(buildDemoNote(null), null);
});
