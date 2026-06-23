// ─── Scorecard Metrics — src/jobs/scorecard-metrics.js ───────────────
//
// Pure(ish) metric derivation for the "Monday a.m." goal/variance scorecard.
// Re-derives the funnel ACTUALS from raw LP records (LP has no report-export
// API). Consumed by src/jobs/goal-scorecard-daily.js. No Supabase, no network
// here — give it prospect records + a window, get back one market's actuals.
//
// SCORECARD_FIELD_MAP / CANCEL_STATUSES below are the verified field names and
// status strings from the existing sync layer (sync-leads.js, n8n-enrichment.js)
// and a live read of lp_jobs.job_status. Everything downstream reads from these,
// so a definition change is a one-line edit here.
//
// Aligned to the Reece "Marketing Sub-Source By Appt Date" report. The funnel is
// keyed By APPOINTMENT DATE (a lead counts in the period of its appt, not its
// creation), and the columns/ratios mirror the report exactly:
//   Set, Issue, Net Issue, %Issue=Issue/Set, Demo, %Demo=Demo/NetIssue,
//   Sold, %Gross Close=Sold/Demo, Gross$, GSLI=Gross$/Issue,
//   #Net Close, %Net Close=NetClose/Demo, Net$, NSLI=Net$/Issue.
//
// ⚠ TIE-OUT (provisional until reconciled to the official report):
//   - CANCEL_STATUSES drive every "Net" column (Net Issue / Net Close / Net $).
//     Calibrate the set against the report's gross→net haircut.
//   - Net Issue has no dedicated LP flag; approximated as issued && !cancelled.

import { getField } from '../sync-utils.js';
import { lpDateToEastern } from '../lp-dates.js';

export const SCORECARD_GETLEAD_OPTIONS = Number(process.env.SCORECARD_GETLEAD_OPTIONS || 261120);

/** Single Reece market. Group-by-market so a future split is a config change. */
export const DEFAULT_MARKET = 'REECE';

// Verified lead-level funnel flags. Each LP flag has an "ever*" companion
// (n8n-enrichment.js:332-338) — count either as true.
export const SCORECARD_FIELD_MAP = {
  source:      ['source', 'Source'],
  sub_source:  ['sourcesubdescr', 'SourceSubDescr'],
  branch:      ['brn_id', 'BRN_ID'],            // future per-branch split
  set:         ['apptset', 'ApptSet', 'everset'],
  issued:      ['issued', 'Issued', 'everissued'],
  sat:         ['sat', 'Sat', 'eversat'],       // demo / sat
  sold:        ['sold', 'Sold'],
  appt_date:   ['apptdate', 'ApptDate'],        // cohort key (By Appt Date)
  job_status:  ['jobstatus', 'JobStatus', 'job_status'],
  job_value:   ['grossamount', 'GrossAmount', 'gsa', 'GSA'],
};

// Job statuses that mean a sold/issued deal did NOT stick — used to derive the
// report's "Net" columns (Net Issue, # Net Close, Net Sale $) as gross minus
// these. Verified against a live read of lp_jobs.job_status. ⚠ TIE-OUT — the set
// is env-overridable (SCORECARD_CANCEL_STATUSES, comma-separated) and calibrated
// against the report's gross→net haircut (Sold 2,842 → Net Close 2,030).
export const CANCEL_STATUSES = (
  process.env.SCORECARD_CANCEL_STATUSES
    ? process.env.SCORECARD_CANCEL_STATUSES.split(',')
    : ['Cancelled', 'Cancelled By Mgt', 'Dead Deal', 'Credit Decline']
).map((s) => s.trim().toLowerCase()).filter(Boolean);
const CANCEL_SET = new Set(CANCEL_STATUSES);

function flag(lead, mapKey) {
  const v = getField(lead, ...SCORECARD_FIELD_MAP[mapKey]);
  return v === true || v === 'true';
}

// Dispositions where the rep sat the appointment (LP Sat=true) but it should
// NOT count as a demo for Reece's metrics: NOC = Not Covered (out of service
// area / our fault), NIS = Not Issued. demo_completed in the cache still mirrors
// LP faithfully; this exclusion is applied only at the reporting/count layer.
export const NON_DEMO_DISPOSITIONS = new Set(['NOC', 'NIS']);
function isNonDemoDisposition(lead) {
  const d = getField(lead, 'disposition', 'Disposition');
  return d != null && NON_DEMO_DISPOSITIONS.has(String(d).trim().toUpperCase());
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** ET calendar date (YYYY-MM-DD) of a UTC-tagged timestamp string. */
const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
export function etDateOf(tsStr) {
  if (!tsStr) return null;
  const d = new Date(tsStr);
  if (Number.isNaN(d.getTime())) return null;
  return ET_FMT.format(d); // "YYYY-MM-DD"
}

/** Round to 1 decimal, or null when the denominator is 0 (PDF parity: "0.0%"). */
function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}
function money(numerator, denominator) {
  if (!denominator) return null;
  return Math.round(numerator / denominator);
}

/**
 * Compute one market's actuals from LP prospect records, By Appt Date.
 *
 * @param {object[]} prospects   GetLead prospect records (each with nested .leads[])
 * @param {object}   window      { periodStart:'YYYY-MM-DD', periodEnd:'YYYY-MM-DD' }
 * @returns {object} actuals row (sans market/as_of_date/period — caller adds those)
 */
export function computeActuals(prospects, { periodStart, periodEnd }) {
  let leads = 0, sets = 0, issued = 0, net_issue = 0, demos = 0, sold = 0, net_close = 0;
  let ko_count = 0, gross_sales = 0, net_sales = 0;
  const statusTally = {};        // every job status seen → count (tie-out aid)

  for (const prospect of prospects || []) {
    const leadList = getField(prospect, 'leads', 'Leads') || [];
    for (const lead of leadList) {
      // Cohort key: APPOINTMENT date (ET calendar day) within the window.
      const apptDate = etDateOf(lpDateToEastern(getField(lead, ...SCORECARD_FIELD_MAP.appt_date)));
      if (!apptDate || apptDate < periodStart || apptDate > periodEnd) continue;

      leads += 1;
      const isSet = flag(lead, 'set');
      const isIssued = flag(lead, 'issued');
      // NOC/NIS are sits (LP Sat=true) that should not count as demos for Reece metrics.
      const isDemo = flag(lead, 'sat') && !isNonDemoDisposition(lead);
      const isSold = flag(lead, 'sold');

      // Roll up this lead's jobs → gross $, surviving (non-cancelled) $, cancel flag.
      let leadGross = 0, leadNet = 0, hasJob = false, hasCancel = false;
      const jobs = getField(lead, 'jobs', 'Jobs') || [];
      for (const job of jobs) {
        const status = String(getField(job, ...SCORECARD_FIELD_MAP.job_status) || '').trim();
        const value = num(getField(job, ...SCORECARD_FIELD_MAP.job_value));
        statusTally[status || '(blank)'] = (statusTally[status || '(blank)'] || 0) + 1;
        hasJob = true;
        leadGross += value;
        if (CANCEL_SET.has(status.toLowerCase())) { ko_count += 1; hasCancel = true; }
        else { leadNet += value; }
      }
      // A deal "cancelled" when it has job(s) and none survived the cancel set.
      const cancelled = hasJob && hasCancel && leadNet === 0;

      if (isSet) sets += 1;
      if (isIssued) { issued += 1; if (!cancelled) net_issue += 1; }   // ⚠ TIE-OUT (no LP net-issue flag)
      if (isDemo) demos += 1;
      if (isSold) {
        sold += 1;
        gross_sales += leadGross;        // Gross Sale $ (incl. cancellations)
        net_sales += leadNet;            // Net Sale $ (net of cancellations)
        if (!cancelled) net_close += 1;  // # Net Close
      }
    }
  }

  return {
    leads, sets, issued, net_issue, demos, sales: sold, net_close, ko_count,
    gross_sales, net_sales,
    good_business: net_sales,            // clean (non-cancelled) sold $
    pending_dollars: Math.max(0, gross_sales - net_sales),
    deposits: 0,                         // ⚠ TIE-OUT (job/milestone field; 0 until mapped)
    // ── Report ratios (Marketing Sub-Source By Appt Date) ──
    pct_issue:     rate(issued, sets),       // Issue ÷ Set
    demo_pct:      rate(demos, net_issue),   // Demo ÷ Net Issue
    close_pct:     rate(sold, demos),        // % Gross Close = Sold ÷ Demo
    pct_net_close: rate(net_close, demos),   // # Net Close ÷ Demo
    good_rate_pct: rate(net_sales, gross_sales), // clean-business ratio
    ko_pct:        rate(ko_count, sold),
    gsli:          money(gross_sales, issued),   // Gross Sale $ ÷ Issue
    nsli:          money(net_sales, issued),     // Net Sale $ ÷ Issue
    avg_sale:      money(net_sales, net_close),
    raw_inputs: {
      basis: 'appt_date',
      window: { periodStart, periodEnd },
      status_tally: statusTally,
      cancel_statuses: CANCEL_STATUSES,
      tie_out: ['net_issue', 'net_close', 'net_sales', 'gross_sales', 'cancel_statuses'],
    },
  };
}
