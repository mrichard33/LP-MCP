import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadHadDemo, contactHadDemo } from '../src/demo-truth.js';
import { buildMergedLead } from '../src/ghl-field-sync.js';

const base = { ghl_contact_id: 'X', lp_prospect_id: 'P', updated_at_lp: '2026-09-30T00:00:00Z' };

test('Ileana: NOC appointment with sat=true is NOT a demo', () => {
  const lead = { ...base, lp_lead_id: '575923', disposition_code: 'NOC', demo_completed: true, ever_sat: true,
    appts: [{ disposition: 'Data', sat: 'false' }, { disposition: 'NOC', sat: 'true' }] };
  assert.equal(leadHadDemo(lead), false);
  const rebook = { ...base, lp_lead_id: '576249', disposition_code: 'CCC', appts: [{ disposition: 'CCC', sat: 'false' }] };
  assert.equal(buildMergedLead([lead, rebook]).demo_completed, false);
});

test('Napoly: NoRehash demo survives a later cancelled rebook on the same lead', () => {
  const lead = { ...base, lp_lead_id: '578728', disposition_code: 'CXL', demo_completed: false,
    appts: [{ disposition: 'NoRehash', sat: 'true' }, { disposition: 'CXL', sat: 'false' }] };
  assert.equal(leadHadDemo(lead), true);
});

test('Sale, OPPFDN, closed_won count; CXL with a stray sat=true does not', () => {
  assert.equal(leadHadDemo({ disposition_code: 'Sale' }), true);
  assert.equal(leadHadDemo({ appts: [{ disposition: 'OPPFDN' }] }), true);
  assert.equal(leadHadDemo({ closed_won: true }), true);
  assert.equal(leadHadDemo({ disposition_code: 'CXL', appts: [{ disposition: 'CXL', sat: 'true' }] }), false);
});

test('duplicate leads: demo on the older lead counts', () => {
  assert.equal(contactHadDemo([{ disposition_code: 'Set' }, { appts: [{ disposition: 'OPPFDN' }] }]), true);
});

// ── Additions beyond the handoff's four cases ───────────────────────

test('raw_lp_data.appointments is read when appts is absent', () => {
  assert.equal(leadHadDemo({ raw_lp_data: { appointments: [{ disposition: 'NoRehash' }] } }), true);
  assert.equal(leadHadDemo({ raw_lp_data: { appointments: null } }), false);
});

test('empty / missing input is not a demo', () => {
  assert.equal(leadHadDemo(null), false);
  assert.equal(contactHadDemo(null), false);
  assert.equal(contactHadDemo([]), false);
});

test('buildMergedLead: LP Demo Completed ignores the sat-derived demo_completed column', () => {
  // Napoly's shape: column false (sat reset on rebook), appointment says NoRehash.
  const napoly = { ...base, lp_lead_id: '578728', disposition_code: 'CXL', demo_completed: false,
    appts: [{ disposition: 'NoRehash' }, { disposition: 'CXL' }] };
  assert.equal(buildMergedLead([napoly]).demo_completed, true);
});

// ── backfill planner (scripts/backfill-demo-truth.js) ───────────────

const { planDemoTruthBackfill, parseArgs } = await import('./backfill-demo-truth.js');

test('backfill plan: ADD true-and-untagged, REMOVE false-and-tagged, protected and unlinked left alone', () => {
  const leads = new Map([
    ['napoly', [{ disposition_code: 'CXL', appts: [{ disposition: 'NoRehash' }, { disposition: 'CXL' }] }]],
    ['ileana', [{ disposition_code: 'NOC', appts: [{ disposition: 'NOC', sat: 'true' }] }, { disposition_code: 'CCC' }]],
    ['customer', [{ disposition_code: 'NOC' }]],
    ['already', [{ disposition_code: 'Sale' }]],
    ['gone', [{ disposition_code: 'OPPFDN' }]],
  ]);
  const hl = new Map([
    ['napoly', ['s5.2']],
    ['ileana', ['LP-Demo-Completed']],
    ['customer', ['lp-demo-completed', 'customer']],
    ['already', ['lp-demo-completed']],
    ['unlinked', ['lp-demo-completed']],
  ]);
  const plan = planDemoTruthBackfill(leads, hl);
  assert.deepEqual(plan.add.map((r) => r.contact_id), ['napoly']);
  assert.equal(plan.add[0].why, 'appt:NoRehash');
  assert.deepEqual(plan.remove.map((r) => r.contact_id), ['ileana']);
  assert.equal(plan.skippedNotInHl, 1);   // 'gone'
  assert.equal(plan.skippedNoLpLeads, 1); // 'unlinked'
});

test('backfill args: --execute needs both confirm counts', () => {
  assert.equal(parseArgs([]).execute, false);
  assert.equal(parseArgs([]).limit, 200);
  assert.ok(parseArgs(['--execute']).errors.length > 0);
  assert.ok(parseArgs(['--execute', '--confirm-add=3']).errors.length > 0);
  const ok = parseArgs(['--execute', '--confirm-add=3', '--confirm-remove=0', '--limit=50']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.confirmAdd, 3);
  assert.equal(ok.confirmRemove, 0);
  assert.equal(ok.limit, 50);
  assert.ok(parseArgs(['--limit=0']).errors.length > 0);
});

test('backfill plan: deal-won / stage:customer-onboarding are protected (the tags GHL actually uses)', () => {
  const leads = new Map([['won', [{ disposition_code: 'No Demo' }]], ['onb', [{ disposition_code: 'No Demo' }]]]);
  const hl = new Map([['won', ['lp-demo-completed', 'Deal-Won']], ['onb', ['lp-demo-completed', 'stage:customer-onboarding']]]);
  assert.deepEqual(planDemoTruthBackfill(leads, hl).remove, []);
});
