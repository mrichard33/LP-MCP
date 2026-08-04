// ─── LP report freshness watchdog — src/jobs/lp-report-watchdog.js ───
//
// From 07:30 ET onward, alert (GroupMe, once per report type per ET day) if
// a report type has NO successful snapshot ingested today. The LP emails are
// scheduled 6:00 / 6:15 ET, so by 07:30 both should have landed and ingested.
//
// INDEPENDENCE (the design requirement): this module watches the OUTCOME —
// scorecard_report_snapshots — not any stage of the pipeline. It fires the
// same alert whether LP's schedule silently stopped, Gmail delivery broke,
// the n8n workflow is paused, or the ingest route is rejecting files. It
// imports nothing from the ingest path and stays correct even if that path
// is refactored away.
//
// Kill switch: LP_REPORT_WATCHDOG_DISABLED (any value).

import supabase from '../supabase.js';
import { todayET, hourET } from './lp-report-common.js';

const DISABLED = !!(process.env.LP_REPORT_WATCHDOG_DISABLED || '').trim();

const WATCHED = [
  { type: 'jobs_by_milestone', label: 'Report A "Jobs by Milestone Date" (Net Sales)', schedule: '6:00 ET' },
  { type: 'jobs_by_status', label: 'Report B "Jobs By Status" (Good Business split)', schedule: '6:15 ET' },
];

let watchdogTimer = null;
const lastAlertDate = new Map(); // report_type → ET date already alerted

/** Minute-of-hour in ET (0-59). */
function minuteET(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', minute: '2-digit',
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}

/**
 * One sweep. Exported for tests/manual runs; DST-proof — "today" is decided
 * by converting each snapshot's ingested_at INTO an ET calendar date rather
 * than converting an ET midnight into UTC.
 */
export async function checkLpReportFreshness({ alert = true } = {}) {
  if (!supabase) return { checked: false };
  const today = todayET();
  const missing = [];

  for (const { type, label, schedule } of WATCHED) {
    const { data, error } = await supabase
      .from('scorecard_report_snapshots')
      .select('ingested_at')
      .eq('report_type', type)
      .order('ingested_at', { ascending: false })
      .limit(1).maybeSingle();
    if (error) {
      console.error('[LPReportWatchdog] snapshot read failed:', error.message);
      continue;
    }
    const lastEtDay = data ? todayET(new Date(data.ingested_at)) : null;
    if (lastEtDay === today) continue;

    missing.push({ type, label, last_ingested_et: lastEtDay });
    if (!alert || lastAlertDate.get(type) === today) continue;
    lastAlertDate.set(type, today);
    try {
      const { sendGroupMeMessage } = await import('../groupme.js');
      await sendGroupMeMessage(
        `⏰ LP report MISSING: ${label} has not ingested today (${today} ET). ` +
        `Expected via scheduled email ~${schedule}. Last ingest: ${lastEtDay ?? 'never'}. ` +
        `Check, in order: LP's scheduled email fired → Gmail received it → n8n workflow active (I.LPRA/I.LPRB) → ` +
        `GET /n8n/admin/lp-report-ingest/status for a rejection.`,
      );
    } catch (err) {
      console.error('[LPReportWatchdog] GroupMe alert failed:', err.message);
    }
  }
  return { checked: true, today, missing };
}

export function startLpReportWatchdog() {
  if (watchdogTimer) return;
  if (DISABLED) {
    console.log('[LPReportWatchdog] DISABLED (LP_REPORT_WATCHDOG_DISABLED set)');
    return;
  }
  console.log('[LPReportWatchdog] Started — missing-report check from 07:30 ET, once per type per day');
  watchdogTimer = setInterval(async () => {
    const h = hourET();
    if (h < 7 || (h === 7 && minuteET() < 30)) return;
    try {
      await checkLpReportFreshness();
    } catch (err) {
      console.error('[LPReportWatchdog] sweep failed:', err.message);
    }
  }, 5 * 60 * 1000);
}

export function stopLpReportWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}
