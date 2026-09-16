# Job run history — `job_runs`, `job_registry`, `v_job_status`

**Added:** 2026-09-16 (`sql/113_job_runs.sql`)
**Code:** `src/job-runner.js`, `src/job-registry.js`
**Consumer:** Reece-Dashboard → `/agent` (Decision Engine)

## Why

This service runs about 44 scheduled background jobs. Before this, not one of
them had a durable run history: each kept its last result in a module-level
variable (`lastRun`, `lastRunSummary`, `lastRunDate`) that Railway wipes on
every deploy. "Did the nightly job run last night, and did it work?" had no
answer, which is the same shape of blind spot that let the decision engine sit
dormant for 47 hours and the fail-closed counter go unread for 71 days.

This is the roster and the one-line outcome. It does **not** replace the detail
tables some jobs already keep (`lp_sync_log`, `lp_source_reconcile_runs`,
`scorecard_ingest_log`, `five9_config_snapshots`). Those stay.

## The status vocabulary is six values, and two of them are the point

| status | meaning |
|---|---|
| `running` | in flight right now |
| `ok` | finished, and the job said it worked |
| `failed` | it threw, **or** it returned `ok:false` / `success:false` without throwing |
| `unknown` | the job could not tell. Never recorded as fine. |
| `interrupted` | the process was killed mid-pass. Infrastructure, not a defect. |
| `skipped` | a re-entrancy guard declined to start. Not a defect either. |

**`failed` without a throw is the one that matters.** Most jobs here never
throw: `runMemoryNightly` wraps all ten of its steps and returns
`{ ok: false, errors: [...] }`, `runWorkflowProjection` returns
`{ success: false, error }`, and `runFastCapacityPass` folds sub-step errors
into a summary object. A wrapper built on `try/catch` alone would file every one
of those as a success and produce a more convincing version of the blind spot it
was built to remove. `classifyResult()` reads the returned value, and that
function is the most heavily tested thing in the module.

**`unknown` follows the tri-state rule** already used by `reportAlertCondition`
in `src/alert-state.js`: a read that failed must neither page nor clear.
`checkLpReportFreshness` tracks a `readFailed` flag precisely so an unreadable
table is not reported as a healthy check.

**`interrupted` is not `failed`.** This is the lesson from `src/sync-log.js:56-70`
repeated: every SIGTERM row in `lp_sync_log` came from a Railway deploy, and
counting those as failures produced a "23% failure rate" nobody could act on for
weeks. Shutdown cleanup is scoped to `instance_id`, so two replicas cannot bury
each other's in-flight work.

## What is instrumented

Twelve jobs, listed in `src/job-registry.js`. Eight of them had no durable
history of any kind; four keep a detail table but had no roster entry.

The two per-minute heartbeats (decision engine, executor) are **deliberately
excluded**: they already have dedicated `/heartbeat-status` endpoints and
edge-triggered alerting, and a row a minute would add roughly 2,900 rows a day
carrying no new signal.

## Adding the thirteenth job

1. Add a row to `JOBS` in `src/job-registry.js`, including an `isEnabled(env)`
   that mirrors the gate in the job's own module exactly. That is what lets the
   dashboard say "disabled" instead of "stale" — an alarm that fires on the
   healthy case gets muted, and a muted alarm is how the outages above went
   unnoticed. The gate is **resolved here at boot and stored** in
   `job_registry.enabled`, because these env vars live on this service and the
   dashboard cannot read them. Watch the two odd ones:
   `LP_REPORT_WATCHDOG_DISABLED` is inverted, and `OMI_PULL_MODE` is a mode
   rather than a boolean.
2. Wrap the call inside that job's own `start*Scheduler()`:
   ```js
   await runJob('my-job', () => runMyJob());
   ```
3. **Wrap the work, not the timer tick.** Seven of these tick every five minutes
   but only act inside an Eastern-time window. Wrapping the tick would file about
   288 no-op rows a day for each of them. The wrap belongs inside the hour gate,
   so a row always means a real pass.
4. `runJob` never throws and never rethrows, so the surrounding `try/catch` stays
   as it is. It returns `{ status, summary, value, error }`, so a caller that
   needs the job's own return value reads `value`.

## Retention

Runs older than 90 days are pruned daily (`JOB_RUNS_RETENTION_DAYS` overrides).
At the current cadence the twelve jobs write roughly 1,000 rows a day.

## Reading it

The dashboard reads `v_job_status`: one row per registered job with its latest
run and a 24-hour tally. A registered job that has never run appears with
`last_status` NULL — that row is the entire point of the table, so the view uses
`LEFT JOIN`, never `INNER`.
