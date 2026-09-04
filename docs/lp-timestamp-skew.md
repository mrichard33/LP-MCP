# LP timestamp skew — stored values are ET wall-clock, not UTC

**Status:** read-side fix shipped 2026-09-03. Write path unchanged and staying unchanged.
**Helpers:** `lpStoredToUtcMs` / `lpStoredAgeMinutes` / `lpStoredToUtcIso` / `utcToLpStoredIso` in `src/lp-dates.js`.
**Tests:** `scripts/test-lp-stored-timestamps.js`.

---

## 1. The measurement

`src/lp-dates.js` was "CORRECTED March 25, 2026" on the theory that LP returns UTC, so
`lpDateToEastern()` tags every bare LP datetime with `+00:00`. Measured 2026-09-03, that
theory is wrong for the fields feeding `created_at_lp`.

```sql
SELECT max(created_at_lp), max(synced_at),
       round(EXTRACT(EPOCH FROM (max(synced_at) - max(created_at_lp)))/3600.0, 2) AS lag_h
FROM lp_leads WHERE created_at_lp > now() - interval '2 days';
-- max(created_at_lp) 2026-09-03T22:49:23Z | max(synced_at) 2026-09-04T03:38:25Z | lag_h 4.82
-- lp_notes, same shape: ~4.0
```

Rows synced *minutes* after creation appear 4+ hours old. That gap is not sync lag — it is
the offset between ET and UTC.

**The proof case.** LP leads `572927` / `572928` / `572929` (contact `eqjK58AwEZ1juYJH6szE`,
Tom Messick) are stored `19:57:45+00:00`. Their own `lp.disposition_changed` events fired at
`23:59:48Z` — two minutes after real creation. The stored value is 19:57 **ET**, wearing a
`+00:00` offset it did not earn.

**Two files already said this and it was never generalized:** `src/ci/lp-readback.js:43` and
`scripts/test-ci-verify-lp.js:84` both state that `lp_notes.created_at_lp` is "4–5 hours early."

So: **a stored LP value is ET wall-clock wearing a `+00:00` offset.** Comparing it to a
true-UTC `Date.now()` reads every row as ~4h older than it is (5h in EST).

---

## 2. Why the write path does not change

Re-tagging `lpDateToEastern()` with `-04:00` is the obvious move and it is wrong:

- It would give new rows different semantics from the ~228k rows already stored, **silently
  splitting the table into two eras with no marker distinguishing them.** Every historical
  query would then need to know which era a row belongs to, and nothing records that.
- It would collide with `lpWallClockToGhlStartTime()`, which already normalizes
  `appointment_date` at the claim boundary.

Anyone proposing to change the writer must first answer what happens to those ~228k rows.
Until there is an answer, **conversion happens on read.**

---

## 3. Triage — where the skew actually changes behavior

Skew is a constant ~4h. Whether it matters depends entirely on the size of the window it is
compared against.

| Site | Window | Skew as % of window | Verdict |
|---|---|---|---|
| `src/admin/data-freshness.js` — `lp_leads` | 6 h | **67%** | **FIXED** — was causing false alerts |
| `src/admin/data-freshness.js` — `lp_notes` | 12 h | **33%** | **FIXED** — was causing false alerts |
| `src/jobs/goal-scorecard-daily.js` | day bucket | day-boundary | **Verified already correct** — see §5 |
| Requeue verification query | 30 min | **800%** | **FIXED** — was a false all-clear |
| `src/services/lp-contact-backstop.js:267,301` | 72 h | 5.5% | Documented, not fixed |
| `src/sync-triggers.js:35` day-15 | 15 d | 1.1% | Documented, not fixed |
| `src/tools/sync-tools.js:104` | 15 d | 1.1% | Documented, not fixed |
| `src/tools/lead-tools.js` (ordering only) | N d | ~1% | Documented, not fixed |
| `src/actions/handlers/risk-score.js:155` `daysOld` | days | <1% | Documented, not fixed |

**Only the sites where a 4h error changes an outcome are fixed.** A 4-hour error on a 15-day
filter moves 1.1% of the boundary and is not worth the regression risk today. The un-fixed
sites are listed here with their skew so a future pass has a list instead of a re-discovery.

---

## 4. What was fixed

### `src/lp-dates.js` — the canonical read-side helpers

Appended, with `lpDateToEastern` and `lpCreatedDate` untouched:

| Helper | Use |
|---|---|
| `lpStoredToUtcMs(stored)` | stored value → true UTC epoch ms, or `null` |
| `lpStoredAgeMinutes(stored, nowMs?)` | real age in minutes, or `null` |
| `lpStoredToUtcIso(stored)` | true-UTC ISO string, for logging |
| `utcToLpStoredIso(atMs?)` | **inverse** — a true-UTC instant in stored form, for index-eligible query bounds |

**Two-pass zone lookup.** The offset is looked up at the naive instant, then re-looked-up at
the corrected instant. Within four hours of a DST transition those differ and the second
answer is the right one. Exactly on the spring-forward gap the wall-clock time does not
exist; the later offset is taken, matching Postgres `AT TIME ZONE`.

**`null`, never `0`, on unparseable input.** A freshness monitor that reads a broken
timestamp as "brand new" is worse than one that errors.

**Apply only to columns written through `lpDateToEastern()`:** `lp_leads` /
`lp_notes.created_at_lp` and `.updated_at_lp`, `lp_call_logs.call_date`,
`lp_activities.activity_date`, `lp_jobs.created_at_lp`. **Never** to `synced_at`, or to any
`system_events` / `agent_actions` column — those are written by this service and are already
true UTC.

### `src/admin/data-freshness.js`

The four LP-derived tables carry `lp_wall_clock: true` and measure staleness through
`lpStoredAgeMinutes`. Unparseable timestamps now return `status: 'error'` rather than a `NaN`
staleness. The response carries both `latest` (converted) and `latest_raw` (as stored).

The old reading added a constant ~4h to every LP table. On `lp_leads` that left **two hours
of real headroom under a six-hour threshold** — so any ordinary quiet stretch paged GroupMe
with a STALE DATA warning that was not true.

---

## 5. `goal-scorecard-daily.js` — verified already correct, deliberately unchanged

The handoff called for converting the raw-lead-count bounds with `utcToLpStoredIso`.
**Measured against live data, that site is already correct and the conversion would break it.**

`periodStart` / `nextDay(periodEnd)` are bare ET `YYYY-MM-DD` strings. Postgres (session
`TimeZone = UTC`, confirmed) reads those as midnight `+00:00`. The column holds ET wall-clock
tagged `+00:00`. **Both sides of the comparison are ET wall-clock in the same frame, so the
skew cancels exactly.**

```sql
-- 2026-09-02, live:
--   current bare-date bounds ......................... 325
--   (created_at_lp AT TIME ZONE 'UTC')::date = day .... 325   ← identical
--   bounds shifted 4h by utcToLpStoredIso ............. 324   ← wrong
```

`utcToLpStoredIso` converts a **true-UTC instant** into stored form. These bounds are not
true-UTC instants, so applying it would shift them 4h earlier and pull in the previous ET
evening — introducing the day-boundary bug rather than removing it. The comment at that site
records this so the next reader does not "fix" it.

**The conversion belongs only where a bound really is a true-UTC instant** — a
`Date.now()`-derived window, not an ET calendar date string.

---

## 6. Corrected queries

### 6a. Requeue-duplicate check

The original form in `Handoff_Duplicate_LP_Leads_And_False_Cancellation` compares
`created_at_lp` directly against `agent_actions.created_at` (true UTC). **It returns 0 for
every row — a false all-clear.**

```sql
SELECT a.id, a.target_id, a.retry_count,
 (SELECT count(*) FROM lp_leads l
   WHERE l.ghl_contact_id = a.target_id
     AND ((l.created_at_lp AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')
         BETWEEN a.created_at AND a.created_at + interval '30 minutes') AS leads_created
FROM agent_actions a
WHERE a.action_type = 'lp_callback_requeue'
  AND a.created_at > now() - interval '14 days'
ORDER BY a.created_at DESC;
```

Measured 2026-09-03, corrected vs. original, side by side:

| action | corrected | original |
|---|---|---|
| `418351` (Messick) | **3** | 0 |
| `405952` (Mark Test) | **3** | 0 |
| `388193` (Totolis) | **3** | 0 |

Post-PR-823, any **new** action must show 0.

### 6b. Real staleness of any LP-derived table

```sql
SELECT max(created_at_lp) AS stored,
       max(created_at_lp) + interval '4 hours' AS approx_true_utc,  -- 5h in EST
       now() - (max(created_at_lp) + interval '4 hours') AS real_age
FROM lp_leads;
```

In application code use `lpStoredAgeMinutes` rather than a hardcoded interval — it handles
DST.

---

## 7. Post-deploy verification

1. `GET /n8n/admin/freshness` — `lp_leads` and `lp_notes` `staleness_min` must drop by ~240
   relative to the pre-deploy reading, and `latest_raw` must show the stored value while
   `latest` shows the converted one.
2. `data_freshness_log` — no STALE DATA alert for `lp_leads` or `lp_notes` in the 48h after
   deploy unless the sync is genuinely stopped. Confirm against `lp_sync_log` that syncs were
   running for any alert that does fire.

---

## 8. Decisions — do not relitigate

- **`lpDateToEastern()` is not changing.** Read-side conversion only.
- **Convert the bounds, not the column,** in any query that must stay index-eligible —
  `utcToLpStoredIso` exists for exactly that. But only where the bound is a true-UTC instant
  (§5).
- **Only the sites where the error changes an outcome are fixed.** The rest are in §3 with
  their skew percentage.
- **`lpStoredAgeMinutes` returns `null`, not `0`,** on unparseable input.

---

## 9. The appointment columns — 2026-09-04

§4 restricted the read-side helpers to the columns written through `lpDateToEastern()` and
deliberately left `appointment_date` / `demo_date` / `set_date` / `confirmed_date` off the
list, on the grounds that `lpWallClockToGhlStartTime()` already normalizes them at the GHL
claim boundary.

That was true of every site that **builds** a GHL appointment. It was not true of the sites
that **compare** the column to `now()`, and nothing owned those.

### What it cost

`duplicate-lead-guard.js` clause (a) filtered `.gte('appointment_date', new Date().toISOString())`
— a true-UTC bound against an ET-wall-clock column. A 6:00 PM ET appointment is stored
`2026-09-04T18:00:00+00:00`, and from 2:00 PM ET the bound is already past it, so **the guard
stopped protecting a booked customer four hours before their appointment began.** Verified on
contact `zLDD7V1eosF8vldF5U7i`, lead 459770 (2026-09-04). The same contact held a 2:00 PM
cancellation and a 6:00 PM live appointment on one day with no invariant catching it.

`hasActiveBooking()` in `agentic/lead-state/signals/context-reader.js` had the same shape
against `Date.now()`, releasing contacts from the S4.5 suppression gate 4–5h early.

### What changed

The bound, never the column. `utcToLpStoredIso()` at:

- `src/duplicate-lead-guard.js` — both clauses
- `src/jobs/appointment-parity-watchdog.js` (the `lp_leads` read only; the GHL
  `appointments.start_time` read beside it is true UTC and is untouched)
- `src/admin/ghl-appointment-backfill.js`, `src/admin/parity-report.js`
- `src/services/lp-contact-backstop.js` — the appointment window and the `created_at_lp` window

and `lpStoredToUtcMs()` in `context-reader.js`'s `hasActiveBooking`.

**Nothing stored changed, so §2 still holds** — there is no second era and no backfill. The
two mechanisms are split by DIRECTION, not by column: `utcToLpStoredIso()` moves a *bound*
into the stored frame for comparison; `lpWallClockToGhlStartTime()` moves a stored *value*
out of it for GHL. Neither touches what the other reads. Do not "simplify" this by converting
the column — that also drops index eligibility on every one of these queries.

### Correction to a note elsewhere

`sql/migrations/2026-08-03_contact_appointment_authority.sql:47-55` states that
`updated_at_lp` is true UTC ("0 of 228,013 rows are future-dated"). It is not — a
non-future-dated column is not evidence of a true-UTC one. Measured 2026-09-04 on rows synced
within 6h:

```sql
SELECT round(EXTRACT(EPOCH FROM (max(synced_at) - max(updated_at_lp)))/3600.0, 2) AS updated_lag_h,
       round(EXTRACT(EPOCH FROM (max(synced_at) - max(created_at_lp)))/3600.0, 2) AS created_lag_h
FROM lp_leads WHERE synced_at > now() - interval '6 hours';
-- updated_lag_h 4.01 | created_lag_h 4.10
```

`updated_at_lp` carries the same ~4h skew as `created_at_lp`. On the guard's 30-day sale
lookback that is 0.6% and changed no outcome, but the bound was moved to the stored frame
anyway so both clauses read the same way.

### Deliberately not fixed

Per the §3 rule — fix only where the error changes an outcome — these still compare raw and
are left alone, each on a multi-day window where 4h does not flip the decision:
`src/intent-scorer.js:191`, `src/agentic/lead-selection/select.js:280,298`,
`src/agentic/lead-state/signals/behavioral-signals.js:192,259`.

`sql/schema.sql:39` `close_date` has no writer and no reader anywhere in `src/`, `scripts/`
or `sql/`. Nothing to fix.
