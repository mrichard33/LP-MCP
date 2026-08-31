#!/usr/bin/env node
/**
 * Unit tests — src/jobs/market-resolver.js reducers
 *
 * Covers the two rules that decide a prospect's market once its rows have been
 * read. Both were previously expressed as query clauses (`.order(...)` for
 * recency, first-row-wins for branch) and are now pure functions, because range
 * pagination has to order by a unique stable key and cannot also order by
 * recency. See src/supabase-page.js.
 *
 * The point of these tests is not that the reducers are complicated — they are
 * not. It is that the ONE thing that breaks them is an incomplete input, and
 * an incomplete input produces a confident wrong answer rather than an error.
 * So each rule is tested twice: once on the full set, and once on the truncated
 * set, asserting that truncation changes the answer. That second assertion is
 * the regression guard — if someone un-paginates these reads, the wrong answer
 * it produces is the one written down here.
 *
 *   node scripts/test-market-resolver.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { latestZipByProspect, branchFirstByProspect, normalizeZip5 } from '../src/jobs/market-resolver.js';

// ── normalizeZip5 ────────────────────────────────────────────────
test('normalizeZip5 takes the leading 5 digits and rejects short input', () => {
  assert.equal(normalizeZip5('32801'), '32801');
  assert.equal(normalizeZip5('32801-1234'), '32801');
  assert.equal(normalizeZip5(' 32801 '), '32801');
  assert.equal(normalizeZip5('328'), null);
  assert.equal(normalizeZip5(null), null);
  assert.equal(normalizeZip5(undefined), null);
});

// ── latestZipByProspect ──────────────────────────────────────────
test('latest updated_at_lp wins, regardless of the order rows arrive in', () => {
  const rows = [
    { lp_prospect_id: 'p1', zip: '11111', updated_at_lp: '2026-01-01T00:00:00Z' },
    { lp_prospect_id: 'p1', zip: '99999', updated_at_lp: '2026-08-01T00:00:00Z' }, // newest
    { lp_prospect_id: 'p1', zip: '55555', updated_at_lp: '2026-04-01T00:00:00Z' },
  ];
  assert.equal(latestZipByProspect(rows).get('p1'), '99999');
  // Same set, reversed — the reducer sorts, so the answer must not move.
  assert.equal(latestZipByProspect([...rows].reverse()).get('p1'), '99999');
});

test('a newest row with no usable zip falls back to an older row that has one', () => {
  const rows = [
    { lp_prospect_id: 'p1', zip: null, updated_at_lp: '2026-08-01T00:00:00Z' }, // newest, unusable
    { lp_prospect_id: 'p1', zip: '32801', updated_at_lp: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(latestZipByProspect(rows).get('p1'), '32801');
});

test('an older row does NOT overwrite a usable newer zip', () => {
  const rows = [
    { lp_prospect_id: 'p1', zip: '32801', updated_at_lp: '2026-08-01T00:00:00Z' },
    { lp_prospect_id: 'p1', zip: '10001', updated_at_lp: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(latestZipByProspect(rows).get('p1'), '32801');
});

test('prospects are kept apart, and blank ids are dropped', () => {
  const rows = [
    { lp_prospect_id: 'p1', zip: '11111', updated_at_lp: '2026-01-01T00:00:00Z' },
    { lp_prospect_id: 'p2', zip: '22222', updated_at_lp: '2026-01-01T00:00:00Z' },
    { lp_prospect_id: null, zip: '33333', updated_at_lp: '2026-01-01T00:00:00Z' },
  ];
  const out = latestZipByProspect(rows);
  assert.equal(out.get('p1'), '11111');
  assert.equal(out.get('p2'), '22222');
  assert.equal(out.size, 2);
});

test('numeric prospect ids are keyed as strings', () => {
  const out = latestZipByProspect([{ lp_prospect_id: 162482, zip: '32801', updated_at_lp: '2026-01-01T00:00:00Z' }]);
  assert.equal(out.get('162482'), '32801');
});

test('empty and nullish input are safe', () => {
  assert.equal(latestZipByProspect([]).size, 0);
  assert.equal(latestZipByProspect(null).size, 0);
  assert.equal(latestZipByProspect(undefined).size, 0);
});

// THE REGRESSION GUARD. A truncated read is the failure this pagination exists
// to prevent, and it is silent: the prospect still resolves, to the wrong ZIP.
test('TRUNCATION CHANGES THE ANSWER — a dropped newest row yields a stale zip', () => {
  const complete = [
    { lp_prospect_id: 'p1', zip: '32801', updated_at_lp: '2026-01-01T00:00:00Z' },
    { lp_prospect_id: 'p1', zip: '99999', updated_at_lp: '2026-08-01T00:00:00Z' }, // past a 1-row cap
  ];
  const truncated = complete.slice(0, 1);
  assert.equal(latestZipByProspect(complete).get('p1'), '99999');
  assert.equal(latestZipByProspect(truncated).get('p1'), '32801');
  assert.notEqual(
    latestZipByProspect(truncated).get('p1'),
    latestZipByProspect(complete).get('p1'),
    'a truncated read must not be able to agree with a complete one here — '
    + 'if it does, this test has stopped guarding anything',
  );
});

// ── branchFirstByProspect ────────────────────────────────────────
test('a brn_map assignment beats a zip one, whichever arrives first', () => {
  const zipRow    = { prospect_id: 'p1', resolved_market_code: 'TPA_MKT', method: 'zip_lookup' };
  const branchRow = { prospect_id: 'p1', resolved_market_code: 'ORL_MKT', method: 'brn_map' };
  assert.equal(branchFirstByProspect([zipRow, branchRow]).get('p1').market_code, 'ORL_MKT');
  assert.equal(branchFirstByProspect([branchRow, zipRow]).get('p1').market_code, 'ORL_MKT');
});

test('the first zip assignment stands when no branch one exists', () => {
  const rows = [
    { prospect_id: 'p1', resolved_market_code: 'TPA_MKT', method: 'zip_lookup' },
    { prospect_id: 'p1', resolved_market_code: 'JAX_MKT', method: 'zip_out_of_area' },
  ];
  const got = branchFirstByProspect(rows).get('p1');
  assert.equal(got.market_code, 'TPA_MKT');
  assert.equal(got.method, 'zip_lookup');
});

test('a second brn_map row does not displace the first', () => {
  const rows = [
    { prospect_id: 'p1', resolved_market_code: 'ORL_MKT', method: 'brn_map' },
    { prospect_id: 'p1', resolved_market_code: 'TPA_MKT', method: 'brn_map' },
  ];
  assert.equal(branchFirstByProspect(rows).get('p1').market_code, 'ORL_MKT');
});

test('rows with a null market_code are skipped, not stored as null', () => {
  const rows = [
    { prospect_id: 'p1', resolved_market_code: null, method: 'brn_map' },
    { prospect_id: 'p1', resolved_market_code: 'TPA_MKT', method: 'zip_lookup' },
  ];
  const got = branchFirstByProspect(rows).get('p1');
  assert.equal(got.market_code, 'TPA_MKT');
});

test('a prospect with only null market codes is absent, so the caller falls back', () => {
  const out = branchFirstByProspect([{ prospect_id: 'p1', resolved_market_code: null, method: 'brn_map' }]);
  assert.equal(out.has('p1'), false);
});

test('branchFirst: empty and nullish input are safe', () => {
  assert.equal(branchFirstByProspect([]).size, 0);
  assert.equal(branchFirstByProspect(null).size, 0);
  assert.equal(branchFirstByProspect(undefined).size, 0);
});

// THE REGRESSION GUARD, branch side. This is the quieter of the two failures:
// the prospect resolves to a real market by a real rule, just the wrong one.
test('TRUNCATION CHANGES THE ANSWER — a dropped brn_map row silently downgrades to zip', () => {
  const complete = [
    { prospect_id: 'p1', resolved_market_code: 'TPA_MKT', method: 'zip_lookup' },
    { prospect_id: 'p1', resolved_market_code: 'ORL_MKT', method: 'brn_map' }, // past the cap
  ];
  const truncated = complete.slice(0, 1);
  assert.equal(branchFirstByProspect(complete).get('p1').method, 'brn_map');
  assert.equal(branchFirstByProspect(complete).get('p1').market_code, 'ORL_MKT');
  assert.equal(branchFirstByProspect(truncated).get('p1').method, 'zip_lookup');
  assert.equal(branchFirstByProspect(truncated).get('p1').market_code, 'TPA_MKT');
});
