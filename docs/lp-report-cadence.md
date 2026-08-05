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

## The schedule (revised 2026-08-05 — five reports, scope corrections applied)

| Report | LP ID | Time ET | Scope | Feeds |
|---|---|---|---|---|
| **Jobs by Milestone Date** (RTP, Actual) | 134 | 6:00 | **MTD** + prior month through business day 5 (flow — month-anchored self-heals backdated RTP) | Net Released, Goal & Pace |
| **Jobs By Status** | 133 | 6:15 | **YTD** (changed from MTD — a stock metric; the Aug MTD pull returned 38 jobs vs 242 actually open, ~85% understatement) | Open backlog, HOA/Permit/Other |
| **Lead Disposition Detail** | 135 | 6:30 | **MTD daily + YTD weekly** validation | Leads by market, dispositions, source |
| **Marketing Sub Source Cost Anlysis 2** | 136 | 6:45 | **YTD** (changed from MTD — MTD returns $0 for Net Sales, NSLI, Total Cost, Cost/Lead) | Marketing cost, cost-per-lead |
| **Sales Efficiency By Market** | 137 | 7:00 | **YTD daily** (MTD has an entirely blank Net column and garbage NSLI); pin the end date to **yesterday** — a future EDate widens the window past the sibling reports | Per-market Issued/Sat/Sold/**Cancelled**/NSA/NSLI |

All to `lp-reports@reecewindowsmail.com`. Ingestion is the single **I.LPR
router** (one Gmail trigger, routes on the `_133_`…`_137_` report ID in the
attachment filename — subject strings retired); it polls every 15 minutes
(worst-case ~15 min latency; multiple reports in one poll window are safe —
each item routes independently).

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
