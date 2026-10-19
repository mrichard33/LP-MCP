// The Five9 Spanish list push for a Spanish live-chat visitor (2026-10-19,
// "Guest Visitor ugurs", P0TM5O8p0EmNJpXzgKig). The Spanish campaign runs the
// Callback Request V3 profile, so the push is a callback push: DNC first, the
// re-arm, callback_requested_at and call-now; a later name rides without a re-dial.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildSpanishListAction, queueSpanishList, spanishListName, SPANISH_LIST_RULE } = await import('../src/live-chat/spanish-list.js');

const env = { SPANISH_FIVE9_LIST: 'Spanish' };
const NOW = Date.parse('2026-10-19T20:45:00Z'); // 4:45 PM EDT
const deps = (over = {}) => {
  const rows = [];
  const keys = new Set(over.keys || []);
  const rearms = [];
  return {
    rows, rearms, env, nowMs: NOW,
    insertAction: async (r) => { rows.push(r); return { id: rows.length }; },
    findExisting: async (k) => keys.has(k),
    checkDnc: async () => ({ onDnc: false }),
    rearm: async (a) => { rearms.push(a); return { delete_action_id: 9, delete_status: 'completed', records_deleted: 0 }; },
    log: () => {},
    ...over,
  };
};
const field = (row, name) => row.action_payload.records[0][row.action_payload.field_names.indexOf(name)];

test('off until the list is named', async () => {
  assert.equal(spanishListName({}), null);
  const d = deps({ env: {} });
  assert.deepEqual(await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, d), { queued: false, reason: 'no_list_configured' });
  assert.equal(d.rows.length, 0);
});

test('the first push is a callback push: re-arm, call-now, callback_requested_at on the Eastern clock', async () => {
  const d = deps({ findLpLead: async () => ({ lp_prospect_id: 463174, lp_lead_id: 584100 }) });
  const res = await queueSpanishList({ contactId: 'C1', phone: '+1 (305) 680-7206', firstName: 'Carlos' }, d);
  assert.equal(res.kind, 'push');
  assert.deepEqual(d.rearms, [{ contactId: 'C1', number1: '3056807206', listName: 'Spanish' }]);
  const row = d.rows[0];
  assert.equal(row.action_type, 'five9_add_records_to_list');
  assert.equal(row.rule_applied, SPANISH_LIST_RULE);
  assert.equal(row.requires_approval, false);
  assert.equal(row.action_payload.call_now_mode, 'ANY');
  assert.equal(field(row, 'number1'), '3056807206');
  assert.equal(field(row, 'first_name'), 'Carlos');
  assert.equal(field(row, 'CustID'), '463174');
  assert.equal(field(row, 'call_ID'), 'C1');
  assert.equal(field(row, 'callback_requested_at'), '2026-10-19 16:45:00.000');
  assert.equal(row.action_payload.rearm.delete_status, 'completed');
  assert.equal(row.action_payload.spanish_key, 'C1:named');
});

test('a name that arrives later updates the record without a re-dial', async () => {
  const d = deps({ keys: ['C1:unnamed'] });
  const res = await queueSpanishList({ contactId: 'C1', phone: '3056807206', firstName: 'Carlos' }, d);
  assert.equal(res.kind, 'name_update');
  assert.equal(d.rearms.length, 0);
  const row = d.rows[0];
  assert.equal(row.action_payload.call_now_mode, 'NONE');
  assert.deepEqual(row.action_payload.field_names, ['number1', 'first_name']);
  assert.equal(row.action_payload.rearm, undefined);
});

test('no name yet → number + request time; the same contact is never pushed twice', async () => {
  const row = buildSpanishListAction({ contactId: 'C1', phone: '3056807206', listName: 'Spanish', nowMs: NOW });
  assert.deepEqual(row.action_payload.field_names, ['number1', 'call_ID', 'callback_requested_at']);
  assert.equal(row.action_payload.spanish_key, 'C1:unnamed');
  assert.equal((await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, deps({ keys: ['C1:unnamed'] }))).reason, 'already_queued');
  assert.equal((await queueSpanishList({ contactId: 'C1', phone: '3056807206', firstName: 'Carlos' }, deps({ keys: ['C1:named'] }))).reason, 'already_queued');
});

test('a Five9 DNC number is never pushed: one lift review, asked once', async () => {
  const d = deps({ checkDnc: async () => ({ onDnc: true }) });
  const res = await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, d);
  assert.equal(res.reason, 'five9_dnc_review_requested');
  assert.equal(d.rearms.length, 0);
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].action_type, 'request_dnc_lift_review');
  assert.equal(d.rows[0].action_payload.spanish_key, 'C1:dnc');
  assert.equal((await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, deps({ keys: ['C1:dnc'] }))).reason, 'five9_dnc_review_already_requested');
});

test('never without a phone, never past an opt-out or stop-bot, never throws', async () => {
  assert.equal((await queueSpanishList({ contactId: 'C1', phone: '12' }, deps())).reason, 'no_phone');
  assert.match((await queueSpanishList({ contactId: 'C1', phone: '3056807206', tags: ['stop-bot'] }, deps())).reason, /^send_gate:/);
  assert.match((await queueSpanishList({ contactId: 'C1', phone: '3056807206', tags: ['dnc-voice'] }, deps())).reason, /^send_gate:/);
  const res = await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, deps({ findExisting: async () => { throw new Error('db down'); } }));
  assert.equal(res.queued, false);
  assert.match(res.reason, /db down/);
});
