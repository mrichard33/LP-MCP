/**
 * test-job-runner.js — job run history (2026-09-16).
 *
 * THE DEFECT THIS GUARDS. ~44 scheduled jobs kept their last result in a
 * module-level variable that Railway wipes on every deploy, so "did the nightly
 * job run last night, and did it work?" had no answer at all.
 *
 * The trap in building the fix is that MOST OF THESE JOBS NEVER THROW. They
 * catch everything internally and report failure in the return value —
 * runMemoryNightly wraps all ten of its steps and returns { ok:false, errors },
 * runWorkflowProjection returns { success:false, error }, and
 * checkLpReportFreshness returns { checked:false } when it could not read at
 * all. A wrapper built on try/catch alone would file every one of those as a
 * success, producing a more convincing version of the blind spot it was meant
 * to remove. Most of what is asserted here is that classifyResult reads the
 * VALUE, not just the absence of an exception.
 *
 * The other half is the sync-log.js lesson (src/sync-log.js:56-70): a pass
 * killed by a deploy is `interrupted`, never `failed`, and cleanup is scoped to
 * this process's own rows so two replicas cannot bury each other's work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOB_STATUS,
  activeRunIds,
  classifyResult,
  describe as describeResult,
  markActiveInterrupted,
  pruneOldRuns,
  reapOrphanRuns,
  registerJobs,
  runJob,
  isOccurrenceTaken,
  __resetJobRunnerForTests,
} from '../src/job-runner.js';
import { JOBS, JOB_IDS } from '../src/job-registry.js';

// ─── A minimal PostgREST-shaped fake ────────────────────────────────────────
// Chainable and awaitable at any point, like the real client. Records every
// call so the assertions can look at exactly what would have been written.

function fakeDb({ failInsert = false, failUpdate = false, failUpsert = false, insertError = null, nextId = 1 } = {}) {
  const calls = { insert: [], update: [], upsert: [], delete: [] };
  let idSeq = nextId;

  const chain = (table, kind, payload) => {
    const state = { table, kind, payload, filters: [] };
    const settle = async () => {
      if (kind === 'insert') {
        if (insertError) return { data: null, error: insertError };
        if (failInsert) return { data: null, error: { message: 'insert boom' } };
        const id = idSeq++;
        calls.insert.push({ table, payload, id });
        return { data: { id }, error: null };
      }
      if (kind === 'update') {
        if (failUpdate) return { data: null, error: { message: 'update boom' } };
        calls.update.push({ table, payload, filters: state.filters });
        return { data: [], error: null };
      }
      if (kind === 'upsert') {
        if (failUpsert) return { data: null, error: { message: 'upsert boom' } };
        calls.upsert.push({ table, payload, options: state.options });
        return { data: null, error: null };
      }
      calls.delete.push({ table, filters: state.filters });
      return { data: null, error: null };
    };
    const api = {
      eq(c, v) { state.filters.push(['eq', c, v]); return api; },
      in(c, v) { state.filters.push(['in', c, v]); return api; },
      lt(c, v) { state.filters.push(['lt', c, v]); return api; },
      select() { return api; },
      single() { return api; },
      then(resolve, reject) { return settle().then(resolve, reject); },
    };
    state.api = api;
    return api;
  };

  return {
    calls,
    from(table) {
      return {
        insert: (payload) => chain(table, 'insert', payload),
        update: (payload) => chain(table, 'update', payload),
        delete: () => chain(table, 'delete', null),
        upsert: (payload, options) => {
          const api = chain(table, 'upsert', payload);
          // options ride along so the onConflict assertion can see them
          api.__options = options;
          calls.upsertOptions = options;
          return api;
        },
      };
    },
  };
}

const deps = (db, extra = {}) => ({ supabase: db, instanceId: 'test-host', ...extra });
const lastUpdate = (db) => db.calls.update.at(-1)?.payload ?? {};

test.beforeEach(() => __resetJobRunnerForTests());

// ─── classifyResult — the trap ──────────────────────────────────────────────

test('a job that throws is failed', () => {
  const r = classifyResult(undefined, new Error('SOAP fault: boom'));
  assert.equal(r.status, JOB_STATUS.FAILED);
  assert.match(r.summary, /SOAP fault: boom/);
});

test('a job that returns ok:false WITHOUT throwing is failed, not ok', () => {
  // This is runMemoryNightly's real shape. The whole table is worthless if
  // this records `ok`.
  const r = classifyResult({ ok: false, errors: ['autoclose failed', 'digest failed'] }, null);
  assert.equal(r.status, JOB_STATUS.FAILED);
  assert.match(r.summary, /autoclose failed; digest failed/);
});

test('a job that returns success:false without throwing is failed', () => {
  // runWorkflowProjection's shape.
  const r = classifyResult({ success: false, error: 'supabase unreachable', scanned: 0 }, null);
  assert.equal(r.status, JOB_STATUS.FAILED);
  assert.match(r.summary, /supabase unreachable/);
});

test('a re-entrancy guard declining to start is skipped, not failed', () => {
  const r = classifyResult({ skipped: true, reason: 'previous pass still running' }, null);
  assert.equal(r.status, JOB_STATUS.SKIPPED);
  assert.match(r.summary, /previous pass still running/);
});

test('a job that could not tell is unknown, never ok', () => {
  // checkLpReportFreshness returns { checked:false } when supabase is null.
  assert.equal(classifyResult({ checked: false }, null).status, JOB_STATUS.UNKNOWN);
  assert.equal(classifyResult({ readFailed: true, missing: [] }, null).status, JOB_STATUS.UNKNOWN);
});

test('an explicit ok:false outranks a partial-read hint', () => {
  // The job made a definite claim about its own outcome. That wins.
  const r = classifyResult({ ok: false, readFailed: true, error: 'three of four reads failed' }, null);
  assert.equal(r.status, JOB_STATUS.FAILED);
});

test('a healthy return is ok, and a void return is ok', () => {
  assert.equal(classifyResult({ ok: true, projected: 12 }, null).status, JOB_STATUS.OK);
  assert.equal(classifyResult(undefined, null).status, JOB_STATUS.OK);
  assert.equal(classifyResult(null, null).status, JOB_STATUS.OK);
});

test('checked:true is a real check and stays ok', () => {
  const r = classifyResult({ checked: true, missing: [], unarmed: [] }, null);
  assert.equal(r.status, JOB_STATUS.OK);
});

test('describe summarises counters without dumping the object', () => {
  assert.equal(describeResult({ summary: 'said it itself' }), 'said it itself');
  assert.match(describeResult({ scanned: 40, projected: 12, elapsed_ms: 900 }), /scanned=40 projected=12/);
  assert.doesNotMatch(describeResult({ scanned: 40, elapsed_ms: 900 }), /elapsed_ms/);
  assert.equal(describeResult(undefined), 'completed');
});

// ─── runJob — end to end against the fake ───────────────────────────────────

test('a healthy pass opens a running row and closes it ok with timing', async () => {
  const db = fakeDb();
  let t = 1_000;
  const out = await runJob('demo', async () => ({ ok: true, projected: 3 }), deps(db, { now: () => (t += 250) }));

  assert.equal(out.status, JOB_STATUS.OK);
  assert.equal(db.calls.insert.length, 1);
  assert.equal(db.calls.insert[0].payload.job_id, 'demo');
  assert.equal(db.calls.insert[0].payload.status, JOB_STATUS.RUNNING);
  assert.equal(db.calls.insert[0].payload.instance_id, 'test-host');

  const closed = lastUpdate(db);
  assert.equal(closed.status, JOB_STATUS.OK);
  assert.equal(closed.elapsed_ms, 250);
  assert.deepEqual(closed.detail, { ok: true, projected: 3 });
  assert.ok(closed.finished_at);
});

test('a throwing job is recorded failed and the error never escapes to the scheduler', async () => {
  const db = fakeDb();
  const out = await runJob('demo', async () => { throw new Error('kaboom'); }, deps(db));
  assert.equal(out.status, JOB_STATUS.FAILED);
  assert.equal(lastUpdate(db).status, JOB_STATUS.FAILED);
  assert.match(lastUpdate(db).summary, /kaboom/);
});

test('the never-throws job is recorded failed end to end', async () => {
  const db = fakeDb();
  await runJob('memory-nightly', async () => ({ ok: false, errors: ['step 4 failed'] }), deps(db));
  assert.equal(lastUpdate(db).status, JOB_STATUS.FAILED);
  assert.match(lastUpdate(db).summary, /step 4 failed/);
});

test('losing the log row does not lose the job', async () => {
  const db = fakeDb({ failInsert: true });
  let ran = false;
  const out = await runJob('demo', async () => { ran = true; return { ok: true }; }, deps(db));
  assert.equal(ran, true, 'the job must still run when its row cannot be opened');
  assert.equal(out.status, JOB_STATUS.OK);
  assert.equal(db.calls.update.length, 0, 'nothing to close when nothing was opened');
});

test('failing to close the row does not throw at the scheduler', async () => {
  const db = fakeDb({ failUpdate: true });
  const out = await runJob('demo', async () => ({ ok: true }), deps(db));
  assert.equal(out.status, JOB_STATUS.OK);
});

test('a finished run is no longer tracked as in flight', async () => {
  const db = fakeDb();
  await runJob('demo', async () => ({ ok: true }), deps(db));
  assert.equal(activeRunIds.size, 0);
});

test('an unserialisable return still records a status', async () => {
  const db = fakeDb();
  const cyclic = { ok: true };
  cyclic.self = cyclic;
  const out = await runJob('demo', async () => cyclic, deps(db));
  assert.equal(out.status, JOB_STATUS.OK);
  assert.deepEqual(lastUpdate(db).detail, { unserializable: true });
});

test('with no supabase the job still runs and nothing is written', async () => {
  let ran = false;
  const out = await runJob('demo', async () => { ran = true; return { ok: true }; }, { supabase: null });
  assert.equal(ran, true);
  assert.equal(out.status, JOB_STATUS.OK);
});

// ─── The occurrence claim (sql/114) ─────────────────────────────────────────
// The six daily jobs guard themselves with a module-level date claimed before
// awaiting. That works inside one process and is worth nothing across two: each
// replica has its own copy of the variable, both see "not run today", and both
// run. The database is the only thing that can arbitrate.

test('an occurrence key is written with the run', async () => {
  const db = fakeDb();
  await runJob('memory-nightly', async () => ({ ok: true }), deps(db, { occurrence: '2026-09-16' }));
  assert.equal(db.calls.insert[0].payload.occurrence_key, '2026-09-16');
});

test('an interval job stores no occurrence and is never blocked', async () => {
  const db = fakeDb();
  await runJob('capacity-sweep-fast', async () => ({ ok: true }), deps(db));
  assert.equal(db.calls.insert[0].payload.occurrence_key, null);
});

test('losing the claim SKIPS without running the job — the whole point', async () => {
  const db = fakeDb({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "uq_job_runs_job_occurrence"' } });
  let ran = false;
  const out = await runJob('memory-nightly', async () => { ran = true; return { ok: true }; },
    deps(db, { occurrence: '2026-09-16' }));

  assert.equal(ran, false, 'the job must NOT run when another replica owns the slot');
  assert.equal(out.status, JOB_STATUS.SKIPPED);
  assert.match(out.summary, /2026-09-16/);
  assert.equal(db.calls.update.length, 0, 'nothing to close — no row was opened');
});

test('an insert failure that is NOT a lost claim still runs the job unlogged', async () => {
  // Fail open. A broken log must never cost a nightly pass.
  const db = fakeDb({ insertError: { code: '08006', message: 'connection failure' } });
  let ran = false;
  const out = await runJob('memory-nightly', async () => { ran = true; return { ok: true }; },
    deps(db, { occurrence: '2026-09-16' }));
  assert.equal(ran, true);
  assert.equal(out.status, JOB_STATUS.OK);
});

test('isOccurrenceTaken recognises the violation by code and by message', () => {
  assert.equal(isOccurrenceTaken({ code: '23505' }), true);
  assert.equal(isOccurrenceTaken({ message: 'duplicate key value violates unique constraint' }), true);
  // Everything else is an ordinary error and must fail open.
  assert.equal(isOccurrenceTaken({ code: '08006', message: 'connection failure' }), false);
  assert.equal(isOccurrenceTaken(null), false);
  assert.equal(isOccurrenceTaken({}), false);
});

test('a run is closed only by the replica that opened it', async () => {
  // A slow process must not write a terminal result over a row another replica
  // has since taken responsibility for.
  const db = fakeDb();
  await runJob('demo', async () => ({ ok: true }), deps(db));
  assert.deepEqual(db.calls.update.at(-1).filters, [
    ['eq', 'id', 1],
    ['eq', 'instance_id', 'test-host'],
  ]);
});

// ─── Registry, reaping, shutdown, prune ─────────────────────────────────────

test('registerJobs upserts the whole roster keyed on job_id', async () => {
  const db = fakeDb();
  const res = await registerJobs(JOBS, deps(db));
  assert.equal(res.registered, JOBS.length);
  assert.equal(db.calls.upsertOptions.onConflict, 'job_id');

  const rows = db.calls.upsert[0].payload;
  assert.equal(rows.length, JOBS.length);
  const memory = rows.find((r) => r.job_id === 'memory-nightly');
  assert.equal(memory.label, 'Memory nightly');
  assert.equal(memory.job_group, 'memory');
  assert.equal(memory.enabled_env, 'MEMORY_NIGHTLY_ENABLED');
  assert.equal(memory.enabled_default, true);

  // A job that is off by default must say so, or the UI will call it stale.
  const five9 = rows.find((r) => r.job_id === 'five9-config-snapshot');
  assert.equal(five9.enabled_default, false);
});

test('the gate is resolved at boot, because the dashboard cannot read this env', async () => {
  const db = fakeDb();
  await registerJobs(JOBS, deps(db, { env: { FIVE9_CONFIG_SNAPSHOT_ENABLED: 'true', MEMORY_NIGHTLY_ENABLED: 'false' } }));
  const rows = db.calls.upsert[0].payload;
  const byId = Object.fromEntries(rows.map((r) => [r.job_id, r]));

  // Switched on by env despite shipping dark.
  assert.equal(byId['five9-config-snapshot'].enabled, true);
  assert.equal(byId['five9-config-snapshot'].enabled_default, false);
  // Switched off by env despite defaulting on — must read disabled, not stale.
  assert.equal(byId['memory-nightly'].enabled, false);
  assert.equal(byId['memory-nightly'].enabled_default, true);
  // Ungated jobs are always enabled.
  assert.equal(byId['capacity-sweep-fast'].enabled, true);
});

test('every gate mirrors its own module, including the inverted and mode ones', () => {
  const gate = (id) => JOBS.find((j) => j.id === id).isEnabled;
  // LP_REPORT_WATCHDOG_DISABLED is inverted: any non-empty value disables.
  assert.equal(gate('lp-report-watchdog')({}), true);
  assert.equal(gate('lp-report-watchdog')({ LP_REPORT_WATCHDOG_DISABLED: '1' }), false);
  // OMI_PULL_MODE is a mode, not a boolean, and ships off.
  assert.equal(gate('omi-pull')({}), false);
  assert.equal(gate('omi-pull')({ OMI_PULL_MODE: 'live' }), true);
  assert.equal(gate('omi-pull')({ OMI_PULL_MODE: 'off' }), false);
  // The ordinary default-on shape.
  assert.equal(gate('source-reconcile')({}), true);
  assert.equal(gate('source-reconcile')({ SOURCE_RECONCILE_ENABLED: 'false' }), false);
});

test('a missing sql/113 does not take the boot down', async () => {
  const db = fakeDb({ failUpsert: true });
  const res = await registerJobs(JOBS, deps(db));
  assert.equal(res.registered, 0);
  assert.match(res.error, /upsert boom/);
});

test('orphan reaping is scoped to this host and only to running rows', async () => {
  const db = fakeDb();
  await reapOrphanRuns(deps(db));
  const call = db.calls.update.at(-1);
  assert.equal(call.payload.status, JOB_STATUS.INTERRUPTED);
  assert.deepEqual(call.filters, [
    ['eq', 'status', JOB_STATUS.RUNNING],
    ['eq', 'instance_id', 'test-host'],
  ]);
});

test('shutdown marks in-flight runs interrupted, not failed', async () => {
  // A deploy is infrastructure, not a defect — src/sync-log.js:56-70.
  const db = fakeDb();
  activeRunIds.add(41);
  activeRunIds.add(42);
  const res = await markActiveInterrupted(deps(db));

  assert.equal(res.marked, 2);
  const call = db.calls.update.at(-1);
  assert.equal(call.payload.status, JOB_STATUS.INTERRUPTED);
  assert.notEqual(call.payload.status, JOB_STATUS.FAILED);
  assert.deepEqual(call.filters, [['in', 'id', [41, 42]]]);
  assert.equal(activeRunIds.size, 0);
});

test('shutdown with nothing in flight writes nothing', async () => {
  const db = fakeDb();
  const res = await markActiveInterrupted(deps(db));
  assert.equal(res.marked, 0);
  assert.equal(db.calls.update.length, 0);
});

test('prune deletes by the retention cutoff', async () => {
  const db = fakeDb();
  const now = Date.parse('2026-09-16T00:00:00Z');
  await pruneOldRuns(deps(db, { now: () => now, retentionDays: 90 }));
  const call = db.calls.delete.at(-1);
  assert.equal(call.filters[0][0], 'lt');
  assert.equal(call.filters[0][1], 'started_at');
  assert.equal(call.filters[0][2], '2026-06-18T00:00:00.000Z');
});

// ─── The roster itself ──────────────────────────────────────────────────────

test('the roster is unique, complete and shaped', () => {
  assert.equal(new Set(JOB_IDS).size, JOB_IDS.length, 'job ids must be unique');
  // Bump this when you add a job — the count is here so an accidental DELETION
  // is caught too, which a "shape of each row" loop cannot see.
  // 13 → 14 on 2026-09-18: link-leak-monitor.
  assert.equal(JOBS.length, 14);
  for (const j of JOBS) {
    assert.match(j.id, /^[a-z0-9-]+$/, `${j.id} should be a slug`);
    assert.ok(j.label && j.group && j.cadence, `${j.id} needs a label, group and cadence`);
    assert.equal(typeof j.enabledDefault, 'boolean');
    assert.equal(typeof j.isEnabled, 'function', `${j.id} needs a resolvable gate`);
  }
});

test('the two per-minute heartbeats are deliberately not instrumented', () => {
  // A row a minute each is ~2,900 rows a day carrying no signal that the
  // dedicated /heartbeat-status endpoints do not already provide.
  assert.ok(!JOB_IDS.includes('decision-engine-heartbeat'));
  assert.ok(!JOB_IDS.includes('executor-heartbeat'));
});
