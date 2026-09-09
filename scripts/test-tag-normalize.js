/**
 * test-tag-normalize.js — 2026-09-09 (Wally Scott 2LT4JDrObOgPlKnn3H0q post-mortem).
 *
 * The objection-confirmed family has two shapes in the wild:
 *   objection-confirmed-competitor   ← what O.0 step 20 branches on
 *   objection-confirmed:competitor   ← namespaced form, matches nothing
 *
 * A colon-form tag is a SILENT failure: GHL accepts the write, no workflow
 * reads it, the lead enters no arc. normalizeTag (src/ghl.js) rewrites colon
 * → hyphen at the chokepoint every tag producer passes through.
 *
 * Contract under test:
 *   1. colon → hyphen for every objection value the system emits
 *   2. hyphen form passes through untouched (idempotent)
 *   3. unrelated tags are never rewritten — especially other colon namespaces
 *   4. matching is case-insensitive, output is lowercased
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeTag } = await import('../src/ghl.js');

// ── 1. colon → hyphen across the objection value set ────────────────

const OBJECTION_VALUES = ['competitor', 'price', 'timing', 'spouse', 'trust', 'complexity'];

for (const value of OBJECTION_VALUES) {
  test(`objection-confirmed:${value} → objection-confirmed-${value}`, () => {
    assert.equal(
      normalizeTag(`objection-confirmed:${value}`),
      `objection-confirmed-${value}`,
    );
  });
}

test('a hyphenated multi-word value survives the rewrite', () => {
  assert.equal(
    normalizeTag('objection-confirmed:not-interested'),
    'objection-confirmed-not-interested',
  );
});

// ── 2. hyphen form is already correct — never touched ───────────────

for (const value of OBJECTION_VALUES) {
  test(`objection-confirmed-${value} passes through unchanged`, () => {
    const tag = `objection-confirmed-${value}`;
    assert.equal(normalizeTag(tag), tag);
  });
}

test('normalizeTag is idempotent', () => {
  assert.equal(
    normalizeTag(normalizeTag('objection-confirmed:competitor')),
    'objection-confirmed-competitor',
  );
});

// ── 3. unrelated tags are never rewritten ───────────────────────────

const UNRELATED = [
  'stop-bot',
  'intent-rescission-rescue',
  'rescission-state:active',
  'concern-expressed:competitor',
  'pre-demo-concern:competitor',
  'loss-reason:competitor',
  'active-entry:chatbot',
  'stage:dnc',
  'story-arc:sa3',
  'objection-confirmed',          // no value at all
  'objection-confirmed:',         // empty namespace value — the ':' guard owns this
  'pre-objection-confirmed:price', // prefix must anchor at the start
];

for (const tag of UNRELATED) {
  test(`unrelated tag "${tag}" is returned unchanged`, () => {
    assert.equal(normalizeTag(tag), tag);
  });
}

// ── 4. case-insensitive match, lowercased output ────────────────────

test('uppercase namespace is matched', () => {
  assert.equal(normalizeTag('OBJECTION-CONFIRMED:COMPETITOR'), 'objection-confirmed-competitor');
});

test('mixed case is matched and the value is lowercased', () => {
  assert.equal(normalizeTag('Objection-Confirmed:Competitor'), 'objection-confirmed-competitor');
});

test('surrounding whitespace is trimmed before matching', () => {
  assert.equal(normalizeTag('  objection-confirmed:price  '), 'objection-confirmed-price');
});

// ── 5. non-string input never throws ────────────────────────────────

test('null / undefined / non-string input is returned as given, no throw', () => {
  assert.equal(normalizeTag(null), null);
  assert.equal(normalizeTag(undefined), undefined);
  assert.equal(normalizeTag(''), '');
  assert.equal(normalizeTag(42), 42);
});
