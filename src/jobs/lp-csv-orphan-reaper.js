// ─── Orphaned-snapshot reaper — src/jobs/lp-csv-orphan-reaper.js ───
//
// A chunked (CSV) ingest that calls lp_csv_ingest_begin and then fails before
// lp_csv_ingest_finalize leaves a snapshot row holding BOTH unique keys —
// UNIQUE (report_type, file_sha256) and the partial index on
// (report_type, content_sha256). Neither carries a finalized_at filter, so the
// dead row blocks its own corrected re-send, permanently and silently.
//
// probeExistingSnapshot names that state honestly (`orphaned_snapshot`, HTTP
// 200 + success:false) rather than disguising it as a duplicate, but nothing
// clears it: the runbook makes clearing a manual operator action. That held
// while orphans were rare. It stopped holding on 2026-08-09, when a missing
// `city` column failed every report-133 load at chunk 0 and 11 orphans
// accumulated in two days, each one rejecting the retry that would have fixed
// it once the column was added.
//
// This job runs lp_csv_reap_orphan_snapshots on the shared 5-minute heartbeat —
// no extra cron, no extra infrastructure, following src/actions/reaper.js.
//
// ══ WHAT IT WILL NOT TOUCH — read before widening anything ══
//
//   • PDF snapshots. Their RPC is single-tx, so finalized_at IS NULL is their
//     permanent resting state, not a fault. 19 such snapshots exist and SIX ARE
//     is_current — reaping them would blank the dashboard. The SQL function
//     filters source_format = 'csv' for this reason; it is not an optimisation.
//   • Snapshots that loaded rows. Those hold real data and failed later, at a
//     finalize assertion. Discarding them is an operator decision.
//   • Anything younger than REAP_AGE_MINUTES, so a legitimately in-flight
//     chunked load is never reaped mid-flight. The default 60 minutes is far
//     beyond the slowest observed ingest (the ~20MB lead-disposition YTD export
//     finalizes in seconds), so the margin is deliberate rather than tuned.
//
// The reaper MARKS rather than deletes — the audit row is the only record of
// what failed. See sql/migrations/2026-08-10_job_status_city_and_orphan_reaper.sql.
//
// Kill switch: LP_CSV_REAPER_DISABLED (any value).

import supabase from '../supabase.js';

const DISABLED = !!(process.env.LP_CSV_REAPER_DISABLED || '').trim();

/** Minutes an unfinalized chunked snapshot must sit before it is reapable. */
const REAP_AGE_MINUTES = Number(process.env.LP_CSV_REAP_AGE_MINUTES || 60);

let reaperTimer = null;

/**
 * One sweep. Exported for tests and manual runs.
 *
 * Returns { reaped } on success and { reaped: 0, error } on failure — a reaper
 * that cannot run is a logged non-event, never a thrown one: it is a cleanup
 * pass on a heartbeat, and taking the process down over it would be a worse
 * outcome than the orphan it failed to clear.
 */
export async function reapOrphanSnapshots({ ageMinutes = REAP_AGE_MINUTES } = {}) {
  if (!supabase) return { reaped: 0 };

  const { data, error } = await supabase
    .rpc('lp_csv_reap_orphan_snapshots', { p_age_minutes: ageMinutes });
  if (error) {
    console.error(`[LPCsvReaper] reap failed: ${error.message}`);
    return { reaped: 0, error: error.message };
  }

  const reaped = data ?? 0;
  if (reaped > 0) {
    // Worth a line in the log every time: an orphan means an ingest died
    // between begin and finalize, and a steady trickle is a defect upstream,
    // not routine housekeeping. Each row is in scorecard_ingest_log as 'reaped'.
    console.log(`[LPCsvReaper] marked ${reaped} orphaned snapshot(s) abandoned (older than ${ageMinutes}m) — see scorecard_ingest_log status='reaped'`);
  }
  return { reaped };
}

export function startLpCsvOrphanReaper() {
  if (reaperTimer) return;
  if (DISABLED) {
    console.log('[LPCsvReaper] DISABLED (LP_CSV_REAPER_DISABLED set)');
    return;
  }
  console.log(`[LPCsvReaper] Started — sweeping every 5 min for chunked snapshots unfinalized > ${REAP_AGE_MINUTES}m`);
  reaperTimer = setInterval(async () => {
    try {
      await reapOrphanSnapshots();
    } catch (err) {
      console.error('[LPCsvReaper] sweep failed:', err.message);
    }
  }, 5 * 60 * 1000);
}

export function stopLpCsvOrphanReaper() {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
}
