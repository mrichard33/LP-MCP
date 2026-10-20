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

const { planDisqualifiedCleanup, executeDisqualifiedCleanup, openEstimateAppointments, disqualifiedTargetLists } =
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

// Five9's list inventory as read live on 2026-10-20, after "Data - Hot" was split by market.
const LIVE_LISTS = ['Disconnected from IVR', 'Reset-Cold', 'Reset-Warm', 'Resets-Hot', 'Sale - Completed 2-4yrs',
  'Sale - Completed 0-2yrs', 'Sale - Cancelled', 'Rehash - All Roof', 'Rehash -Old', 'Rehash', 'Rehash New', 'Inbound Queue',
  'Data -Old more than 180', 'Data - Leads more than 30', 'Data - Hot - Unmapped', 'Conf - All Roof', 'Conf - 2nd Day',
  'Conf - Next Day', 'Data - Warm - Unmapped', 'LP_ASAP', 'reset campaign - old', 'hotleads', 'After DIAL ASAP', 'AGED DATA',
  'Simpletext_ASAP', 'SimpleText-data', 'Reece Chatbot', 'East Coast PC list', 'Data - Hot - FTL less than 7',
  'Data - Hot - STP less than 7', 'Data - Hot - SAR less than 7', 'Data - Hot - JAX less than 7', 'Data - Hot - ORL less than 7',
  'Data - Hot - FTM less than 7', 'Data - Hot - LKE less than 7', 'Data - Warm - FTL less than 30', 'Data - Warm - FTM less than 30',
  'Data - Warm - JAX less than 30', 'Data - Warm - LKE less than 30', 'Data - Warm - ORL less than 30',
  'Data - Warm - SAR less than 30', 'Data - Warm - STP less than 30', 'Callback Request', 'Direct Lead Entry', 'Spanish']
  .map((name) => ({ name, size: 1 }));
const SMALL_LISTS = ['LP_ASAP', 'Reece Chatbot', 'Direct Lead Entry', 'Data - Hot - FTL less than 7', 'Conf - Next Day'].map((name) => ({ name }));

function plan(over = {}) {
  return planDisqualifiedCleanup({
    contactId: 'c1', lead: AVILA, appointments: [appt()], tags: ['active-s5.2'], phone: '(813) 555-1234',
    workflowIds: { 'S5.2': 'wf-s52' }, targetLists: SMALL_LISTS, autoRemove: false, nowMs: Date.parse('2026-10-20T15:00:00Z'), ...over,
  });
}

test('every outbound list from the live inventory: the market lists in, Sale / Rehash / Inbound out (2026-10-20)', () => {
  const lists = disqualifiedTargetLists(LIVE_LISTS);
  assert.ok(!lists.includes('Data - Hot'), 'the retired list is never named');
  for (const want of ['LP_ASAP', 'Reece Chatbot', 'Direct Lead Entry', 'After DIAL ASAP', 'Conf - Next Day', 'Conf - 2nd Day',
    'Data - Hot - FTL less than 7', 'Data - Hot - LKE less than 7', 'Data - Hot - Unmapped', 'Data - Warm - STP less than 30',
    'Data - Warm - Unmapped', 'Callback Request', 'Spanish', 'Resets-Hot', 'Data - Leads more than 30', 'AGED DATA']) {
    assert.ok(lists.includes(want), want);
  }
  for (const not of ['Sale - Completed 0-2yrs', 'Sale - Cancelled', 'Rehash', 'Rehash New', 'Rehash -Old', 'Rehash - All Roof', 'Inbound Queue']) {
    assert.ok(!lists.includes(not), not);
  }
  assert.equal(lists.length, LIVE_LISTS.length - 8);
  // A market list added tomorrow is covered without a code change.
  assert.ok(disqualifiedTargetLists([...LIVE_LISTS, { name: 'Data - Hot - HOU less than 7' }]).includes('Data - Hot - HOU less than 7'));
});

test('the removal is split into rows of at most 10 lists, one group, every list once', () => {
  const f9 = plan({ targetLists: LIVE_LISTS, autoRemove: true }).filter((r) => r.action_type === 'five9_delete_record_from_list');
  const lists = disqualifiedTargetLists(LIVE_LISTS);
  assert.equal(f9.length, Math.ceil(lists.length / 10));
  assert.ok(f9.every((r) => r.action_payload.list_names.length <= 10));
  assert.deepEqual(f9.flatMap((r) => r.action_payload.list_names), lists);
  assert.equal(new Set(f9.map((r) => r.action_payload.group)).size, 1);
  assert.deepEqual(f9.map((r) => r.action_payload.chunk), f9.map((_, i) => ({ index: i + 1, of: f9.length })));
  assert.ok(f9.every((r) => r.action_payload.skip_missing_lists === true && r.status === 'pending' && r.requires_approval === false));
});

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
  assert.deepEqual(f9.action_payload.list_names, SMALL_LISTS.map((l) => l.name));
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
  const names = f9.action_payload.list_names;
  const result = { lists: names, record_deleted: true,
    per_list: names.map((list) => ({ list, deleted: list === 'LP_ASAP' ? 1 : 0, outcome: list === 'LP_ASAP' ? 'deleted' : 'not_on_list' })) };
  const text = formatDisqualifiedRemovedNotice(action, result);
  assert.match(text, /Done automatically · #609912 · LP ND → disqualified, off every dialing list/);
  assert.match(text, /Maria Avila was dispositioned "ND" in LP/);
  assert.match(text, /took 8135551234 off every Five9 dialing list\. Removed from "LP_ASAP"; it was not on the other 4 lists\./);
  assert.match(text, /No action needed\./);
  assert.match(text, /Contact: Maria Avila · 8135551234 · Prospect 470123/);
  assert.doesNotMatch(text, /583486/, 'never the lead id');

  const posts = [];
  const posted = new Set();
  const dedupe = {
    filterNew: async ({ items }) => ({ fresh: items.filter((i) => !posted.has(i.key)) }),
    recordPosted: async ({ items }) => { for (const i of items) posted.add(i.key); return { ok: true }; },
  };
  const deps = { channel: 'C_APPROVALS', post: async (t, ch) => { posts.push([t, ch]); return { ok: true }; }, ...dedupe };
  assert.deepEqual(await noticeDisqualifiedRemoval(action, result, deps), { posted: 'approvals' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0][1], 'C_APPROVALS');
  // A retry of the same lead never posts twice.
  assert.deepEqual(await noticeDisqualifiedRemoval(action, result, deps), { posted: 'already' });
  assert.equal(posts.length, 1);

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
  const failed = await noticeDisqualifiedRemoval({ ...action, id: 1, action_payload: { ...action.action_payload, group: 'other' } }, result, {
    channel: 'C_APPROVALS', post: async () => ({ ok: false, error: 'channel_not_found' }),
    sendAlert: async (t, o) => { alerts.push([t, o]); return { sent: true }; }, ...dedupe,
  });
  assert.deepEqual(failed, { posted: 'ops' });
  assert.equal(alerts[0][1].channel, 'ops');
});

test('a split removal posts ONE notice, from the last chunk, with every chunk\'s lists', async () => {
  const { noticeDisqualifiedRemoval } = await import('../src/notifications/disqualified-removed.js');
  const rows = plan({ targetLists: LIVE_LISTS, autoRemove: true }).filter((r) => r.action_type === 'five9_delete_record_from_list')
    .map((r, i) => ({ ...r, id: 900 + i }));
  const resultOf = (r) => ({ lists: r.action_payload.list_names, record_deleted: true,
    per_list: r.action_payload.list_names.map((list) => ({ list, deleted: /FTL less than 7|^LP_ASAP$/.test(list) ? 1 : 0,
      outcome: /FTL less than 7|^LP_ASAP$/.test(list) ? 'deleted' : 'not_on_list' })) });
  const state = new Map(rows.map((r) => [r.id, { id: r.id, status: 'pending', execution_result: null }]));
  const posts = [];
  const posted = new Set();
  const deps = {
    channel: 'C', post: async (t) => { posts.push(t); return { ok: true }; },
    readGroup: async (_g, selfId) => [...state.values()].filter((r) => r.id !== selfId),
    filterNew: async ({ items }) => ({ fresh: items.filter((i) => !posted.has(i.key)) }),
    recordPosted: async ({ items }) => { for (const i of items) posted.add(i.key); },
  };
  for (const r of rows) {
    const res = resultOf(r);
    const out = await noticeDisqualifiedRemoval(r, res, deps);
    state.set(r.id, { id: r.id, status: 'completed', execution_result: res });
    if (r !== rows.at(-1)) assert.deepEqual(out, { posted: 'waiting' });
  }
  assert.equal(posts.length, 1);
  assert.match(posts[0], /Removed from "LP_ASAP", "Data - Hot - FTL less than 7"; it was not on the other 35 lists\./);

  // A sibling that failed: no notice (the morning digest names the failure).
  posts.length = 0; posted.clear();
  state.set(rows[0].id, { id: rows[0].id, status: 'failed', execution_result: null });
  assert.deepEqual(await noticeDisqualifiedRemoval(rows.at(-1), resultOf(rows.at(-1)), deps), { posted: 'waiting' });
  assert.equal(posts.length, 0);
});

test('Five9: skip_missing_lists skips a list Five9 no longer has; without it a missing list still faults', async () => {
  const { missingListsToSkip } = await import('../src/five9/admin-writes.js');
  const inventory = new Set(['LP_ASAP', 'Data - Hot - FTL less than 7']);
  const lists = ['LP_ASAP', 'Data - Hot', 'Data - Hot - FTL less than 7'];
  assert.deepEqual([...missingListsToSkip(lists, inventory, { skip_missing_lists: true })], ['Data - Hot']);
  assert.equal(missingListsToSkip(lists, inventory, {}).size, 0);
  assert.equal(missingListsToSkip(lists, inventory, { skip_missing_lists: 'true' }).size, 0);
  assert.equal(missingListsToSkip(lists, null, { skip_missing_lists: true }).size, 0);
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

test('handler: the Five9 lists come from the live inventory; a failed or empty read throws, nothing queued', async () => {
  const base = { ghlFetch: async () => ({ contact: { tags: [], phone: '+18135551234' } }), fetchUpcomingAppointments: async () => [], env: {} };
  const db = fakeDb({ lead: AVILA });
  await assert.rejects(executeDisqualifiedCleanup({ target_id: 'c1' }, {}, { ...base, supabase: db, getListsInfo: async () => { throw new Error('SOAP down'); } }), /SOAP down/);
  await assert.rejects(executeDisqualifiedCleanup({ target_id: 'c1' }, {}, { ...base, supabase: db, getListsInfo: async () => ({ lists: [] }) }), /inventory came back empty/);
  assert.equal(db.inserted.length, 0);
  const ok = fakeDb({ lead: AVILA });
  await executeDisqualifiedCleanup({ target_id: 'c1' }, {}, { ...base, supabase: ok, getListsInfo: async () => ({ lists: LIVE_LISTS }) });
  const f9 = ok.inserted.filter((r) => r.action_type === 'five9_delete_record_from_list');
  assert.equal(f9.length, 4);
  assert.ok(f9.flatMap((r) => r.action_payload.list_names).includes('Data - Warm - ORL less than 30'));
});

test('handler queues the full plan for a current ND lead', async () => {
  const db = fakeDb({ lead: AVILA });
  const res = await executeDisqualifiedCleanup({ target_id: 'c1', event_id: 9 }, {}, {
    supabase: db, ghlFetch: async () => ({ contact: { tags: ['active-s5.2'], phone: '+18135551234' } }),
    fetchUpcomingAppointments: async () => [appt()], resolveWorkflowId: async () => 'wf-s52', getListsInfo: async () => ({ lists: SMALL_LISTS }), env: {},
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

test('Five9 per-minute upload limit is a wait, not a failure (2026-10-20 backlog: 25 rows failed on it)', async () => {
  const { rateLimitDeferral, RATE_LIMIT_MAX_WAITS, RATE_LIMIT_WAIT_MS } = await import('../src/five9/admin-writes.js');
  const fault = new Error('Five9 deleteRecordFromList fault: 60 seconds limit (160) for single upload operation is reached.');
  const now = Date.parse('2026-10-20T16:25:00Z');
  const d = rateLimitDeferral(fault, {}, now);
  assert.deepEqual([d.deferred, d.reason, d.rate_limit_waits], [true, 'five9_rate_limited', 1]);
  assert.equal(Date.parse(d.retry_at) - now, RATE_LIMIT_WAIT_MS);
  assert.equal(rateLimitDeferral(fault, { execution_result: { rate_limit_waits: 3 } }, now).rate_limit_waits, 4);
  // After the cap the fault stands; any other fault is never a wait.
  assert.equal(rateLimitDeferral(fault, { execution_result: { rate_limit_waits: RATE_LIMIT_MAX_WAITS } }, now), null);
  assert.equal(rateLimitDeferral(new Error('Five9 deleteRecordFromList fault: List "Data - Hot" doesn\'t exist.'), {}, now), null);
});
