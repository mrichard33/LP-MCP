# I.LPRA — LP Report CSV Cutover & History Remediation — Runbook

**Status:** built / migration applied → verify + remediate · **Owner:** Mark · **Updated:** 2026-08-06

LP can now schedule CSV exports as email attachments, so CSV becomes the ingest
format for all six reports and the PDF parsers become legacy. This runbook is
the operator half: verify the CSV path end to end, then repair the history that
the PDF parsers got wrong — by re-sending periods as CSV, not by editing or
deleting anything.

**Six, not five, as of 2026-08-07:** report **138 Appointment Stats by Sales Rep
with Source** now ingests. It is the only export carrying both gross and net
issued at source grain, which is what makes a gross-basis sit rate by source —
and the only sit rate by REP we have — computable at all. It needs no n8n
change: `I.LPRA`'s CSV branch already posts every CSV, and LP-MCP resolves 138
from its header. It has **no market column**, so it produces no
`lp_report_facts` and must never be used for market attribution.

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

## Schedule change — the cohort re-observation exports (§8, 2026-08-12)

The `[BOPM]`/`[EOPM]` closing pull above re-observes the **most recent closed
month, once**. Cohort maturation needs more than that.

Net Sales — Gross Written − Cancellations − Financing Denied — matures DOWNWARD
as losses land. Measured 2026-08-12 as a share of gross written:

| cohort age | <1mo | 1mo | 2mo | 3mo | 4–7mo |
|---|---|---|---|---|---|
| Net Sales ÷ Gross | 84.8% | 76.3% | 70.4% | 69.1% | 69–73% |

A cohort observed once freezes at its FIRST, HIGHEST reading. July would hold
76.3% forever instead of settling toward ~70%, and the retention history would
be wrong in the flattering direction — the dangerous one, because nothing about
the number looks broken.

**Add a recurring monthly report-137 export for every still-open cohort month**,
using explicit `t1`/`t2` date ranges (a full calendar month: first day → last
day). As of 2026-08-12 that is Feb–Jul; each still holds working or hold dollars,
so each is still moving. `lp_cohort_reobservation` lists exactly which months
qualify at any moment.

Nothing on our side needs to change when these start arriving, verified
2026-08-12:

- **I.LPRE is scope-agnostic.** Its Gmail query matches the subject and any
  `.csv`, with no `newer_than` or read-status filter, so a monthly export is
  picked up like any other.
- **Scope comes from the FILE, not the email.** `lp_derive_scope()` returns
  `'month'` when `period_start` is the first of a month and `period_end` its
  last day, so a monthly export self-classifies into `lp_cohort_maturation`
  (which filters `scope IN ('month','mtd')`).
- **Supersession is already the retention model.** The unique index
  `(report_type, scope, period_start)` on current snapshots demotes the prior
  snapshot for that month to history — and that demoted history IS the
  maturation series.

⚠️ Use explicit month ranges, not `[BOCM]`/`[DAYOFFSET(-1)]`. Run on the 1st,
that pair yields `2026-09-01..2026-08-31` — an end before its start, which the
ingest rejects as `inverted_period`.

⚠️⚠️ **CLOSED MONTHS ONLY. Never schedule a month-scoped export for the CURRENT
month.** This is the one well-intentioned schedule that breaks the daily ingest,
and the symptom looks nothing like the cause.

`lp_csv_ingest_finalize` demotes on daterange OVERLAP within the `{mtd, month}`
scope family, and since 2026-08-11 it also refuses to promote a snapshot
covering strictly LESS of the period than the current one. Both rules are
correct. Together:

1. An `Aug 1–31` export lands mid-month. It overlaps the daily rolling window
   (`Aug 1–12`) and its `period_end` is later, so it wins and demotes it.
2. Every subsequent daily file — `Aug 1–13`, `Aug 1–14`, … — now covers strictly
   less than `Aug 31`, so coverage-recency **refuses to promote it**.
3. The current month freezes for the rest of the month, on a file generated
   mid-month that claims to cover all of it. The dashboard quietly stops
   advancing; nothing errors.

Verified against the live function 2026-08-12. Closed months are unaffected —
`Jul 1–31` does not overlap `Aug 1–12` — and a re-pull of the SAME closed month
is *equal* coverage, which still wins, so maturation works exactly as intended.

`I.LPRG` detects this condition and alerts separately from staleness, because
the remedy is the opposite: **remove** an export rather than add one.

**The monitor.** `I.LPRG Cohort Re-observation Monitor` (n8n
`NjIimzOjiuuddigd`) checks daily and alerts GroupMe when a cohort goes
unobserved — >2 days for the current month (the daily 137 email has stopped),
>35 days for a prior cohort (the monthly export is missing). It cannot re-pull;
LP has no report API, so its only job is to make the gap loud. Until these
exports are scheduled it is the one thing standing between a frozen cohort and
a silently wrong retention curve.

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
- **`orphaned_snapshot` — READ THIS ONE BEFORE RE-SENDING ANYTHING.** It means a
  previous ingest of the same bytes called `lp_csv_ingest_begin` successfully and
  then failed at finalize. That dead row still holds
  `(report_type, file_sha256)`, so the re-send cannot land until someone clears
  it. Nothing is deleted automatically; the snapshot is inert and non-current, so
  no reader sees it, but it does block its own replacement.

  This used to be reported as `success: true, duplicate: true`, which is the
  dangerous part — a remediation re-send of a bad month came back looking like it
  had landed while the bad snapshot stayed live. If you are re-sending a month to
  repair it, a `duplicate: true` response means the content was **already
  identical** and there was nothing to repair; an `orphaned_snapshot` response
  means the repair did **not** happen.
- **`disposition_alias_disagreement` on 138.** A warning, never a rejection. LP
  prints each disposition twice — once positionally (`NumDsp1..10`, labelled by
  `Dsp1..10`) and once under a fixed name (`Num1Leg`, `NumNoHome`, …). The parser
  decodes by label, because a label travels with its count; the fixed names are
  the cross-check. A disagreement means LP reordered the `Dsp` slots, which is
  worth knowing but does not make the file unreadable.

## Cross-report reconciliations — read them, do not act on them

Two checks in the daily 08:00 ET recon (`src/jobs/lp-report-recon.js`) compare
one report against another. Both are **observability only**: neither can return
`fail`, neither alerts, and neither can block a send.

```sql
SELECT recon_date, recon_type, status, comparison
  FROM scorecard_recon_results
 WHERE recon_type IN ('lead_count_vs_source_raw', 'se_gsa_vs_milestone_gross')
 ORDER BY recon_date DESC, recon_type;
```

**`lead_count_vs_source_raw`** — 135 record count vs summed 136 `NumRaw` over
the same window. Two independent views of one lead population, so a tie is the
happy case and drift is worth a look. They tied at 1,194 on the 2026-08-06 MTD
pull; at YTD on 2026-08-07 they sat 4 apart (78,557 vs 78,561). A handful of
records is LP-side timing. A jump into the hundreds means one of the two feeds
is missing a chunk of days — that is worth chasing, by hand, not by alarm.

**`se_gsa_vs_milestone_gross`** — 137 per-market `GSA` vs 134 summed
`GrossAmount`. **A large delta here is NOT a defect.** The two reports count
different milestone bases; measured 2026-08-07 the ratio ran 1.1×–3× across
every market and went *negative* for ORL and STPET in August. There is no
threshold that would not fire on everything forever, which is why there isn't
one. Read `per_market` when someone asks why two dashboards disagree; ignore it
otherwise.

Both pair on the **window**, not the scope label. When no shared window exists —
common, since 135 is pulled MTD daily and 136 YTD — the row is written as
`skipped` listing the windows each side actually had, so "no result" never looks
like "never ran".

## Out of scope / still Mark's

- Scheduling the `[BOPM]`/`[EOPM]` closing pull inside LeadPerfection.
- Pushing I.LPRA to the live n8n instance (the deploy action is still broken).
- Replacing the four synthetic CSV fixtures with redacted real exports — see
  `scripts/fixtures/lp-reports/README.md`.
