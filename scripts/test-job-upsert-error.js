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
