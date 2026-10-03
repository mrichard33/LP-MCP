/**
 * Sales-board hand-post tools — src/tools/sales-board-tools.js (2026-09-26).
 *
 * Both tools post to the whole sales floor, so the guards that matter are:
 * dry run by default, a manual run never uses up the scheduled slot, and a
 * sale that is already announced is never posted twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makePostOfficePowerRanking,
  makeAnnounceMissedSale,
  registerSalesBoardTools,
  makeSaleP2BackstopRun,
} from '../src/tools/sales-board-tools.js';
import { RECENT_APPT_MS } from '../src/notifications/sale-backstop.js';

const INNIS = {
  leadId: '577880',
  prospectId: '1',
  contactId: 'c1',
  repDisplayName: 'Michael Innis',
  amount: 31000,
  branch: 'JAX',
  firstSeenAt: '2026-09-23T22:05:36Z',
};

function fakeSupabase(rows = []) {
  const calls = [];
  return {
    calls,
    from(table) {
      const chain = {
        select() { return chain; },
        eq(col, val) { calls.push({ table, col, val }); return chain; },
        limit() { return Promise.resolve({ data: rows, error: null }); },
      };
      return chain;
    },
  };
}

// ── post_office_power_ranking ───────────────────────────────────────────────

test('ranking dry run returns the text and never reaches Slack or job_runs', async () => {
  let jobCalls = 0;
  const run = async ({ send }) => {
    const r = await send('🏆 Office power ranking — September 1–25', 'C1');
    return { ok: true, posted: true, ts: r.ts };
  };
  const out = await makePostOfficePowerRanking({ run, runJobFn: () => { jobCalls++; } })({});
  assert.equal(out.dry_run, true);
  assert.equal(out.text, '🏆 Office power ranking — September 1–25');
  assert.equal(out.result.ts, 'dry-run');
  assert.equal(jobCalls, 0);
});

test('ranking real run posts once under a manual occurrence, not the scheduled date key', async () => {
  const seen = [];
  const runJobFn = async (id, fn, opts) => {
    seen.push({ id, occurrence: opts.occurrence });
    return { status: 'ok', summary: 's', value: await fn() };
  };
  let sends = 0;
  const run = async ({ kind, send }) => { await send('board'); return { ok: true, posted: true, kind }; };
  const out = await makePostOfficePowerRanking({
    run,
    runJobFn,
    send: async () => { sends++; return { ok: true, ts: '1.2' }; },
    now: () => new Date('2026-09-26T00:45:00Z'),
  })({ dry_run: false });
  assert.equal(sends, 1);
  assert.deepEqual(seen, [{ id: 'office-power-ranking', occurrence: 'manual:2026-09-26T00:45:00.000Z' }]);
  assert.equal(out.result.posted, true);
});

test('ranking final kind records under the final job id', async () => {
  const ids = [];
  await makePostOfficePowerRanking({
    run: async () => ({ ok: true, posted: true }),
    runJobFn: async (id, fn) => { ids.push(id); return { value: await fn() }; },
  })({ kind: 'final', dry_run: false });
  assert.deepEqual(ids, ['office-power-ranking-final']);
});

// ── announce_missed_sale ────────────────────────────────────────────────────

test('missed sale looks back 7 days and dry run returns the one-line catch-up without posting', async () => {
  let lookback = null;
  let posts = 0;
  const out = await makeAnnounceMissedSale({
    supabase: fakeSupabase(),
    find: async ({ lookbackMs }) => { lookback = lookbackMs; return [INNIS]; },
    post: async () => { posts++; },
  })({ lp_lead_id: '577880' });
  assert.equal(lookback, RECENT_APPT_MS);
  assert.equal(posts, 0);
  assert.equal(out.dry_run, true);
  assert.match(out.text, /^📋 A sale that didn't reach the board when it closed:/);
  assert.match(out.text, /• Michael Innis — \$31,000 \(Jacksonville\) · Sep 23/);
});

test('an already-announced lead is refused with a reason and never posted', async () => {
  let posts = 0;
  const out = await makeAnnounceMissedSale({
    supabase: fakeSupabase([{ id: 96, status: 'posted', announce_source: 'backstop_digest' }]),
    find: async () => [], // findMissedSales drops announced leads
    post: async () => { posts++; },
  })({ lp_lead_id: '578002', dry_run: false });
  assert.equal(out.ok, false);
  assert.match(out.reason, /already announced \(row 96, posted/);
  assert.equal(posts, 0);
});

test('a lead that is not a recent won sale is refused', async () => {
  const out = await makeAnnounceMissedSale({
    supabase: fakeSupabase([]),
    find: async () => [INNIS],
    post: async () => { throw new Error('must not post'); },
  })({ lp_lead_id: '999999', dry_run: false });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no recent won sale/);
});

test('missed sale real run hands exactly that sale to postDigest', async () => {
  const posted = [];
  const out = await makeAnnounceMissedSale({
    supabase: fakeSupabase(),
    find: async () => [{ ...INNIS, leadId: '1' }, INNIS],
    post: async (sales) => { posted.push(...sales); return { ok: true, posted: 1, ts: '9.9' }; },
  })({ lp_lead_id: '577880', dry_run: false });
  assert.deepEqual(posted.map((s) => s.leadId), ['577880']);
  assert.equal(out.ok, true);
  assert.equal(out.ts, '9.9');
});

test('missing lead id is refused', async () => {
  const out = await makeAnnounceMissedSale({ find: async () => { throw new Error('no read'); } })({});
  assert.equal(out.ok, false);
});

// ── registration ────────────────────────────────────────────────────────────

test('every tool registers and defaults to dry run', async () => {
  const tools = {};
  registerSalesBoardTools({ tool: (name, _d, schema) => { tools[name] = schema; } });
  // 2026-10-03: sale_p2_backstop_run added (the Sale → P2 backfill).
  assert.deepEqual(Object.keys(tools).sort(), ['announce_missed_sale', 'post_office_power_ranking', 'sale_p2_backstop_run']);
  assert.equal(tools.post_office_power_ranking.dry_run.parse(undefined), true);
  assert.equal(tools.announce_missed_sale.dry_run.parse(undefined), true);
  assert.equal(tools.sale_p2_backstop_run.dry_run.parse(undefined), true);
  assert.throws(() => tools.sale_p2_backstop_run.since.parse('Aug 1'));
  assert.equal(tools.post_office_power_ranking.kind.parse(undefined), 'daily');
});

test('sale_p2_backstop_run: dry run is shadow mode; a real run is live with the asked lookback and cap', async () => {
  const calls = [];
  const run = async (opts) => { calls.push(opts); return { ok: true, summary: 's', counts: { tag_deal_won: 1 }, writes: 0, failures: 0,
    results: [
      { contactId: 'c1', contactName: 'Ann B', job: { lp_job_id: '60111', job_status: 'HOLD - HOA', job_value: 9000, contractdate: '2026-10-01T00:00:00' }, plan: { action: 'tag_deal_won', reason: 'no_deal_won' } },
      { contactId: 'c2', job: {}, plan: { action: 'skip', reason: 'has_p2' } },
    ] }; };
  const tool = makeSaleP2BackstopRun({ run });
  const dry = await tool({});
  assert.equal(calls[0].mode, 'shadow');
  assert.deepEqual(dry.sales.map((s) => s.contact_id), ['c1'], 'contacts that already have a card are not listed');
  assert.equal(dry.sales[0].contract_date, '2026-10-01');
  await tool({ dry_run: false, since: '2026-08-01', max_actions: 100 });
  assert.deepEqual(calls[1], { mode: 'live', sinceDay: '2026-08-01', maxActions: 100 });
});
