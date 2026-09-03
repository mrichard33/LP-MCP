/**
 * test-capacity-ranker.js — capacity-driven Five9 list priority ranker.
 *
 * THE RULE UNDER TEST: Lakeland on 2026-09-04 read 0.0 % filled (0 of 2
 * requested) with 3 appointments already pending — open_true = -1. A naive
 * fill-% sort ranks it FIRST and points the whole floor at a market with
 * nothing to sell. It must rank LAST. Fort Myers (1/43, 39 truly open) ranks
 * first.
 *
 * Pure — no Supabase, no Five9, no network. Every I/O seam is injected.
 * Run: node --test scripts/test-capacity-ranker.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rankMarkets,
  isMaterialChange,
  MARKET_CODES,
} from '../src/capacity/rankMarkets.js';
import {
  computeListBlock,
  verifyListOrder,
  applyDialPriority,
  MARKET_LISTS,
  CAMPAIGNS,
} from '../src/capacity/applyDialPriority.js';
import {
  runCapacityRanker,
  resolveMode,
  resolveSwapMargin,
  addDays,
  MissingTableError,
} from '../src/routes/capacityRanker.js';

// ─── Fixture: GET /board/capacity?date=2026-09-04, live 2026-09-03 12:48 ET ──
// (the HANDOFF worked example; STPET read 6/29 by 17:01 UTC — LP data moves)
const FIXTURE_2026_09_04 = [
  { market: 'FTLAU_MKT', requested: 7,  confirmed: 1,  set_pending: 2 },
  { market: 'FTMYR_MKT', requested: 43, confirmed: 1,  set_pending: 3 },
  { market: 'JAX_MKT',   requested: 21, confirmed: 4,  set_pending: 8 },
  { market: 'LAKE_MKT',  requested: 2,  confirmed: 0,  set_pending: 3 },
  { market: 'ORL_MKT',   requested: 27, confirmed: 11, set_pending: 3 },
  { market: 'SAR_MKT',   requested: 19, confirmed: 4,  set_pending: 1 },
  { market: 'STPET_MKT', requested: 30, confirmed: 6,  set_pending: 7 },
];

const byMarket = (ranking) => Object.fromEntries(ranking.map((r) => [r.market, r]));

// ─── rankMarkets ─────────────────────────────────────────────────────────────

test('2026-09-04 fixture: FTMYR_MKT ranks first, LAKE_MKT ranks LAST (not first)', () => {
  const { ranking, unknown } = rankMarkets(FIXTURE_2026_09_04);
  assert.equal(unknown.length, 0, 'every market filed capacity');
  assert.equal(ranking.length, 7);
  assert.equal(ranking[0].market, 'FTMYR_MKT', 'Fort Myers 1/43 is priority 1');
  assert.equal(ranking[0].rank, 1);
  assert.equal(ranking[ranking.length - 1].market, 'LAKE_MKT', 'Lakeland ranks last');
  assert.equal(ranking[ranking.length - 1].rank, 7);
  assert.notEqual(ranking[0].market, 'LAKE_MKT', 'Lakeland must NEVER be priority 1');
});

test('2026-09-04 fixture: full order matches the handoff worked example', () => {
  const { ranking } = rankMarkets(FIXTURE_2026_09_04);
  assert.deepEqual(
    ranking.map((r) => r.market),
    ['FTMYR_MKT', 'FTLAU_MKT', 'JAX_MKT', 'STPET_MKT', 'SAR_MKT', 'ORL_MKT', 'LAKE_MKT'],
  );
});

test('2026-09-04 fixture: Lakeland carries BOTH oversold and small_denominator, open_true = -1', () => {
  const m = byMarket(rankMarkets(FIXTURE_2026_09_04).ranking);
  assert.equal(m.LAKE_MKT.fill_pct, 0);
  assert.equal(m.LAKE_MKT.open_true, -1);
  assert.equal(m.LAKE_MKT.oversold, true);
  assert.equal(m.LAKE_MKT.small_denominator, true);
  assert.deepEqual(m.LAKE_MKT.flags, ['oversold', 'small_denominator']);
  // and no other market is flagged
  for (const code of MARKET_CODES.filter((c) => c !== 'LAKE_MKT')) {
    assert.deepEqual(m[code].flags, [], `${code} is unflagged`);
  }
});

test('2026-09-04 fixture: fill % and open_true per market match the handoff table', () => {
  const m = byMarket(rankMarkets(FIXTURE_2026_09_04).ranking);
  assert.equal(m.FTMYR_MKT.fill_pct, 2.3);  assert.equal(m.FTMYR_MKT.open_true, 39);
  assert.equal(m.FTLAU_MKT.fill_pct, 14.3); assert.equal(m.FTLAU_MKT.open_true, 4);
  assert.equal(m.JAX_MKT.fill_pct, 19.0);   assert.equal(m.JAX_MKT.open_true, 9);
  assert.equal(m.STPET_MKT.fill_pct, 20.0); assert.equal(m.STPET_MKT.open_true, 17);
  assert.equal(m.SAR_MKT.fill_pct, 21.1);   assert.equal(m.SAR_MKT.open_true, 14);
  assert.equal(m.ORL_MKT.fill_pct, 40.7);   assert.equal(m.ORL_MKT.open_true, 13);
});

test('UNKNOWN fail-open: requested = 0 lands in unknown[] and is absent from ranking[]', () => {
  const rows = FIXTURE_2026_09_04.map((r) => (r.market === 'SAR_MKT' ? { ...r, requested: 0, confirmed: 0, set_pending: 0 } : r));
  const { ranking, unknown } = rankMarkets(rows);
  assert.deepEqual(unknown.map((u) => u.market), ['SAR_MKT']);
  assert.equal(unknown[0].reason, 'requested_zero');
  assert.ok(!ranking.some((r) => r.market === 'SAR_MKT'), 'not in ranking');
  assert.equal(ranking.length, 6);
  assert.equal(ranking[0].market, 'FTMYR_MKT');
});

test('UNKNOWN fail-open: a market with NO capacity row lands in unknown[] with no_capacity_row', () => {
  const rows = FIXTURE_2026_09_04.filter((r) => r.market !== 'JAX_MKT');
  const { ranking, unknown } = rankMarkets(rows);
  assert.deepEqual(unknown, [{ market: 'JAX_MKT', reason: 'no_capacity_row' }]);
  assert.ok(!ranking.some((r) => r.market === 'JAX_MKT'));
  assert.notEqual(ranking[0].market, 'JAX_MKT', 'an unknown market is never priority 1');
});

test('UNKNOWN: a market code outside the seven is surfaced as unmapped_market, never ranked', () => {
  const rows = [...FIXTURE_2026_09_04, { market: 'TPA_MKT', requested: 10, confirmed: 0, set_pending: 0 }];
  const { ranking, unknown } = rankMarkets(rows);
  assert.ok(!ranking.some((r) => r.market === 'TPA_MKT'));
  assert.deepEqual(unknown.map((u) => [u.market, u.reason]), [['TPA_MKT', 'unmapped_market']]);
});

test('SMALL DENOMINATOR: requested < 4 ranks after every normal market, before oversold', () => {
  const rows = [
    { market: 'ORL_MKT',   requested: 27, confirmed: 20, set_pending: 3 },   // 74 %, normal
    { market: 'FTLAU_MKT', requested: 3,  confirmed: 0,  set_pending: 0 },   // 0 %, small
    { market: 'JAX_MKT',   requested: 21, confirmed: 4,  set_pending: 8 },   // 19 %, normal
    { market: 'LAKE_MKT',  requested: 10, confirmed: 5,  set_pending: 6 },   // 50 %, oversold (open -1)
  ];
  const { ranking } = rankMarkets(rows);
  assert.deepEqual(ranking.map((r) => r.market), ['JAX_MKT', 'ORL_MKT', 'FTLAU_MKT', 'LAKE_MKT']);
  const m = byMarket(ranking);
  assert.deepEqual(m.FTLAU_MKT.flags, ['small_denominator']);
  assert.deepEqual(m.LAKE_MKT.flags, ['oversold']);
});

test('OVERSOLD: open_true = 0 counts as full (<= 0), ranks last even at 0 % fill', () => {
  const rows = [
    { market: 'ORL_MKT', requested: 10, confirmed: 9, set_pending: 0 },   // 90 %, open 1
    { market: 'SAR_MKT', requested: 10, confirmed: 0, set_pending: 10 },  // 0 %, open 0
  ];
  const { ranking } = rankMarkets(rows);
  assert.deepEqual(ranking.map((r) => r.market), ['ORL_MKT', 'SAR_MKT']);
  assert.equal(byMarket(ranking).SAR_MKT.open_true, 0);
  assert.equal(byMarket(ranking).SAR_MKT.oversold, true);
});

test('ranking is deterministic on ties (same fill % → more open slots first, then code)', () => {
  const rows = [
    { market: 'SAR_MKT', requested: 10, confirmed: 2, set_pending: 5 }, // 20 %, open 3
    { market: 'JAX_MKT', requested: 20, confirmed: 4, set_pending: 2 }, // 20 %, open 14
  ];
  assert.deepEqual(rankMarkets(rows).ranking.map((r) => r.market), ['JAX_MKT', 'SAR_MKT']);
});

// ─── isMaterialChange ────────────────────────────────────────────────────────

test('material change: no prior applied ranking is material', () => {
  const next = rankMarkets(FIXTURE_2026_09_04);
  const r = isMaterialChange(null, next);
  assert.equal(r.changed, true);
  assert.deepEqual(r.reasons, ['no_prior_applied_ranking']);
});

test('material change: identical ranking is NOT a change', () => {
  const a = rankMarkets(FIXTURE_2026_09_04);
  const b = rankMarkets(FIXTURE_2026_09_04);
  assert.equal(isMaterialChange(a, b).changed, false);
});

test('material change: a rank swap under the margin (SAR 21.1 vs STPET 20.0) is NOT material', () => {
  const prev = rankMarkets(FIXTURE_2026_09_04);
  // Nudge SAR under STPET without crossing 5 points: 3/19 = 15.8 % (gap 4.2)
  const rows = FIXTURE_2026_09_04.map((r) => (r.market === 'SAR_MKT' ? { ...r, confirmed: 3 } : r));
  const next = rankMarkets(rows);
  assert.equal(next.ranking.findIndex((r) => r.market === 'SAR_MKT') < next.ranking.findIndex((r) => r.market === 'STPET_MKT'), true, 'they did swap');
  assert.equal(isMaterialChange(prev, next).changed, false);
});

test('material change: a rank swap at or over the margin IS material', () => {
  const prev = rankMarkets(FIXTURE_2026_09_04);
  // ORL drops to 2/27 = 7.4 % — jumps over FTLAU (14.3), JAX, STPET, SAR
  const rows = FIXTURE_2026_09_04.map((r) => (r.market === 'ORL_MKT' ? { ...r, confirmed: 2 } : r));
  const r = isMaterialChange(prev, rankMarkets(rows));
  assert.equal(r.changed, true);
  assert.ok(r.reasons.some((s) => s.includes('rank swap')), r.reasons.join('; '));
});

test('material change: margin is configurable (a 4.2-point swap is material at margin 4)', () => {
  const prev = rankMarkets(FIXTURE_2026_09_04);
  const rows = FIXTURE_2026_09_04.map((r) => (r.market === 'SAR_MKT' ? { ...r, confirmed: 3 } : r));
  assert.equal(isMaterialChange(prev, rankMarkets(rows), { swapMargin: 4 }).changed, true);
});

test('material change: a market changing oversold state is material regardless of rank', () => {
  const prev = rankMarkets(FIXTURE_2026_09_04);
  // Lakeland pending drops 3 → 1: open_true = 1, no longer oversold (still small)
  const rows = FIXTURE_2026_09_04.map((r) => (r.market === 'LAKE_MKT' ? { ...r, set_pending: 1 } : r));
  const r = isMaterialChange(prev, rankMarkets(rows));
  assert.equal(r.changed, true);
  assert.ok(r.reasons.some((s) => s.includes('LAKE_MKT: oversold true → false')), r.reasons.join('; '));
});

test('material change: a market becoming UNKNOWN is material', () => {
  const prev = rankMarkets(FIXTURE_2026_09_04);
  const next = rankMarkets(FIXTURE_2026_09_04.filter((r) => r.market !== 'SAR_MKT'));
  const r = isMaterialChange(prev, next);
  assert.equal(r.changed, true);
  assert.ok(r.reasons.some((s) => s.includes('SAR_MKT: unknown false → true')));
});

// ─── computeListBlock (reorder only) ─────────────────────────────────────────

// Both campaigns exactly as read live 2026-09-03 (getOutboundCampaign shape).
const LIVE_HOT_LISTS = [
  { name: 'Data - Hot - FTL less than 7', priority: 1, dialingPriority: 1, dialingRatio: 1 },
  { name: 'Data - Hot - FTM less than 7', priority: 2, dialingPriority: 1, dialingRatio: 1 },
  { name: 'Data - Hot - JAX less than 7', priority: 3, dialingPriority: 1, dialingRatio: 1 },
  { name: 'Data - Hot - LKE less than 7', priority: 4, dialingPriority: 1, dialingRatio: 1 },
  { name: 'Data - Hot - ORL less than 7', priority: 5, dialingPriority: 1, dialingRatio: 1 },
  { name: 'Data - Hot - SAR less than 7', priority: 6, dialingPriority: 1, dialingRatio: 1 },
  { name: 'Data - Hot - STP less than 7', priority: 7, dialingPriority: 1, dialingRatio: 1 },
  { name: 'Data - Hot - Unmapped',        priority: 8, dialingPriority: 2, dialingRatio: 1 },
];
const LIVE_WARM_LISTS = LIVE_HOT_LISTS.map((l) => ({
  ...l, name: l.name.replace('Hot', 'Warm').replace('less than 7', 'less than 30'),
}));

test('mapping: the 14 market list names match what is attached to both campaigns live', () => {
  const hot = new Set(LIVE_HOT_LISTS.map((l) => l.name));
  const warm = new Set(LIVE_WARM_LISTS.map((l) => l.name));
  for (const code of MARKET_CODES) {
    assert.ok(hot.has(MARKET_LISTS[code].hot), `${code} hot list attached`);
    assert.ok(warm.has(MARKET_LISTS[code].warm), `${code} warm list attached`);
  }
  assert.equal(Object.keys(MARKET_LISTS).length, 7, 'seven markets — no Tampa');
  assert.ok(!Object.keys(MARKET_LISTS).some((c) => /TPA|TAMPA/i.test(c)));
});

test('computeListBlock: rank → dialingPriority, Lakeland dials last among markets, Unmapped pinned after', () => {
  const rank = rankMarkets(FIXTURE_2026_09_04);
  const block = computeListBlock(LIVE_HOT_LISTS, rank, 'hot');
  assert.equal(block.intended['Data - Hot - FTM less than 7'], 1);
  assert.equal(block.intended['Data - Hot - FTL less than 7'], 2);
  assert.equal(block.intended['Data - Hot - JAX less than 7'], 3);
  assert.equal(block.intended['Data - Hot - STP less than 7'], 4);
  assert.equal(block.intended['Data - Hot - SAR less than 7'], 5);
  assert.equal(block.intended['Data - Hot - ORL less than 7'], 6);
  assert.equal(block.intended['Data - Hot - LKE less than 7'], 7);
  assert.equal(block.intended['Data - Hot - Unmapped'], 8, 'non-market list pinned to the highest number');
  assert.deepEqual(block.pinned, ['Data - Hot - Unmapped']);
  assert.deepEqual(block.skipped, []);
  assert.equal(block.changed, true);
});

test('computeListBlock: REORDER ONLY — every attached list is resubmitted, none dropped or added, priority/ratio untouched', () => {
  const block = computeListBlock(LIVE_WARM_LISTS, rankMarkets(FIXTURE_2026_09_04), 'warm');
  assert.deepEqual(block.lists.map((l) => l.name), LIVE_WARM_LISTS.map((l) => l.name), 'same lists, same order as read');
  for (let i = 0; i < block.lists.length; i += 1) {
    assert.equal(block.lists[i].priority, LIVE_WARM_LISTS[i].priority, 'priority carried as read');
    assert.equal(block.lists[i].dialingRatio, LIVE_WARM_LISTS[i].dialingRatio, 'dialingRatio carried as read');
  }
});

test('computeListBlock: a missing market list is skipped and logged — never created', () => {
  const lists = LIVE_HOT_LISTS.filter((l) => l.name !== 'Data - Hot - JAX less than 7');
  const block = computeListBlock(lists, rankMarkets(FIXTURE_2026_09_04), 'hot');
  assert.deepEqual(block.skipped, [{ market: 'JAX_MKT', list: 'Data - Hot - JAX less than 7', reason: 'list_not_attached' }]);
  assert.ok(!block.lists.some((l) => l.name === 'Data - Hot - JAX less than 7'), 'not added');
  assert.equal(block.lists.length, lists.length);
});

test('computeListBlock: an UNKNOWN market\'s list still dials — after ranked markets, never priority 1', () => {
  const rows = FIXTURE_2026_09_04.map((r) => (r.market === 'SAR_MKT' ? { ...r, requested: 0, confirmed: 0, set_pending: 0 } : r));
  const block = computeListBlock(LIVE_HOT_LISTS, rankMarkets(rows), 'hot');
  const sar = block.intended['Data - Hot - SAR less than 7'];
  assert.ok(sar > 1, 'never priority 1');
  assert.equal(sar, 7, 'after the six ranked markets');
  assert.equal(block.intended['Data - Hot - Unmapped'], 8, 'pinned list still last');
  assert.deepEqual(block.unknown_lists, ['Data - Hot - SAR less than 7']);
});

test('computeListBlock: legacy statewide lists, if attached, are pinned last and never reordered', () => {
  const lists = [
    ...LIVE_HOT_LISTS,
    { name: 'Data - Hot Leads less than 7', priority: 9, dialingPriority: 3, dialingRatio: 1 },
  ];
  const block = computeListBlock(lists, rankMarkets(FIXTURE_2026_09_04), 'hot');
  assert.equal(block.intended['Data - Hot Leads less than 7'], 8);
  assert.equal(block.intended['Data - Hot - Unmapped'], 8, 'all non-market lists share the last number');
  assert.deepEqual(block.pinned, ['Data - Hot - Unmapped', 'Data - Hot Leads less than 7']);
});

test('computeListBlock: changed=false when the attached order already matches', () => {
  const rank = rankMarkets(FIXTURE_2026_09_04);
  const first = computeListBlock(LIVE_HOT_LISTS, rank, 'hot');
  const second = computeListBlock(first.lists, rank, 'hot');
  assert.equal(second.changed, false);
});

test('verifyListOrder: reports mismatches, empty when read-back matches', () => {
  const intended = { A: 1, B: 2 };
  assert.deepEqual(verifyListOrder(intended, [{ name: 'A', dialingPriority: 1 }, { name: 'B', dialingPriority: 2 }]), []);
  assert.deepEqual(verifyListOrder(intended, [{ name: 'A', dialingPriority: 1 }, { name: 'B', dialingPriority: 1 }]), [{ list: 'B', expected: 2, actual: 1 }]);
  assert.deepEqual(verifyListOrder(intended, [{ name: 'A', dialingPriority: 1 }]), [{ list: 'B', expected: 2, actual: null }]);
});

// ─── applyDialPriority (fake Five9) ──────────────────────────────────────────

function fakeFive9({ writesEnabled = true, applyWrites = true, refuse = null } = {}) {
  const state = {
    [CAMPAIGNS.hot]: LIVE_HOT_LISTS.map((l) => ({ ...l })),
    [CAMPAIGNS.warm]: LIVE_WARM_LISTS.map((l) => ({ ...l })),
  };
  const writes = [];
  return {
    state,
    writes,
    deps: {
      five9WritesEnabled: () => writesEnabled,
      getOutboundCampaign: async (name) => (state[name] ? { name, state: 'RUNNING', lists: state[name].map((l) => ({ ...l })) } : { name, error: 'campaign_not_found' }),
      modifyCampaignLists: async (action) => {
        const p = action.action_payload;
        writes.push(action);
        assert.equal(action.requires_approval, true);
        assert.equal(p.confirm_token, p.campaign_name, 'confirm_token restates the campaign');
        if (refuse) throw new Error(refuse);
        if (!writesEnabled) return { campaign: p.campaign_name, method: 'modifyCampaignLists', previewed: true, dry_run: true };
        if (applyWrites) state[p.campaign_name] = p.lists.map((l) => ({ ...l }));
        return { campaign: p.campaign_name, method: 'modifyCampaignLists' };
      },
    },
  };
}

test('applyDialPriority: writes both campaigns, reads back, applied=true when the order matches', async () => {
  const f = fakeFive9();
  const out = await applyDialPriority(rankMarkets(FIXTURE_2026_09_04), { ...f.deps, log: () => {} });
  assert.equal(out.applied, true);
  assert.equal(out.dry_run, false);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes.map((w) => w.action_payload.campaign_name), [CAMPAIGNS.hot, CAMPAIGNS.warm]);
  assert.equal(f.writes[0].action_type, 'five9_modify_campaign_lists');
  // reorder only: the same 8 lists went out on each campaign
  assert.equal(f.writes[0].action_payload.lists.length, 8);
  assert.equal(f.state[CAMPAIGNS.hot].find((l) => l.name === 'Data - Hot - LKE less than 7').dialingPriority, 7);
  assert.equal(f.state[CAMPAIGNS.warm].find((l) => l.name === 'Data - Warm - FTM less than 30').dialingPriority, 1);
  assert.equal(out.campaigns.hot.verified, true);
  assert.equal(out.campaigns.warm.verified, true);
});

test('applyDialPriority: read-back mismatch throws, applied stays false, no retry', async () => {
  const f = fakeFive9({ applyWrites: false }); // Five9 "accepts" but nothing changes
  await assert.rejects(
    applyDialPriority(rankMarkets(FIXTURE_2026_09_04), { ...f.deps, log: () => {} }),
    /read-back order does not match intent.*not retrying/,
  );
  assert.equal(f.writes.length, 1, 'stopped at the first mismatch — no retry, no second campaign');
});

test('applyDialPriority: FIVE9_WRITES_ENABLED off → dry-run, applied=false, no read-back assertion', async () => {
  const f = fakeFive9({ writesEnabled: false });
  const out = await applyDialPriority(rankMarkets(FIXTURE_2026_09_04), { ...f.deps, log: () => {} });
  assert.equal(out.applied, false);
  assert.equal(out.dry_run, true);
  assert.equal(f.writes.length, 2, 'the gated op still ran (it previews the envelope)');
  assert.equal(f.state[CAMPAIGNS.hot][0].dialingPriority, 1, 'nothing changed');
});

test('applyDialPriority: a REFUSED write (e.g. campaign RUNNING) surfaces as a thrown error, not a retry', async () => {
  const f = fakeFive9({ refuse: 'REFUSED: modify_campaign_lists on a RUNNING campaign' });
  await assert.rejects(
    applyDialPriority(rankMarkets(FIXTURE_2026_09_04), { ...f.deps, log: () => {} }),
    /REFUSED.*RUNNING/,
  );
  assert.equal(f.writes.length, 1);
});

test('applyDialPriority: no write when the order already matches', async () => {
  const f = fakeFive9();
  const rank = rankMarkets(FIXTURE_2026_09_04);
  await applyDialPriority(rank, { ...f.deps, log: () => {} });
  const before = f.writes.length;
  const out = await applyDialPriority(rank, { ...f.deps, log: () => {} });
  assert.equal(f.writes.length, before, 'second run wrote nothing');
  assert.equal(out.applied, true, 'still reflects intent');
  assert.equal(out.campaigns.hot.changed, false);
});

// ─── runCapacityRanker (route orchestration, fake I/O) ───────────────────────

function fakeRun({ prev = null, mode = 'shadow', rows = FIXTURE_2026_09_04, applyImpl = null, insertImpl = null, stale = false } = {}) {
  const calls = { apply: 0, inserted: [] };
  const deps = {
    mode,
    swapMargin: 5,
    log: () => {},
    now: new Date('2026-09-03T16:48:00Z'), // 12:48 ET
    fetchCapacity: async () => ({ rows, stale, last_sweep_at: '2026-09-03T16:45:00Z' }),
    readLastApplied: async () => prev,
    insertLog: insertImpl || (async (row) => { calls.inserted.push(row); return 42; }),
    apply: applyImpl || (async () => { calls.apply += 1; return { applied: true, dry_run: false, campaigns: {} }; }),
  };
  return { deps, calls };
}

test('route: defaults slot_date to tomorrow in America/New_York', async () => {
  const { deps } = fakeRun();
  const { status, body } = await runCapacityRanker({}, deps);
  assert.equal(status, 200);
  assert.equal(body.slot_date, '2026-09-04');
});

test('route: rejects a malformed slot_date with 400', async () => {
  const { deps, calls } = fakeRun();
  const { status } = await runCapacityRanker({ slot_date: '09/04/2026' }, deps);
  assert.equal(status, 400);
  assert.equal(calls.inserted.length, 0);
});

test('route: SHADOW mode computes, logs one row, returns the ranking, and NEVER calls apply', async () => {
  const { deps, calls } = fakeRun({ mode: 'shadow' });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(status, 200);
  assert.equal(body.mode, 'shadow');
  assert.equal(body.changed, true, 'nothing applied yet, so the first ranking is material');
  assert.equal(body.applied, false);
  assert.equal(calls.apply, 0, 'shadow never writes to Five9');
  assert.equal(calls.inserted.length, 1);
  assert.equal(calls.inserted[0].applied, false);
  assert.equal(calls.inserted[0].mode, 'shadow');
  assert.equal(calls.inserted[0].slot_date, '2026-09-04');
  assert.equal(body.log_id, 42);
  assert.equal(body.ranking[0].market, 'FTMYR_MKT');
  assert.equal(body.ranking[0].rank, 1);
  assert.equal(body.ranking[6].market, 'LAKE_MKT');
  assert.deepEqual(body.ranking[6].flags, ['oversold', 'small_denominator']);
  assert.deepEqual(body.unknown, []);
  for (const r of body.ranking) {
    for (const k of ['market', 'rank', 'fill_pct', 'open_true', 'flags']) assert.ok(k in r, `ranking row carries ${k}`);
  }
});

test('route: LIVE mode with a material change applies and logs applied=true', async () => {
  const { deps, calls } = fakeRun({ mode: 'live' });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(status, 200);
  assert.equal(calls.apply, 1);
  assert.equal(body.applied, true);
  assert.equal(calls.inserted[0].applied, true);
});

test('route: LIVE mode with NO material change writes nothing, logs changed=false', async () => {
  const prev = rankMarkets(FIXTURE_2026_09_04);
  const { deps, calls } = fakeRun({ mode: 'live', prev: { id: 7, ran_at: 'x', slot_date: '2026-09-04', ...prev } });
  const { body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(body.changed, false);
  assert.equal(calls.apply, 0);
  assert.equal(calls.inserted[0].changed, false);
  assert.equal(calls.inserted[0].applied, false);
  assert.equal(body.compared_to.log_id, 7);
});

test('route: LIVE apply failure → applied=false, error logged, 500, row still inserted', async () => {
  const { deps, calls } = fakeRun({
    mode: 'live',
    applyImpl: async () => { throw new Error('Data - Hot Leads less than 7: read-back order does not match intent (not retrying)'); },
  });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(status, 500);
  assert.equal(body.applied, false);
  assert.match(body.error, /read-back/);
  assert.equal(calls.inserted.length, 1);
  assert.equal(calls.inserted[0].applied, false);
  assert.match(calls.inserted[0].error_message, /read-back/);
});

test('route: missing dial_priority_log table fails gracefully with a clear message', async () => {
  const { deps } = fakeRun({ insertImpl: async () => { throw new MissingTableError({ message: 'relation "dial_priority_log" does not exist' }); } });
  await assert.rejects(runCapacityRanker({ slot_date: '2026-09-04' }, deps), (err) => {
    assert.equal(err.status, 500);
    assert.match(err.message, /apply sql\/080_dial_priority_log\.sql/);
    return true;
  });
});

test('route: unmapped market codes from the source are reported in warnings and unknown[]', async () => {
  const rows = [...FIXTURE_2026_09_04, { market: 'TPA_MKT', requested: 5, confirmed: 0, set_pending: 0 }];
  const { deps } = fakeRun({ rows });
  const { body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.ok(body.warnings.some((w) => w.includes('TPA_MKT')));
  assert.ok(body.unknown.some((u) => u.market === 'TPA_MKT' && u.reason === 'unmapped_market'));
  assert.ok(!body.ranking.some((r) => r.market === 'TPA_MKT'));
});

test('route: a stale capacity source is flagged, not hidden', async () => {
  const { deps } = fakeRun({ stale: true });
  const { body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(body.source.stale, true);
  assert.ok(body.warnings.some((w) => /STALE/.test(w)));
});

// ─── env resolution ──────────────────────────────────────────────────────────

test('CAPACITY_RANKER_MODE: default shadow; only the literal "live" arms live mode', () => {
  assert.equal(resolveMode(undefined), 'shadow');
  assert.equal(resolveMode(''), 'shadow');
  assert.equal(resolveMode('LIVE'), 'live');
  assert.equal(resolveMode('live'), 'live');
  assert.equal(resolveMode('true'), 'shadow');
  assert.equal(resolveMode('on'), 'shadow');
});

test('CAPACITY_RANKER_SWAP_MARGIN: default 5, unparseable falls back', () => {
  assert.equal(resolveSwapMargin(undefined), 5);
  assert.equal(resolveSwapMargin('3'), 3);
  assert.equal(resolveSwapMargin('abc'), 5);
  assert.equal(resolveSwapMargin('-1'), 5);
});

test('addDays: pure calendar arithmetic across a month boundary', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
