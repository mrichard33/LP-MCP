// scripts/test-ghl-rate-limiter-budget.js
//
// The limiter's defaults must stay DERIVED from GoHighLevel's published
// ceiling, and inside it.
//
// ─── WHY THIS EXISTS (2026-09-24) ───────────────────────────────────────────
// src/ghl-rate-limiter.js said "conservative under GHL's ~100/min limit" from
// v1.0 until today. GoHighLevel publishes 100 requests per 10 SECONDS — 600 a
// minute. The 10-second figure had been read as a per-minute one, and every
// default in the file descended from it.
//
// Measured cost of that one word: 159 executor token timeouts in 40 minutes,
// waits to 13.0s, the bucket pinned at its reserve — while average consumption
// was ~31 calls/min against an 80/min budget and `total429s` had been 0 for the
// life of the process. GoHighLevel never throttled us once. We throttled
// ourselves to a seventh of the real ceiling and then timed out jobs against
// our own number.
//
// This is the guard, in the same role scripts/test-llm-timeout-budget.js plays
// for the LLM budgets: it fails when a default escapes the documented ceiling,
// so the next person to raise a number has to move the ceiling knowingly
// rather than by drift. See CLAUDE.md — "a constant written for the old model
// is the recurring bug".
//
// Env is set BEFORE the import because the limiter reads its knobs at module
// load and is a process singleton.

process.env.GHL_RATE_CAPACITY = '';
process.env.GHL_RATE_REFILL_PER_MIN = '';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  GHL_DOCUMENTED_BURST_PER_MIN,
  GHL_DOCUMENTED_PER_DAY,
  GHL_SUSTAINED_CEILING_PER_MIN,
  DEFAULT_CAPACITY,
  DEFAULT_REFILL_PER_MIN,
  getRateLimiterStats,
} = await import('../src/ghl-rate-limiter.js');

// ─── The published ceiling ──────────────────────────────────────────────────

test('the documented ceiling is the per-MINUTE form of GHL 100-per-10-seconds', () => {
  // The whole bug was the unit. 100 req / 10s = 600/min. If someone "corrects"
  // this to 100, they have reintroduced it.
  assert.equal(GHL_DOCUMENTED_BURST_PER_MIN, 600,
    'https://marketplace.gohighlevel.com/docs/other/rate-limits/ — 100 requests per 10 SECONDS');
  assert.equal(GHL_DOCUMENTED_PER_DAY, 200_000);
});

// ─── Defaults stay inside it ────────────────────────────────────────────────

test('the default refill is inside the documented burst ceiling', () => {
  assert.ok(DEFAULT_REFILL_PER_MIN > 0);
  assert.ok(DEFAULT_REFILL_PER_MIN <= GHL_DOCUMENTED_BURST_PER_MIN,
    `refill ${DEFAULT_REFILL_PER_MIN}/min exceeds GHL's documented ${GHL_DOCUMENTED_BURST_PER_MIN}/min`);
});

test('the default leaves at least half the budget for the HL MCP', () => {
  // GHL meters per app per location; both MCP servers draw on the same budget.
  // Taking more than half of it is a decision, not a default.
  assert.ok(DEFAULT_REFILL_PER_MIN <= GHL_DOCUMENTED_BURST_PER_MIN / 2,
    `refill ${DEFAULT_REFILL_PER_MIN}/min takes more than half the shared ${GHL_DOCUMENTED_BURST_PER_MIN}/min`);
});

test('the sustained ceiling is derived from the daily cap, not guessed', () => {
  // 200,000/day over 1440 minutes = 138/min. This is the LOWER of GoHighLevel's
  // two ceilings and the one nobody was watching — the burst limit (600/min) is
  // only available in bursts.
  assert.equal(GHL_SUSTAINED_CEILING_PER_MIN, Math.floor(GHL_DOCUMENTED_PER_DAY / (60 * 24)));
  assert.equal(GHL_SUSTAINED_CEILING_PER_MIN, 138);
  assert.ok(GHL_SUSTAINED_CEILING_PER_MIN < GHL_DOCUMENTED_BURST_PER_MIN,
    'the daily cap, not the burst limit, is what binds a rate held all day');
});

test('refill above the sustained ceiling stays a bounded, deliberate margin', () => {
  // The default (150) IS above the sustained ceiling (138), on purpose: refill
  // governs queue-drain speed, and real demand is ~9 calls/min against a
  // 13,500/day volume — 7% of the cap. But the margin must stay small enough
  // that a runaway is survivable, because NOTHING enforces the daily cap:
  // src/ghl-shared-budget.js counts and deliberately does not throttle, and no
  // daily counter exists. 150/min flat out for 24h is 216,000 — over the cap.
  //
  // Half the shared burst ceiling (300) is the hard stop without a daily guard.
  assert.ok(DEFAULT_REFILL_PER_MIN <= GHL_DOCUMENTED_BURST_PER_MIN / 2,
    `refill ${DEFAULT_REFILL_PER_MIN}/min needs a daily-cap guard before going past `
    + `${GHL_DOCUMENTED_BURST_PER_MIN / 2}`);

  const perDayIfSaturated = DEFAULT_REFILL_PER_MIN * 60 * 24;
  assert.ok(perDayIfSaturated <= GHL_DOCUMENTED_PER_DAY * 2,
    `${DEFAULT_REFILL_PER_MIN}/min saturated is ${perDayIfSaturated}/day — more than double `
    + `GHL's ${GHL_DOCUMENTED_PER_DAY}/day cap is not a margin, it is a hazard`);
});

// ─── Capacity and refill must move together ─────────────────────────────────

test('capacity holds at least a full minute of refill', () => {
  // The 2026-09-24 failure shape: capacity 120 against refill 150 meant the
  // bucket could not hold one minute of burst. A batch drained it in seconds
  // and the queue behind cleared at the refill trickle — ~40s for 100 calls,
  // past the 30s wait timeout, so they timed out while the per-minute average
  // still looked healthy. Capacity absorbs bursts; refill sets the sustained
  // rate. They are different jobs and capacity must not be the smaller one.
  assert.ok(DEFAULT_CAPACITY >= DEFAULT_REFILL_PER_MIN,
    `capacity ${DEFAULT_CAPACITY} is below one minute of refill (${DEFAULT_REFILL_PER_MIN})`);
});

test('a queue the size of the bucket drains inside the wait timeout', () => {
  // The property that actually matters to a caller: if a burst fills the
  // bucket and an equal number queue behind it, do they get served before
  // they fail open? At capacity==refill this is 60s, which is why the
  // assertion is against the drain of a FULL bucket rather than a round number.
  const { waitTimeoutMs } = getRateLimiterStats();
  const secondsToDrainAFullBucket = DEFAULT_CAPACITY / (DEFAULT_REFILL_PER_MIN / 60);
  assert.ok(secondsToDrainAFullBucket * 1000 <= waitTimeoutMs * 2,
    `a full bucket takes ${secondsToDrainAFullBucket}s to re-serve against a ${waitTimeoutMs}ms wait timeout`);
});

// ─── The live configuration is reported honestly ────────────────────────────

test('stats report refill as well as capacity', () => {
  // 2026-09-15: capacity was reported and refill was not, so the dashboard
  // showed one number. That is how capacity reached 120 while refill stayed at
  // 40 — a bucket that could not hold a minute of its own refill, unnoticed.
  const s = getRateLimiterStats();
  assert.equal(typeof s.capacity, 'number');
  assert.equal(typeof s.refillPerMin, 'number');
  assert.equal(typeof s.refillIntervalMs, 'number');
  assert.equal(s.refillIntervalMs, (60 * 1000) / s.refillPerMin);
});
