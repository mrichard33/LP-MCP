// 2026-09-30 (fix/f0-oppfdn-integrity) — the lp_current_lead_match verb that
// F0_ENROLL_CURRENT_OPPFDN and F0_EXIT_NOT_OPPFDN gate on, plus the F.0 audit's
// pure flagger. Fail-closed: unknown data never adds or removes anyone.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { evaluateCurrentLeadMatch, _internal } = await import('../src/decision-engine.js');
const { flagF0Contact, formatF0AuditReport, isMissingFromF0, runF0IntegrityAudit } = await import('../src/jobs/f0-integrity-audit.js');
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

// 2026-10-01 — S5.2 cancel entry: the cancelled appointment is usually still
// upcoming, so future passes; an April cancel re-synced in September fails.
const CANCEL = { disposition_in: ['CXL', 'CCC'], appointment_within_days: 14, allow_synthetic: false };

test('appointment_within_days: upcoming and recent pass; old and missing fail', () => {
  assert.equal(evaluateCurrentLeadMatch(lead('CXL', -3), CANCEL, evt(), NOW).pass, true);
  assert.equal(evaluateCurrentLeadMatch(lead('CXL', 0), CANCEL, evt(), NOW).pass, true);
  assert.equal(evaluateCurrentLeadMatch(lead('CCC', 13), CANCEL, evt(), NOW).pass, true);
  assert.equal(evaluateCurrentLeadMatch(lead('CXL', 15), CANCEL, evt(), NOW).pass, false);
  assert.equal(evaluateCurrentLeadMatch(lead('CXL', null), CANCEL, evt(), NOW).pass, false);
});

test('appointment_within_days (Sharyn Blake): an April CXL first synced on 9/30 does not route', () => {
  const april = { ...lead('CXL'), lp_lead_id: '524525', appointment_date: '2026-04-16T14:00:00+00:00' };
  const v = evaluateCurrentLeadMatch(april, CANCEL, evt(), NOW);
  assert.equal(v.pass, false);
  assert.match(v.reason, /days ago/);
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
  assert.match(formatF0AuditReport({ total: 390, flagged: [] }), /0 of 390 .*0 demos missing — clean/);
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

// 2026-10-01 — the audit's other direction: demoed recently, not in F.0.
test('missing: recent OPPFDN demo without active-f.0 is missing; in F.0, excluded, old or unread is not', () => {
  const demo = [lead('OPPFDN', 1)];
  assert.equal(isMissingFromF0(demo, ['lp-demo-completed'], NOW), true);
  assert.equal(isMissingFromF0(demo, ['active-f.0'], NOW), false);
  assert.equal(isMissingFromF0(demo, ['Customer'], NOW), false);
  assert.equal(isMissingFromF0(demo, undefined, NOW), false, 'not in the HL cache is not missing');
  assert.equal(isMissingFromF0([lead('OPPFDN', 20)], [], NOW), false);
  assert.equal(isMissingFromF0([lead('OPPFDN', -1)], [], NOW), false);
  assert.equal(isMissingFromF0([lead('Sale', 1)], [], NOW), false);
});

test('missing (Sharyn Blake): a blank Data lead on top of the demo lead does not hide it', () => {
  const demoLead = { ...lead('OPPFDN', 1), lp_lead_id: '579801', created_at_lp: '2026-09-28T10:10:40Z' };
  const data = { lp_lead_id: '579804', disposition_code: 'Data', appointment_date: null, created_at_lp: '2026-09-28T10:14:53Z' };
  assert.equal(isMissingFromF0([demoLead, data], [], NOW), true);
});

test('missing report: lists the demos that never reached F.0', () => {
  const text = formatF0AuditReport({ total: 390, flagged: [], missing: [{ contact_id: 'c9', lp_lead_id: 'L9' }] });
  assert.match(text, /NOT in F\.0: 1/);
  assert.match(text, /c9 · lead L9/);
});

function fakeSupabase(rows) {
  return {
    from() {
      const filters = [];
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        gte(k, v) { filters.push((r) => r[k] && r[k] >= v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        not(k) { filters.push((r) => r[k] != null); return q; },
        is() { return q; },
        limit() { return q; },
        then(res) { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(res); },
      };
      return q;
    },
  };
}

test('runF0IntegrityAudit: reports a demo that is missing from F.0 and posts nothing when post=false', async () => {
  const rows = [
    { ghl_contact_id: 'in-f0', ...lead('OPPFDN', 2) },
    { ghl_contact_id: 'missed', ...lead('OPPFDN', 1), lp_lead_id: 'L-missed' },
  ];
  const hl = { 'in-f0': ['active-f.0'], missed: ['lp-demo-completed'] };
  const deps = {
    supabase: fakeSupabase(rows),
    nowMs: NOW,
    hlRunSQL: async (sql) => (/unnest\(tags\)/.test(sql)
      ? [{ ghl_contact_id: 'in-f0' }]
      : Object.entries(hl).filter(([id]) => sql.includes(`'${id}'`)).map(([id, tags]) => ({ ghl_contact_id: id, tags }))),
    sendAlertMessage: async () => { throw new Error('must not post'); },
  };
  const r = await runF0IntegrityAudit({ post: false, deps });
  assert.equal(r.ok, true);
  assert.deepEqual(r.flagged, []);
  assert.deepEqual(r.missing, [{ contact_id: 'missed', lp_lead_id: 'L-missed' }]);
  assert.match(r.text, /NOT in F\.0: 1/);
});

// 2026-10-01 — lp_disposition_in judges the CURRENT lead, not the last-synced one.
test('lp_disposition_in (Sharyn Blake): an old CXL lead synced last does not route when a newer lead is live', async () => {
  const rows = [
    { ghl_contact_id: 'c-sb', lp_lead_id: '524525', disposition_code: 'CXL', appointment_date: '2026-04-16T14:00:00+00:00',
      created_at_lp: '2026-04-07T13:45:10Z', updated_at_lp: '2026-04-15T19:58:50Z' },
    { ghl_contact_id: 'c-sb', lp_lead_id: '579801', disposition_code: 'Cnf', appointment_date: '2026-10-01T14:00:00+00:00',
      created_at_lp: '2026-09-30T10:10:40Z', updated_at_lp: '2026-09-30T10:20:00Z' },
  ];
  const ev = { id: 1, ghl_contact_id: 'c-sb', event_type: 'lp.disposition_changed', payload: {} };
  const deps = { supabase: fakeSupabase(rows) };
  assert.equal(await evaluateContextConditions({ lp_disposition_in: ['CXL', 'CCC'] }, {}, ev, { ruleKey: 'T', deps }), false);
  assert.equal(await evaluateContextConditions({ lp_disposition_in: ['Cnf'] }, {}, ev, { ruleKey: 'T', deps }), true);
});

test('S5.2 cancel gate: an April CXL that is the only lead still fails appointment_within_days', async () => {
  const rows = [{ ghl_contact_id: 'c-old', lp_lead_id: '524525', disposition_code: 'CXL',
    appointment_date: '2026-04-16T14:00:00+00:00', created_at_lp: '2026-04-07T13:45:10Z' }];
  const ev = { id: 2, ghl_contact_id: 'c-old', event_type: 'lp.disposition_changed', payload: {} };
  const deps = { supabase: fakeSupabase(rows), nowMs: NOW };
  const cond = { lp_disposition_in: ['CXL', 'CCC'], lp_current_lead_match: { appointment_within_days: 14 } };
  assert.equal(await evaluateContextConditions(cond, {}, ev, { ruleKey: 'T', deps }), false);
  const fresh = [{ ...rows[0], appointment_date: daysAgo(-2) }];
  assert.equal(await evaluateContextConditions(cond, {}, ev, { ruleKey: 'T', deps: { supabase: fakeSupabase(fresh), nowMs: NOW } }), true);
});

// 2026-10-01 — lp_had_demo (Mark: a lead that had a demo does not go to S5.2
// via 1Leg or "ghost after booking"). LP demo truth, not the lagging tag.
test('lp_had_demo:false blocks a contact with a demo on any lead or appointment; passes one without', async () => {
  const ev = (cid) => ({ id: 3, ghl_contact_id: cid, event_type: 'confirmation_unacknowledged', payload: {} });
  const rows = [
    // Van De Velde: 1Leg on one lead, demo (OPPFDN) on the next.
    { ghl_contact_id: 'demoed', disposition_code: '1Leg' },
    { ghl_contact_id: 'demoed', disposition_code: 'OPPFDN' },
    // A NoRehash demo, then a rebooked appointment on the same lead.
    { ghl_contact_id: 'appt-demo', disposition_code: 'Set', appts: [{ disposition: 'NoRehash' }, { disposition: 'Set' }] },
    // NOC is not a demo (src/demo-truth.js).
    { ghl_contact_id: 'no-demo', disposition_code: '1Leg', appts: [{ disposition: 'NOC' }] },
  ];
  const deps = { supabase: fakeSupabase(rows) };
  const cond = { lp_had_demo: false };
  assert.equal(await evaluateContextConditions(cond, {}, ev('demoed'), { ruleKey: 'T', deps }), false);
  assert.equal(await evaluateContextConditions(cond, {}, ev('appt-demo'), { ruleKey: 'T', deps }), false);
  assert.equal(await evaluateContextConditions(cond, {}, ev('no-demo'), { ruleKey: 'T', deps }), true);
  assert.equal(await evaluateContextConditions(cond, {}, ev('no-leads'), { ruleKey: 'T', deps }), true, 'no LP lead = no demo');
  assert.equal(await evaluateContextConditions({ lp_had_demo: true }, {}, ev('demoed'), { ruleKey: 'T', deps }), true);
});

test('lp_had_demo: a failed LP read fails closed', async () => {
  const broken = { from: () => { const q = { select: () => q, eq: () => q, is: () => q, limit: () => q,
    then: (res) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(res) }; return q; } };
  const emitted = [];
  const deps = { supabase: broken, emitEvent: async (e) => { emitted.push(e); } };
  const ev = { id: 4, ghl_contact_id: 'c-x', event_type: 'lp.disposition_changed', payload: {} };
  assert.equal(await evaluateContextConditions({ lp_had_demo: false }, {}, ev, { ruleKey: 'T', deps }), false);
});
