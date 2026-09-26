// ─── Payroll Engine — src/jobs/payroll-engine.js ─────────────────────────────
//
// WHAT
//   Once a week (Monday 07:00 ET) it applies the pay_rules table to the
//   previous Monday–Sunday. For each payee it writes one payroll_runs row and
//   one payroll_ledger line per pay event, flags what a person must look at,
//   and posts one Slack summary.
//
// WHY (2026-09-26)
//   Payroll ran by hand off LP report 134 with no pay-rules table and no audit
//   trail — Five9 keeps none. The ledger this writes becomes the record.
//
// WHERE THE NUMBERS COME FROM — see src/payroll/rules.js. lp_leads supplies
//   every event; report 134 supplies only the net amount for the 1.5% rule.
//   134 carries no lead id, so a net job reaches its lead through
//   lp_jobs.raw_lp_data->>'contractid'. A job that cannot be matched gets no
//   line, but it is COUNTED in the Slack card and written to payroll_audit —
//   never dropped silently. Neither are leads missing from lp_leads: each run
//   checks report 135's lead ids against lp_leads and says how many are absent.
//
// IT NEVER MOVES MONEY. `approved` is set only by a live-card click from an
//   active lf_report_approvers email; `paid` only by a person through the
//   payroll_mark_paid tool (src/payroll/ledger-actions.js).
//
// MODES — PAYROLL_ENGINE_MODE, default `shadow`
//   off     the scheduler does nothing; tool writes are refused.
//   shadow  writes runs with mode='shadow'; card titled "SHADOW — compare to
//           manual payroll"; NO Approve button. Nothing is ever approved.
//   live    the same with mode='live' plus an Approve button. Going live is
//           Mark's decision after 2–3 weeks of matching the manual payroll.
//   Anything unrecognised is `shadow`, never `live` (missed-caller-recovery
//   precedent): a typo must not arm an Approve button.
//
// IDEMPOTENT
//   A run is unique per (payee, period, mode); a line per (run, line_key).
//   Re-running a week inserts only lines it did not have and leaves every
//   existing line — including a person's resolution — exactly as it was.
//
// NOT READY IS NOT A CRASH
//   Until sql/131 is applied the tables do not exist. A pass then logs, posts
//   one ops note and returns { ok:false, reason:'tables_missing' }; runJob
//   files it failed, which is true.

import { createPayrollStore, isMissingTableError } from '../payroll/store.js';
import {
  agedDays, buildLightFireEvents, evaluateLine, eventLineKey, summarizeLines,
  previousWeekET, describeMissingLeads, PAYEE_LIGHTFIRE,
} from '../payroll/rules.js';
import { buildPayrollCardText, buildPayrollCardBlocks } from '../payroll/slack-card.js';
import { postToSlack } from '../slack.js';
import { runJob } from '../job-runner.js';
import { hourET } from './lp-report-common.js';

export const JOB_ID = 'payroll-engine';
export const MODES = Object.freeze(['off', 'shadow', 'live']);
const RUN_HOUR_ET = 7;
const ACTOR = 'payroll-engine';

export function payrollMode(env = process.env) {
  const m = String(env.PAYROLL_ENGINE_MODE ?? 'shadow').toLowerCase().trim();
  return MODES.includes(m) ? m : 'shadow';
}

export function payrollChannel(env = process.env) {
  return (env.PAYROLL_SLACK_CHANNEL || '').trim() || (env.SLACK_CHANNEL_OPS || '').trim();
}

// groupme.js is imported lazily: it pulls in the whole approval/mirror stack,
// and only a failed pass needs it.
async function defaultOpsNote(text) {
  try {
    const { sendGroupMeMessage } = await import('../groupme.js');
    await sendGroupMeMessage(text, { channel: 'ops' });
  } catch (err) {
    console.warn(`[Payroll] ops note failed: ${err.message}`);
  }
}

/* ─── one payee ─────────────────────────────────────────────────────────── */

/**
 * Compute LightFire's lines for the period. Pure over what the store returns;
 * writes nothing. Returns { lines, unmatched, coverage, events }.
 */
export async function computeLightFire({ store, partner, rules, excluded, period, runId = null, env = process.env }) {
  const [canvassLeads, demoLeads, net] = await Promise.all([
    store.loadCanvassConfirms(period),
    store.loadDemos(period),
    store.load134(period),
  ]);

  const matches = await store.matchJobsToLeads(net.rows.map((r) => r.job_number));
  const netJobs = [];
  const unmatched = [];
  for (const row of net.rows) {
    const m = matches.get(String(row.job_number));
    if (m?.lead) netJobs.push({ ...row, lead: m.lead });
    else unmatched.push({ job_number: row.job_number, rtp_date: row.rtp_date, net_cents: row.net_cents, reason: m?.reason || 'not matched' });
  }

  const events = buildLightFireEvents({ canvassLeads, demoLeads, netJobs, excluded, period });
  const paidElsewhere = await store.findPaidElsewhere(events.map(eventLineKey), runId);
  const ctx = { rules, partnerId: partner.id, excluded, paidElsewhere, agedDays: agedDays(env) };

  const byKey = new Map();
  for (const ev of events) {
    const line = evaluateLine(ev, ctx);
    if (line && !byKey.has(line.line_key)) byKey.set(line.line_key, line);
  }
  return { lines: [...byKey.values()], unmatched, coverage: net.coverage, events: events.length };
}

function coverageNote(coverage, period) {
  const short = (coverage || []).filter((c) => !c.through || c.through < (period.end < monthEnd(c.month) ? period.end : monthEnd(c.month)));
  if (!short.length) return null;
  const parts = short.map((c) => (c.through ? `${c.month.slice(0, 7)} only through ${c.through}` : `no ${c.month.slice(0, 7)} report`));
  return `⚠️ Report 134 does not cover the whole week (${parts.join('; ')}) — Direct 1.5% lines for the missing days will land in a later run.`;
}

function monthEnd(firstOfMonth) {
  const [y, m] = firstOfMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/* ─── the pass ──────────────────────────────────────────────────────────── */

/**
 * @param {object} o
 *   period   { start, end } — default: the previous Mon–Sun in ET
 *   confirm  write runs/lines/audit and post (the scheduler passes true);
 *            false = dry run: compute and return, write and post nothing
 *   mode     override PAYROLL_ENGINE_MODE (tests)
 *   deps     { store, post, opsNote, now, env }
 */
export async function runPayrollEngine({ period = null, confirm = false, mode = null, deps = {} } = {}) {
  const env = deps.env || process.env;
  const runMode = mode || payrollMode(env);
  const opsNote = deps.opsNote || defaultOpsNote;
  const post = deps.post || postToSlack;
  const p = period || previousWeekET(deps.now || new Date());

  if (runMode === 'off' && confirm) {
    return { ok: false, reason: 'mode_off', message: 'PAYROLL_ENGINE_MODE=off — nothing written. Dry runs still work.' };
  }
  const writeMode = runMode === 'live' ? 'live' : 'shadow';

  let store;
  try {
    store = deps.store || createPayrollStore();
  } catch (err) {
    return { ok: false, reason: 'no_database', error: err.message };
  }

  try {
    const [rules, excluded, partner] = await Promise.all([
      store.loadRules(), store.loadExcluded(), store.loadPartner(PAYEE_LIGHTFIRE),
    ]);
    let missing;
    try {
      missing = await store.missingLeadCheck();
    } catch (err) {
      if (isMissingTableError(err)) throw err;
      missing = { error: err.message };
    }
    const missingNote = describeMissingLeads(missing);
    const channel = payrollChannel(env);
    const results = [];

    // ── LightFire ──
    if (!partner || partner.active === false) {
      results.push({ payee: PAYEE_LIGHTFIRE, skipped: true, reason: 'no active lf_partners row with slug lightfire' });
    } else {
      const runRow = confirm ? (await store.ensureRun({ payeeType: 'partner', partnerId: partner.id, period: p, mode: writeMode })).run : null;
      const lf = await computeLightFire({ store, partner, rules, excluded, period: p, runId: runRow?.id || null, env });
      let lines = lf.lines;
      let inserted = [];
      if (confirm) {
        inserted = await store.insertLines(runRow.id, lf.lines);
        lines = await store.getLines(runRow.id);
        const summaryNow = summarizeLines(lines);
        if (runRow.status === 'pending') await store.setRunTotal(runRow.id, summaryNow.payableCents);
        await store.audit([
          ...inserted.map((l) => ({
            run_id: runRow.id, ledger_id: l.id, action: l.status === 'pending' ? 'created' : 'flagged', actor: ACTOR,
            detail: { status: l.status, reason: l.flag_reason, amount_cents: l.amount_cents },
          })),
          ...lf.unmatched.map((u) => ({ run_id: runRow.id, action: 'unmatched_134', actor: ACTOR, detail: u })),
        ]);
      }
      const summary = summarizeLines(lines);
      const notes = [
        lf.unmatched.length
          ? `⚠️ ${lf.unmatched.length} netted job${lf.unmatched.length === 1 ? '' : 's'} in report 134 could not be matched to an LP lead — review (payroll_get_run shows them in the audit).`
          : null,
        coverageNote(lf.coverage, p),
        missingNote,
      ];
      const text = buildPayrollCardText({
        mode: writeMode, payeeLabel: partner.display_name || 'LightFire', period: p, runId: runRow?.id || null, summary, notes,
      });
      let posted = null;
      if (confirm) {
        const blocks = buildPayrollCardBlocks({ mode: writeMode, runId: runRow.id, text, summary });
        posted = await post(text, channel, blocks ? { blocks } : {});
        if (posted?.ok) console.log(`[Payroll] summary posted ts=${posted.ts} run=${runRow.id}`);
        else console.warn(`[Payroll] summary NOT posted (${posted?.error || 'unknown'}) run=${runRow.id}`);
      }
      results.push({
        payee: PAYEE_LIGHTFIRE, run_id: runRow?.id || null, run_status: runRow?.status || null,
        events: lf.events, lines_inserted: inserted.length, summary, unmatched_134: lf.unmatched,
        coverage_134: lf.coverage, text, posted: posted ? { ok: !!posted.ok, ts: posted.ts || null, error: posted.error || null } : null,
      });
    }

    // ── Call center: never guessed ──
    const ccRules = rules.filter((r) => r.payee_type === 'call_center');
    const ccNote = ccRules.length === 0
      ? 'No call center pay rules defined yet.'
      : `Call center rules found (${ccRules.length}) — not computed in Phase 1. Nothing was guessed.`;
    const ccRun = confirm ? (await store.ensureRun({ payeeType: 'call_center', partnerId: null, period: p, mode: writeMode })).run : null;
    const ccText = buildPayrollCardText({
      mode: writeMode, payeeLabel: 'Call center', period: p, runId: ccRun?.id || null, summary: summarizeLines([]), notes: [ccNote],
    });
    let ccPosted = null;
    if (confirm) {
      ccPosted = await post(ccText, channel, {});
      if (ccPosted?.ok) console.log(`[Payroll] call center note posted ts=${ccPosted.ts}`);
    }
    results.push({ payee: 'call_center', run_id: ccRun?.id || null, lines_inserted: 0, note: ccNote, text: ccText,
      posted: ccPosted ? { ok: !!ccPosted.ok, error: ccPosted.error || null } : null });

    return { ok: true, mode: writeMode, dry_run: !confirm, period: p, missing_leads: missing, results };
  } catch (err) {
    if (isMissingTableError(err)) {
      const msg = `⚠️ Payroll engine could not run for ${p.start} – ${p.end}: payroll tables are missing. Apply sql/131_payroll_engine.sql in the Supabase dashboard. (${err.message})`;
      console.error(`[Payroll] ${msg}`);
      if (confirm) await opsNote(msg);
      return { ok: false, reason: 'tables_missing', error: err.message, period: p };
    }
    console.error(`[Payroll] pass failed: ${err.message}`);
    if (confirm) await opsNote(`⚠️ Payroll engine failed for ${p.start} – ${p.end}: ${err.message}`);
    return { ok: false, reason: 'error', error: err.message, period: p };
  }
}

/* ─── scheduler ─────────────────────────────────────────────────────────── */

let timer = null;
let lastRunSlot = null;

/** Pure: should the tick fire now? */
export function shouldRunNow({ weekday, hour, slot, lastSlot }) {
  return weekday === 'Monday' && hour === RUN_HOUR_ET && slot !== lastSlot;
}

export function startPayrollEngineScheduler() {
  if (timer) return;
  if (payrollMode() === 'off') {
    console.log('[Payroll] disabled (PAYROLL_ENGINE_MODE=off)');
    return;
  }
  console.log(`[Payroll] Scheduler started — weekly Monday 07:00 ET (mode=${payrollMode()})`);
  const checkAndRun = async () => {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(now);
    const period = previousWeekET(now);
    if (!shouldRunNow({ weekday, hour: hourET(now), slot: period.start, lastSlot: lastRunSlot })) return;
    lastRunSlot = period.start;
    try {
      await runJob(JOB_ID, () => runPayrollEngine({ period, confirm: true }), { occurrence: period.start });
    } catch (err) {
      console.error('[Payroll] run failed:', err.message);
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}
