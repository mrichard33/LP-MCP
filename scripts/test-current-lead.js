// 2026-09-30 (fix/f0-oppfdn-integrity) — the ONE definition of a contact's
// current LP lead, the field-sync switch to it, and the 'reassert' sentinel.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { pickCurrentLead } = await import('../src/current-lead.js');
const { buildMergedLead, syncLeadFieldsToGHL } = await import('../src/ghl-field-sync.js');
const { findMismatches, parseArgs, REASSERT_HASH } = await import('./reassert-lp-disposition.js');

test('pickCurrentLead: newest CREATED wins even when an older lead was updated later', () => {
  const old = { lp_lead_id: 'old', created_at_lp: '2026-01-01T00:00:00Z', updated_at_lp: '2026-09-30T00:00:00Z' };
  const cur = { lp_lead_id: 'cur', created_at_lp: '2026-09-01T00:00:00Z', updated_at_lp: '2026-09-02T00:00:00Z' };
  assert.equal(pickCurrentLead([old, cur]).lp_lead_id, 'cur');
});

test('pickCurrentLead: tie on created_at_lp → later updated_at_lp wins', () => {
  const a = { lp_lead_id: 'a', created_at_lp: '2026-09-01T00:00:00Z', updated_at_lp: '2026-09-02T00:00:00Z' };
  const b = { lp_lead_id: 'b', created_at_lp: '2026-09-01T00:00:00Z', updated_at_lp: '2026-09-05T00:00:00Z' };
  assert.equal(pickCurrentLead([a, b]).lp_lead_id, 'b');
});

test('pickCurrentLead: empty / missing input → null', () => {
  assert.equal(pickCurrentLead([]), null);
  assert.equal(pickCurrentLead(null), null);
});

// 2026-10-01 — a blank Data lead must not hide a real appointment.
test('pickCurrentLead (Sharyn Blake): Data lead made 4 min after the demo lead does not win', () => {
  const demo = { lp_lead_id: '579801', disposition_code: 'OPPFDN', appointment_date: '2026-10-01T14:00:00Z',
    created_at_lp: '2026-09-30T10:10:40Z', updated_at_lp: '2026-10-01T15:44:26Z' };
  const data = { lp_lead_id: '579804', disposition_code: 'Data', appointment_date: null,
    created_at_lp: '2026-09-30T10:14:53Z', updated_at_lp: '2026-09-30T10:14:53Z' };
  const old = { lp_lead_id: '524525', disposition_code: 'CXL', appointment_date: '2026-04-16T14:00:00Z',
    created_at_lp: '2026-04-07T13:45:10Z', updated_at_lp: '2026-04-15T19:58:50Z' };
  assert.equal(pickCurrentLead([old, demo, data]).lp_lead_id, '579801');
  assert.equal(buildMergedLead([old, demo, data]).disposition_code, 'OPPFDN');
});

test('pickCurrentLead: Data lead within 15 days AFTER an appointment still yields', () => {
  const demo = { lp_lead_id: 'demo', disposition_code: 'OPPFDN', appointment_date: '2026-09-20T14:00:00Z',
    created_at_lp: '2026-09-01T00:00:00Z' };
  const data = { lp_lead_id: 'data', disposition_code: 'Data', created_at_lp: '2026-10-01T00:00:00Z' };
  assert.equal(pickCurrentLead([demo, data]).lp_lead_id, 'demo');
});

test('pickCurrentLead: Data lead 16+ days after the last appointment stays current (15-day window)', () => {
  const demo = { lp_lead_id: 'demo', disposition_code: 'OPPFDN', appointment_date: '2026-09-14T14:00:00Z',
    created_at_lp: '2026-09-10T00:00:00Z' };
  const data = { lp_lead_id: 'data', disposition_code: 'Data', created_at_lp: '2026-10-01T00:00:00Z' };
  assert.equal(pickCurrentLead([demo, data]).lp_lead_id, 'data');
});

test('pickCurrentLead: Data lead long after the last appointment is a new cycle and stays current', () => {
  const demo = { lp_lead_id: 'demo', disposition_code: 'OPPFDN', appointment_date: '2026-03-01T14:00:00Z',
    created_at_lp: '2026-02-20T00:00:00Z' };
  const data = { lp_lead_id: 'data', disposition_code: 'Data', created_at_lp: '2026-10-01T00:00:00Z' };
  assert.equal(pickCurrentLead([demo, data]).lp_lead_id, 'data');
});

test('pickCurrentLead: only Data is skipped — a newer DNC or worked lead still wins', () => {
  const demo = { lp_lead_id: 'demo', disposition_code: 'OPPFDN', appointment_date: '2026-09-30T14:00:00Z',
    created_at_lp: '2026-09-29T00:00:00Z' };
  for (const code of ['DNC', 'ND', 'Set']) {
    const newer = { lp_lead_id: code, disposition_code: code, created_at_lp: '2026-10-01T00:00:00Z' };
    assert.equal(pickCurrentLead([demo, newer]).lp_lead_id, code, code);
  }
});

test('pickCurrentLead: a Data lead with no other appointment, or the only lead, stays current', () => {
  const data = { lp_lead_id: 'data', disposition_code: 'Data', created_at_lp: '2026-10-01T00:00:00Z' };
  const noAppt = { lp_lead_id: 'na', disposition_code: 'NIS', created_at_lp: '2026-09-29T00:00:00Z' };
  assert.equal(pickCurrentLead([data]).lp_lead_id, 'data');
  assert.equal(pickCurrentLead([noAppt, data]).lp_lead_id, 'data');
});

test('buildMergedLead (Napoly): newer-created OPPFDN lead beats the later-updated CXL lead', () => {
  const cxl = { lp_lead_id: '578728', ghl_contact_id: 'zxyqXazWZa0h3hrNodq8', disposition_code: 'CXL',
    created_at_lp: '2026-09-25T10:00:00Z', updated_at_lp: '2026-09-30T12:00:00Z' };
  const oppfdn = { lp_lead_id: '579518', ghl_contact_id: 'zxyqXazWZa0h3hrNodq8', disposition_code: 'OPPFDN',
    created_at_lp: '2026-09-29T10:00:00Z', updated_at_lp: '2026-09-29T18:00:00Z' };
  const merged = buildMergedLead([cxl, oppfdn]);
  assert.equal(merged.disposition_code, 'OPPFDN');
  assert.equal(merged.lp_lead_id, '579518');
});

test('buildMergedLead: a soft-deleted lead is never the current lead', () => {
  const live = { lp_lead_id: 'live', disposition_code: 'OPPFDN', created_at_lp: '2026-09-01T00:00:00Z' };
  const gone = { lp_lead_id: 'gone', disposition_code: 'CXL', created_at_lp: '2026-09-20T00:00:00Z', lp_deleted_at: '2026-09-21T00:00:00Z' };
  assert.equal(buildMergedLead([live, gone]).disposition_code, 'OPPFDN');
});

// ── the 'reassert' sentinel (scripts/reassert-lp-disposition.js) ─────

function fakeDb() {
  return { from() { const api = { update() { return api; }, eq() { return Promise.resolve({ error: null }); } }; return api; } };
}

test("'reassert' hash forces a push and emits NO lp.disposition_changed", async () => {
  const emitted = [];
  const pushed = [];
  const lead = buildMergedLead([{ lp_lead_id: '1', ghl_contact_id: 'C1', disposition_code: 'OPPFDN',
    created_at_lp: '2026-09-29T00:00:00Z', ghl_fields_hash: REASSERT_HASH }]);
  const res = await syncLeadFieldsToGHL(lead, 'C1', REASSERT_HASH, {
    updateGHLContactFields: async (id, fields) => { pushed.push(id); return true; },
    emitEvent: async (e) => { emitted.push(e); },
    supabase: fakeDb(),
  });
  assert.equal(res.pushed, true);
  assert.deepEqual(pushed, ['C1']);
  assert.deepEqual(emitted, [], 'a reasserted push must not fire routing rules');
});

test('a NULL hash (first sync) DOES emit — which is why the sentinel is not NULL', async () => {
  const emitted = [];
  const lead = buildMergedLead([{ lp_lead_id: '1', ghl_contact_id: 'C1', disposition_code: 'OPPFDN',
    created_at_lp: '2026-09-29T00:00:00Z', ghl_fields_hash: null }]);
  await syncLeadFieldsToGHL(lead, 'C1', null, {
    updateGHLContactFields: async () => true,
    emitEvent: async (e) => { emitted.push(e); },
    supabase: fakeDb(),
  });
  assert.equal(emitted.length, 1);
});

test('findMismatches compares GHL with the current lead and skips contacts missing from HL', () => {
  const leads = new Map([
    ['A', [{ lp_lead_id: 'a1', disposition_code: 'CXL', created_at_lp: '2026-09-01T00:00:00Z', updated_at_lp: '2026-09-30T00:00:00Z' },
           { lp_lead_id: 'a2', disposition_code: 'OPPFDN', created_at_lp: '2026-09-20T00:00:00Z' }]],
    ['B', [{ lp_lead_id: 'b1', disposition_code: 'Set', created_at_lp: '2026-09-01T00:00:00Z' }]],
    ['C', [{ lp_lead_id: 'c1', disposition_code: 'NOC', created_at_lp: '2026-09-01T00:00:00Z' }]],
  ]);
  const ghl = new Map([['A', 'CXL'], ['B', 'Set']]);
  const m = findMismatches(leads, ghl);
  assert.deepEqual(m.map((x) => [x.contact_id, x.ghl, x.lp]), [['A', 'CXL', 'OPPFDN']]);
});

test('reassert args: --execute needs --confirm', () => {
  assert.ok(parseArgs(['--execute']).errors.length > 0);
  assert.deepEqual(parseArgs(['--execute', '--confirm=12']).errors, []);
  assert.equal(parseArgs([]).execute, false);
});
