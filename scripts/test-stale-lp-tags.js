// 2026-10-11 — old LP leads must not tag a returning contact (Frances Overton,
// wkUjSVicxP6918ll9nHc). Her new calculator lead (582736) linked nine older
// leads to the contact; Day 15 fired from leads 15+ days old and a 2024 OPPFDN
// made her lp-demo-completed. Day 15 now fires for the contact's current lead
// only, and a demo counts for the current sales cycle only (demo-truth.js).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { checkDay15Handoffs, checkDay15Handoff, checkLeadTriggers, day15Verdict, DAY15_TAG } =
  await import('../src/sync-triggers.js');
const { demoInCurrentCycle, currentCycleDemoLead, DEMO_CYCLE_DAYS } = await import('../src/demo-truth.js');
const { buildMergedLead, syncLeadFieldsToGHL } = await import('../src/ghl-field-sync.js');
const { buildGHLFieldPayload } = await import('../src/ghl-field-map.js');
const { _internal } = await import('../src/decision-engine.js');

const NOW = Date.parse('2026-10-11T15:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const DEMO_FIELD = 'j84cNc7Rk6BkiYdZwuOO';

// ── a tiny PostgREST stand-in: filters rows, records writes ─────────
function fakeDb(rows, { failIn = false } = {}) {
  const updates = [];
  const logs = [];
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\d/.test(v) ? Date.parse(v) : v);
  const client = {
    updates, logs,
    from(table) {
      const filters = [];
      let op = 'select';
      let patch = null;
      let limit = Infinity;
      const run = async () => {
        if (table === 'lp_trigger_log') return { data: null, error: null };
        if (op === 'update') {
          for (const r of rows.filter(r => filters.every(f => f(r)))) { Object.assign(r, patch); updates.push({ id: r.lp_lead_id, patch }); }
          return { data: null, error: null };
        }
        if (failIn && filters.some(f => f.isIn)) return { data: null, error: { message: 'boom' } };
        return { data: rows.filter(r => filters.every(f => f(r))).slice(0, limit), error: null };
      };
      const b = {
        select() { return b; },
        eq(c, v) { filters.push(r => String(r[c]) === String(v)); return b; },
        lt(c, v) { filters.push(r => val(r[c]) < val(v)); return b; },
        gte(c, v) { filters.push(r => val(r[c]) >= val(v)); return b; },
        not(c, o, v) { filters.push(r => !(o === 'is' && v === null ? r[c] == null : r[c] === v)); return b; },
        is(c, v) { filters.push(r => (v === null ? r[c] == null : r[c] === v)); return b; },
        in(c, vs) { const f = r => vs.map(String).includes(String(r[c])); f.isIn = true; filters.push(f); return b; },
        limit(n) { limit = n; return b; },
        update(p) { op = 'update'; patch = p; return b; },
        insert(row) { logs.push({ table, ...row }); return Promise.resolve({ data: null, error: null }); },
        then(res, rej) { return run().then(res, rej); },
      };
      return b;
    },
  };
  return client;
}

const lead = (o) => ({ lp_day15_triggered: false, closed_won: false, last_contact_date: null,
  disposition_code: 'Data', appointment_date: null, updated_at_lp: o.created_at_lp, lp_deleted_at: null, ...o });

// ── Day 15 ─────────────────────────────────────────────────────────

test('day15: an old lead with a newer lead on the contact does not tag, and is marked suppressed', async () => {
  const rows = [
    lead({ lp_lead_id: 'old', ghl_contact_id: 'C1', created_at_lp: daysAgo(60) }),
    lead({ lp_lead_id: 'new', ghl_contact_id: 'C1', created_at_lp: daysAgo(1) }),
  ];
  const db = fakeDb(rows);
  const tagged = [];
  const stats = await checkDay15Handoffs({ supabase: db, nowMs: NOW, applyGHLTag: async (id, t) => { tagged.push([id, t]); return true; } });
  assert.deepEqual(tagged, []);
  assert.equal(stats.suppressed, 1);
  assert.equal(rows[0].lp_day15_triggered, true, 'the old lead is marked so it is not re-read every pass');
  assert.equal(rows[1].lp_day15_triggered, false, 'the new lead is untouched');
  assert.equal(db.logs.length, 1);
  assert.equal(db.logs[0].status, 'suppressed');
  assert.match(db.logs[0].error_detail, /superseded_by_newer_lead: current lead new/);
});

test('day15: a single lead aged 16 days still fires (no regression)', async () => {
  const rows = [lead({ lp_lead_id: 'only', ghl_contact_id: 'C2', created_at_lp: daysAgo(16) })];
  const db = fakeDb(rows);
  const tagged = [];
  const stats = await checkDay15Handoffs({ supabase: db, nowMs: NOW, applyGHLTag: async (id, t) => { tagged.push([id, t]); return true; } });
  assert.deepEqual(tagged, [['C2', DAY15_TAG]]);
  assert.equal(stats.triggered, 1);
  assert.equal(rows[0].lp_day15_triggered, true);
  assert.equal(db.logs[0].status, 'success');
});

test('day15: Frances — nine old leads under a lead made today: nothing fires', async () => {
  const rows = [
    lead({ lp_lead_id: '582736', ghl_contact_id: 'F', created_at_lp: daysAgo(0.2) }),
    lead({ lp_lead_id: '447061', ghl_contact_id: 'F', created_at_lp: '2025-09-03T12:43:22Z' }),
    lead({ lp_lead_id: '386011', ghl_contact_id: 'F', created_at_lp: '2025-02-13T09:06:55Z' }),
    lead({ lp_lead_id: '339624', ghl_contact_id: 'F', created_at_lp: '2024-07-30T16:41:28Z', disposition_code: 'OPPFDN', appointment_date: '2024-07-31T10:00:00Z' }),
  ];
  const tagged = [];
  const stats = await checkDay15Handoffs({ supabase: fakeDb(rows), nowMs: NOW, applyGHLTag: async (id) => { tagged.push(id); return true; } });
  assert.deepEqual(tagged, []);
  assert.equal(stats.suppressed, 3);
});

test('day15: an unreadable sibling read tags nothing and marks nothing (fail closed)', async () => {
  const rows = [lead({ lp_lead_id: 'x', ghl_contact_id: 'C3', created_at_lp: daysAgo(20) })];
  const tagged = [];
  const stats = await checkDay15Handoffs({ supabase: fakeDb(rows, { failIn: true }), nowMs: NOW, applyGHLTag: async (id) => { tagged.push(id); return true; } });
  assert.deepEqual(tagged, []);
  assert.equal(stats.unreadable, 1);
  assert.equal(rows[0].lp_day15_triggered, false);
});

test('day15 single-lead path: a newer current lead suppresses; the current lead itself fires', async () => {
  const db = fakeDb([lead({ lp_lead_id: 'old', ghl_contact_id: 'C4', created_at_lp: daysAgo(40) })]);
  const tagged = [];
  const applyGHLTag = async (id) => { tagged.push(id); return true; };
  await checkDay15Handoff('old', 'C4', daysAgo(40), 'Data', {
    supabase: db, nowMs: NOW, applyGHLTag,
    fetchCurrentLead: async () => ({ lp_lead_id: 'new', created_at_lp: daysAgo(2), disposition_code: 'Data' }),
  });
  assert.deepEqual(tagged, []);
  assert.equal(db.logs[0].status, 'suppressed');

  await checkDay15Handoff('cur', 'C5', daysAgo(1), 'Data', {
    supabase: fakeDb([]), nowMs: NOW, applyGHLTag,
    // LP passed a 1-day-old entry date (another lead's); lp_leads knows better.
    fetchCurrentLead: async () => ({ lp_lead_id: 'cur', created_at_lp: daysAgo(16), disposition_code: 'Data' }),
  });
  assert.deepEqual(tagged, ['C5']);
});

test('day15 single-lead path: a failed current-lead read does not tag', async () => {
  const tagged = [];
  await checkDay15Handoff('a', 'C6', daysAgo(30), 'Data', {
    supabase: fakeDb([]), nowMs: NOW, applyGHLTag: async (id) => { tagged.push(id); return true; },
    fetchCurrentLead: async () => { throw new Error('read failed'); },
  });
  assert.deepEqual(tagged, []);
});

test('day15Verdict uses the shared current-lead rule (a blank Data lead does not outrank an appointment)', () => {
  const appt = lead({ lp_lead_id: 'appt', disposition_code: 'Set', appointment_date: daysAgo(3), created_at_lp: daysAgo(20) });
  const data = lead({ lp_lead_id: 'data', created_at_lp: daysAgo(10) });
  assert.equal(day15Verdict(appt, [appt, data]).action, 'fire');
  assert.equal(day15Verdict(data, [appt, data]).action, 'suppress');
});

// ── Demo: current sales cycle only ─────────────────────────────────

const oldDemo = { lp_lead_id: '339624', disposition_code: 'OPPFDN', appointment_date: '2024-07-31T10:00:00Z',
  created_at_lp: '2024-07-30T16:41:28Z', ghl_contact_id: 'F',
  appts: [{ disposition: 'OPPFDN', apptdate: '2024-07-31T10:00:00' }] };
const newData = { lp_lead_id: '582736', disposition_code: 'Data', appointment_date: null,
  created_at_lp: '2026-10-11T09:47:21Z', ghl_contact_id: 'F' };

test('demo: an old demo lead + a new non-demo lead is NOT a demo; the field reads No', () => {
  assert.equal(demoInCurrentCycle([oldDemo, newData]), false);
  const merged = buildMergedLead([oldDemo, newData]);
  assert.equal(merged.demo_completed, false);
  const field = buildGHLFieldPayload(merged).find(f => f.id === DEMO_FIELD);
  assert.equal(field?.field_value, 'No');
});

test('demo: a demo on an older lead within the cycle window still counts (rebook / duplicate lead)', () => {
  const demo = { lp_lead_id: 'd', disposition_code: 'OPPFDN', appointment_date: '2026-09-25T14:00:00Z', created_at_lp: '2026-09-20T00:00:00Z' };
  const rebook = { lp_lead_id: 'r', disposition_code: 'Set', appointment_date: '2026-10-20T14:00:00Z', created_at_lp: '2026-10-05T00:00:00Z' };
  assert.equal(currentCycleDemoLead([demo, rebook])?.lp_lead_id, 'd');
  assert.equal(buildMergedLead([demo, rebook]).demo_completed, true);
  // ...and stops counting once the demo is more than DEMO_CYCLE_DAYS before the current lead.
  const later = { ...rebook, created_at_lp: new Date(Date.parse(demo.appointment_date) + (DEMO_CYCLE_DAYS + 1) * 86400000).toISOString() };
  assert.equal(demoInCurrentCycle([demo, later]), false);
});

test('demo: a soft-deleted newer lead does not hide the current lead\'s demo', () => {
  const demo = { lp_lead_id: 'd', disposition_code: 'Sale', closed_won: true, created_at_lp: '2026-09-01T00:00:00Z' };
  const deleted = { lp_lead_id: 'x', disposition_code: 'Data', created_at_lp: '2026-10-10T00:00:00Z', lp_deleted_at: '2026-10-10T01:00:00Z' };
  assert.equal(demoInCurrentCycle([demo, deleted]), true);
});

test('demo tag: newest lead demoed → field sync stamps once; a second run does not re-tag', async () => {
  const demoLead = { lp_lead_id: 'n', ghl_contact_id: 'C7', disposition_code: 'OPPFDN', appointment_date: daysAgo(2),
    created_at_lp: daysAgo(5), ghl_fields_hash: null };
  const merged = buildMergedLead([oldDemo, demoLead]);
  assert.equal(merged.demo_completed, true);
  const stamped = [];
  const deps = {
    updateGHLContactFields: async () => true,
    emitEvent: async () => {},
    supabase: fakeDb([]),
    demoTagMode: 'live',
    executeAddTag: async (a) => { stamped.push(a.action_payload.tag); },
  };
  const first = await syncLeadFieldsToGHL(merged, 'C7', null, deps);
  assert.equal(first.pushed, true);
  const second = await syncLeadFieldsToGHL(merged, 'C7', first.hash, deps);
  assert.equal(second.pushed, false);
  assert.deepEqual(stamped, ['lp-demo-completed']);
});

test('demo tag: Frances — field sync never stamps from a 2024 demo', async () => {
  const stamped = [];
  await syncLeadFieldsToGHL(buildMergedLead([oldDemo, newData]), 'F', null, {
    updateGHLContactFields: async () => true, emitEvent: async () => {}, supabase: fakeDb([]),
    demoTagMode: 'live', executeAddTag: async (a) => { stamped.push(a.action_payload.tag); },
  });
  assert.deepEqual(stamped, []);
});

test('checkLeadTriggers no longer writes any tag (its demo half never matched a row)', async () => {
  assert.equal(await checkLeadTriggers(), undefined);
});

// ── Routing ────────────────────────────────────────────────────────

function routingDb(leads) {
  return {
    from(table) {
      const api = {
        select() { return api; }, eq() { return api; }, order() { return api; }, is() { return api; },
        limit() { return table === 'lp_leads' ? Promise.resolve({ data: leads, error: null }) : api; },
        async maybeSingle() { return { data: null, error: null }; },
      };
      return api;
    },
  };
}
const ghlFetch = (tags = []) => async () => ({
  ok: true, status: 200, headers: { get: () => null }, json: async () => ({ contact: { tags, customFields: [] } }),
});

test('routing: a 2024 demo does not make a new lead post-demo; a current demo does', async () => {
  const event = { id: 1, ghl_contact_id: 'F', payload: { buyer_stage: 2 } };
  const deps = (leads) => ({ supabase: routingDb(leads), fetch: ghlFetch([]), sleep: async () => {} });
  assert.equal(await _internal.resolveDemoState(event, {}, deps([oldDemo, newData])), 'pre');
  const current = { ...newData, disposition_code: 'OPPFDN', appointment_date: daysAgo(1) };
  assert.equal(await _internal.resolveDemoState({ ...event, id: 2 }, {}, deps([oldDemo, current])), 'post');
});

// ── cleanup-stale-lp-tags.js planner ───────────────────────────────

const { planCleanup } = await import('./cleanup-stale-lp-tags.js');

test('cleanup: Frances loses both tags; a real customer and an older contact keep theirs', () => {
  const now = Date.parse('2026-10-11T15:00:00Z');
  const fNew = { ...newData, ghl_intent_bucket: 'estimate-calculator', demo_completed: false };
  const contacts = [
    { ghl_contact_id: 'F', name: 'Frances C Overton', tags: ['lp-day15-handoff', 'lp-demo-completed', 'active-e.2', 'estimator-completed'] },
    { ghl_contact_id: 'CUST', name: 'Cust', tags: ['lp-demo-completed', 'deal-won'] },
    { ghl_contact_id: 'OLD', name: 'Old', tags: ['lp-day15-handoff'] },
    { ghl_contact_id: 'NOLP', name: 'No LP', tags: ['lp-demo-completed'] },
  ];
  const leads = new Map([
    ['F', [{ ...oldDemo, demo_completed: true }, fNew]],
    ['CUST', [{ ...oldDemo, ghl_contact_id: 'CUST', demo_completed: true }, { ...fNew, ghl_contact_id: 'CUST' }]],
    ['OLD', [{ lp_lead_id: 'o', created_at_lp: '2026-08-01T00:00:00Z', disposition_code: 'Data' }]],
  ]);
  const plan = planCleanup(contacts, leads, now);
  assert.deepEqual(plan.removals.map(r => [r.contact_id, r.tag]), [
    ['F', 'lp-day15-handoff'], ['F', 'lp-demo-completed'],
  ]);
  assert.equal(plan.removals[0].lead_id, '582736');
  assert.equal(plan.skipped.noLpLead, 1);
  assert.deepEqual(plan.callNow.map(r => r.contact_id), ['F'], 'listed for a CALL NOW decision, never fired');
});

test('cleanup: the demo tag stays when the current cycle has a demo (field sync would re-add it)', () => {
  const now = Date.parse('2026-10-11T15:00:00Z');
  const demo = { lp_lead_id: 'd', disposition_code: 'OPPFDN', appointment_date: '2026-10-01T14:00:00Z', created_at_lp: '2026-09-28T00:00:00Z', demo_completed: true };
  const rebook = { lp_lead_id: 'r', disposition_code: 'Set', created_at_lp: '2026-10-05T00:00:00Z', demo_completed: false };
  const plan = planCleanup([{ ghl_contact_id: 'X', name: 'X', tags: ['lp-demo-completed'] }], new Map([['X', [demo, rebook]]]), now);
  assert.deepEqual(plan.removals, []);
});
