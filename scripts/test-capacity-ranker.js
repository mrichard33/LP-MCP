/**
 * test-capacity-ranker.js — capacity-driven Five9 list priority ranker.
 *
 * THE RULE UNDER TEST (the user, 2026-10-15): markets are ranked on
 * confirmed ÷ requested from the Appointment Capacity board, LOWEST first.
 * Set / hopper appointments and appointments still needed play no part. An
 * exact tie breaks on the market conversion ranking (perf_multiplier), then
 * market code. Supersedes the open-slot scoring of 2026-09-05 and the
 * half-weight hopper of 2026-10-09.
 *
 * Pure — no Supabase, no Five9, no network. Every I/O seam is injected.
 * Run: node --test scripts/test-capacity-ranker.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rankMarkets,
  isMaterialChange,
  compareFill,
  MARKET_CODES,
  DEFAULT_SWAP_MARGIN,
} from '../src/capacity/rankMarkets.js';
import {
  computeListBlock,
  verifyListOrder,
  applyDialPriority,
  MARKET_LISTS,
  CAMPAIGNS,
  isCycling,
  markCycling,
  clearCycling,
  _resetCycling,
  CYCLE_MARK_TTL_MS,
  DEFAULT_RESTART,
  restartBackoffMs,
  restartCampaignVerified,
  waitForStopSettle,
} from '../src/capacity/applyDialPriority.js';
import {
  runCapacityRanker,
  resolveMode,
  resolveSwapMargin,
  cycleEnabled,
  withinCycleWindow,
  withinWatchdogWindow,
  watchdogAlertKey,
  watchdogAlertText,
  checkCampaignState,
  readCampaignState,
  readLastRestartFailureLive,
  healCampaigns,
  todayET,
  endOfDayET,
  startOfDayET,
  healMaxPerDay,
  healStandDownKey,
  restartTuning,
  runLockTtlSec,
  addDays,
  MissingTableError,
} from '../src/routes/capacityRanker.js';
import {
  computeMultipliers,
  perfWindowStart,
  buildScorecardQuery,
  getMarketPerformance,
  _resetPerfCache,
  PERF_CLAMP,
  DEFAULT_PERF_WEIGHT,
  DEFAULT_PERF_MIN_SETS,
  DEFAULT_PERF_WINDOW_DAYS,
  PERF_MEMO_MS,
} from '../src/capacity/marketPerformance.js';

// ─── 2026-09-28: Lakeland merged into Orlando ────────────────────────────────
// MARKET_CODES is six now (sql/135_lake_orl_merge.sql). The fixtures below are
// REAL pre-merge boards — seven markets, with Lakeland as the small one — and
// they are the regression cover for the ranking RULES, which do not depend on
// which markets exist. So the pure-ranker tests run them against the market
// list that was live on those dates, passed explicitly. The post-merge default
// (six markets, ranks 1–6, no LAKE_MKT, no LKE list ever ranked) has its own
// "MERGE:" block further down.
//
// 2026-10-15: the ranking is confirmed ÷ requested only. These boards keep
// their real numbers; the hand-checked multipliers below were recorded at the
// old W 0.25 and now only break exact fill ties.
const PRE_MERGE_MARKETS = Object.freeze([...MARKET_CODES, 'LAKE_MKT']);
const OLD_PERF_WEIGHT = 0.25;
const rankPreMerge = (rows, opts = {}) => rankMarkets(rows, { markets: PRE_MERGE_MARKETS, ...opts });
const rankOld = (rows, opts = {}) => rankMarkets(rows, opts);

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

// ─── Fixture: the 2026-09-05 board ────────────────────────────────────────────
//
// History: Jacksonville (2 confirmed of 17, 14 in the hopper) ranked FIRST here
// under the first confirmed/requested sort, and the 2026-09-05 fix moved the
// ranker to hopper-weighted open slots. The user's ruling of 2026-10-15 brings
// confirmed ÷ requested back as the ONLY key, on purpose: the hopper is not
// confirmed capacity. The open-slot numbers in the comments are kept for
// reference only.
const FIXTURE_2026_09_05 = [
  { market: 'JAX_MKT',   requested: 17, confirmed: 2, set_pending: 14 }, // open  1
  { market: 'FTLAU_MKT', requested: 4,  confirmed: 2, set_pending: 4 },  // open -2 → oversold
  { market: 'ORL_MKT',   requested: 16, confirmed: 6, set_pending: 9 },  // open  1
  { market: 'LAKE_MKT',  requested: 2,  confirmed: 0, set_pending: 0 },  // open  2, small_denominator
  { market: 'STPET_MKT', requested: 20, confirmed: 5, set_pending: 8 },  // open  7
  { market: 'FTMYR_MKT', requested: 20, confirmed: 8, set_pending: 5 },  // open  7
  { market: 'SAR_MKT',   requested: 8,  confirmed: 2, set_pending: 2 },  // open  4
];

// Trailing-90d scorecard aggregate, verified against lp_market_scorecard_daily
// on 2026-09-04 (deduped by (market, period_start), latest as_of_date per
// period). Company baseline 1,197 / 8,885 = 13.47 %.
const SCORECARD_90D = [
  { market: 'ORL_MKT',   sets: 1178, sales: 188 }, // 16.0 %
  { market: 'SAR_MKT',   sets: 1213, sales: 191 }, // 15.7 %
  { market: 'FTMYR_MKT', sets: 2318, sales: 346 }, // 14.9 %
  { market: 'STPET_MKT', sets: 2084, sales: 282 }, // 13.5 %
  { market: 'LAKE_MKT',  sets: 232,  sales: 27 },  // 11.6 %
  { market: 'JAX_MKT',   sets: 1348, sales: 119 }, //  8.8 %
  { market: 'FTLAU_MKT', sets: 512,  sales: 44 },  //  8.6 %
];

/** The multipliers SCORECARD_90D produces at W=0.25 — the HANDOFF table. */
const PERF_2026_09_04 = computeMultipliers(SCORECARD_90D, { weight: OLD_PERF_WEIGHT });

// ─── Fixture: dial_priority_log #670, live 2026-10-15 11:15 ET, slots 10/16 ──
// The board the 2026-10-15 ruling was checked against. The old open-slot
// scoring ranked it FTMYR, ORL, JAX, STPET, FTLAU, SAR.
const FIXTURE_2026_10_16 = [
  { market: 'FTMYR_MKT', requested: 41, confirmed: 6,  set_pending: 4 },  // 14.6 %
  { market: 'ORL_MKT',   requested: 34, confirmed: 11, set_pending: 5 },  // 32.4 %
  { market: 'JAX_MKT',   requested: 22, confirmed: 0,  set_pending: 5 },  //  0 %
  { market: 'STPET_MKT', requested: 28, confirmed: 4,  set_pending: 11 }, // 14.3 %
  { market: 'FTLAU_MKT', requested: 11, confirmed: 1,  set_pending: 1 },  //  9.1 %
  { market: 'SAR_MKT',   requested: 15, confirmed: 10, set_pending: 2 },  // 66.7 %
];
/** Row #670's logged multipliers (W 0.125). */
const PERF_2026_10_15 = {
  FTMYR_MKT: { multiplier: 1.0160 }, ORL_MKT: { multiplier: 1.0085 }, JAX_MKT: { multiplier: 0.9575 },
  STPET_MKT: { multiplier: 0.9987 }, FTLAU_MKT: { multiplier: 0.9409 }, SAR_MKT: { multiplier: 1.0332 },
};

const byMarket = (ranking) => Object.fromEntries(ranking.map((r) => [r.market, r]));
const order = (ranking) => ranking.map((r) => r.market.replace('_MKT', ''));

// ─── rankMarkets: confirmed ÷ requested, lowest first (the user, 2026-10-15) ─

test('2026-10-15: the user\'s example — 1 of 10 (10 %) beats 11 of 20 (55 %) though both need 9', () => {
  const { ranking } = rankMarkets([
    { market: 'ORL_MKT', requested: 20, confirmed: 11, set_pending: 0 }, // Office B, 55 %
    { market: 'SAR_MKT', requested: 10, confirmed: 1,  set_pending: 0 }, // Office A, 10 %
  ]);
  const m = byMarket(ranking);
  assert.equal(m.SAR_MKT.still_needed, 9);
  assert.equal(m.ORL_MKT.still_needed, 9, 'both still need nine');
  assert.equal(m.SAR_MKT.fill_pct, 10);
  assert.equal(m.ORL_MKT.fill_pct, 55);
  assert.deepEqual(order(ranking), ['SAR', 'ORL']);
});

test('2026-10-15: appointments still needed never decide — 10 of 50 (20 %) ranks above 1 of 4 (25 %)', () => {
  const { ranking } = rankMarkets([
    { market: 'JAX_MKT', requested: 4,  confirmed: 1,  set_pending: 0 }, // 25 %, needs 3
    { market: 'FTMYR_MKT', requested: 50, confirmed: 10, set_pending: 0 }, // 20 %, needs 40
  ]);
  assert.deepEqual(order(ranking), ['FTMYR', 'JAX']);
  // and the other way round: a big office with MORE still needed but a higher % ranks below.
  const r2 = rankMarkets([
    { market: 'JAX_MKT', requested: 4,  confirmed: 0,  set_pending: 0 }, // 0 %, needs 4
    { market: 'FTMYR_MKT', requested: 50, confirmed: 5, set_pending: 0 }, // 10 %, needs 45
  ]);
  assert.deepEqual(order(r2.ranking), ['JAX', 'FTMYR']);
});

test('2026-10-15: Set / hopper appointments are ignored — a full hopper changes nothing', () => {
  const base = [
    { market: 'JAX_MKT', requested: 20, confirmed: 2, set_pending: 0 },  // 10 %
    { market: 'STPET_MKT', requested: 20, confirmed: 4, set_pending: 0 }, // 20 %
  ];
  const withHopper = base.map((r) => (r.market === 'JAX_MKT' ? { ...r, set_pending: 18 } : r));
  assert.deepEqual(order(rankMarkets(base).ranking), ['JAX', 'STPET']);
  const { ranking } = rankMarkets(withHopper);
  assert.deepEqual(order(ranking), ['JAX', 'STPET'], 'JAX stays first with 18 in the hopper');
  const m = byMarket(ranking);
  assert.equal(m.JAX_MKT.set_pending, 18, 'still reported for the board');
  assert.equal(m.JAX_MKT.oversold, false, 'the hopper cannot make a market oversold');
  assert.ok(!('open_true' in m.JAX_MKT), 'no hopper-weighted open slots any more');
  assert.ok(!('hopper_weight' in m.JAX_MKT));
});

test('2026-10-15: an EXACT tie (1/10 vs 2/20) breaks on conversion — the better converter first', () => {
  const rows = [
    { market: 'FTLAU_MKT', requested: 10, confirmed: 1, set_pending: 0 },
    { market: 'ORL_MKT',   requested: 20, confirmed: 2, set_pending: 9 },
  ];
  const performance = { FTLAU_MKT: { multiplier: 1.03, set_to_sale: 0.15 }, ORL_MKT: { multiplier: 0.97, set_to_sale: 0.11 } };
  assert.deepEqual(order(rankMarkets(rows, { performance }).ranking), ['FTLAU', 'ORL']);
  const flipped = { FTLAU_MKT: { multiplier: 0.97 }, ORL_MKT: { multiplier: 1.03 } };
  assert.deepEqual(order(rankMarkets(rows, { performance: flipped }).ranking), ['ORL', 'FTLAU']);
});

test('2026-10-15: an exact tie with no conversion data falls to market code — deterministic', () => {
  const rows = [
    { market: 'STPET_MKT', requested: 8,  confirmed: 2, set_pending: 0 }, // 25 %
    { market: 'SAR_MKT',   requested: 12, confirmed: 3, set_pending: 0 }, // 25 %
  ];
  const { ranking } = rankMarkets(rows);
  assert.deepEqual(order(ranking), ['SAR', 'STPET']);
  for (const r of ranking) assert.equal(r.perf_multiplier, 1);
});

test('2026-10-15: fill is compared exactly, never on the rounded fill_pct', () => {
  // 1/3 = 33.33… % and 333/1000 = 33.3 % both print 33.3, but they are not equal.
  const { ranking } = rankMarkets([
    { market: 'ORL_MKT', requested: 3,    confirmed: 1,   set_pending: 0 },
    { market: 'JAX_MKT', requested: 1000, confirmed: 333, set_pending: 0 },
  ], { performance: { ORL_MKT: { multiplier: 1.15 } } });
  const m = byMarket(ranking);
  assert.equal(m.ORL_MKT.fill_pct, m.JAX_MKT.fill_pct, 'same rounded number');
  assert.deepEqual(order(ranking), ['JAX', 'ORL'], '33.3 % exactly is lower than 33.33… %, conversion never consulted');
});

test('2026-10-15: conversion can NEVER beat a real % gap', () => {
  // 14.3 % vs 14.6 % (dial_priority_log #670: St. Pete 4/28, Fort Myers 6/41),
  // with the clamp's most extreme multipliers pulling the other way.
  const rows = [
    { market: 'FTMYR_MKT', requested: 41, confirmed: 6, set_pending: 4 },
    { market: 'STPET_MKT', requested: 28, confirmed: 4, set_pending: 11 },
  ];
  const performance = { FTMYR_MKT: { multiplier: 1.15 }, STPET_MKT: { multiplier: 0.85 } };
  assert.deepEqual(order(rankMarkets(rows, { performance }).ranking), ['STPET', 'FTMYR']);
});

test('2026-10-15: live row #670 (slots 10/16) — every market ranked, lowest confirmed % first', () => {
  const { ranking, unknown } = rankMarkets(FIXTURE_2026_10_16, { performance: PERF_2026_10_15 });
  assert.deepEqual(unknown, []);
  assert.deepEqual(ranking.map((r) => r.rank), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(order(ranking), ['JAX', 'FTLAU', 'STPET', 'FTMYR', 'ORL', 'SAR']);
  assert.deepEqual(ranking.map((r) => r.fill_pct), [0, 9.1, 14.3, 14.6, 32.4, 66.7]);
  // Under the old open-slot scoring this read FTMYR, ORL, JAX, STPET, FTLAU, SAR:
  // Fort Myers first on 35 open slots while 14.6 % filled, Jacksonville third at 0 %.
  for (let i = 1; i < ranking.length; i += 1) {
    assert.ok(compareFill(ranking[i - 1], ranking[i]) <= 0, `${ranking[i - 1].market} is no fuller than ${ranking[i].market}`);
  }
});

test('2026-10-15: score is the fill % — kept under the old name for log readers', () => {
  for (const r of rankMarkets(FIXTURE_2026_10_16).ranking) {
    assert.equal(r.score, r.fill_pct, r.market);
    assert.equal(r.still_needed, Math.max(0, r.requested - r.confirmed), r.market);
  }
});

test('2026-09-04 board (pre-merge): ranked by confirmed % alone — Lakeland 0 of 2 is now FIRST', () => {
  // The hopper (3 pending against 2 slots) no longer counts, so Lakeland is
  // simply 0 % filled. That is the user's rule: only confirmed fills capacity.
  const { ranking, unknown } = rankPreMerge(FIXTURE_2026_09_04);
  assert.equal(unknown.length, 0);
  assert.deepEqual(order(ranking), ['LAKE', 'FTMYR', 'FTLAU', 'JAX', 'STPET', 'SAR', 'ORL']);
  const m = byMarket(ranking);
  assert.equal(m.FTMYR_MKT.fill_pct, 2.3);
  assert.equal(m.FTLAU_MKT.fill_pct, 14.3);
  assert.equal(m.JAX_MKT.fill_pct, 19.0);
  assert.equal(m.STPET_MKT.fill_pct, 20.0);
  assert.equal(m.SAR_MKT.fill_pct, 21.1);
  assert.equal(m.ORL_MKT.fill_pct, 40.7);
  assert.deepEqual(m.LAKE_MKT.flags, ['small_denominator'], 'small, but no longer oversold');
});

test('2026-09-05 board (pre-merge): a 25 % tie between St. Pete and Sarasota breaks on conversion', () => {
  const { ranking } = rankPreMerge(FIXTURE_2026_09_05, { performance: PERF_2026_09_04 });
  assert.deepEqual(order(ranking), ['LAKE', 'JAX', 'SAR', 'STPET', 'ORL', 'FTMYR', 'FTLAU']);
  const m = byMarket(ranking);
  assert.equal(m.SAR_MKT.fill_pct, 25);
  assert.equal(m.STPET_MKT.fill_pct, 25);
  assert.ok(m.SAR_MKT.perf_multiplier > m.STPET_MKT.perf_multiplier, 'Sarasota converts at 15.7 %, St. Pete 13.5 %');
});

test('UNKNOWN fail-open: requested = 0 lands in unknown[] and is absent from ranking[]', () => {
  const rows = FIXTURE_2026_09_04.map((r) => (r.market === 'SAR_MKT' ? { ...r, requested: 0, confirmed: 0, set_pending: 0 } : r));
  const { ranking, unknown } = rankPreMerge(rows);
  assert.deepEqual(unknown.map((u) => u.market), ['SAR_MKT']);
  assert.equal(unknown[0].reason, 'requested_zero');
  assert.ok(!ranking.some((r) => r.market === 'SAR_MKT'), 'not in ranking');
  assert.equal(ranking.length, 6);
});

test('UNKNOWN fail-open: a market with NO capacity row lands in unknown[] with no_capacity_row', () => {
  const rows = FIXTURE_2026_09_04.filter((r) => r.market !== 'JAX_MKT');
  const { ranking, unknown } = rankPreMerge(rows);
  assert.deepEqual(unknown, [{ market: 'JAX_MKT', reason: 'no_capacity_row' }]);
  assert.ok(!ranking.some((r) => r.market === 'JAX_MKT'));
  assert.notEqual(ranking[0].market, 'JAX_MKT', 'an unknown market is never priority 1');
});

test('UNKNOWN: a market code outside the list is surfaced as unmapped_market, never ranked', () => {
  const rows = [...FIXTURE_2026_09_04, { market: 'TPA_MKT', requested: 10, confirmed: 0, set_pending: 0 }];
  const { ranking, unknown } = rankPreMerge(rows);
  assert.ok(!ranking.some((r) => r.market === 'TPA_MKT'));
  assert.deepEqual(unknown.map((u) => [u.market, u.reason]), [['TPA_MKT', 'unmapped_market']]);
});

test('SMALL DENOMINATOR: flagged for the board, ranked on its % like everyone else', () => {
  const rows = [
    { market: 'ORL_MKT',   requested: 27, confirmed: 20, set_pending: 3 }, // 74 %
    { market: 'FTLAU_MKT', requested: 3,  confirmed: 0,  set_pending: 0 }, // 0 %, small
    { market: 'JAX_MKT',   requested: 21, confirmed: 4,  set_pending: 8 }, // 19 %
  ];
  const { ranking } = rankMarkets(rows);
  assert.deepEqual(order(ranking), ['FTLAU', 'JAX', 'ORL']);
  assert.deepEqual(byMarket(ranking).FTLAU_MKT.flags, ['small_denominator']);
});

test('OVERSOLD: confirmed >= requested is flagged and sorts last on the % alone', () => {
  const rows = [
    { market: 'SAR_MKT', requested: 4,  confirmed: 5, set_pending: 0 },  // 125 %
    { market: 'ORL_MKT', requested: 10, confirmed: 9, set_pending: 0 },  // 90 %
    { market: 'JAX_MKT', requested: 10, confirmed: 10, set_pending: 0 }, // 100 %
  ];
  const { ranking } = rankMarkets(rows, { performance: { SAR_MKT: { multiplier: 1.15 } } });
  assert.deepEqual(order(ranking), ['ORL', 'JAX', 'SAR']);
  const m = byMarket(ranking);
  assert.equal(m.JAX_MKT.oversold, true);
  assert.equal(m.SAR_MKT.oversold, true);
  assert.equal(m.ORL_MKT.oversold, false);
  assert.equal(m.SAR_MKT.still_needed, 0, 'never negative');
});

test('no performance data at all → every multiplier 1.0, ranking still by %', () => {
  const { ranking } = rankMarkets(FIXTURE_2026_10_16);
  for (const r of ranking) assert.equal(r.perf_multiplier, 1);
  assert.deepEqual(order(ranking), ['JAX', 'FTLAU', 'STPET', 'FTMYR', 'ORL', 'SAR']);
});

// ─── marketPerformance: the multiplier itself ────────────────────────────────

test('computeMultipliers reproduces the verified 2026-09-04 handoff table at W=0.25', () => {
  const p = PERF_2026_09_04;
  // The handoff quotes multipliers computed off percentages already rounded to
  // one decimal, so it sits up to 0.0012 away from the exact arithmetic. Every
  // ORDERING relation the handoff asserts holds exactly; only the third
  // decimal drifts. Assert both: the exact value, and agreement with the table.
  const HANDOFF = {
    ORL_MKT: 1.047, SAR_MKT: 1.041, FTMYR_MKT: 1.026, STPET_MKT: 1.000,
    LAKE_MKT: 0.965, JAX_MKT: 0.913, FTLAU_MKT: 0.910,
  };
  const EXACT = {
    ORL_MKT: 1.046, SAR_MKT: 1.042, FTMYR_MKT: 1.027, STPET_MKT: 1.001,
    LAKE_MKT: 0.966, JAX_MKT: 0.914, FTLAU_MKT: 0.909,
  };
  for (const [code, want] of Object.entries(EXACT)) {
    assert.equal(Math.round(p[code].multiplier * 1000) / 1000, want, code);
    assert.ok(Math.abs(p[code].multiplier - HANDOFF[code]) < 0.002, `${code} agrees with the handoff table`);
  }
  // Ordering — the part that actually decides the dial list.
  const byMult = Object.entries(p).filter(([k]) => k !== '_company')
    .sort((a, b) => b[1].multiplier - a[1].multiplier).map(([k]) => k);
  assert.deepEqual(byMult, ['ORL_MKT', 'SAR_MKT', 'FTMYR_MKT', 'STPET_MKT', 'LAKE_MKT', 'JAX_MKT', 'FTLAU_MKT']);
  // set_to_sale, to the tenth of a point the handoff quotes
  const pct = (n) => Math.round(n * 1000) / 10;
  assert.equal(pct(p.ORL_MKT.set_to_sale),   16.0);
  assert.equal(pct(p.SAR_MKT.set_to_sale),   15.7);
  assert.equal(pct(p.FTMYR_MKT.set_to_sale), 14.9);
  assert.equal(pct(p.STPET_MKT.set_to_sale), 13.5);
  assert.equal(pct(p.LAKE_MKT.set_to_sale),  11.6);
  assert.equal(pct(p.JAX_MKT.set_to_sale),   8.8);
  assert.equal(pct(p.FTLAU_MKT.set_to_sale), 8.6);
});

test('computeMultipliers: company baseline is 1,197 / 8,885 = 13.5 %', () => {
  const p = computeMultipliers(SCORECARD_90D);
  assert.equal(Math.round(p._company.sets), 8885);
  assert.equal(Math.round(p._company.sales), 1197);
  assert.equal(Math.round(p._company.set_to_sale * 1000) / 10, 13.5);
});

test('a market with sets < 100 in the window gets multiplier EXACTLY 1.0 — never a penalty', () => {
  const rows = [...SCORECARD_90D, { market: 'TINY_MKT', sets: 99, sales: 0 }];
  const p = computeMultipliers(rows);
  // 0 sales of 99 sets is the worst possible conversion; it must NOT be punished.
  assert.equal(p.TINY_MKT.multiplier, 1, 'insufficient sample → exactly 1.0');
  assert.equal(p.TINY_MKT.insufficient_sample, true);
  assert.equal(p.TINY_MKT.sets, 99);
  // 100 sets is enough, and then the real (bad) number applies.
  const p2 = computeMultipliers([...SCORECARD_90D, { market: 'TINY_MKT', sets: 100, sales: 0 }]);
  assert.equal(p2.TINY_MKT.insufficient_sample, false);
  assert.ok(p2.TINY_MKT.multiplier < 1);
  assert.equal(DEFAULT_PERF_MIN_SETS, 100);
});

test('the clamp is ±0.15 and holds at ANY weight — capacity always dominates', () => {
  assert.equal(PERF_CLAMP, 0.15, 'DO NOT RAISE — see the handoff');
  for (const weight of [0.25, 1, 5, 100, -100]) {
    for (const p of Object.values(computeMultipliers(SCORECARD_90D, { weight }))) {
      if (p.multiplier === undefined) continue;
      assert.ok(p.multiplier >= 0.85 && p.multiplier <= 1.15, `weight ${weight} → ${p.multiplier}`);
    }
  }
});

test('at the old W=0.25 the real spread was 0.91–1.05 — enough to break ties, never to override', () => {
  const mults = Object.entries(PERF_2026_09_04)
    .filter(([k]) => !k.startsWith('_'))
    .map(([, v]) => v.multiplier);
  assert.ok(Math.min(...mults) > 0.90 && Math.min(...mults) < 0.92);
  assert.ok(Math.max(...mults) > 1.04 && Math.max(...mults) < 1.06);
});

test('computeMultipliers: a market with zero sets does not divide by zero', () => {
  const p = computeMultipliers([...SCORECARD_90D, { market: 'ZERO_MKT', sets: 0, sales: 0 }]);
  assert.equal(p.ZERO_MKT.multiplier, 1);
  assert.equal(p.ZERO_MKT.set_to_sale, 0);
});

test('the scorecard query dedupes with DISTINCT ON (market, period_start) ORDER BY as_of_date DESC', () => {
  const sql = buildScorecardQuery({ windowStart: '2026-06-01' });
  // The table re-ingests the same period repeatedly (month-to-date cumulative
  // snapshots). Summing raw rows multiplies the sets ~13x and every multiplier
  // computed off them is wrong.
  assert.match(sql, /DISTINCT ON \(market, period_start\)/);
  assert.match(sql, /ORDER BY market, period_start, as_of_date DESC/);
  assert.match(sql, /NOT IN \('REECE', 'OUT_OF_AREA', 'UNASSIGNED'\)/);
  assert.match(sql, /GROUP BY market/);
  assert.match(sql, /2026-06-01/);
});

test('perfWindowStart opens at the FIRST OF THE MONTH containing the cutoff', () => {
  // lp_market_scorecard_daily is month-grain: period_start is always the 1st.
  // A bare `period_start >= today - 90 days` cutoff (2026-06-06) is BEFORE no
  // June row and therefore silently drops the whole month — that is what made
  // the baseline read 12.5 % instead of the verified 13.5 %.
  assert.equal(perfWindowStart('2026-09-04', 90), '2026-06-01');
  assert.equal(perfWindowStart('2026-01-15', 90), '2025-10-01');
  assert.equal(perfWindowStart('2026-03-31', 30), '2026-03-01');
  assert.equal(DEFAULT_PERF_WINDOW_DAYS, 90);
});

test('getMarketPerformance memoises for 12 hours — performance does not move hourly', () => {
  _resetPerfCache();
  let queries = 0;
  const query = async () => { queries += 1; return SCORECARD_90D; };
  const t0 = Date.parse('2026-09-04T12:00:00Z');
  return (async () => {
    const a = await getMarketPerformance({ query, now: t0 });
    assert.equal(queries, 1);
    // 2026-10-09: default W is 0.125 (was 0.25 → 1.027).
    assert.equal(Math.round(a.FTMYR_MKT.multiplier * 1000) / 1000, 1.013);
    await getMarketPerformance({ query, now: t0 + 60 * 1000 });
    await getMarketPerformance({ query, now: t0 + PERF_MEMO_MS - 1 });
    assert.equal(queries, 1, 'still cached inside the 12h window');
    await getMarketPerformance({ query, now: t0 + PERF_MEMO_MS + 1 });
    assert.equal(queries, 2, 'recomputed once the window lapses');
    assert.equal(PERF_MEMO_MS, 12 * 60 * 60 * 1000);
  })();
});

test('getMarketPerformance FAILS OPEN: a query error yields 1.0 everywhere, never a crash', async () => {
  _resetPerfCache();
  const query = async () => { throw new Error('run_sql exploded'); };
  const warnings = [];
  const perf = await getMarketPerformance({ query, log: (m) => warnings.push(m) });
  assert.deepEqual(perf, {});
  // and rankMarkets on an empty table is still ranked by confirmed % — ties
  // fall to market code. Degraded, but still a sane dial list.
  const { ranking } = rankPreMerge(FIXTURE_2026_09_05, { performance: perf });
  assert.deepEqual(order(ranking), ['LAKE', 'JAX', 'SAR', 'STPET', 'ORL', 'FTMYR', 'FTLAU']);
  assert.ok(warnings.some((w) => /run_sql exploded/.test(w)), 'the failure is logged, not swallowed');
});

// ─── isMaterialChange (fill gap in percentage points, 2026-10-15) ────────────

test('material change: no prior applied ranking is material', () => {
  const r = isMaterialChange(null, rankMarkets(FIXTURE_2026_10_16));
  assert.equal(r.changed, true);
  assert.deepEqual(r.reasons, ['no_prior_applied_ranking']);
});

test('material change: identical ranking is NOT a change', () => {
  assert.equal(isMaterialChange(rankMarkets(FIXTURE_2026_10_16), rankMarkets(FIXTURE_2026_10_16)).changed, false);
});

test('material change: a swap made by the conversion tiebreak alone (0-point gap) is NOT material', () => {
  const rows = [
    { market: 'FTLAU_MKT', requested: 10, confirmed: 1, set_pending: 0 },
    { market: 'ORL_MKT',   requested: 20, confirmed: 2, set_pending: 0 },
  ];
  const prev = rankMarkets(rows, { performance: { FTLAU_MKT: { multiplier: 1.03 }, ORL_MKT: { multiplier: 0.97 } } });
  const next = rankMarkets(rows, { performance: { FTLAU_MKT: { multiplier: 0.97 }, ORL_MKT: { multiplier: 1.03 } } });
  assert.notDeepEqual(order(prev.ranking), order(next.ranking), 'they did swap');
  assert.equal(isMaterialChange(prev, next).changed, false, 'a refreshed multiplier must not re-point Five9');
});

test('material change: ANY real % difference that reorders IS material (14.3 % must dial ahead of 14.6 %)', () => {
  const prevRows = FIXTURE_2026_10_16.map((r) => (r.market === 'STPET_MKT' ? { ...r, confirmed: 5 } : r)); // STP 17.9 %
  const prev = rankMarkets(prevRows);
  const next = rankMarkets(FIXTURE_2026_10_16); // STP back to 14.3 %, now ahead of FTM 14.6 %
  assert.ok(byMarket(prev.ranking).FTMYR_MKT.rank < byMarket(prev.ranking).STPET_MKT.rank);
  assert.ok(byMarket(next.ranking).STPET_MKT.rank < byMarket(next.ranking).FTMYR_MKT.rank);
  const r = isMaterialChange(prev, next);
  assert.equal(r.changed, true);
  assert.ok(r.reasons.some((s) => /FTMYR_MKT\/STPET_MKT|STPET_MKT\/FTMYR_MKT/.test(s) && s.includes('0.3-point')), r.reasons.join('; '));
});

test('material change: the margin is configurable in percentage points', () => {
  const prev = rankMarkets(FIXTURE_2026_10_16.map((r) => (r.market === 'STPET_MKT' ? { ...r, confirmed: 5 } : r)));
  const next = rankMarkets(FIXTURE_2026_10_16);
  assert.equal(isMaterialChange(prev, next, { swapMargin: 0 }).changed, true);
  assert.equal(isMaterialChange(prev, next, { swapMargin: 1 }).changed, false, 'a 0.3-point swap under a 1-point margin');
});

test('material change: a row logged under the OLD open-slot scoring still compares', () => {
  // dial_priority_log #670 as it was written: open-slot order, with score and
  // open_true, and the retired starvation flag present on nobody.
  const prev = { ranking: [
    { market: 'FTMYR_MKT', rank: 1, score: 33.526, open_true: 33, fill_pct: 14.6, flags: [] },
    { market: 'ORL_MKT',   rank: 2, score: 20.673, open_true: 20.5, fill_pct: 32.4, flags: [] },
    { market: 'JAX_MKT',   rank: 3, score: 18.67, open_true: 19.5, fill_pct: 0, flags: [] },
    { market: 'STPET_MKT', rank: 4, score: 18.476, open_true: 18.5, fill_pct: 14.3, flags: [] },
    { market: 'FTLAU_MKT', rank: 5, score: 8.938, open_true: 9.5, fill_pct: 9.1, flags: [] },
    { market: 'SAR_MKT',   rank: 6, score: 4.133, open_true: 4, fill_pct: 66.7, flags: [] },
  ], unknown: [] };
  const r = isMaterialChange(prev, rankMarkets(FIXTURE_2026_10_16));
  assert.equal(r.changed, true, 'the first run on the new basis re-points Five9');
  assert.ok(r.reasons.some((s) => s.includes('rank swap')), r.reasons.join('; '));
});

test('material change: a market changing oversold state is material regardless of rank', () => {
  const prev = rankMarkets(FIXTURE_2026_10_16);
  const rows = FIXTURE_2026_10_16.map((r) => (r.market === 'SAR_MKT' ? { ...r, confirmed: 15 } : r));
  const r = isMaterialChange(prev, rankMarkets(rows));
  assert.equal(r.changed, true);
  assert.ok(r.reasons.some((s) => s.includes('SAR_MKT: oversold false → true')), r.reasons.join('; '));
});

test('material change: a market becoming UNKNOWN is material', () => {
  const prev = rankMarkets(FIXTURE_2026_10_16);
  const next = rankMarkets(FIXTURE_2026_10_16.filter((r) => r.market !== 'SAR_MKT'));
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

// The list-block tests run on the POST-MERGE world (2026-09-28): the board no
// longer emits LAKE_MKT — branch LAKE folds into ORL_MKT through
// lp_branch_market_map — so the 2026-09-04 board is replayed with Lakeland's
// row added into Orlando's. The LKE lists stay in the live fixtures because
// they remain attached until the approval-gated detach runs.
const mergeLakeIntoOrl = (rows) => {
  const lake = rows.find((r) => r.market === 'LAKE_MKT');
  return rows.filter((r) => r.market !== 'LAKE_MKT').map((r) => (r.market === 'ORL_MKT' && lake
    ? { ...r,
      requested: r.requested + lake.requested,
      confirmed: r.confirmed + lake.confirmed,
      set_pending: r.set_pending + lake.set_pending }
    : r));
};
// ORL 29 requested / 11 confirmed / 6 pending → 12 open.
const FIXTURE_2026_09_04_MERGED = mergeLakeIntoOrl(FIXTURE_2026_09_04);
// ORL 18 requested / 6 confirmed / 9 pending → 3 open.
const FIXTURE_2026_09_05_MERGED = mergeLakeIntoOrl(FIXTURE_2026_09_05);

test('mapping: the 12 market list names match what is attached to both campaigns live', () => {
  const hot = new Set(LIVE_HOT_LISTS.map((l) => l.name));
  const warm = new Set(LIVE_WARM_LISTS.map((l) => l.name));
  for (const code of MARKET_CODES) {
    assert.ok(hot.has(MARKET_LISTS[code].hot), `${code} hot list attached`);
    assert.ok(warm.has(MARKET_LISTS[code].warm), `${code} warm list attached`);
  }
  assert.equal(Object.keys(MARKET_LISTS).length, 6, 'six markets — no Tampa, no Lakeland');
  assert.ok(!Object.keys(MARKET_LISTS).some((c) => /TPA|TAMPA/i.test(c)));
});

test('route 2026-10-15: the response and log row carry the confirmed-% basis, no hopper weight', async () => {
  const { deps, calls } = fakeRun({ rows: FIXTURE_2026_10_16, performance: PERF_2026_10_15 });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-10-16' }, deps);
  assert.equal(status, 200);
  assert.equal(body.scoring_basis, 'confirmed_fill_pct');
  assert.equal(calls.inserted[0].scoring_basis, 'confirmed_fill_pct');
  assert.ok(!('hopper_weight' in body));
  assert.deepEqual(order(body.ranking), ['JAX', 'FTLAU', 'STPET', 'FTMYR', 'ORL', 'SAR']);
  const jax = byMarket(body.ranking).JAX_MKT;
  assert.equal(jax.fill_pct, 0);
  assert.equal(jax.still_needed, 22);
  assert.equal(jax.set_pending, 5, 'reported, not ranked');
  assert.ok(!('open_true' in jax));
});

test('MERGE: six markets, ranked 1–6, and LAKE_MKT is not one of them', () => {
  assert.deepEqual([...MARKET_CODES].sort(),
    ['FTLAU_MKT', 'FTMYR_MKT', 'JAX_MKT', 'ORL_MKT', 'SAR_MKT', 'STPET_MKT']);
  assert.ok(!('LAKE_MKT' in MARKET_LISTS), 'no LKE mapping');
  const { ranking, unknown } = rankOld(FIXTURE_2026_09_04_MERGED);
  assert.deepEqual(ranking.map((r) => r.rank), [1, 2, 3, 4, 5, 6]);
  // FTMYR 2.3 %, FTLAU 14.3, JAX 19.0, STPET 20.0, SAR 21.1, ORL 11/29 = 37.9.
  assert.deepEqual(order(ranking), ['FTMYR', 'FTLAU', 'JAX', 'STPET', 'SAR', 'ORL']);
  assert.equal(byMarket(ranking).ORL_MKT.requested, 29, 'Orlando carries the former Lakeland slots');
  assert.deepEqual(unknown, []);
});

test('MERGE: a stray LAKE_MKT row is surfaced as unmapped, never ranked', () => {
  const { ranking, unknown } = rankMarkets(FIXTURE_2026_09_04);
  assert.ok(!ranking.some((r) => r.market === 'LAKE_MKT'));
  assert.deepEqual(unknown.map((u) => [u.market, u.reason]), [['LAKE_MKT', 'unmapped_market']]);
});

test('MERGE: the LKE lists never receive a ranked priority — pinned last with Unmapped, both tiers', () => {
  for (const [tier, lists] of [['hot', LIVE_HOT_LISTS], ['warm', LIVE_WARM_LISTS]]) {
    const block = computeListBlock(lists, rankOld(FIXTURE_2026_09_04_MERGED), tier);
    const lke = MARKET_LISTS.ORL_MKT[tier].replace(' ORL ', ' LKE ');
    assert.equal(block.intended[lke], 7, `${tier}: LKE dials after every ranked market`);
    assert.ok(block.pinned.includes(lke), `${tier}: LKE is a pinned non-market list`);
    assert.deepEqual(block.unknown_lists, [], `${tier}: LKE is not an "unknown market"`);
  }
});

test('computeListBlock: rank → dialingPriority, market lists 1–6, LKE and Unmapped pinned after', () => {
  const rank = rankOld(FIXTURE_2026_09_04_MERGED);
  const block = computeListBlock(LIVE_HOT_LISTS, rank, 'hot');
  assert.equal(block.intended['Data - Hot - FTM less than 7'], 1);
  assert.equal(block.intended['Data - Hot - FTL less than 7'], 2);
  assert.equal(block.intended['Data - Hot - JAX less than 7'], 3);
  assert.equal(block.intended['Data - Hot - STP less than 7'], 4);
  assert.equal(block.intended['Data - Hot - SAR less than 7'], 5);
  assert.equal(block.intended['Data - Hot - ORL less than 7'], 6);
  assert.equal(block.intended['Data - Hot - LKE less than 7'], 7, 'former market list, now pinned');
  assert.equal(block.intended['Data - Hot - Unmapped'], 7, 'non-market list pinned to the highest number');
  assert.deepEqual(block.pinned, ['Data - Hot - LKE less than 7', 'Data - Hot - Unmapped']);
  assert.deepEqual(block.skipped, []);
  assert.equal(block.changed, true);
});

test('computeListBlock: REORDER ONLY — every attached list is resubmitted, none dropped or added, priority/ratio untouched', () => {
  const block = computeListBlock(LIVE_WARM_LISTS, rankOld(FIXTURE_2026_09_04_MERGED), 'warm');
  assert.deepEqual(block.lists.map((l) => l.name), LIVE_WARM_LISTS.map((l) => l.name), 'same lists, same order as read');
  for (let i = 0; i < block.lists.length; i += 1) {
    assert.equal(block.lists[i].priority, LIVE_WARM_LISTS[i].priority, 'priority carried as read');
    assert.equal(block.lists[i].dialingRatio, LIVE_WARM_LISTS[i].dialingRatio, 'dialingRatio carried as read');
  }
});

test('computeListBlock: a missing market list is skipped and logged — never created', () => {
  const lists = LIVE_HOT_LISTS.filter((l) => l.name !== 'Data - Hot - JAX less than 7');
  const block = computeListBlock(lists, rankOld(FIXTURE_2026_09_04_MERGED), 'hot');
  assert.deepEqual(block.skipped, [{ market: 'JAX_MKT', list: 'Data - Hot - JAX less than 7', reason: 'list_not_attached' }]);
  assert.ok(!block.lists.some((l) => l.name === 'Data - Hot - JAX less than 7'), 'not added');
  assert.equal(block.lists.length, lists.length);
});

test('computeListBlock: an UNKNOWN market\'s list still dials — after ranked markets, never priority 1', () => {
  const rows = FIXTURE_2026_09_04_MERGED.map((r) => (r.market === 'SAR_MKT' ? { ...r, requested: 0, confirmed: 0, set_pending: 0 } : r));
  const block = computeListBlock(LIVE_HOT_LISTS, rankMarkets(rows), 'hot');
  const sar = block.intended['Data - Hot - SAR less than 7'];
  assert.ok(sar > 1, 'never priority 1');
  assert.equal(sar, 6, 'after the five ranked markets');
  assert.equal(block.intended['Data - Hot - Unmapped'], 7, 'pinned list still last');
  assert.deepEqual(block.unknown_lists, ['Data - Hot - SAR less than 7']);
});

test('computeListBlock: legacy statewide lists, if attached, are pinned last and never reordered', () => {
  const lists = [
    ...LIVE_HOT_LISTS,
    { name: 'Data - Hot Leads less than 7', priority: 9, dialingPriority: 3, dialingRatio: 1 },
  ];
  const block = computeListBlock(lists, rankOld(FIXTURE_2026_09_04_MERGED), 'hot');
  assert.equal(block.intended['Data - Hot Leads less than 7'], 7);
  assert.equal(block.intended['Data - Hot - Unmapped'], 7, 'all non-market lists share the last number');
  assert.deepEqual(block.pinned, ['Data - Hot - LKE less than 7', 'Data - Hot - Unmapped', 'Data - Hot Leads less than 7']);
});

test('computeListBlock: changed=false when the attached order already matches', () => {
  const rank = rankOld(FIXTURE_2026_09_04_MERGED);
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

/**
 * Fake Five9 with campaign lifecycle.
 *   states            — initial campaign state per campaign (default RUNNING).
 *   refuseWhileRunning — mimic refuseIfCampaignRunning: the list write throws
 *                        unless the campaign is NOT_RUNNING at write time.
 *   startsBeforeRunning — how many startCampaign calls read back non-RUNNING
 *                        before the campaign actually comes up (retry cases).
 *   startAlwaysFails  — startCampaign never brings the campaign back.
 *   startThrows       — startCampaign throws instead of returning.
 *   stopDrainMs       — REAL FIVE9 BEHAVIOUR (observed in production
 *                       2026-09-04): a graceful stop does not land instantly.
 *                       The campaign reports STOPPING while it drains calls in
 *                       progress, and startCampaign is REFUSED outright with
 *                       "Illegal campaign state STOPPING" for that whole
 *                       window. Only after it drains does it read NOT_RUNNING
 *                       and become startable.
 *   calls             — ordered [op, campaign] log across stop/modify/start.
 */
function fakeFive9({
  writesEnabled = true, applyWrites = true, refuse = null,
  states = null, refuseWhileRunning = false,
  startsBeforeRunning = 0, startAlwaysFails = false, startThrows = false,
  startLagMs = 0, stopDrainMs = 0, startRejectsFirst = 0,
} = {}) {
  const state = {
    [CAMPAIGNS.hot]: LIVE_HOT_LISTS.map((l) => ({ ...l })),
    [CAMPAIGNS.warm]: LIVE_WARM_LISTS.map((l) => ({ ...l })),
  };
  const campaignState = { [CAMPAIGNS.hot]: 'RUNNING', [CAMPAIGNS.warm]: 'RUNNING', ...(states || {}) };
  const writes = [];
  const calls = [];
  const startAttempts = {};
  const stoppedByUs = new Set(); // campaigns THIS run stopped and has not brought back
  // Five9 reports campaign state on a lag: the SOAP start is accepted, but
  // state reads keep saying NOT_RUNNING for a while (5-8s observed live on
  // 2026-09-03). Time only passes here when the code under test sleeps, so the
  // test's injected sleep drives this clock through advance().
  let clock = 0;
  const flipAt = {};
  const drainUntil = {};
  const readCampaignState = (name) => {
    // A draining campaign reports STOPPING until it settles to NOT_RUNNING.
    if (drainUntil[name] !== undefined) {
      if (clock >= drainUntil[name]) {
        delete drainUntil[name];
        campaignState[name] = 'NOT_RUNNING';
      } else {
        return 'STOPPING';
      }
    }
    if (flipAt[name] !== undefined && clock >= flipAt[name]) {
      campaignState[name] = 'RUNNING';
      stoppedByUs.delete(name);
      delete flipAt[name];
    }
    return campaignState[name];
  };
  return {
    advance: (ms) => { clock += ms; },
    state,
    campaignState,
    writes,
    calls,
    deps: {
      five9WritesEnabled: () => writesEnabled,
      getOutboundCampaign: async (name) => (state[name]
        ? { name, state: readCampaignState(name), lists: state[name].map((l) => ({ ...l })) }
        : { name, error: 'campaign_not_found' }),
      modifyCampaignLists: async (action) => {
        const p = action.action_payload;
        writes.push(action);
        calls.push(['modify', p.campaign_name]);
        assert.equal(action.requires_approval, true);
        assert.equal(p.confirm_token, p.campaign_name, 'confirm_token restates the campaign');
        if (refuse) throw new Error(refuse);
        if (refuseWhileRunning && campaignState[p.campaign_name] === 'RUNNING') {
          throw new Error(`REFUSED: modify_campaign_lists on a RUNNING campaign — ${p.campaign_name}`);
        }
        if (!writesEnabled) return { campaign: p.campaign_name, method: 'modifyCampaignLists', previewed: true, dry_run: true };
        if (applyWrites) state[p.campaign_name] = p.lists.map((l) => ({ ...l }));
        return { campaign: p.campaign_name, method: 'modifyCampaignLists' };
      },
      stopCampaign: async (action) => {
        const name = action.action_payload.campaign_name;
        assert.equal(action.action_type, 'five9_stop_campaign');
        assert.notEqual(action.action_payload.force, true, 'NEVER force-stop — it drops calls in progress');
        assert.equal(stoppedByUs.size, 0, `stop ${name}: a campaign this run stopped (${[...stoppedByUs].join(', ')}) is still dark — never both at once`);
        calls.push(['stop', name]);
        campaignState[name] = 'NOT_RUNNING';
        if (stopDrainMs > 0) drainUntil[name] = clock + stopDrainMs;
        stoppedByUs.add(name);
        return { campaign: name, method: 'stopCampaign', state: stopDrainMs > 0 ? 'STOPPING' : 'NOT_RUNNING' };
      },
      startCampaign: async (action) => {
        const name = action.action_payload.campaign_name;
        assert.equal(action.action_type, 'five9_start_campaign');
        calls.push(['start', name]);
        startAttempts[name] = (startAttempts[name] || 0) + 1;
        // Five9 refuses a start outright while the campaign is still draining.
        // This is the exact fault that took the floor dark twice on 2026-09-04.
        if (readCampaignState(name) === 'STOPPING') {
          throw new Error(`Five9 startCampaign fault: Error updating campaign state "${name}": Illegal campaign state STOPPING`);
        }
        // Five9 REJECTS the first N starts outright — the campaign stays down.
        // This is the 2026-09-04 shape: a start refused against a campaign that
        // has not finished settling, which the old 3 x 2s budget ran out on.
        if (startAttempts[name] <= startRejectsFirst) {
          throw new Error(`Five9 startCampaign fault: Error updating campaign state "${name}": campaign is not ready`);
        }
        if (startThrows) throw new Error('Five9 startCampaign fault');
        if (startAlwaysFails) return { campaign: name, method: 'startCampaign', state: 'NOT_RUNNING' };
        if (startAttempts[name] > startsBeforeRunning && campaignState[name] !== 'RUNNING') {
          // Five9 has ACCEPTED the start; the campaign is dialing. State
          // reporting catches up startLagMs later. A repeat start does not
          // re-arm the lag — the campaign is already up (decideLifecycleNoop
          // makes a start on a RUNNING campaign a skip).
          if (flipAt[name] === undefined) flipAt[name] = clock + startLagMs;
          if (startLagMs === 0) { campaignState[name] = 'RUNNING'; stoppedByUs.delete(name); delete flipAt[name]; }
        }
        return { campaign: name, method: 'startCampaign', state: campaignState[name] };
      },
      sleep: async () => {},
    },
  };
}

// ─── applyDialPriority: stop → reorder → restart cycle ───────────────────────
//
// THE test this whole design exists for. A successful stop followed by a
// reorder that throws must STILL restart the campaign — a stop with no restart
// leaves the floor dark, which is worse than the reorder never happening.

test('CYCLE: modifyCampaignLists THROWS → startCampaign is still called (finally guarantee), campaign reads RUNNING', async () => {
  const f = fakeFive9({ refuse: 'SOAP fault: modifyCampaignLists exploded' });
  await assert.rejects(
    applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, cycleCampaigns: true, log: () => {} }),
    /modifyCampaignLists exploded/,
    'the reorder failure still surfaces (logged, abandoned, not retried)',
  );
  assert.deepEqual(
    f.calls,
    [['stop', CAMPAIGNS.hot], ['modify', CAMPAIGNS.hot], ['start', CAMPAIGNS.hot]],
    'stop → (failed) modify → START. Warm is never touched because hot aborted the run.',
  );
  assert.equal(f.campaignState[CAMPAIGNS.hot], 'RUNNING', 'hot is dialing again');
  assert.equal(f.campaignState[CAMPAIGNS.warm], 'RUNNING', 'warm was never stopped');
});

test('CYCLE: read-back MISMATCH after a landed write → campaign is still restarted', async () => {
  const f = fakeFive9({ applyWrites: false, refuseWhileRunning: true });
  await assert.rejects(
    applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, cycleCampaigns: true, log: () => {} }),
    /read-back order does not match intent/,
  );
  assert.deepEqual(f.calls.map((c) => c[0]), ['stop', 'modify', 'start']);
  assert.equal(f.campaignState[CAMPAIGNS.hot], 'RUNNING');
});

test('CYCLE: stop before modify, start after, one campaign at a time — the write lands only because the campaign was stopped', async () => {
  const f = fakeFive9({ refuseWhileRunning: true });
  const out = await applyDialPriority(rankOld(FIXTURE_2026_09_04_MERGED), { ...f.deps, cycleCampaigns: true, log: () => {} });
  assert.deepEqual(f.calls, [
    ['stop', CAMPAIGNS.hot], ['modify', CAMPAIGNS.hot], ['start', CAMPAIGNS.hot],
    ['stop', CAMPAIGNS.warm], ['modify', CAMPAIGNS.warm], ['start', CAMPAIGNS.warm],
  ], 'hot cycles and restarts fully before warm begins');
  assert.equal(out.applied, true);
  assert.deepEqual(out.restart_failures, []);
  for (const t of ['hot', 'warm']) {
    assert.equal(out.campaigns[t].cycled, true);
    assert.equal(out.campaigns[t].was_running, true);
    assert.equal(out.campaigns[t].restarted, true);
    assert.equal(out.campaigns[t].verified, true);
    assert.equal(typeof out.campaigns[t].downtime_ms, 'number');
  }
  assert.equal(f.campaignState[CAMPAIGNS.hot], 'RUNNING');
  assert.equal(f.campaignState[CAMPAIGNS.warm], 'RUNNING');
  assert.equal(f.state[CAMPAIGNS.hot].find((l) => l.name === 'Data - Hot - LKE less than 7').dialingPriority, 7, 'reorder landed');
});

test('CYCLE: restart reads non-RUNNING twice then RUNNING → retried with EXPONENTIAL backoff, restarted:true', async () => {
  const sleeps = [];
  const f = fakeFive9({ startsBeforeRunning: 2 });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, log: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(f.calls.filter((c) => c[0] === 'start' && c[1] === CAMPAIGNS.hot).length, 3, 'three start attempts on hot');
  // The backoff is what the old flat 2s could not do: 2s, then 4s, then 8s…
  // Everything else in the sleep log is the 3s verify poll.
  const backoffs = sleeps.filter((ms) => ms !== DEFAULT_RESTART.pollMs);
  assert.deepEqual(backoffs.slice(0, 2), [2000, 4000], 'exponential, not flat');
  assert.equal(out.campaigns.hot.restarted, true);
  assert.equal(out.campaigns.hot.restart_attempts, 3);
  assert.equal(out.applied, true);
  assert.deepEqual(out.restart_failures, []);
});

test('BACKOFF: 2, 4, 8, 16, 32, then capped at 60s — the published ladder', () => {
  const ladder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => restartBackoffMs(n));
  assert.deepEqual(ladder, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000]);
});

// Five9 reports campaign state asynchronously. On 2026-09-03 the STEP 0 start
// was accepted at 20:13:41 and getCampaignState still read NOT_RUNNING until
// ~20:13:49. Reading state the instant the start returns therefore says
// "campaign is dark" about a campaign that is dialing — a false CRITICAL, a
// false 500, and a page for nobody.

test('LAG: state still reads NOT_RUNNING right after an accepted start → the verify poll waits it out, ONE start call', async () => {
  const sleeps = [];
  const f = fakeFive9({ startLagMs: 3000 }); // Five9 reports state 3s late
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { sleeps.push(ms); f.advance(ms); }, log: () => {},
  });
  assert.equal(f.calls.filter((c) => c[0] === 'start' && c[1] === CAMPAIGNS.hot).length, 1, 'the start was accepted once — never re-fired at a live campaign');
  assert.equal(sleeps[0], DEFAULT_RESTART.pollMs, 'polled rather than believing the first read');
  assert.equal(out.campaigns.hot.restarted, true);
  assert.deepEqual(out.restart_failures, []);
  assert.equal(out.applied, true);
});

test('LAG: a 25s reporting lag is absorbed INSIDE the attempt budget — no CRITICAL, applied stays true', async () => {
  const log = [];
  // 25s lag: longer than one 15s verify window, so it takes a second attempt.
  // Under the OLD budget (3 x 2s + a 10s final read) this campaign was declared
  // dark while it was in fact dialing.
  const f = fakeFive9({ startLagMs: 25000 });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { f.advance(ms); }, log: (m) => log.push(m),
  });
  assert.equal(out.campaigns.hot.restarted, true);
  assert.equal(out.campaigns.hot.restart_error, undefined, 'a rescued restart carries no error');
  assert.ok(out.campaigns.hot.restart_attempts <= 3, 'took a couple of attempts, nowhere near the ceiling');
  assert.ok(!log.some((m) => /CRITICAL/.test(m)), 'never paged anyone');
  assert.deepEqual(out.restart_failures, []);
  assert.equal(out.applied, true);
});

test('LAG: a genuinely dark campaign still fails once the budget is spent — the alarm is not disarmed', async () => {
  const log = [];
  const f = fakeFive9({ startAlwaysFails: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, sleep: async () => {}, log: (m) => log.push(m),
  });
  assert.equal(out.campaigns.hot.restarted, false);
  assert.deepEqual(out.restart_failures, [CAMPAIGNS.hot]);
  assert.equal(out.applied, false);
  assert.ok(log.some((m) => /CRITICAL.*DID NOT RESTART/.test(m)));
});

// ─── DRAIN: the STOPPING window ─────────────────────────────────────────────
//
// THE PRODUCTION INCIDENT, 2026-09-04. A graceful stop does not land instantly:
// Five9 reports STOPPING while it drains calls in progress, and it REFUSES
// startCampaign for that entire window with "Illegal campaign state STOPPING".
// The old restart loop spent all three attempts inside that window — a throwing
// start skips the settle wait, so the whole budget was 2s + 2s + a 10s final
// read ≈ 16s — and gave up while the campaign was still draining. Both Data
// campaigns went dark that afternoon, ~85s and ~95s, and each needed a manual
// start. The fix is to WAIT OUT the transitional state instead of firing
// starts into it.

test('DRAIN: no start is fired while the campaign reads STOPPING — the restart waits it out', async () => {
  const f = fakeFive9({ stopDrainMs: 25000 }); // 25s drain, as seen live
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { f.advance(ms); }, log: () => {},
  });
  // The old code fired 3 starts into STOPPING and every one was refused.
  const hotStarts = f.calls.filter((c) => c[0] === 'start' && c[1] === CAMPAIGNS.hot);
  assert.equal(hotStarts.length, 1, 'exactly ONE start, fired only once the campaign was startable');
  assert.equal(out.campaigns.hot.restarted, true);
  assert.equal(out.campaigns.hot.restart_error, undefined);
  assert.deepEqual(out.restart_failures, []);
  assert.equal(out.applied, true);
});

test('DRAIN: a 25s drain would have blown the OLD ~16s budget — both campaigns still come back', async () => {
  const log = [];
  const f = fakeFive9({ stopDrainMs: 25000 });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { f.advance(ms); }, log: (m) => log.push(m),
  });
  for (const t of ['hot', 'warm']) {
    assert.equal(out.campaigns[t].cycled, true, `${t} cycled`);
    assert.equal(out.campaigns[t].restarted, true, `${t} came back`);
    assert.equal(out.campaigns[t].verified, true, `${t} reorder landed`);
  }
  assert.deepEqual(out.restart_failures, []);
  assert.ok(!log.some((m) => /CRITICAL/.test(m)), 'nobody is paged for a normal drain');
  assert.equal(out.applied, true);
});

test('DRAIN: waiting is BOUNDED — a campaign that never leaves STOPPING is declared dark, not hung', async () => {
  const log = [];
  const f = fakeFive9({ stopDrainMs: 10 * 60 * 1000 }); // drains long past any budget
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, restartMaxWaitMs: 60000,
    sleep: async (ms) => { f.advance(ms); }, log: (m) => log.push(m),
  });
  assert.equal(out.campaigns.hot.restarted, false, 'gave up rather than looping forever');
  assert.deepEqual(out.restart_failures, [CAMPAIGNS.hot]);
  assert.equal(out.applied, false);
  assert.match(out.campaigns.hot.restart_error, /STOPPING/, 'the error names the state it was stuck in');
  assert.ok(log.some((m) => /CRITICAL.*DID NOT RESTART/.test(m)), 'a genuinely stuck campaign still pages');
});

test('DRAIN: the dark window is still REPORTED, never hidden by the new waiting', async () => {
  const f = fakeFive9({ stopDrainMs: 20000 });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { f.advance(ms); }, log: () => {},
  });
  // Waiting out the drain makes the restart RELIABLE, not free: the campaign
  // genuinely was not dialing for that whole window. downtime_ms must still be
  // reported so a long drain shows up in dial_priority_log rather than being
  // silently absorbed.
  assert.ok(Number.isFinite(out.campaigns.hot.downtime_ms), 'downtime is measured, not null');
  assert.equal(out.campaigns.hot.restarted, true);
});

// ─── SETTLE: wait for the graceful stop to land before doing anything ───────
//
// THE MECHANISM BEHIND 2026-09-04. stopCampaign returns as soon as Five9
// accepts it, but the campaign then sits in STOPPING while it drains calls in
// progress — and in that window Five9 refuses BOTH the list write and a start.
// Warm (2,640 records, 8 lists) drains longest, which is why it failed twice.

test('SETTLE: the list write waits for the stop to actually land, and settle_ms is recorded', async () => {
  const f = fakeFive9({ stopDrainMs: 12000, refuseWhileRunning: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { f.advance(ms); }, log: () => {},
  });
  assert.equal(out.campaigns.hot.settled, true);
  assert.ok(out.campaigns.hot.settle_ms >= 12000, `settle_ms reports the observed drain (got ${out.campaigns.hot.settle_ms})`);
  assert.equal(out.campaigns.hot.written, true, 'the write went out only once the campaign had settled');
  assert.equal(out.campaigns.hot.verified, true);
  assert.ok(out.settle_ms > 0, 'summed for the dial_priority_log row');
  assert.equal(out.applied, true);
});

test('SETTLE: a stop that NEVER settles → no reorder is attempted, the campaign is restarted, the run aborts cleanly', async () => {
  const log = [];
  // Drains far past the settle timeout, then finally comes back — so the
  // restart succeeds and the only casualty is this run's reorder.
  const f = fakeFive9({ stopDrainMs: 40000, refuseWhileRunning: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, stopSettleTimeoutMs: 10000,
    sleep: async (ms) => { f.advance(ms); }, log: (m) => log.push(m),
  });
  assert.deepEqual(f.calls.filter((c) => c[0] === 'modify' && c[1] === CAMPAIGNS.hot), [],
    'the reorder was NEVER fired into a draining campaign');
  assert.equal(out.campaigns.hot.settled, false);
  assert.match(out.campaigns.hot.skipped_reason, /did not settle/);
  assert.equal(out.campaigns.hot.restarted, true, 'but it was still brought back');
  assert.deepEqual(out.restart_failures, [], 'a skipped reorder is not a dark campaign');
  assert.equal(out.applied, false, 'nothing was applied, and the run says so');
  assert.equal(f.campaignState[CAMPAIGNS.hot], 'RUNNING');
});

test('SETTLE: waitForStopSettle polls every 2s up to the timeout and reports the state it gave up on', async () => {
  let state = 'STOPPING';
  const sleeps = [];
  const out = await waitForStopSettle('Data - Warm Leads less than 30', {
    readState: async () => state,
    sleep: async (ms) => { sleeps.push(ms); },
    timeoutMs: 30000, pollMs: 2000,
  });
  assert.equal(out.settled, false);
  assert.equal(out.state, 'STOPPING');
  assert.equal(sleeps.length, 15, '30s / 2s — bounded by a poll count, not a wall clock');
  assert.equal(out.settle_ms, 30000);

  state = 'RUNNING';
  const quick = await waitForStopSettle('x', { readState: async () => (state = 'NOT_RUNNING'), sleep: async () => {} });
  assert.equal(quick.settled, true);
  assert.equal(quick.settle_ms, 0, 'a stop that has already landed costs nothing');
});

// ─── THE PRODUCTION CASE: a start rejected, then rejected again, then taken ──

test('RESTART: startCampaign is REJECTED twice, then succeeds → campaign ends RUNNING and applied is true', async () => {
  // This is dial_priority_log id 24, 2026-09-04: the campaign was reachable and
  // the starts were being refused, not lost. Under the old 3 x 2s budget the
  // loop gave up and "Data - Warm Leads less than 30" stayed dark for two hours.
  const log = [];
  const f = fakeFive9({ startRejectsFirst: 2 });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { f.advance(ms); }, log: (m) => log.push(m),
  });
  for (const tier of ['hot', 'warm']) {
    assert.equal(out.campaigns[tier].restarted, true, `${tier} came back`);
    assert.equal(out.campaigns[tier].restart_attempts, 3, `${tier}: two refusals then a start that took`);
    assert.equal(f.campaignState[CAMPAIGNS[tier]], 'RUNNING');
  }
  assert.deepEqual(out.restart_failures, []);
  assert.equal(out.applied, true, 'the reorder landed AND the floor is dialing');
  assert.ok(!log.some((m) => /CRITICAL/.test(m)), 'a refusal that is retried past is not an incident');
});

test('RESTART: an exception NEVER exits the loop early — every attempt is spent before giving up', async () => {
  const f = fakeFive9({ startThrows: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, sleep: async () => {}, log: () => {},
  });
  assert.equal(f.calls.filter((c) => c[0] === 'start' && c[1] === CAMPAIGNS.hot).length, DEFAULT_RESTART.maxAttempts,
    'ten attempts, even though every one of them threw');
  assert.equal(out.campaigns.hot.restart_attempts, DEFAULT_RESTART.maxAttempts);
  assert.match(out.campaigns.hot.restart_error, /startCampaign fault/, 'the refusal, not a state read, is the reported cause');
});

test('RESTART: the CEILING ends the loop even when attempts remain', async () => {
  const f = fakeFive9({ startAlwaysFails: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, restartCeilingMs: 30000,
    sleep: async (ms) => { f.advance(ms); }, log: () => {},
  });
  assert.ok(out.campaigns.hot.restart_attempts < DEFAULT_RESTART.maxAttempts,
    `the 30s ceiling stopped it early (attempts=${out.campaigns.hot.restart_attempts})`);
  assert.deepEqual(out.restart_failures, [CAMPAIGNS.hot]);
});

test('RESTART: a campaign someone else already brought back is left alone — no start is fired', async () => {
  const r = await restartCampaignVerified('Data - Hot Leads less than 7', {
    readState: async () => 'RUNNING',
    startCampaign: async () => { throw new Error('must never be called'); },
    sleep: async () => {},
  });
  assert.equal(r.restarted, true);
  assert.equal(r.attempts, 0, 'idempotent — this is what makes /heal safe to call repeatedly');
});

test('SETTLE: a stop that settles INSTANTLY reports settle_ms 0, not null', async () => {
  // 2026-09-04 23:15, the first armed cycle in production: the stop settled on
  // the very first read — the best possible outcome — and `sum || null` logged
  // it as NULL, which reads identically to "this run never cycled". settle_ms
  // is the number the stop-settle timeout is tuned from, so a measured zero
  // must survive.
  const f = fakeFive9({ refuseWhileRunning: true }); // no drain: settles at once
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true,
    sleep: async (ms) => { f.advance(ms); }, log: () => {},
  });
  assert.equal(out.campaigns.hot.settled, true);
  assert.equal(out.campaigns.hot.settle_ms, 0, 'settled on the first read');
  assert.equal(out.settle_ms, 0, 'and ZERO is reported, not null');
  assert.notEqual(out.settle_ms, null, 'null would mean "never measured"');
  assert.ok(out.restart_attempts >= 1);
  assert.equal(out.applied, true);
});

test('SETTLE: a run that never cycled still reports settle_ms null', async () => {
  // The other side of the same contract: null keeps meaning "not measured".
  const f = fakeFive9();
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: false, log: () => {},
  });
  assert.equal(out.settle_ms, null);
  assert.equal(out.restart_attempts, null);
});

// ─── The never-both-dark guard, on LIVE state ───────────────────────────────

test('GUARD: a campaign already dark from an EARLIER run blocks cycling the other one', async () => {
  // 2026-09-04: the Hot campaign was left NOT_RUNNING by a failed restart at
  // 17:07. The 17:15 run then cycled Warm anyway — the guard only looked at
  // campaigns cycled in ITS OWN run, so it never saw that Hot was dark. Had
  // Warm also failed to come back, the floor would have had NO Data campaign
  // dialing at all.
  const f = fakeFive9({ states: { [CAMPAIGNS.hot]: 'NOT_RUNNING' } });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, log: () => {},
  });
  assert.equal(out.campaigns.warm.cycled, false, 'warm must NOT be stopped while hot is dark');
  assert.ok(!f.calls.some((c) => c[0] === 'stop' && c[1] === CAMPAIGNS.warm), 'no stop was issued for warm');
  assert.match(out.campaigns.warm.skipped_reason, /Data - Hot Leads less than 7 is NOT_RUNNING/);
  assert.match(out.campaigns.warm.skipped_reason, /never both campaigns stopped at once/);
  // Hot itself is still reordered — it is already stopped, so no cycle needed.
  assert.equal(out.campaigns.hot.cycled, false);
  assert.equal(out.campaigns.hot.verified, true, 'hot got its new order');
  assert.equal(out.applied, false, 'warm did not get its order — the run is not fully applied');
});

test('GUARD: an UNREADABLE peer is treated as dark — the campaign that cannot vouch for its peer does not stop', async () => {
  const f = fakeFive9();
  // Fail ONLY the very first read of warm — the peer check hot runs before it
  // stops itself. Warm's own cycle later reads cleanly, so this isolates the
  // guard rather than also breaking warm's restart verification.
  let warmReads = 0;
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, log: () => {},
    getCampaignState: async (name) => {
      if (name === CAMPAIGNS.warm && (warmReads += 1) === 1) throw new Error('Five9 unreachable');
      return { name, state: f.campaignState[name] };
    },
  });
  // Hot goes first and cannot confirm warm is up, so it refuses to stop —
  // a peer we cannot see is not a peer we can vouch for.
  assert.equal(out.campaigns.hot.cycled, false);
  assert.match(out.campaigns.hot.skipped_reason, /unreadable/);
  assert.ok(!f.calls.some((c) => c[0] === 'stop' && c[1] === CAMPAIGNS.hot), 'hot was never stopped');
  // Warm CAN read hot (RUNNING), so it cycles normally. Only ever one down.
  assert.equal(out.campaigns.warm.cycled, true);
  assert.equal(out.campaigns.warm.restarted, true);
  assert.equal(out.applied, false, 'hot kept its old order, so the run is not fully applied');
});

test('GUARD: with BOTH campaigns RUNNING the guard is silent — normal cycling is unaffected', async () => {
  const f = fakeFive9();
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, log: () => {},
  });
  assert.deepEqual(f.calls, [
    ['stop', CAMPAIGNS.hot], ['modify', CAMPAIGNS.hot], ['start', CAMPAIGNS.hot],
    ['stop', CAMPAIGNS.warm], ['modify', CAMPAIGNS.warm], ['start', CAMPAIGNS.warm],
  ], 'one at a time, hot fully back before warm begins');
  assert.equal(out.applied, true);
});

test('DOWNTIME: measured to the start Five9 accepted, not to the confirmation read that waits out the lag', async () => {
  const f = fakeFive9({ startLagMs: 30 });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, restartSettleMs: 60, log: () => {},
    // Real elapsed time AND fake-clock time, so the settle genuinely waits.
    sleep: async (ms) => { f.advance(ms); await new Promise((r) => setTimeout(r, ms)); },
  });
  assert.ok(out.campaigns.hot.downtime_ms < 50,
    `downtime ${out.campaigns.hot.downtime_ms}ms should exclude the settle wait — the campaign was already dialing`);
  assert.equal(out.campaigns.hot.restarted, true);
});

test('CYCLE: restart NEVER succeeds → applied:false, restart_failures populated, restart_error recorded', async () => {
  const log = [];
  const f = fakeFive9({ startAlwaysFails: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, cycleCampaigns: true, log: (m) => log.push(m) });
  assert.equal(out.applied, false, 'a landed reorder never counts as applied when the campaign is dark');
  assert.deepEqual(out.restart_failures, [CAMPAIGNS.hot], 'hot is named');
  assert.equal(out.campaigns.hot.restarted, false);
  assert.equal(out.campaigns.hot.verified, true, 'the reorder itself DID land — the failure is the restart');
  assert.match(out.campaigns.hot.restart_error, /state reads NOT_RUNNING after start/);
  assert.equal(f.calls.filter((c) => c[0] === 'start' && c[1] === CAMPAIGNS.hot).length, DEFAULT_RESTART.maxAttempts, 'bounded at restartAttempts — TEN, not three');
  assert.ok(log.some((m) => /CRITICAL.*DID NOT RESTART/.test(m)), 'shouts in the log');
  // Hot is dark, so Warm must NOT be stopped too — the floor keeps its one live campaign.
  assert.deepEqual(f.calls.filter((c) => c[1] === CAMPAIGNS.warm), [], 'warm: not stopped, not written, not started');
  assert.equal(f.campaignState[CAMPAIGNS.warm], 'RUNNING');
  assert.equal(out.campaigns.warm.cycled, false);
  assert.equal(out.campaigns.warm.written, false);
  assert.match(out.campaigns.warm.skipped_reason, /Data - Hot Leads less than 7 is NOT_RUNNING/);
});

test('CYCLE: startCampaign THROWS every time → still bounded, restart_failures populated, the throw does not escape', async () => {
  const f = fakeFive9({ startThrows: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, cycleCampaigns: true, log: () => {} });
  assert.equal(out.applied, false);
  assert.match(out.campaigns.hot.restart_error, /startCampaign fault/);
  assert.deepEqual(out.restart_failures, [CAMPAIGNS.hot]);
  assert.equal(f.campaignState[CAMPAIGNS.warm], 'RUNNING', 'warm left running — never both dark');
});

test('CYCLE: a campaign already NOT_RUNNING is reordered and LEFT STOPPED — never stopped, never started, cycled:false', async () => {
  const f = fakeFive9({ states: { [CAMPAIGNS.hot]: 'NOT_RUNNING' }, refuseWhileRunning: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, cycleCampaigns: true, log: () => {} });
  assert.deepEqual(f.calls.filter((c) => c[1] === CAMPAIGNS.hot), [['modify', CAMPAIGNS.hot]], 'hot: write only');
  assert.equal(out.campaigns.hot.cycled, false);
  assert.equal(out.campaigns.hot.was_running, false);
  assert.equal(out.campaigns.hot.restarted, undefined);
  assert.equal(f.campaignState[CAMPAIGNS.hot], 'NOT_RUNNING', 'prior state restored, not assumed');
  // BEHAVIOUR CHANGE (2026-09-04): warm used to cycle here. It must not. Hot
  // is dark, so stopping warm would leave NO Data campaign dialing — exactly
  // the state the never-both-dark guard exists to prevent. It only ever
  // checked campaigns cycled in its own run, so it missed a peer that was
  // already down. See the GUARD tests above.
  assert.equal(out.campaigns.warm.cycled, false, 'warm must NOT cycle while hot is dark');
  assert.equal(out.applied, false, 'warm kept its old order — not fully applied');
});

test('CYCLE: flag OFF (default) → no stop, no start, a RUNNING campaign still refuses the write (today\'s behavior)', async () => {
  const f = fakeFive9({ refuseWhileRunning: true });
  await assert.rejects(
    applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, log: () => {} }),
    /REFUSED.*RUNNING/,
  );
  assert.deepEqual(f.calls, [['modify', CAMPAIGNS.hot]], 'no lifecycle calls at all');
});

test('CYCLE: dry-run (FIVE9_WRITES_ENABLED off) never stops a campaign even with the flag on', async () => {
  const f = fakeFive9({ writesEnabled: false });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, cycleCampaigns: true, log: () => {} });
  assert.equal(out.dry_run, true);
  assert.ok(!f.calls.some((c) => c[0] === 'stop' || c[0] === 'start'));
  assert.equal(out.campaigns.hot.cycled, false);
});

test('CYCLE: no write needed → no cycle (order already matches)', async () => {
  const f = fakeFive9();
  const rank = rankPreMerge(FIXTURE_2026_09_04);
  await applyDialPriority(rank, { ...f.deps, cycleCampaigns: true, log: () => {} });
  f.calls.length = 0;
  const out = await applyDialPriority(rank, { ...f.deps, cycleCampaigns: true, log: () => {} });
  assert.deepEqual(f.calls, [], 'nothing stopped for a no-op');
  assert.equal(out.campaigns.hot.cycled, false);
  assert.equal(out.applied, true);
});

test('CYCLE: cycleCampaigns without stopCampaign/startCampaign deps is refused up front', async () => {
  const f = fakeFive9();
  const { stopCampaign, startCampaign, ...rest } = f.deps;
  await assert.rejects(
    applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...rest, cycleCampaigns: true, log: () => {} }),
    /cycleCampaigns requires stopCampaign and startCampaign/,
  );
  assert.deepEqual(f.calls, [], 'nothing was touched');
});

test('CYCLE: getCampaignState, when injected, is used for restart verification', async () => {
  const f = fakeFive9();
  const reads = [];
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, log: () => {},
    getCampaignState: async (name) => { reads.push(name); return { name, state: f.campaignState[name] }; },
  });
  // The cheap read is used for all three jobs that need live state: the peer
  // check before a stop, the drain check before a start, and the restart
  // verification after one. Both campaigns are read; the exact sequence is not
  // pinned, because adding a safety read must not break this test.
  assert.ok(reads.includes(CAMPAIGNS.hot) && reads.includes(CAMPAIGNS.warm), 'both campaigns read via getCampaignState');
  assert.ok(reads.indexOf(CAMPAIGNS.warm) < reads.lastIndexOf(CAMPAIGNS.hot),
    'warm is read as hot\'s peer before hot is cycled');
  assert.equal(out.applied, true);
});

test('applyDialPriority: writes both campaigns, reads back, applied=true when the order matches', async () => {
  const f = fakeFive9();
  const out = await applyDialPriority(rankOld(FIXTURE_2026_09_04_MERGED), { ...f.deps, log: () => {} });
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
    applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, log: () => {} }),
    /read-back order does not match intent.*not retrying/,
  );
  assert.equal(f.writes.length, 1, 'stopped at the first mismatch — no retry, no second campaign');
});

test('applyDialPriority: FIVE9_WRITES_ENABLED off → dry-run, applied=false, no read-back assertion', async () => {
  const f = fakeFive9({ writesEnabled: false });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, log: () => {} });
  assert.equal(out.applied, false);
  assert.equal(out.dry_run, true);
  assert.equal(f.writes.length, 2, 'the gated op still ran (it previews the envelope)');
  assert.equal(f.state[CAMPAIGNS.hot][0].dialingPriority, 1, 'nothing changed');
});

test('applyDialPriority: a REFUSED write (e.g. campaign RUNNING) surfaces as a thrown error, not a retry', async () => {
  const f = fakeFive9({ refuse: 'REFUSED: modify_campaign_lists on a RUNNING campaign' });
  await assert.rejects(
    applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), { ...f.deps, log: () => {} }),
    /REFUSED.*RUNNING/,
  );
  assert.equal(f.writes.length, 1);
});

test('applyDialPriority: no write when the order already matches', async () => {
  const f = fakeFive9();
  const rank = rankPreMerge(FIXTURE_2026_09_04);
  await applyDialPriority(rank, { ...f.deps, log: () => {} });
  const before = f.writes.length;
  const out = await applyDialPriority(rank, { ...f.deps, log: () => {} });
  assert.equal(f.writes.length, before, 'second run wrote nothing');
  assert.equal(out.applied, true, 'still reflects intent');
  assert.equal(out.campaigns.hot.changed, false);
});

// ─── runCapacityRanker (route orchestration, fake I/O) ───────────────────────
// The route runs the LIVE market list (six, post-merge), so every route test
// replays the pre-merge boards with Lakeland added into Orlando.

function fakeRun({
  prev = null, mode = 'shadow', rows = FIXTURE_2026_09_04_MERGED, applyImpl = null,
  insertImpl = null, stale = false, now = null, performance = PERF_2026_09_04,
  perfWeight = 0.25,
  lockHeld = false, lockImpl = null, releaseImpl = null,
  cycleDisabledUntil = null, cycleDisabledImpl = null,
} = {}) {
  const calls = { apply: 0, applyOpts: [], inserted: [], acquired: 0, released: [], alerts: [] };
  const deps = {
    mode,
    swapMargin: DEFAULT_SWAP_MARGIN,
    perfWeight,
    log: () => {},
    now: now || new Date('2026-09-03T16:48:00Z'), // 12:48 ET
    fetchCapacity: async () => ({ rows, stale, last_sweep_at: '2026-09-03T16:45:00Z' }),
    getPerformance: async () => performance,
    readLastApplied: async () => prev,
    readCycleDisabledUntil: cycleDisabledImpl || (async () => cycleDisabledUntil),
    raiseAlert: async (a) => { calls.alerts.push(a); },
    insertLog: insertImpl || (async (row) => { calls.inserted.push(row); return 42; }),
    acquireRunLock: lockImpl || (async () => {
      calls.acquired += 1;
      return lockHeld
        ? { acquired: false, reason: 'lock_held', held_by: 'capacity_ranker', acquired_at: '2026-09-03T16:47:00Z', expires_at: '2026-09-03T16:52:00Z' }
        : { acquired: true, expires_at: '2026-09-03T16:53:00Z' };
    }),
    releaseRunLock: releaseImpl || (async (lock) => { calls.released.push(lock?.expires_at ?? null); }),
    apply: async (rankResult, opts) => {
      calls.apply += 1;
      calls.applyOpts.push(opts);
      if (applyImpl) return applyImpl(rankResult, opts);
      return { applied: true, dry_run: false, campaigns: {} };
    },
  };
  return { deps, calls };
}

/** Run fn with CAPACITY_RANKER_CYCLE_CAMPAIGNS set, then restore the env. */
async function withCycleEnv(value, fn) {
  const prev = process.env.CAPACITY_RANKER_CYCLE_CAMPAIGNS;
  if (value === undefined) delete process.env.CAPACITY_RANKER_CYCLE_CAMPAIGNS;
  else process.env.CAPACITY_RANKER_CYCLE_CAMPAIGNS = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CAPACITY_RANKER_CYCLE_CAMPAIGNS;
    else process.env.CAPACITY_RANKER_CYCLE_CAMPAIGNS = prev;
  }
}

// ─── Run lock: only one ranker run at a time, fleet-wide ────────────────────
//
// WHY THIS EXISTS. The Five9 write gate already serializes each INDIVIDUAL
// admin write fleet-wide (five9_admin:write in outbound_locks), but a ranker
// run is a SEQUENCE of writes — stop, reorder, start, per campaign — and the
// gate releases between each one. Two overlapping runs can therefore interleave
// perfectly legally:
//
//     run A: stop Hot   (takes the write lock, releases it)
//     run B: stop Warm  (takes the write lock, releases it)
//     → BOTH Data campaigns are now stopped and the floor is dark.
//
// The peer check added in PR #844 narrows this but cannot close it: it reads
// each peer's live state and refuses to stop while another is down, which is
// check-then-act. If both runs read before either stop lands, both see RUNNING
// and both proceed. That is a TOCTOU race, and no amount of re-reading fixes it.
//
// On 2026-09-04 two runs landed 42 seconds apart (n8n executions 286949 at
// 18:15:00 mode=trigger, and 286951 at 18:15:42 mode=manual — someone hit
// Execute in the n8n UI). Neither cycled that time, because the order already
// matched, so nothing broke. A manual run landing 42 seconds into a real cycle
// is the same race with a live floor attached.
//
// The lock is held for the WHOLE run, in Supabase (not process memory) so it
// survives a Railway restart and holds if the service ever runs more than one
// instance.

test('LOCK: a second concurrent run is REFUSED with 409 — no ranking, no log row, no Five9 write', async () => {
  const { deps, calls } = fakeRun({ mode: 'live', lockHeld: true });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(status, 409);
  assert.equal(body.error, 'ranker_already_running', 'a machine-readable code, not prose — n8n branches on it');
  assert.match(body.message, /already running/i, 'the prose moved to message');
  assert.equal(body.lock_acquired_at, '2026-09-03T16:47:00Z', 'the caller is told WHEN the holder took it');
  assert.equal(body.lock_held_by, 'capacity_ranker');
  assert.equal(calls.apply, 0, 'nothing was applied to Five9');
  assert.equal(calls.inserted.length, 0, 'no dial_priority_log row — the run never happened');
  assert.deepEqual(calls.released, [], 'a lock we never took is never released');
});

test('LOCK: the winning run proceeds normally and RELEASES the lock afterwards', async () => {
  const { deps, calls } = fakeRun({ mode: 'live' });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(status, 200);
  assert.equal(calls.acquired, 1);
  assert.deepEqual(calls.released, ['2026-09-03T16:53:00Z'], 'released with the expires_at it acquired');
  assert.ok(body.ranking.length > 0);
});

test('LOCK: released even when the run THROWS — a crash must not wedge the next hour', async () => {
  const { deps, calls } = fakeRun({
    mode: 'live',
    insertImpl: async () => { throw new Error('dial_priority_log insert exploded'); },
  });
  await assert.rejects(
    runCapacityRanker({ slot_date: '2026-09-05' }, deps),
    /insert exploded/,
  );
  assert.deepEqual(calls.released, ['2026-09-03T16:53:00Z'], 'the finally released it anyway');
});

test('LOCK: released compare-and-set — the release carries the acquired expires_at', async () => {
  // Without this, a slow run whose lock expired and was re-taken by the NEXT
  // run would release its successor's live lock on the way out, re-opening the
  // exact race the lock exists to close.
  const released = [];
  const { deps } = fakeRun({
    mode: 'live',
    lockImpl: async () => ({ acquired: true, expires_at: '2026-09-03T17:00:00Z' }),
    releaseImpl: async (lock) => { released.push(lock); },
  });
  await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(released.length, 1);
  assert.equal(released[0].expires_at, '2026-09-03T17:00:00Z');
});

test('LOCK: FAILS OPEN — a lock backend error lets the run proceed rather than stalling the floor', async () => {
  // Consistent with tryAcquireLock itself, which returns acquired:true with
  // reason acquire_error_open when Supabase errors. A dial order that is one
  // hour stale is worse than a small race window.
  const warnings = [];
  const { deps, calls } = fakeRun({
    mode: 'live',
    lockImpl: async () => ({ acquired: true, reason: 'acquire_error_open' }),
  });
  deps.log = (m) => warnings.push(m);
  const { status } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(status, 200);
  assert.equal(calls.apply, 1, 'the run still applied');
});

test('LOCK: taken BEFORE any capacity read — a refused run does no work at all', async () => {
  const order = [];
  const { deps } = fakeRun({
    mode: 'live',
    lockHeld: true,
    lockImpl: async () => { order.push('lock'); return { acquired: false, reason: 'lock_held' }; },
  });
  deps.fetchCapacity = async () => { order.push('capacity'); return { rows: FIXTURE_2026_09_05_MERGED, stale: false, last_sweep_at: null }; };
  const { status } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(status, 409);
  assert.deepEqual(order, ['lock'], 'the capacity read never ran');
});

test('LOCK: a malformed slot_date is rejected BEFORE the lock is taken', async () => {
  const { deps, calls } = fakeRun({ mode: 'live' });
  const { status } = await runCapacityRanker({ slot_date: '09/05/2026' }, deps);
  assert.equal(status, 400);
  assert.equal(calls.acquired, 0, 'never took a lock for a request that cannot run');
  assert.deepEqual(calls.released, []);
});

test('route: the 2026-09-05 board end to end — order by confirmed %, tie on conversion, fields', async () => {
  const { deps, calls } = fakeRun({ rows: FIXTURE_2026_09_05_MERGED });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(status, 200);
  // JAX 11.8 %, SAR 25 % = STP 25 % (SAR converts better), ORL 6/18 33.3, FTM 40, FTL 50.
  assert.deepEqual(order(body.ranking), ['JAX', 'SAR', 'STPET', 'ORL', 'FTMYR', 'FTLAU']);
  assert.deepEqual(body.ranking.map((r) => r.rank), [1, 2, 3, 4, 5, 6]);
  const m = byMarket(body.ranking);
  assert.equal(m.JAX_MKT.fill_pct, 11.8);
  assert.equal(m.JAX_MKT.score, 11.8);
  assert.equal(m.JAX_MKT.still_needed, 15);
  assert.equal(m.JAX_MKT.set_pending, 14, 'reported, not ranked');
  assert.equal(Math.round(m.FTMYR_MKT.perf_multiplier * 1000) / 1000, 1.027);
  assert.equal(Math.round(m.FTMYR_MKT.set_to_sale * 1000) / 10, 14.9);
  assert.ok(!('starvation_promoted' in m.FTMYR_MKT), 'the starvation guard is retired');
  assert.equal(body.scoring_basis, 'confirmed_fill_pct');
  assert.equal(body.perf_weight, 0.25);
  assert.equal(Math.round(body.perf_baseline.set_to_sale * 1000) / 10, 13.5);
  assert.equal(calls.inserted[0].scoring_basis, 'confirmed_fill_pct');
  assert.equal(calls.inserted[0].perf_weight, 0.25);
});

test('route: a market performance outage warns, ties fall to market code, and it still answers 200', async () => {
  const { deps } = fakeRun({ rows: FIXTURE_2026_09_05_MERGED, performance: {} });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(status, 200, 'the floor still needs a dial order');
  assert.ok(body.warnings.some((w) => /market performance unavailable.*market code/.test(w)), body.warnings.join('; '));
  for (const r of body.ranking) assert.equal(r.perf_multiplier, 1);
  assert.deepEqual(order(body.ranking), ['JAX', 'SAR', 'STPET', 'ORL', 'FTMYR', 'FTLAU']);
  assert.equal(body.perf_baseline, null);
});

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
  assert.equal(body.ranking[0].market, 'FTMYR_MKT', 'Fort Myers 1 of 43 is the least filled');
  assert.equal(body.ranking[0].rank, 1);
  assert.equal(body.ranking.length, 6, 'six markets since the Lakeland merge');
  assert.equal(body.ranking[5].market, 'ORL_MKT', 'Orlando 11 of 29 is the most filled');
  assert.equal(body.ranking[5].rank, 6);
  assert.ok(!body.ranking.some((r) => r.market === 'LAKE_MKT'), 'Lakeland is never ranked');
  assert.deepEqual(body.unknown, []);
  for (const r of body.ranking) {
    for (const k of ['market', 'rank', 'fill_pct', 'still_needed', 'confirmed', 'requested', 'flags']) assert.ok(k in r, `ranking row carries ${k}`);
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
  const prev = rankOld(FIXTURE_2026_09_04_MERGED);
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

test('route: LIVE apply that reports restart_failures → applied=false, 500, CRITICAL error, row carries cycled/downtime/restart_failures', async () => {
  const { deps, calls } = fakeRun({
    mode: 'live',
    applyImpl: async () => ({
      applied: false,
      dry_run: false,
      restart_failures: [CAMPAIGNS.hot],
      campaigns: {
        hot: { cycled: true, restarted: false, downtime_ms: 8000, verified: true, written: true, changed: true },
        warm: { cycled: true, restarted: true, downtime_ms: 1500, verified: true, written: true, changed: true },
      },
    }),
  });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(status, 500);
  assert.equal(body.applied, false);
  assert.match(body.error, /CRITICAL: campaign\(s\) did not restart after reorder: Data - Hot Leads less than 7/);
  assert.equal(calls.inserted.length, 1, 'row still inserted');
  assert.equal(calls.inserted[0].applied, false);
  assert.equal(calls.inserted[0].cycled, true);
  assert.equal(calls.inserted[0].downtime_ms, 9500);
  assert.deepEqual(calls.inserted[0].restart_failures, [CAMPAIGNS.hot]);
  assert.match(calls.inserted[0].error_message, /CRITICAL/);
});

test('route: a successful cycle logs cycled=true, summed downtime_ms, restart_failures=null', async () => {
  const { deps, calls } = fakeRun({
    mode: 'live',
    applyImpl: async () => ({
      applied: true, dry_run: false, restart_failures: [],
      campaigns: {
        hot: { cycled: true, restarted: true, downtime_ms: 900 },
        warm: { cycled: true, restarted: true, downtime_ms: 1100 },
      },
    }),
  });
  const { status, body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(status, 200);
  assert.equal(body.applied, true);
  assert.equal(calls.inserted[0].cycled, true);
  assert.equal(calls.inserted[0].downtime_ms, 2000);
  assert.equal(calls.inserted[0].restart_failures, null);
});

test('route: no apply (shadow / unchanged) logs cycled=false, downtime_ms=null, restart_failures=null', async () => {
  const { deps, calls } = fakeRun({ mode: 'shadow' });
  await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
  assert.equal(calls.inserted[0].cycled, false);
  assert.equal(calls.inserted[0].downtime_ms, null);
  assert.equal(calls.inserted[0].restart_failures, null);
});

test('route: cycle flag OFF (default) → apply receives cycleCampaigns:false, no window warning', async () => {
  await withCycleEnv(undefined, async () => {
    const { deps, calls } = fakeRun({ mode: 'live' });
    const { body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
    assert.deepEqual(calls.applyOpts, [{ cycleCampaigns: false }]);
    assert.ok(!body.warnings.some((w) => /cycle window/.test(w)));
  });
});

test('route: cycle flag ON inside the window (12:48 ET) → apply receives cycleCampaigns:true', async () => {
  await withCycleEnv('true', async () => {
    const { deps, calls } = fakeRun({ mode: 'live' });
    const { body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
    assert.deepEqual(calls.applyOpts, [{ cycleCampaigns: true }]);
    assert.ok(!body.warnings.some((w) => /cycle window/.test(w)));
  });
});

test('route: cycle flag ON outside the window (20:45 ET) → cycleCampaigns:false and a warning', async () => {
  await withCycleEnv('true', async () => {
    const { deps, calls } = fakeRun({ mode: 'live', now: new Date('2026-09-04T00:45:00Z') }); // 20:45 EDT
    const { body } = await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
    assert.deepEqual(calls.applyOpts, [{ cycleCampaigns: false }]);
    assert.ok(body.warnings.some((w) => /outside the 07:00–20:30 ET cycle window/.test(w)), body.warnings.join('; '));
  });
});

test('route: cycle flag ON in SHADOW mode never calls apply', async () => {
  await withCycleEnv('true', async () => {
    const { deps, calls } = fakeRun({ mode: 'shadow' });
    await runCapacityRanker({ slot_date: '2026-09-04' }, deps);
    assert.equal(calls.apply, 0);
  });
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

// ─── Blast radius: a restart failure disables cycling for the rest of the day ─
//
// Three restart failures in one afternoon (dial_priority_log 18, 19, 24) should
// have stopped the cycling automatically after the FIRST one. A run still
// computes and logs its ranking when cycling is disabled — only the stop and
// restart are withheld.

test('DISABLE: a restart failure sets cycle_disabled_until to the end of the ET day, alerts, and 500s', async () => {
  await withCycleEnv('true', async () => {
    const { deps, calls } = fakeRun({
      mode: 'live',
      now: new Date('2026-09-04T20:18:00Z'), // 16:18 ET — the id 24 run
      applyImpl: async () => ({
        applied: false, dry_run: false, restart_failures: [CAMPAIGNS.warm],
        settle_ms: 26000, restart_attempts: 10,
        campaigns: { warm: { cycled: true, restarted: false, downtime_ms: 199717, settle_ms: 26000, restart_attempts: 10 } },
      }),
    });
    const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
    assert.equal(status, 500);
    assert.equal(calls.inserted[0].cycle_disabled_until, '2026-09-05T04:00:00.000Z', 'midnight ET, not midnight UTC');
    assert.equal(calls.inserted[0].settle_ms, 26000, 'the observed settle time is recorded');
    assert.equal(calls.inserted[0].restart_attempts, 10, 'and how many attempts it took to give up');
    assert.deepEqual(calls.inserted[0].restart_failures, [CAMPAIGNS.warm]);
    assert.equal(calls.alerts.length, 1, 'the failure is queued durably, not only logged');
    assert.deepEqual(calls.alerts[0].campaigns, [CAMPAIGNS.warm]);
    assert.match(body.warnings.join(' '), /cycling disabled until/);
  });
});

test('DISABLE: with cycle_disabled_until in the FUTURE the run still ranks and logs, but never cycles', async () => {
  await withCycleEnv('true', async () => {
    const { deps, calls } = fakeRun({
      mode: 'live',
      cycleDisabledUntil: '2026-09-04T23:59:00Z', // after the 12:48 ET run clock
    });
    const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
    assert.equal(status, 200);
    assert.ok(body.ranking.length > 0, 'the ranking is still computed');
    assert.equal(calls.inserted.length, 1, 'and still logged');
    assert.equal(calls.applyOpts[0].cycleCampaigns, false, 'but nothing is stopped');
    assert.equal(body.cycled, false);
    assert.match(body.warnings.join(' '), /cycling is DISABLED until/);
  });
});

test('DISABLE: a marker that has already PASSED does not block cycling', async () => {
  await withCycleEnv('true', async () => {
    const { deps } = fakeRun({ mode: 'live', cycleDisabledUntil: '2026-09-03T10:00:00Z' });
    const { status } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
    assert.equal(status, 200);
  });
});

test('DISABLE: an unreadable marker refuses to cycle rather than silently re-arming', async () => {
  await withCycleEnv('true', async () => {
    const { deps, calls } = fakeRun({
      mode: 'live',
      cycleDisabledImpl: async () => { throw new Error('supabase unavailable'); },
    });
    const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
    assert.equal(status, 200, 'the ranking still runs');
    assert.equal(calls.applyOpts[0].cycleCampaigns, false);
    assert.match(body.warnings.join(' '), /could not read cycle_disabled_until/);
  });
});

test('DISABLE: with the cycle flag OFF the marker is never even read', async () => {
  let reads = 0;
  const { deps } = fakeRun({ mode: 'live', cycleDisabledImpl: async () => { reads += 1; return null; } });
  await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
  assert.equal(reads, 0);
});

test('endOfDayET: the next ET midnight, in both EDT and EST', () => {
  assert.equal(endOfDayET(new Date('2026-09-04T20:18:00Z')).toISOString(), '2026-09-05T04:00:00.000Z', 'EDT, UTC-4');
  assert.equal(endOfDayET(new Date('2026-01-15T18:00:00Z')).toISOString(), '2026-01-16T05:00:00.000Z', 'EST, UTC-5');
  assert.equal(endOfDayET(new Date('2026-09-05T03:30:00Z')).toISOString(), '2026-09-05T04:00:00.000Z', '23:30 ET — half an hour left, not a whole day');
});

test('runLockTtlSec: 15 minutes by default, RANKER_LOCK_TTL_MS wins over the legacy seconds knob', () => {
  assert.equal(runLockTtlSec({}), 900, 'longer than the worst run now a restart can take ten minutes');
  assert.equal(runLockTtlSec({ RANKER_LOCK_TTL_MS: '600000' }), 600);
  assert.equal(runLockTtlSec({ CAPACITY_RANKER_LOCK_TTL_SEC: '600' }), 600, 'an existing Railway value still means something');
  assert.equal(runLockTtlSec({ RANKER_LOCK_TTL_MS: '900000', CAPACITY_RANKER_LOCK_TTL_SEC: '600' }), 900, 'the documented knob wins');
});

test('restartTuning: env overrides, with the hardened defaults when unset', () => {
  assert.deepEqual(restartTuning({}), {
    restartAttempts: 10, restartCeilingMs: 600000, stopSettleTimeoutMs: 30000,
  });
  assert.deepEqual(restartTuning({
    RANKER_RESTART_MAX_ATTEMPTS: '4', RANKER_RESTART_CEILING_MS: '120000', RANKER_STOP_SETTLE_TIMEOUT_MS: '45000',
  }), { restartAttempts: 4, restartCeilingMs: 120000, stopSettleTimeoutMs: 45000 });
  assert.deepEqual(restartTuning({ RANKER_RESTART_MAX_ATTEMPTS: 'lots', RANKER_RESTART_CEILING_MS: '0' }), {
    restartAttempts: 10, restartCeilingMs: 600000, stopSettleTimeoutMs: 30000,
  }, 'garbage and zero both fall back to the default rather than disabling retries');
});

// ─── End to end: the production incident, run through the whole route ───────

test('INCIDENT 2026-09-04: two rejected starts, then RUNNING — the run applies, logs settle_ms, and disables nothing', async () => {
  await withCycleEnv('true', async () => {
    const f = fakeFive9({ startRejectsFirst: 2, stopDrainMs: 20000, refuseWhileRunning: true });
    const { deps, calls } = fakeRun({ mode: 'live' });
    deps.apply = (rankResult, { cycleCampaigns }) => applyDialPriority(rankResult, {
      ...f.deps, cycleCampaigns, log: () => {},
      sleep: async (ms) => { f.advance(ms); },
    });
    const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
    assert.equal(status, 200, 'no 500 — the campaigns came back');
    assert.equal(body.applied, true);
    assert.equal(f.campaignState[CAMPAIGNS.hot], 'RUNNING');
    assert.equal(f.campaignState[CAMPAIGNS.warm], 'RUNNING');
    assert.equal(calls.inserted[0].restart_failures, null);
    assert.equal(calls.inserted[0].cycle_disabled_until, null, 'cycling stays armed when nothing went dark');
    assert.ok(calls.inserted[0].settle_ms >= 40000, 'both drains are recorded');
    assert.equal(calls.inserted[0].restart_attempts, 6, 'three attempts per campaign');
    assert.deepEqual(calls.alerts, [], 'nobody is paged for a restart that took a few tries');
  });
});

test('INCIDENT 2026-09-04: a campaign that never comes back → 500, named, alerted, cycling disabled for the day', async () => {
  await withCycleEnv('true', async () => {
    const f = fakeFive9({ startAlwaysFails: true });
    const { deps, calls } = fakeRun({ mode: 'live', now: new Date('2026-09-04T20:18:00Z') });
    deps.apply = (rankResult, { cycleCampaigns }) => applyDialPriority(rankResult, {
      ...f.deps, cycleCampaigns, log: () => {},
      sleep: async (ms) => { f.advance(ms); },
    });
    const { status, body } = await runCapacityRanker({ slot_date: '2026-09-05' }, deps);
    assert.equal(status, 500);
    assert.equal(body.applied, false);
    assert.match(body.error, /CRITICAL/);
    assert.deepEqual(calls.inserted[0].restart_failures, [CAMPAIGNS.hot]);
    assert.equal(calls.inserted[0].restart_attempts, DEFAULT_RESTART.maxAttempts, 'ten attempts, not three');
    assert.equal(calls.inserted[0].cycle_disabled_until, '2026-09-05T04:00:00.000Z');
    assert.equal(calls.alerts.length, 1);
    // And the peer guard held: one dark campaign never becomes two.
    assert.equal(f.campaignState[CAMPAIGNS.warm], 'RUNNING');
  });
});

// ─── /heal — the self-healing sweeper ───────────────────────────────────────
//
// The finally block cannot survive a process death between stop and start, and
// retries can genuinely exhaust. Either way a campaign is left NOT_RUNNING and
// nothing in the run comes back for it — on 2026-09-04 that was two hours.
// The watchdog that already DETECTS now also REPAIRS.

function fakeHeal({
  restartFailures = [CAMPAIGNS.warm], states = { [CAMPAIGNS.warm]: 'NOT_RUNNING' },
  sourceId = 24, startWorks = true, sourceRow = undefined,
  // Cycling ARMED by default: these cases exercise the repair path. The
  // observe-only path is gated on this and has its own tests below.
  cycleOn = true, attemptsToday = [], maxPerDay = 2, attemptsThrow = false,
} = {}) {
  const campaignState = { [CAMPAIGNS.hot]: 'RUNNING', ...states };
  const calls = { starts: [], inserted: [], healed: [], alerts: [], conditions: [] };
  const deps = {
    log: () => {},
    now: new Date('2026-09-04T20:25:00Z'),
    sleep: async () => {},
    actionEnabled: () => cycleOn,
    maxPerDay,
    readHealAttemptsToday: async () => {
      if (attemptsThrow) throw new Error('supabase unavailable');
      return attemptsToday;
    },
    report: async (c) => { calls.conditions.push(c); return { sent: c.active === true }; },
    readLastRestartFailure: async () => (sourceRow !== undefined
      ? sourceRow
      : { id: sourceId, ran_at: '2026-09-04T20:18:27Z', restart_failures: restartFailures, healed_at: null }),
    getOutbound: async (name) => ({ name, state: campaignState[name] ?? null }),
    startCampaign: async (action) => {
      const name = action.action_payload.campaign_name;
      calls.starts.push(name);
      assert.equal(action.action_type, 'five9_start_campaign');
      if (startWorks) campaignState[name] = 'RUNNING';
      return { campaign: name, method: 'startCampaign' };
    },
    insertLog: async (row) => { calls.inserted.push(row); return 99; },
    markHealed: async (id, at) => { calls.healed.push([id, at]); },
    sendAlert: async (text) => { calls.alerts.push(text); },
  };
  return { deps, calls, campaignState };
}

test('HEAL: a campaign left NOT_RUNNING is started, verified, and stamped healed_at', async () => {
  const { deps, calls, campaignState } = fakeHeal();
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.equal(body.outcome, 'healed');
  assert.deepEqual(body.healed, [CAMPAIGNS.warm]);
  assert.deepEqual(calls.starts, [CAMPAIGNS.warm], 'exactly one start');
  assert.equal(campaignState[CAMPAIGNS.warm], 'RUNNING', 'the floor is dialing it again');
  assert.deepEqual(calls.healed, [[24, '2026-09-04T20:25:00.000Z']], 'the row that recorded the failure is closed out');
  assert.equal(calls.inserted[0].mode, 'heal', 'the outcome row never mixes with ranking runs');
  assert.equal(calls.inserted[0].healed_at, '2026-09-04T20:25:00.000Z');
  assert.equal(calls.inserted[0].restart_failures, null);
  assert.equal(calls.alerts.length, 1, 'and somebody is told');
  assert.match(calls.alerts[0], /restarted/);
});

test('HEAL: IDEMPOTENT — a second call against an already RUNNING campaign is a silent no-op', async () => {
  const { deps, calls } = fakeHeal({ states: { [CAMPAIGNS.warm]: 'RUNNING' } });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(calls.starts, [], 'never starts what is already up');
  assert.deepEqual(body.already_running, [CAMPAIGNS.hot, CAMPAIGNS.warm], 'BOTH campaigns are checked, not just the one the failure row named');
  assert.deepEqual(body.swept, [CAMPAIGNS.hot, CAMPAIGNS.warm]);
  assert.equal(body.no_op, true);
  assert.equal(body.outcome, 'noop', 'a sweep that started nothing did not HEAL anything');
  assert.equal(body.log_id, null);
  assert.deepEqual(calls.inserted, [], 'and it writes no row — the watchdog calls this every 5 minutes for as long as ANY campaign is down, and one junk row per poll buries the rows that matter');
  assert.deepEqual(calls.alerts, [], 'a healthy sweep every 5 minutes must not become a 5-minute alarm');
  assert.deepEqual(calls.healed, [], 'nothing to close out');
});

test('HEAL: no failure row and everything RUNNING → no-op, 200, no Five9 write', async () => {
  const { deps, calls } = fakeHeal({
    sourceRow: null,
    states: { [CAMPAIGNS.hot]: 'RUNNING', [CAMPAIGNS.warm]: 'RUNNING' },
  });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.equal(body.no_op, true);
  assert.equal(body.source_log_id, null);
  assert.deepEqual(calls.starts, []);
  assert.deepEqual(calls.inserted, [], 'no outcome row for a sweep that had nothing to do');
});

// ─── THE SCOPING GAP: the failure row says WHY, not WHAT ────────────────────
//
// The sweep used to be limited to the campaigns named in the newest
// restart_failures row. Two holes, both of them the exact shape of the incident
// this sweeper exists for.

test('HEAL GAP: a peer left dark by a PROCESS DEATH is healed, even though the failure row names the other campaign', async () => {
  // dial_priority_log 24 names Warm. Warm recovered; HOT then died between stop
  // and start, which writes no row at all. The old sweep looked only at Warm
  // and walked past a dark Hot campaign.
  const { deps, calls, campaignState } = fakeHeal({
    restartFailures: [CAMPAIGNS.warm],
    states: { [CAMPAIGNS.hot]: 'NOT_RUNNING', [CAMPAIGNS.warm]: 'RUNNING' },
  });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(body.healed, [CAMPAIGNS.hot], 'the campaign NOBODY logged is the one that needed healing');
  assert.deepEqual(body.already_running, [CAMPAIGNS.warm]);
  assert.equal(campaignState[CAMPAIGNS.hot], 'RUNNING');
  assert.deepEqual(calls.healed, [], 'healed_at is NOT stamped on row 24 — it named Warm, and Warm was never the problem');
});

test('HEAL GAP: NO failure row at all and both campaigns dark → both are healed', async () => {
  // A process death mid-cycle writes nothing. Live state is the only witness.
  const { deps, campaignState } = fakeHeal({
    sourceRow: null,
    states: { [CAMPAIGNS.hot]: 'NOT_RUNNING', [CAMPAIGNS.warm]: 'NOT_RUNNING' },
  });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(body.healed, [CAMPAIGNS.hot, CAMPAIGNS.warm]);
  assert.equal(body.source_log_id, null, 'no row to point at, and it heals anyway');
  assert.equal(campaignState[CAMPAIGNS.hot], 'RUNNING');
  assert.equal(campaignState[CAMPAIGNS.warm], 'RUNNING');
});

test('HEAL GAP: healed_at IS stamped when the healed campaign is one the row named', async () => {
  const { deps, calls } = fakeHeal({
    restartFailures: [CAMPAIGNS.warm],
    states: { [CAMPAIGNS.hot]: 'RUNNING', [CAMPAIGNS.warm]: 'NOT_RUNNING' },
  });
  const { body } = await healCampaigns(deps);
  assert.deepEqual(body.healed, [CAMPAIGNS.warm]);
  assert.deepEqual(calls.healed, [[24, '2026-09-04T20:25:00.000Z']], 'that incident really is closed out');
});

test('HEAL GAP: a campaign the ranker is CYCLING right now is left alone', async () => {
  // NOT_RUNNING on purpose, for a few seconds, with the list write still to
  // land. Starting it here would break the reorder mid-flight — the run's own
  // finally block owns that restart.
  const { deps, calls, campaignState } = fakeHeal({
    states: { [CAMPAIGNS.hot]: 'NOT_RUNNING', [CAMPAIGNS.warm]: 'RUNNING' },
  });
  deps.cycling = (name) => name === CAMPAIGNS.hot;
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(calls.starts, [], 'never fired a start into a live cycle');
  assert.deepEqual(body.cycling, [CAMPAIGNS.hot]);
  assert.deepEqual(body.healed, []);
  assert.equal(body.no_op, true, 'and it is not an incident');
  assert.equal(campaignState[CAMPAIGNS.hot], 'NOT_RUNNING', 'left exactly as the run left it');
});

test('HEAL: a campaign that still will not start → 503, heal_failed, and a loud alert', async () => {
  const { deps, calls } = fakeHeal({ startWorks: false });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 503, 'the n8n execution goes red so a human looks');
  assert.equal(body.outcome, 'heal_failed');
  assert.equal(body.failed[0].campaign, CAMPAIGNS.warm);
  assert.deepEqual(calls.healed, [], 'healed_at is NOT stamped on a failure');
  assert.deepEqual(calls.inserted[0].restart_failures, [CAMPAIGNS.warm]);
  assert.match(calls.alerts[0], /HEAL FAILED/);
});

// 2026-09-28 — dial_priority_log 429, 430, 433: three "HEAL FAILED … STILL not
// RUNNING" cards in one afternoon for campaigns that were dialing the whole
// time. Five9 simply did not answer a status read. "Could not tell" is not
// "down", so it is not a failed restart, writes no restart_failures (which the
// next heal would read as a new incident) and posts no failure card.
test('HEAL: an UNREADABLE campaign is reported, never guessed at — and never called down', async () => {
  const { deps, calls } = fakeHeal({ states: { [CAMPAIGNS.warm]: null } });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200, 'nothing is known to be down, so the n8n execution stays green');
  assert.equal(body.outcome, 'unreadable');
  assert.deepEqual(body.failed, []);
  assert.equal(body.unreadable[0].campaign, CAMPAIGNS.warm);
  assert.match(body.unreadable[0].error, /UNREADABLE after 3 reads \(Five9 returned no state\)/);
  assert.deepEqual(calls.starts, [], 'a campaign we cannot see is not a campaign we start');
  assert.deepEqual(calls.inserted, [], 'no outcome row, so no restart_failures for the next heal to chase');
  assert.ok(!calls.alerts.some((t) => /HEAL FAILED|STILL not RUNNING/.test(t)), 'no false failure card');
});

test('HEAL: a read that fails once and then answers is not UNREADABLE', async () => {
  const { deps, calls } = fakeHeal({ states: { [CAMPAIGNS.warm]: 'RUNNING' } });
  let reads = 0;
  const real = deps.getOutbound;
  deps.getOutbound = async (name) => {
    if (name === CAMPAIGNS.warm && reads++ === 0) throw new Error('SOAP fault: connection reset');
    return real(name);
  };
  const logs = [];
  deps.log = (m) => logs.push(m);
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(body.unreadable, []);
  assert.ok(body.already_running.includes(CAMPAIGNS.warm));
  assert.deepEqual(calls.starts, []);
  assert.ok(logs.some((m) => /Five9 state read for Data - Warm Leads less than 30 failed \(attempt 1\/3\): SOAP fault: connection reset/.test(m)),
    'the reason Five9 did not answer is logged, not swallowed');
});

test('HEAL: a confirmed-down campaign that will not start still fails loudly (no regression)', async () => {
  const { deps, calls } = fakeHeal({ startWorks: false });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 503);
  assert.equal(body.outcome, 'heal_failed');
  assert.deepEqual(body.unreadable, []);
  assert.match(calls.alerts[0], /HEAL FAILED: Data - Warm Leads less than 30 is STILL not RUNNING/);
});

test('HEAL: both campaigns named → both handled, and one outcome row covers the sweep', async () => {
  const { deps, calls } = fakeHeal({
    restartFailures: [CAMPAIGNS.hot, CAMPAIGNS.warm],
    states: { [CAMPAIGNS.hot]: 'NOT_RUNNING', [CAMPAIGNS.warm]: 'NOT_RUNNING' },
  });
  const { body } = await healCampaigns(deps);
  assert.deepEqual(body.healed, [CAMPAIGNS.hot, CAMPAIGNS.warm]);
  assert.deepEqual(calls.starts, [CAMPAIGNS.hot, CAMPAIGNS.warm]);
  assert.equal(calls.inserted.length, 1);
});

// ─── The heal action gate and the flap guard ────────────────────────────────
//
// 2026-09-04, ~22:05 and ~22:15 UTC: Warm went NOT_RUNNING twice in ten minutes
// with cycling OFF — so no failed cycle could have caused either — and heal
// restarted it both times, at three GroupMe cards a round. Heal cannot tell
// "dark because our cycle failed" from "Five9 stopped it for its own reasons".
//
// The fix gates the ACTION, never the OBSERVATION: going quiet would trade a
// restart loop for the failure PR #844 exists to prevent.

test('GATE: cycling OFF → heal does not restart, but STILL reports the dark campaign', async () => {
  const { deps, calls, campaignState } = fakeHeal({ cycleOn: false });
  const { status, body } = await healCampaigns(deps);

  assert.deepEqual(calls.starts, [], 'no restart: the ranker never stopped it, so this outage is not heal\'s to fix');
  assert.equal(campaignState[CAMPAIGNS.warm], 'NOT_RUNNING', 'left exactly as Five9 had it');

  // ...and the observation is LOUD, which is the whole amendment.
  assert.equal(status, 503, 'a campaign is still dark — the n8n execution must go red');
  assert.equal(body.may_act, false);
  assert.equal(body.stood_down[0].campaign, CAMPAIGNS.warm);
  assert.equal(body.stood_down[0].state, 'NOT_RUNNING');
  assert.match(body.stood_down[0].reason, /CAPACITY_RANKER_CYCLE_CAMPAIGNS is false/);
  const fired = calls.conditions.filter((c) => c.active === true);
  assert.equal(fired.length, 1, 'exactly one condition opened');
  assert.match(fired[0].text, /is NOT_RUNNING during dial hours and heal will NOT restart it/);
  assert.match(fired[0].text, /out of dialable records/, 'the card names the likeliest cause, so it is actionable at 6pm');
  assert.equal(fired[0].key, `capacity_ranker:heal_not_acting:${CAMPAIGNS.warm}`);
  // 2026-10-02 (Mark, alert noise cut): outages post on state change only — no reminder.
  assert.equal(fired[0].remindMs, 0, 'no re-remind while the campaign stays dark');
});

test('GATE: force:true overrides it for a deliberate manual repair', async () => {
  const { deps, calls, campaignState } = fakeHeal({ cycleOn: false });
  deps.force = true;
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(body.healed, [CAMPAIGNS.warm]);
  assert.deepEqual(calls.starts, [CAMPAIGNS.warm]);
  assert.equal(campaignState[CAMPAIGNS.warm], 'RUNNING');
});

test('GATE: cycling off and everything RUNNING is still a clean no-op', async () => {
  const { deps, calls } = fakeHeal({
    cycleOn: false,
    states: { [CAMPAIGNS.hot]: 'RUNNING', [CAMPAIGNS.warm]: 'RUNNING' },
  });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.equal(body.no_op, true);
  assert.deepEqual(body.stood_down, []);
  assert.deepEqual(calls.inserted, [], 'nothing happened, so nothing is logged');
});

test('FLAP CAP: at the cap heal stands down — ONE alert, no further restarts', async () => {
  // Warm already restarted twice today. This is the third time it has gone down.
  const { deps, calls, campaignState } = fakeHeal({
    attemptsToday: [CAMPAIGNS.warm, CAMPAIGNS.warm], maxPerDay: 2,
  });
  const { status, body } = await healCampaigns(deps);

  assert.deepEqual(calls.starts, [], 'a third restart is fighting whatever keeps stopping it');
  assert.equal(campaignState[CAMPAIGNS.warm], 'NOT_RUNNING');
  assert.equal(status, 503);
  assert.equal(body.outcome, 'stood_down');
  assert.equal(body.stood_down[0].attempts_today, 2);
  assert.match(body.stood_down[0].reason, /already restarted this campaign 2x today/);

  const fired = calls.conditions.filter((c) => c.active === true);
  assert.equal(fired.length, 1, 'exactly one alert, not one per poll');
  assert.match(fired[0].detail, /attempts_today=2 cap=2/);
  // Edge-triggered: a second identical sweep opens the same condition, and
  // alert-state — not this code — decides it has already been said.
  assert.equal(fired[0].key, healStandDownKey(CAMPAIGNS.warm));
});

test('FLAP CAP: BELOW the cap it still heals, and records the attempt durably', async () => {
  const { deps, calls, campaignState } = fakeHeal({ attemptsToday: [CAMPAIGNS.warm], maxPerDay: 2 });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(body.healed, [CAMPAIGNS.warm], 'second restart of the day is still allowed');
  assert.equal(campaignState[CAMPAIGNS.warm], 'RUNNING');
  assert.deepEqual(calls.inserted[0].heal_attempted, [CAMPAIGNS.warm],
    'the attempt is written to dial_priority_log — that row IS tomorrow\'s budget memory');
});

test('FLAP CAP: a FAILED attempt spends budget too', async () => {
  const { deps, calls } = fakeHeal({ startWorks: false, attemptsToday: [], maxPerDay: 2 });
  await healCampaigns(deps);
  assert.deepEqual(calls.inserted[0].heal_attempted, [CAMPAIGNS.warm],
    'a heal that tried and failed must not get a free retry every 5 minutes');
});

test('FLAP CAP: the cap RESETS the next day — yesterday\'s attempts are not counted', async () => {
  // The counter query is bounded by startOfDayET, so a new ET day reads zero
  // attempts. Proven here through the boundary itself.
  const lateYesterday = new Date('2026-09-04T23:30:00Z');   // 19:30 ET Sep 4
  const earlyToday = new Date('2026-09-05T12:00:00Z');      // 08:00 ET Sep 5
  assert.equal(todayET(lateYesterday), '2026-09-04');
  assert.equal(todayET(earlyToday), '2026-09-05');
  assert.ok(startOfDayET(earlyToday) > lateYesterday,
    'the new day\'s window opens AFTER yesterday\'s attempts, so they fall out of the count');

  // And with an empty count the campaign heals again, cap or no cap yesterday.
  const { deps, calls } = fakeHeal({ attemptsToday: [], maxPerDay: 2 });
  deps.now = earlyToday;
  const { body } = await healCampaigns(deps);
  assert.deepEqual(body.healed, [CAMPAIGNS.warm]);
  assert.deepEqual(calls.starts, [CAMPAIGNS.warm]);
});

test('FLAP CAP: an unreadable counter FAILS OPEN — a dark campaign beats a duplicate restart', async () => {
  const { deps, calls, campaignState } = fakeHeal({ attemptsThrow: true });
  const { status, body } = await healCampaigns(deps);
  assert.equal(status, 200);
  assert.deepEqual(calls.starts, [CAMPAIGNS.warm], 'still repaired');
  assert.equal(campaignState[CAMPAIGNS.warm], 'RUNNING');
  assert.match(body.heal_budget.counter_unreadable, /supabase unavailable/, 'and it says the budget was unknown');
});

test('STAND-DOWN: the condition CLEARS when the campaign comes back', async () => {
  const { deps, calls } = fakeHeal({
    states: { [CAMPAIGNS.hot]: 'RUNNING', [CAMPAIGNS.warm]: 'RUNNING' },
  });
  await healCampaigns(deps);
  const cleared = calls.conditions.filter((c) => c.active === false).map((c) => c.key);
  assert.ok(cleared.includes(healStandDownKey(CAMPAIGNS.warm)), 'so tomorrow\'s first stand-down pages again');
  assert.ok(cleared.includes(healStandDownKey(CAMPAIGNS.hot)));
});

test('STAND-DOWN: a successful heal also clears the condition', async () => {
  const { deps, calls } = fakeHeal();
  await healCampaigns(deps);
  const cleared = calls.conditions.filter((c) => c.active === false).map((c) => c.key);
  assert.ok(cleared.includes(healStandDownKey(CAMPAIGNS.warm)));
});

test('healMaxPerDay: default 2, env-tunable, garbage falls back', () => {
  assert.equal(healMaxPerDay(undefined), 2);
  assert.equal(healMaxPerDay('4'), 4);
  assert.equal(healMaxPerDay('nope'), 2);
  assert.equal(healMaxPerDay('0'), 2, 'zero would disable heal entirely — that is what the cycling gate is for');
});

test('startOfDayET: ET midnight in both EDT and EST', () => {
  assert.equal(startOfDayET(new Date('2026-09-04T20:18:00Z')).toISOString(), '2026-09-04T04:00:00.000Z');
  assert.equal(startOfDayET(new Date('2026-01-15T18:00:00Z')).toISOString(), '2026-01-15T05:00:00.000Z');
  assert.equal(startOfDayET(new Date('2026-09-04T03:00:00Z')).toISOString(), '2026-09-03T04:00:00.000Z',
    '23:00 ET is still the PREVIOUS ET day');
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

test('CAPACITY_RANKER_SWAP_MARGIN_PCT: default 0 POINTS, unparseable falls back', () => {
  // 2026-10-15: the margin is a fill gap in percentage points. A new env name,
  // because CAPACITY_RANKER_SWAP_MARGIN held SLOTS under the open-slot scoring.
  assert.equal(DEFAULT_SWAP_MARGIN, 0);
  assert.equal(resolveSwapMargin(undefined), 0);
  assert.equal(resolveSwapMargin('1.5'), 1.5);
  assert.equal(resolveSwapMargin('0'), 0);
  assert.equal(resolveSwapMargin('abc'), 0);
  assert.equal(resolveSwapMargin('-1'), 0);
  const saved = { old: process.env.CAPACITY_RANKER_SWAP_MARGIN, pct: process.env.CAPACITY_RANKER_SWAP_MARGIN_PCT };
  try {
    process.env.CAPACITY_RANKER_SWAP_MARGIN = '0.5';
    delete process.env.CAPACITY_RANKER_SWAP_MARGIN_PCT;
    assert.equal(resolveSwapMargin(), 0, 'the old slot-unit variable is never read');
    process.env.CAPACITY_RANKER_SWAP_MARGIN_PCT = '2';
    assert.equal(resolveSwapMargin(), 2);
  } finally {
    for (const [k, v] of [['CAPACITY_RANKER_SWAP_MARGIN', saved.old], ['CAPACITY_RANKER_SWAP_MARGIN_PCT', saved.pct]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('CAPACITY_RANKER_CYCLE_CAMPAIGNS: default false; only the literal "true" arms cycling', () => {
  assert.equal(cycleEnabled(undefined), false);
  assert.equal(cycleEnabled(''), false);
  assert.equal(cycleEnabled('false'), false);
  assert.equal(cycleEnabled('1'), false);
  assert.equal(cycleEnabled('on'), false);
  assert.equal(cycleEnabled('true'), true);
  assert.equal(cycleEnabled(' TRUE '), true);
});

test('withinCycleWindow: TRUE at 07:15 ET — the baseline run must no longer be refused', () => {
  // The 07:15 run is the first and largest ranking of each day, for a new
  // slot_date, and the 08:00 lower bound refused it every single morning
  // (dial_priority_log row 12: changed=true, REFUSED). 07:15 is also the
  // SAFEST time to cycle — campaign profiles dial 08:00–21:00, so the
  // campaigns are RUNNING but not dialing and the downtime is free.
  assert.equal(withinCycleWindow(new Date('2026-09-03T11:15:00Z')), true, '07:15 ET');
  assert.equal(withinCycleWindow(new Date('2026-09-03T11:30:00Z')), true, '07:30 ET');
  assert.equal(withinCycleWindow(new Date('2026-09-03T16:00:00Z')), true, '12:00 ET');
});

test('withinCycleWindow: FALSE at 06:45 and 20:45 ET', () => {
  assert.equal(withinCycleWindow(new Date('2026-09-03T10:45:00Z')), false, '06:45 ET');
  assert.equal(withinCycleWindow(new Date('2026-09-04T00:45:00Z')), false, '20:45 ET');
});

test('withinCycleWindow: edges — 07:00 and 20:30 ET are inside, 06:59 and 20:31 are outside', () => {
  assert.equal(withinCycleWindow(new Date('2026-09-03T11:00:00Z')), true, '07:00 ET');
  assert.equal(withinCycleWindow(new Date('2026-09-03T10:59:00Z')), false, '06:59 ET');
  assert.equal(withinCycleWindow(new Date('2026-09-04T00:30:00Z')), true, '20:30 ET — upper bound UNCHANGED');
  assert.equal(withinCycleWindow(new Date('2026-09-04T00:31:00Z')), false, '20:31 ET');
});

test('withinCycleWindow: honours America/New_York in winter too (EST, UTC-5)', () => {
  assert.equal(withinCycleWindow(new Date('2026-01-15T12:15:00Z')), true, '07:15 EST');
  assert.equal(withinCycleWindow(new Date('2026-01-15T12:00:00Z')), true, '07:00 EST');
  assert.equal(withinCycleWindow(new Date('2026-01-15T11:59:00Z')), false, '06:59 EST');
  assert.equal(withinCycleWindow(new Date('2026-01-16T01:31:00Z')), false, '20:31 EST');
});

// ─── Campaign watchdog (LP-MCP sends the alert; n8n only polls) ──────────────
//
// The alert lives here because GROUPME_BOT_ID is set on LP-MCP and on NEITHER
// n8n service. The first cut had n8n read $env.GROUPME_BOT_ID, which posted
// with no bot id and was rejected — silently, since the node continues on
// error. A watchdog that reports healthy while the floor is dark is the exact
// failure it exists to catch, so these tests pin the alert to this side.

/**
 * In-memory stand-in for src/alert-state.js, modelling the contract the route
 * depends on: one card per incident, a recovery only if the incident was
 * actually announced, and `active: null` touching nothing at all. The real
 * module's own edges (the PK claim, the CAS, the fallback cooldown) are
 * covered in scripts/test-alert-state.js; what is pinned HERE is that the
 * watchdog hands it the right tri-state and the right key.
 *
 * `store` is shareable so a test can carry one condition across two fixtures.
 */
function alertStateStore() {
  return { rows: new Map(), sent: [] };
}

function makeReport(store, { sendThrows = false } = {}) {
  return async ({ key, active, label, text, recoveredText, send }) => {
    if (active === null || active === undefined) return { action: 'noop', sent: false };
    const emit = async (body) => {
      try {
        await send(body);
        store.sent.push(body);
        return true;
      } catch {
        return false;
      }
    };
    const row = store.rows.get(key);
    if (active) {
      if (row && row.state === 'firing') return { action: 'silent', sent: false };
      const next = { state: 'firing', notifyCount: 0 };
      store.rows.set(key, next);
      const body = typeof text === 'function' ? await text() : text;
      const ok = await emit(body);
      if (ok) next.notifyCount = 1;
      return { action: 'fired', sent: ok };
    }
    if (!row || row.state !== 'firing') return { action: 'idle', sent: false };
    row.state = 'cleared';
    if (!(row.notifyCount > 0)) return { action: 'recovered', sent: false };
    const body = recoveredText ?? `✅ RECOVERED — ${label}`;
    return { action: 'recovered', sent: await emit(body) };
  };
}

function watchdogFake({ states = { hot: 'RUNNING', warm: 'RUNNING' }, throwFor = null, sendThrows = false, cyclingNames = [], store = alertStateStore() } = {}) {
  const sent = store.sent;
  return {
    sent,
    store,
    deps: {
      report: makeReport(store, { sendThrows }),
      log: () => {},
      sleep: async () => {},
      inWindow: () => true,
      cycling: (name) => cyclingNames.includes(name),
      getOutbound: async (name) => {
        if (throwFor && name === throwFor) throw new Error('Five9 getOutboundCampaign fault');
        const tier = name === CAMPAIGNS.hot ? 'hot' : 'warm';
        return { name, state: states[tier], lists: [] };
      },
      sendAlert: async () => {
        if (sendThrows) throw new Error('GroupMe 400');
      },
    },
  };
}

test('WATCHDOG: both RUNNING → 200, nothing sent', async () => {
  const f = watchdogFake();
  const { status, body } = await checkCampaignState(f.deps);
  assert.equal(status, 200);
  assert.equal(body.all_running, true);
  assert.deepEqual(f.sent, [], 'a healthy floor pages nobody');
  assert.deepEqual(body.alerted, []);
});

test('WATCHDOG: a stopped campaign → 503 AND the GroupMe alert goes out from LP-MCP', async () => {
  const f = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' } });
  const { status, body } = await checkCampaignState(f.deps);
  assert.equal(status, 503);
  assert.equal(body.all_running, false);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /CAPACITY RANKER: Data - Warm Leads less than 30 is NOT_RUNNING during dial hours/);
  assert.match(f.sent[0], /Check Five9 now/);
  assert.deepEqual(body.alerted, [CAMPAIGNS.warm]);
  assert.ok(!f.sent.some((t) => t.includes(CAMPAIGNS.hot)), 'the healthy campaign is not named');
});

test('WATCHDOG: an unreadable campaign alerts too — "cannot confirm" is not "fine"', async () => {
  const f = watchdogFake({ throwFor: CAMPAIGNS.hot });
  const { status, body } = await checkCampaignState(f.deps);
  assert.equal(status, 503);
  assert.match(f.sent[0], /Data - Hot Leads less than 7 is UNREADABLE during dial hours/);
  // 2026-09-28 — but it says what we know: Five9 did not answer. It no longer
  // claims the floor is not dialing, which was false every time on 2026-09-28.
  assert.match(f.sent[0], /did not answer 3 status checks in a row, so the floor may not be dialing it/);
  assert.doesNotMatch(f.sent[0], /floor is not dialing it/);
  const hot = body.campaigns.find((c) => c.campaign === CAMPAIGNS.hot);
  assert.equal(hot.state, null);
  assert.match(hot.read_error, /Five9 getOutboundCampaign fault/, 'the reason travels with the result');
});

test('WATCHDOG: one failed read that then answers RUNNING pages nobody (2026-09-28)', async () => {
  const f = watchdogFake();
  let hotReads = 0;
  const real = f.deps.getOutbound;
  f.deps.getOutbound = async (name) => {
    if (name === CAMPAIGNS.hot && hotReads++ === 0) throw new Error('Five9 getOutboundCampaign fault');
    return real(name);
  };
  const logs = [];
  f.deps.log = (m) => logs.push(m);
  const { status, body } = await checkCampaignState(f.deps);
  assert.equal(status, 200);
  assert.equal(body.all_running, true, 'so the n8n watchdog does not call heal either');
  assert.deepEqual(f.sent, [], 'a single blip is not evidence');
  assert.ok(logs.some((m) => /Five9 state read for Data - Hot Leads less than 7 failed \(attempt 1\/3\)/.test(m)));
});

test('HEAL SOURCE: a heal row is never the source of the next heal (2026-09-28 chain 331 → 429 → 430 → 433)', async () => {
  const calls = [];
  const builder = {
    from(t) { calls.push(['from', t]); return this; },
    select(c) { calls.push(['select', c]); return this; },
    not(c, op, v) { calls.push(['not', c, op, v]); return this; },
    neq(c, v) { calls.push(['neq', c, v]); return this; },
    order(c, o) { calls.push(['order', c, o]); return this; },
    limit(n) { calls.push(['limit', n]); return Promise.resolve({ data: [{ id: 428 }], error: null }); },
  };
  const row = await readLastRestartFailureLive(builder);
  assert.deepEqual(row, { id: 428 });
  assert.ok(calls.some((c) => c[0] === 'neq' && c[1] === 'mode' && c[2] === 'heal'), 'mode=heal rows are excluded');
  assert.ok(calls.some((c) => c[0] === 'not' && c[1] === 'restart_failures'), 'still only rows that recorded a failure');
});

test('readCampaignState: retries on throw or empty state, then gives up with the last reason', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const answers = [new Error('timeout'), { state: '' }, { state: 'RUNNING' }];
  const ok = await readCampaignState(async () => {
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a;
  }, 'X', { sleep, log: () => {} });
  assert.deepEqual(ok, { state: 'RUNNING', error: null, attempts: 3 });
  assert.deepEqual(slept, [2000, 4000]);

  const dead = await readCampaignState(async () => { throw new Error('SOAP 500'); }, 'X', { sleep: async () => {}, log: () => {} });
  assert.deepEqual(dead, { state: null, error: 'SOAP 500', attempts: 3 });
});

test('readCampaignState: a SLOW failure (a timeout) is not retried past the budget — the watchdog has 30s', async () => {
  let t = 0;
  let reads = 0;
  const r = await readCampaignState(async () => {
    reads += 1;
    t += 20000; // one Five9 SOAP timeout
    throw new Error('Five9 admin API timeout after 20000ms (getOutboundCampaign)');
  }, 'X', { sleep: async (ms) => { t += ms; }, clock: () => t, log: () => {} });
  assert.equal(reads, 1, 'one timeout already used the budget');
  assert.equal(r.state, null);
  assert.equal(r.attempts, 1);
  assert.match(r.error, /timeout/);
});

test('WATCHDOG: both down → both named, one message each', async () => {
  const f = watchdogFake({ states: { hot: 'NOT_RUNNING', warm: 'NOT_RUNNING' } });
  const { body } = await checkCampaignState(f.deps);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(body.alerted, [CAMPAIGNS.hot, CAMPAIGNS.warm]);
});

test('WATCHDOG: one continuous outage is ONE card, however long it runs', async () => {
  // The 2026-09-04 defect. The old 30-minute re-alert paged 4x in 90 minutes
  // for two campaigns that never came back up in between, and a channel that
  // repeats itself is a channel people mute.
  const f = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' } });
  const t0 = new Date('2026-09-03T16:00:00Z');
  for (const min of [0, 5, 29, 31, 90, 240]) {
    await checkCampaignState({ ...f.deps, now: new Date(t0.getTime() + min * 60000) });
  }
  assert.equal(f.sent.length, 1, 'still the same outage — say it once');
});

test('WATCHDOG: a changing Five9 state is still ONE outage, not three', async () => {
  // Five9 reported one continuous outage as UNREADABLE, then NOT_RUNNING, then
  // STOPPING. The old alert keyed on that string, so one dead campaign read as
  // three separate problems. The key must carry no live state.
  const store = alertStateStore();
  const t0 = new Date('2026-09-03T16:00:00Z');
  const seq = [
    watchdogFake({ throwFor: CAMPAIGNS.hot, store }),                                  // UNREADABLE
    watchdogFake({ states: { hot: 'NOT_RUNNING', warm: 'RUNNING' }, store }),
    watchdogFake({ states: { hot: 'STOPPING', warm: 'RUNNING' }, store }),
  ];
  for (const [i, f] of seq.entries()) {
    await checkCampaignState({ ...f.deps, now: new Date(t0.getTime() + i * 60000) });
  }
  assert.equal(store.sent.length, 1, 'one campaign down is one condition, whatever Five9 calls it');
  assert.match(store.sent[0], /is UNREADABLE during dial hours/, 'the first observed state is the one reported');
});

test('WATCHDOG: recovery is announced exactly once', async () => {
  const store = alertStateStore();
  const t0 = new Date('2026-09-03T16:00:00Z');
  const down = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' }, store });
  await checkCampaignState({ ...down.deps, now: t0 });
  assert.equal(store.sent.length, 1);

  const healthy = watchdogFake({ store });
  await checkCampaignState({ ...healthy.deps, now: new Date(t0.getTime() + 60000) });
  await checkCampaignState({ ...healthy.deps, now: new Date(t0.getTime() + 120000) });
  assert.equal(store.sent.length, 2, 'one recovery card, and the second healthy sweep is silent');
  assert.match(store.sent[1], /RECOVERED/);
  assert.match(store.sent[1], new RegExp(CAMPAIGNS.warm));
});

test('WATCHDOG: a fresh outage after a recovery alerts immediately', async () => {
  // Silence must be scoped to ONE incident. A campaign that recovers and dies
  // again two minutes later is news, and must not inherit the first outage's
  // silence.
  const store = alertStateStore();
  const t0 = new Date('2026-09-03T16:00:00Z');
  const down = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' }, store });
  const healthy = watchdogFake({ store });

  await checkCampaignState({ ...down.deps, now: t0 });
  await checkCampaignState({ ...healthy.deps, now: new Date(t0.getTime() + 60000) });
  await checkCampaignState({ ...down.deps, now: new Date(t0.getTime() + 120000) });

  assert.equal(store.sent.length, 3, 'outage, recovery, second outage');
  assert.match(store.sent[2], /is NOT_RUNNING during dial hours/);
});

test('WATCHDOG: outside dial hours it neither pages NOR announces a recovery', async () => {
  // A campaign that dies at 22:00 and is still dead at 08:00 must page once at
  // 08:00. It must not "recover" at 22:01 just because nobody is listening —
  // that would be a false all-clear on a floor that is still dark.
  const store = alertStateStore();
  const t0 = new Date('2026-09-03T16:00:00Z');
  const down = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' }, store });
  await checkCampaignState({ ...down.deps, now: t0 });
  assert.equal(store.sent.length, 1);

  const healthy = watchdogFake({ store });
  await checkCampaignState({ ...healthy.deps, inWindow: () => false, now: new Date(t0.getTime() + 60000) });
  assert.equal(store.sent.length, 1, 'no recovery card at 3am');

  await checkCampaignState({ ...down.deps, now: new Date(t0.getTime() + 120000) });
  assert.equal(store.sent.length, 1, 'and the outage is still held — it was never cleared');
});

test('WATCHDOG: outside the window → still 503, but nobody is paged at 3am', async () => {
  const f = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' } });
  const { status, body } = await checkCampaignState({ ...f.deps, inWindow: () => false });
  assert.equal(status, 503, 'the state is still reported honestly');
  assert.equal(body.alert_window_open, false);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(body.alerted, []);
});

test('WATCHDOG: a GroupMe send failure does not take the route down, and is not reported as alerted', async () => {
  const f = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' }, sendThrows: true });
  const { status, body } = await checkCampaignState(f.deps);
  assert.equal(status, 503);
  assert.deepEqual(body.alerted, [], 'never claim an alert that did not go out');
});

// ─── Mid-cycle suppression ───────────────────────────────────────────────────
//
// A cycling campaign is NOT_RUNNING for a few seconds ON PURPOSE. The watchdog
// polls every 5 minutes, so roughly one cycling run in fifteen lands inside
// that window and pages about a campaign the ranker stopped itself. A watchdog
// that cries wolf gets ignored, and this one is the only cover for a crash
// between stop and start — so it has to be right in BOTH directions. The tests
// below pin the suppression AND the three ways it must not hide a real outage.

test('CYCLE-SUPPRESS: a campaign the ranker is cycling right now does not page, and does not fail the poll', async () => {
  const f = watchdogFake({
    states: { hot: 'RUNNING', warm: 'NOT_RUNNING' },
    cyclingNames: [CAMPAIGNS.warm],
  });
  const { status, body } = await checkCampaignState(f.deps);
  assert.deepEqual(f.sent, [], 'nobody is paged about a deliberate stop');
  assert.equal(status, 200, 'and the n8n execution does not fail either');
  assert.equal(body.needs_attention, false);
  assert.equal(body.all_running, false, 'the literal Five9 state is still reported honestly');
  const warm = body.campaigns.find((c) => c.campaign === CAMPAIGNS.warm);
  assert.equal(warm.state, 'NOT_RUNNING', 'nothing is hidden');
  assert.equal(warm.cycling, true, 'it is explained');
});

test('CYCLE-SUPPRESS: a campaign down while a DIFFERENT one cycles still pages', async () => {
  const f = watchdogFake({
    states: { hot: 'NOT_RUNNING', warm: 'NOT_RUNNING' },
    cyclingNames: [CAMPAIGNS.warm],
  });
  const { status, body } = await checkCampaignState(f.deps);
  assert.equal(status, 503);
  assert.equal(body.needs_attention, true);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /Data - Hot Leads less than 7 is NOT_RUNNING/);
  assert.deepEqual(body.alerted, [CAMPAIGNS.hot], 'only the unexplained one');
});

test('CYCLE-SUPPRESS: a RUNNING campaign is never reported as cycling', async () => {
  const f = watchdogFake({ cyclingNames: [CAMPAIGNS.hot, CAMPAIGNS.warm] });
  const { status, body } = await checkCampaignState(f.deps);
  assert.equal(status, 200);
  assert.ok(body.campaigns.every((c) => c.cycling === false));
});

test('CYCLE-SUPPRESS: a mid-cycle poll leaves the condition untouched in BOTH directions', async () => {
  // A cycling campaign is neither an alert nor a healthy read, so it must
  // neither open the condition nor clear it. Getting this wrong in the second
  // direction is the subtle one: a cycle mid-outage would announce a recovery
  // for a floor that is still dark.
  const store = alertStateStore();
  const t0 = new Date('2026-09-03T16:00:00Z');

  // A cycle BEFORE any outage must not start a silence window.
  const midCycle = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' }, cyclingNames: [CAMPAIGNS.warm], store });
  await checkCampaignState({ ...midCycle.deps, now: t0 });
  assert.deepEqual(store.sent, []);

  // The cycle ends badly — the campaign is still down and unexplained.
  const after = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' }, store });
  const { status } = await checkCampaignState({ ...after.deps, now: new Date(t0.getTime() + 30000) });
  assert.equal(status, 503);
  assert.equal(store.sent.length, 1, 'pages 30 seconds later — the mid-cycle poll suppressed nothing');

  // A cycle DURING the outage must not read as recovery.
  const cyclingAgain = watchdogFake({ states: { hot: 'RUNNING', warm: 'NOT_RUNNING' }, cyclingNames: [CAMPAIGNS.warm], store });
  await checkCampaignState({ ...cyclingAgain.deps, now: new Date(t0.getTime() + 60000) });
  assert.equal(store.sent.length, 1, 'no false all-clear from a cycle mid-outage');
});

test('CYCLE MARK: set while the reorder runs, cleared once the campaign is back', async () => {
  _resetCycling();
  const seenDuringWrite = [];
  const f = fakeFive9({ refuseWhileRunning: true });
  const deps = {
    ...f.deps,
    cycleCampaigns: true,
    sleep: async () => {},
    log: () => {},
    modifyCampaignLists: async (action) => {
      seenDuringWrite.push([action.action_payload.campaign_name, isCycling(action.action_payload.campaign_name)]);
      return f.deps.modifyCampaignLists(action);
    },
  };
  await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), deps);
  assert.deepEqual(seenDuringWrite, [[CAMPAIGNS.hot, true], [CAMPAIGNS.warm, true]], 'marked across the whole stopped window');
  assert.equal(isCycling(CAMPAIGNS.hot), false, 'cleared once it is dialing again');
  assert.equal(isCycling(CAMPAIGNS.warm), false);
});

test('CYCLE MARK: a campaign that FAILS to restart is left UNMARKED, so the watchdog pages about it', async () => {
  _resetCycling();
  const f = fakeFive9({ startAlwaysFails: true });
  const out = await applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps, cycleCampaigns: true, sleep: async () => {}, log: () => {},
  });
  assert.deepEqual(out.restart_failures, [CAMPAIGNS.hot], 'the campaign really is dark');
  assert.equal(isCycling(CAMPAIGNS.hot), false, 'dark is NOT cycling — nothing may suppress this page');
  // Prove it end to end: the watchdog pages about exactly this campaign.
  const wd = watchdogFake({ states: { hot: 'NOT_RUNNING', warm: 'RUNNING' }, cyclingNames: [] });
  const { status } = await checkCampaignState({ ...wd.deps, cycling: isCycling });
  assert.equal(status, 503);
  assert.match(wd.sent[0], /Data - Hot Leads less than 7 is NOT_RUNNING/);
});

test('CYCLE MARK: a stop that throws leaves nothing marked', async () => {
  _resetCycling();
  const f = fakeFive9();
  await assert.rejects(applyDialPriority(rankPreMerge(FIXTURE_2026_09_04), {
    ...f.deps,
    cycleCampaigns: true,
    log: () => {},
    stopCampaign: async () => { throw new Error('Five9 stopCampaign fault'); },
  }), /stopCampaign fault/);
  assert.equal(isCycling(CAMPAIGNS.hot), false, 'nothing was stopped, so nothing is suppressed');
});

test('CYCLE MARK: expires, so a HUNG cycle cannot suppress the page forever', () => {
  _resetCycling();
  const t0 = 1_000_000;
  markCycling(CAMPAIGNS.hot, { now: t0 });
  assert.equal(isCycling(CAMPAIGNS.hot, { now: t0 + 1000 }), true, 'seconds in, still cycling');
  assert.equal(isCycling(CAMPAIGNS.hot, { now: t0 + CYCLE_MARK_TTL_MS - 1 }), true);
  assert.equal(isCycling(CAMPAIGNS.hot, { now: t0 + CYCLE_MARK_TTL_MS }), false, 'past the TTL it is an outage, not a cycle');
  assert.equal(isCycling(CAMPAIGNS.hot), false, 'and the stale mark is gone for good');
});

test('CYCLE MARK: is per campaign, and clearCycling only clears its own', () => {
  _resetCycling();
  markCycling(CAMPAIGNS.hot);
  markCycling(CAMPAIGNS.warm);
  clearCycling(CAMPAIGNS.hot);
  assert.equal(isCycling(CAMPAIGNS.hot), false);
  assert.equal(isCycling(CAMPAIGNS.warm), true);
  _resetCycling();
});

test('watchdogAlertKey: identity carries no live state — that IS the fix', () => {
  // The key must be identical across every state one outage passes through,
  // and distinct per campaign so one dead campaign never silences another.
  const hot = watchdogAlertKey(CAMPAIGNS.hot);
  assert.equal(hot, watchdogAlertKey(CAMPAIGNS.hot), 'stable');
  assert.notEqual(hot, watchdogAlertKey(CAMPAIGNS.warm), 'per campaign, not global');
  for (const state of ['UNREADABLE', 'NOT_RUNNING', 'STOPPING', null]) {
    assert.ok(!hot.includes(String(state)), `the key must not embed ${state}`);
  }
});

test('watchdogAlertText: the live state belongs in the BODY', () => {
  assert.match(watchdogAlertText(CAMPAIGNS.hot, 'stopping'), /is STOPPING during dial hours/);
  assert.match(watchdogAlertText(CAMPAIGNS.hot, null), /is UNREADABLE during dial hours/);
  assert.match(watchdogAlertText(CAMPAIGNS.hot, 'NOT_RUNNING'), /Check Five9 now/);
});

test('withinWatchdogWindow: 08:00–21:00 ET Mon–Sat, never Sunday', () => {
  assert.equal(withinWatchdogWindow(new Date('2026-09-03T12:00:00Z')), true, 'Thu 08:00 ET');
  assert.equal(withinWatchdogWindow(new Date('2026-09-03T11:59:00Z')), false, 'Thu 07:59 ET');
  assert.equal(withinWatchdogWindow(new Date('2026-09-04T01:00:00Z')), true, 'Thu 21:00 ET');
  assert.equal(withinWatchdogWindow(new Date('2026-09-04T01:01:00Z')), false, 'Thu 21:01 ET');
  assert.equal(withinWatchdogWindow(new Date('2026-09-05T16:00:00Z')), true, 'Sat 12:00 ET');
  assert.equal(withinWatchdogWindow(new Date('2026-09-06T16:00:00Z')), false, 'Sun 12:00 ET');
});

test('addDays: pure calendar arithmetic across a month boundary', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
