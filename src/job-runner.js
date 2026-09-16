/**
 * job-runner.js — one row per real pass of a scheduled background job.
 *
 * WHY (2026-09-16). ~44 scheduled jobs, none with a durable run history: each
 * kept its last result in a module-level variable that Railway wipes on every
 * deploy. "Did the nightly job run last night, and did it work?" had no answer.
 * See sql/113_job_runs.sql for the full account and the table definitions.
 *
 * This is modelled on syncLogStart/syncLogComplete in src/sync-log.js, which
 * has been doing the same job for lp_sync_log for months — including the two
 * lessons that matter most:
 *
 *   1. activeRunIds scopes shutdown cleanup to THIS process's rows. Two
 *      replicas must not mark each other's in-flight runs dead.
 *   2. `interrupted` is not `failed`. Every SIGTERM row in lp_sync_log came
 *      from a Railway deploy; counting those as failures produced a "23%
 *      failure rate" nobody could act on (src/sync-log.js:56-70).
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. Most jobs here never throw. They catch
 * everything internally and report failure in the RETURN VALUE:
 *
 *     runMemoryNightly()      → { ok: false, errors: [...] }   (ten guarded steps)
 *     runWorkflowProjection() → { success: false, error }
 *     runFastCapacityPass()   → summary with per-step { error } sub-objects
 *     checkLpReportFreshness()→ { checked: false } when it could not read
 *
 * A wrapper built on try/catch alone would file every one of those as a
 * success, and the new table would be a more convincing version of the same
 * blind spot it was built to remove. So classifyResult() reads the value.
 *
 * Everything that touches the network or the database comes in through `deps`
 * (CLAUDE.md), so the whole module tests without a live Supabase.
 */

import os from 'node:os';
import supabase from './supabase.js';
import { onShutdown } from './graceful-shutdown.js';

/** Terminal statuses. Mirrors the CHECK constraint in sql/113_job_runs.sql. */
export const JOB_STATUS = Object.freeze({
  RUNNING: 'running',
  OK: 'ok',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped',
  INTERRUPTED: 'interrupted',
});

/** Run ids owned by THIS process — scopes shutdown cleanup. */
export const activeRunIds = new Set();

const SUMMARY_MAX = 500;
const PRUNE_AFTER_DAYS = Number(process.env.JOB_RUNS_RETENTION_DAYS || 90);

export function instanceId() {
  return (
    process.env.RAILWAY_REPLICA_ID ||
    process.env.RAILWAY_DEPLOYMENT_ID ||
    os.hostname() ||
    'unknown'
  );
}

function clip(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

/**
 * The heart of this module: decide what a finished pass actually means.
 *
 * Order is deliberate and load-bearing:
 *   1. it threw                       → failed
 *   2. it declined to start           → skipped (a re-entrancy guard, not a defect)
 *   3. it SAID it failed              → failed (authoritative, even without a throw)
 *   4. it said it could not tell      → unknown (never recorded as fine)
 *   5. anything else                  → ok
 *
 * Step 3 sits above step 4 on purpose: when a job states ok:false it has made a
 * definite claim about its own outcome, and that claim wins over a partial-read
 * hint. Step 4 catches the case where the job reached no conclusion at all.
 *
 * Pure. No I/O, no clock, no imports used. Exported for the test suite because
 * this function is where the "never throws" trap is either caught or repeated.
 */
export function classifyResult(value, error) {
  if (error) {
    return { status: JOB_STATUS.FAILED, summary: clip(error.message || error) };
  }
  if (value && typeof value === 'object') {
    if (value.skipped === true) {
      return { status: JOB_STATUS.SKIPPED, summary: clip(value.reason || 'skipped') };
    }
    if (value.ok === false || value.success === false) {
      const errs = Array.isArray(value.errors) ? value.errors.join('; ') : null;
      return {
        status: JOB_STATUS.FAILED,
        summary: clip(errs || value.error || value.reason || 'job reported failure'),
      };
    }
    if (value.checked === false || value.readFailed) {
      return {
        status: JOB_STATUS.UNKNOWN,
        summary: clip(value.reason || value.error || 'job could not determine an outcome'),
      };
    }
  }
  return { status: JOB_STATUS.OK, summary: clip(describe(value)) };
}

/**
 * A one-line summary for the roster. Jobs return wildly different shapes, so
 * prefer an explicit summary field, then fall back to the handful of scalar
 * counters the shape happens to carry. Never dump the whole object — the full
 * value is kept verbatim in job_runs.detail.
 */
export function describe(value) {
  if (value === null || value === undefined) return 'completed';
  if (typeof value !== 'object') return String(value);
  if (typeof value.summary === 'string' && value.summary) return value.summary;

  const parts = [];
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'number' && Number.isFinite(v) && k !== 'elapsed_ms') {
      parts.push(`${k}=${v}`);
    }
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join(' ') : 'completed';
}

function db(deps) {
  return deps.supabase !== undefined ? deps.supabase : supabase;
}

/**
 * Run one job pass and record it.
 *
 * NEVER THROWS and never rethrows the job's error. A scheduler that called this
 * must keep ticking: a failed pass is data, not a reason to stop the timer, and
 * a failure to WRITE the log row must not take the job down with it.
 *
 * Returns { status, summary, value, error } so a caller that wants the job's
 * own return value still has it.
 */
export async function runJob(jobId, fn, deps = {}) {
  const client = db(deps);
  const now = deps.now || (() => Date.now());
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();

  let runId = null;
  if (client) {
    try {
      const { data, error } = await client
        .from('job_runs')
        .insert({
          job_id: jobId,
          status: JOB_STATUS.RUNNING,
          started_at: startedAt,
          instance_id: deps.instanceId || instanceId(),
        })
        .select('id')
        .single();
      if (error) throw error;
      runId = data?.id ?? null;
      if (runId !== null) activeRunIds.add(runId);
    } catch (err) {
      // Losing the log row must not lose the job. Run it unlogged and say so.
      console.error(`[JobRunner] ${jobId}: could not open a run row: ${err.message}`);
    }
  }

  let value;
  let error = null;
  try {
    value = await fn();
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }

  const { status, summary } = classifyResult(value, error);
  const finishedMs = now();

  if (status === JOB_STATUS.FAILED) {
    console.error(`[JobRunner] ${jobId} FAILED: ${summary}`);
  } else if (status === JOB_STATUS.UNKNOWN) {
    console.warn(`[JobRunner] ${jobId} UNKNOWN: ${summary}`);
  }

  if (runId !== null && client) {
    activeRunIds.delete(runId);
    try {
      const { error: updErr } = await client
        .from('job_runs')
        .update({
          status,
          summary,
          detail: serializable(value ?? (error ? { error: String(error.message || error) } : null)),
          finished_at: new Date(finishedMs).toISOString(),
          elapsed_ms: Math.max(0, Math.round(finishedMs - startedMs)),
        })
        .eq('id', runId);
      if (updErr) throw updErr;
    } catch (err) {
      console.error(`[JobRunner] ${jobId}: could not close run ${runId}: ${err.message}`);
    }
  }

  return { status, summary, value, error };
}

/** jsonb-safe: drop anything that will not survive JSON.stringify. */
function serializable(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { unserializable: true };
  }
}

/**
 * Upsert the roster at boot so job_registry always reflects deployed code.
 * Idempotent by construction (job_id is the primary key).
 */
export async function registerJobs(jobs, deps = {}) {
  const client = db(deps);
  if (!client) return { registered: 0, skipped: 'no supabase' };
  const rows = jobs.map((j) => ({
    job_id: j.id,
    label: j.label,
    job_group: j.group || 'general',
    cadence: j.cadence || null,
    enabled_env: j.enabledEnv || null,
    enabled_default: j.enabledDefault !== false,
    registered_at: new Date((deps.now || (() => Date.now()))()).toISOString(),
  }));
  try {
    const { error } = await client.from('job_registry').upsert(rows, { onConflict: 'job_id' });
    if (error) throw error;
    console.log(`[JobRunner] registered ${rows.length} jobs`);
    return { registered: rows.length };
  } catch (err) {
    // sql/113 may not be applied yet. That is a dashboard-visible condition,
    // not a boot failure — the service must come up either way.
    console.error(`[JobRunner] could not register jobs (is sql/113 applied?): ${err.message}`);
    return { registered: 0, error: err.message };
  }
}

/**
 * Mark this host's leftover `running` rows as interrupted at boot.
 *
 * A row is only orphaned if the process that owned it is gone, so this is
 * scoped to instance_id. Precedent: the stale-lock sweep at
 * src/sync-engine.js:1631. Without it, a deploy mid-pass leaves a row that
 * reads "running" forever and the roster shows a job permanently in flight.
 */
export async function reapOrphanRuns(deps = {}) {
  const client = db(deps);
  if (!client) return { reaped: 0 };
  const id = deps.instanceId || instanceId();
  try {
    const { data, error } = await client
      .from('job_runs')
      .update({
        status: JOB_STATUS.INTERRUPTED,
        summary: 'process restarted while this pass was in flight',
        finished_at: new Date((deps.now || (() => Date.now()))()).toISOString(),
      })
      .eq('status', JOB_STATUS.RUNNING)
      .eq('instance_id', id)
      .select('id');
    if (error) throw error;
    const reaped = data?.length ?? 0;
    if (reaped) console.log(`[JobRunner] reaped ${reaped} orphaned run(s) from a previous boot`);
    return { reaped };
  } catch (err) {
    console.error(`[JobRunner] orphan reap failed: ${err.message}`);
    return { reaped: 0, error: err.message };
  }
}

/**
 * On SIGTERM, close this process's in-flight rows as `interrupted` — not
 * `failed`. A deploy is not a defect (src/sync-log.js:56-70).
 */
export async function markActiveInterrupted(deps = {}) {
  const client = db(deps);
  const ids = [...activeRunIds];
  if (!client || ids.length === 0) return { marked: 0 };
  activeRunIds.clear();
  try {
    const { error } = await client
      .from('job_runs')
      .update({
        status: JOB_STATUS.INTERRUPTED,
        summary: 'process shut down while this pass was in flight',
        finished_at: new Date((deps.now || (() => Date.now()))()).toISOString(),
      })
      .in('id', ids);
    if (error) throw error;
    return { marked: ids.length };
  } catch (err) {
    console.error(`[JobRunner] could not mark ${ids.length} run(s) interrupted: ${err.message}`);
    return { marked: 0, error: err.message };
  }
}

/** Drop history older than the retention window. Cheap, indexed on started_at. */
export async function pruneOldRuns(deps = {}) {
  const client = db(deps);
  if (!client) return { pruned: 0 };
  const days = deps.retentionDays ?? PRUNE_AFTER_DAYS;
  const cutoff = new Date((deps.now || (() => Date.now()))() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { error } = await client.from('job_runs').delete().lt('started_at', cutoff);
    if (error) throw error;
    return { pruned: true, cutoff };
  } catch (err) {
    console.error(`[JobRunner] prune failed: ${err.message}`);
    return { pruned: false, error: err.message };
  }
}

let pruneTimer = null;

/**
 * Boot wiring: register the roster, reap orphans from the last boot, arm the
 * shutdown hook and the daily prune. Safe to call once from app.listen.
 */
export async function startJobRunner(jobs, deps = {}) {
  await registerJobs(jobs, deps);
  await reapOrphanRuns(deps);

  onShutdown(async () => {
    await markActiveInterrupted(deps);
  });

  if (!pruneTimer) {
    pruneTimer = setInterval(() => {
      pruneOldRuns(deps).catch(() => {});
    }, 24 * 60 * 60 * 1000);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  }
}

/** TESTS ONLY. */
export function __resetJobRunnerForTests() {
  activeRunIds.clear();
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}
