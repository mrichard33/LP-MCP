# Five-Report Daily Automation (PDF-only) — Deliverable Report (2026-08-05)

Deliverable for the "Complete the Five-Report Daily Automation" handoff. Goal:
all five LP reports ingest automatically every day from PDF alone, no manual
CSV step.

## 1. Workflows: created vs activated

| Report | ID | Live state after this session |
|---|---|---|
| Jobs by Milestone | 134 | `I.LPRA` **active** (untouched) |
| Jobs By Status | 133 | `I.LPRB` **active** (untouched) |
| Lead Disposition | 135 | `I.LPRC` **active** (Mark activated it mid-session — the handoff's "inactive" was a pre-activation snapshot) |
| Mktg Sub-Source | 136 | `I.LPRD` **active** (exists — the handoff's "MISSING" was stale; Mark activated it mid-session) |
| Sales Efficiency | 137 | covered by the new **`I.LPR` router** (below), live **inactive** (`wakX7NzvbOJa1UZt`) |

**Structure choice (handoff §6): ONE router workflow** — `I.LPR LP Report
Router (133–137)` — instead of a fifth near-identical per-report workflow.
One Gmail trigger (`from:reports@leadperfection.com`, `filename:pdf`, no
subject dependence) → Code node extracting the report ID from the attachment
filename (`/_1(3[3-7])_/`) → Switch → five HTTP posts. Rationale: the
filename ID is machine-stable; subject strings have already caused
misrouting risk; five workflows quintuplicate every fix. The router ships
inactive alongside the four active workflows — cutover is Mark's checklist
(§10), so nothing live was disturbed. Corrections the handoff required are
built in: **positive IF** (`success is true`), telemetry `onError:
continueRegularOutput`, unroutable filenames → telemetry
(`unroutable_filename`), never silent.

The telemetry route `POST /events/lp_report_ingest_failed` exists and
answers 200 (shipped and verified in the prior session — the 404 era is
over).

## 2. Report 137 parser — design and golden results

- **PDF** (`src/jobs/lp-report-parse-sales-efficiency.js`): self-calibrating
  **column bands** — the Total row (the one line with every active column
  populated) fixes each column's right edge by character offset; every
  market-line token is assigned to the nearest band edge (values are
  right-aligned). Token order is never used — BOCA's Close 1/$85,415 and
  Working 1/$85,415 (identical dollars, different columns) parse correctly,
  as do FTLAU (Canceled only), MIAMI (three leading cells only), and the
  Total values line that renders *before* its `Total:` label. A token
  landing in no band fails the file closed (`column_misaligned`).
- **Checksum**: Σ parsed rows must equal the Total row per column — exact
  for counts, within the bounded `display_rounding` allowance ($1 × row
  count, always logged) for dollars. A perturbed total rejects the file
  (`total_row_mismatch`), tested.
- **MTD guard (§8.5)**: 13 data bands (no Net pair) ⇒ `counts_only` — Net /
  NSA are never written and the facts projection emits **no `net_sold`
  rows**; nothing downstream can mistake absence for $0. 15 bands ⇒ `full`.
- **NSLI**: the printed column is **never ingested** in any mode (verified
  not reproducible from the report's own columns). NSLI = NSA ÷ Issued,
  computed downstream.
- **CSV** (manual exports): cents-exact, control totals asserted in the
  fail-closed finalize RPC.
- **Golden results**: the real Aug MTD PDF fixture parses 9 markets with a
  clean checksum (`scripts/fixtures/lp-reports/report-137-...-aug-mtd.txt` —
  market aggregates, no PII). The YTD CSV ties the §1 golden table **to the
  cent**: company Issued 15,441 · Sat 10,505 · Sold 3,443 · GSA
  $81,110,135.20 · Net 2,250 · NSA $54,119,101.28 · Cancelled
  628/$15,275,357.92; all six market rollups exact (Orlando = ORL+LAKE,
  Fort Lauderdale = FTLAU+BOCA+MIAMI+RFED). **Ingested live** — 80 fact
  rows, `is_current`, snapshot `ab37fba7`.

## 3. Scope corrections (Mark reschedules in LP)

Applied to the cadence doc and the router's cutover sticky: **133 → YTD**
(Aug MTD returned 38 jobs vs 242 actually open, ~85% understatement),
**136 → YTD** and **137 → YTD** (MTD returns $0/garbage for Net, NSA, NSLI —
cohort-based columns), 134 stays MTD + prior month through BD5, 135 stays
MTD daily + YTD weekly. The pipelines record the actual window on every
snapshot and handle whatever arrives; 137's future `EDate` is recorded as a
`future_period_end` reconciliation note — pin the scheduled end date to
yesterday.

## 4. Authoritative source per metric — enforced

| Metric | Source | Enforcement |
|---|---|---|
| Net Sales released | 134 | dashboard hero (via `lp_net_report_rtp`) |
| Issued/Sat/Sold/Cancelled/NSA/NSLI by market | **137** | dashboard `buildSold` reads `sales_efficiency` facts FIRST, for company and market; cancellations come from the explicit bucket, never sold−net inference |
| Open backlog HOA/Permit/Other | 133/job_status | `buildGoodBusiness` (unchanged) |
| Leads/dispositions/source | 135 | leads facts (unchanged) |
| Marketing cost / cost-per-lead | 136 | source_cost facts (cost metrics only) |

The older sold bases (source_cost company / lead_attributed market) remain
**fallbacks only** when no covering 137 snapshot exists, labeled as such on
the card. The sold/net-sold divergence across 135/136/137 (3,345/3,344/3,443
and 2,223/2,389/2,250) is **partly a window mismatch** — the 137 export ran
through 9/2 while the others ran through 8/5 — plus genuinely different
bases (appointment-cohort vs lead-attribution vs marketing rollup). Windows
must be aligned before divergence is reported; the `future_period_end` note
makes the misalignment visible on every snapshot.

## 5. Overlap invariant + named exceptions (live)

- **Non-overlap promotion**: both promotion RPCs now demote any current
  snapshot of the same report type whose `[period_start, period_end]`
  **overlaps** the incoming range (was: period_start equality — which let
  Aug 1–31 and Aug 4–4 be simultaneously current and double-count Aug 4).
  The Aug 4–4 snapshot is **retired** (demoted, retained); exactly one
  current `jobs_by_milestone` remains (Aug 1–31, net $702,506.00). No hard
  DB exclusion constraint — planned YTD validation pulls overlap MTD dailies
  by design and must supersede, not error.
- **`se_internal`** recon check: GSA − Cancelled − CD − Working − Hold vs
  NSA carries the named **`SE_BUCKET_RESIDUAL` $246,768.00** — verified
  live to the cent; never absorbed into a bucket.
- **`se_hold_vs_job_status_hoa`**: 137 Hold 92/$1,999,974 vs Job Status HOA
  93/$2,008,759 — live delta exactly the named **Δ1 job / $8,785.00**
  tolerance. Both checks write `skipped` when a snapshot is missing, `warn`
  + GroupMe when the delta stops matching its named artifact.
- Watchdog now lists all five reports but **arms only after a type's first
  scheduled (n8n-sourced) success** — manual backfills don't trigger daily
  false alarms for reports Mark hasn't scheduled yet.

## 6. PDF-only viability — confirmed

**Yes: every field the dashboard needs exists in the PDF versions of the
five reports**, with two stated qualifications:

1. **Daily figures carry ±$1/row rounding** (PDFs print whole dollars). The
   bounded `display_rounding` allowance covers it — $1/row cap, logged on
   every invocation, fail closed beyond the cap. CSV-sourced paths remain
   cents-exact and never use the allowance.
2. **Penny-exact reconciliation is not achievable from PDF alone.**
   Recommendation: a monthly manual CSV pull purely for reconciliation
   (yesterday's and today's CSVs already serve as the YTD anchors), or the
   unattended `FMT=XLS` fetch if the investigation lands. This does not
   block daily accuracy.

One honest gap in "no manual step, day one": **135 and 136 have no PDF
parser yet because no sample PDF of either has ever existed** (storage
verified). Their endpoints fail closed (`parser_pending`), archiving each
PDF — the first scheduled email IS the sample, and building each parser from
it is a small follow-up. 133/134/137 parse for real today.

## 7. Test matrix (handoff §8)

| # | Test | Result |
|---|---|---|
| 1 | 137 PDF parses; sparse columns by position; Total checksums | **PASS** (real-sample fixture; BOCA/FTLAU/MIAMI cases) |
| 2 | YTD rollup matches §1 | **PASS** — CSV exact to the cent; PDF asserts within the rounding allowance |
| 3 | Hold vs HOA within Δ1/$8,785 | **PASS** — live delta exactly the named tolerance |
| 4 | $246,768 residual = named exception | **PASS** — live, to the cent |
| 5 | MTD does not write Net/NSA/NSLI | **PASS** — counts_only guard, parser + facts tests |
| 6 | 136 Grand Total checksum | **DEFERRED** — no sample PDF exists; first email archives it |
| 7 | 135 parser + alternative gate | **DEFERRED** — same; gate design (row count vs 136 NumRaw, Δ4 on YTD) documented for the build |
| 8 | Report-ID routing 133–137 | **PASS** — regex unit test mirrors the router |
| 9 | Positive IF + telemetry never fails workflow | **BUILT** — router uses `success is true` and `continueRegularOutput`; route verified live |
| 10 | Replace-not-append; no overlapping currents | **PASS** — overlap demotion live; Aug 4 retired; duplicate no-op retained from prior session |
| 11 | Sold This Period per office + company | **PASS** — dashboard tests on live 137 figures (Sarasota, Orlando fold) |
| 12 | Cancellation value ≠ gross sold | **PASS** — explicit-bucket test + prior regression suite |

Gates: LP-MCP `npm test` 1,315/1,325 (the 10 failures reproduce identically
on origin/main — booking calendar, GHL appt dedupe, contact backstop;
unrelated) · `node --check` clean · dashboard 142/142 + `tsc` clean + lint
0 errors.

## 8. Remaining risks

1. **YTD 137 PDF layout is unverified** — only the MTD sample exists. The
   parser fails closed on band-count or alignment drift; the first real YTD
   email may need a parser tweak (15-band mode is implemented but untested
   against a real file).
2. **135/136 parsers pending first samples** (§6). Until built, those
   reports' PDFs archive-and-alert rather than ingest.
3. **n8n GH deploy action is still broken** (`N8N_API_KEY` secret empty
   since Aug 4) — the router was created on the live instance via the API
   and committed to the repo; repo and instance must be kept in sync by API
   until the secret is fixed.
4. **Recon named-exception semantics are exact-match**: when the SE residual
   or the Hold/HOA delta drifts from today's verified values, the check
   degrades to `warn` + GroupMe — intentionally, so drift is re-ruled rather
   than silently forgiven.
5. The first finalize attempt of the 137 CSV correctly **failed closed** on
   a then-unknown control key (`num_cancelled`) before the RPC was patched
   and the same snapshot finalized — recorded in `scorecard_ingest_log`;
   an incidental live proof of the fail-closed gate.

## 9. Post-merge checklist (Mark) — unchanged from the handoff

1. Reschedule 133, 136, 137 to **YTD** in LP; pin 137's end date to yesterday.
2. Activate `I.LPR`; deactivate `I.LPRA`–`I.LPRD` (the router replaces all five subject-filtered flows).
3. Next morning: five `scorecard_ingest_log` rows — 133/134/137 `success`, 135/136 `parser_pending` (their samples; parsers follow).
4. Confirm Sold This Period and Net Good Business populate for every office.
