// node --test — proportional-split allocator + zip market resolver invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateProportional } from '../src/jobs/scorecard-market-backfill.js';
import { normalizeZip5, resolveMarket } from '../src/jobs/market-resolver.js';

test('allocateProportional always sums to round(total)', () => {
  const cases = [
    [100, [1, 1, 1]],
    [2420395, [711768, 1047063, 661564]],
    [500, [0, 0, 0]],          // no basis, non-zero total → even split, still sums
    [0, [3, 2, 1]],            // zero total → all zero
    [97, [5]],
    [459, [146, 66, 58, 54, 43, 20, 72]],
    [28748025, [8190000, 7360000, 4020000, 3180000, 2360000, 1080000, 2558025]],
  ];
  for (const [total, shares] of cases) {
    const out = allocateProportional(total, shares);
    assert.equal(out.length, shares.length);
    assert.ok(out.every((x) => Number.isInteger(x) && x >= 0), `non-neg ints for ${total}`);
    assert.equal(out.reduce((a, b) => a + b, 0), Math.round(total), `sum == total for ${total}`);
  }
});

test('allocateProportional preserves proportional shares when exact', () => {
  assert.deepEqual(allocateProportional(2420395, [711768, 1047063, 661564]), [711768, 1047063, 661564]);
});

test('normalizeZip5 strips ZIP+4 and whitespace', () => {
  assert.equal(normalizeZip5('32824  '), '32824');
  assert.equal(normalizeZip5('33101-1234'), '33101');
  assert.equal(normalizeZip5(''), null);
  assert.equal(normalizeZip5(null), null);
  assert.equal(normalizeZip5('abc'), null);
});

test('resolveMarket routes zip → *_MKT / OUT_OF_AREA / UNASSIGNED', () => {
  const zipMap = new Map([['33009', 'BOCA'], ['33701', 'STPET'], ['99999', 'GENERAL']]);
  const branchMap = new Map([['BOCA', 'FTLAU_MKT'], ['STPET', 'STPET_MKT']]);
  assert.equal(resolveMarket('33009', { zipMap, branchMap }).market_code, 'FTLAU_MKT');
  assert.equal(resolveMarket('33701', { zipMap, branchMap }).method, 'zip_lookup');
  assert.equal(resolveMarket('00000', { zipMap, branchMap }).market_code, 'OUT_OF_AREA'); // valid zip, not in territory
  assert.equal(resolveMarket('', { zipMap, branchMap }).market_code, 'UNASSIGNED');        // no address
  assert.equal(resolveMarket('99999', { zipMap, branchMap }).method, 'unmapped_branch');   // GENERAL → UNASSIGNED
});
