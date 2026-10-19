// The Five9 Spanish list push for a Spanish live-chat visitor (2026-10-19,
// "Guest Visitor ugurs", P0TM5O8p0EmNJpXzgKig).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildSpanishListAction, queueSpanishList, spanishListName, SPANISH_LIST_RULE } = await import('../src/live-chat/spanish-list.js');

const env = { SPANISH_FIVE9_LIST: 'Spanish' };
const deps = (over = {}) => {
  const rows = [];
  return { rows, env, insertAction: async (r) => { rows.push(r); return { id: rows.length }; }, findExisting: async () => false, log: () => {}, ...over };
};

test('off until the list is named', async () => {
  assert.equal(spanishListName({}), null);
  const d = deps({ env: {} });
  assert.deepEqual(await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, d), { queued: false, reason: 'no_list_configured' });
  assert.equal(d.rows.length, 0);
});

test('one auto-run add keyed on number1, with the first name when known', async () => {
  const d = deps();
  const res = await queueSpanishList({ contactId: 'C1', phone: '+1 (305) 680-7206', firstName: 'Carlos' }, d);
  assert.equal(res.queued, true);
  const row = d.rows[0];
  assert.equal(row.action_type, 'five9_add_records_to_list');
  assert.equal(row.rule_applied, SPANISH_LIST_RULE);
  assert.equal(row.requires_approval, false);
  assert.deepEqual(row.action_payload.field_names, ['number1', 'first_name']);
  assert.deepEqual(row.action_payload.records, [['3056807206', 'Carlos']]);
  assert.equal(row.action_payload.spanish_key, 'C1:named');
});

test('no name yet → number only; a later name gets its own row (Five9 updates the record)', () => {
  const row = buildSpanishListAction({ contactId: 'C1', phone: '3056807206', listName: 'Spanish' });
  assert.deepEqual(row.action_payload.records, [['3056807206']]);
  assert.equal(row.action_payload.spanish_key, 'C1:unnamed');
});

test('never twice, never without a phone, never past an opt-out or stop-bot', async () => {
  assert.equal((await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, deps({ findExisting: async () => true }))).reason, 'already_queued');
  assert.equal((await queueSpanishList({ contactId: 'C1', phone: '12' }, deps())).reason, 'no_phone');
  assert.match((await queueSpanishList({ contactId: 'C1', phone: '3056807206', tags: ['stop-bot'] }, deps())).reason, /^send_gate:/);
  assert.match((await queueSpanishList({ contactId: 'C1', phone: '3056807206', tags: ['dnc-voice'] }, deps())).reason, /^send_gate:/);
});

test('a failed check never throws', async () => {
  const res = await queueSpanishList({ contactId: 'C1', phone: '3056807206' }, deps({ findExisting: async () => { throw new Error('db down'); } }));
  assert.equal(res.queued, false);
  assert.match(res.reason, /db down/);
});
