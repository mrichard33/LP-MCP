# Claude Code Handoff — Scorecard ingest repair

**Prepared:** 2026-08-09. Every figure measured live.
**Scope:** the LP report → n8n → LP-MCP → `scorecard_*` pipeline.

---

## Correction first — two earlier claims in this session were wrong

I diagnosed this pipeline twice. The first pass was wrong on two points. Both corrections are load-bearing, so read them before touching anything.

**WRONG: "`Content-Type: application/pdf` is the bug; flip it to `text/csv`."**

It is not a bug. `/n8n/admin/lp-report-ingest/{lead-disposition,source-cost}` is bound with:

```js
const rawPdf = express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' });
```

and runs real PDF parsers (`ingestLeadDispositionPdf`, `ingestSourceCostPdf`). `application/pdf` is **correct** for that route. Flipping the header would have made `express.raw` skip the body, and the route would have answered `400 POST the raw PDF bytes`. **Do not make that change.**

**WRONG: "`parser_pending` is why 135 and 136 fail."**

Stale. `lp-csv-ingest.js` declares:

```js
export const PDF_PENDING_TYPES = {};   // EMPTY as of 2026-08-06 — 135 and 136 graduated
```

Both have live PDF parsers. The newest `parser_pending` row is **2026-08-06 12:00:21**, before the graduation. Those log rows are history, not a live failure.

---

## §1 — THE BUG: the Gmail filters ask for CSVs that LP never sends

Both live ingest workflows filter on `filename:csv`:

**`I.LPRC`** (report 135, workflow `0cEoJ0GI5tBrQFp7`, last edited 2026-08-07 22:30):
```
to:lp-reports@reecewindowsmail.com from: ReportScheduler@leadperfection.com
subject:"Lead Disposition Detail" has:attachment filename:csv
```

**`I.LPRD`** (report 136, workflow `7aFZC5BLzvp9QgaK`, last edited 2026-08-06 22:43):
```
to:lp-reports@reecewindowsmail.com from: ReportScheduler@leadperfection.com
subject:"Mktg Sub-Source Cost Analysis" has:attachment filename:csv
```

**LP's scheduler is PDF-only.** Stated in `lp-csv-ingest.js`:

> *"The CSVs are today a manual backfill (LP's scheduler is PDF-only, confirmed 2026-08-05). … All five LP reports now parse from the scheduled PDF."*

So the trigger matches nothing. Everything downstream is correct — the `_135_` / `_136_` filename routing, the PDF Content-Type, the endpoint, the parsers, the IF/telemetry wiring. Only the attachment-type predicate is wrong.

Both sticky notes still describe the query as *"sender + has:attachment + **PDF**"*, which is the original and correct design. Someone changed the query and not the note.

### Confirming evidence

`scorecard_ingest_log` has **zero** rows for `lead_disposition` or `source_cost` after **2026-08-06 22:00:38** — immediately before both workflows were edited. Two active hourly triggers, silent for three days.

### The fix

In both workflows, in the Gmail Trigger `filters.q`, change `filename:csv` → `filename:pdf`. Nothing else.

Then re-read the sticky notes and make sure they still match. They already say PDF, so they will.

### Do not "fix" this by pointing at the CSV routes

`/n8n/admin/lp-csv-ingest/*` exists and works, but it is **for manual backfill**. LP cannot schedule CSV — asked and answered 2026-08-05. Wiring n8n to the CSV routes would produce a pipeline with no input.

**If CSV end-to-end is genuinely wanted**, that is an LP-side request (schedule the five reports as CSV), not an n8n change. Until LP supports it, PDF is the only automatable path and the parsers for all five already exist. Raise it with Mark rather than building around it.

---

## §2 — 27 snapshots are orphaned and permanently block their own re-sends

```
report_type          snapshots   never_finalized
jobs_by_milestone       10            10
job_status_ytd           9             8
jobs_by_status           4             4
sales_efficiency        11             4
source_cost              8             1
                        ──            ──
                        49            27
```

`probeExistingSnapshot` explains it, and the comment above it documents the reasoning: the unique constraint on `(report_type, file_sha256)` has no `finalized_at` filter, so a row from a `begin` that never reached `finalize` keeps the key forever. Every re-send of those bytes now returns:

```
success:false, reason: orphaned_snapshot
"an earlier ingest of these bytes began but never finalized; it holds the
 unique key, so this re-send cannot land until it is cleared"
```

Still firing at **2026-08-09 00:00:53**.

The code deliberately does not self-clear — *"Clearing the orphan is an operator action — nothing is deleted here."* That is the right call. So this needs a deliberate cleanup.

**Write a cleanup routine, do not hand-delete.** For each orphan: confirm `finalized_at IS NULL`, confirm no child rows reference it (or delete them in the same transaction), delete the snapshot, log what was cleared and why. Run it, then re-send the affected files.

Also worth fixing at the source: nothing currently reaps orphans. A `begin` that never finalizes should either roll back or be swept. Add a sweep — or a `pg_cron` job once installed — clearing snapshots with `finalized_at IS NULL` older than, say, 6 hours. Without it this recurs.

---

## §3 — `is_current` is set on multiple snapshots per report type

```
report_type          snapshots   is_current
jobs_by_milestone       10            5
sales_efficiency        11            4
lead_disposition         5            3
source_cost              8            2
appt_stats_by_rep_source 2            2
```

`is_current` is promoted inside `lp_csv_ingest_finalize`, which is supposed to demote the prior current snapshot in the same transaction. Multiple current rows per report type means either the demotion is scoped wrong (probably per `period_start`/`period_end` rather than per `report_type`, which would be legitimate if periods differ — **check this before assuming a bug**) or it is not running on some paths.

**This is the most dangerous item in this document.** A stalled feed is visible. Duplicate `is_current` rows are not: anything reading `WHERE is_current = true` silently double-counts, and the numbers still look plausible. Given `lp_market_scorecard_resolved` is the authoritative source for market metrics that reach Chris and Randy, verify this before trusting any current scorecard figure.

Determine intended grain first. If one-current-per-`(report_type, period_start, period_end)` is correct, the counts above may be fine — five `jobs_by_milestone` snapshots could be five distinct months. Query the periods before changing anything:

```sql
SELECT report_type, period_start, period_end, count(*) FILTER (WHERE is_current) AS current_count
FROM scorecard_report_snapshots GROUP BY 1,2,3 HAVING count(*) FILTER (WHERE is_current) > 1;
```

Only rows returned here are real violations. Add this as a permanent assertion.

---

## §4 — `appt_stats_by_rep_source` is landing February data

Last ingest **2026-08-08 00:00:07**, `period_end` = **2026-02-28**. Six months stale, and it is the only report type currently producing successes.

The period comes from the file header (`parsed.header.periodStart/periodEnd`), and `ingestCsv` rejects a caller/file period mismatch with `period_mismatch`. So the file itself declares February. Either the LP schedule for report 138 has a fixed date range that was never made relative, or a backfill of February is being replayed on a loop.

This is the exact failure mode flagged before this pipeline was built — *"A schedule is useless if the range is hard-coded to 07/01–07/28."* Check the LP-side schedule for 138 first; this is likely LP configuration, not code.

---

## §5 — `disposition_sum_mismatch`, 40 occurrences, still firing

`appt_stats_by_rep_source`, tripping on the same row every run:

```
src_id: "Canvass", row_num: 2, salesrep: "(SalesRep Unknown)"
```

`lp-report-parse-appt-stats.js` exports `SALESREP_UNKNOWN` and `ingestCsv` already treats that bucket as expected — it is counted into `extraDetail.salesrep_unknown` with the note that LP files pre-assignment sets under its own label (12 rows, 1,822 sets in January 2026).

So the parser knows the bucket exists, but `validateApptStatsCsv` still applies a per-row disposition-sum rule to it. **Check whether that row is meant to be exempt.** If LP's `(SalesRep Unknown)` row is a rollup rather than a peer row, the arithmetic rule should skip it, the same way the totals row is skipped.

**Do not simply loosen the gate.** Confirm from a real file whether the row is a rollup. If it is a genuine peer row whose numbers do not sum, that is LP data trouble and the gate is doing its job.

---

## §6 — Something is POSTing as `I.LPRB` and `I.LPRF`, and neither exists

Tonight's telemetry carries `"workflow": "I.LPRB"` and `"workflow": "I.LPRF"`. The n8n instance holds **only** `I.LPRC` and `I.LPRD`. There is no `I.LPRA`, `I.LPRB`, `I.LPRE`, or `I.LPRF`.

Half the recent rows also carry `source: 'manual'`, which `ingestCsv` sets from `?source=` — so something outside this n8n instance is calling the ingest endpoints and labelling itself with workflow names that were designed but never built here.

**Identify what that is before building the missing workflows.** Candidates: a second n8n instance, a script, or a Railway job. If it is rebuilt in n8n without finding the existing caller, there will be two writers racing on the same snapshots — and given §2, one of them will orphan the other's rows.

---

## §7 — Every failure is logged twice

Each failure appears once bare and once `n8n_`-prefixed, with matching timestamps and near-identical counts:

```
n8n_parser_pending 24 / parser_pending 23
n8n_disposition_sum_mismatch 20 / disposition_sum_mismatch 20
n8n_unmapped_status 13 / unmapped_status 12
n8n_finalize_assertion 12 / finalize_assertion 13
n8n_orphaned_snapshot 6 / orphaned_snapshot 6
```

The route logs the failure, then n8n's telemetry node POSTs `/events/lp_report_ingest_failed`, which logs it again with a prefix. Both are useful individually; double-writing them into one table is not. Either drop the prefixed copy, or add a column distinguishing origin so counts can be filtered. Failure counts in `scorecard_ingest_log` are currently ~2x reality.

Report types are also inconsistent — `source_cost` vs `source-cost`, `jobs_by_status` vs `jobs-by-status`, `sales_efficiency` vs `sales-efficiency`. `canonicalReportType` exists in `lp-report-ingest.js`; the telemetry path clearly is not using it. Normalise on write.

---

## §8 — The ingest secret is hardcoded in the workflow JSON

Both workflows carry a literal `x-ghl-signature` value in two nodes each, stored in plaintext in the n8n workflow definition and returned by the API.

Move it to an n8n credential or environment expression. It is the shared secret for every `/n8n/admin/lp-report-ingest/*` route (`LP_REPORT_INGEST_SECRET`), so anyone with workflow read access can post arbitrary report bytes into the scorecard. Rotate it after moving it, since it has been sitting in retrievable form.

---

## Order of work

1. **§1 — `filename:csv` → `filename:pdf`.** One word, two workflows, restores the feed. Verify a real ingest lands within the hour.
2. **§6 — identify the unknown caller.** Before anything is rebuilt.
3. **§3 — determine the `is_current` grain.** This one is producing wrong numbers today.
4. **§2 — clear the 27 orphans**, then add the sweep.
5. **§4 — check LP's schedule for report 138.**
6. **§5 — decide whether `(SalesRep Unknown)` is exempt.**
7. **§7, §8 —** logging hygiene and the secret.

---

## Working rules

1. **MCP is reality.** Every figure here was measured 2026-08-09. If a query disagrees, the query wins.
2. **Do not change the PDF Content-Type or point n8n at the CSV routes.** See the correction at the top.
3. Deterministic content failures are 200 + `success:false`; 5xx is reserved for infrastructure, because 5xx is the only thing n8n replays. Preserve that contract.
4. A duplicate is not a failure — it must return `success: true`.
5. Feature branch off `main`, PR, Mark merges. Never commit to `main`.
