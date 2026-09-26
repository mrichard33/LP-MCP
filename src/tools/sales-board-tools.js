/**
 * Sales-board hand-post tools — src/tools/sales-board-tools.js  (2026-09-26)
 *
 *   post_office_power_ranking  post the month-to-date office board (or last
 *                              month's final standings) to #sales-all now
 *   announce_missed_sale       post ONE sale the backstop could not reach, as
 *                              the same one-line catch-up the digest uses
 *
 * WHY THESE EXIST. Both automatic paths have a window, and on 2026-09-25 a
 * post fell outside each one:
 *   - The first 8 PM month-to-date board never posted. The old 8 AM rolling
 *     run had already taken occurrence 2026-09-25 that morning, so runJob
 *     correctly declined the 8 PM run as the same slot. Nothing could post the
 *     board again until the next day.
 *   - The one-time catch-up digest reached 18 of 19 missed sales. Michael
 *     Innis (lead 577880) sold at 22:05 UTC on 9/23, 19 minutes outside the
 *     48-hour lookback when the digest ran, and no path could reach it after.
 *
 * Both tools reuse the automatic code end to end — runOfficePowerRanking and
 * findMissedSales/postDigest — so there is no second copy of either message
 * and no way around the "never twice" guard: a missed sale is claimed on the
 * same idempotency key as the endpoint before anything posts.
 *
 * DRY RUN BY DEFAULT. Both post to the whole sales floor, so the default
 * returns the exact text and posts nothing; posting takes dry_run:false.
 */
import { z } from 'zod';
import supabaseDefault from '../supabase.js';
import { runJob } from '../job-runner.js';
import {
  runOfficePowerRanking,
  JOB_ID as RANKING_JOB_ID,
  FINAL_JOB_ID as RANKING_FINAL_JOB_ID,
} from '../jobs/office-power-ranking.js';
import {
  findMissedSales,
  formatDigest,
  postDigest,
  RECENT_APPT_MS,
} from '../notifications/sale-backstop.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

/**
 * Post (or preview) the office power ranking.
 *
 * A real run goes through runJob so it shows in job_runs like the scheduled
 * one, but under a `manual:` occurrence — it must never use up the scheduled
 * daily or monthly key, or the next automatic post would be declined the same
 * way the 9/25 one was.
 */
export function makePostOfficePowerRanking(deps = {}) {
  const {
    run = runOfficePowerRanking,
    runJobFn = runJob,
    send,
    now = () => new Date(),
  } = deps;

  return async ({ kind = 'daily', dry_run = true } = {}) => {
    if (dry_run) {
      let preview = null;
      const result = await run({
        kind,
        send: async (t) => { preview = t; return { ok: true, ts: 'dry-run' }; },
      });
      return { dry_run: true, kind, result, text: preview };
    }
    const jobId = kind === 'final' ? RANKING_FINAL_JOB_ID : RANKING_JOB_ID;
    const job = await runJobFn(
      jobId,
      () => run({ kind, ...(send ? { send } : {}) }),
      { occurrence: `manual:${new Date(now()).toISOString()}` },
    );
    return { dry_run: false, kind, status: job?.status, summary: job?.summary, result: job?.value ?? null };
  };
}

/**
 * Post (or preview) one missed sale as a one-line catch-up.
 *
 * Looks back as far as the backstop's own "recent appointment" rule (7 days)
 * instead of its 48 hours, and nothing else changes: the lead must still be a
 * won sale with a usable rep name, an amount and a recent appointment, and a
 * lead that already has any sale_announcements row is never posted again.
 */
export function makeAnnounceMissedSale(deps = {}) {
  const {
    supabase = supabaseDefault,
    find = findMissedSales,
    post = postDigest,
  } = deps;

  return async ({ lp_lead_id, dry_run = true } = {}) => {
    const leadId = String(lp_lead_id || '').trim();
    if (!leadId) return { ok: false, reason: 'lp_lead_id is required' };

    const missed = await find({ supabase, lookbackMs: RECENT_APPT_MS });
    const sale = missed.find((s) => s.leadId === leadId);
    if (!sale) {
      const existing = await supabase
        .from('sale_announcements')
        .select('id, status, announce_source')
        .eq('lp_lead_id', leadId)
        .limit(1);
      const row = existing?.data?.[0];
      return {
        ok: false,
        reason: row
          ? `already announced (row ${row.id}, ${row.status}, source ${row.announce_source || 'endpoint'}) — not posting twice`
          : 'no recent won sale for this lead in the last 7 days — nothing to post',
      };
    }

    if (dry_run) return { ok: true, dry_run: true, sale, text: formatDigest([sale]) };
    const res = await post([sale], { supabase });
    return { ...res, dry_run: false, sale };
  };
}

export function registerSalesBoardTools(server, deps = {}) {
  server.tool(
    'post_office_power_ranking',
    'Post the office power ranking to #sales-all now: the month-to-date board (kind "daily") or last month\'s '
      + 'final standings (kind "final"). Dry run by default — returns the text and posts nothing. '
      + 'Does not use up the scheduled 8 PM slot.',
    {
      kind: z.enum(['daily', 'final']).optional().default('daily'),
      dry_run: z.boolean().optional().default(true).describe('true (default) previews only; false posts'),
    },
    async (args) => text(await makePostOfficePowerRanking(deps)(args)),
  );

  server.tool(
    'announce_missed_sale',
    'Post one sale that never reached the sales board, as a one-line catch-up in #sales-all (and GroupMe when '
      + 'the sales bot is configured). Looks back 7 days. Never posts a lead that is already announced. '
      + 'Dry run by default.',
    {
      lp_lead_id: z.string().describe('LP lead ID of the sale'),
      dry_run: z.boolean().optional().default(true).describe('true (default) previews only; false posts'),
    },
    async (args) => text(await makeAnnounceMissedSale(deps)(args)),
  );
}
