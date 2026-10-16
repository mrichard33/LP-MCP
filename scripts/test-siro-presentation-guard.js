/**
 * The visit in LEAD FACTS and the presentation guard — scripts/test-siro-presentation-guard.js (2026-10-16)
 * Run: node --test scripts/test-siro-presentation-guard.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforcePresentationGuard, presentationViolations } from '../src/siro/presentation-guard.js';
import { buildLeadFacts, renderLeadFacts } from '../src/agentic/lead-facts.js';

const presentation = { rep_first_name: 'Brian', objections: [] };

test('a price or a rep quote is dropped, the rest kept; no block = no change', () => {
  const out = enforcePresentationGuard('Totally fair. The total was $18,400. What would make it work for you?', { presentation });
  assert.equal(out.text, 'Totally fair. What would make it work for you?');
  assert.deepEqual(out.changes, ['presentation_quoted_price']);
  const rep = enforcePresentationGuard('Your rep said the slider is the priority. Is it still?', { presentation });
  assert.equal(rep.text, 'Is it still?');
  // A reply that is ONLY the bad sentence is never emptied; the check still fails it.
  assert.equal(enforcePresentationGuard('Brian said it was the priority.', { presentation }).changed, false);
  assert.deepEqual(presentationViolations('Your rep said the slider is the priority. Is it still?', presentation), ['presentation_rep_quoted']);
  assert.equal(enforcePresentationGuard('It was $500.', { presentation: null }).changed, false);
  assert.deepEqual(presentationViolations('Brian mentioned it', null), []);
});

const ROW = {
  recording_id: 'rec_1', processed: true, deleted: false, lp_lead_id: '1', recorded_at: '2026-10-14T22:00:00Z',
  rep_name: 'Brian Kowalski', result: 'not closed', summary: [{ name: 'Need', content: 'Lanai slider sticks' }],
  moments: [{ kind: 'objection', objection_type: 'price', customer_said: 'Too expensive' }],
};
const LP = {
  disposition: 'OPPFDN',
  notes: [
    { text: 'Siro Call Summary: Customer Need & Motivation: lanai slider', entered_by: 'Siro', date: '2026-10-14T23:00:00Z' },
    { text: 'Customer wants to think it over with spouse', entered_by: 'Kowalski, Brian', date: '2026-10-14T22:30:00Z' },
  ],
};

test('LEAD FACTS gets the PRESENTATION block after the notes, and Siro\'s own LP note is dropped then', () => {
  const lines = renderLeadFacts(buildLeadFacts({ lp: LP, siro: [ROW] }));
  const text = lines.join('\n');
  assert.match(text, /=== PRESENTATION \(Siro recording/);
  assert.doesNotMatch(text, /Siro Call Summary/);
  assert.match(text, /think it over with spouse/);
  assert.ok(lines.findIndex(l => /=== PRESENTATION/.test(l)) > lines.findIndex(l => /think it over/.test(l)));
  // Without a recording nothing changes: the Siro note stays, no block.
  const plain = renderLeadFacts(buildLeadFacts({ lp: LP })).join('\n');
  assert.match(plain, /Siro Call Summary/);
  assert.doesNotMatch(plain, /PRESENTATION/);
});
