# I.LPRA — LP Report CSV Cutover & History Remediation — Runbook

**Status:** built / migration applied → verify + remediate · **Owner:** Mark · **Updated:** 2026-08-06

LP can now schedule CSV exports as email attachments, so CSV becomes the ingest
format for all five reports and the PDF parsers become legacy. This runbook is
the operator half: verify the CSV path end to end, then repair the history that
the PDF parsers got wrong — by re-sending periods as CSV, not by editing or
deleting anything.

> **Scope guardrail:** NO DELETES. Superseded snapshots demote to non-current
> history through the normal promotion path and stay forever — that is the
> RETENTION GUARANTEE (`sql/migrations/2026-08-05_lp_report_facts.sql`). If a
> step here seems to call for a `DELETE` or a purge, the step is wrong. Nothing
> in this runbook edits a stored row; every repair lands a NEW snapshot that
> supersedes the old one.

## What changed, in one paragraph

Three things the PDF pipeline relied on do not exist in a CSV export: the footer
(LP CSV has no footer and no Grand Total row), the report ID in the filename
(every CSV is `_<YYMMDDHHMMSS>_Export.csv`), and `file_sha256` as a dedup key
(every row embeds `CurrentDateTime`, so two pulls of one period differ
byte-for-byte). Routing now happens on the CSV **header row**, dedup on
`content_sha256`, and coverage on the file's own `CurrentDateTime`.

## Deploy order

1. **Apply the migration** — `sql/migrations/2026-08-06_csv_content_identity.sql`
   (already applied 2026-08-06). Additive columns plus a widening CHECK; old code
   cannot see them, so it is safe ahead of the deploy.
2. **Run the smoke** — `sql/verify/2026-08-06_csv_content_identity_smoke.sql` in
   the Supabase SQL editor, as one batch. It is self-checking and rolls back;
   expect `csv_content_identity smoke: ALL CHECKS PASSED`.
3. **Deploy LP-MCP** (Railway, `main` after merge).
4. **Push I.LPRA to the live n8n instance.** The GitHub deploy action has been
   broken since 2026-08-04 (`N8N_API_KEY` empty), so repo and instance are kept
   in sync **by hand** — pushing the repo alone changes nothing. Workflow ID
   `mmgiTOWznsTfz8c9`.

## Schedule change — the previous-month closing pull

Month-anchored scheduling never captures the final day of a month. The last
in-month run happens on the 31st and covers only through that run; on the 1st
the `[BOCM]`/`[EOCM]` tokens roll forward and the closed month is never pulled
again.

**Add a second scheduled run of all five reports on the 2nd–5th of each month,
using `[BOPM]`/`[EOPM]`.** That file carries the same period key as the closed
month's in-month snapshots, so it supersedes them through normal promotion, and
because it is generated *after* `period_end` it is the snapshot that closes the
period. Without it, `period_closed_at` stays NULL forever and every closed month
is represented by a file that stops partway through its last day.

## Smoke test — verify

Run in order. Each step is independently checkable; stop if one fails.

**1. Current-month send of all five reports.** Expect five ingest-log rows, five
snapshots, zero 5xx, zero duplicates.

```sql
SELECT report_type, status, failure_reason, source, created_at
  FROM scorecard_ingest_log
 WHERE created_at > now() - interval '2 hours'
 ORDER BY created_at;
-- expect: 5 rows, all status 'success'/'succeeded', failure_reason NULL
```

**2. The CSV path is actually being used, and identity is populated.**

```sql
SELECT report_type, source_format, parser_version,
       content_sha256 IS NOT NULL AS has_content_sha,
       report_generated_at, is_partial_month, period_closed_at
  FROM scorecard_report_snapshots
 WHERE ingested_at > now() - interval '2 hours'
 ORDER BY report_type;
-- expect: source_format 'csv'; has_content_sha TRUE on every row.
-- report_generated_at must carry a TIME, not 00:00:00 — that was the bug.
-- is_partial_month TRUE for the in-flight month; period_closed_at NULL.
```

**3. A re-send is a benign no-op, not a page.** Post the same file twice.

```
HTTP 200
{ "success": true, "duplicate": true, "snapshot_id": "…", "matched_on": "content_sha256" }
```

`success` must be `true` and the status code must not be 5xx. One extra
`duplicate` log row; no new snapshot; the existing snapshot's `is_current`,
`finalized_at` and `period_closed_at` unchanged; no other snapshot demoted.

**4. Re-send January, February and March as CSV** for reports 134, 136 and 137.
Because the bytes and `content_sha256` differ from the stored PDF-sourced
snapshots, each lands as a new snapshot and demotes the old one.

This is what repairs March's 137 without a parser fix: its `hold_cents`
currently holds $8,357,993 of net sales with `nsa_cents` NULL, because the PDF
printed a 13-band Total row (no Hold-HOA activity that month) and the parser
assumed the missing pair was Net. The CSV has named columns and cannot make
that mistake. The same send fills January's 137, which is absent entirely.

```sql
-- March 137 BEFORE: nsa_cents NULL, hold_cents holding the net total.
SELECT h.branch_code_raw, h.gsa_cents, h.num_net, h.nsa_cents, h.hold_cents
  FROM scorecard_report_snapshots s
  JOIN lp_sales_efficiency_history h ON h.snapshot_id = s.id
 WHERE s.report_type = 'sales_efficiency' AND s.period_start = '2026-03-01'
   AND s.is_current
 ORDER BY h.row_num;
-- AFTER: nsa_cents populated, hold_cents back to a plausible Hold-HOA figure
-- (it was ~70% of gross, which no Hold-HOA balance ever is).
```

**5. Closed months are now closed.**

```sql
SELECT report_type, period_start, period_end, is_partial_month,
       finalized_at IS NOT NULL AS load_committed,
       period_closed_at IS NOT NULL AS period_closed
  FROM scorecard_report_snapshots
 WHERE report_type = 'jobs_by_milestone' AND is_current
 ORDER BY period_start;
-- expect: period_closed TRUE for Jan/Feb/Mar (after the closing pull),
-- FALSE for the in-flight month.
```

`jobs_by_milestone` had never set `finalized_at` on any of its snapshots.
Note the two columns mean different things: `finalized_at` means the chunked
load committed, `period_closed_at` means this is the accepted final reading of
a closed period. Read the second one.

**6. Exactly one current snapshot per period.** Two known-bad sets:

```sql
SELECT report_type, scope, period_start,
       count(*) AS snapshots,
       count(*) FILTER (WHERE is_current) AS current
  FROM scorecard_report_snapshots
 GROUP BY 1,2,3 HAVING count(*) FILTER (WHERE is_current) <> 1
 ORDER BY 1,3;
-- expect: EMPTY.
```

As of 2026-08-06 this returns two rows, and one is worse than previously
recorded: **January's 136 pair has ZERO current snapshots**, not one — both are
`is_current = false`, so the dashboard reads nothing for that month. March's 137
has **six** snapshots. Re-sending each period as CSV promotes exactly one.

**7. Only then continue the remaining monthly backfill pulls** — April onward,
all as CSV.

## Watch for

- **`unresolved_branch` on 137.** An unknown `Grouper` lands in an explicit
  `UNRESOLVED` bucket and alerts; it is never dropped. Fix by adding the code to
  `lp_branch_market_map` and re-sending — the revenue is preserved either way.
  `RFED` is already mapped (→ `FTLAU_MKT`); it is a real tenth market code and
  a nine-market assumption would bucket it as UNRESOLVED on every file.
- **`unmapped_columns` on 134.** The CSV column mapping for 134 was written
  without a sample file in hand. The parser reports every column it did not
  read rather than guessing; check this on the first real 134 CSV and widen the
  mapping if something meaningful is listed.
- **`sub_cent_precision_loss`.** LP prints some money at four decimals. Cents
  are computed half-even and the remainder is reported, never silently absorbed.
- **`unexpected_band_count_13` from a PDF replay.** Expected and correct — a
  closed-month PDF with a 13-band Total row is exactly the March defect. Send
  that period as CSV instead. The PDF parser is frozen.

## Out of scope / still Mark's

- Scheduling the `[BOPM]`/`[EOPM]` closing pull inside LeadPerfection.
- Pushing I.LPRA to the live n8n instance (the deploy action is still broken).
- Replacing the four synthetic CSV fixtures with redacted real exports — see
  `scripts/fixtures/lp-reports/README.md`.
