/**
 * scripts/test-storm-season.js
 *
 * Drives src/agentic/storm-season.js. Pure module — the date arrives as an
 * argument, so every boundary is deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonPhase, monthDayFromISO, stormSeasonBlock } from '../src/agentic/storm-season.js';

test('the date that caused this: 2026-09-23 is PEAK season', () => {
  assert.equal(seasonPhase({ month: 9, day: 23 }), 'peak_season');
  const block = stormSeasonBlock('2026-09-23').join('\n');
  assert.match(block, /PEAK of hurricane season/);
  assert.match(block, /NEVER say "before storm season"/);
});

test('season boundaries are the NOAA dates, inclusive', () => {
  assert.equal(seasonPhase({ month: 5, day: 31 }), 'pre_season');   // day before
  assert.equal(seasonPhase({ month: 6, day: 1 }), 'early_season');  // opens
  assert.equal(seasonPhase({ month: 11, day: 30 }), 'late_season'); // closes
  assert.equal(seasonPhase({ month: 12, day: 1 }), 'post_season');  // day after
});

test('peak window boundaries', () => {
  assert.equal(seasonPhase({ month: 8, day: 14 }), 'early_season');
  assert.equal(seasonPhase({ month: 8, day: 15 }), 'peak_season');
  assert.equal(seasonPhase({ month: 10, day: 15 }), 'peak_season');
  assert.equal(seasonPhase({ month: 10, day: 16 }), 'late_season');
});

test('every month of the year resolves to a phase', () => {
  for (let m = 1; m <= 12; m++) {
    const phase = seasonPhase({ month: m, day: 15 });
    assert.ok(phase, `month ${m} produced no phase`);
    assert.ok(stormSeasonBlock(`2026-${String(m).padStart(2, '0')}-15`), `month ${m} produced no block`);
  }
});

test('"before storm season" is only permitted OUT of season', () => {
  // The whole point of the module: in-season copy must not say the season is ahead.
  for (const [iso, shouldBan] of [
    ['2026-01-15', false], // pre-season — accurate to say "before"
    ['2026-05-31', false],
    ['2026-06-01', true],  // open
    ['2026-09-23', true],  // peak — the reported case
    ['2026-11-30', true],  // still open
    ['2026-12-15', false], // closed
  ]) {
    const block = stormSeasonBlock(iso).join('\n');
    const bans = /NEVER say "before storm season"|Do not say "before storm season"/.test(block);
    assert.equal(bans, shouldBan, `${iso}: expected ban=${shouldBan}`);
  }
});

test('an unparseable date renders NOTHING rather than guessing', () => {
  // A wrong season is worse than no season.
  for (const bad of ['', null, undefined, 'Tuesday, September 23, 2026', '2026-13-01', '09/23/2026']) {
    assert.equal(stormSeasonBlock(bad), null, `expected null for ${bad}`);
  }
});

test('monthDayFromISO parses and rejects correctly', () => {
  assert.deepEqual(monthDayFromISO('2026-09-23'), { month: 9, day: 23 });
  assert.deepEqual(monthDayFromISO('2026-09-23T14:00:00Z'), { month: 9, day: 23 });
  assert.equal(monthDayFromISO('September 23, 2026'), null);
  assert.equal(monthDayFromISO('2026-00-10'), null);
});

test('every phase names the real urgency and forbids fake countdowns', () => {
  for (const iso of ['2026-02-01', '2026-07-01', '2026-09-23', '2026-11-01', '2026-12-20']) {
    const block = stormSeasonBlock(iso).join('\n');
    assert.match(block, /never a fake countdown or invented deadline/);
  }
});
