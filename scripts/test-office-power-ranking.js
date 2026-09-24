// scripts/test-office-power-ranking.js
//
// The office-vs-office league table: which office is winning, posted daily to
// the sales rollup.
//
// The happy path is arithmetic. What actually needs pinning is everything that
// decides WHAT GOES ON THE BOARD, because this is published to every office at
// once and a confidently wrong league table is worse than none:
//
//   - only day-accurate close dates count (appointment_proxy is the right
//     MONTH, not the right DAY — CLAUDE.md);
//   - branch codes fold to their OFFICE, so BOCA volume lands on Fort
//     Lauderdale exactly as the channel routing already treats it;
//   - movement is null for an office with no previous board, never 0 — "held"
//     would invent a history it never had;
//   - a degraded or truncated read posts NOTHING;
//   - an empty window is quiet, not failed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rankOffices,
  withMovement,
  formatOfficePowerRanking,
  buildOfficePowerRanking,
  daysBefore,
  DAY_ACCURATE_CLOSE_SOURCES,
  POWER_RANKING_ROW_LIMIT,
} from '../src/notifications/office-power-ranking.js';
import { runOfficePowerRanking } from '../src/jobs/office-power-ranking.js';

const quiet = { warn: () => {}, log: () => {}, error: () => {} };
const sale = (branch, value) => ({ lp_branch_id: branch, job_value: value });

// ─── Ranking ────────────────────────────────────────────────────────────────

test('offices rank by revenue, highest first', () => {
  const rows = rankOffices([sale('ORL', 100), sale('FTMYR', 300), sale('JAX', 200)]);
  assert.deepEqual(rows.map((r) => r.office), ['FTMYR', 'JAX', 'ORL']);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
});

test('several sales in one office sum into one line', () => {
  const rows = rankOffices([sale('ORL', 100), sale('ORL', 250), sale('JAX', 300)]);
  assert.equal(rows[0].office, 'ORL');
  assert.equal(rows[0].volume, 350);
  assert.equal(rows[0].count, 2);
});

test('a branch code folds into its OFFICE', () => {
  // BOCA and MIAMI post to Fort Lauderdale's channel; officeMarketCodes already
  // treats them as one office, so the board must too or FTLAU's real number is
  // split across three lines that each look like a losing office.
  const rows = rankOffices([sale('FTLAU', 100), sale('BOCA', 200), sale('MIAMI', 50)]);
  assert.equal(rows.length, 1, 'one office, not three');
  assert.equal(rows[0].volume, 350);
  assert.equal(rows[0].count, 3);
});

test('ties share a rank and the next rank skips', () => {
  const rows = rankOffices([sale('ORL', 100), sale('JAX', 100), sale('SAR', 50)]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 3]);
});

test('order is stable when volume and count tie', () => {
  const a = rankOffices([sale('ORL', 100), sale('JAX', 100)]).map((r) => r.office);
  const b = rankOffices([sale('JAX', 100), sale('ORL', 100)]).map((r) => r.office);
  assert.deepEqual(a, b, 'the same sales in a different read order rank the same');
});

test('an eligible office with no sales is listed at zero, not dropped', () => {
  // An office that vanishes from the board reads as a bug. A zero is honest.
  const rows = rankOffices([sale('ORL', 100)], ['ORL', 'JAX']);
  assert.equal(rows.length, 2);
  const jax = rows.find((r) => r.office === 'JAX');
  assert.equal(jax.volume, 0);
  assert.equal(jax.count, 0);
  assert.equal(jax.rank, 2);
});

test('a row with an unmappable branch is skipped, not counted as an office', () => {
  const rows = rankOffices([sale('ORL', 100), sale(null, 500), sale('', 500)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].volume, 100, 'the 1000 of unattributable volume is not on anyone');
});

test('a non-numeric job_value counts as a sale worth nothing, not NaN', () => {
  const rows = rankOffices([sale('ORL', null), sale('ORL', 'abc'), sale('ORL', 100)]);
  assert.equal(rows[0].volume, 100);
  assert.equal(rows[0].count, 3);
});

// ─── Movement ───────────────────────────────────────────────────────────────

test('a climb is positive and a fall is negative', () => {
  const current = rankOffices([sale('JAX', 300), sale('ORL', 100)]);
  const previous = rankOffices([sale('ORL', 300), sale('JAX', 100)]);
  const rows = withMovement(current, previous);
  assert.equal(rows.find((r) => r.office === 'JAX').move, 1);
  assert.equal(rows.find((r) => r.office === 'ORL').move, -1);
});

test('an office that held its rank reads 0', () => {
  const current = rankOffices([sale('JAX', 300), sale('ORL', 100)]);
  const rows = withMovement(current, rankOffices([sale('JAX', 500), sale('ORL', 50)]));
  assert.equal(rows.find((r) => r.office === 'JAX').move, 0);
});

test('an office absent from the previous board is null, NOT held', () => {
  // null and 0 render differently on purpose: printing "—" for an office that
  // has no previous standing claims a history it never had.
  const rows = withMovement(rankOffices([sale('JAX', 300)]), rankOffices([sale('ORL', 100)]));
  assert.equal(rows[0].move, null);
});

// ─── The post ───────────────────────────────────────────────────────────────

const boardOf = (rows, days = 7) => ({
  degraded: false, days, rows,
  totalVolume: rows.reduce((t, r) => t + r.volume, 0),
  totalCount: rows.reduce((t, r) => t + r.count, 0),
});

test('the post ranks every office and totals the field', () => {
  const rows = withMovement(
    rankOffices([sale('FTMYR', 300), sale('ORL', 100)]),
    rankOffices([sale('ORL', 300), sale('FTMYR', 100)]),
  );
  const text = formatOfficePowerRanking({ ranking: boardOf(rows), days: 7 });
  assert.match(text, /Office power ranking — last 7 days/);
  assert.match(text, /1\. .*\$300 \(1\) ▲1/);
  assert.match(text, /2\. .*\$100 \(1\) ▼1/);
  assert.match(text, /Across all offices: \$400 · 2 sales/);
});

test('a one-day window says today, not "last 1 days"', () => {
  const text = formatOfficePowerRanking({ ranking: boardOf(rankOffices([sale('ORL', 100)]), 1), days: 1 });
  assert.match(text, /— today/);
  assert.doesNotMatch(text, /last 1 day/);
});

test('an office with no previous standing gets no marker at all', () => {
  const rows = withMovement(rankOffices([sale('ORL', 100)]), []);
  const text = formatOfficePowerRanking({ ranking: boardOf(rows) });
  assert.doesNotMatch(text, /▲|▼|—$/m);
});

test('one sale reads "sale", not "sales"', () => {
  const text = formatOfficePowerRanking({ ranking: boardOf(rankOffices([sale('ORL', 100)])) });
  assert.match(text, /· 1 sale$/);
});

test('a degraded board posts nothing', () => {
  assert.equal(formatOfficePowerRanking({ ranking: { degraded: true, reason: 'timeout' } }), null);
  assert.equal(formatOfficePowerRanking({ ranking: null }), null);
});

test('a board where every office sold nothing posts nothing', () => {
  // All zeros is an outage or a holiday. Either way there is no ranking in it,
  // and publishing a table of $0 would read as a failure of the offices.
  const rows = rankOffices([], ['ORL', 'JAX']);
  assert.equal(formatOfficePowerRanking({ ranking: boardOf(rows) }), null);
});

// ─── The read ───────────────────────────────────────────────────────────────

/** Supabase stub: records the query chain and returns `data` per call. */
function supa(queue) {
  const calls = [];
  return {
    calls,
    from() {
      const q = { filters: {} };
      calls.push(q);
      const chain = {
        select() { return chain; },
        eq(k, v) { q.filters[k] = v; return chain; },
        in(k, v) { q.filters[k] = v; return chain; },
        gte(k, v) { q.filters[`gte_${k}`] = v; return chain; },
        lt(k, v) { q.filters[`lt_${k}`] = v; return chain; },
        limit(n) { q.filters.limit = n; return Promise.resolve(queue.shift() ?? { data: [] }); },
      };
      return chain;
    },
  };
}

test('only day-accurate close sources are read', async () => {
  // appointment_proxy is the right MONTH, not the right DAY. A 7-day window
  // built on it would pull in sales that closed elsewhere in the month.
  const supabase = supa([{ data: [sale('ORL', 100)] }, { data: [] }, { data: [] }]);
  await buildOfficePowerRanking({ supabase, logger: quiet, days: 7 });
  assert.deepEqual(supabase.calls[0].filters.close_date_source, DAY_ACCURATE_CLOSE_SOURCES);
  assert.ok(!DAY_ACCURATE_CLOSE_SOURCES.includes('appointment_proxy'));
  assert.equal(supabase.calls[0].filters.closed_won, true);
});

test('the previous window abuts the current one and does not overlap it', async () => {
  const supabase = supa([{ data: [] }, { data: [] }, { data: [] }]);
  const now = new Date('2026-09-24T12:00:00Z');
  await buildOfficePowerRanking({ supabase, logger: quiet, days: 7, now: () => now });
  const current = supabase.calls[0].filters;
  const previous = supabase.calls[2].filters;
  assert.equal(previous.lt_close_date, current.gte_close_date,
    'previous ends exactly where current begins — no sale counted twice, none skipped');
  assert.equal(current.gte_close_date, daysBefore(now.toISOString(), 7));
});

test('a timed-out read degrades instead of publishing a partial board', async () => {
  const supabase = { from() { return { select() { return this; }, eq() { return this; }, in() { return this; }, gte() { return this; }, lt() { return this; }, limit() { return new Promise(() => {}); } }; } };
  const out = await buildOfficePowerRanking({ supabase, logger: quiet, budgetMs: 20, days: 7 });
  assert.equal(out.degraded, true);
  assert.equal(out.reason, 'timeout');
});

test('a truncated read degrades rather than ranking a partial field', async () => {
  const many = Array.from({ length: POWER_RANKING_ROW_LIMIT }, () => sale('ORL', 1));
  const out = await buildOfficePowerRanking({ supabase: supa([{ data: many }]), logger: quiet, days: 7 });
  assert.equal(out.degraded, true);
  assert.match(out.reason, /^truncated_at_/);
});

test('a failed PREVIOUS read costs the arrows, not the board', async () => {
  const supabase = supa([
    { data: [sale('ORL', 100)] },          // current
    { data: [sale('ORL', 100)] },          // roster
    { error: { message: 'boom' } },        // previous
  ]);
  const out = await buildOfficePowerRanking({ supabase, logger: quiet, days: 7 });
  assert.equal(out.degraded, false, 'the board still publishes');
  assert.equal(out.movementAvailable, false);
  assert.equal(out.rows[0].move, null);
});

// ─── The job ────────────────────────────────────────────────────────────────

test('the board is posted to the sales rollup', async () => {
  const sent = [];
  const out = await runOfficePowerRanking({
    build: async () => boardOf(rankOffices([sale('ORL', 100)])),
    send: async (text, channel) => { sent.push({ text, channel }); return { ok: true, ts: '1.2' }; },
    channelId: 'C_SALES', logger: quiet,
  });
  assert.equal(out.ok, true);
  assert.equal(out.posted, true);
  assert.equal(sent[0].channel, 'C_SALES');
  assert.match(sent[0].text, /Office power ranking/);
});

test('an empty window is QUIET, not failed', async () => {
  // No sales in the window is a slow week, not a broken job. Filing it as a
  // failure is how a real alarm gets muted (CLAUDE.md, "classify before you
  // threshold").
  let posted = false;
  const out = await runOfficePowerRanking({
    build: async () => boardOf(rankOffices([], ['ORL'])),
    send: async () => { posted = true; return { ok: true }; },
    channelId: 'C_SALES', logger: quiet,
  });
  assert.equal(out.ok, true, 'not a failure');
  assert.equal(out.posted, false);
  assert.equal(posted, false, 'nothing sent');
});

test('a degraded build fails the job and posts nothing', async () => {
  let posted = false;
  const out = await runOfficePowerRanking({
    build: async () => ({ degraded: true, reason: 'timeout' }),
    send: async () => { posted = true; return { ok: true }; },
    channelId: 'C_SALES', logger: quiet,
  });
  assert.equal(out.ok, false, 'runJob classifies from the RETURN VALUE');
  assert.equal(posted, false);
});

test('a failed post is a failed job — silence must not read as success', async () => {
  const out = await runOfficePowerRanking({
    build: async () => boardOf(rankOffices([sale('ORL', 100)])),
    send: async () => ({ ok: false, error: 'channel_not_found' }),
    channelId: 'C_SALES', logger: quiet,
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /channel_not_found/);
});

test('no configured channel fails rather than posting into the void', async () => {
  const out = await runOfficePowerRanking({
    build: async () => boardOf(rankOffices([sale('ORL', 100)])),
    send: async () => ({ ok: true }),
    channelId: '', logger: quiet,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_channel');
});
