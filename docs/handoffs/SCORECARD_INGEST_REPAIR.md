# Claude Code Handoff — Scorecard ingest repair + initial backfill

**Prepared:** 2026-08-09 · **Revised:** 2026-08-10
**Scope:** the LP report → n8n → LP-MCP → `scorecard_*` pipeline, and the one-time load of the months already sitting in the inbox.

---

## Corrections — three claims in the first draft were wrong

**WRONG: "`Content-Type: application/pdf` is the bug; flip it to `text/csv`."**

It is not a bug. `/n8n/admin/lp-report-ingest/{lead-disposition,source-cost}` is bound with:

```js
const rawPdf = express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' });
```

and runs real PDF parsers. `application/pdf` is **correct**. Flipping the header makes `express.raw` skip the body and the route answers `400 POST the raw PDF bytes`. **Do not make that change.**

**WRONG: "`parser_pending` is why 135 and 136 fail."**

Stale. `PDF_PENDING_TYPES = {}` since 2026-08-06 — both graduated to live parsers. Newest `parser_pending` row is 2026-08-06 12:00, before the graduation.

**WRONG: "`I.LPRA/B/E/F` do not exist in n8n."**

They all exist. The earlier inventory was taken with `limit: 60` and returned exactly 60 rows — a truncated page read as an absence. Verified 2026-08-10:

| Workflow | ID | Nodes | Last edited |
|---|---|---:|---|
| `I.LPRA` — 134 Jobs by Milestone | `mmgiTOWznsTfz8c9` | 6 | 2026-08-07 22:20 |
| `I.LPRB` — 133 Jobs By Status | `fzDXhS0mC5DSbgRj` | **13** | 2026-08-07 22:09 |
| `I.LPRC` — 135 Lead Disposition | `0cEoJ0GI5tBrQFp7` | 6 | 2026-08-07 22:30 |
| `I.LPRD` — 136 Source Cost | `7aFZC5BLzvp9QgaK` | 6 | 2026-08-10 17:52 |
| `I.LPRE` — 137 Sales Efficiency | `OyjpSpcDbSf2hC7G` | 6 | 2026-08-06 22:42 |
| `I.LPRF` — 138 Appt Stats | `x4IebASKtAFWdiND` | **13** | 2026-08-07 21:55 |

All six active. The old §6 is withdrawn — there is no unknown external caller; the `I.LPRB` / `I.LPRF` telemetry is simply these workflows. B and F carry 13 nodes against the others' 6, so they are a different shape and should be read before being changed.

---

## §1 — Why every workflow "finds nothing." Two independent causes.

Mark reports all six run and return no data, while the reports are confirmed in the inbox. Both of the following are true, and fixing only one will not help.

### 1a. The Gmail filters ask for CSVs that LP never sends

Verified on `I.LPRC` and `I.LPRD`:

```
subject:"Lead Disposition Detail"        has:attachment filename:csv
subject:"Mktg Sub-Source Cost Analysis"  has:attachment filename:csv
```

**LP's scheduler is PDF-only** — stated in `lp-csv-ingest.js`, confirmed 2026-08-05:

> *"The CSVs are today a manual backfill (LP's scheduler is PDF-only, confirmed 2026-08-05). … All five LP reports now parse from the scheduled PDF."*

So the query matches nothing. Both sticky notes still correctly describe the query as **PDF** — someone changed the query and not the note.

`scorecard_ingest_log` has **zero** rows for `lead_disposition` or `source_cost` after **2026-08-06 22:00:38**, immediately before both were edited.

**Fix:** `filename:csv` → `filename:pdf`. **Check all six** — only C and D were read directly; A, B, E and F must be inspected before assuming.

### 1b. Polling triggers do not re-emit messages they have already seen

This is why a manual run finds nothing **even after 1a is fixed**, and it is the more important of the two for the backfill.

The Gmail Trigger is a polling node. n8n keeps per-workflow `staticData`:

```json
"node:Gmail Trigger: LP scheduled email": {
  "lastTimeChecked": 1786230960,
  "possibleDuplicates": ["19fe3a9803f824ab", "19fe3a96766a39dc", ...]
}
```

Once a message ID is in that list it is never emitted again, and manual execution honours the same dedupe. So:

- Emails that arrived while the filter was broken were still **polled** — the poll ran, matched nothing, advanced the clock.
- Re-running the workflow cannot reach back for them.

**A Gmail polling trigger cannot backfill.** It is a forward-only feed. Clearing `staticData` would force a re-poll, but Gmail's search window and the dedupe list make that unreliable for a multi-month load and risk re-emitting everything at once.

**Use §3 for the historical months. Use 1a to fix the feed going forward.**

---

## §2 — Multi-month arrivals: already handled, verify rather than build

Mark is sending several months at once and asked whether the triggers filter correctly.

The Code node in each workflow already handles this:

```js
const RE = /_135_/;
for (const item of $input.all()) {          // every message in the poll
  for (const key of Object.keys(bin)) {     // every attachment in each message
```

It iterates **all** messages and **all** attachments, keyed on the LP report ID in the filename. Three months of report 135 in one poll produce three items, each POSTed separately.

Downstream, each file is its own `sha256` → its own snapshot → its own `period_start`/`period_end` taken **from the file header**, not from the caller. `ingestCsv` rejects a caller/file period disagreement with `period_mismatch`. Months cannot collide or overwrite each other.

**Do not add month-filtering to the triggers.** The design is already correct. The one thing to confirm is §4 — that `is_current` is scoped per period, because that is where multi-month loads would actually collide.

---

## §3 — How to load the months already in the inbox

**Recommendation: a one-time backfill script that POSTs the files directly. Not manual uploads, and not the Gmail trigger.**

The endpoints are built for this — `ingestCsv` and the PDF ingests take `?source=` precisely so a manual load is distinguishable from the n8n feed, and `source: 'manual'` rows already exist in `scorecard_ingest_log`.

### Shape of the script

1. Download the attachments from the inbox into a local folder. Keep LP's filenames — the `_133_` … `_138_` ID is what identifies the report.
2. Map each ID to its endpoint:

| LP ID | Report | Endpoint |
|---|---|---|
| 133 | Job Status YTD | `/n8n/admin/lp-csv-ingest/job-status` *(CSV)* |
| 134 | Jobs by Milestone | `/n8n/admin/lp-csv-ingest/jobs-by-milestone` *(CSV)* |
| 135 | Lead Disposition | `/n8n/admin/lp-report-ingest/lead-disposition` *(PDF)* |
| 136 | Source Cost | `/n8n/admin/lp-report-ingest/source-cost` *(PDF)* |
| 137 | Sales Efficiency | `/n8n/admin/lp-report-ingest/sales-efficiency` *(PDF)* |
| 138 | Appt Stats by Rep | `/n8n/admin/lp-csv-ingest/*` *(CSV — the header routes it)* |

⚠️ **Confirm each mapping against the live route table before running.** `registerLpCsvRoutes` logs the registered routes on boot; read that line rather than trusting this table. PDF and CSV are different routes with different body parsers, and posting to the wrong one fails.

Note the CSV routes resolve the report from the **file header fingerprint**, not the slug — *"THE HEADER DECIDES, NOT THE SLUG (§C)"* — so a CSV posted to the wrong CSV slug still routes correctly. That safety net does not exist across the PDF/CSV boundary.

3. POST with the matching `Content-Type` (`application/pdf` or `text/csv`), the ingest secret header, and `?source=manual-backfill`.
4. **Oldest month first.** `is_current` promotion is last-write-wins within a period; chronological order means the newest data ends current.
5. **Serially, not in parallel.** Each ingest does a chunked load plus a finalize; concurrent loads on the same report type are how orphaned snapshots (§5) get created.
6. Log every response. A `success:false` with a reason is a real rejection that needs reading — not a transport hiccup to retry. A `duplicate: true` with `success: true` is a clean no-op and expected on re-runs.

### On the CSV question specifically

Mark asked about "collecting the CSV reports properly." To be explicit: the CSV routes work well and are the better parser path — cents-exact control totals rather than PDF text extraction. But **LP cannot schedule CSV**, so CSVs only reach the system by manual export.

The honest picture:

- **Backfill now:** use CSV exports where you have them. Better data, stricter validation.
- **Ongoing feed:** PDF, because that is all LP will schedule.
- **Worth asking LP again:** whether scheduled CSV delivery is now possible. If it is, the entire PDF-parsing layer becomes redundant and the pipeline gets materially more robust. This is the highest-leverage question to put to the vendor.

---

## §4 — `is_current` on multiple snapshots per report type

```
report_type              snapshots   is_current
jobs_by_milestone           10           5
sales_efficiency            11           4
lead_disposition             5           3
source_cost                  8           2
appt_stats_by_rep_source     2           2
```

**This is the item that matters most for report accuracy**, and it interacts directly with a multi-month backfill. A stalled feed is visible; silent double-counting is not, and `v_scorecard_current` is a bare `SELECT … WHERE is_current`.

**Establish the intended grain before changing anything.** If one-current-per-`(report_type, period_start, period_end)` is correct, several months each holding a current snapshot is right and normal:

```sql
SELECT report_type, period_start, period_end, count(*) FILTER (WHERE is_current) AS current_count
FROM scorecard_report_snapshots
GROUP BY 1,2,3 HAVING count(*) FILTER (WHERE is_current) > 1;
```

Only rows returned here are genuine violations. Run this **before and after** the backfill, and make it a permanent assertion.

---

## §5 — 27 snapshots are orphaned and block their own re-sends

```
jobs_by_milestone  10/10 never finalized
job_status_ytd      8/9
jobs_by_status      4/4
sales_efficiency    4/11
source_cost         1/8
```

`probeExistingSnapshot` returns, still firing 2026-08-09 00:00:53:

> *"an earlier ingest of these bytes began but never finalized; it holds the unique key, so this re-send cannot land until it is cleared"*

The unique constraint on `(report_type, file_sha256)` carries no `finalized_at` filter, so a `begin` that never finalized keeps the key permanently. The code deliberately does not self-clear — *"Clearing the orphan is an operator action."*

**Clear these before the §3 backfill**, or any file whose bytes match an orphan is rejected on arrival. Cleanup routine, not hand-deletion: confirm `finalized_at IS NULL`, remove child rows in the same transaction, delete the snapshot, log what was cleared.

Then add a reaper — or a `pg_cron` job — for snapshots with `finalized_at IS NULL` older than ~6 hours. Without it this recurs on every failed load, and a backfill creates more failed loads than normal operation.

---

## §6 — `appt_stats_by_rep_source` is landing February data

Last ingest 2026-08-08, `period_end` = **2026-02-28**. The period comes from the file header, so the file itself declares February. Either LP's schedule for 138 has a fixed date range that was never made relative, or a February backfill is being replayed.

Check the LP-side schedule first. Likely vendor configuration, not code — and it is the failure mode flagged before this pipeline was built: *"A schedule is useless if the range is hard-coded."*

---

## §7 — `disposition_sum_mismatch`, 40 occurrences, still firing

`appt_stats_by_rep_source`, same row every run: `src_id: "Canvass"`, `row_num: 2`, `salesrep: "(SalesRep Unknown)"`.

`lp-report-parse-appt-stats.js` exports `SALESREP_UNKNOWN`, and `ingestCsv` already treats that bucket as expected — counted into `extraDetail.salesrep_unknown`, with a note that LP files pre-assignment sets under its own label (12 rows, 1,822 sets in January 2026). So the parser knows about it while the validator still applies a per-row sum rule to it.

**Confirm from a real file whether that row is a rollup.** If it is, exempt it the way the totals row is exempted. If it is a genuine peer row whose numbers do not sum, the gate is doing its job and this is LP data trouble.

---

## §8 — Every failure is logged twice

Each failure appears bare and `n8n_`-prefixed with matching timestamps: `parser_pending` 23/24, `disposition_sum_mismatch` 20/20, `unmapped_status` 12/13, `finalize_assertion` 13/12, `orphaned_snapshot` 6/6. The route logs it, then the telemetry node POSTs `/events/lp_report_ingest_failed` which logs it again.

Failure counts are ~2x reality. Either drop the prefixed copy or add an origin column. Report types are also inconsistent (`source_cost` vs `source-cost`) despite `canonicalReportType` existing — normalise on write.

---

## §9 — The ingest secret is hardcoded in the workflow JSON

Both inspected workflows carry a literal `x-ghl-signature` value in two nodes each, in plaintext in the stored definition and returned by the n8n API. It is the shared secret for every `/n8n/admin/lp-report-ingest/*` route, so anyone with workflow read access can post arbitrary report bytes into the scorecard.

Move to an n8n credential or environment expression, then **rotate** — it has been retrievable.

---

## §10 — OPEN QUESTION: is the monthly goal measured against gross or net?

Mark reports the dashboard appears to measure the monthly goal against **gross**, when it should be **net**.

What is established:

- `lp_report_facts` carries both `gross_sold` and `net_sales` from `jobs_by_milestone`, so either basis is available.
- The goal columns (`monthly_goal_dollars`, `goal_dollars`) carry **no gross/net designation**. Nothing in the schema records which basis a stored number represents.
- `lib/scorecard/viewModel.ts:517` renders `metric: "Net Sales (Released)"` with `monthGoal: usd(d.goal.effective_monthly_goal)` against `actual: a.net_sales` — on **that row**, goal is compared to net.
- `lib/queries/reportFacts.core.ts:376` computes `const gross = sumMetric(sc, "gross_sold")`, so gross is summed somewhere in the same pipeline.

**Which tile Mark is looking at was not traced, and is not guessed here.** Trace `effective_monthly_goal`, `mtd_goal_dollars` and `period_goal_dollars` through `viewModel.ts` (attainment and pace, around lines 244–250 and 480–520) and identify every tile that divides an actual by a goal. Then confirm which actual each one uses.

Two things to settle, in order:

1. **Which tile is wrong?** Possibly none — the Net Sales row already looks correct, and Mark may be seeing a different tile (pace, tier, or by-market) that uses gross. Note `viewModel.ts:484` derives `monthlyIssued` from `g.monthly_goal_dollars / nsliRate`, so the goal also drives derived targets, not just an attainment bar.
2. **What does a stored goal mean?** Since the schema does not say, a goal entered as net and compared to gross understates attainment by the gross-to-net gap. If net is the intended basis, record it explicitly — a comment in `goalSchema.ts` and a note in the Goal editor UI — so the ambiguity does not return.

**Do not change the comparison until both are answered.** Silently switching a goal basis rewrites every historical attainment figure.

---

## Order of work

1. **§5** — clear the 27 orphans. Nothing else lands cleanly until this is done.
2. **§3** — backfill the inbox months, oldest first, serially.
3. **§4** — run the grain query before and after; make it a permanent assertion.
4. **§1a** — `filename:csv` → `filename:pdf` on all six, restoring the forward feed.
5. **§6, §7** — LP schedule for 138; the `(SalesRep Unknown)` rule.
6. **§10** — trace the goal basis and rule on it.
7. **§8, §9** — logging hygiene; the secret.

---

## Working rules

1. **MCP is reality.** Figures measured 2026-08-09/10. If a query disagrees, the query wins.
2. **Do not change the PDF Content-Type or repoint n8n at the CSV routes.** See the corrections at the top.
3. **A Gmail polling trigger cannot backfill.** Forward-only, and it dedupes on message ID.
4. Deterministic content failures are 200 + `success:false`; 5xx is reserved for infrastructure, because 5xx is the only thing n8n replays.
5. A duplicate is not a failure — it must return `success: true`.
6. Feature branch off `main`, PR, Mark merges. Never commit to `main`.
