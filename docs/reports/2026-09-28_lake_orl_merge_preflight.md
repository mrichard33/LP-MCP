# Lakeland → Orlando merge — Step 0 preflight (2026-09-28)

Read-only. Nothing has been written to any database, Five9, GHL or Slack.

## memory_precheck — "merge Lakeland market into Orlando"

Verdict **clear** (no `previously_rejected`, no `conflict_open`). But this merge
reverses four ACTIVE decisions, which must be superseded when it ships:

| id | date | decision | effect of this merge |
|---|---|---|---|
| 467 | 2026-08-06 | Lakeland becomes its own market everywhere (dashboard + board) | reversed |
| 468 | 2026-08-06 | Lakeland goal carved OUT of Orlando; company total stays fixed | reversed (goal added back; company total still unchanged) |
| 521 | 2026-08-18 | Seven dial markets, ORL incl. Lakeland via DIAL_MARKET merge map | becomes six; merge moves into the data |
| 2579 | 2026-09-24 | Service cards whose Servicing Office says "Lakeland" always go to #service-lakeland | **needs a ruling** — see Q1 |

## 0.1 Every place Lakeland lives (LP Supabase)

Counts are rows holding `LAKE` / `LAKE_MKT` / `Lakeland`. No view or function body hardcodes Lakeland.

### Config (small, change directly)
| table | rows | note |
|---|---|---|
| `lp_branch_market_map` | 1 | `LAKE → LAKE_MKT / Lakeland`. The one switch every writer reads. |
| `service_area_zips` | 59 | `market_code='LAKE'`; FK → `service_markets` |
| `service_markets` | 1 | `LAKE`, enabled. Referenced by the zips FK → deactivate, don't delete |
| `slack_market_slugs` | 1 | `LAKE → lakeland` |
| `slack_channels` | 3 | sales-lakeland, canvass-lakeland, service-lakeland |
| `scorecard_goals` | 1 | live goal row |
| `scorecard_goals_monthly` | 12 | Jan–Dec 2026 |

### Row-level facts (one row per lead/job/report row — safe to relabel `market`, raw columns untouched)
| table | rows |
|---|---|
| `lp_lead_market_assignments.resolved_market_code` | 9,298 (the 05:00 ET `scope='all'` job rewrites these itself once the map changes) |
| `lp_lead_disposition_history.market` | 15,003 |
| `lp_job_status_history.market` | 457 |
| `lp_sales_efficiency_history.market` | 70 |
| `scorecard_report_rows_a.market` / `_b.market` | 266 / 8 |

### Aggregates (one row per date+market — would COLLIDE, must be summed)
| table | LAKE rows | collide with ORL on the unique key |
|---|---|---|
| `lp_appt_fill_hourly` (snapshot_hour, slot_date, market) | 9,883 | 9,108 |
| `lp_appt_fill_snapshot` (snapshot_date, slot_date, market) | 472 | 422 |
| `lp_market_scorecard_daily` (market, as_of_date) | 89 | 89 |
| `lp_net_report_rtp` (market, report_month, report_as_of) | 46 | 46 |
| `lp_report_facts` (snapshot, market, branch_raw, metric, bucket) | 1,543 | 204 (the 308 rows with no LAKE branch are market-level rollups) |

`lp_market_scorecard_daily` cannot be safely rebuilt by its job for past dates (the job does not delete
the old LAKE row, and revenue reads from `lp_net_report_rtp`), so the plan is a SQL sum: counts and
dollars add; percent columns are recomputed from the summed counts using the same formulas.

### Raw LP branch codes — recommend LEAVE (the Fort Lauderdale precedent keeps BOCA/MIAMI raw here too)
| column | rows | why leave |
|---|---|---|
| `lp_capacity_slots.rep_home_market` | 144 `LAKE` | raw LP value, rewritten by every sweep; board views map it live through `lp_branch_market_map` |
| `ci_canvassers.market` | 20 `LAKE` | raw roster CSV value (BOCA also stays) |
| `lp_jobs.branch_code`, `lp_leads.lp_branch_id`, `lp_lead_disposition_rows.branch_code_raw`, all `branch_code_raw`/`market_code_raw` | — | audit trail |
| `ft_leads` / `ft_summary_territory.territory` | 1,009 / 271 | Lead Gurus vendor label, verbatim |

### No Lakeland rows today
`team_members`, `sale_announcements`, `agentic_callback_log`, `lp_source_scorecard_daily`, `lp_source_spend_daily`.

Views that show LAKE_MKT only because the tables above do: `lp_cohort_maturation`, `lp_market_scorecard_resolved`,
`v_appt_board`, `v_appt_board_bands`, `v_capacity_submission_horizon`, `v_scorecard_current`, `v_bot_review_queue`.

## 0.3 Hardcoded Lakeland in code

**LP-MCP — must change**
- `src/capacity/rankMarkets.js:72` `MARKET_CODES` includes `LAKE_MKT`
- `src/capacity/applyDialPriority.js:83` `MARKET_LISTS.LAKE_MKT` → LKE lists
- `src/slack.js:44` `MARKET_ALIASES` has BOCA/MIAMI → FTLAU but no `LAKE → ORL`. Without it, deleting the Lakeland
  Slack rows sends Lakeland cards to the ROLLUP channels, not Orlando's (LP still stamps `lp_branch_id='LAKE'`).
  The same map groups the sale leaderboard (`office-ranking.js`), so the alias also merges Lakeland there.
- `src/actions/service-card.js:65` hardcodes `LAKE` for a Lakeland Servicing Office (decision 2579 — Q1)
- Tests: `test-capacity-ranker.js`, `test-dial-rank-source.js`, `test-capacity-bands.js`, `test-service-card.js`

**LP-MCP — keep** (they recognise LP's raw branch token, which LP will keep printing):
`BRANCH_CODES` (`lp-report-parse-a.js:54`), `MARKET_CODES` (`lp-report-parse-b.js:31`),
`SE_BRANCH_LABELS` (`lp-report-parse-sales-efficiency.js:46`), `approval-card.js` `BRANCH_NAMES.LAKE`.

**Seeds that would undo the merge if re-applied by hand:** `sql/037_scorecard_market_split.sql:39`,
`sql/017_service_area_zips.sql:85`, `data/service_area_zips.csv`.

**Market-map cache:** writers cache `lp_branch_market_map` up to 1 hour (`MARKET_MAP_TTL_MS`), Slack tables 10 min.
Redeploy right after the migration so nothing writes a fresh `LAKE_MKT` row after the cleanup.

**Reece-Dashboard** — 7 markets hardcoded in `lib/scorecard/markets.ts` (`SCORECARD_MARKETS`),
`components/capacity-board/CapacityBoard.tsx` (`BOARD_DESIGN_ORDER`), plus comments/tests in ~20 files.
Change: drop the `LAKE_MKT` entry and give Orlando `sources: ["ORL_MKT","LAKE_MKT"]` — the same mechanism as the
old fold, so any straggling LAKE_MKT row still sums into Orlando instead of vanishing.

**n8n** — `OPS.SLK-A-team-onboarding-intake` has a "Lakeland" option mapping to `LAKE`
(`scripts/lib/slack-onboarding-normalize.js:15`).

**HL-MCP** — nothing functional (two static marketing pages mention the city).

## 0.4 Who fills `Data - Hot - LKE less than 7` / `Data - Warm - LKE less than 30`

**Lead Perfection's own "Dialer Queue Mapping" export** (UI-only inside LP, ~6 AM ET). Not our code, not n8n
(confirmed 2026-09-08, session 787 / issue 1782: LP-MCP only reads these lists). Fix is in LP — Mark.

## 0.5 Service phone

Lakeland and Orlando already share **(407) 604-7114** (Mon–Fri 8–5). `check_service_area('33801')` → LAKE / Lakeland,
note "Polk. Shares office with ORL." After the merge it returns ORL / "Orlando / Central Florida" — same phone.

## Step 6 preview — GHL (report only)

- Live workflow **U.MRKT Market Lead Assigner** (`b35a32c9-49e8-445e-ab3b-f0e1fa41f9bd`, published) has a trigger
  branch `LP Market == LAKE`. GHL-Workflows repo: no Lakeland matches.
- GHL "LP Market Code" (`z0MV6mXi0w9WwdCOFThh`) keeps receiving `LAKE` from LP's branch; the Slack alias handles routing.

## Goals — the numbers

Adding Lakeland into Orlando keeps every company (REECE) total unchanged, because REECE is Σ offices.
Jan–Jul simply undoes migration 0018's carve-out (Orlando back to $1,736,866.40).

| month | Orlando | Lakeland | Orlando after |
|---|---|---|---|
| Aug 2026 | 1,048,251 | **1,000,000** | **2,048,251** |
| Sep 2026 | 1,184,232 | 133,388 | 1,317,620 |

Live `scorecard_goals`: Lakeland also shows **$1,000,000** (set by Mark 2026-08-18). Every other month Lakeland is
$25k–$212k. See Q2.

Rate columns (`target_demo/close/ko/good_rate_pct`) are identical for both markets where set — nothing to average.
`trailing_nsli` is a per-lead rate, not a count: keep Orlando's value.
