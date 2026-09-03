/**
 * scripts/test-job-upsert-error.js — job-upsert failure surfacing
 *
 * REGRESSION UNDER TEST (2026-09-03): a failed lp_jobs upsert never reached
 * lp_sync_errors. supabase-js RESOLVES with { error } rather than throwing, so
 * syncJobAndMilestones logged the failure and returned normally, and
 * runJobChangesSweep's try/catch never fired — it incremented counts.jobs and
 * left `failed` at 0. get_sync_health therefore reported 104 jobs / 0 failures
 * on the same sweep that dropped job 57771 (a $19,595 sale, install in
 * progress) and job 58260, both rejected by lp_jobs_lp_lead_id_fkey because
 * their parent leads (531457, 540081) were never synced into lp_leads.
 *
 * These cover the shaping helpers the sweep now branches on. They are pure, so
 * they run with no SUPABASE_URL and no network.
 *
 * Run: node --test scripts/test-job-upsert-error.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJobUpsertError,
  describeJobUpsertError,
  PG_FK_VIOLATION,
  getJobParentHealMode,
  getJobParentHealBudget,
  shouldHealParent,
} from '../src/job-upsert-error.js';

// The exact error supabase-js returned for job 57771 on 2026-09-03.
const REAL_FK_ERROR = {
  code: '23503',
  message: 'insert or update on table "lp_jobs" violates foreign key constraint "lp_jobs_lp_lead_id_fkey"',
  details: 'Key (lp_lead_id)=(531457) is not present in table "lp_leads".',
  hint: '',
};

test('a successful upsert produces no error object', () => {
  assert.equal(buildJobUpsertError('57771', '531457', null), null);
  assert.equal(buildJobUpsertError('57771', '531457', undefined), null);
  assert.equal(describeJobUpsertError(null), '');
});

test('the real FK violation is captured and flagged as a missing parent', () => {
  const e = buildJobUpsertError('57771', '531457', REAL_FK_ERROR);
  assert.equal(e.jobId, '57771');
  assert.equal(e.lpLeadId, '531457');
  assert.equal(e.code, PG_FK_VIOLATION);
  assert.equal(e.missingParent, true);
  assert.match(e.details, /531457/);
});

test('non-FK failures are captured but NOT flagged as missing parent', () => {
  // Only 23503 is fixable by creating the parent lead; everything else needs a
  // human. The self-heal path keys on this flag, so a false positive there
  // would mean inventing lead rows for permission and constraint errors.
  for (const code of ['42501', '23505', '22P02', '08006', 'none']) {
    const e = buildJobUpsertError('1', '2', { code, message: 'x' });
    assert.equal(e.missingParent, false, `code ${code} must not be missingParent`);
  }
  const noCode = buildJobUpsertError('1', '2', { message: 'connection reset' });
  assert.equal(noCode.code, 'none');
  assert.equal(noCode.missingParent, false);
});

test('ids are normalised to strings — lp_sync_errors columns are text', () => {
  const e = buildJobUpsertError(57771, 531457, REAL_FK_ERROR);
  assert.equal(e.jobId, '57771');
  assert.equal(e.lpLeadId, '531457');
  const missing = buildJobUpsertError(null, null, REAL_FK_ERROR);
  assert.equal(missing.jobId, null);
  assert.equal(missing.lpLeadId, null);
});

test('the logged message identifies job, lead, code and cause', () => {
  const msg = describeJobUpsertError(buildJobUpsertError('57771', '531457', REAL_FK_ERROR));
  // Everything needed to find the record without opening a deploy log.
  assert.match(msg, /Job 57771/);
  assert.match(msg, /lead 531457/);
  assert.match(msg, /23503/);
  assert.match(msg, /parent lead absent from lp_leads/);
});

test('a non-FK failure message omits the missing-parent clause', () => {
  const msg = describeJobUpsertError(
    buildJobUpsertError('99', '88', { code: '42501', message: 'permission denied' }),
  );
  assert.match(msg, /permission denied/);
  assert.doesNotMatch(msg, /parent lead absent/);
});

test('missing details/hint do not produce dangling separators', () => {
  const msg = describeJobUpsertError(
    buildJobUpsertError('99', '88', { code: '42501', message: 'permission denied' }),
  );
  assert.doesNotMatch(msg, /—\s*$/);
  assert.doesNotMatch(msg, /——/);
});

// ─── Parent-lead self-heal gate (v1.1) ───────────────────────────
// The heal path WRITES a lead row and costs an LP call, so the gate is the
// safety boundary: wrong-mode, wrong-error-code, or unbounded volume all have
// to be impossible here.

const FK_ERR = buildJobUpsertError('57771', '531457', REAL_FK_ERROR);

test('heal mode defaults to off and rejects unknown values', () => {
  assert.equal(getJobParentHealMode({}), 'off');
  assert.equal(getJobParentHealMode({ LP_JOB_PARENT_HEAL_MODE: '' }), 'off');
  assert.equal(getJobParentHealMode({ LP_JOB_PARENT_HEAL_MODE: 'on' }), 'off');
  assert.equal(getJobParentHealMode({ LP_JOB_PARENT_HEAL_MODE: 'true' }), 'off');
  assert.equal(getJobParentHealMode({ LP_JOB_PARENT_HEAL_MODE: ' SHADOW ' }), 'shadow');
  assert.equal(getJobParentHealMode({ LP_JOB_PARENT_HEAL_MODE: 'live' }), 'live');
});

test('off mode never heals, whatever the error', () => {
  assert.equal(shouldHealParent(FK_ERR, 'off', 0, 25), false);
  assert.equal(shouldHealParent(FK_ERR, 'nonsense', 0, 25), false);
});

test('shadow and live both pass the gate on a real missing parent', () => {
  assert.equal(shouldHealParent(FK_ERR, 'shadow', 0, 25), true);
  assert.equal(shouldHealParent(FK_ERR, 'live', 0, 25), true);
});

test('ONLY a missing parent is healable — never another failure', () => {
  // Creating a lead cannot fix a permission or constraint error, and writing a
  // row in response to one would be inventing data.
  for (const code of ['42501', '23505', '22P02', '08006', 'none']) {
    const e = buildJobUpsertError('1', '531457', { code, message: 'x' });
    assert.equal(shouldHealParent(e, 'live', 0, 25), false, `code ${code} must not heal`);
  }
  assert.equal(shouldHealParent(null, 'live', 0, 25), false);
  assert.equal(shouldHealParent(undefined, 'live', 0, 25), false);
});

test('an unusable lead id never reaches the LP fetch', () => {
  for (const bad of [null, undefined, '', 'abc', '12a', ' 531457', '531457 ']) {
    const e = { ...FK_ERR, lpLeadId: bad };
    assert.equal(shouldHealParent(e, 'live', 0, 25), false, `id ${JSON.stringify(bad)} must not heal`);
  }
});

test('the per-sweep budget is enforced at the boundary', () => {
  assert.equal(shouldHealParent(FK_ERR, 'live', 24, 25), true);   // last allowed
  assert.equal(shouldHealParent(FK_ERR, 'live', 25, 25), false);  // spent
  assert.equal(shouldHealParent(FK_ERR, 'live', 99, 25), false);
  assert.equal(shouldHealParent(FK_ERR, 'live', 0, 0), false);    // zero budget disables
});

test('budget parses with a sane default and rejects junk', () => {
  assert.equal(getJobParentHealBudget({}), 25);
  assert.equal(getJobParentHealBudget({ LP_JOB_PARENT_HEAL_MAX_PER_SWEEP: '100' }), 100);
  assert.equal(getJobParentHealBudget({ LP_JOB_PARENT_HEAL_MAX_PER_SWEEP: '1' }), 1);
  for (const junk of ['0', '-5', 'abc', '']) {
    assert.equal(getJobParentHealBudget({ LP_JOB_PARENT_HEAL_MAX_PER_SWEEP: junk }), 25, `junk ${junk}`);
  }
});
