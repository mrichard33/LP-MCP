// 2026-09-30 (fix/f0-oppfdn-integrity) — the lp_current_lead_match verb that
// F0_ENROLL_CURRENT_OPPFDN and F0_EXIT_NOT_OPPFDN gate on, plus the F.0 audit's
// pure flagger. Fail-closed: unknown data never adds or removes anyone.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { evaluateCurrentLeadMatch, _internal } = await import('../src/decision-engine.js');
const { flagF0Contact, formatF0AuditReport } = await import('../src/jobs/f0-integrity-audit.js');
const evaluateContextConditions = _internal?.evaluateContextConditions
  || (await import('../src/decision-engine.js')).evaluateContextConditions;

// appointment_date is stored as ET wall clock tagged +00:00 (src/lp-dates.js).
const NOW = Date.parse('2026-09-30T16:00:00Z');           // 12:00 ET
const daysAgo = (d) => new Date(NOW - d * 86_400_000 - 4 * 3_600_000).toISOString().replace('Z', '+00:00');
const lead = (disp, apptDaysAgo = 3) => ({
  lp_lead_id: 'L1', disposition_code: disp,
  appointment_date: apptDaysAgo === null ? null : daysAgo(apptDaysAgo),
  created_at_lp: '2026-09-01T00:00:00Z', updated_at_lp: '2026-09-02T00:00:00Z',
});
const evt = (payload = {}) => ({ id: 1, ghl_contact_id: 'c-1', event_type: 'lp.disposition_changed', payload });
const ENTER = { disposition_in: ['OPPFDN'], max_days_since_appointment: 14, allow_synthetic: false };
const EXIT = { disposition_not_in: ['OPPFDN'], allow_synthetic: false };

// ── pure core ───────────────────────────────────────────────────────

test('disposition_in: OPPFDN passes, anything else fails', () => {
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN'), ENTER, evt(), NOW).pass, true);
  assert.equal(evaluateCurrentLeadMatch(lead('CXL'), ENTER, evt(), NOW).pass, false);
  assert.equal(evaluateCurrentLeadMatch(lead(null), { disposition_in: ['OPPFDN'] }, evt(), NOW).pass, false);
});

test('disposition_not_in: OPPFDN fails (stays in F.0); NoRehash/NOC and a null code pass', () => {
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN'), EXIT, evt(), NOW).pass, false);
  for (const d of ['NoRehash', 'NOC', 'Issue', 'Set']) {
    assert.equal(evaluateCurrentLeadMatch(lead(d), EXIT, evt(), NOW).pass, true, d);
  }
  assert.equal(evaluateCurrentLeadMatch(lead(null), EXIT, evt(), NOW).pass, true);
});

test('Sale exits F.0 (Mark, 2026-09-30): disposition_not_in ["OPPFDN"] passes for Sale', () => {
  assert.equal(evaluateCurrentLeadMatch(lead('Sale'), EXIT, evt(), NOW).pass, true);
});

test('max_days_since_appointment: within window passes; old, missing and future fail', () => {
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN', 13), ENTER, evt(), NOW).pass, true);
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN', 15), ENTER, evt(), NOW).pass, false);
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN', null), ENTER, evt(), NOW).pass, false);
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN', -2), ENTER, evt(), NOW).pass, false);
});

test('max_days uses the stored ET frame: 14d minus 2h in ET is still inside the window', () => {
  // 13.9 days ago in true time. Read naively as UTC it would look 4h older.
  const l = { ...lead('OPPFDN'), appointment_date: daysAgo(13.9) };
  assert.equal(evaluateCurrentLeadMatch(l, ENTER, evt(), NOW).pass, true);
});

test('allow_synthetic:false fails an inbound-backfill replay', () => {
  const v = evaluateCurrentLeadMatch(lead('OPPFDN'), ENTER, evt({ synthetic: true }), NOW);
  assert.equal(v.pass, false);
  assert.match(v.reason, /synthetic/);
});

test('no spec keys → any lead passes; no lead → fails', () => {
  assert.equal(evaluateCurrentLeadMatch(lead('X'), {}, evt(), NOW).pass, true);
  assert.equal(evaluateCurrentLeadMatch(null, {}, evt(), NOW).pass, false);
});

// ── the verb inside evaluateContextConditions (live read, fail-closed) ──

function mockDb({ rows = [], error = null } = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      reads.push(table);
      const api = { select() { return api; }, eq() { return api; }, is() { return api; },
        limit: async () => ({ data: error ? null : rows, error: error ? { message: error } : null }) };
      return api;
    },
  };
}
const deps = (db) => ({ deps: { supabase: db, nowMs: NOW, emitEvent: async () => {} } });

test('verb: current OPPFDN lead within 14 days → rule A passes', async () => {
  const db = mockDb({ rows: [lead('OPPFDN', 2)] });
  assert.equal(await evaluateContextConditions({ lp_current_lead_match: ENTER }, {}, evt(), deps(db)), true);
});

test('verb: the CURRENT lead decides, not an older touched duplicate', async () => {
  const older = { ...lead('OPPFDN', 2), lp_lead_id: 'old', created_at_lp: '2026-01-01T00:00:00Z', updated_at_lp: '2026-09-30T00:00:00Z' };
  const current = { ...lead('CXL', 2), lp_lead_id: 'new', created_at_lp: '2026-09-20T00:00:00Z' };
  const db = mockDb({ rows: [older, current] });
  assert.equal(await evaluateContextConditions({ lp_current_lead_match: ENTER }, {}, evt(), deps(db)), false);
});

test('verb: read error → fails closed', async () => {
  const db = mockDb({ error: 'connection reset' });
  assert.equal(await evaluateContextConditions({ lp_current_lead_match: EXIT }, {}, evt(), deps(db)), false);
});

test('verb: contact with no LP lead → fails closed (never removes on unknown data)', async () => {
  const db = mockDb({ rows: [] });
  assert.equal(await evaluateContextConditions({ lp_current_lead_match: EXIT }, {}, evt(), deps(db)), false);
});

test('verb: event without a contact → suppressed, no read attempted', async () => {
  const db = mockDb({ rows: [lead('OPPFDN', 2)] });
  const e = { ...evt(), ghl_contact_id: null };
  assert.equal(await evaluateContextConditions({ lp_current_lead_match: ENTER }, {}, e, deps(db)), false);
  assert.deepEqual(db.reads, []);
});

test('verb: synthetic event → fails before any read', async () => {
  const db = mockDb({ rows: [lead('OPPFDN', 2)] });
  assert.equal(await evaluateContextConditions({ lp_current_lead_match: ENTER }, {}, evt({ synthetic: true }), deps(db)), false);
  assert.deepEqual(db.reads, []);
});

// ── F.0 integrity audit (src/jobs/f0-integrity-audit.js) ──────────

test('audit: flags no leads, non-OPPFDN (Sale included) and no real demo; passes a real OPPFDN', () => {
  assert.match(flagF0Contact([]).reason, /no LP lead/);
  assert.match(flagF0Contact([{ disposition_code: 'Sale', closed_won: true }]).reason, /Sale, not OPPFDN/);
  assert.match(flagF0Contact([{ disposition_code: 'NOC' }]).reason, /NOC, not OPPFDN/);
  assert.equal(flagF0Contact([{ disposition_code: 'OPPFDN' }]), null);
});

test('audit report: clean run still says so; failure says it could not run', () => {
  assert.match(formatF0AuditReport({ total: 390, flagged: [] }), /0 of 390 .* clean/);
  assert.match(formatF0AuditReport({ total: 0, flagged: [], error: 'boom' }), /could not run: boom/);
  const many = Array.from({ length: 30 }, (_, i) => ({ contact_id: `c${i}`, disposition: 'NOC', reason: 'x' }));
  const text = formatF0AuditReport({ total: 400, flagged: many });
  assert.match(text, /30 of 400/);
  assert.match(text, /and 5 more/);
});

test('allow_synthetic:false also catches a stringified "true"', () => {
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN'), ENTER, evt({ synthetic: 'true' }), NOW).pass, false);
  assert.equal(evaluateCurrentLeadMatch(lead('OPPFDN'), ENTER, evt({ synthetic: false }), NOW).pass, true);
});
