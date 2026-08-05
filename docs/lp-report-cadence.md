# LP Report Automation — Recommended Cadence (2026-08-05)

**Answer to the cadence question: daily month-to-date pulls plus periodic full-YTD
validation pulls (option 4).** Job Status is the one exception — it is a stock
snapshot, always pulled full-YTD.

## Why not previous-day-only

LP backdates milestones and statuses. A correction dated three days back would
never be re-pulled under a previous-day schedule, and that revenue silently never
lands. Month-to-date pulls self-heal within the month: each pull fully replaces
that month's picture (snapshot-replace per `(report_type, period_start)` with
`is_current`), so backdated corrections are absorbed automatically. A weekly +
month-end full-YTD pull catches cross-month corrections and validates that the
summed monthly snapshots equal the YTD pull.

Duplicate risk from daily MTD pulls is **zero** as long as snapshot-replace
semantics hold — each accepted import demotes the prior current snapshot for the
same `(report_type, period_start)`. Appending instead of replacing is the only
way duplicates occur; replace behavior is asserted live (see the 2026-08-05
accuracy report §6) and enforced by the partial unique index
`scorecard_report_snapshots_current_idx`.

## The schedule

| Report | LP schedule | Feeds | Cadence |
|---|---|---|---|
| **Jobs by Milestone Date** (RTP, Actual) — Report A | ~6:00 ET daily (existing) | Goal & Pace, Net—Released, Funnel Sales | Month-to-date daily + prior month through business day 5 |
| **Jobs By Status** — Report B | ~6:15 ET daily (existing) | Good Business split (monthly cohort) | Point-in-time daily (existing behavior) |
| **Job Status Report** (open jobs) — Report C′ source for `job_status_ytd` | new | Net (Good Business) Breakdown: HOA / Permit / Other pending | **Full YTD daily** — it is a stock snapshot, not a period cohort |
| **Lead Disposition Detail** — I.LPRC | ~6:30 ET daily (new) | Leads row, Issue %, funnel counts, source analysis | Month-to-date daily + monthly full-YTD validation pull |
| **Marketing Sub Source Cost Anlysis 2** — I.LPRD | ~6:45 ET daily (new) | Sold This Period (NumSold/NumNetSold, GSA/NSA), NSLI, marketing ROI | Month-to-date daily + monthly full-YTD validation pull |

All to `lp-reports@reecewindowsmail.com`, staggered 6:00 / 6:15 / 6:30 / 6:45 ET.
n8n polls the inbox every 15 minutes (worst-case ~15 min ingest latency; one poll
window can pick up multiple reports — each Gmail trigger matches only its own
subject filter, so that is safe).

## Format: PDF-only is confirmed — consequences

Mark confirmed 2026-08-05 that LP's scheduler **cannot export CSV/XLS; reports
always arrive as PDF.** The 2026-08-05 CSVs were a one-time manual backfill and
are cents-accurate; the scheduled PDFs round to whole dollars and cannot support
penny-accurate reconciliation. Two consequences:

1. **The direct-URL fetch path rises in priority.** If LP report URLs can be
   fetched directly (investigation already underway), that path can presumably
   return the cents-accurate export the UI produces manually. This is now the
   only route to automated penny-accurate daily data.
2. **The new PDF endpoints fail closed until samples exist.** No sample PDF of
   Lead Disposition Detail or Marketing Sub-Source Cost existed on 2026-08-05,
   so `/n8n/admin/lp-report-ingest/{lead-disposition|source-cost}` archive the
   PDF, log `parser_pending`, alert GroupMe, and write nothing. The first real
   scheduled email IS the parser-development sample: pin the Gmail subject
   filter against it, build the parser in `src/jobs/` (the validate/load layer
   is already shared with the CSV path), then the pipeline goes live.

## Recommendations to LP (flagged, not yet requested)

- **Add a branch column to the Job Status Report.** It carries no `brn_id`;
  market attribution currently rides a `cst_id → Lead Disposition id` join
  (938/940 on 2026-08-05) — a workaround, not an architecture.
- Ask whether report scheduling can deliver the cents-accurate CSV the manual
  export produces (or expose a stable fetch URL).
