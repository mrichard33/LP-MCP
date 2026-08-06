# Scope Regression, Router Rollback, Goal Editor, Formatting — Deliverable (2026-08-05)

Deliverable for the "Snapshot Scope Regression, Router Rollback, Goal Editor,
Formatting" handoff. Every section states what was actually found, not what was
expected to be found.

## 1. The regression: an MTD pull retired the YTD snapshot

**What happened.** The overlap-demotion rule shipped earlier that day was
unscoped: any current snapshot of the same report type whose window overlapped
an incoming one was demoted. At 21:56 UTC the first real *month-to-date* Sales
Efficiency PDF arrived (Aug 1–31, Net column entirely blank — a cohort
artifact). Its window overlaps the year-to-date snapshot (Jan 1 → Sep 2), so
the YTD snapshot was retired. The MTD snapshot that replaced it carries no
`net_sold` facts at all, so Gross / Net / Cancellations went blank on the
dashboard.

**Immediate remediation (done first).** The YTD snapshot
`ab37fba7-ef62-42de-bd3c-8d81dd2a4515` (CSV, sha `3741bcfd…`, Jan 1 → Sep 2,
10 rows, 80 facts) was re-promoted with its facts in lockstep. Both snapshots
are now current — which is the point of the fix below.

**The fix: scope is part of snapshot identity.** Every snapshot carries a
`scope`:

| scope | meaning | derivation |
|---|---|---|
| `mtd` | the month containing the generation date | `period_start` = first of the generation month, `period_end` inside it |
| `ytd` | year to date | `period_start` = Jan 1 of the generation year, `period_end` ≥ generation date − 7 |
| `month` | a full historical calendar month | `period_start`/`period_end` are exactly one calendar month |
| `custom` | anything else (single-day pulls, truncated ranges) | fallthrough |

Derived in ONE place — `lp_derive_scope(period_start, period_end, as_of)` —
used by both promotion RPCs, so no JS ingest path can drift from the
definition. The seven-day slack on the YTD end date tolerates a schedule pinned
to "yesterday" plus weekend gaps, and also absorbs LP's future `EDate`.

Replace-on-overlap now applies only within a scope **family**:

- `ytd` demotes only `ytd`
- `custom` demotes only `custom`
- `mtd` and `month` are ONE family — a finalized calendar month still
  supersedes the stale in-month snapshot for the same window (otherwise July
  would double-count), but neither can ever touch a `ytd` snapshot

The partial unique index becomes `(report_type, scope, period_start) WHERE
is_current`, so a January YTD pull and a January monthly backfill can both be
current.

Scope is mirrored onto `lp_report_facts` by trigger rather than inside
`scorecard_rebuild_facts`. The projection stays the one place metrics are
computed, and every present and future branch of it inherits a correct scope
without a 200-line restatement that could drift.

**Live proof** (`sql/verify/2026-08-05_snapshot_scope_smoke.sql`, run in a
rolled-back transaction):

| case | result |
|---|---|
| MTD arrives while a YTD snapshot is current | both current — the regression cannot recur |
| a second MTD arrives | supersedes the first MTD; YTD untouched |
| a full-July pull arrives over a stale July MTD | month supersedes mtd (one family) |
| facts | `is_current` and `scope` follow their snapshot in lockstep |

**Metric → scope mapping on the read side** (`reportFacts.core.ts`):

| metric | source |
|---|---|
| Issued · Sat · Sold count · Gross sold · Cancellations (flow) | the snapshot whose scope matches the view — `mtd` for a month view, `ytd` for a year view |
| Net sold · NSA · NSLI (cohort-mature) | only a snapshot that actually carries them; an MTD pull's blank Net renders **"still maturing"** with the reason on the card |

Reads pick exactly ONE snapshot per report type per view (preferring the
matching scope, then the freshest as-of) rather than summing every covering
row. That matters now that multiple currents are normal: a `custom` Jan 1 →
Aug 5 pull alongside the Jan 1 → Sep 2 YTD share a `period_start`, and summing
them would double every figure. Regression-tested.

Cohort-mature figures are never borrowed across scopes. The YTD snapshot's
$9.3M net answers a different window; showing it on an August view would
silently overstate the month, and $0 would read as "everything cancelled".

## 2. Net — Released MTD read "report pending" — the actual predicate

**Not** the guessed future-`period_end` coverage guard. The coverage predicate
is fine and was never reached.

The real chain: `lp_market_scorecard_daily.released_dollars` is sourced ONLY
from `lp_net_report_rtp`, and the ONLY writer of that table was the historical
backfill route (`projectSnapshotToNetReport` was module-private to
`lp-report-backfill.js`). The daily ingest never called it. So the Aug 1–31
`jobs_by_milestone` snapshot sat current with net **$702,506.00** / gross
$702,916.00 while `lp_net_report_rtp`'s newest row was **July**, `hasReport`
was false, `released_dollars` was NULL, and the hero correctly rendered
"report pending" for a figure that had in fact arrived.

(The handoff quotes $702,507 — the exact snapshot figure is $702,506.00; the
$1 is the PDF's whole-dollar rounding.)

**Fix.** `ingestReportPdf` now projects every `jobs_by_milestone` snapshot
itself; the backfill reuses that result instead of repeating the upsert. A
failing projection is reported in the ingest log and alerted to GroupMe, never
silently swallowed, and never retracts an already-durable snapshot.

**`report_as_of` is capped at the generation date.** LP prints the *scheduled*
window, so a pull run Aug 5 declares `period_end = 2026-08-31` — a date that
has not happened. Everything downstream reads `report_as_of` as "the report
covers through here": `computeAuthoritativeRtpNet` takes `max(report_as_of)` as
the winning snapshot, and the provisional tail is the days *after* it. An
uncapped future end would swallow the rest of August as already-reported and
freeze the figure until Sep 1.

**Live now.** `lp_net_report_rtp` carries the Aug 1–31 projection (`report_as_of
2026-08-05`, REECE $702,506.00 over 30 rows, six markets) and the August
scorecard rows carry `released_dollars` with `revenue_basis
rtp_net_by_milestone_date`, `reconciled = true`. Applied directly because the
daily job cannot currently run: LP's API is returning
`500 Execution Timeout Expired` on the scorecard fetch (10:04 and 22:22 UTC
runs both failed that way) — an LP-side outage, unrelated to this work, and
worth watching.

## 3. The five duplicate jobs_by_milestone snapshots

**Byte-level idempotency was working as designed.** All five Aug 1–31 rows
carry *different* SHA-256s:

| sha (12) | ingested |
|---|---|
| `656e15f6…` `3944e6d1…` `82f5cdd4…` | 17:00:53–59 |
| `37ff8441…` `591f5cf2…` | 21:52:36 |
| `a9842b0e…` | 22:05:54 (current) |

LP re-sent regenerated PDFs whose bytes differ (embedded generation
timestamps), so dedup could not and should not have collapsed them. They are
retained history; overlap-demotion kept exactly one current, which is the
invariant that matters. The router was inactive throughout and is not the
source. Two of them (21:52:36) landed in the same second from one poll — so the
Gmail trigger demonstrably *does* process multiple messages per poll.

`scripts/test-lp-report-idempotency.js` pins the mechanisms so a refactor can't
quietly drop them: the SHA check runs **before** any insert and returns the
existing snapshot as a success no-op (a 200, so n8n does not retry forever);
unfinalized snapshots are excluded from the duplicate probe so a retry after a
failed fail-closed finalize can complete; the DB backstops with
`UNIQUE (report_type, file_sha256)`; and promotion stays scope-confined.

## 4. Router rolled back — five independent workflows

The combined router is retired. Each report now has its own workflow:

| workflow | report | live id | state |
|---|---|---|---|
| `I.LPRA` | 134 Jobs by Milestone | `mmgiTOWznsTfz8c9` | active (updated in place) |
| `I.LPRB` | 133 Jobs By Status | `fzDXhS0mC5DSbgRj` | active (updated in place) |
| `I.LPRC` | 135 Lead Disposition | `0cEoJ0GI5tBrQFp7` | active (updated in place) |
| `I.LPRD` | 136 Marketing Sub-Source Cost | `7aFZC5BLzvp9QgaK` | active (**recreated** — the prior one had been archived) |
| `I.LPRE` | 137 Sales Efficiency | `OyjpSpcDbSf2hC7G` | active (**new** — 137 had no transport of its own) |

Each polls Gmail every 15 minutes on a deliberately **broad** query
(`from:ReportScheduler@leadperfection.com has:attachment filename:pdf`, no
subject dependence, so no subject-string change can quietly stop a feed), then
routes in a Code node on the LP report ID in the attachment **filename**
(`_133_`…`_137_`). That node examines every message in the poll and every
attachment in each message, so five simultaneous arrivals all flow — each
workflow takes its own and leaves the rest to its siblings. A non-matching
filename is a sibling's item, not a dropped one; a report type that stops
arriving altogether is caught by the LP-MCP watchdog, which arms per report
type after that type's first scheduled success.

**A live defect found while rebuilding.** The IF node's branches were reversed.
The condition read `success is true` (correct) but its **TRUE** output was
wired to the failure telemetry, so every SUCCESSFUL ingest filed a bogus
`transport_error`:

```
22:05:54  jobs_by_milestone  success            source=n8n
22:05:55  jobs_by_milestone  n8n_transport_error  source=n8n_telemetry
```

— and the same pattern after every success that day (21:52:36 ×2, 21:56:19).
One of them reached GroupMe as a false alarm. TRUE now ends the run; only
`success:false` reaches telemetry. The telemetry body also stringifies a
non-string failure reason, which had been producing `n8n_[object Object]`.

The half-built copy workflow was posting the **137** PDF to the **136**
endpoint (22:01:55 and 22:02:45, both sha `6c8a105d…`). The filename-ID guard
makes that misroute impossible.

## 5. The monthly-goal input rejected a real goal

`<input type="number" step="1000">` silently refused **$2,731,306.68** — the
browser enforces step multiples — and a number input cannot display thousands
separators at all. Goal entry is now a text field (`MoneyInput`): any amount to
the cent is accepted, `$` and commas are stripped on the way in, and the value
is re-grouped with commas on blur so what you read back matches how the goal is
written down. `parseMoney` rounds to the cent, so 2,731,306.68 stores as itself
rather than the float artifact 2731306.6800000002 — the DB columns are
unconstrained `numeric`, so cents survive. Same treatment for the distributor's
company-goal field. The zero-goal warning is unchanged; the company total stays
derived on read and is never editable.

## 6. Comma separators, from one formatter

`num` / `usd` / `usdExact` in `lib/utils.ts` are THE display formatters and
every figure goes through them. The remaining raw renders were replaced:
`.toLocaleString()` in the funnel chart and the guide metrics, interpolated
`Math.round(...)` in the by-market table and the pace hero. Percentages keep
their existing one-decimal helper — a percentage never reaches four digits, so
grouping is a no-op there.

## 7. NSLI is rolling-90-day everywhere, and says so

The header showed **$3,599** ("trailing net ÷ leads issued") while the editor
showed **$3,888** ("rolling 90d · n=344"). Cause: the rates used the rolling
window only when the view's anchor happened to be the current month. A YTD view
anchors at January, so its window was the trailing 3 completed months *before
January 2026*; the editor always plans the current month, so it got the rolling
90 days. Two numbers under one label.

Rates are conversion ratios, not period totals — the current 90 days is the
honest basis for turning a dollar goal into funnel targets, whichever period is
being viewed. Both surfaces now compute the rolling-90-day window and name it
identically, with the sample size: `net ÷ leads issued · rolling 90d · n=…`.
Any widening beyond the primary window still renders its visible flag.

The growth-mode baseline stays period-scoped: the baseline resolver ignores
months at or after its own anchor, so widening the rate fetch cannot leak a
period's own performance into its own dollar goal. Orlando remains
(ORL+LAKE net) ÷ (ORL+LAKE issued) — a ratio of sums, never an average of
ratios (tested).

## 8. The Leads goal resolves for every office

`raw_leads_in` is only ever written for the **company** row — every office row
has it NULL — so every office resolved to a null issue rate and the editor said
"no leads history yet — leads goal unavailable" for all seven.

Until per-office lead history accumulates, the rate comes from the
period-scoped totals already sitting in the current YTD snapshots: report 137
`issued` ÷ report 135 `leads`, summed over the market's source codes.
Numerator and denominator are taken from one scope so they describe the same
window. Live values:

| market | issued (137) | leads (135) | issue rate |
|---|---|---|---|
| Orlando (ORL+LAKE) | 3,387 | 19,482 | 17.4% |
| Sarasota | 1,783 | 6,448 | 27.7% |
| St. Pete | 3,747 | 17,494 | 21.4% |
| Fort Myers | 3,940 | 11,666 | 33.8% |
| Fort Lauderdale (FTLAU+BOCA+MIAMI+RFED) | 1,449 | 10,531 | 13.8% |
| Jacksonville | 1,135 | 9,159 | 12.4% |

The rolling window still wins whenever it has real history; the basis is
labeled on the editor either way ("YTD reports · issued ÷ leads" vs the window
name), so nobody has to guess which number they are looking at.

## 9. Tests

| # | Test | Result |
|---|---|---|
| 1 | MTD arrival does not demote a YTD snapshot | **PASS** — live smoke, both scopes current |
| 2 | Same-scope overlap still supersedes | **PASS** — live smoke |
| 3 | `month` supersedes a stale `mtd` for the same window | **PASS** — live smoke |
| 4 | Scope derivation table (mtd / ytd-with-future-end / ytd-pinned / month / single-day / stale) | **PASS** — live |
| 5 | YTD view reads the YTD snapshot; month view reads the MTD one | **PASS** — vitest |
| 6 | Month view never borrows the YTD net | **PASS** — vitest |
| 7 | Two snapshots sharing a `period_start` are never summed | **PASS** — vitest |
| 8 | Counts-only snapshot sources counts + cancellations, net "still maturing" | **PASS** — vitest |
| 9 | Same file twice ⇒ one snapshot (SHA check before insert, DB unique, unfinalized excluded) | **PASS** — node:test |
| 10 | Daily ingest projects into `lp_net_report_rtp`; `report_as_of` capped | **PASS** — node:test |
| 11 | `$2,731,306.68` parses, round-trips, and displays with commas | **PASS** — vitest |
| 12 | Issue-rate fallback resolves per office; Orlando is a ratio of sums; one scope only | **PASS** — vitest |

Gates: LP-MCP `npm test` 1,310/1,322 (the 10 failures reproduce identically on
`origin/main` — booking calendar, GHL appointment dedupe, contact backstop;
unrelated) · `node --check` clean · dashboard 158/158, `tsc` clean, lint 0
errors, `next build` green.

## 10. Open items

1. **LP's API is timing out** on the scorecard fetch
   (`500 Execution Timeout Expired`, both runs on 2026-08-05). The daily
   scorecard job cannot complete until it recovers; August revenue was applied
   directly this session. Not caused by anything here.
2. **Reschedule 133, 136, 137 to YTD in LP** and pin 137's end date to
   yesterday. Now merely *desirable* rather than urgent — a mis-scoped MTD pull
   can no longer retire the YTD snapshot.
3. **135 and 136 still have no PDF parser** — their endpoints archive the file,
   log `parser_pending` and alert. Both workflows are active precisely so the
   first scheduled emails become the samples.
4. **The n8n GitHub deploy action remains broken** (`N8N_API_KEY` repo secret
   empty since Aug 4). All five workflows were pushed to the live instance via
   the API and committed to the repo; the two must be kept in sync by API until
   the secret is fixed.
5. **The 137 YTD PDF layout is still unverified** — only the MTD sample exists.
   The parser fails closed on band-count or alignment drift, so the first real
   YTD email may need a tweak rather than producing a wrong number.
