/**
 * Maintenance tools — src/tools/maintenance-tools.js  (2026-10-11)
 *
 *   stale_lp_tags_cleanup_run  take lp-day15-handoff / lp-demo-completed off
 *                              contacts an OLD LP lead tagged — an on-demand
 *                              pass of scripts/cleanup-stale-lp-tags.js
 *
 * WHY THIS EXISTS. Mark asked for the cleanup to be run, and running a repo
 * script needs a terminal plus the LP/HL Supabase keys and the GHL key, which
 * live only on this Railway service (and get_railway_env_vars never returns
 * values, by design). A tool runs the SAME code inside the service that already
 * holds the keys, so the cleanup is a chat request instead of a terminal session.
 *
 * DRY RUN BY DEFAULT, like every write tool here. dry_run:false removes the two
 * tags only (never any other tag); the script re-reads each contact from GHL
 * right before a write and skips one whose tags changed. max_removals caps one
 * pass (writes are paced 500ms apart); anything past the cap is reported as
 * `remaining` and the next pass re-plans from live data.
 *
 *   check_rule_targets         (2026-10-12, F-L) read-only: does every enabled
 *                              agent rule that adds/removes a contact from a GHL
 *                              workflow, or fires when one completes, point at a
 *                              PUBLISHED workflow? The same check the 02:10 job
 *                              runs (src/jobs/rule-target-check.js), writing
 *                              nothing.
 *
 *   rehash_tag_cleanup_run     (2026-10-14) the one-time move of the rehash
 *                              sweep's rehash-lead:/rehash-since:/rehash-done:
 *                              tags into rehash_stage, then their removal
 *                              (src/services/rehash-tag-cleanup.js; Mark: no
 *                              dates or ids in GHL tags). ~650 throttled GHL
 *                              reads take minutes, longer than a tool call
 *                              should wait, so it runs in the background and
 *                              job_id returns the report.
 *
 *   ghl_attribution_cleanup_run (2026-10-18) removes the `ghl-attributed` tag
 *                              rule 87 put on contacts for appointments our own
 *                              LP→GHL sync created (src/services/ghl-attribution-cleanup.js;
 *                              the user: "Clear the wrong ones"). Same background
 *                              job pattern; dry run by default.
 *
 *   invoice_bank_redact_run    (2026-10-19) erases the bank routing and account
 *                              numbers already saved with marketing invoices
 *                              (src/marketing/bank-redact-backfill.js; the user:
 *                              "remove the routing and account numbers that were
 *                              already entered"). Counts only, never a number;
 *                              dry run by default. Original PDFs are kept.
 *
 *   calculator_appt_move_run   (2026-10-22) moves calculator leads' upcoming
 *                              Window Estimate visits to Measurement Verification
 *                              in place (src/admin/move-calculator-appts.js; the
 *                              LP→GHL sync used to create them all on WE). Same
 *                              background job pattern; preview by default.
 */
import { z } from 'zod';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

const short = (r) => ({
  contact_id: r.contact_id, name: r.name, tag: r.tag, reason: r.reason,
  newest_lead: r.lead_id, lead_date: r.lead_date, dnc: r.dnc === true,
});

export function makeStaleLpTagsCleanupRun(deps = {}) {
  const {
    loadScript = () => import('../../scripts/cleanup-stale-lp-tags.js'),
    scriptDeps = null,
  } = deps;

  return async ({ dry_run = true, max_removals = 150 } = {}) => {
    const mod = await loadScript();
    const base = scriptDeps || await mod.defaultDeps();
    const lines = [];
    const argv = dry_run ? [] : ['--live', `--max=${max_removals}`];
    const res = await mod.run(argv, { ...base, log: (l) => lines.push(String(l)) });
    const removals = res.plan?.removals || [];
    return {
      ok: res.ok,
      dry_run,
      summary: lines[0] || null,
      planned: {
        total: removals.length,
        day15_handoff: removals.filter((r) => r.tag === mod.DAY15_TAG).length,
        demo_completed: removals.filter((r) => r.tag === mod.DEMO_TAG).length,
        contacts: new Set(removals.map((r) => r.contact_id)).size,
        no_lp_lead_left_alone: res.plan?.skipped?.noLpLead ?? 0,
      },
      ...(dry_run ? {} : { written: res.written, remaining: res.remaining }),
      removals: removals.map(short),
      calculator_call_now_missed: (res.plan?.callNow || []).map(short),
      next_step: dry_run
        ? (removals.length ? 'Nothing written. Run again with dry_run:false to remove these tags.' : 'Nothing to remove.')
        : (res.remaining ? `Run again with dry_run:false to finish the remaining ${res.remaining}.` : 'Done.'),
    };
  };
}

export function makeCheckRuleTargets(deps = {}) {
  const { loadJob = () => import('../jobs/rule-target-check.js'), jobDeps = undefined } = deps;
  return async ({ include_ok = false } = {}) => {
    const mod = await loadJob();
    const res = await mod.runRuleTargetCheck({ write: false, includeOk: include_ok, deps: jobDeps });
    if (res.checked === false) return { ok: false, checked: false, reason: res.reason, next_step: 'The check could not run; this is NOT a clean result.' };
    return {
      ok: true,
      summary: res.summary,
      registry_synced_at: res.registry_synced_at,
      high: res.high,
      low: res.low,
      findings: res.findings,
      next_step: res.high
        ? 'HIGH findings are routes that move nobody. Each needs a person to re-point or disable the rule; nothing was changed.'
        : 'No HIGH findings.',
    };
  };
}

const cleanupJobs = new Map();

export function makeRehashTagCleanupRun(deps = {}) {
  const {
    run = async (opts) => {
      const { runRehashTagCleanup } = await import('../services/rehash-tag-cleanup.js');
      const supabase = (await import('../supabase.js')).default;
      const { ghlFetch } = await import('../actions/helpers.js');
      const getContact = async (id) => (await ghlFetch('GET', `/contacts/${id}`))?.contact || null;
      return runRehashTagCleanup(opts, { supabase, getContact });
    },
  } = deps;
  return async ({ job_id = null, dry_run = true, limit = 0, contact_ids = [] } = {}) => {
    if (job_id) {
      const job = cleanupJobs.get(job_id);
      return job ? { ok: true, ...job } : { ok: false, error: 'job_not_found (jobs live in memory; a deploy clears them)' };
    }
    const id = `rehashclean_${Date.now().toString(36)}`;
    const job = { job_id: id, status: 'running', dry_run, started_at: new Date().toISOString(), report: null, error: null };
    cleanupJobs.set(id, job);
    while (cleanupJobs.size > 20) cleanupJobs.delete(cleanupJobs.keys().next().value);
    Promise.resolve()
      .then(() => run({ dryRun: dry_run !== false, limit, contactIds: contact_ids }))
      .then((report) => { job.report = report; job.status = 'completed'; })
      .catch((err) => { job.error = String(err?.message || err).slice(0, 500); job.status = 'failed'; })
      .finally(() => { job.completed_at = new Date().toISOString(); });
    return { ok: true, job_id: id, dry_run: dry_run !== false, next_step: 'Call again with this job_id for the report.' };
  };
}

export function makeGhlAttributionCleanupRun(deps = {}) {
  const {
    run = async (opts) => {
      const { runAttributionCleanup } = await import('../services/ghl-attribution-cleanup.js');
      const { readSyncCreatedStarts } = await import('../appointments/estimate-drift-io.js');
      const db = (await import('../supabase.js')).default;
      const { ghlFetch } = await import('../actions/helpers.js');
      const getContact = async (id) => (await ghlFetch('GET', `/contacts/${id}`))?.contact || null;
      return runAttributionCleanup(opts, { db, readSyncCreatedStarts, getContact });
    },
  } = deps;
  return async ({ job_id = null, dry_run = true, max_removals = 200 } = {}) => {
    if (job_id) {
      const job = cleanupJobs.get(job_id);
      return job ? { ok: true, ...job } : { ok: false, error: 'job_not_found (jobs live in memory; a deploy clears them)' };
    }
    const id = `attrclean_${Date.now().toString(36)}`;
    const job = { job_id: id, status: 'running', dry_run: dry_run !== false, started_at: new Date().toISOString(), report: null, error: null };
    cleanupJobs.set(id, job);
    while (cleanupJobs.size > 20) cleanupJobs.delete(cleanupJobs.keys().next().value);
    Promise.resolve()
      .then(() => run({ dryRun: dry_run !== false, maxRemovals: max_removals }))
      .then((report) => { job.report = report; job.status = 'completed'; })
      .catch((err) => { job.error = String(err?.message || err).slice(0, 500); job.status = 'failed'; })
      .finally(() => { job.completed_at = new Date().toISOString(); });
    return { ok: true, job_id: id, dry_run: dry_run !== false, next_step: 'Call again with this job_id for the report.' };
  };
}

export function makeCalculatorApptMoveRun(deps = {}) {
  const {
    run = async (opts) => {
      const mod = await import('../admin/move-calculator-appts.js');
      return mod.runCalculatorApptMove(opts, await mod.defaultDeps());
    },
  } = deps;
  return async ({ job_id = null, dry_run = true, contact_ids = [] } = {}) => {
    if (job_id) {
      const job = cleanupJobs.get(job_id);
      return job ? { ok: true, ...job } : { ok: false, error: 'job_not_found (jobs live in memory; a deploy clears them)' };
    }
    const id = `calcmove_${Date.now().toString(36)}`;
    const job = { job_id: id, status: 'running', dry_run: dry_run !== false, started_at: new Date().toISOString(), report: null, error: null };
    cleanupJobs.set(id, job);
    while (cleanupJobs.size > 20) cleanupJobs.delete(cleanupJobs.keys().next().value);
    Promise.resolve()
      .then(() => run({ dryRun: dry_run !== false, contactIds: contact_ids }))
      .then((report) => { job.report = report; job.status = 'completed'; })
      .catch((err) => { job.error = String(err?.message || err).slice(0, 500); job.status = 'failed'; })
      .finally(() => { job.completed_at = new Date().toISOString(); });
    return { ok: true, job_id: id, dry_run: dry_run !== false, next_step: 'Call again with this job_id for the report.' };
  };
}

export function makeInvoiceBankRedactRun(deps = {}) {
  const { load = () => import('../marketing/bank-redact-backfill.js'), backfillDeps = {} } = deps;
  return async ({ dry_run = true } = {}) => {
    const { runBankRedactBackfill } = await load();
    return runBankRedactBackfill({ dryRun: dry_run !== false }, backfillDeps);
  };
}

export function registerMaintenanceTools(server, deps = {}) {
  server.tool(
    'calculator_appt_move_run',
    'One-time move (2026-10-22): estimate-calculator leads whose upcoming visit the LP→GHL sync created on Window '
      + 'Estimate are moved IN PLACE to Measurement Verification (one PUT: same time and status, toNotify false; never a '
      + 'cancel and rebook), each read back; stops at the first failure. A contact that already has an active MV visit '
      + 'is listed, never touched. Preview by default (writes nothing). Runs in the background: the first call returns '
      + 'job_id; call again with job_id for the report.',
    {
      job_id: z.string().optional().describe('return the report of an earlier run'),
      dry_run: z.boolean().optional().default(true).describe('true (default) previews only; false moves the appointments'),
      contact_ids: z.array(z.string()).optional().default([]).describe('only these GHL contacts (default: every calculator-tagged contact)'),
    },
    async (args) => text(await makeCalculatorApptMoveRun(deps)(args)),
  );

  server.tool(
    'invoice_bank_redact_run',
    'Erase bank routing and account numbers already saved with marketing invoices (the user, 2026-10-19): the stored '
      + 'invoice text, the AI analysis, error and subject lines, ledger descriptions, and our .txt copies of email-body '
      + 'invoices. Original PDFs/photos are kept (admins-only on the dashboard). Returns COUNTS only, never a number. '
      + 'Dry run by default; dry_run:false writes, and a second dry run should then find 0.',
    {
      dry_run: z.boolean().optional().default(true).describe('true (default) counts only; false erases them'),
    },
    async (args) => text(await makeInvoiceBankRedactRun(deps)(args)),
  );

  server.tool(
    'ghl_attribution_cleanup_run',
    'One-time cleanup (2026-10-18). Rule 87 GHL_ATTR_APPT_BOOKED_VIA_GHL tagged ghl-attributed for appointments our own '
      + 'LP→GHL sync created (LP bookings, not GHL ones). Removes that tag only where rule 87 really added it, every '
      + 'rule-87 booking for the contact was sync-created, and GHL_ATTR_DIGITAL_ENTRY never touched the contact; the live '
      + 'tag is read first, one remove_tag per contact (rule GHL_ATTR_SYNC_CLEANUP). Dry run by default (counts only). '
      + 'Runs in the background: the first call returns job_id; call again with job_id for the report.',
    {
      job_id: z.string().optional().describe('return the report of an earlier run'),
      dry_run: z.boolean().optional().default(true).describe('true (default) counts only; false queues the removals'),
      max_removals: z.number().int().min(1).max(2000).optional().default(200).describe('contacts read and queued per run'),
    },
    async (args) => text(await makeGhlAttributionCleanupRun(deps)(args)),
  );

  server.tool(
    'rehash_tag_cleanup_run',
    'One-time cleanup (2026-10-14, Mark: no dates or ids in GHL tags). Reads every contact carrying rehash-lead:, '
      + 'rehash-since: or rehash-done: live from GHL, records them in rehash_stage (an open row for rehash + '
      + 'rehash-lead + rehash-since, an ended row per rehash-done), then queues one remove_tag per old tag (rule '
      + 'REHASH_TAG_CLEANUP). The plain rehash tag stays. Dry run by default (counts only). Runs in the background: '
      + 'the first call returns job_id; call again with job_id for the report.',
    {
      job_id: z.string().optional().describe('return the report of an earlier run'),
      dry_run: z.boolean().optional().default(true).describe('true (default) counts only; false backfills and queues the removals'),
      limit: z.number().int().min(0).max(5000).optional().default(0).describe('at most this many contacts (0 = all)'),
      contact_ids: z.array(z.string()).optional().default([]).describe('only these GHL contacts'),
    },
    async (args) => text(await makeRehashTagCleanupRun(deps)(args)),
  );

  server.tool(
    'check_rule_targets',
    'Read-only. Checks every enabled agent rule that adds or removes a contact from a GHL workflow (by workflow_id or '
      + 'by inbound webhook_url, resolved through the HL workflow_triggers mirror), and every rule that fires on '
      + 'ghl.workflow_completed, against the HL mirror: the target must be a PUBLISHED workflow with an active trigger. '
      + 'Returns HIGH findings (an add or a completion trigger that goes nowhere) and LOW ones (a remove from a draft). '
      + 'Writes nothing; the nightly job (02:10 ET) records history in rule_target_checks.',
    {
      include_ok: z.boolean().optional().default(false).describe('also list the targets that are fine'),
    },
    async (args) => text(await makeCheckRuleTargets(deps)(args)),
  );


  server.tool(
    'stale_lp_tags_cleanup_run',
    'Remove lp-day15-handoff and lp-demo-completed from GHL contacts that an OLD LP lead tagged (the Frances Overton '
      + 'case, 2026-10-11): Day 15 comes off when the current LP lead is under 15 days old; the demo tag comes off when '
      + 'the current sales cycle has no demo and the contact has no customer tag. Also lists calculator leads whose '
      + 'CALL NOW never ran (listed only, nothing fired). Removes only those two tags. Dry run by default.',
    {
      dry_run: z.boolean().optional().default(true).describe('true (default) previews only; false removes the tags'),
      max_removals: z.number().int().min(1).max(500).optional().default(150)
        .describe('most tags removed in one pass; the rest are reported as remaining'),
    },
    async (args) => text(await makeStaleLpTagsCleanupRun(deps)(args)),
  );
}
