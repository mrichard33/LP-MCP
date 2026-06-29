// scripts/test-source-promoter-backstop.js
//
// Unit tests for the v10.2 null-source attribution backstop in
// src/sync-leads.js — deriveSourceFromPromoter() + effectiveLeadSource().
//
// Covers the active leak ("Internet, <Vendor>" feeds — Socius Marketing,
// Lead Gurus) while proving rep-entered promoters ("Surname, First - OFFICE")
// are never mistaken for a source.
//
// Run standalone:  node scripts/test-source-promoter-backstop.js
// (also picked up by the aggregate scripts/test-*.js suite via `npm test`.)

import assert from 'node:assert/strict';
import { _internal } from '../src/sync-leads.js';

const { deriveSourceFromPromoter, effectiveLeadSource } = _internal;

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ── deriveSourceFromPromoter ───────────────────────────────────────
test('Internet, Socius Marketing → Internet / Socius Marketing', () => {
  assert.deepEqual(
    deriveSourceFromPromoter('Internet, Socius Marketing'),
    { source: 'Internet', sourcesubdescr: 'Socius Marketing' },
  );
});

test('Internet, Lead Gurus → Internet / Lead Gurus', () => {
  assert.deepEqual(
    deriveSourceFromPromoter('Internet, Lead Gurus'),
    { source: 'Internet', sourcesubdescr: 'Lead Gurus' },
  );
});

test('rep promoter "Singer, Jack - ORL" → null', () => {
  assert.equal(deriveSourceFromPromoter('Singer, Jack - ORL'), null);
});

test('rep promoter "Richard, Mark" → null', () => {
  assert.equal(deriveSourceFromPromoter('Richard, Mark'), null);
});

test('no comma / blank vendor / empty / null / undefined → null', () => {
  assert.equal(deriveSourceFromPromoter('Internet'), null);     // no comma
  assert.equal(deriveSourceFromPromoter('Internet, '), null);   // blank vendor
  assert.equal(deriveSourceFromPromoter(', Socius'), null);     // blank channel
  assert.equal(deriveSourceFromPromoter(''), null);
  assert.equal(deriveSourceFromPromoter(null), null);
  assert.equal(deriveSourceFromPromoter(undefined), null);
});

// ── effectiveLeadSource ────────────────────────────────────────────
test('native source wins → returns native, derivedFromPromoter:false', () => {
  assert.deepEqual(
    effectiveLeadSource({ source: 'Canvass' }),
    { source: 'Canvass', sourcesubdescr: null, derivedFromPromoter: false },
  );
});

test('blank native source → derives from Internet promoter', () => {
  assert.deepEqual(
    effectiveLeadSource({ promotername: 'Internet, Socius Marketing' }),
    { source: 'Internet', sourcesubdescr: 'Socius Marketing', derivedFromPromoter: true },
  );
});

test('blank native source + rep promoter → stays null', () => {
  assert.deepEqual(
    effectiveLeadSource({ promotername: 'Singer, Jack - ORL' }),
    { source: null, sourcesubdescr: null, derivedFromPromoter: false },
  );
});

// ── runner ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
console.log(`\n[test-source-promoter-backstop] ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
