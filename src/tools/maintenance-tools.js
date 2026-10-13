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

export function registerMaintenanceTools(server, deps = {}) {
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
