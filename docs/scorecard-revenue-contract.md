# Scorecard Revenue Data Contract (`lp_market_scorecard_daily`)

**Owner:** LP-MCP · **Consumer:** Reece-Dashboard · **Status:** live as of this PR

This document is the authoritative contract for how the dashboard must read the scorecard's
**revenue** columns after the RTP-net realignment. It exists to prevent a collision with the
dashboard workstream, which was built against the pre-realignment schema. Read the two
**⚠ BREAKING** items first.

---

## 0. TL;DR — two revenue figures, never blended

The scorecard's headline revenue metric is **Released-to-Production (RTP) net, attributed to the
RTP milestone completion date, for the job's market.** A live-month row now carries **two**
revenue figures in **separate columns**:

| Figure | Column(s) | Basis | Source |
|---|---|---|---|
| **Authoritative** | `released_dollars` = `net_sales` = `good_business` | RTP **net** | Net Report (`lp_net_report_rtp`) |
| **Provisional** | `provisional_gross_dollars` | RTP **gross** | Warehouse (`lp_job_milestones` × `lp_jobs`) |

They are **never summed into one number.** The provisional is a **pace signal, not a preview of
the report** — measured drift vs net ranges **−25% … +30%** depending on period maturity.

---

## 1. ⚠ BREAKING — revenue provenance moved from `computed_from` to `revenue_basis`

Before, `computed_from` distinguished report-sourced (`net_report_rtp`) from live (`lp_api`)
revenue. **That is no longer true.** A live-month row is `computed_from='lp_api'` (that column now
means **funnel** provenance only) **while its revenue is report-sourced.** Revenue provenance
lives in **`revenue_basis`**:

| `revenue_basis` | Meaning |
|---|---|
| `rtp_net_by_milestone_date` | Authoritative report RTP net (closed months AND report-backed live months) |
| `rtp_gross_by_milestone_date_provisional` | Warehouse gross promoted to authoritative (config B only; off by default) |
| `NULL` | **No report for this period yet** — `released_dollars` is also NULL (pending). See §4. |
| `released/working/cancel v1 (retired)` | Legacy pre-realignment rows; retained, never rendered |

**Action for the dashboard:** `lib/queries/scorecardAggregate.core.ts` currently derives its
`computed_from` seam-marker (`'net_report_rtp'` / `'lp_api'` / `'mixed'`) from `computed_from`.
Migrate that to read **`revenue_basis`** instead. Reading `computed_from` for revenue provenance
is now a bug: it will label a report-backed live month as `'lp_api'`.

## 2. ⚠ Invariant — `released_dollars IS NULL ⇔ revenue_basis IS NULL`

Enforced in the writer (aborts on violation) and by a DB check. It guarantees a row can never
look authoritative while being empty. **Never treat `released_dollars IS NULL` as `$0`** — it
means *pending* (no report yet). See §4.

---

## 3. New / changed columns

| Column | Type | Meaning |
|---|---|---|
| `released_dollars` | numeric NULL | **Authoritative RTP net.** NULL when no report (pending) — never 0. |
| `net_sales`, `good_business` | numeric (0-default) | Mirror `released_dollars`; **0** when pending (so YTD sums exclude the live month — §5). |
| `working_dollars`, `pending_total`, `pending_dollars` | numeric | **0** under the RTP-net basis (no working/pending split). |
| `revenue_basis` | text NULL | Revenue provenance — see §1. **Sole revenue-provenance signal.** |
| `revenue_as_of` | date NULL | The report's coverage-end date backing `released_dollars`. NULL when pending. Render as "as of MM/DD". |
| `provisional_gross_dollars` | numeric NULL | Warehouse RTP **gross** for the days **after** `revenue_as_of` (the provisional tail). A pace signal. |
| `provisional_days` | int NULL | # calendar days in the provisional tail (days after `revenue_as_of` through the snapshot). |
| `computed_from` | text | **Funnel** provenance only (`'lp_api'`). Do NOT read for revenue. |
| `gross_sales`, funnel counts, ratios | — | Unchanged — still `lp_api` funnel basis. `nsli`/`avg_sale`/`good_rate_pct` are re-derived from the net. |

`raw_inputs` also carries `provisional_basis`, `revenue_as_of`, `provisional_days`,
`live_month_source` for convenience.

## 4. The three live-month display states (C3) — never a bare $0

Drive display off `revenue_basis` / `revenue_as_of` / `released_dollars`:

1. **Report ingested, current** (`revenue_basis='rtp_net_by_milestone_date'`, `revenue_as_of` = latest):
   show **authoritative net** + "as of MM/DD".
2. **Report ingested, stale** (same, but `revenue_as_of` older than the snapshot, `provisional_days > 0`):
   show authoritative net + "as of MM/DD", **plus** `provisional_gross_dollars` for the N days
   after, **badged** (e.g. "provisional · gross basis · not report-tied").
3. **No report this month** (`revenue_basis IS NULL`, `released_dollars IS NULL`):
   show `provisional_gross_dollars` **only**, badged; render the authoritative figure as
   **pending** — **NOT $0.** Never gap-fill, never blend.

## 5. YTD / multi-month composition (R2)

Aggregate periods take the **latest snapshot per month** and **sum `net_sales`**, re-deriving
ratios (existing behavior). Because a no-report live month has `net_sales = 0`, it **naturally
drops out** of the authoritative YTD hero — which is correct. **Rules:**

- **Never** sum authoritative-closed + provisional-live into one number. The provisional live
  month is shown **separately**, badged.
- A live month joins the hero **only** when it has a report (`revenue_basis='rtp_net_by_milestone_date'`)
  — same basis as closed months, so summing is legitimate.
- Verified composition (July report ingested): closed Jan–Jun + July net = **$48,724,515.17**
  from stored rows (closed months are integer-rounded; the exact-penny figure is
  $47,814,304.43 + $910,210.17 = **$48,724,514.60**).

## 6. Precedence view — `lp_market_scorecard_resolved`

One authoritative row per `(market, period_start)`, ready to read:
`DISTINCT ON (market, period_start) … ORDER BY source_rank ASC, as_of_date DESC`, where
`source_rank` ranks on **`revenue_basis`** (`rtp_net_by_milestone_date`=1,
`…_provisional`=2, else=9). Legacy `backfill_split*` rows are **excluded** so they can never win.
Prefer this view for "the current number per market/period"; it already resolves closed→net and
live→report-or-pending correctly.

## 7. Out-of-scope notes

- **`lp_source_scorecard_daily`** (per-source funnel table) revenue remains **v1/funnel basis** —
  source-level RTP-net attribution is not available. It is **not** the realigned metric; the
  revenue hero must read `lp_market_scorecard_daily` / `lp_market_scorecard_resolved`.
- **Ingest:** `POST /n8n/admin/net-report-ingest` (raw Net Report CSV body) → `lp_net_report_rtp`.
  A newer report supersedes provisional for its range; superseded provisional values are retained
  on prior daily rows for drift audit.
- **Drift:** `GET /n8n/admin/net-report-drift` — closed-month report-net vs warehouse-gross, the
  measured −25%…+30% spread. The provisional is a pace signal; do not tune it to the report.
- **Config switch:** `SCORECARD_LIVE_MONTH_SOURCE` (default `net_report`). Flipping to
  `warehouse_rtp_gross` makes the warehouse gross the authoritative column (all-provisional,
  labeled) — a one-line change, no rebuild.
