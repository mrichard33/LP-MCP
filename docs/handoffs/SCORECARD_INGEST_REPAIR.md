# Claude Code Handoff — Scorecard ingest repair + initial backfill

**Prepared:** 2026-08-09 · **Revised:** 2026-08-10 (v3 — the diagnosis changed, read §0)
**Scope:** the LP report → n8n → LP-MCP → `scorecard_*` pipeline, and the one-time load of the months already in the inbox.

---

## §0 — Corrections. Four earlier claims were wrong.

**WRONG: "LP's scheduler is PDF-only."**

**LP sends CSV.** Mark confirmed 2026-08-10: the scheduled reports arrive as CSV via the LP **report exporter**, an add-on configured by Amanda at LP.

This claim came from a code comment in `lp-csv-ingest.js` — *"LP's scheduler is PDF-only, confirmed 2026-08-05"* — which predates the exporter and is now stale. **The comment is wrong and should be corrected in the source.** Everything built on it was wrong too, including the instruction below.

**WITHDRAWN: "change `filename:csv` → `filename:pdf`."** Do not do this. The Gmail filters are correct as written.

**WRONG: "`I.LPRA/B/E/F` do not exist in n8n."** All six exist and are active. That inventory used `limit: 60` and returned exactly 60 rows — a truncated page read as an absence.

**WRONG: "`parser_pending` is why 135 and 136 fail."** Stale. `PDF_PENDING_TYPES = {}` since 2026-08-06; both graduated. Newest such row is 2026-08-06 12:00.

### The six workflows, verified 2026-08-10

| Workflow | ID | Nodes | Last edited |
|---|---|---:|---|
| `I.LPRA` — 134 Jobs by Milestone | `mmgiTOWznsTfz8c9` | 6 | 2026-08-07 22:20 |
| `I.LPRB` — 133 Jobs By Status | `fzDXhS0mC5DSbgRj` | **13** | 2026-08-07 22:09 |
| `I.LPRC` — 135 Lead Disposition | `0cEoJ0GI5tBrQFp7` | 6 | 2026-08-07 22:30 |
| `I.LPRD` — 136 Source Cost | `7aFZC5BLzvp9QgaK` | 6 | 2026-08-10 17:52 |
| `I.LPRE` — 137 Sales Efficiency | `OyjpSpcDbSf2hC7G` | 6 | 2026-08-06 22:42 |
| `I.LPRF` — 138 Appt Stats | `x4IebASKtAFWdiND` | **13** | 2026-08-07 21:55 |

B and F carry 13 nodes against the others' 6. Read them before changing them — they are a different shape.

---

## §1 — THE BUG: the Code node filters on an ID that CSV filenames do not carry

Each workflow's Code node does this:

```js
const RE = /_136_/;                       // ← PDF-era filename routing
for (const item of $input.all()) {
  for (const key of Object.keys(bin)) {
    const fileName = bin[key]?.fileName ?? '';
    if (!RE.test(fileName)) continue;     // ← drops EVERY CSV attachment
```

And `lp-report-csv-common.js` states plainly why that cannot work:

> *"CSV attachments are ALL named `_<YYMMDDHHMMSS>_Export.csv`, so the LP report ID that the PDF filenames carried (`_134_`) is simply gone. Routing moves to the one thing the file still asserts about itself: its header row."*

**The Gmail trigger fetches the CSV correctly. The Code node then discards it, because a CSV filename has no `_136_` in it.** Zero items reach the POST node, and the workflow completes having done nothing — exactly what Mark sees.

This is a half-finished migration. The trigger was moved to CSV; the filename routing and the POST target were left on the PDF design.

### Confirming evidence

`scorecard_ingest_log` has **zero** rows for `lead_disposition` or `source_cost` after **2026-08-06 22:00:38** — immediately before both workflows were edited. Two active hourly triggers, silent since.

### The fix, per workflow

1. **Gmail trigger — leave `filename:csv` alone.** It is correct.
2. **Code node — remove the `_1NN_` filename test.** It can never match. Keep the loop over every message and every attachment; just stop filtering on the name. Pass all `.csv` attachments through.
3. **POST node — retarget:**
   - URL → `https://lp-mcp-production.up.railway.app/n8n/admin/lp-csv-ingest/<slug>`
   - `Content-Type` → `text/csv`
4. Update the sticky note. Every one still describes PDF-era filename routing and will mislead the next reader.

### Which slug, and why it barely matters

`registerLpCsvRoutes` registers these, and **the header decides, not the slug**:

```js
export const CSV_REPORT_TYPES = {
  'job-status': 'job_status_ytd',
  'lead-disposition': 'lead_disposition',
  'source-cost': 'source_cost',
  'sales-efficiency': 'sales_efficiency',
  'jobs-by-milestone': 'jobs_by_milestone',
};
```

The route handler calls `detectReportFromHeader(...)` and ingests as the **resolved** type, logging a warning when the slug disagreed. So a mis-slugged CSV still lands correctly. Use the matching slug anyway for readable logs.

All six reports are fingerprinted in `REPORT_FINGERPRINTS` — 133, 134, 135, 136, 137, 138 — so header routing covers every one.

⚠️ **Note for 138:** there is **no `appt-stats` slug**. `I.LPRF` must post to one of the five above and let the fingerprint route it. It works — `ingestCsv` handles `appt_stats_by_rep_source` — but it reads wrong. Adding the slug to `CSV_REPORT_TYPES` is a one-line change worth making.

⚠️ **Note for 133:** the fingerprint resolves 133 to **`job_status_ytd`**, *not* `jobs_by_status`. Those are two distinct report types over the same LP report; `jobs_by_status` is the legacy PDF type writing to a different table. This is already handled correctly — do not "fix" it.

### Once this is done, the PDF path is dead weight

If every scheduled report now arrives as CSV, the PDF parsers (`ingestLeadDispositionPdf`, `ingestSourceCostPdf`, `ingestSalesEfficiencyPdf`) have no live producer. **Do not delete them yet** — they are the fallback if the exporter is ever turned off, and the archived PDFs still parse. But stop treating the PDF routes as the primary path, and correct the stale comments in `lp-csv-ingest.js` that assert otherwise.

The CSV path is also the better one: cents-exact control totals and eleven assertions in `lp_csv_ingest_finalize`, against PDF text extraction. Getting onto it fully is an upgrade, not a workaround.

---

## §2 — Why a manual run finds nothing even after §1 is fixed

The Gmail Trigger is a **polling** node. n8n keeps per-workflow `staticData`:

```json
"node:Gmail Trigger: LP scheduled email": {
  "lastTimeChecked": 1786230960,
  "possibleDuplicates": ["19fe3a9803f824ab", "19fe3a96766a39dc", ...]
}
```

Once a message ID is in that list it is never emitted again, and manual execution honours the same dedupe. Every email that arrived while the Code node was dropping attachments **was still polled** — the poll ran, the clock advanced, the message was marked seen.

**A Gmail polling trigger cannot backfill. It is forward-only.** Fixing §1 restores tomorrow's feed and recovers nothing already in the inbox. Use §4 for the history.

---

## §3 — Multi-month arrivals need no new filtering

Mark sends several months at once and asked whether the triggers filter correctly. They do not need to.

The Code node loops **every message in the poll** and **every attachment in each message**. Downstream, each file gets its own `sha256` → its own snapshot → its own `period_start`/`period_end` read **from the file header**, not from the caller. `ingestCsv` rejects a caller/file period disagreement with `period_mismatch`.

Three months of report 135 in one poll produce three separate snapshots. Months cannot collide or overwrite each other.

**Do not add month-filtering.** The real collision risk is `is_current` — see §5.

---

## §4 — Loading the months already in the inbox

**A one-time backfill script that POSTs the files directly. Not manual uploads, and not the trigger.**

`?source=` exists precisely so a manual load is distinguishable from the n8n feed, and `source: 'manual'` rows already exist in the log.

1. Download the attachments to a local folder.
2. POST each to `/n8n/admin/lp-csv-ingest/<slug>` with `Content-Type: text/csv`, the ingest secret header, and `?source=manual-backfill`. **The header fingerprint routes it**, so the slug need only be plausible — but there is no need to identify the report from the filename, which is the whole point of §1.
3. **Oldest month first.** `is_current` promotion is last-write-wins within a period.
4. **Serially.** Concurrent loads on one report type are how orphans (§6) form.
5. Log every response. `success:false` with a reason is a real rejection to read, not a hiccup to retry. `duplicate: true` with `success: true` is a clean no-op and expected on re-runs.

⚠️ **Clear the orphans (§6) first**, or files matching an orphaned sha are rejected on arrival.

---

## §5 — `is_current` on multiple snapshots per report type

```
report_type              snapshots   is_current
jobs_by_milestone           10           5
sales_efficiency            11           4
lead_disposition             5           3
source_cost                  8           2
appt_stats_by_rep_source     2           2
```

**The item that matters most for report accuracy**, and it interacts directly with a multi-month backfill. A stalled feed is visible; silent double-counting is not, and `v_scorecard_current` is a bare `SELECT … WHERE is_current`.

**Establish the intended grain before changing anything.** If one-current-per-`(report_type, period_start, period_end)` is correct, several months each holding a current snapshot is normal:

```sql
SELECT report_type, period_start, period_end, count(*) FILTER (WHERE is_current) AS current_count
FROM scorecard_report_snapshots
GROUP BY 1,2,3 HAVING count(*) FILTER (WHERE is_current) > 1;
```

Only rows returned here are genuine violations. Run **before and after** the backfill; make it a permanent assertion.

---

## §6 — 27 snapshots are orphaned and block their own re-sends

```
jobs_by_milestone  10/10 never finalized
job_status_ytd      8/9
jobs_by_status      4/4
sales_efficiency    4/11
source_cost         1/8
```

`probeExistingSnapshot` returns, still firing 2026-08-09 00:00:53:

> *"an earlier ingest of these bytes began but never finalized; it holds the unique key, so this re-send cannot land until it is cleared"*

The unique constraint on `(report_type, file_sha256)` has no `finalized_at` filter, so a `begin` that never finalized keeps the key permanently. The code deliberately does not self-clear — *"Clearing the orphan is an operator action."*

Cleanup routine, not hand-deletion: confirm `finalized_at IS NULL`, remove child rows in the same transaction, delete the snapshot, log what was cleared. Then add a reaper — or a `pg_cron` job — for orphans older than ~6 hours. A backfill produces more failed loads than normal operation, so this matters more during one.

---

## §7 — `appt_stats_by_rep_source` is landing February data

Last ingest 2026-08-08, `period_end` = **2026-02-28**. The period comes from the file header, so the file declares February. Either LP's schedule for 138 has a fixed date range that was never made relative, or a February export is being replayed.

Check the LP-side schedule first — and given the exporter is new, check whether its date range is relative or pinned. This is the failure mode flagged before the pipeline was built: *"A schedule is useless if the range is hard-coded."*

---

## §8 — `disposition_sum_mismatch`, 40 occurrences, still firing

`appt_stats_by_rep_source`, same row every run: `src_id: "Canvass"`, `row_num: 2`, `salesrep: "(SalesRep Unknown)"`.

`lp-report-parse-appt-stats.js` exports `SALESREP_UNKNOWN`, and `ingestCsv` already treats that bucket as expected — counted into `extraDetail.salesrep_unknown`, noting LP files pre-assignment sets under its own label (12 rows, 1,822 sets in January 2026). The parser knows about it; the validator still applies a per-row sum rule to it.

**Confirm from a real file whether that row is a rollup.** If it is, exempt it as the totals row is exempted. If it is a genuine peer row whose numbers do not sum, the gate is doing its job and this is LP data trouble.

---

## §9 — Every failure is logged twice

Bare and `n8n_`-prefixed with matching timestamps: `parser_pending` 23/24, `disposition_sum_mismatch` 20/20, `unmapped_status` 12/13, `finalize_assertion` 13/12, `orphaned_snapshot` 6/6. The route logs it; the telemetry node POSTs `/events/lp_report_ingest_failed`, which logs it again.

Failure counts are ~2x reality. Drop the prefixed copy or add an origin column. Report types are also inconsistent (`source_cost` vs `source-cost`) despite `canonicalReportType` existing — normalise on write.

---

## §10 — The ingest secret is hardcoded in the workflow JSON

Both inspected workflows carry a literal `x-ghl-signature` value in two nodes each, plaintext in the stored definition and returned by the n8n API. It is the shared secret for every ingest route, so anyone with workflow read access can post arbitrary report bytes into the scorecard.

Move to a credential or environment expression, then **rotate** — it has been retrievable.

---

## §11 — OPEN QUESTION: is the monthly goal measured against gross or net?

Mark reports the dashboard appears to measure the monthly goal against **gross** when it should be **net**.

Established:

- `lp_report_facts` carries both `gross_sold` and `net_sales` from `jobs_by_milestone`, so either basis is available.
- The goal columns (`monthly_goal_dollars`, `goal_dollars`) carry **no gross/net designation**. Nothing in the schema records which basis a stored number represents.
- `lib/scorecard/viewModel.ts:517` renders `"Net Sales (Released)"` with `monthGoal: usd(d.goal.effective_monthly_goal)` against `actual: a.net_sales` — on **that row**, goal is compared to net.
- `lib/queries/reportFacts.core.ts:376` computes `const gross = sumMetric(sc, "gross_sold")`, so gross is summed elsewhere in the same pipeline.
- `lib/scorecard/viewModel.ts:484` derives `monthlyIssued` from `g.monthly_goal_dollars / nsliRate`, so the goal drives derived targets too, not just an attainment bar.

**Which tile Mark is seeing was not traced and is not guessed here.** Trace `effective_monthly_goal`, `mtd_goal_dollars` and `period_goal_dollars` through `viewModel.ts` (roughly lines 244–250 and 480–520), identify every tile that divides an actual by a goal, and confirm which actual each uses.

Then settle **what a stored goal means**. Since the schema does not say, a goal entered as net and compared to gross understates attainment by the gross-to-net gap. If net is intended, record it — a comment in `goalSchema.ts` and a note in the Goal editor UI.

**Do not change the comparison until both are answered.** Switching a goal basis silently rewrites every historical attainment figure.

---

## Order of work

1. **§6** — clear the 27 orphans.
2. **§1** — fix the Code node + POST target on all six. This is the one that restores the feed.
3. **§4** — backfill the inbox months, oldest first, serially.
4. **§5** — run the grain query before and after; make it permanent.
5. **§7, §8** — LP schedule for 138; the `(SalesRep Unknown)` rule.
6. **§11** — trace the goal basis and rule on it.
7. **§9, §10** — logging hygiene; the secret.

---

## Working rules

1. **MCP is reality, and so is Mark.** A stale code comment is not evidence — the "PDF-only" comment in `lp-csv-ingest.js` sent this diagnosis the wrong way for a full revision. Correct it in the source while you are in there.
2. **A Gmail polling trigger cannot backfill.** Forward-only, dedupes on message ID.
3. Deterministic content failures are 200 + `success:false`; 5xx is reserved for infrastructure, because 5xx is the only thing n8n replays.
4. A duplicate is not a failure — it must return `success: true`.
5. Feature branch off `main`, PR, Mark merges. Never commit to `main`.
