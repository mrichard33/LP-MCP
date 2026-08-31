# install_date hand-verification worksheet — 10 jobs

**This is the merge gate for the `lp_jobs` field backfill.** Nothing automated in the
PR can catch a mapper that reads the wrong milestone code: it would produce a
fully-populated, entirely plausible column of wrong dates and every count-based
check would pass. Ten rows checked by eye against the Lead Perfection UI is the only
thing that catches it.

**Do not merge until this is signed off.**

## What the mapper does

`install_date` ← milestone **`S` / "Start"** → **`actdate`**
`install_completed_date` ← milestone **`F` / "Install End"** → **`actdate`**

Never `estdate`. Never `C` / "Completion". The `Est start` column below is shown
**only for contrast** — it is what a wrong mapper would have written, and it is
never stored.

Note how far off it is: on every row here the estimated start sits roughly six
months after the real one. Substituting `estdate` would not produce subtly wrong
data, it would push essentially every install date into 2027 — and the column would
still look complete.

## The rows

| # | Job | Customer | Status | Shape | **install_date** (S actdate) | **install_completed_date** (F actdate) | _Est start — not stored_ | C "Completion" |
|---|---|---|---|---|---|---|---|---|
| 1 | 59382 | Alan/Eugeina Lemmond | Scheduled | A | 2026-09-07 | 2026-09-07 | _2027-02-26_ | — |
| 2 | 59275 | Phil & Annette Westwood | Scheduled | B | 2026-09-01 | 2026-09-01 | _2027-02-19_ | — |
| 3 | 59271 | Laura Ansell | Scheduled | B | **NULL** | NULL | _2027-02-19_ | — |
| 4 | 59260 | Lorielly/Jorge Martinez | Installed & Unpaid | A | 2026-08-26 | 2026-08-26 | _2027-02-18_ | — |
| 5 | 59326 | Gale Somers | Installed & Unpaid | B | 2026-08-26 | **NULL** | _2027-02-23_ | — |
| 6 | 59436 | Marion Kaufman | Installed & Unpaid | B | 2026-08-26 | 2026-08-26 | _2027-03-02_ | — |
| 7 | 59214 | Marcia Rosman | Paid In Full | A | 2026-08-28 | 2026-08-29 | _2027-02-15_ | 2026-08-31 |
| 8 | 59193 | Darcy Arenz | Paid In Full | B | 2026-08-25 | 2026-08-25 | _2027-02-14_ | 2026-08-27 |
| 9 | 59373 | Evelyn/Martin Jacobs | Paid In Full | B | 2026-08-27 | 2026-08-27 | _2027-02-25_ | — |
| 10 | 59595 | Cindy/Tom Looc | Awaiting Product | B | **NULL** | NULL | _2027-03-16_ | — |

Both payload shapes are represented (3 Shape A, 7 Shape B) so the check covers the
two endpoints, not just one.

## What to check in the LP UI

For each row, open the job and read its milestone grid.

1. **The dates match.** `install_date` equals the **actual** date on the **Start**
   milestone — not the estimated date, not Install End.
2. **Rows 7 and 8 are the F-vs-C check.** Both are Paid In Full with a
   `Completion` date that differs from `Install End` — two days apart on row 8,
   two days on row 7. `install_completed_date` must carry the **Install End**
   value, not Completion. `C` covers 3,204 of 3,230 Paid In Full jobs against
   `F`'s 2,127, so a mapper reaching for coverage would grab the wrong one and
   this is where it shows.
3. **Row 5 is the asymmetric case.** Installed but no Install End stamped — the
   install started and the end date was never recorded. `install_date` set,
   `install_completed_date` NULL is correct.
4. **Rows 3 and 10 must be NULL.** Neither has an actual Start date in LP. Row 10
   (Awaiting Product) has not been scheduled at all; row 3 is booked but not yet
   stamped. If either shows a 2027 date after the backfill, the mapper fell
   through to `estdate` and **the PR must not merge**.
5. **Rows 1, 2, 9 are future or same-week installs.** A future `install_date` is
   correct, not a bug — LP is routinely used to record scheduled actuals, and the
   milestone gate holds the tag while still storing the date
   (`src/milestone-gate.js`).

## Sign-off

- [ ] All ten `install_date` values match the LP UI Start actual date
- [ ] Rows 7 and 8 carry Install End, not Completion
- [ ] Rows 3 and 10 are NULL, not a 2027 estimate
- [ ] No date in the `Est start` column appears anywhere in `lp_jobs`

Verified by: ________________  Date: ____________

Query to re-pull these ten rows after the backfill:

```sql
SELECT lp_job_id, job_status, install_date, install_completed_date
  FROM lp_jobs
 WHERE lp_job_id IN ('59382','59275','59271','59260','59326',
                     '59436','59214','59193','59373','59595')
 ORDER BY job_status, lp_job_id;
```
