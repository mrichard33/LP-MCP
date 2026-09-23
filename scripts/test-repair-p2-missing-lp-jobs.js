// scripts/test-repair-p2-missing-lp-jobs.js
//
// scripts/repair-p2-missing-lp-jobs.js writes lp_leads / lp_jobs rows and puts a
// GHL contact id on each job. The cases that matter are the REFUSALS: a job is
// linked to a contact only when that contact provably names the LP customer, a
// failed read is never "LP has nothing", and a job upsert that RESOLVES with an
// error is counted as a failure, not a success.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRecovery, contactField, prospectFrom, runRepair,
  CONTACT_CF_LP_LEAD_ID, CONTACT_CF_LP_PROSPECT_ID,
} from './repair-p2-missing-lp-jobs.js';

// The shape GetLead returns (trimmed): prospect → leads[] → jobs[].
const prospect = (cst_id, leads) => ({ cst_id, leads });
const lead = (id, disposition, jobs = []) => ({ id, disposition, jobs });
const lpJob = (id, jobstatus) => ({ id, jobstatus, grossamount: '9020.00' });
const cf = (leadId, prospectId) => [
  ...(leadId ? [{ id: CONTACT_CF_LP_LEAD_ID, value: leadId }] : []),
  ...(prospectId ? [{ id: CONTACT_CF_LP_PROSPECT_ID, value: prospectId }] : []),
];

// ─── classifyRecovery ────────────────────────────────────────────────

test('the live case: prospect 426541 owns job 58021 → recoverable', () => {
  const p = prospect('426541', [lead('533193', 'Sale', [lpJob('58021', 'Paid In Full')])]);
  const c = classifyRecovery({ contactLeadId: '533193', contactProspectId: '426541', prospect: p });
  assert.equal(c.verdict, 'recoverable');
  assert.deepEqual(c.jobs.map((j) => [j.job.id, j.leadId]), [['58021', '533193']]);
});

test('a prospect id that disagrees decides — even when the lead id matches', () => {
  // The lead id can be an unresolved inbound queue id that collides with a
  // real lead of a different customer. The stable prospect id wins.
  const p = prospect('999', [lead('533193', 'Sale', [lpJob('58021', 'Paid In Full')])]);
  const c = classifyRecovery({ contactLeadId: '533193', contactProspectId: '426541', prospect: p });
  assert.equal(c.verdict, 'link_mismatch');
});

test('no prospect id on the contact: the lead id may prove ownership', () => {
  const p = prospect('426541', [lead('533193', 'Sale', [lpJob('58021', 'Paid In Full')])]);
  assert.equal(classifyRecovery({ contactLeadId: '533193', contactProspectId: '', prospect: p }).verdict, 'recoverable');
  assert.equal(classifyRecovery({ contactLeadId: '111', contactProspectId: '', prospect: p }).verdict, 'link_mismatch');
});

test('LP holds the customer but no job → lp_has_no_job, with dispositions for the reviewer', () => {
  const p = prospect('1', [lead('10', 'CXL'), lead('11', 'OPPFDN')]);
  const c = classifyRecovery({ contactLeadId: '10', contactProspectId: '1', prospect: p });
  assert.equal(c.verdict, 'lp_has_no_job');
  assert.deepEqual(c.dispositions, ['CXL', 'OPPFDN']);
});

test('no prospect at all → no_lp_record', () => {
  assert.equal(classifyRecovery({ contactLeadId: '', contactProspectId: '', prospect: null }).verdict, 'no_lp_record');
});

test('field and response readers tolerate every shape they meet', () => {
  assert.equal(contactField(cf('5', '6'), CONTACT_CF_LP_PROSPECT_ID), '6');
  assert.equal(contactField({}, CONTACT_CF_LP_LEAD_ID), '');           // mirror's '{}' default
  assert.equal(prospectFrom([{ cst_id: '7' }]).cst_id, '7');
  assert.equal(prospectFrom({ cst_id: '8' }).cst_id, '8');
  assert.equal(prospectFrom([]), null);
  assert.equal(prospectFrom(null), null);
});

// ─── runRepair, end to end through the deps seam ─────────────────────

function fakeDeps({ opps, jobsByContact = {}, lpByProspect = {}, lpThrows = false, upsertResult = {} }) {
  const calls = { leadUpserts: [], jobUpserts: [] };
  return {
    calls,
    deps: {
      esc: (s) => String(s).replace(/'/g, "''"),
      p2PipelineId: 'P2',
      hlRunSQL: async () => opps,
      jobsForContact: async (c) => (jobsByContact[c] === 'ERR'
        ? { jobs: [], error: 'boom' } : { jobs: jobsByContact[c] || [], error: null }),
      getLead: async (pid) => { if (lpThrows) throw new Error('LP down'); return lpByProspect[pid] ? [lpByProspect[pid]] : []; },
      getLeadByLdsId: async () => [],
      upsertLeadOnly: async (p) => { calls.leadUpserts.push(p.cst_id); },
      syncJobAndMilestones: async (job, leadId, contactId, o) => {
        calls.jobUpserts.push({ job: job.id, leadId, contactId, suppress: o?.suppressSideEffects });
        return upsertResult;
      },
    },
  };
}

const quiet = { log: () => {} };

test('dry run writes nothing and sorts every opportunity', async () => {
  const { deps, calls } = fakeDeps({
    opps: [
      { ghl_opportunity_id: 'A', ghl_contact_id: 'cA', custom_fields: cf('533193', '426541') },
      { ghl_opportunity_id: 'B', ghl_contact_id: 'cB', custom_fields: cf('', '') },
      { ghl_opportunity_id: 'C', ghl_contact_id: 'cC', custom_fields: cf('1', '2') },
    ],
    jobsByContact: { cC: [{ lp_job_id: '9' }] },
    lpByProspect: { 426541: prospect('426541', [lead('533193', 'Sale', [lpJob('58021', 'Paid In Full')])]) },
  });
  const r = await runRepair(quiet, deps);
  assert.equal(r.recoverable, 1);
  assert.equal(r.no_lp_record, 1);
  assert.equal(r.has_job, 1);
  assert.deepEqual(calls.leadUpserts, []);
  assert.deepEqual(calls.jobUpserts, []);
  assert.deepEqual(r.manual.map((m) => m.id), ['B']);
});

test('--execute writes the lead, then each job with side effects SUPPRESSED and the contact linked', async () => {
  const { deps, calls } = fakeDeps({
    opps: [{ ghl_opportunity_id: 'A', ghl_contact_id: 'cA', custom_fields: cf('533193', '426541') }],
    lpByProspect: { 426541: prospect('426541', [lead('533193', 'Sale', [lpJob('58021', 'Paid In Full')])]) },
  });
  const r = await runRepair({ ...quiet, execute: true }, deps);
  assert.equal(r.jobs_written, 1);
  assert.deepEqual(calls.leadUpserts, ['426541']);
  assert.deepEqual(calls.jobUpserts, [{ job: '58021', leadId: '533193', contactId: 'cA', suppress: true }]);
});

test('a link mismatch is listed and never written, even under --execute', async () => {
  const { deps, calls } = fakeDeps({
    opps: [{ ghl_opportunity_id: 'A', ghl_contact_id: 'cA', custom_fields: cf('', '426541') }],
    lpByProspect: { 426541: prospect('999', [lead('1', 'Sale', [lpJob('5', 'New')])]) },
  });
  const r = await runRepair({ ...quiet, execute: true }, deps);
  assert.equal(r.link_mismatch, 1);
  assert.deepEqual(calls.jobUpserts, []);
});

test('an LP read that throws is unreadable, not "no LP record"', async () => {
  const { deps } = fakeDeps({
    opps: [{ ghl_opportunity_id: 'A', ghl_contact_id: 'cA', custom_fields: cf('', '426541') }],
    lpThrows: true,
  });
  const r = await runRepair(quiet, deps);
  assert.equal(r.unreadable, 1);
  assert.equal(r.no_lp_record, 0);
});

test('an unreadable job list touches nothing', async () => {
  const { deps, calls } = fakeDeps({
    opps: [{ ghl_opportunity_id: 'A', ghl_contact_id: 'cA', custom_fields: cf('', '426541') }],
    jobsByContact: { cA: 'ERR' },
  });
  const r = await runRepair({ ...quiet, execute: true }, deps);
  assert.equal(r.unreadable, 1);
  assert.deepEqual(calls.leadUpserts, []);
});

test('a job upsert that RESOLVES with jobUpsertError counts as a failure', async () => {
  const { deps } = fakeDeps({
    opps: [{ ghl_opportunity_id: 'A', ghl_contact_id: 'cA', custom_fields: cf('', '426541') }],
    lpByProspect: { 426541: prospect('426541', [lead('533193', 'Sale', [lpJob('58021', 'Paid In Full')])]) },
    upsertResult: { jobUpsertError: { code: '23503' } },
  });
  const r = await runRepair({ ...quiet, execute: true }, deps);
  assert.equal(r.write_failed, 1);
  assert.equal(r.jobs_written, 0);
});

test('--limit caps how many are recovered', async () => {
  const p = (id) => prospect(id, [lead(`L${id}`, 'Sale', [lpJob(`J${id}`, 'New')])]);
  const { deps, calls } = fakeDeps({
    opps: ['1', '2', '3'].map((i) => ({ ghl_opportunity_id: i, ghl_contact_id: `c${i}`, custom_fields: cf('', i) })),
    lpByProspect: { 1: p('1'), 2: p('2'), 3: p('3') },
  });
  const r = await runRepair({ ...quiet, execute: true, limit: 2 }, deps);
  assert.equal(r.recoverable, 2);
  assert.equal(calls.jobUpserts.length, 2);
});
