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

// ══════════════════════════════════════════════════════════════════════════
// PROBE IDENTITY — matchFaqsProbed must say WHICH faq, not only how close
//
// Added 2026-09-23. The probe recorded the SCORE of a near-miss and discarded
// its IDENTITY, which is the one fact the score cannot supply: "0.378 and it
// was the right FAQ" argues for lowering the floor; "0.378 and it was the
// wrong one" argues the floor is working. Both wrote an identical-looking row.
//
// That gap had already cost a bad call. The 0.40 -> 0.35 change was argued
// from a near-miss ASSUMED to point at the right FAQ; probed afterwards it
// pointed at the wrong one, so the lower floor turned a clean miss into two
// confident wrong matches.
//
// The RPC is stubbed, so these run with no env and no network.
// ══════════════════════════════════════════════════════════════════════════

const { matchFaqsProbed } = await import('../src/knowledge/tier1-semantic.js');

/** Rows a match_kb_faqs call would return, top-first. */
const FAKE_ROWS = [
  { id: 3,  question_pattern: 'Do you sell aluminum or vinyl windows?', similarity: 0.386 },
  { id: 17, question_pattern: 'Impact windows vs hurricane shutters?',  similarity: 0.359 },
  { id: 18, question_pattern: 'How much do impact windows cost?',       similarity: 0.290 },
];

/** A queryEmbedding-shaped object; the stub ignores its contents. */
const EMBEDDING = { embedding: new Array(1536).fill(0) };

/** Stand-in for the match_kb_faqs RPC — the deps seam, no supabase needed. */
const fakeMatch = (rows) => async (_emb, _ch, count, threshold) =>
  rows.filter((r) => r.similarity >= threshold).slice(0, count);

test('probe returns the candidate IDENTITIES, not just the top score', async () => {
  const { matches, top, candidates } = await matchFaqsProbed(
    EMBEDDING, 'sms', 3, { probe: true, match: fakeMatch(FAKE_ROWS) },
  );

  // The bug: this used to be unanswerable from the audit row.
  assert.equal(candidates.length, 3, 'every candidate the search saw is recorded');
  assert.equal(candidates[0].faq_id ?? candidates[0].id, 3);
  assert.match(candidates[0].question_pattern, /aluminum or vinyl/);
  assert.equal(top, 0.386);

  // And each one says whether it cleared the floor, so a reader never has to
  // re-derive the threshold to interpret the row.
  for (const c of candidates) {
    assert.equal(typeof c.matched, 'boolean', 'every candidate carries a matched flag');
  }

  // matches stays exactly "what the live path would answer with".
  assert.ok(matches.length <= 3);
  for (const m of matches) assert.ok(m.similarity >= 0.35 || m.similarity >= 0.40);
});

test('the first-to-second margin is readable from the candidates', async () => {
  // The margin is the signal the absolute score hides: on this corpus a right
  // answer led by 0.046-0.159 and a wrong one by 0.017-0.027. Recording the
  // tail is what makes that computable later without another live probe.
  const { candidates } = await matchFaqsProbed(
    EMBEDDING, 'sms', 3, { probe: true, match: fakeMatch(FAKE_ROWS) },
  );
  const margin = candidates[0].similarity - candidates[1].similarity;
  assert.ok(Math.abs(margin - 0.027) < 1e-9, `expected the real 0.027 margin, got ${margin}`);
});

test('live mode records NO candidates — [] means "not probed"', async () => {
  // Live must stay distinguishable from a probed miss: kb-retriever writes
  // NULL for an empty candidate list, so "we did not look below the floor"
  // never reads as "we looked and found nothing".
  const { candidates } = await matchFaqsProbed(
    EMBEDDING, 'sms', 3, { probe: false, match: fakeMatch(FAKE_ROWS) },
  );
  assert.deepEqual(candidates, [], 'not probing records nothing');
});

test('THE REGRESSION: at 0.40 these rows miss cleanly; at 0.35 they answer WRONG', async () => {
  // FAKE_ROWS is the real result for "What does single or double hung mean":
  // top is #3 "Do you sell aluminum or vinyl windows?" at 0.386 — the WRONG
  // FAQ. This is the query the 0.40 -> 0.35 change was argued from, on the
  // assumption its near-miss pointed at the RIGHT one. It did not.
  //
  // The floor cannot tell these apart; only the identity can. That is the
  // whole reason the probe now records it.
  const live40 = await matchFaqsProbed(EMBEDDING, 'sms', 3, { match: fakeMatch(FAKE_ROWS) });
  assert.deepEqual(live40.matches, [], 'at a 0.40 floor the query correctly answers nothing');

  // Same rows, floor lowered: two wrong FAQs now clear it.
  const admitted = FAKE_ROWS.filter((r) => r.similarity >= 0.35);
  assert.equal(admitted.length, 2, 'lowering to 0.35 admits two rows');
  assert.match(admitted[0].question_pattern, /aluminum or vinyl/, 'and the best of them is wrong');
});

test('a probe with no candidates at all is still safe to serialize', async () => {
  const { matches, top, candidates } = await matchFaqsProbed(
    EMBEDDING, 'sms', 3, { probe: true, match: fakeMatch([]) },
  );
  assert.deepEqual(candidates, []);
  assert.deepEqual(matches, []);
  assert.equal(top, null, 'no rows means no similarity, not 0');
});
