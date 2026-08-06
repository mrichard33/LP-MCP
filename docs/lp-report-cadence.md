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

### Scope is part of snapshot identity (2026-08-05)

Every snapshot carries a `scope` (`mtd` · `ytd` · `month` · `custom`) derived
from its declared range vs its generation date, and the replace-on-overlap rule
applies only WITHIN a scope family (`ytd` alone; `mtd`+`month` together;
`custom` alone). A YTD pull and an MTD pull of the same report are different
reports about different windows, not competing versions of one, so both stay
current. This is what makes a mis-scheduled MTD pull harmless: on 2026-08-05 an
MTD Sales Efficiency PDF retired the YTD snapshot and blanked Gross / Net /
Cancellations on the dashboard. It cannot recur.

Reads pick ONE snapshot per report type per view: flow metrics (issued, sat,
sold count, gross, cancellations) from the scope matching the view; cohort-
mature metrics (net sold, NSA, NSLI) only from a snapshot that actually carries
them — an MTD pull's blank Net column renders "still maturing", never a
borrowed YTD figure and never $0.

All to `lp-reports@reecewindowsmail.com`. Ingestion is **five independent
workflows** — `I.LPRA` (134) · `I.LPRB` (133) · `I.LPRC` (135) · `I.LPRD` (136)
· `I.LPRE` (137) — each polling Gmail every 15 minutes on a broad query
(sender + `has:attachment filename:pdf`, no subject dependence) and selecting
its own report by the `_133_`…`_137_` ID in the attachment filename.

The single combined router was tried and **rolled back on 2026-08-05**: when
all five reports arrived in one poll window it handled one and the rest were
dropped. Five triggers cannot drop a sibling's report, and the filename-ID
guard examines every message in the poll and every attachment in each message,
so simultaneous arrivals all flow. A report type that stops arriving is caught
by the LP-MCP watchdog, which arms per report type after that type's first
scheduled success.

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
