// scripts/test-link-selection-nojob.js
//
// selectLinkLead({ requireJob: false }) — the widening added for the
// unreferenced-contact cohort on 2026-09-19.
//
// Mark's job-bearing rule is the DEFAULT and is unchanged. These tests pin two
// things: that the default behaves exactly as before, and that the widened path
// judges ambiguity over a STRICTER population than the default does — every
// candidate prospect, not just the job-bearing ones.
//
// Why the widening exists: lp_jobs holds 6,248 rows against 24,885 WON leads
// (24.5% coverage), so "has no job row" does not mean "is not a real customer".
// For the P2 cohort a missing job row is the defect being repaired; for a
// contact nothing references it is just the normal state of an unsold lead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLinkLead } from '../src/lp-link-selection.js';

const lead = (id, has_job, lp_prospect_id = '100') => ({ lp_lead_id: id, has_job, lp_prospect_id });

// ─── The default is untouched ───────────────────────────────────────────────

test('default still refuses when no lead has a job', () => {
  const r = selectLinkLead([lead('1', false), lead('2', false)]);
  assert.equal(r.verdict, 'no_job_bearing_lead');
  assert.equal(r.lead, null);
});

test('default is the behaviour when no options are passed at all', () => {
  const candidates = [lead('1', false, '100'), lead('2', true, '100')];
  assert.deepEqual(selectLinkLead(candidates), selectLinkLead(candidates, { requireJob: true }));
});

// ─── The widened path ───────────────────────────────────────────────────────

test('requireJob false: a single jobless lead under one prospect is selected', () => {
  const r = selectLinkLead([lead('1', false)], { requireJob: false });
  assert.equal(r.verdict, 'selected');
  assert.equal(r.lead.lp_lead_id, '1');
  assert.equal(r.jobBearingCount, 0);
});

test('requireJob false: several jobless leads under ONE prospect → highest id', () => {
  const r = selectLinkLead([lead('7', false), lead('42', false), lead('9', false)], { requireJob: false });
  assert.equal(r.verdict, 'selected');
  assert.equal(r.lead.lp_lead_id, '42');
});

test('requireJob false: jobless leads spanning TWO prospects → ambiguous', () => {
  // The strictness that replaces the job rule. The default would have called
  // this no_job_bearing_lead and the job-filtered fan-out guard would have
  // counted 0 prospects for the key — blind to exactly this case.
  const r = selectLinkLead([lead('1', false, '100'), lead('2', false, '200')], { requireJob: false });
  assert.equal(r.verdict, 'ambiguous');
  assert.equal(r.lead, null);
  assert.deepEqual(new Set(r.prospectIds), new Set(['100', '200']));
});

test('requireJob false: three prospects, none job-bearing → still ambiguous', () => {
  // The live shape behind the placeholder number 8135555555.
  const r = selectLinkLead(
    [lead('1', false, '1'), lead('2', false, '2'), lead('3', false, '3')], { requireJob: false });
  assert.equal(r.verdict, 'ambiguous');
});

test('requireJob false: a job-bearing lead still wins when one exists', () => {
  // The widening is a fallback, never a change of preference — it must not
  // pick a higher-id jobless lead over a real job-bearing one.
  const r = selectLinkLead([lead('99', false), lead('5', true)], { requireJob: false });
  assert.equal(r.verdict, 'selected');
  assert.equal(r.lead.lp_lead_id, '5', 'the job-bearing lead wins despite the lower id');
  assert.equal(r.jobBearingCount, 1);
});

test('requireJob false: job-bearing leads spanning two prospects are still ambiguous', () => {
  const r = selectLinkLead([lead('1', true, '100'), lead('2', true, '200')], { requireJob: false });
  assert.equal(r.verdict, 'ambiguous');
});

test('requireJob false: no candidates is still no_candidates, not a selection', () => {
  const r = selectLinkLead([], { requireJob: false });
  assert.equal(r.verdict, 'no_candidates');
  assert.equal(r.lead, null);
});

test('the widened path never selects where the default selected something else', () => {
  // Exhaustive over small shapes: whenever the default selects, the widened
  // path must select the SAME lead. It may only turn a refusal into a
  // selection, never redirect one.
  const shapes = [];
  for (const aJob of [true, false]) {
    for (const bJob of [true, false]) {
      for (const bProspect of ['100', '200']) {
        shapes.push([lead('1', aJob, '100'), lead('2', bJob, bProspect)]);
      }
    }
  }
  for (const c of shapes) {
    const strict = selectLinkLead(c);
    const wide = selectLinkLead(c, { requireJob: false });
    if (strict.verdict === 'selected') {
      assert.equal(wide.verdict, 'selected');
      assert.equal(wide.lead.lp_lead_id, strict.lead.lp_lead_id,
        `widening redirected a selection for ${JSON.stringify(c)}`);
    }
  }
});
