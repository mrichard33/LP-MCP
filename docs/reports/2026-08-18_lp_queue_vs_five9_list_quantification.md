# LP Dial Queues vs Five9 List Sizes — Quantification (read-only)

**Date measured:** 2026-08-18, 22:14–22:20 UTC (18:14–18:20 ET)
**Method:** read-only. LP counts paged via `POST /api/Downloads/GetLeadsByCQDID`
(1000-row windows, `startrow`/`endrow` 1-indexed inclusive, paged until a partial
page) with calls spaced to stay well under the 60/min domain-wide LP budget.
Five9 counts from the Five9 Admin list inventory (record counts per list).
No writes were made to LP, Five9, GHL, or Supabase. No runtime code changes in
this PR.

## Findings

| LP queue name        | cqd_id | LP dialable count | Five9 list name                | Five9 list size | Delta (LP − Five9) |
|----------------------|--------|-------------------|--------------------------------|-----------------|--------------------|
| Data - Hot Leads <7  | 8      | 1,162             | Data - Hot Leads less than 7   | 1,115           | 47                 |
| Data - Warm Leads <30| 30     | 2,543             | Data - Warm Leads less than 30 | 2,392           | 151                |
| Data - Leads >30     | 9      | 8,963             | Data - Leads more than 30      | 3,178           | **5,785**          |

Page-level LP detail (each page is one API pull):

- cqd 8: 1,000 + 162 = **1,162**
- cqd 30: 1,000 + 1,000 + 543 = **2,543**
- cqd 9: 8 full pages + 963 (rows 8001–8963) = **8,963** (row windows are
  contiguous `ROW_NUMBER` ranges, so a partial page at 8001 proves the earlier
  pages full; verified full pages at 1, 1001, 2001, 3001)

## Interpretation

1. **The morning starvation did not reproduce at measurement time.** Earlier on
   2026-08-18 the Five9 list "Data - Hot Leads less than 7" held **1 record**
   while LP cqd 8 returned 1000+ dialable rows and the campaign was RUNNING. At
   18:14 ET the same list held 1,115. Five9 lists repopulate at 6 AM ET daily,
   so the two readings sit on opposite sides of at least one repopulation cycle.
   The morning reading remains unexplained; this report cannot distinguish
   "mapping fixed" from "mapping intermittently starves the list". The LP Dialer
   Queue Mapping screen for cqd 8 is a UI-only surface — Mark is the only one
   who can read it, and it is the next diagnostic step.
2. **The structural gap is cqd 9.** LP holds 8,963 dialable leads in
   "Data - Leads >30"; the matching Five9 list holds 3,178 — a shortfall of
   5,785 leads (65% of the queue) that persists after the daily repopulation.
   The hot/warm deltas (47 / 151) are small enough to be same-day churn between
   the two measurement instants; the cqd 9 delta is not.
3. **Attempt counts show the queues are being worked unevenly.** Sampled rows in
   cqd 8 page 2 already carry `NumDialingAttempts` 2; cqd 9 samples range from 0
   attempts (never dialed, e.g. Lds_ID 553347) to 53 attempts. Fresh never-dialed
   leads coexist with heavily-redialed ones inside the same queue.

Adjacent observations captured while reading the list inventory (not part of the
three-row ask): "Data -Old more than 180" holds 989, "AGED DATA" 2,456,
"SimpleText-data" 71.

## Scope

Quantification only, per the 2026-08-18 handoff (Section A). The suspected cause
lives in the LP Dialer Queue Mapping configuration, which is not reachable from
the API. Nothing in this PR changes runtime behavior.
