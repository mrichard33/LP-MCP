/**
 * scripts/test-lp-job-fields.js
 *
 * Unit coverage for mapJobFields() / mapMilestoneChangeFields() — the derivation
 * that fills the ten lp_jobs columns that sat at 100% null across 5,889 rows.
 *
 * The risk this file exists to catch is NOT a crash. It is a mapper that reads
 * `estdate` instead of `actdate`, or 'Install End' instead of 'Start', and writes a
 * plausible-looking wrong date that no count-based check would ever flag. Every
 * fixture below is shaped from a real production payload.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-lp-job-fields.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapJobFields, mapMilestoneChangeFields } from '../src/lp-job-fields.js';

// Fixed reference: 2026-08-31, the day the mapping was measured.
const NOW = new Date('2026-08-31T12:00:00Z');

/** LP sends every milestone slot for every job; unset fields are "", never null. */
function milestone(mdt_id, datetype, { actdate = '', estdate = '', lastchangedby = '', lastchangedon = '' } = {}) {
  return { id: '56785', mdt_id, datetype, actdate, acttime: '', estdate,
           enteredby: '', enteredon: '', lastchangedby, lastchangedon };
}

function userfield(fieldtitle, fieldvalue) {
  return { fldnumber: '1', fieldtitle, fieldvalue };
}

/** Shape A — /api/Customers/GetJobStatusChanges. Carries lastchanged, no finco. */
function shapeA(overrides = {}) {
  return {
    job_id: '56785', lds_id: '999', jobstatus: 'Paid In Full',
    salesrepid: '3442', salesrepname: 'Sanders, Michael',
    entrydate: '2025-08-20T00:00:00', dateentered: '2025-08-20T14:03:11.21',
    lastchanged: '2026-02-28T16:45:41.287', stg_id: '0',
    milestones: [], userfields: [],
    ...overrides,
  };
}

/** Shape B — /api/Customers/GetLead nested jobs[]. Carries finco, no lastchanged. */
function shapeB(overrides = {}) {
  return {
    id: '46112', jobstatus: 'Paid In Full',
    salesrepid: '4437', salesrepname: 'Woodby, Melisa',
    finamount: '0.00', finco: '', fincrlimit: '0.00', finmonths: '0', finfee: '0.00',
    milestones: [], userfields: [],
    ...overrides,
  };
}

// ─── The estdate trap ────────────────────────────────────────────────

test('empty-string actdate maps to null, never epoch', () => {
  const f = mapJobFields(shapeA({ milestones: [milestone('S', 'Start', { actdate: '', estdate: '2026-09-01T00:00:00' })] }), {}, NOW);
  assert.equal(f.install_date, null);
});

test('estdate is never read for install_date, even when actdate is empty', () => {
  const job = shapeA({ milestones: [milestone('S', 'Start', { actdate: '', estdate: '2027-03-16T00:00:00' })] });
  const f = mapJobFields(job, {}, NOW);
  assert.equal(f.install_date, null);
  // The whole failure mode: a populated column full of forecasts.
  assert.ok(!JSON.stringify(f).includes('2027-03-16'));
});

test('when both dates exist, install_date takes actdate and not estdate', () => {
  const f = mapJobFields(shapeA({
    milestones: [milestone('S', 'Start', { actdate: '2026-02-26T00:00:00', estdate: '2026-03-08T00:00:00' })],
  }), {}, NOW);
  assert.equal(f.install_date, '2026-02-26T00:00:00+00:00');
});

// ─── Milestone code selection ────────────────────────────────────────

test('S feeds install_date and F feeds install_completed_date, not the reverse', () => {
  const f = mapJobFields(shapeA({
    milestones: [
      milestone('S', 'Start',       { actdate: '2026-01-10T00:00:00' }),
      milestone('F', 'Install End', { actdate: '2026-01-14T00:00:00' }),
    ],
  }), {}, NOW);
  assert.equal(f.install_date,           '2026-01-10T00:00:00+00:00');
  assert.equal(f.install_completed_date, '2026-01-14T00:00:00+00:00');
});

test("'Completion' (C) does not populate install_completed_date", () => {
  // C has an actual date on 3,204 of 3,230 Paid In Full jobs vs F's 2,127, so a
  // mapper reaching for coverage would grab it. It is a different event.
  const f = mapJobFields(shapeA({
    milestones: [milestone('C', 'Completion', { actdate: '2026-01-20T00:00:00' })],
  }), {}, NOW);
  assert.equal(f.install_completed_date, null);
  assert.equal(f.job_stage, 'complete');
});

test('permit_status reads issued over submitted', () => {
  const submitted = mapJobFields(shapeA({
    milestones: [milestone('U', 'Permit Submit', { actdate: '2026-01-02T00:00:00' })],
  }), {}, NOW);
  assert.equal(submitted.permit_status, 'submitted');

  const issued = mapJobFields(shapeA({
    milestones: [
      milestone('U', 'Permit Submit', { actdate: '2026-01-02T00:00:00' }),
      milestone('P', 'Permit Issued', { actdate: '2026-01-09T00:00:00' }),
    ],
  }), {}, NOW);
  assert.equal(issued.permit_status, 'issued');
});

test('job_stage derives the schema vocabulary from milestone codes', () => {
  const stageOf = (codes) => mapJobFields(shapeA({
    milestones: codes.map(c => milestone(c, c, { actdate: '2026-01-02T00:00:00' })),
  }), {}, NOW).job_stage;

  assert.equal(stageOf(['U']),           'permit');
  assert.equal(stageOf(['H']),           'permit');
  assert.equal(stageOf(['U', 'K']),      'production');
  assert.equal(stageOf(['K', 'S']),      'install');
  assert.equal(stageOf(['S', 'F']),      'complete');
  assert.equal(stageOf([]),              null);
});

test('job_stage ignores stg_id entirely', () => {
  // stg_id is "0" on 3,534 of 3,583 Shape A rows — no stage information at all.
  const f = mapJobFields(shapeA({ stg_id: '7', milestones: [] }), {}, NOW);
  assert.equal(f.job_stage, null);
});

// ─── One-directional booleans ────────────────────────────────────────

test('hoa_required is true on evidence and null — never false — without it', () => {
  const withHoa = mapJobFields(shapeA({
    milestones: [milestone('H', 'HOA Approved', { actdate: '2026-01-02T00:00:00' })],
  }), {}, NOW);
  assert.equal(withHoa.hoa_required, true);

  const without = mapJobFields(shapeA({
    milestones: [milestone('H', 'HOA Approved', { actdate: '', estdate: '2023-12-04T00:00:00' })],
  }), {}, NOW);
  assert.equal(without.hoa_required, null);
  assert.notEqual(without.hoa_required, false);
});

test('permit_required matches the trailing-space "Permit Expiration " title', () => {
  // LP ships the title with a trailing space. An exact match returns nothing and
  // the column stays silently null on 1,507 rows.
  const f = mapJobFields(shapeA({
    userfields: [userfield('Permit Expiration ', '2026-08-13T00:00:00')],
  }), {}, NOW);
  assert.equal(f.permit_required, true);
});

test('permit_required matches Permit Location and stays null when values are empty', () => {
  const located = mapJobFields(shapeA({
    userfields: [userfield('Permit Location', ' Charlotte County')],
  }), {}, NOW);
  assert.equal(located.permit_required, true);

  const blank = mapJobFields(shapeA({
    userfields: [userfield('Permit Location', ''), userfield('Permit Expiration ', '')],
  }), {}, NOW);
  assert.equal(blank.permit_required, null);
});

// ─── updated_at_lp: the key that never existed ───────────────────────

test('updated_at_lp reads lastchanged', () => {
  const f = mapJobFields(shapeA(), {}, NOW);
  assert.equal(f.updated_at_lp, '2026-02-28T16:45:41.287+00:00');
});

test('lastchangedon is NOT a job-level key and must not populate updated_at_lp', () => {
  // The original bug: getField(job, 'lastchangedon', ...) against a payload that
  // has no such key. It appears only inside milestone objects.
  const job = shapeA();
  delete job.lastchanged;
  job.lastchangedon = '2026-02-28T16:45:41.287';
  const f = mapJobFields(job, {}, NOW);
  assert.ok(!('updated_at_lp' in f));
});

// ─── Sparse vs always-written ────────────────────────────────────────

test('shape-scoped keys are omitted, not nulled, when the payload lacks them', () => {
  const b = mapJobFields(shapeB(), {}, NOW);
  assert.ok(!('updated_at_lp' in b), 'Shape B must not blank updated_at_lp');

  const a = mapJobFields(shapeA(), {}, NOW);
  assert.ok(!('financing_company' in a), 'Shape A must not blank financing_company');
});

test('always-written keys are present as explicit nulls so they track reality', () => {
  const f = mapJobFields(shapeB(), {}, NOW);
  for (const key of ['job_stage', 'install_date', 'install_completed_date',
                     'permit_status', 'hoa_required', 'permit_required',
                     'financing_status', 'rep_id']) {
    assert.ok(key in f, `${key} must always be written`);
  }
});

test('both payload shapes map without throwing', () => {
  assert.doesNotThrow(() => mapJobFields(shapeA(), {}, NOW));
  assert.doesNotThrow(() => mapJobFields(shapeB(), {}, NOW));
  assert.doesNotThrow(() => mapJobFields({}, {}, NOW));
});

// ─── financing_status: precedence and recomputation ──────────────────

test('finance block outranks a contradictory job_status', () => {
  const f = mapJobFields(shapeB({ finco: 'Medallion', jobstatus: 'Credit Decline' }), {}, NOW);
  assert.equal(f.financing_status, 'financed');
});

test('finamount > 0 alone is financing evidence', () => {
  const f = mapJobFields(shapeB({ finamount: '3325.00' }), {}, NOW);
  assert.equal(f.financing_status, 'financed');
});

test('a zeroed finance block is not evidence and falls through to job_status', () => {
  const f = mapJobFields(shapeB({ finamount: '0.00', finco: '', jobstatus: 'Credit Decline' }), {}, NOW);
  assert.equal(f.financing_status, 'declined');
});

test('financing_status is recomputed, never sticky', () => {
  // A job leaves 'Awaiting Loan Docs' when the docs arrive. A fill-nulls-only
  // mapper would freeze it at 'pending' forever.
  const pending = mapJobFields(shapeB({ jobstatus: 'Awaiting Loan Docs' }), {}, NOW);
  assert.equal(pending.financing_status, 'pending');

  const moved = mapJobFields(shapeB({ jobstatus: 'Paid In Full' }),
                             { financing_status: 'pending' }, NOW);
  assert.equal(moved.financing_status, null);
});

test('a Shape A sweep does not downgrade a job already known to be financed', () => {
  // finco is Shape-B-only, so without the persisted column in hand this returns
  // whatever the status implies and the row silently loses 'financed'.
  const f = mapJobFields(shapeA({ jobstatus: 'Paid In Full' }),
                         { financing_company: 'Service Finance' }, NOW);
  assert.equal(f.financing_status, 'financed');
});

// ─── Date corruption ─────────────────────────────────────────────────

test('corrupt future and corrupt past dates drop to null', () => {
  const far = mapJobFields(shapeA({
    milestones: [milestone('S', 'Start', { actdate: '2206-01-23T00:00:00' })],
  }), {}, NOW);
  assert.equal(far.install_date, null);

  const old = mapJobFields(shapeA({
    milestones: [milestone('S', 'Start', { actdate: '1998-04-01T00:00:00' })],
  }), {}, NOW);
  assert.equal(old.install_date, null);
});

test('a legitimately future scheduled install date survives', () => {
  // LP is routinely used to record scheduled actuals; an install booked for next
  // month is exactly what install_date should hold on a Scheduled job.
  const f = mapJobFields(shapeA({
    jobstatus: 'Scheduled',
    milestones: [milestone('S', 'Start', { actdate: '2026-11-12T00:00:00' })],
  }), {}, NOW);
  assert.equal(f.install_date, '2026-11-12T00:00:00+00:00');
});

test('2014 history is kept — the plausible floor is 2005, not 2015', () => {
  // Jobs 2732 and 2695 carry genuine 2014 Start dates on Paid In Full rows.
  const f = mapJobFields(shapeA({
    milestones: [milestone('S', 'Start', { actdate: '2014-06-17T00:00:00' })],
  }), {}, NOW);
  assert.equal(f.install_date, '2014-06-17T00:00:00+00:00');
});

test('a whitespace-only date does not become a bare offset', () => {
  const f = mapJobFields(shapeA({ lastchanged: '   ' }), {}, NOW);
  assert.ok(!('updated_at_lp' in f));
});

// ─── rep_id ──────────────────────────────────────────────────────────

test('rep_id is the salesrepid string, and null when LP omits the key', () => {
  assert.equal(mapJobFields(shapeA(), {}, NOW).rep_id, '3442');
  const shapeC = shapeB();
  delete shapeC.salesrepid;              // LP drops the key when no rep is set
  assert.equal(mapJobFields(shapeC, {}, NOW).rep_id, null);
});

test('rep_id does not fall back to the secondary rep', () => {
  const job = shapeB({ salesrepid2: '9999' });
  delete job.salesrepid;
  assert.equal(mapJobFields(job, {}, NOW).rep_id, null);
});

// ─── Milestone change fields ─────────────────────────────────────────

test('milestone last_changed_by / last_changed_on map from the payload pair', () => {
  const f = mapMilestoneChangeFields(
    milestone('R', 'RTP', { actdate: '2026-02-28T00:00:00',
                            lastchangedby: 'Rochelle, Cayla',
                            lastchangedon: '2026-02-28T16:45:41.287' }), NOW);
  assert.equal(f.last_changed_by, 'Rochelle, Cayla');
  assert.equal(f.last_changed_on, '2026-02-28T16:45:41.287+00:00');
});

test('an untouched milestone slot yields explicit nulls', () => {
  const f = mapMilestoneChangeFields(milestone('H', 'HOA Approved'), NOW);
  assert.deepEqual(f, { last_changed_by: null, last_changed_on: null });
});

test('milestone keys are uniform so the bulk upsert cannot be broken', () => {
  // PostgREST requires every object in a bulk insert to carry the same keys. A
  // sparse return here would fail the batch and drop the whole job's milestones to
  // the per-row fallback on every sync.
  const touched   = mapMilestoneChangeFields(milestone('R', 'RTP', { lastchangedby: 'A', lastchangedon: '2026-01-01T00:00:00' }), NOW);
  const untouched = mapMilestoneChangeFields(milestone('H', 'HOA Approved'), NOW);
  assert.deepEqual(Object.keys(touched).sort(), Object.keys(untouched).sort());
});

test('a future last_changed_on is dropped — it is bad data, not scheduling', () => {
  const f = mapMilestoneChangeFields(
    milestone('R', 'RTP', { lastchangedby: 'Someone', lastchangedon: '2027-01-01T00:00:00' }), NOW);
  assert.equal(f.last_changed_by, 'Someone');
  assert.equal(f.last_changed_on, null);
});
