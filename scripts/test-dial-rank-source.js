import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDialRanks, _resetDialRankCache } from '../src/capacity/dialRankSource.js';

const liveLists = [
  { name: 'Data - Hot - FTM less than 7', dialingPriority: 1 },
  { name: 'Data - Hot - SAR less than 7', dialingPriority: 2 },
  { name: 'Data - Hot - JAX less than 7', dialingPriority: 3 },
  { name: 'Data - Hot - STP less than 7', dialingPriority: 4 },
  { name: 'Data - Hot - ORL less than 7', dialingPriority: 5 },
  { name: 'Data - Hot - LKE less than 7', dialingPriority: 6 },
  { name: 'Data - Hot - FTL less than 7', dialingPriority: 7 },
  { name: 'Data - Hot - Unmapped',        dialingPriority: 8 },
];

// 2026-09-28 — Lakeland merged into Orlando. The LKE list is still attached
// live until the approval-gated detach runs, so it stays in the fixture: it is
// now a NON-market list and must never be given a rank or a LAKE_MKT badge.
test('ranks the six markets 1..6 and ignores non-market lists (LKE included)', async () => {
  _resetDialRankCache();
  const r = await getDialRanks({ getCampaign: async () => ({ lists: liveLists }), log: () => {} });
  assert.deepEqual(r.ranks, {
    FTMYR_MKT: 1, SAR_MKT: 2, JAX_MKT: 3, STPET_MKT: 4,
    ORL_MKT: 5, FTLAU_MKT: 6,
  });
  assert.equal('LAKE_MKT' in r.ranks, false, 'no Lakeland badge after the merge');
  assert.equal(Object.values(r.ranks).includes(7), false);
});

test('gapped Five9 priorities still print 1..6', async () => {
  _resetDialRankCache();
  const gapped = liveLists.slice(0, 7).map((l, i) => ({ ...l, dialingPriority: (i + 1) * 10 }));
  const r = await getDialRanks({ getCampaign: async () => ({ lists: gapped }), log: () => {} });
  assert.deepEqual(Object.values(r.ranks).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test('a Five9 failure returns empty ranks and does not throw', async () => {
  _resetDialRankCache();
  const r = await getDialRanks({ getCampaign: async () => { throw new Error('SOAP down'); }, log: () => {} });
  assert.deepEqual(r.ranks, {});
  assert.match(r.error, /SOAP down/);
});

test('a later failure keeps the last good ranks', async () => {
  _resetDialRankCache();
  await getDialRanks({ getCampaign: async () => ({ lists: liveLists }), log: () => {} });
  const r = await getDialRanks({
    now: Date.now() + 10 * 60 * 1000,
    getCampaign: async () => { throw new Error('SOAP down'); },
    log: () => {},
  });
  assert.equal(r.ranks.FTMYR_MKT, 1);
});

test('the read is cached inside the TTL', async () => {
  _resetDialRankCache();
  let calls = 0;
  const getCampaign = async () => { calls += 1; return { lists: liveLists }; };
  await getDialRanks({ getCampaign, log: () => {} });
  await getDialRanks({ getCampaign, log: () => {} });
  assert.equal(calls, 1);
});
