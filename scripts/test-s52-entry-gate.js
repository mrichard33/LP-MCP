// 2026-10-02 — S5.2 entry gate (src/s52-entry-gate.js), the 30-minute cancel
// re-check (src/s52-cancel-recheck.js), the quieter F.0 / S5.2 audit, the
// one-time cleanup planner and the SI-3 live-tag confirmation. Mark's rules:
// S5.2 is no demo ever, never with a live appointment on ANY lead (read LP
// live), never current-lead Issue, never canvassing, never No Demo/ND/NOC, and
// a failed read never lets anyone in.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const gate = await import('../src/s52-entry-gate.js');
const recheck = await import('../src/s52-cancel-recheck.js');
const audit = await import('../src/jobs/f0-integrity-audit.js');
const cleanup = await import('../src/admin/cleanup-2026-10-02-f0-s52.js');
const { checkNoDuplicateWorkflowEnrollment } = await import('../src/services/validation/invariants/stage-integrity.js');

const NOW = Date.parse('2026-10-02T16:00:00Z'); // 12:00 ET
const S52_WF = '0a6a1349-0b44-429b-91e1-4c5be264cd9f';
// lp_leads stores the ET wall clock tagged +00:00.
const row = (id, disp, appt, created, extra = {}) => ({
  lp_lead_id: id, lp_prospect_id: 'P1', disposition_code: disp,
  appointment_date: appt, created_at_lp: created, updated_at_lp: created, ...extra,
});

// ── tiny chainable Supabase fake: tables of rows, records writes ─────
function fakeDb(tables = {}) {
  const writes = [];
  const db = {
    writes,
    from(table) {
      const filters = [];
      let op = 'select';
      let payload = null;
      const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        gte(k, v) { filters.push((r) => r[k] != null && r[k] >= v); return q; },
        lt(k, v) { filters.push((r) => r[k] != null && r[k] < v); return q; },
        not(k) { filters.push((r) => r[k] != null); return q; },
        is(k, v) { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
        contains(k, obj) { filters.push((r) => Object.entries(obj).every(([kk, vv]) => r[k]?.[kk] === vv)); return q; },
        limit() { return q; },
        delete() { op = 'delete'; return q; },
        upsert(p) { op = 'upsert'; payload = p; return q; },
        insert(p) { op = 'insert'; payload = p; return q; },
        single() { return q.then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); },
        maybeSingle() { return q.single(); },
        then(res, rej) {
          let out;
          if (op === 'select') out = { data: rows(), error: null };
          else {
            writes.push({ table, op, payload, matched: op === 'delete' ? rows().length : undefined });
            out = { data: op === 'insert' ? [{ id: 9001, ...payload }] : null, error: null };
          }
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
  return db;
}

// Live-read deps for one contact: GHL contact, lp_leads cache, LP prospects.
function liveDeps({ cache = [], tags = [], phone = '+15555550100', prospects = {}, phoneProspects = [], fail = null } = {}) {
  const calls = { ghl: 0, lp: 0, events: [] };
  return {
    calls,
    deps: {
      nowMs: NOW,
      supabase: fakeDb({ lp_leads: cache.map((r) => ({ ghl_contact_id: 'C1', lp_deleted_at: null, ...r })) }),
      ghlFetch: async () => { calls.ghl++; if (fail === 'ghl') throw new Error('GHL down'); return { contact: { id: 'C1', tags, phone } }; },
      getCustomers3: async () => { calls.lp++; if (fail === 'phone') throw new Error('LP 500'); return phoneProspects; },
      getProspectByCstId: async (pid) => {
        calls.lp++;
        if (fail === 'prospect') throw new Error('Execution Timeout Expired');
        return prospects[pid] ? [prospects[pid]] : [];
      },
      emitEvent: async (e) => { calls.events.push(e); return { id: 1 }; },
    },
  };
}

const gatedAction = (state = 'APPOINTMENT_DISRUPTION.cancelled') => ({
  id: 77, event_id: 55, target_id: 'C1', rule_applied: 'STATE_ENROLLMENT',
  action_payload: { workflow_id: S52_WF, webhook_url: 'https://x/hooks/ZXz0xlpBilGAkbJEbDHy', state_code: state },
});

// ── Gate: pure rules ──────────────────────────────────────────────────

test('gate: blocks a demo on an OLDER lead even when the current lead is a plain CXL', () => {
  const leads = [
    row('1', 'OPPFDN', '2026-08-10T14:00:00+00:00', '2026-08-01T10:00:00+00:00'),
    row('2', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00'),
  ];
  assert.equal(gate.evaluateS52Entry({ leads, tags: [], nowMs: NOW }).reason, 'demo_on_any_lead');
});

test('gate: demo hiding in an appointment-level disposition still counts', () => {
  const leads = [row('1', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-01T10:00:00+00:00', { appts: [{ disposition: 'NoRehash' }] })];
  assert.equal(gate.evaluateS52Entry({ leads, tags: [], nowMs: NOW }).reason, 'demo_on_any_lead');
});

test('gate: blocks current-lead Issue (appointment already past)', () => {
  const leads = [row('1', 'Issue', '2026-09-30T14:00:00+00:00', '2026-09-20T10:00:00+00:00')];
  assert.equal(gate.evaluateS52Entry({ leads, tags: [], nowMs: NOW }).reason, 'current_lead_issue');
});

test('gate: live appointment = Set/Cnf/Verif/Issue dated today or later (ET), on ANY lead', () => {
  for (const disp of ['Set', 'Cnf', 'Verif', 'Issue']) {
    const leads = [
      row('1', disp, '2026-10-02T18:00:00+00:00', '2026-09-01T10:00:00+00:00'), // today, later ET
      row('2', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00'),
    ];
    assert.equal(gate.evaluateS52Entry({ leads, tags: [], nowMs: NOW }).reason, 'live_appointment', disp);
  }
  // Earlier today still counts: the rule is the calendar day.
  assert.equal(gate.evaluateS52Entry({ leads: [row('1', 'Set', '2026-10-02T08:00:00+00:00', '2026-09-01T10:00:00+00:00'),
    row('2', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00')], tags: [], nowMs: NOW }).reason, 'live_appointment');
});

test('gate: an old lead stuck at "Set" with a past date does not block forever', () => {
  const leads = [
    row('1', 'Set', '2026-03-01T14:00:00+00:00', '2026-02-20T10:00:00+00:00'),
    row('2', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00'),
  ];
  assert.equal(gate.evaluateS52Entry({ leads, tags: [], nowMs: NOW }).allow, true);
});

test('gate: blocks a canvassing contact even with a prior inbound (any of the three markers, any case)', () => {
  const leads = [row('1', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00')];
  for (const tag of ['active-entry:canvassing', 'Entry:Canvassing', 'source:canvass']) {
    assert.equal(gate.evaluateS52Entry({ leads, tags: [tag, 'has-inbound'], nowMs: NOW }).reason, 'canvassing', tag);
  }
});

test('gate: blocks current lead No Demo / ND / NOC (NOC is not a demo, but still never enters)', () => {
  for (const disp of ['No Demo', 'ND', 'NOC']) {
    const leads = [row('1', disp, '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00')];
    assert.equal(gate.evaluateS52Entry({ leads, tags: [], nowMs: NOW }).reason, 'current_lead_no_demo', disp);
  }
});

test('gate: allows a plain CXL with no demo and no live appointment', () => {
  const leads = [row('1', 'CXL', '2026-10-03T14:00:00+00:00', '2026-09-25T10:00:00+00:00')];
  const v = gate.evaluateS52Entry({ leads, tags: ['appt-cancelled'], nowMs: NOW });
  assert.equal(v.allow, true);
});

test('gate scope: only cancel/no-show/1Leg/be-back/ghost states, only the S5.2 workflows', () => {
  assert.equal(gate.isGatedState('APPOINTMENT_DISRUPTION.no_show'), true);
  assert.equal(gate.isGatedState('APPOINTMENT_DISRUPTION.be_back'), true);
  assert.equal(gate.isGatedState('APPOINTMENT_FRICTION.ghost_after_booking'), true);
  assert.equal(gate.isGatedState('APPOINTMENT_FRICTION.timing_delay'), false);
  assert.equal(gate.isGatedState(undefined), false);
  assert.equal(gate.isS52Target({ workflow_id: '613dbbbd-b7af-4be0-81fa-371f3e1d7b14' }), true);
  assert.equal(gate.isS52Target({ webhook_url: 'https://h/ZXz0xlpBilGAkbJEbDHy' }), true);
  assert.equal(gate.isS52Target({ workflow_id: '15f47572-9ffc-453d-995d-a1890441f290' }), false);
});

// ── Gate: live reads ──────────────────────────────────────────────────

test('gate (iPS9QrarjlzIV6WZR1kQ): a newer Set lead that lp_leads has not synced yet blocks, via LP live', async () => {
  const cache = [row('580100', '1Leg', '2026-09-30T14:00:00+00:00', '2026-09-20T10:00:00+00:00')];
  const prospect = {
    cst_id: 'P1',
    leads: [
      { id: '580100', disposition: '1Leg', apptdate: '2026-09-30T14:00:00', dateentered: '2026-09-20T10:00:00' },
      { id: '580145', disposition: 'Set', apptdate: '2026-10-06T14:00:00', dateentered: '2026-10-01T12:00:00' },
    ],
  };
  const { deps, calls } = liveDeps({ cache, prospects: { P1: prospect } });
  const out = await gate.gateS52Enrollment(gatedAction('APPOINTMENT_DISRUPTION.one_leg'), deps);
  assert.equal(out.skipped, true);
  assert.equal(out.action, 'skipped_s52_gate');
  assert.equal(out.reason, 's52_gate:live_appointment');
  assert.equal(out.gate_detail.lp_lead_id, '580145');
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].event_type, 's52.entry_blocked');
  assert.equal(calls.events[0].payload.reason, 'live_appointment');
  assert.equal(calls.events[0].bypass_filter, true);
});

test('gate: leads found only by PHONE (another prospect) are read too', async () => {
  const cache = [row('1', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-20T10:00:00+00:00')];
  const other = { cst_id: 'P9', leads: [{ id: '9', disposition: 'Sale', sold: 'true', apptdate: '2026-07-01T14:00:00', dateentered: '2026-06-20T10:00:00' }] };
  const { deps } = liveDeps({ cache, phoneProspects: [{ ProspectID: 'P9' }], prospects: { P9: other } });
  const v = await gate.checkS52Entry('C1', deps);
  assert.equal(v.reason, 'demo_on_any_lead');
});

test('gate: allows a plain CXL end to end, and records nothing', async () => {
  const cache = [row('1', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-20T10:00:00+00:00')];
  const { deps, calls } = liveDeps({ cache, prospects: { P1: { cst_id: 'P1', leads: [{ id: '1', disposition: 'CXL', apptdate: '2026-09-30T14:00:00', dateentered: '2026-09-20T10:00:00' }] } } });
  assert.equal(await gate.gateS52Enrollment(gatedAction(), deps), null);
  assert.equal(calls.events.length, 0);
});

test('gate: fails CLOSED on an LP read error, a phone lookup error, or a GHL read error', async () => {
  const cache = [row('1', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-20T10:00:00+00:00')];
  for (const fail of ['prospect', 'phone', 'ghl']) {
    const { deps, calls } = liveDeps({ cache, fail });
    const out = await gate.gateS52Enrollment(gatedAction(), deps);
    assert.equal(out?.skipped, true, fail);
    assert.match(out.reason, /^s52_gate:read_failed:/, fail);
    assert.equal(calls.events[0].event_type, 's52.entry_blocked', fail);
  }
});

test('gate: a pre-demo friction entry passes untouched — no reads at all', async () => {
  const { deps, calls } = liveDeps({ fail: 'ghl' });
  assert.equal(await gate.gateS52Enrollment(gatedAction('APPOINTMENT_FRICTION.timing_delay'), deps), null);
  assert.equal(await gate.gateS52Enrollment({ ...gatedAction(), action_payload: { workflow_id: '15f47572-9ffc-453d-995d-a1890441f290', state_code: 'APPOINTMENT_DISRUPTION.cancelled' } }, deps), null);
  assert.equal(calls.ghl, 0);
});

test('liveLeadRow maps an LP GetLead lead onto the lp_leads columns', () => {
  const r = gate.liveLeadRow({ cst_id: 77 }, { id: 5, disposition: 'Set', apptdate: '2026-10-06T14:00:00', dateentered: '2026-10-01T12:00:00', sold: 'false', appointments: [{ disposition: 'CXL' }] });
  assert.equal(r.lp_lead_id, '5');
  assert.equal(r.lp_prospect_id, '77');
  assert.equal(r.appointment_date, '2026-10-06T14:00:00+00:00');
  assert.equal(r.closed_won, false);
  assert.deepEqual(r.raw_lp_data.appointments, [{ disposition: 'CXL' }]);
});

// ── Recheck ───────────────────────────────────────────────────────────

test('recheck (Maria, lead 580116): Cnf → Set → CXL in 10 minutes still routes the cancel after 30 min', async () => {
  const leads = [row('580116', 'CXL', '2026-10-03T14:00:00+00:00', '2026-09-28T10:00:00+00:00')];
  const events = [];
  let rechecked = null;
  const out = await recheck.executeS52CancelRecheck(
    { id: 1, target_id: '0VcsATQcnXOM7jErFFY0', action_payload: { rule_key: 'LP_DISP_CANCEL_COLD_TO_S5_2', source_event_id: 42 } },
    {
      nowMs: NOW,
      supabase: fakeDb({ agent_actions: [] }),
      loadS52GateInputs: async () => ({ leads, tags: [] }),
      recheckRuleForEvent: async (eventId, ruleKey) => { rechecked = [eventId, ruleKey]; return { fired: true, reason: 'actions_created', created_action_ids: [10, 11] }; },
      emitEvent: async (e) => { events.push(e); },
    },
  );
  assert.equal(out.outcome, 'cancel_routed');
  assert.deepEqual(rechecked, [42, 'LP_DISP_CANCEL_COLD_TO_S5_2']);
  assert.equal(events[0].event_type, 's52.cancel_recheck_ran');
});

test('recheck: a real reschedule (CXL, then a new Set) logs reschedule_confirmed and routes nothing', async () => {
  const leads = [
    row('580116', 'CXL', '2026-10-01T14:00:00+00:00', '2026-09-20T10:00:00+00:00'),
    row('580200', 'Set', '2026-10-08T14:00:00+00:00', '2026-10-02T09:00:00+00:00'),
  ];
  const events = [];
  const out = await recheck.executeS52CancelRecheck(
    { id: 2, target_id: 'C2', action_payload: { rule_key: 'GHL_APPT_CANCELLED_REBOOK_COLD', source_event_id: 43 } },
    {
      nowMs: NOW,
      supabase: fakeDb({ agent_actions: [] }),
      loadS52GateInputs: async () => ({ leads, tags: [] }),
      recheckRuleForEvent: async () => { throw new Error('must not re-run the rule'); },
      emitEvent: async (e) => { events.push(e); },
    },
  );
  assert.equal(out.outcome, 'reschedule_confirmed');
  assert.equal(events[0].event_type, 's52.reschedule_confirmed');
  // Same lead re-booked (CXL → Set again) is a reschedule too.
  assert.equal(recheck.decideRecheck({ leads: [row('1', 'Set', '2026-10-09T14:00:00+00:00', '2026-09-20T10:00:00+00:00')], nowMs: NOW }).run, false);
});

test('recheck: a failed read stops (fail closed) and is never re-queued', async () => {
  const events = [];
  const out = await recheck.executeS52CancelRecheck(
    { id: 3, target_id: 'C3', action_payload: { rule_key: 'GHL_APPT_CANCELLED_REBOOK', source_event_id: 44 } },
    { nowMs: NOW, supabase: fakeDb({ agent_actions: [] }), loadS52GateInputs: async () => ({ error: 'read_failed:lp_leads' }), recheckRuleForEvent: async () => { throw new Error('no'); }, emitEvent: async (e) => { events.push(e); } },
  );
  assert.equal(out.skipped, true);
  assert.equal(out.deferred, undefined);
  assert.equal(events[0].event_type, 's52.cancel_recheck_failed');
});

test('recheck: a cancel a sibling rule already routed (reconciler marker case) is not routed twice', async () => {
  const events = [];
  const db = fakeDb({ agent_actions: [{ id: 5, target_id: 'C4', rule_applied: 'LP_DISP_CANCEL_COLD_TO_S5_2', created_at: '2026-10-02T15:31:00.000Z' }] });
  const out = await recheck.executeS52CancelRecheck(
    { id: 4, target_id: 'C4', created_at: '2026-10-02T15:30:00.000Z', action_payload: { rule_key: 'GHL_APPT_CANCELLED_REBOOK_COLD', source_event_id: 45 } },
    { nowMs: NOW, supabase: db, loadS52GateInputs: async () => { throw new Error('no read needed'); }, recheckRuleForEvent: async () => { throw new Error('no'); }, emitEvent: async (e) => { events.push(e); } },
  );
  assert.equal(out.outcome, 'already_routed');
  assert.equal(events[0].event_type, 's52.reschedule_confirmed');
});

test('audit S5.2: a cancel blocked only because a read FAILED is still listed as missed', async () => {
  const lp = {
    lp_leads: [lpRow('m-rf', 'A', 'CXL', '2026-10-03T14:00:00+00:00', '2026-09-28T10:00:00+00:00', { updated_at_lp: '2026-10-01T20:00:00+00:00' })],
    system_events: [{ ghl_contact_id: 'm-rf', event_type: 's52.entry_blocked', created_at: '2026-10-01T21:00:00Z', payload: { reason: 'read_failed:lp_phone' } }],
  };
  const { deps } = auditDeps({ hl: { 'm-rf': [] }, lp });
  const r = await audit.runF0IntegrityAudit({ post: false, deps });
  assert.deepEqual(r.s52.missed.map((m) => m.contact_id), ['m-rf']);
});

test('recheck queue: one row per event + rule, held 30 minutes, only for the three cancel rules', async () => {
  const db = fakeDb({ agent_actions: [] });
  const ev = { id: 500, ghl_contact_id: 'C1' };
  const r = await recheck.queueS52CancelRecheck(ev, 'LP_DISP_CANCEL_COLD_TO_S5_2', { supabase: db, nowMs: NOW });
  assert.equal(r.queued, true);
  const ins = db.writes.find((w) => w.op === 'insert');
  assert.equal(ins.payload.action_type, 's52_cancel_recheck');
  assert.equal(ins.payload.retry_at, new Date(NOW + 1800_000).toISOString());
  assert.equal(ins.payload.action_payload.not_before_seconds, 1800);

  const db2 = fakeDb({ agent_actions: [{ id: 7, event_id: 500, rule_applied: 'S52_CANCEL_RECHECK', action_payload: { rule_key: 'LP_DISP_CANCEL_COLD_TO_S5_2' } }] });
  assert.equal((await recheck.queueS52CancelRecheck(ev, 'LP_DISP_CANCEL_COLD_TO_S5_2', { supabase: db2, nowMs: NOW })).reason, 'already_queued');
  assert.equal((await recheck.queueS52CancelRecheck(ev, 'LP_DISP_CXL_TO_CANCELLED', { supabase: db2 })).reason, 'not_applicable');
  // GHL's cancel webhook for the same cancel: the contact already has one pending.
  const db3 = fakeDb({ agent_actions: [{ id: 8, event_id: 499, target_id: 'C1', status: 'pending', rule_applied: 'S52_CANCEL_RECHECK', action_payload: { rule_key: 'LP_DISP_CANCEL_COLD_TO_S5_2' } }] });
  assert.equal((await recheck.queueS52CancelRecheck(ev, 'GHL_APPT_CANCELLED_REBOOK_COLD', { supabase: db3, nowMs: NOW })).reason, 'contact_recheck_pending');
});

// ── Audit ─────────────────────────────────────────────────────────────

test('audit: a demo before F0_AUDIT_SINCE is not reported as missing; one after it is', () => {
  const since = audit.auditSinceMs({});
  assert.equal(since, Date.parse('2026-10-01T15:40:00Z'));
  const before = [row('1', 'OPPFDN', '2026-10-01T09:00:00+00:00', '2026-09-20T10:00:00+00:00')]; // 13:00Z
  const after = [row('1', 'OPPFDN', '2026-10-01T14:00:00+00:00', '2026-09-20T10:00:00+00:00')];  // 18:00Z
  assert.equal(audit.isMissingFromF0(before, [], NOW, since), false);
  assert.equal(audit.isMissingFromF0(after, [], NOW, since), true);
});

// Full-run harness: HL contacts by tag, LP tables, Slack sink.
function auditDeps({ hl = {}, lp = {}, posted = [], checkS52Entry, hlFails = false } = {}) {
  const sent = [];
  const db = fakeDb({ lp_leads: [], contact_objection_states: [], system_events: [], agent_actions: [], audit_posted_items: posted, ...lp });
  return {
    sent, db,
    deps: {
      nowMs: NOW,
      supabase: db,
      checkS52Entry: checkS52Entry || (async () => ({ allow: true })),
      sendAlertMessage: async (text) => { sent.push(text); },
      hlRunSQL: async (sql) => {
        if (hlFails) throw new Error('HL down');
        const tagged = (pred) => Object.entries(hl).filter(([, t]) => t.some(pred)).map(([id]) => ({ ghl_contact_id: id }));
        if (/unnest\(tags\)/.test(sql)) return tagged((t) => t === 'active-f.0');
        if (/unnest\(contacts\.tags\)/.test(sql)) return tagged((t) => ['active-s5.2', 'active-w5.2'].includes(t));
        return Object.entries(hl).filter(([id]) => sql.includes(`'${id}'`)).map(([id, tags]) => ({ ghl_contact_id: id, tags, first_name: 'Pat', last_name: id }));
      },
    },
  };
}
const lpRow = (cid, ...args) => ({ ghl_contact_id: cid, lp_deleted_at: null, ...row(...args) });

test('audit: a clean run posts nothing and is still ok (runJob records it)', async () => {
  const { deps, sent } = auditDeps();
  const r = await audit.runF0IntegrityAudit({ post: true, deps });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 0);
  assert.deepEqual(sent, []);
});

test('audit: an already-posted item is not re-posted; a new one is, one line per contact, and recorded', async () => {
  const lp = { lp_leads: [
    lpRow('f-old', 'A', 'CXL', '2026-09-20T14:00:00+00:00', '2026-09-10T10:00:00+00:00'),
    lpRow('f-new', 'B', 'Sale', '2026-09-25T14:00:00+00:00', '2026-09-12T10:00:00+00:00', { closed_won: true }),
  ] };
  const posted = [{ audit: 'f0-s52-integrity', contact_id: 'f-old', reason: 'f0_flag:CXL', posted_at: '2026-10-01T12:00:00Z' }];
  const { deps, sent, db } = auditDeps({ hl: { 'f-old': ['active-f.0'], 'f-new': ['active-f.0'] }, lp, posted });
  const r = await audit.runF0IntegrityAudit({ post: true, deps });
  assert.equal(r.items.length, 2);
  assert.equal(r.posted, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /1 new problem\(s\) \(1 already posted\)/);
  assert.match(sent[0], /• Pat f-new · f-new · in F\.0 — current disposition is Sale, not OPPFDN · remove from F\.0/);
  assert.doesNotMatch(sent[0], /f-old/);
  const up = db.writes.find((w) => w.table === 'audit_posted_items' && w.op === 'upsert');
  assert.deepEqual(up.payload.map((p) => [p.contact_id, p.reason]), [['f-new', 'f0_flag:Sale']]);

  // Everything already posted → no card at all.
  const again = auditDeps({ hl: { 'f-old': ['active-f.0'] }, lp: { lp_leads: [lp.lp_leads[0]] }, posted });
  await audit.runF0IntegrityAudit({ post: true, deps: again.deps });
  assert.deepEqual(again.sent, []);
});

test('audit: a read failure still posts "could not run"', async () => {
  const { deps, sent } = auditDeps({ hlFails: true });
  const r = await audit.runF0IntegrityAudit({ post: true, deps });
  assert.equal(r.ok, false);
  assert.match(sent[0], /could not run: HL down/);
});

test('audit card: at most 10 lines plus "N more"', () => {
  const items = Array.from({ length: 13 }, (_, i) => ({ contact_id: `c${i}`, name: 'N', wrong: 'w', todo: 't' }));
  const card = audit.formatAuditCard(items);
  assert.equal(card.split('\n').filter((l) => l.startsWith('•')).length, 10);
  assert.match(card, /and 3 more/);
});

test('audit S5.2: flags a demoed contact in S5.2 (confirmed live); leaves a pre-demo friction contact alone', async () => {
  const lp = {
    lp_leads: [
      lpRow('s-demo', 'A', 'OPPFDN', '2026-09-20T14:00:00+00:00', '2026-09-10T10:00:00+00:00'),
      lpRow('s-fric', 'B', 'Set', '2026-10-05T14:00:00+00:00', '2026-09-28T10:00:00+00:00'),
    ],
    contact_objection_states: [
      { contact_id: 's-demo', state_code: 'APPOINTMENT_DISRUPTION.cancelled', entered_at: '2026-09-21', exited_at: null },
      { contact_id: 's-fric', state_code: 'APPOINTMENT_FRICTION.timing_delay', entered_at: '2026-09-29', exited_at: null },
    ],
  };
  const checked = [];
  const { deps } = auditDeps({ hl: { 's-demo': ['active-s5.2'], 's-fric': ['active-s5.2'] }, lp,
    checkS52Entry: async (id) => { checked.push(id); return { allow: false, reason: 'demo_on_any_lead' }; } });
  const r = await audit.runF0IntegrityAudit({ post: false, deps });
  assert.deepEqual(r.s52.flagged, [{ contact_id: 's-demo', reason: 'demo_on_any_lead', confirmed: true }]);
  assert.deepEqual(checked, ['s-demo']);
  assert.match(r.text, /S5\.2 integrity: 1 of 2/);
});

test('audit S5.2: a new no-demo cancel that never reached S5.2 is listed; one blocked on purpose is not', async () => {
  const cxl = (cid, id) => lpRow(cid, id, 'CXL', '2026-10-03T14:00:00+00:00', '2026-09-28T10:00:00+00:00', { updated_at_lp: '2026-10-01T20:00:00+00:00' });
  const lp = {
    lp_leads: [cxl('m-miss', 'A'), cxl('m-block', 'B'), cxl('m-old', 'C')].map((r) => (r.ghl_contact_id === 'm-old' ? { ...r, updated_at_lp: '2026-09-29T12:00:00+00:00' } : r)),
    system_events: [{ ghl_contact_id: 'm-block', event_type: 's52.entry_blocked', created_at: '2026-10-01T21:00:00Z' }],
  };
  const { deps } = auditDeps({ hl: { 'm-miss': [], 'm-block': [], 'm-old': [] }, lp });
  const r = await audit.runF0IntegrityAudit({ post: false, deps });
  assert.deepEqual(r.s52.missed.map((m) => m.contact_id), ['m-miss']);
  assert.equal(r.items.find((i) => i.reason === 's52_missed_cancel').todo, 'check why S5.2 did not enroll');
});

// ── Cleanup planner ───────────────────────────────────────────────────

test('cleanup S5.2 planner: demo / Issue / live appt out; friction kept; canvassing out only when it is a cancel', () => {
  const cxl = [row('1', 'CXL', '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00')];
  const plan = (o) => cleanup.planS52Contact({ nowMs: NOW, stateCode: 'APPOINTMENT_DISRUPTION.cancelled', tags: [], leads: cxl, ...o });
  assert.deepEqual(plan({ leads: [row('1', 'OPPFDN', '2026-09-20T14:00:00+00:00', '2026-09-10T10:00:00+00:00')] }), { remove: true, reason: 'demo_on_any_lead' });
  assert.equal(plan({ leads: [row('1', 'Issue', '2026-09-30T14:00:00+00:00', '2026-09-25T10:00:00+00:00')] }).reason, 'current_lead_issue');
  assert.equal(plan({ stateCode: 'APPOINTMENT_FRICTION.timing_delay', leads: [row('1', 'Set', '2026-10-05T14:00:00+00:00', '2026-09-25T10:00:00+00:00')] }).reason, 'friction_state_kept');
  assert.deepEqual(plan({ tags: ['active-entry:canvassing', 'appt-cancelled'] }), { remove: true, reason: 'canvassing_cancel' });
  assert.deepEqual(plan({ tags: ['active-entry:canvassing'] }), { remove: false, reason: 'canvassing_not_cancel_kept' });
  assert.deepEqual(plan({}), { remove: false, reason: 'passes_gate' });
});

test('cleanup Gaby planner: enroll only without active-f.0, current lead 579452 OPPFDN, demo in the last 14 days', () => {
  const lead = row('579452', 'OPPFDN', '2026-09-29T14:00:00+00:00', '2026-09-20T10:00:00+00:00');
  assert.equal(cleanup.planGaby({ leads: [lead], tags: [], nowMs: NOW }).enroll, true);
  assert.equal(cleanup.planGaby({ leads: [lead], tags: ['active-f.0'], nowMs: NOW }).reason, 'already_has_active_f0');
  assert.equal(cleanup.planGaby({ leads: [{ ...lead, disposition_code: 'Sale' }], tags: [], nowMs: NOW }).enroll, false);
  assert.equal(cleanup.planGaby({ leads: [{ ...lead, appointment_date: '2026-09-01T14:00:00+00:00' }], tags: [], nowMs: NOW }).reason, 'demo_not_in_last_14_days');
});

test('cleanup run (report): flags without writing; a failed read is skipped, never changed', async () => {
  const writes = [];
  const leadsByContact = {
    'f-sale': [row('1', 'Sale', '2026-09-20T14:00:00+00:00', '2026-09-10T10:00:00+00:00', { closed_won: true })],
    's-demo': [row('2', 'OPPFDN', '2026-09-20T14:00:00+00:00', '2026-09-10T10:00:00+00:00')],
  };
  const deps = {
    __noDefaults: true,
    nowMs: NOW,
    sleep: async () => {},
    supabase: fakeDb({ contact_objection_states: [], lp_leads: [] }),
    hlRunSQL: async (sql) => (sql.includes("'active-f.0'") ? [{ ghl_contact_id: 'f-sale' }, { ghl_contact_id: 'f-broken' }] : [{ ghl_contact_id: 's-demo' }]),
    ghlFetch: async (method, path) => {
      if (method !== 'GET') { writes.push([method, path]); return {}; }
      if (path.includes('f-broken')) throw new Error('GHL 500');
      return { contact: { tags: ['active-f.0', 'active-s5.2'], phone: '' } };
    },
    getCustomers3: async () => [],
    getProspectByCstId: async () => [],
    emitEvent: async () => ({}),
    fetch: async () => { throw new Error('report must not POST'); },
  };
  // Cache rows per contact through the lp_leads fake.
  deps.supabase = fakeDb({
    contact_objection_states: [],
    lp_leads: Object.entries(leadsByContact).flatMap(([cid, rows]) => rows.map((r) => ({ ...r, ghl_contact_id: cid, lp_deleted_at: null }))),
  });
  const s = await cleanup.runCleanup({ mode: 'report', deps });
  assert.equal(s.f0.flagged, 1);
  assert.deepEqual(s.f0.by_reason, { 'not_oppfdn:Sale': 1 });
  assert.equal(s.f0.read_failed, 1);
  assert.equal(s.s52.flagged, 1);
  assert.deepEqual(s.s52.by_reason, { demo_on_any_lead: 1 });
  assert.deepEqual(writes, []);
  assert.equal(s.gaby.action, 'none');
});

// ── SI-3: confirm the snapshot with GHL before rejecting (Gaby, action 535417) ──

test('SI-3: snapshot says active-f.0 but GHL live does not → passes and fixes the snapshot', async () => {
  const fixed = [];
  const action = { action_type: 'add_to_workflow', target_id: 'zPSEN55i7yCjbjlnSoKu', action_payload: { canonical_code: 'F.0' } };
  const deps = {
    loadContactTags: async () => new Set(['active-f.0']),
    ghlFetch: async () => ({ contact: { tags: ['lp-demo-completed'] } }),
    applyTagsToSnapshot: async (id, ch) => { fixed.push([id, ch]); },
  };
  const r = await checkNoDuplicateWorkflowEnrollment(action, { deps });
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'snapshot_stale_live_clear');
  assert.deepEqual(fixed, [['zPSEN55i7yCjbjlnSoKu', { remove: ['active-f.0'] }]]);
});

test('SI-3: GHL live confirms the tag → still blocks; GHL unreadable → snapshot decides (blocks)', async () => {
  const action = { action_type: 'add_to_workflow', target_id: 'C1', action_payload: { canonical_code: 'F.0' } };
  const base = { loadContactTags: async () => new Set(['active-f.0']), applyTagsToSnapshot: async () => {} };
  assert.equal((await checkNoDuplicateWorkflowEnrollment(action, { deps: { ...base, ghlFetch: async () => ({ contact: { tags: ['Active-F.0'] } }) } })).passed, false);
  assert.equal((await checkNoDuplicateWorkflowEnrollment(action, { deps: { ...base, ghlFetch: async () => { throw new Error('down'); } } })).passed, false);
});
