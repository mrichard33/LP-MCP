/**
 * Partner (Ross Erstling / RFED) operator tools — src/tools/partner-tools.js
 *
 *   partner_five9_sweep_run     (2026-10-22) one pass of src/jobs/partner-five9-sweep.js:
 *                               partner-owned contacts off every Reece Five9 list (log or
 *                               enforce, per PARTNER_FIVE9_REMOVAL_MODE). Dry run by default.
 *   partner_rfed_integrity_run  (2026-10-22, Build 3) the RFED integrity guard alone: a
 *                               contact a partner OWNS must have its newest LP lead on the
 *                               partner branch with the original's Source / Sub-Source /
 *                               Promoter. Never a fix. Dry run by default.
 *   rfed_batch_run              (2026-10-22, Build 2) Mark's 50 1-Leg leads → RFED: plan
 *                               (read-only dry-run table), record (approved ids →
 *                               partner_rfed_batch), create (sends each ready lead to LP's
 *                               inbound queue, at most 10 a call), verify.
 *
 * WHY TOOLS: the same runs exist as admin routes (src/partners/routes.js), but those take
 * the strict operator token, which no chat session holds; production holds the LP, Five9
 * and GHL credentials these runs need. The tools reuse the same functions end to end.
 * The rfed_batch_run sheet (names, phones, addresses for LP support) is returned only
 * when asked, never logged or stored.
 */
import { z } from 'zod';
import { runJob } from '../job-runner.js';
import { runPartnerFive9Sweep, JOB_ID as SWEEP_JOB_ID } from '../jobs/partner-five9-sweep.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

export function registerPartnerTools(server, deps = {}) {
  server.tool(
    'partner_five9_sweep_run',
    'One pass of the partner Five9 sweep (Ross / RFED): every partner-owned contact and the Reece Five9 lists it leaves. '
      + 'Dry run by default (reads only). dry_run:false runs the real pass under runJob: log mode records '
      + 'partner_five9_removals rows only, enforce queues the removals. Also runs the RFED integrity guard.',
    { dry_run: z.boolean().optional().default(true).describe('true (default) reads and reports only') },
    async ({ dry_run }) => {
      if (dry_run) return text(await runPartnerFive9Sweep(deps, { dryRun: true }));
      const { value } = await runJob(SWEEP_JOB_ID, () => runPartnerFive9Sweep(deps, {}));
      return text(value);
    },
  );

  server.tool(
    'partner_rfed_integrity_run',
    'The RFED integrity guard alone: every contact a partner (Ross) OWNS in GHL whose newest LP lead is not on the '
      + 'partner branch, or does not carry the original lead\'s Source / Sub-Source / Promoter. Never changes an owner '
      + 'or writes LP. Dry run by default; dry_run:false posts the cards only when PARTNER_RFED_INTEGRITY_MODE=alert.',
    { dry_run: z.boolean().optional().default(true) },
    async ({ dry_run }) => text(await runPartnerFive9Sweep(deps, { dryRun: dry_run, integrityOnly: true })),
  );

  server.tool(
    'rfed_batch_run',
    'Mark\'s 50 1-Leg leads → a new LP lead on RFED (Build 2). action plan (default, read-only): the dry-run table '
      + '(Source, Sub-Source, Promoter copied, canvass included; skips a sale, any DNC, a new appointment, a newer lead). '
      + 'sheet:true also returns the LP-ready lines (names, phones) for LP support. action record: approved ids → '
      + 'partner_rfed_batch. action create (at most 10 ids, Mark 2026-10-22): re-plans, then sends each ready lead to '
      + 'LP\'s inbound queue (addLead, legacy path only) for a person to merge onto the prospect and set RFED; stops on '
      + 'the first failure, never re-sends. action verify: the merged RFED leads, Ross the owner, phone-team, a Five9 '
      + 'removal row. Only create writes to LP; nothing writes GHL or Five9.',
    {
      action: z.enum(['plan', 'record', 'create', 'verify']).optional().default('plan'),
      ids: z.array(z.string().regex(/^\d+$/)).optional().describe('LP lead ids (default: Mark\'s 50 for plan)'),
      batch_no: z.number().int().min(1).optional(),
      sheet: z.boolean().optional().default(false),
      blank_promoter_ids: z.array(z.string().regex(/^\d+$/)).optional()
        .describe('Mark 2026-10-22: these leads\' promoters are not in LP\'s list; send them blank, the note names the promoter to set at merge'),
    },
    async ({ action, ids, batch_no, sheet, blank_promoter_ids }) => {
      const run = await import('../partners/rfed-batch-run.js');
      if (action === 'record') return text(await run.recordRfedBatch({ approvedIds: ids, batchNo: batch_no ?? null, deps }));
      if (action === 'verify') return text(await run.verifyRfedBatch({ batchNo: batch_no ?? null, deps }));
      if (action === 'create') return text(await run.createRfedBatch({ ids, batchNo: batch_no ?? null, blankPromoterIds: blank_promoter_ids || [], deps }));
      const r = await run.planRfedBatch({ ...(ids?.length ? { ids } : {}), sheet, blankPromoterIds: blank_promoter_ids || [], deps });
      return text(sheet ? r : { table: r.table, rows: r.rows });
    },
  );
}
