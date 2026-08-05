# Reece Scorecard — CSV Backfill & Accuracy Report (2026-08-05)

Deliverable for the 2026-08-05 handoff (CSV backfill, accuracy repair, automation
cadence). Every figure below was verified against the live LP Supabase after the
import, or against the source CSVs directly. Money is cents in storage; dollars
here for readability.

Source files (uploaded manually, ground truth): `Job_Status_Report_YTD` (940
rows), `Lead_Disposition_Detail_YTD` (78,557 rows),
`Marketing_Sub_Source_Cost_Anlysis_2_YTD` (127 rows); all 1/1/2026–8/5/2026.

---

## 1. Is the dashboard accurate? — verdict per section

| Section | Verdict before | Root cause / delta | Status after |
|---|---|---|---|
| **Sold This Period** | **WRONG** — cancellation value rendered $575,084 = gross sold to the dollar; surviving $0 | `viewModel.ts` computed cancellation value as the residual `max(0, gross − net)`; with `net_sales = 0` the residual equals gross and surviving collapses to $0. The count (`ko_count`) came from a different column, so the count looked plausible while the dollars were wrong. | **FIXED** — five-line structure sourced from `lp_report_facts` (source_cost): count = NumSold, gross = GSA, cancel count = NumSold − NumNetSold, cancel value = GSA − NSA, net after cancels = NSA. Regression tests assert cancel value ≠ gross. |
| **Net (Good Business) Breakdown** | **WRONG** — all zeros | Same zero `net_sales` + missing `raw_inputs.bucket_tally`; every value was coerced to `number`, so the `usd()` "—" convention was unreachable and missing data rendered as confident $0s. | **FIXED** — Gross → −Cancels → =Net (NSA) → −HOA −Permit −Other pending (count·$ each, from `job_status_ytd` facts) → =Released remaining. Missing source renders **"not yet sourced"**, never $0. |
| **Company YTD totals** | Not previously sourced to the cent (PDFs round) | — | `lp_report_facts` now carries the exact control totals (see §7 matrix). |
| **By-Market table** | UNASSIGNED could vanish | Suppression rule counted only leads/issued/demos/sales/gross — a utility row holding only net dollars was silently dropped. | **FIXED** — `rowHasActivity()` includes `net_sales`; UNASSIGNED renders whenever it carries anything. |
| **Date filters** | OK | MTD / 3M / YTD resolve correctly (existing `resolvePeriod` suite). New facts are period-gated: the YTD backfill answers YTD views; MTD views show "not yet sourced" until daily MTD pulls exist — by design, a YTD snapshot must not impersonate an MTD figure. | OK |

## 2. Every mismatch found (dashboard/report vs CSV ground truth)

1. Cancellation value = gross sold (the §1 defect) — $575,084 shown vs true YTD
   cancellation value **$23,010,879.77** (955 cancels).
2. Surviving good business $0 vs true **$56,893,787.43** (NSA).
3. Net Breakdown zeros vs true pending stock: HOA **93 / $2,008,759.00**, Permit
   **18 / $343,564.00**, Other pending **131 / $3,794,614.00** (943 open-jobs
   released-track excluded bucket: 698 / $18,707,849.28).
4. Lead file vs Marketing report basis gap (NOT a defect — two bases, now
   labeled): lead-file ΣGSA $80,127,468.28 (+$222,801.08 vs GSA), ΣNetAmount
   $53,497,849.16 (**−$3,395,938.27** vs NSA), ApptDate-set 25,290 (Δ138 vs
   NumSet), GSA>0 rows 3,345 (Δ1 vs NumSold), NetAmount>0 rows 2,223 (Δ166 vs
   NumNetSold). Company Sold figures therefore come ONLY from the Marketing
   report; per-market splits are labeled "lead-attributed".
5. Leads YTD 78,557 file rows vs Marketing NumRaw 78,561 — see §5a.
6. `lp_branch_market_map` was missing **RFED** (286 lead rows) — would have
   quarantined + rejected any RFED revenue file. Seeded RFED → FTLAU_MKT.

## 3. Import mechanism and schema as built

- **Tables** (all money cents bigint, superseded imports never deleted):
  `lp_job_status_history` (940 rows/import, bucket CHECK hoa|permit|other_pending|excluded),
  `lp_lead_disposition_history` (grain = (snapshot, row_num) — lead id is NOT
  unique: 71,040 distinct over 78,557 rows, 6,182 repeats),
  `lp_source_cost_history` (grain = (snapshot, row_num) — duplicate descr rows
  exist and are kept).
- **Provenance**: reuses `scorecard_report_snapshots` (+ new `source_format`,
  `control_totals`, `finalized_at` columns) — snapshot id serves as the
  handoff's `import_id`. Deliberate deviation from the proposed `lp_csv_imports`
  table: sha256 idempotency, the `is_current` pointer, the partial unique index,
  ingest log and quarantine already live there.
- **Fail-closed chunked ingest**: `lp_csv_ingest_begin` → `_rows`×N →
  `_finalize`. Finalize is one transaction: row-count assertion, control-total
  assertions **to the cent**, demote-then-promote `is_current` with facts in
  lockstep, facts projection. A failed finalize leaves an inert non-current
  snapshot. source_cost REQUIRES all ten §0 control totals or refuses to promote.
- **Rollup**: `scorecard_rebuild_facts` extended — one projection path over five
  sources into `lp_report_facts` (report_type += `job_status_ytd`,
  `lead_disposition`, `source_cost`; metric += leads/sets/confirmed/issued/sat/
  sold/net_sold/marketing_cost/working_amount; bucket += `permit`).
- **Market resolution** reuses `market-resolver.js` (`lp_branch_market_map` +
  `service_area_zips`) — not reimplemented.
- **Routes**: `POST /n8n/admin/lp-csv-ingest/{job-status|lead-disposition|source-cost}`
  (CSV text, 60 MB) + fail-closed PDF stubs
  `POST /n8n/admin/lp-report-ingest/{lead-disposition|source-cost}` (`parser_pending`).
- **Backfill vehicle**: `scripts/backfill-reece-csv.js` (dry-run default,
  `--execute` gate), order lead_disposition → job_status_ytd → source_cost.

## 4. Query patterns supported

- **By day**: `lp_lead_disposition_history.entry_date` (indexed per snapshot),
  `lp_job_status_history.contract_date / net_date / status_date`.
- **By office / market**: `market` on both history tables (indexed) plus
  `branch_code_raw`/`brn_id_raw` so BOCA/MIAMI/RFED/LAKE reconcile without
  reopening files; dashboard folds LAKE→Orlando at display.
- **By source**: `src_id`, `sub_source`, `promoter` on lead history (sub_source
  indexed); `lp_source_cost_history.sub_source` for the company rollup.
- **Custom ranges**: plain date-range predicates over the indexed columns;
  `lp_report_facts` carries `(market, period_start, metric)` and
  `(as_of_date, metric)` indexes for the dashboard read path, and every
  superseded snapshot is retained, so point-in-time questions are `as_of_date`
  queries, not archaeology.

## 5. Unassigned / Out-of-Area

- 4,041 leads have blank `brn_id` + 2 carry literal `'0'` → 4,043 unattributed.
- `Category = 'Out-of-Area'` covers 3,855 rows — a **strict subset** of the
  blank-brn rows (overlap exactly 3,855).
- Zip resolution through `service_area_zips` (deterministic, method recorded):
  **266 recovered** to a real market (`zip_lookup`, 6.6%), **1,084** carry an
  in-file zip outside the service territory (`OUT_OF_AREA`), **2,693** have no
  usable zip (`UNASSIGNED`, `no_address`). Note: a CSV-internal zip-vote
  estimate suggested ~603 recoverable (14.9%) — the delta is zips that appear on
  branch-assigned leads but are not in `service_area_zips`; if recovery matters,
  extending `service_area_zips` is the lever.
- Final lead-market distribution (Σ = 78,557): STPET 17,494 · ORL 16,555 ·
  FTMYR 11,666 · FTLAU 10,531 (incl. BOCA/MIAMI/RFED) · JAX 9,159 · SAR 6,448 ·
  LAKE 2,927 · OUT_OF_AREA 1,084 · UNASSIGNED 2,693. UNASSIGNED and OUT_OF_AREA
  render visibly (dashboard suppression fixed) and company = Σ markets +
  UNASSIGNED + OUT_OF_AREA exactly.

### 5a. The 4-row NumRaw variance (78,561 vs 78,557) — explained, not papered over

Per-sub-source comparison pins the entire variance to three third-party
aggregator sources: **HomeBuddy +2, Porch101 +1, Modernize +1** (marketing
NumRaw counts 4 leads the detail export does not contain; every other
sub-source ties exactly). Consistent with lead records counted into the
marketing rollup but later deleted/merged out of the detail universe. Impact is
4 of 78,561 (0.005%); both figures are stored (facts `leads` = 78,561 from
source_cost, history rows = 78,557) so the variance stays visible.

## 6. Automation cadence

See `docs/lp-report-cadence.md`. Summary: **daily month-to-date + weekly/month-end
full-YTD validation; Job Status always full-YTD (stock, not flow); 6:00–6:45 ET
staggered.** LP's scheduler is PDF-only (confirmed 2026-08-05) — the CSVs were a
one-time manual backfill, the new PDF endpoints fail closed (`parser_pending`)
until first samples arrive, and the direct-URL fetch path is now the only route
to automated penny-accurate data. n8n transports I.LPRC / I.LPRD are built and
deploy inactive.

## 7. Verification matrix (live, post-import)

| # | Assertion | Result |
|---|---|---|
| 1 | YTD company Gross $79,904,667.20 / Net $56,893,787.43 / Sold 3,344 / Net Sold 2,389 in facts | **PASS** — exact, to the cent |
| 2 | Company totals = Σ markets + UNASSIGNED (+ OUT_OF_AREA) | **PASS** — leads Σ = 78,557; job gross Σ = $24,854,786.28 incl. UNASSIGNED $34,400 |
| 3 | Per-market figures match CSV rollups within $0.01 | **PASS** — history tables mirror source rows verbatim; facts are a projection asserted by finalize |
| 4 | Leads YTD 78,557 vs NumRaw 78,561 explained | **PASS** — §5a (HomeBuddy +2, Porch101 +1, Modernize +1) |
| 5 | Issue rate 17.99% (14,133 ÷ 78,561), NSLI $4,025.60 (NSA ÷ 14,133) reproduce from stored data | **PASS** |
| 6 | Snapshot-replace: no double counting | **PASS** — re-ingest of byte-modified file: 2 snapshots, exactly 1 current, superseded rows+facts retained demoted; identical bytes → `duplicate` no-op |
| 7 | No job dropped: history count = 940 | **PASS** — and finalize would abort on any other count |
| 8 | Date filters return correct subsets | **PASS** — existing `resolvePeriod` suite + new period-gate tests (YTD facts never leak into MTD views) |
| 9 | Cancellation value ≠ gross sold | **PASS** — regression tests in `viewModel.test.ts` + `reportFacts.core.test.ts`; live value $23,010,879.77 vs gross $79,904,667.20 |
| 10 | Buckets foot exactly | **PASS** — 93 + 18 + 131 + 698 = 940; parser asserts the foot, tests cover a 24th-status reject |
| 11 | Hold-Permit renders as its own bucket (18 / $343,564) | **PASS** — pending Mark's ruling (§9) |
| 12 | UNASSIGNED renders visibly and reconciles | **PASS** — 2 jobs / $34,400; 2,693 leads; suppression fix tested |

Fail-closed proof (bonus): a deliberate 1¢ control-total mismatch aborted
finalize live (`control total gsa_cents mismatch — loaded 100, expected 101`)
and promoted nothing.

## 8. Corrected logic (where it lives)

- **Sold This Period**: `Reece-Dashboard/lib/queries/reportFacts.core.ts`
  (projection) + `lib/scorecard/viewModel.ts` (`revenue.facts`, all
  `number | null`) + `components/scorecard/RevenueCard.tsx`. The
  `impliedCancelled` residual no longer feeds the card.
- **Net Breakdown**: same files; pending buckets are a stock from
  `job_status_ytd` facts with their own as-of; released remaining = NSA −
  pending total; "not yet sourced" renders wherever a source is missing.
- Company figures read the control-totals basis; market-filtered views read the
  lead-attributed basis and say so on the card.
- Stale `CURRENT_MONTH_REPORT_RTP` constant in `lib/scorecard/reportRtp.ts`
  (pinned to 2026-07, self-deactivates with a console.error since 2026-08-01) —
  noted, out of scope here; the hero-net composition is a separate surface.

## 9. Hold-Permit recommendation (for Mark's ruling)

`Hold - Permit` exists in the Job Status export: **18 jobs / $343,564** alongside
`HOLD - HOA` (93 / $2,008,759). The 2026-08-04 "no permit bucket" ruling was made
on a July Report B cohort that happened to contain none — that ruling remains
scoped to Report B. **Built as three buckets (hoa / permit / other_pending):**
collapsing permit → other_pending later is a one-line map change in
`lp-report-parse-job-status.js`; the reverse would be a schema migration.
Recommendation: keep the permit bucket. One observation for the ruling: **18/18
permit-hold jobs carry a NETDATE while 0/93 HOA-hold jobs do** — permit holds sit
post-net, HOA holds pre-net, which argues they are economically distinct and
worth separate lines.

## 10. Test matrix

| Suite | Scope | Result |
|---|---|---|
| LP-MCP `test-lp-report-csv-common.js` | RFC-4180 edges, date/count parsing | PASS |
| LP-MCP `test-lp-report-parse-job-status.js` | 23-status map partition, 24th-status reject, one-decimal FinAmount, $0 valid, foot | PASS |
| LP-MCP `test-lp-report-parse-lead-disposition.js` | dup lead ids kept, RFED, blank/'0' brn → zip, unmapped-branch fail-closed, cents, control totals | PASS |
| LP-MCP `test-lp-report-parse-source-cost.js` | control-total tie, **1¢ mismatch fails**, dup/blank descr kept | PASS |
| LP-MCP `test-lp-report-facts.js` (extended) | three new projection branches, partition invariants, permit bucket, cancel ≠ gross at facts layer | PASS |
| LP-MCP full suite | 1,300 tests | 1,293 pass; **7 pre-existing failures reproduce identically on origin/main** (booking calendar router ×2, GHL appointment dedupe ×4, LP contact backstop ×1) — unrelated |
| Dashboard Vitest (14 files / 132 tests) | incl. `reportFacts.core.test.ts` (12), `viewModel.test.ts` regressions, `byMarket.test.ts` | ALL PASS |
| Dashboard `tsc --noEmit` / lint | — | clean / 0 errors (4 pre-existing warnings) |
| Live DB proofs | control totals, footing, replace, duplicate, 1¢ fail-closed | ALL PASS (§7) |

## 11. Remaining risks

1. **The `cst_id` join is a workaround.** Job Status carries no branch column;
   markets ride the join to the current lead_disposition snapshot (938/940).
   Ask LP for a branch column (recommendation flagged in the cadence doc).
   The 2 unmatched jobs — cst_id 267351 (Jacobson, $12,000, Installed & Unpaid)
   and 388153 (Waage, $22,400, Product Received) — have no phone/name match
   anywhere in the YTD lead file (pre-2026 leads); they import as UNASSIGNED,
   visibly.
2. **6 join ambiguities** (multi-match lead rows disagreeing on branch): 2
   null-vs-branch, 4 FTMYR-vs-SAR (cst_ids 70864, 79867, 326012, 440723).
   Resolution prefers the Sale-Contract-Signed row, then latest entry with a
   real branch; every case is recorded in the ingest log detail
   (`join_ambiguities`), ~$0.1M of gross at stake worst-case.
3. **Two bases for market-level Sold.** The −$3.4M NSA gap between lead-file
   and marketing-report bases is real and labeled on the card — do not "fix" it
   by forcing the bases to agree.
4. **PDF parsers pending.** Ongoing automation is blocked on first sample PDFs
   (endpoints fail closed, archiving the samples). Until then the YTD facts
   serve YTD views; MTD views say "not yet sourced".
5. **Chunked ingest is not one transaction** — mitigated: `is_current` flips
   only inside finalize; failed loads leave inert non-current snapshots, logged.
6. **`lp_report_facts` read policy** added for the dashboard (`authenticated`,
   SELECT only) — mirrors `scorecard_daily_read`; writes stay service-role.
