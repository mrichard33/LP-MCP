// ─── Scorecard Metrics — src/jobs/scorecard-metrics.js ───────────────
//
// Pure(ish) metric derivation for the "Monday a.m." goal/variance scorecard.
// Re-derives the funnel ACTUALS from raw LP records (LP has no report-export
// API). Consumed by src/jobs/goal-scorecard-daily.js. No Supabase, no network
// here — give it prospect records + a window, get back one market's actuals.
//
// SCORECARD_FIELD_MAP / JOB_STATUS_MAP below are the verified field names and
// status strings from the existing sync layer (sync-leads.js, n8n-enrichment.js)
// and a live read of lp_jobs.job_status. Everything downstream reads from these,
// so a definition change is a one-line edit here.
//
// ⚠ TIE-OUT (provisional until reconciled to a real Reece Monday-a.m. export):
//   - ko_count / ko_pct          — which job statuses count as a knockout
//   - good_business / good_rate  — "good"/clean sold $; example shows >100% so
//                                   it is likely an attainment ratio, not a count
//   - close_pct denominator      — v1 uses sales/issued; LP may use sales/demos
// The funnel COUNTS (leads/issued/sets/demos/sales) and demo_pct/nsli/avg_sale
// are high-confidence (flags verified against the sync layer).

import { getField } from '../sync-utils.js';
import { lpCreatedDate } from '../lp-dates.js';

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
  job_status:  ['jobstatus', 'JobStatus', 'job_status'],
  job_value:   ['grossamount', 'GrossAmount', 'gsa', 'GSA'],
};

// Verified against a live read of lp_jobs.job_status (June 2026).
// PENDING is the remainder of won-and-working jobs (not NET, not KO).
export const JOB_STATUS_MAP = {
  NET: [
    'Paid In Full', 'PIF Survey Ready', 'PIF NO Survey', 'Assumed Complete',
  ],
  KO: [ // ⚠ TIE-OUT
    'Cancelled', 'Cancelled By Mgt', 'Dead Deal', 'Credit Decline',
  ],
};

const NET_SET = new Set(JOB_STATUS_MAP.NET.map((s) => s.toLowerCase()));
const KO_SET = new Set(JOB_STATUS_MAP.KO.map((s) => s.toLowerCase()));

function flag(lead, mapKey) {
  const v = getField(lead, ...SCORECARD_FIELD_MAP[mapKey]);
  return v === true || v === 'true';
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
 * Compute one market's MTD actuals from LP prospect records.
 *
 * @param {object[]} prospects   GetLead prospect records (each with nested .leads[])
 * @param {object}   window      { periodStart:'YYYY-MM-DD', periodEnd:'YYYY-MM-DD' }
 * @returns {object} actuals row (sans market/as_of_date/period — caller adds those)
 */
export function computeActuals(prospects, { periodStart, periodEnd }) {
  let leads = 0, issued = 0, sets = 0, demos = 0, sales = 0, ko_count = 0;
  let gross_sales = 0, net_sales = 0, pending_dollars = 0, good_business = 0;
  const statusTally = {};        // every job status seen → count (tie-out aid)
  const unmappedStatuses = {};   // statuses not in NET/KO (the PENDING remainder)

  for (const prospect of prospects || []) {
    const leadList = getField(prospect, 'leads', 'Leads') || [];
    for (const lead of leadList) {
      // Cohort filter: lead-date (ET calendar day) within the window.
      const leadDate = etDateOf(lpCreatedDate(prospect, lead, getField));
      if (!leadDate || leadDate < periodStart || leadDate > periodEnd) continue;

      leads += 1;
      if (flag(lead, 'issued')) issued += 1;
      if (flag(lead, 'set')) sets += 1;
      if (flag(lead, 'sat')) demos += 1;
      const isSold = flag(lead, 'sold');
      if (isSold) sales += 1;

      const jobs = getField(lead, 'jobs', 'Jobs') || [];
      for (const job of jobs) {
        const status = String(getField(job, ...SCORECARD_FIELD_MAP.job_status) || '').trim();
        const value = num(getField(job, ...SCORECARD_FIELD_MAP.job_value));
        const lc = status.toLowerCase();
        statusTally[status || '(blank)'] = (statusTally[status || '(blank)'] || 0) + 1;

        if (KO_SET.has(lc)) {
          ko_count += 1;                 // ⚠ TIE-OUT
          continue;                      // KO jobs excluded from $ buckets
        }
        // Non-KO job contributes to gross + good_business (⚠ TIE-OUT) and to
        // either net (cleared/paid) or pending (still working).
        gross_sales += value;
        good_business += value;          // ⚠ TIE-OUT (v1 = non-KO sold $)
        if (NET_SET.has(lc)) {
          net_sales += value;
        } else {
          pending_dollars += value;
          if (status) unmappedStatuses[status] = (unmappedStatuses[status] || 0) + 1;
        }
      }
    }
  }

  return {
    leads, issued, sets, demos, sales, ko_count,
    good_business, gross_sales, net_sales, pending_dollars,
    deposits: 0,                          // ⚠ TIE-OUT (job/milestone field; 0 until mapped)
    // actual-side rates
    demo_pct: rate(demos, issued),        // verified
    close_pct: rate(sales, issued),       // ⚠ TIE-OUT (may be sales/demos)
    good_rate_pct: rate(good_business, gross_sales), // ⚠ TIE-OUT
    ko_pct: rate(ko_count, sales),        // ⚠ TIE-OUT
    nsli: money(net_sales, issued),
    avg_sale: money(net_sales, sales),
    raw_inputs: {
      window: { periodStart, periodEnd },
      status_tally: statusTally,
      pending_remainder_statuses: unmappedStatuses,
      tie_out: ['ko_count', 'good_business', 'good_rate_pct', 'close_pct', 'deposits'],
    },
  };
}
