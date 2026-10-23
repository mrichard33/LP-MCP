// LP sales reconcile — the pure diff (src/lp-sales-reconcile-rules.js).
// Cases are the 2026-10-23 September gaps against LP 136.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffProspect, jobFingerprint, storedJobFingerprint, rtpDateOf } from '../src/lp-sales-reconcile-rules.js';

const job = (over = {}) => ({
  id: '59999', jobstatus: 'Scheduled', grossamount: '36727.00', contractdate: '2026-09-21T00:00:00',
  milestones: [{ datetype: 'RTP', actdate: '2026-09-25T00:00:00' }, { datetype: 'Measure', actdate: '2026-09-22T00:00:00' }],
  ...over,
});
const lead = (over = {}) => ({
  id: '576185', sold: 'true', entrydate: '2026-09-15T00:00:00', sourcesubdescr: 'HomeBuddy',
  disposition: 'Sale', brn_id: 'FTMYR', jobs: [job()], ...over,
});
const storedLead = (over = {}) => ({
  lp_lead_id: '576185', closed_won: true, lead_source_detail: 'HomeBuddy', disposition_code: 'Sale',
  lp_branch_id: 'FTMYR', lp_deleted_at: null, raw_lp_data: { entrydate: '2026-09-15T00:00:00' }, ...over,
});
const storedJob = (over = {}) => ({
  lp_job_id: '59999', lp_lead_id: '576185', job_status: 'Scheduled', job_value: 36727, lp_deleted_at: null,
  raw_lp_data: job(), ...over,
});

test('RTP date is the latest RTP actual date; an empty actdate is no RTP', () => {
  assert.equal(rtpDateOf(job()), '2026-09-25');
  assert.equal(rtpDateOf(job({ milestones: [{ datetype: 'RTP', actdate: '' }] })), null);
});

test('payload and stored row of the same job fingerprint the same', () => {
  assert.equal(jobFingerprint(job()), storedJobFingerprint(storedJob()));
});

test('an unchanged prospect needs nothing', () => {
  const d = diffProspect({ cst_id: '1', leads: [lead()] }, [storedLead()], [storedJob()]);
  assert.deepEqual(d, { resync: false, reasons: [], deleteJobIds: [], undeleteJobIds: [] });
});

test('a reversed sale (lead 579034): lead back to OPPFDN, job gone in LP → resync and mark the job deleted', () => {
  const d = diffProspect(
    { cst_id: '374711', leads: [lead({ id: '579034', sold: 'false', disposition: 'OPPFDN', jobs: [] })] },
    [storedLead({ lp_lead_id: '579034' })],
    [storedJob({ lp_job_id: '60064', lp_lead_id: '579034' })],
  );
  assert.equal(d.resync, true);
  assert.deepEqual(d.deleteJobIds, ['60064']);
});

test('a sold lead we never synced → resync', () => {
  const d = diffProspect({ cst_id: '9', leads: [lead({ id: '999' })] }, [], []);
  assert.equal(d.resync, true);
  assert.ok(d.reasons.includes('lead_missing:999'));
});

test('a job whose RTP, status or amount changed → resync', () => {
  for (const over of [{ jobstatus: 'Cancelled' }, { grossamount: '30000.00' }, { milestones: [] }]) {
    const d = diffProspect({ cst_id: '1', leads: [lead({ jobs: [job(over)] })] }, [storedLead()], [storedJob()]);
    assert.equal(d.resync, true, JSON.stringify(over));
  }
});

test('a lead with no jobs field decides nothing about its jobs', () => {
  const l = lead(); delete l.jobs;
  const d = diffProspect({ cst_id: '1', leads: [l] }, [storedLead()], [storedJob()]);
  assert.deepEqual(d.deleteJobIds, []);
});

test('a job marked deleted that LP returns again is undeleted', () => {
  const d = diffProspect({ cst_id: '1', leads: [lead()] }, [storedLead()], [storedJob({ lp_deleted_at: '2026-10-23T00:00:00Z' })]);
  assert.deepEqual(d.undeleteJobIds, ['59999']);
});
