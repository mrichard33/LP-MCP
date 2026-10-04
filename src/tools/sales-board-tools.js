/**
 * Sales-board hand-post tools — src/tools/sales-board-tools.js  (2026-09-26)
 *
 *   post_office_power_ranking  post the month-to-date office board (or last
 *                              month's final standings) to #sales-all now
 *   announce_missed_sale       post ONE sale the backstop could not reach, as
 *                              the same one-line catch-up the digest uses
 *   sale_p2_backstop_run       (2026-10-03) put every recent LP sale with no P2
 *                              opportunity into P2 — the one-time backfill and
 *                              an on-demand pass of src/p2-sale-backstop.js
 *   sale_contact_backstop_run  (2026-10-04) give every LP sale with no GHL
 *                              contact one, so its P2 card has somewhere to go
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

import { runSaleP2Backstop } from '../p2-sale-backstop.js';
import { runSaleContactBackstop } from '../services/lp-sale-contact-backstop.js';

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

/**
 * 2026-10-03: run the Sale → P2 backstop on demand. Same code as the 15-minute
 * job; `since` widens the lookback for the one-time backfill (LP's webhook
 * stopped on 2026-09-24, and older gaps exist). Dry run by default: shadow mode
 * decides every sale and writes nothing to GHL.
 */
export function makeSaleP2BackstopRun(deps = {}) {
  const { run = runSaleP2Backstop } = deps;
  return async ({ dry_run = true, since = null, max_actions = 25, only = null } = {}) => {
    const res = await run({
      mode: dry_run ? 'shadow' : 'live', sinceDay: since || null, maxActions: max_actions,
      ...(Array.isArray(only) && only.length ? { onlyActions: only } : {}),
    });
    return {
      ok: res.ok, dry_run, summary: res.summary || res.skipped || res.error || null,
      counts: res.counts || {}, writes: res.writes ?? 0, failures: res.failures ?? 0,
      sales: (res.results || []).filter((r) => r.plan?.action !== 'skip' || r.plan?.reason !== 'has_p2').map((r) => ({
        contact_id: r.contactId, name: r.contactName, lp_job_id: r.job?.lp_job_id, job_status: r.job?.job_status,
        job_value: r.job?.job_value, contract_date: String(r.job?.contractdate || '').slice(0, 10),
        action: r.plan?.action, reason: r.plan?.reason, done: r.done === true, error: r.error || r.result?.error || null,
      })),
    };
  };
}

/**
 * 2026-10-04: give LP sales with no GHL contact one. Same code as the 15-minute
 * job; `since` widens the window for a backfill, `lead_ids` names leads.
 * Dry run by default: shadow searches GHL and writes nothing.
 */
export function makeSaleContactBackstopRun(deps = {}) {
  const { run = runSaleContactBackstop } = deps;
  return async ({ dry_run = true, since = null, lead_ids = null, max_actions = 25 } = {}) => {
    const res = await run({
      mode: dry_run ? 'shadow' : 'live', sinceDay: since || null, maxPerRun: max_actions,
      ...(Array.isArray(lead_ids) && lead_ids.length ? { leadIds: lead_ids.map(String) } : {}),
    });
    return {
      ok: res.ok, dry_run, summary: res.summary || res.skipped || res.error || null,
      counts: res.counts || {}, deferred: res.deferred ?? 0,
      sales: (res.results || []).map((r) => ({
        lp_lead_id: r.lp_lead_id, lp_job_id: r.job_id, job_status: r.job_status, name: r.name,
        outcome: r.outcome, contact_id: r.contact_id || null, email_dropped: r.email_dropped || false, error: r.error || null,
      })),
    };
  };
}

export function registerSalesBoardTools(server, deps = {}) {
  server.tool(
    'sale_contact_backstop_run',
    'Give every LP sale whose lead has no GHL contact a contact (find by phone first, create only if none), and link it, '
      + 'so the Sale → P2 backstop can add its P2 card. Customer tags only (never the new-lead tags); an email another '
      + 'contact already holds is not copied. Dry run by default. `since` (YYYY-MM-DD) widens the window (default last '
      + '45 days); `lead_ids` limits the run to named LP leads.',
    {
      dry_run: z.boolean().optional().default(true).describe('true (default) previews only; false writes to GHL'),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('contract dates on or after this day'),
      lead_ids: z.array(z.string()).optional().describe('only these LP lead ids'),
      max_actions: z.number().int().min(1).max(200).optional().default(25),
    },
    async (args) => text(await makeSaleContactBackstopRun(deps)(args)),
  );

  server.tool(
    'sale_p2_backstop_run',
    'Find every recent LP sale with no GHL Pipeline 2 (Client Lifecycle) opportunity and put it there: adds deal-won '
      + '(GHL C.0 builds the card), creates the card directly when deal-won is already on the contact, and creates '
      + 'cancelled sales as Lost. Dry run by default — lists each sale and the planned step, writes nothing. '
      + '`since` (YYYY-MM-DD) widens the lookback for a backfill; max_actions caps writes per run.',
    {
      dry_run: z.boolean().optional().default(true).describe('true (default) previews only; false writes to GHL'),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('contract dates on or after this day (default: last 45 days)'),
      max_actions: z.number().int().min(1).max(500).optional().default(25),
      only: z.array(z.enum(['tag_deal_won', 'create_open', 'create_won', 'create_lost'])).optional()
        .describe('write only these kinds (e.g. a backfill of live jobs: ["tag_deal_won","create_open"]); default all'),
    },
    async (args) => text(await makeSaleP2BackstopRun(deps)(args)),
  );

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
