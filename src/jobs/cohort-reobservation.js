// ─── Cohort re-observation monitor — src/jobs/cohort-reobservation.js ────────
//
// A sales cohort only matures if it is RE-OBSERVED. A contract written in June
// is entirely "working" the day it is signed; over the following months it
// resolves into net, or into a cancellation, or into a financing denial. Net
// Sales — Gross Written − Cancellations − Financing Denied — therefore matures
// DOWNWARD as those losses land. Measured 2026-08-12, as a share of gross:
//
//     <1mo 84.8%   1mo 76.3%   2mo 70.4%   3mo 69.1%   4–7mo 69–73%
//
// A cohort observed once and never again freezes at its first reading. July
// would hold 76.3% forever instead of settling toward ~70%, and the retention
// history would be wrong in the FLATTERING direction — which is the dangerous
// one, because nothing about the number looks broken.
//
// ── WHY THIS IS A MONITOR AND NOT A PULLER ──────────────────────────────────
//
// It cannot re-pull. LP has no report API — `src/lp-client.js` exposes lead and
// job endpoints only (GetLead, GetMilestones, GetJobStatusChanges, …) and
// nothing that asks for report 137 over a date range. A month-scoped
// observation can only arrive as an emailed export, which is an LP-side
// schedule.
//
// Everything on OUR side of that email already works, verified 2026-08-12:
//
//   • I.LPRE's Gmail query is scope-agnostic — it matches the subject and any
//     .csv, with no newer_than or read-status filter, so a monthly export is
//     picked up like any other.
//   • Scope is derived in SQL from the FILE's own dates, not the email:
//     lp_derive_scope() returns 'month' when period_start is the first of a
//     month and period_end its last day. A monthly export self-classifies into
//     lp_cohort_maturation, which filters scope IN ('month','mtd').
//   • The unique index (report_type, scope, period_start) on current snapshots
//     means a re-pull of June demotes June's prior snapshot to history — and
//     that demoted history IS the maturation series.
//
// So the only missing piece is the LP schedule. This route exists to make its
// absence LOUD. The 2026-08-06→08-10 report-137 outage ran unnoticed for four
// days because nothing watched for absence; a frozen cohort is worse, because
// it keeps serving a plausible number. Silence is the failure mode being
// engineered against here.

import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { alertGroupMe } from './lp-report-ingest.js';

/**
 * How many days a cohort may go unobserved before it counts as stale.
 *
 * Cohorts are re-observed by a MONTHLY export, so the window has to tolerate a
 * month plus slack for weekends and a late send. Tighter than ~35 and every
 * cohort alerts every month by construction; much looser and a cohort can
 * freeze for a full quarter before anyone hears about it.
 */
export const REOBSERVATION_STALE_DAYS = 35;

/**
 * The current month is a special case: it is re-observed DAILY by the ordinary
 * 137 email, so anything beyond a couple of days means the daily ingest itself
 * has stopped — a different and more urgent failure than a missing monthly
 * export.
 */
export const CURRENT_MONTH_STALE_DAYS = 2;

/**
 * ⚠️ THE ONE WAY A WELL-INTENTIONED LP SCHEDULE BREAKS THE DAILY INGEST.
 *
 * `lp_csv_ingest_finalize` demotes on daterange OVERLAP within the {mtd, month}
 * scope FAMILY, and since 2026-08-11 it also refuses to promote a snapshot
 * covering strictly LESS of the period than the current one.
 *
 * Both rules are right. Together they mean a month-scoped export for the
 * CURRENT month is poison:
 *
 *   1. An Aug 1–31 file lands mid-month. It overlaps the daily rolling window
 *      (Aug 1–12) and its period_end is later, so it wins and demotes it.
 *   2. Every subsequent daily file — Aug 1–13, Aug 1–14, … — now covers
 *      strictly LESS than Aug 31, so coverage-recency REFUSES to promote it.
 *   3. The current month freezes for the rest of the month on a file generated
 *      mid-month that claims to cover all of it.
 *
 * Verified against the live function 2026-08-12. Closed months are unaffected —
 * Jul 1–31 does not overlap Aug 1–12 — and a re-pull of the SAME closed month
 * is equal coverage, which still wins, so maturation works exactly as intended.
 *
 * So: schedule month-scoped exports for CLOSED months only. This detects the
 * mistake if it is made, because the symptom (a dashboard that quietly stops
 * advancing) looks nothing like the cause.
 */
export async function detectBlockingFullMonthExport() {
  const rows =
    (await runSQL(`
      SELECT id::text, period_start::text, period_end::text, as_of_date::text, scope
        FROM scorecard_report_snapshots
       WHERE report_type = 'sales_efficiency'
         AND is_current
         AND scope IN ('mtd', 'month')
         AND period_start = date_trunc('month', CURRENT_DATE)::date
         AND period_end > CURRENT_DATE
       ORDER BY period_end DESC
       LIMIT 1
    `)) || [];
  return rows[0] || null;
}

/**
 * Read `lp_cohort_reobservation` and mark which cohorts have gone stale.
 *
 * The view already answers WHICH cohorts still need re-pulling and why (the
 * current month always; any prior month still holding working or hold dollars;
 * anything younger than the eligibility threshold). This adds the time
 * dimension — how long since each was last seen — and the verdict.
 */
export async function getCohortReobservationStatus() {
  const rows =
    (await runSQL(`
      SELECT contract_month::text        AS contract_month,
             last_observed_on::text      AS last_observed_on,
             days_since_observed,
             cohort_age_days,
             working_cents,
             hold_cents,
             reason
        FROM lp_cohort_reobservation
       ORDER BY contract_month
    `)) || [];

  const cohorts = rows.map((r) => {
    const isCurrentMonth = r.reason === 'current_month';
    const threshold = isCurrentMonth ? CURRENT_MONTH_STALE_DAYS : REOBSERVATION_STALE_DAYS;
    const days = Number(r.days_since_observed ?? 0);
    return {
      ...r,
      days_since_observed: days,
      stale_threshold_days: threshold,
      stale: days > threshold,
      // Unresolved dollars are WHY the cohort still matters: this is the
      // business that can still move. A cohort with none of it has settled and
      // its figure is final.
      unresolved_cents: Number(r.working_cents ?? 0) + Number(r.hold_cents ?? 0),
    };
  });

  const stale = cohorts.filter((c) => c.stale);
  const blockingFullMonth = await detectBlockingFullMonthExport();
  return {
    cohorts,
    stale,
    stale_count: stale.length,
    // Non-null means a current-month export is blocking the daily rolling file.
    // See detectBlockingFullMonthExport — the symptom is a dashboard that
    // quietly stops advancing, which looks nothing like the cause.
    blocking_full_month_export: blockingFullMonth,
    checked_at: new Date().toISOString().slice(0, 10),
  };
}

/** "Feb 2026 (34d)" — compact enough for a GroupMe line. */
function describe(c) {
  const [y, m] = c.contract_month.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m) - 1] ?? m} ${y} (${c.days_since_observed}d)`;
}

export function buildStaleAlert(status) {
  const blocked = status.blocking_full_month_export;
  if (!status.stale_count && !blocked) return null;

  // Reported FIRST and separately: this is not a missing observation, it is an
  // active blockage, and the fix is to delete an LP schedule rather than add
  // one. Conflating it with staleness would send someone to ask LP for MORE
  // exports when the problem is that one of them should not exist.
  if (blocked) {
    const lines = [
      `⚠️ A current-month export is BLOCKING the daily report-137 ingest.`,
      `Snapshot covers ${blocked.period_start} → ${blocked.period_end}, past today. ` +
        `Every daily file now covers strictly less of that period, so promotion ` +
        `refuses them and the current month has stopped advancing.`,
      `Fix: remove the month-scoped LP export for the CURRENT month. ` +
        `Month-scoped exports are for CLOSED months only.`,
    ];
    if (!status.stale_count) return lines.join('\n');
    return [lines.join('\n'), '', buildStaleLines(status)].join('\n');
  }
  return buildStaleLines(status);
}

function buildStaleLines(status) {
  if (!status.stale_count) return null;
  const current = status.stale.filter((c) => c.reason === 'current_month');
  const prior = status.stale.filter((c) => c.reason !== 'current_month');
  const lines = [`⚠️ Cohort re-observation stale — ${status.stale_count} cohort(s).`];

  // The current month going stale means the DAILY 137 ingest has stopped, which
  // is a different alarm from a missing monthly export. Say which.
  if (current.length) {
    lines.push(
      `Current month not re-observed in ${current[0].days_since_observed}d — the daily ` +
        `report-137 email may have stopped. Check I.LPRE executions and the LP schedule.`,
    );
  }
  if (prior.length) {
    lines.push(
      `Prior cohorts frozen: ${prior.map(describe).join(', ')}. These still hold ` +
        `working/hold dollars, so their Net Sales is still moving — a frozen reading ` +
        `reads HIGH. Needs a month-scoped 137 export from LP for each.`,
    );
  }
  return lines.join('\n');
}

export function registerCohortReobservationRoutes(app) {
  // Read-only. Safe to poll; returns the full list plus the stale subset so a
  // caller can alert on `stale_count` without re-deriving the thresholds.
  app.get('/n8n/admin/cohort-reobservation', async (req, res) => {
    try {
      if (!supabase) return res.status(500).json({ success: false, error: 'Supabase not configured' });
      const status = await getCohortReobservationStatus();

      // `?alert=1` sends the GroupMe message as a side effect, so the n8n
      // workflow stays a thin transport with no message formatting of its own —
      // the same division of labour as the report ingests, where every rule
      // lives here and n8n only moves bytes.
      let alerted = false;
      if (String(req.query.alert || '') === '1') {
        const text = buildStaleAlert(status);
        if (text) {
          await alertGroupMe(text);
          alerted = true;
        }
      }
      res.json({ success: true, ...status, alerted });
    } catch (err) {
      console.error('[CohortReobs] status error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[CohortReobs] Routes registered: GET /n8n/admin/cohort-reobservation');
}
