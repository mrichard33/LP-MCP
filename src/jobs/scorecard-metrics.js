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

// Sold-deal job statuses that ARE released to production → count as Net Sales.
// ⚠ TIE-OUT — verified against a live read of lp_jobs.job_status; calibrate to the
// official report. Env-overridable via SCORECARD_RELEASED_STATUSES (comma-separated).
export const RELEASED_STATUSES = (
  process.env.SCORECARD_RELEASED_STATUSES
    ? process.env.SCORECARD_RELEASED_STATUSES.split(',')
    : ['Rel To Production', 'RTP Await recission', 'RTP DP DUE', 'Awaiting Product']
).map((s) => s.trim().toLowerCase()).filter(Boolean);
const RELEASED_SET = new Set(RELEASED_STATUSES);

// Sold-deal job statuses HELD pre-release (financing/HOA/docs/measure) → Working
// Revenue. Real revenue earned but not yet bookable; a pipeline risk if it stalls.
// ⚠ TIE-OUT — env-overridable via SCORECARD_WORKING_STATUSES (comma-separated).
export const WORKING_STATUSES = (
  process.env.SCORECARD_WORKING_STATUSES
    ? process.env.SCORECARD_WORKING_STATUSES.split(',')
    : ['HOLD - HOA', 'HOLD-Shutter Approval', 'Mgmt Hold', 'Awaiting Credit Application',
       'Awaiting Lender', 'Awaiting Loan Docs', 'Awaiting Change Order',
       'Awaiting Commission Sheet', 'Awaiting Paperwork', 'Out to Measure']
).map((s) => s.trim().toLowerCase()).filter(Boolean);
const WORKING_SET = new Set(WORKING_STATUSES);

function flag(lead, mapKey) {
  // A lead counts if ANY mapped field is true — including the ever* companion
  // (everset/eversat/everissued). LP clears the transient flag (e.g. `issued`)
  // once a lead progresses or is cancelled, so the ever* field is what ties the
  // GROSS funnel counts to the report. NOTE: getField returns the first PRESENT
  // key, so it can't OR a transient flag with its ever* companion — we must check
  // each field explicitly. (Confirmed via raw_inputs.issue_diag: issued=1507 vs
  // everissued=1576 for Jun 1–23.)
  for (const k of SCORECARD_FIELD_MAP[mapKey]) {
    const v = getField(lead, k);
    if (v === true || v === 'true') return true;
  }
  return false;
}

// Dispositions where the rep sat the appointment (LP Sat=true) but it should NOT
// count as a demo for Reece's metrics. Real LP labels (per lp_dispositions):
//   NOC = No Contact, NIS = Not Interested - Shown.
// demo_completed in the cache still mirrors LP faithfully; this exclusion is
// applied only at the reporting/count layer. ⚠ TIE-OUT — env-overridable via
// SCORECARD_NON_DEMO_DISPOSITIONS (comma-separated); confirm against the official
// demo count before trusting demo% as reconciled.
export const NON_DEMO_DISPOSITIONS = new Set(
  (process.env.SCORECARD_NON_DEMO_DISPOSITIONS
    ? process.env.SCORECARD_NON_DEMO_DISPOSITIONS.split(',')
    : ['NOC', 'NIS']
  ).map((s) => s.trim().toUpperCase()).filter(Boolean),
);
// Returns the excluding disposition code (uppercased) if this sat lead is a
// non-demo, else null — lets the caller tally which codes drop sits from demos.
function nonDemoDispositionCode(lead) {
  const d = getField(lead, 'disposition', 'Disposition');
  if (d == null) return null;
  const code = String(d).trim().toUpperCase();
  return NON_DEMO_DISPOSITIONS.has(code) ? code : null;
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

/** A fresh accumulator for one group's funnel counters. */
function makeAcc() {
  return {
    leads: 0, sets: 0, issued: 0, net_issue: 0, demos: 0, sold: 0, net_close: 0,
    ko_count: 0, gross_sales: 0,
    // Three-bucket split of surviving (non-cancelled) sold $.
    released_dollars: 0, working_dollars: 0, other_pending: 0,
    statusTally: {},   // every job status seen → count (tie-out aid)
    statusDollarTally: {}, // per status → sold-lead $ (calibration: which statuses hold the working/released $)
    nonDemoTally: {},  // disposition code → sits dropped from demos (tie-out aid)
    openQuotesSample: [], // sample of SOLD leads carrying open-quote $ (pre-firm status) — diagnoses "Quoted on a sold lead"
    // Issue-count tie-out diagnostics (read-only): candidate "issued" definitions so we
    // can see which reconstructs the official report's gross Issue. headline `issued`
    // is unchanged by these.
    issueDiag: {
      issued_flag: 0,       // current headline: issued || Issued || everissued
      issued_only: 0,       // issued || Issued (no everissued)
      everissued: 0,        // everissued only
      sat: 0, sold: 0, has_job: 0,
      issued_or_progressed: 0,  // issued_flag || sat || sold
      issued_or_job: 0,         // issued_flag || hasJob
      issued_union: 0,          // issued_flag || sat || sold || hasJob
      dispo_issued_plus: 0,     // disposition stage rank ≥ Issued
    },
  };
}

/** Fold one cohort lead's funnel contribution into an accumulator (mutates acc). */
function accumulateLead(acc, lead) {
  acc.leads += 1;
  const isSet = flag(lead, 'set');
  const isIssued = flag(lead, 'issued');
  // NOC/NIS are sits (LP Sat=true) that should not count as demos for Reece
  // metrics; tally the excluding code so Mark can tie out the haircut.
  const isSat = flag(lead, 'sat');
  const nonDemoCode = isSat ? nonDemoDispositionCode(lead) : null;
  if (nonDemoCode) acc.nonDemoTally[nonDemoCode] = (acc.nonDemoTally[nonDemoCode] || 0) + 1;
  const isDemo = isSat && !nonDemoCode;
  const isSold = flag(lead, 'sold');

  // Roll up this lead's jobs → gross $, surviving (non-cancelled) $, cancel flag,
  // and the released/working/other split of the surviving $.
  let leadGross = 0, leadNet = 0, hasJob = false, hasCancel = false;
  let leadReleased = 0, leadWorking = 0, leadOther = 0;
  const leadStatusDollars = {};  // status → $ on this lead (committed to acc only if sold)
  const jobs = getField(lead, 'jobs', 'Jobs') || [];
  for (const job of jobs) {
    const status = String(getField(job, ...SCORECARD_FIELD_MAP.job_status) || '').trim();
    const value = num(getField(job, ...SCORECARD_FIELD_MAP.job_value));
    acc.statusTally[status || '(blank)'] = (acc.statusTally[status || '(blank)'] || 0) + 1;
    leadStatusDollars[status || '(blank)'] = (leadStatusDollars[status || '(blank)'] || 0) + value;
    hasJob = true;
    leadGross += value;
    const lower = status.toLowerCase();
    if (CANCEL_SET.has(lower)) { acc.ko_count += 1; hasCancel = true; }
    else {
      leadNet += value;
      if (RELEASED_SET.has(lower)) leadReleased += value;
      else if (WORKING_SET.has(lower)) leadWorking += value;
      else leadOther += value;     // in-flight, not yet released
    }
  }
  // A deal "cancelled" when it has job(s) and none survived the cancel set.
  const cancelled = hasJob && hasCancel && leadNet === 0;

  // ── Issue-count tie-out diagnostics (read-only; headline `issued` unchanged) ──
  // The report's "Issue" runs ~13% above our flag-based count, concentrated in
  // cancelled deals — so tally each candidate definition to see which ties out.
  {
    const issuedField = (() => { const v = getField(lead, 'issued', 'Issued'); return v === true || v === 'true'; })();
    const everIssued = (() => { const v = getField(lead, 'everissued', 'everIssued', 'EverIssued'); return v === true || v === 'true'; })();
    const dispo = String(getField(lead, 'disposition', 'Disposition') || '').trim().toLowerCase();
    const DISPO_RANK = { data: 1, set: 2, verified: 3, confirmed: 4, issued: 5, sat: 6, sold: 7 };
    const dispoIssuedPlus = (DISPO_RANK[dispo] || 0) >= 5;
    const d = acc.issueDiag;
    if (isIssued) d.issued_flag += 1;
    if (issuedField) d.issued_only += 1;
    if (everIssued) d.everissued += 1;
    if (isSat) d.sat += 1;
    if (isSold) d.sold += 1;
    if (hasJob) d.has_job += 1;
    if (isIssued || isSat || isSold) d.issued_or_progressed += 1;
    if (isIssued || hasJob) d.issued_or_job += 1;
    if (isIssued || isSat || isSold || hasJob) d.issued_union += 1;
    if (dispoIssuedPlus) d.dispo_issued_plus += 1;
  }

  if (isSet) acc.sets += 1;
  if (isIssued) { acc.issued += 1; if (!cancelled) acc.net_issue += 1; }   // ⚠ TIE-OUT (no LP net-issue flag)
  if (isDemo) acc.demos += 1;
  if (isSold) {
    acc.sold += 1;
    acc.gross_sales += leadGross;         // Gross Sale $ (incl. cancellations)
    for (const [s, v] of Object.entries(leadStatusDollars)) {
      acc.statusDollarTally[s] = Math.round((acc.statusDollarTally[s] || 0) + v);
    }
    acc.released_dollars += leadReleased; // released to production = Net Sales
    acc.working_dollars  += leadWorking;  // sold but held
    acc.other_pending    += leadOther;    // open quotes: sold lead, pre-firm job (Quoted/New/…)
    if (!cancelled) acc.net_close += 1;   // # Net Close (released or working both "stuck")
    // Diagnostic sample (capped): a lead flagged sold whose $ landed in the open-quote
    // bucket — i.e. its job is still pre-firm. Lets Mark see from live records whether
    // these are stuck-sold (workflow lag) or genuine open pipeline.
    if (leadOther > 0 && acc.openQuotesSample.length < 25) {
      acc.openQuotesSample.push({
        lead_id: String(getField(lead, 'id', 'lds_id', 'LeadID') || ''),
        sold: true,
        jobs: leadStatusDollars,
      });
    }
  }
}

/** Build the public actuals row from an accumulator. `extra` is merged in first
 *  (e.g. group key fields like {source, sub_source} for per-source rows). */
function finalizeActuals(acc, { periodStart, periodEnd }, extra = {}) {
  const {
    leads, sets, issued, net_issue, demos, sold, net_close, ko_count, gross_sales,
    released_dollars, working_dollars, other_pending, statusTally, statusDollarTally,
    nonDemoTally, openQuotesSample, issueDiag,
  } = acc;

  // Four mutually-exclusive sold-$ buckets: Released, Working (sold but held),
  // Open Quotes (sold lead, job still pre-firm), Cancelled.
  // Net Sale = Gross − Cancelled = Released + Working + Open Quotes (every non-cancelled
  // sold $). This ties to the Reece report's "Net Sale" and is consistent with the
  // Net Close COUNT (both span all non-cancelled deals). The Released/Working/Open split
  // is retained as a sub-breakdown (bucket_tally) for the pipeline-risk view.
  // Pending Revenue = Working ONLY — open quotes are NOT folded in (an unsigned quote
  // would inflate Pending).
  const open_quotes = other_pending;
  const pending_total = working_dollars;   // Pending Revenue = Working only
  const cancelled_dollars = Math.round(gross_sales - (released_dollars + working_dollars + other_pending));
  const net_sales = released_dollars + working_dollars + other_pending;  // Gross − Cancelled

  return {
    ...extra,
    leads, sets, issued, net_issue, demos, sales: sold, net_close, ko_count,
    gross_sales, net_sales,
    good_business: net_sales,            // = Net Sale (non-cancelled total)
    released_dollars, working_dollars,
    pending_total,
    pending_dollars: pending_total,      // = Working only (open quotes excluded; see raw_inputs.open_quotes)
    deposits: 0,                         // ⚠ TIE-OUT (job/milestone field; 0 until mapped)
    revenue_basis: 'released/working/cancel v1',
    // ── Report ratios (Marketing Sub-Source By Appt Date) ──
    pct_issue:     rate(issued, sets),       // Issue ÷ Set
    demo_pct:      rate(demos, net_issue),   // Demo ÷ Net Issue
    close_pct:     rate(sold, demos),        // % Gross Close = Sold ÷ Demo
    pct_net_close: rate(net_close, demos),   // # Net Close ÷ Demo
    good_rate_pct: rate(released_dollars, gross_sales), // released ÷ gross
    ko_pct:        rate(ko_count, sold),
    gsli:          money(gross_sales, issued),       // Gross Sale $ ÷ Issue
    nsli:          money(net_sales, issued),         // Net Sale $ ÷ Issue (ties to report NSLI)
    avg_sale:      money(net_sales, net_close),      // Net Sale $ ÷ Net Close
    raw_inputs: {
      basis: 'appt_date',
      window: { periodStart, periodEnd },
      status_tally: statusTally,
      status_dollar_tally: statusDollarTally,  // sold-lead $ per status (bucket calibration)
      cancel_statuses: CANCEL_STATUSES,
      released_statuses: RELEASED_STATUSES,
      working_statuses: WORKING_STATUSES,
      revenue_basis: 'released/working/cancel v1',
      bucket_tally: { released_dollars, working_dollars, other_pending, cancelled_dollars },
      open_quotes,                       // = bucket_tally.other_pending; Pending excludes this
      pending_basis: 'working_only',     // Pending Revenue = Working; open quotes shown separately
      suspect_sold_sample: openQuotesSample, // sold leads with pre-firm $ (diagnose "Quoted on sold")
      non_demo_tally: nonDemoTally,
      issue_diag: issueDiag,             // candidate "issued" definitions (Issue tie-out)
      tie_out: ['net_issue', 'net_close', 'net_sales', 'released_dollars',
                'working_dollars', 'gross_sales', 'cancel_statuses'],
    },
  };
}

/**
 * Compute actuals from LP prospect records, By Appt Date.
 *
 * @param {object[]} prospects   GetLead prospect records (each with nested .leads[])
 * @param {object}   opts        { periodStart, periodEnd, groupBy? }
 * @param {string[]} [opts.groupBy]  e.g. ['source','sub_source'] → returns an ARRAY
 *                                    of per-group rows (each carrying its key fields).
 *                                    Omit for a single aggregate object (unchanged).
 * @returns {object|object[]} aggregate actuals row, or per-group rows when groupBy set.
 */
export function computeActuals(prospects, { periodStart, periodEnd, groupBy } = {}) {
  const grouped = Array.isArray(groupBy) && groupBy.length > 0;
  const global = makeAcc();
  const groups = grouped ? new Map() : null;   // key → { fields, acc }

  for (const prospect of prospects || []) {
    const leadList = getField(prospect, 'leads', 'Leads') || [];
    for (const lead of leadList) {
      // Cohort key: APPOINTMENT date (ET calendar day) within the window.
      const apptDate = etDateOf(lpDateToEastern(getField(lead, ...SCORECARD_FIELD_MAP.appt_date)));
      if (!apptDate || apptDate < periodStart || apptDate > periodEnd) continue;

      accumulateLead(global, lead);

      if (groups) {
        const fields = {};
        for (const f of groupBy) {
          const v = getField(lead, ...(SCORECARD_FIELD_MAP[f] || [f]));
          fields[f] = v == null || v === '' ? null : v;
        }
        const key = groupBy.map((f) => String(fields[f] ?? '')).join('');
        let entry = groups.get(key);
        if (!entry) { entry = { fields, acc: makeAcc() }; groups.set(key, entry); }
        accumulateLead(entry.acc, lead);
      }
    }
  }

  if (!groups) return finalizeActuals(global, { periodStart, periodEnd });
  return [...groups.values()].map((e) => finalizeActuals(e.acc, { periodStart, periodEnd }, e.fields));
}
