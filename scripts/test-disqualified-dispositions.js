/**
 * ND and No Demo = disqualified (Mark, 2026-10-16, handoff v3.4 Fix 2).
 *
 * Avila (LP 583486, ND: "we don't service this type of project") was routed by
 * GHL_APPT_CANCELLED_REBOOK_COLD and reached S5.2 v2; LP_DISP_NO_DEMO sent 138
 * No Demo contacts toward rebook. An end state: invalid (never cancelled), out
 * of every sequence, lp-disqualified, off every Five9 list.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { planDisqualifiedCleanup, executeDisqualifiedCleanup, openEstimateAppointments, DISQUALIFIED_FIVE9_LISTS } =
  await import('../src/actions/handlers/disqualified-cleanup.js');
const { buildMarkInvalidRows, AWE1_WORKFLOW_ID, REMINDER_TAGS } = await import('../src/appointments/mark-invalid.js');
const { evaluateS52Entry } = await import('../src/s52-entry-gate.js');

const WE = 'aJj14ONxh1oFyDcQ706O';
const AVILA = { lp_lead_id: '583486', disposition_code: 'ND', first_name: 'Maria', last_name: 'Avila', phone: '8135551234' };
const appt = (over = {}) => ({ appointment_id: 'apptA', calendar_id: WE, status: 'new', start_time: '2026-10-20T10:00:00-04:00', ...over });

test('mark_invalid: invalid status, then A.WE-1 out, then the reminder tags — in that order, never cancelled', () => {
  const rows = buildMarkInvalidRows({ contactId: 'c1', appointmentId: 'apptA', rule: 'X', why: 'test' });
  assert.deepEqual(rows.map((r) => r.action_type), ['update_appointment_status', 'remove_from_workflow', 'remove_tag']);
  assert.equal(rows[0].action_payload.status, 'invalid');
  assert.equal(rows[1].action_payload.workflow_id, AWE1_WORKFLOW_ID);
  assert.deepEqual(rows[2].action_payload.tags, [...REMINDER_TAGS]);
  assert.equal(REMINDER_TAGS.length, 8);
  const delays = rows.map((r) => r.action_payload.not_before_seconds || 0);
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2], 'ordered with not_before_seconds');
  assert.ok(rows.every((r) => !JSON.stringify(r).includes('"cancelled"')));
});

test('only an OPEN estimate-pool appointment is invalidated', () => {
  const open = openEstimateAppointments([
    appt(), appt({ appointment_id: 'dead', status: 'cancelled' }), appt({ appointment_id: 'inv', status: 'invalid' }),
    appt({ appointment_id: 'call', calendar_id: 'gFWoSQrlKIdfRbAPV842' }),
  ]);
  assert.deepEqual(open.map((a) => a.appointment_id), ['apptA']);
});

function plan(over = {}) {
  return planDisqualifiedCleanup({
    contactId: 'c1', lead: AVILA, appointments: [appt()], tags: ['active-s5.2'], phone: '(813) 555-1234',
    workflowIds: { 'S5.2': 'wf-s52' }, autoRemove: false, ...over,
  });
}

test('Avila (ND): invalid not cancelled, out of S5.2, lp-disqualified, P3 Hard DQ, Five9 removal behind approval', () => {
  const rows = plan();
  const types = rows.map((r) => r.action_type);
  assert.ok(types.includes('update_appointment_status'));
  assert.equal(rows.find((r) => r.action_type === 'update_appointment_status').action_payload.status, 'invalid');
  assert.ok(rows.some((r) => r.action_type === 'remove_from_workflow' && r.action_payload.workflow_id === 'wf-s52'));
  assert.ok(rows.some((r) => r.action_type === 'add_tag' && r.action_payload.tag === 'lp-disqualified'));
  const opp = rows.find((r) => r.action_type === 'move_opportunity');
  assert.deepEqual([opp.action_payload.pipeline, opp.action_payload.stage], ['P3', 'Hard Disqualified']);
  const f9 = rows.find((r) => r.action_type === 'five9_delete_record_from_list');
  assert.deepEqual(f9.action_payload.list_names, [...DISQUALIFIED_FIVE9_LISTS]);
  assert.deepEqual(f9.action_payload.values, ['8135551234']);
  assert.equal(f9.requires_approval, true);
  assert.equal(f9.status, 'pending_approval');
  assert.ok(rows.every((r) => r.rule_applied === 'LP_DISP_DISQUALIFIED'));
  assert.ok(!types.includes('add_to_workflow'), 'never enrolls anything');
});

test('DISQUALIFIED_FIVE9_AUTO_REMOVE=true queues the removal unarmed', () => {
  const f9 = plan({ autoRemove: true }).find((r) => r.action_type === 'five9_delete_record_from_list');
  assert.deepEqual([f9.requires_approval, f9.status], [false, 'pending']);
});

test('automatic by default (the user, 2026-10-19); only the literal false puts the approval card back', async () => {
  const { disqualifiedAutoRemove } = await import('../src/actions/handlers/disqualified-cleanup.js');
  assert.equal(disqualifiedAutoRemove({}), true);
  assert.equal(disqualifiedAutoRemove({ DISQUALIFIED_FIVE9_AUTO_REMOVE: 'true' }), true);
  assert.equal(disqualifiedAutoRemove({ DISQUALIFIED_FIVE9_AUTO_REMOVE: 'False' }), false);
});

test('the Five9 executor runs it unarmed by default; with the flag false it must carry approval', async () => {
  const { executeFive9Write } = await import('../src/actions/handlers/five9.js');
  const row = { action_type: 'five9_delete_record_from_list', rule_applied: 'LP_DISP_DISQUALIFIED', requires_approval: false, action_payload: {} };
  const prev = process.env.DISQUALIFIED_FIVE9_AUTO_REMOVE;
  try {
    process.env.DISQUALIFIED_FIVE9_AUTO_REMOVE = 'false';
    await assert.rejects(executeFive9Write(row), /REFUSED/);
    delete process.env.DISQUALIFIED_FIVE9_AUTO_REMOVE;
    // Past the gate: the op itself refuses the empty payload, never the approval check.
    await assert.rejects(executeFive9Write(row), (err) => !/REFUSED: .*requires_approval/.test(err.message));
    // Any other rule's removal still needs approval.
    await assert.rejects(executeFive9Write({ ...row, rule_applied: 'SOMETHING_ELSE' }), /REFUSED/);
  } finally {
    if (prev === undefined) delete process.env.DISQUALIFIED_FIVE9_AUTO_REMOVE; else process.env.DISQUALIFIED_FIVE9_AUTO_REMOVE = prev;
  }
});

test('the automatic removal posts one no-button notice: ND, off every list, prospect not lead id', async () => {
  const { noticeDisqualifiedRemoval, formatDisqualifiedRemovedNotice } = await import('../src/notifications/disqualified-removed.js');
  const f9 = plan({ autoRemove: true, lead: { ...AVILA, lp_prospect_id: '470123' } })
    .find((r) => r.action_type === 'five9_delete_record_from_list');
  const action = { ...f9, id: 609912 };
  const result = { lists: [...DISQUALIFIED_FIVE9_LISTS], record_deleted: true,
    per_list: DISQUALIFIED_FIVE9_LISTS.map((list) => ({ list, deleted: list === 'LP_ASAP' ? 1 : 0, outcome: list === 'LP_ASAP' ? 'deleted' : 'not_on_list' })) };
  const text = formatDisqualifiedRemovedNotice(action, result);
  assert.match(text, /Done automatically · #609912 · LP ND → disqualified, off every dialing list/);
  assert.match(text, /Maria Avila was dispositioned "ND" in LP/);
  assert.match(text, /took 8135551234 off every Five9 dialing list\. Removed from "LP_ASAP"; it was not on the others\./);
  assert.match(text, /No action needed\./);
  assert.match(text, /Contact: Maria Avila · 8135551234 · Prospect 470123/);
  assert.doesNotMatch(text, /583486/, 'never the lead id');

  const posts = [];
  const deps = { channel: 'C_APPROVALS', post: async (t, ch) => { posts.push([t, ch]); return { ok: true }; } };
  assert.deepEqual(await noticeDisqualifiedRemoval(action, result, deps), { posted: 'approvals' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0][1], 'C_APPROVALS');

  // An approved card, a dry run, a deferral or another rule posts nothing.
  for (const [a, r] of [
    [{ ...action, requires_approval: true }, result],
    [action, { ...result, record_deleted: false }],
    [action, { deferred: true }],
    [{ ...action, rule_applied: 'BOOKED_DIAL_ROUTING' }, result],
  ]) assert.equal(await noticeDisqualifiedRemoval(a, r, deps), null);
  assert.equal(posts.length, 1);

  // A failed post is an #ops-alerts line, never silence.
  const alerts = [];
  const failed = await noticeDisqualifiedRemoval(action, result, {
    channel: 'C_APPROVALS', post: async () => ({ ok: false, error: 'channel_not_found' }),
    sendAlert: async (t, o) => { alerts.push([t, o]); return { sent: true }; },
  });
  assert.deepEqual(failed, { posted: 'ops' });
  assert.equal(alerts[0][1].channel, 'ops');
});

test('No Demo is the same as ND; an unresolved sequence goes out through Remove All Marketing', () => {
  const rows = plan({ lead: { ...AVILA, disposition_code: 'No Demo' }, tags: ['active-w11.1'], workflowIds: {} });
  assert.ok(rows.some((r) => r.action_type === 'remove_from_workflow' && r.action_payload.remove_all === true));
  assert.ok(!rows.some((r) => r.action_type === 'add_tag' && /rebook|time-lapse/.test(r.action_payload.tag)));
});

function fakeDb({ lead, inserted = [] }) {
  return {
    inserted,
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
        maybeSingle: async () => ({ data: lead, error: null }),
        insert: async (rows) => { inserted.push(...(Array.isArray(rows) ? rows : [rows])); return { error: null }; },
      };
      return q;
    },
  };
}

test('handler re-reads the CURRENT lead: a lead that is no longer ND does nothing', async () => {
  const db = fakeDb({ lead: { ...AVILA, disposition_code: 'Set' } });
  const res = await executeDisqualifiedCleanup({ target_id: 'c1' }, {}, {
    supabase: db, ghlFetch: async () => ({ contact: { tags: [] } }), fetchUpcomingAppointments: async () => [appt()],
  });
  assert.equal(res.reason, 'current_lead_not_disqualified');
  assert.equal(db.inserted.length, 0);
});

test('handler: a failed appointment read throws (the executor retries), nothing queued', async () => {
  const db = fakeDb({ lead: AVILA });
  await assert.rejects(executeDisqualifiedCleanup({ target_id: 'c1' }, {}, {
    supabase: db, ghlFetch: async () => ({ contact: { tags: [] } }), fetchUpcomingAppointments: async () => null,
  }), /appointment lookup failed/);
  assert.equal(db.inserted.length, 0);
});

test('handler queues the full plan for a current ND lead', async () => {
  const db = fakeDb({ lead: AVILA });
  const res = await executeDisqualifiedCleanup({ target_id: 'c1', event_id: 9 }, {}, {
    supabase: db, ghlFetch: async () => ({ contact: { tags: ['active-s5.2'], phone: '+18135551234' } }),
    fetchUpcomingAppointments: async () => [appt()], resolveWorkflowId: async () => 'wf-s52', env: {},
  });
  assert.equal(res.action, 'disqualified_cleanup_queued');
  assert.deepEqual(res.invalidated_appointments, ['apptA']);
  assert.ok(db.inserted.some((r) => r.action_type === 'five9_delete_record_from_list'));
});

test('S5.2 gate: a disqualified current lead is refused UP FRONT, before the note read', () => {
  const v = evaluateS52Entry({
    tags: [], notes: [],
    leads: [{ lp_lead_id: '583486', disposition_code: 'ND', created_at_lp: '2026-10-15T00:00:00Z', appointment_date: '2026-10-20T10:00:00+00:00' }],
  });
  assert.deepEqual([v.allow, v.reason], [false, 'current_lead_disqualified']);
});

// ── lp_disposition_not_in (rule 171's up-front disqualified exclusion) ──
const { _internal } = await import('../src/decision-engine.js');
const evaluateContextConditions = _internal?.evaluateContextConditions
  || (await import('../src/decision-engine.js')).evaluateContextConditions;
function leadsDb({ rows = [], error = null } = {}) {
  return {
    from() {
      const api = { select() { return api; }, eq() { return api; }, is() { return api; },
        limit: async () => ({ data: error ? null : rows, error: error ? { message: error } : null }) };
      return api;
    },
  };
}
const ctx = (db) => ({ deps: { supabase: db, emitEvent: async () => {} } });
const cancelEvt = { id: 2, ghl_contact_id: 'c-1', event_type: 'ghl.appointment_cancelled', payload: {} };
const row = (disposition_code) => ({ lp_lead_id: 'L1', disposition_code, created_at_lp: '2026-10-01T00:00:00Z', updated_at_lp: '2026-10-02T00:00:00Z' });

test('lp_disposition_not_in: an ND / No Demo current lead blocks; CXL and no lead pass; a failed read fails closed', async () => {
  const spec = { lp_disposition_not_in: ['ND', 'No Demo'] };
  assert.equal(await evaluateContextConditions(spec, {}, cancelEvt, ctx(leadsDb({ rows: [row('ND')] }))), false);
  assert.equal(await evaluateContextConditions(spec, {}, cancelEvt, ctx(leadsDb({ rows: [row('No Demo')] }))), false);
  assert.equal(await evaluateContextConditions(spec, {}, cancelEvt, ctx(leadsDb({ rows: [row('CXL')] }))), true);
  assert.equal(await evaluateContextConditions(spec, {}, cancelEvt, ctx(leadsDb({ rows: [] }))), true);
  assert.equal(await evaluateContextConditions(spec, {}, cancelEvt, ctx(leadsDb({ error: 'boom' }))), false);
});
