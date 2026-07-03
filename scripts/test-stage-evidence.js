/**
 * test-stage-evidence.js — stage-transition evidence matrix
 * (2026-07-03 pipeline-integrity breach: BEHAVIORAL_FAST_TRACK fabricated
 * "Appointment Booked" on AI intent; BEHAVIORAL_*_OBJECTION fabricated
 * "Proposal Delivered" with no demo — ~150 unearned moves / 111 contacts.)
 *
 * evaluateStageEvidence is the pure predicate the move_opportunity executor
 * consults before ANY milestone stage move, regardless of requesting rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { evaluateStageEvidence, STAGE_EVIDENCE_REQUIREMENTS } =
  await import('../src/actions/stage-evidence.js');
const { STAGE_MAP } = await import('../src/actions/constants.js');

// ── Matrix coverage ─────────────────────────────────────────────────

test('matrix gates exactly the milestone stages (by stage ID, covering aliases)', () => {
  assert.equal(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Appointment Booked']].evidence, 'booking');
  assert.equal(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Appointment Completed']].evidence, 'demo_completed');
  assert.equal(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Proposal Delivered']].evidence, 'demo_completed');
  // legacy alias maps to the same gated stage id
  assert.ok(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Proposal / Estimate Delivered']]);
  // demotions are NOT gated
  assert.equal(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Reactivation']], undefined);
  assert.equal(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Long-Term Hold']], undefined);
  assert.equal(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Reactivation Queue']], undefined);
  assert.equal(STAGE_EVIDENCE_REQUIREMENTS[STAGE_MAP['Not Interested (Cooling)']], undefined);
});

// ── booking evidence ────────────────────────────────────────────────

test('Appointment Booked with NO evidence → blocked', () => {
  const v = evaluateStageEvidence('booking', { appointments: [], tags: [], lpDisposition: null });
  assert.equal(v.satisfied, false);
  assert.ok(v.missing_evidence.length >= 3);
});

test('Appointment Booked with appointment (new/confirmed/showed) → allowed', () => {
  for (const status of ['new', 'confirmed', 'showed']) {
    const v = evaluateStageEvidence('booking', { appointments: [{ status }], tags: [], lpDisposition: null });
    assert.equal(v.satisfied, true, `status=${status} should satisfy booking`);
  }
});

test('cancelled/noshow appointments do NOT satisfy booking', () => {
  const v = evaluateStageEvidence('booking', { appointments: [{ status: 'cancelled' }, { status: 'noshow' }], tags: [], lpDisposition: null });
  assert.equal(v.satisfied, false);
});

test('durable booked-* tag satisfies booking', () => {
  for (const tag of ['booked-estimate', 'booked-measurement', 'chatbot-booked-call', 'stage:booked-estimate']) {
    const v = evaluateStageEvidence('booking', { appointments: [], tags: [tag], lpDisposition: null });
    assert.equal(v.satisfied, true, `tag=${tag}`);
  }
});

test('LP disposition Set / Cnf satisfies booking', () => {
  for (const disp of ['Set', 'Cnf']) {
    const v = evaluateStageEvidence('booking', { appointments: [], tags: [], lpDisposition: disp });
    assert.equal(v.satisfied, true, `disp=${disp}`);
  }
});

// ── demo_completed evidence ─────────────────────────────────────────

test('Proposal Delivered with appointment status=confirmed ONLY → blocked (demo not done)', () => {
  const v = evaluateStageEvidence('demo_completed', { appointments: [{ status: 'confirmed' }], tags: [], lpDisposition: null });
  assert.equal(v.satisfied, false);
});

test('demo_completed satisfied by appointment status=showed', () => {
  const v = evaluateStageEvidence('demo_completed', { appointments: [{ status: 'showed' }], tags: [], lpDisposition: null });
  assert.equal(v.satisfied, true);
  assert.equal(v.matched, 'appointment_showed');
});

test('demo_completed satisfied by HPA/HPRC-Completed or lp-demo-completed tag', () => {
  for (const tag of ['HPA-Completed', 'hprc-completed', 'lp-demo-completed']) {
    const v = evaluateStageEvidence('demo_completed', { appointments: [], tags: [tag], lpDisposition: null });
    assert.equal(v.satisfied, true, `tag=${tag}`);
  }
});

test('demo_completed satisfied by LP post-demo dispositions', () => {
  for (const disp of ['FDNS', 'BO', '1Leg', 'OPPFDN', 'CS']) {
    const v = evaluateStageEvidence('demo_completed', { appointments: [], tags: [], lpDisposition: disp });
    assert.equal(v.satisfied, true, `disp=${disp}`);
  }
});

test('pre-demo dispositions (Set/Cnf) do NOT satisfy demo_completed', () => {
  for (const disp of ['Set', 'Cnf']) {
    const v = evaluateStageEvidence('demo_completed', { appointments: [], tags: [], lpDisposition: disp });
    assert.equal(v.satisfied, false, `disp=${disp}`);
  }
});

test('unreadable facts (all null) provide no evidence → blocked', () => {
  const v = evaluateStageEvidence('booking', { appointments: null, tags: null, lpDisposition: null });
  assert.equal(v.satisfied, false);
});

test('unknown evidence kind in matrix is a config bug → blocked', () => {
  const v = evaluateStageEvidence('nonsense', { appointments: [{ status: 'showed' }] });
  assert.equal(v.satisfied, false);
});
