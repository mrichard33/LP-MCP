/**
 * scripts/test-kb-vector-gate.js — Tier 2 vector gate (kb-retriever v1.9)
 *
 * The three decisions that determine whether a lead's turn ever hits OpenAI
 * + pgvector, exercised against src/knowledge/vector-gate.js (no env needed):
 *   1. getKbVectorMode()       — missing/unknown values fall back to 'off'
 *   2. shouldRunVectorSearch() — 'miss' intents only when Tier 1 came back
 *                                empty; 'always' intents every time; others never
 *   3. dedupeVectorMatches()   — belief-stack docs dropped only when the
 *                                deterministic belief-stack block is attached
 *
 * Run: node --test scripts/test-kb-vector-gate.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getKbVectorMode,
  shouldRunVectorSearch,
  dedupeVectorMatches,
  VECTOR_INTENT_POLICY,
} from '../src/knowledge/vector-gate.js';

test('getKbVectorMode defaults to off and rejects unknown values', () => {
  assert.equal(getKbVectorMode({}), 'off');
  assert.equal(getKbVectorMode({ KB_VECTOR_MODE: '' }), 'off');
  assert.equal(getKbVectorMode({ KB_VECTOR_MODE: 'on' }), 'off');
  assert.equal(getKbVectorMode({ KB_VECTOR_MODE: 'true' }), 'off');
  assert.equal(getKbVectorMode({ KB_VECTOR_MODE: ' SHADOW ' }), 'shadow');
  assert.equal(getKbVectorMode({ KB_VECTOR_MODE: 'live' }), 'live');
});

test('QUESTION runs only when kb_faqs missed', () => {
  assert.equal(shouldRunVectorSearch('QUESTION', { faqs: [] }), true);
  assert.equal(shouldRunVectorSearch('QUESTION', {}), true);
  assert.equal(shouldRunVectorSearch('QUESTION', { faqs: [{ question_pattern: 'x' }] }), false);
});

test('OBJECTION runs only when no objection script matched', () => {
  assert.equal(shouldRunVectorSearch('OBJECTION', { objection_script: null }), true);
  assert.equal(shouldRunVectorSearch('OBJECTION', { objection_script: { opener: 'x' } }), false);
});

test('PRICING / SEND_INFO / UNCLEAR always run; booking-family intents never do', () => {
  for (const i of ['PRICING', 'SEND_INFO', 'UNCLEAR']) {
    assert.equal(shouldRunVectorSearch(i, { faqs: [{}], objection_script: {} }), true, i);
  }
  for (const i of ['BOOK', 'BOOK_NEXTSTEP', 'BOOK_QUOTE_READY', 'FAST_TRACK_FRUSTRATED',
                   'CALLBACK', 'CALLBACK_CALM', 'APPT_STATUS', 'NOT_INTERESTED',
                   'RECONNECT', 'NOPE', undefined, null]) {
    assert.equal(shouldRunVectorSearch(i, {}), false, String(i));
  }
});

test('policy table only contains the two known policies', () => {
  for (const [intent, policy] of Object.entries(VECTOR_INTENT_POLICY)) {
    assert.ok(policy === 'miss' || policy === 'always', `${intent}: ${policy}`);
  }
});

test('belief-stack docs are dropped only when belief_stack is attached', () => {
  const matches = [
    { source_doc: 'reece_belief_stack',      similarity: 0.91 },
    { source_doc: 'reece_pricing_policy',    similarity: 0.80 },
    { source_doc: 'antifragile_v3',          similarity: 0.52 },
    { source_doc: 'reece_objection_playbook', similarity: 0.50 },
  ];
  const attached = { belief_stack: [{ source_doc: 'reece_belief_stack', text: '...' }] };
  assert.deepEqual(
    dedupeVectorMatches(matches, attached).map((m) => m.source_doc),
    ['antifragile_v3'],
  );
  assert.deepEqual(
    dedupeVectorMatches(matches, { belief_stack: null }).map((m) => m.source_doc),
    ['reece_belief_stack', 'reece_pricing_policy', 'antifragile_v3', 'reece_objection_playbook'],
  );
  assert.deepEqual(dedupeVectorMatches(undefined, attached), []);
  assert.deepEqual(dedupeVectorMatches(null, {}), []);
});
