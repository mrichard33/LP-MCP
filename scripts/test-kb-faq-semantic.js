/**
 * scripts/test-kb-faq-semantic.js — Semantic Tier 1 core (kb-retriever v1.10)
 *
 * Exercises src/knowledge/tier1-semantic-core.js with no env and no network:
 *   1. mode parsing falls back to 'off'
 *   2. buildFaqEmbedText / hashText — stable, and change when content changes
 *   3. makeQueryEmbedder — exactly one embed call per turn; none for empty text;
 *      a failure clears the memo so a retry can succeed
 *   4. pickObjectionType — threshold + best-of
 *   5. OBJECTION_TYPE_DESCRIPTIONS keys == the six kb_objection_scripts types
 *
 * Run: node --test scripts/test-kb-faq-semantic.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getKbFaqSemanticMode,
  buildFaqEmbedText,
  hashText,
  makeQueryEmbedder,
  pickObjectionType,
  OBJECTION_TYPE_DESCRIPTIONS,
} from '../src/knowledge/tier1-semantic-core.js';

test('getKbFaqSemanticMode defaults to off and rejects unknown values', () => {
  assert.equal(getKbFaqSemanticMode({}), 'off');
  assert.equal(getKbFaqSemanticMode({ KB_FAQ_SEMANTIC_MODE: 'on' }), 'off');
  assert.equal(getKbFaqSemanticMode({ KB_FAQ_SEMANTIC_MODE: ' Shadow ' }), 'shadow');
  assert.equal(getKbFaqSemanticMode({ KB_FAQ_SEMANTIC_MODE: 'live' }), 'live');
});

test('buildFaqEmbedText uses pattern + short answer, caps the answer, prefers answer_short', () => {
  const t = buildFaqEmbedText({
    question_pattern: '  hurricane rated / impact rated  ',
    answer_short: 'Yes — all our windows are impact rated.',
    canonical_answer: 'LONG '.repeat(200),
  });
  assert.ok(t.startsWith('hurricane rated / impact rated\nYes'));
  assert.ok(!t.includes('LONG'));
  const long = buildFaqEmbedText({ question_pattern: 'q', canonical_answer: 'x'.repeat(1000) });
  assert.equal(long.length, 'q\n'.length + 240);
  assert.equal(buildFaqEmbedText({}), '');
});

test('hashText is stable and changes when content changes', () => {
  assert.equal(hashText('a'), hashText('a'));
  assert.notEqual(hashText('a'), hashText('a '));
  assert.equal(hashText('a').length, 32);
  assert.equal(hashText(undefined), hashText(''));
});

test('makeQueryEmbedder calls embed once per turn and never for empty text', async () => {
  let calls = 0;
  const fake = async (text) => { calls++; return { embedding: [1, 0], tokens: 1, cost_usd: 0, text }; };
  const get = makeQueryEmbedder('will these hold up in a cat 4', fake);
  const [a, b] = await Promise.all([get(), get()]);
  await get();
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.deepEqual(a.embedding, [1, 0]);

  const empty = makeQueryEmbedder('   ', fake);
  assert.equal(await empty(), null);
  assert.equal(calls, 1);

  assert.throws(() => makeQueryEmbedder('x'), /embedFn/);
});

test('makeQueryEmbedder clears the memo after a failure so a retry can succeed', async () => {
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error('boom'); return { embedding: [0, 1] }; };
  const get = makeQueryEmbedder('hello', flaky);
  await assert.rejects(get(), /boom/);
  const ok = await get();
  assert.deepEqual(ok.embedding, [0, 1]);
  assert.equal(n, 2);
});

test('pickObjectionType honours the threshold and picks the best', () => {
  assert.deepEqual(pickObjectionType({ price: 0.51, timing: 0.22, spouse: 0.48 }, 0.30), { type: 'price', similarity: 0.51 });
  assert.equal(pickObjectionType({ price: 0.29, timing: 0.10 }, 0.30), null);
  assert.equal(pickObjectionType({}, 0.30), null);
  assert.equal(pickObjectionType(undefined, 0.30), null);
  assert.deepEqual(pickObjectionType({ diy: NaN, trust: 0.35 }, 0.30), { type: 'trust', similarity: 0.35 });
});

test('objection type descriptions cover exactly the six kb_objection_scripts types', () => {
  assert.deepEqual(
    Object.keys(OBJECTION_TYPE_DESCRIPTIONS).sort(),
    ['competitor', 'diy', 'price', 'spouse', 'timing', 'trust'],
  );
  for (const [k, v] of Object.entries(OBJECTION_TYPE_DESCRIPTIONS)) {
    assert.ok(typeof v === 'string' && v.length > 40, k);
  }
});
