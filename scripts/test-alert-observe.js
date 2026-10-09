/**
 * test-alert-observe.js — stale alert rows and "[object Object]" (2026-10-07).
 *
 * THE DEFECTS.
 * 1. Since 2026-10-02 the morning checks run inside the 08:00 digest with
 *    `post: false`, and the uncalled check posts through its own dedupe path.
 *    Neither touched alert_conditions any more, so three rows that were firing
 *    on 10-02 ('Leads never reached LP', 'Leads waiting with no call',
 *    'LP↔GHL link leak') read "firing" for five days with last_seen_at frozen.
 *    observeAlertCondition keeps the row true and never posts.
 * 2. Callers pass objects as `detail`; String({...}) stored "[object Object]".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { reportAlertCondition, observeAlertCondition, formatDetail } = await import('../src/alert-state.js');
const { mockAlertConditions } = await import('./fixtures/alert-conditions-mock.js');

test('formatDetail stores objects as JSON, strings as-is, and caps length', () => {
  assert.equal(formatDetail({ count: 2, prospects: [1, 2] }), '{"count":2,"prospects":[1,2]}');
  assert.equal(formatDetail('missing=1'), 'missing=1');
  assert.equal(formatDetail(null), null);
  assert.equal(formatDetail(''), null);
  assert.equal(formatDetail('x'.repeat(900)).length, 500);
  assert.notEqual(formatDetail({ a: 1 }), '[object Object]');
});

test('an object detail is stored as JSON on the alert row', async () => {
  const rows = new Map();
  await reportAlertCondition({
    key: 'k:obj', active: true, text: () => 'BODY', detail: { tables: { a: 1 } },
    client: mockAlertConditions(rows), send: async () => ({ sent: true }),
  });
  assert.equal(rows.get('k:obj').detail, '{"tables":{"a":1}}');
});

test('observe: fires the row without sending, then clears it silently', async () => {
  const rows = new Map();
  const client = mockAlertConditions(rows);
  const r1 = await observeAlertCondition({ key: 'k:obs', active: true, label: 'L', detail: 'n=3', client });
  assert.equal(rows.get('k:obs').state, 'firing');
  assert.equal(r1.sent, false);
  const r2 = await observeAlertCondition({ key: 'k:obs', active: false, label: 'L', client });
  assert.equal(rows.get('k:obs').state, 'cleared', 'a healthy digest pass must clear the row');
  assert.equal(r2.sent, false);
});

test('observe: clears a row a real alert fired, with NO recovery card', async () => {
  const rows = new Map();
  const client = mockAlertConditions(rows);
  const sent = [];
  await reportAlertCondition({
    key: 'k:real', active: true, text: () => 'BODY', client,
    send: async (b) => { sent.push(b); return { sent: true }; },
  });
  assert.equal(sent.length, 1);
  await observeAlertCondition({ key: 'k:real', active: false, client });
  assert.equal(rows.get('k:real').state, 'cleared');
  assert.equal(sent.length, 1, 'the digest owns the message; observe never posts');
});

test('observe: refreshes last_seen_at on a row that is still firing', async () => {
  const rows = new Map();
  const client = mockAlertConditions(rows);
  await observeAlertCondition({ key: 'k:seen', active: true, client, nowMs: Date.parse('2026-10-02T12:00:00Z') });
  await observeAlertCondition({ key: 'k:seen', active: true, client, detail: 'n=4', nowMs: Date.parse('2026-10-07T12:00:00Z') });
  assert.equal(rows.get('k:seen').last_seen_at, '2026-10-07T12:00:00.000Z');
  assert.equal(rows.get('k:seen').detail, 'n=4');
});

test('observe: null (could not tell) touches nothing', async () => {
  const rows = new Map();
  const client = mockAlertConditions(rows);
  await observeAlertCondition({ key: 'k:firing', active: true, client });
  const before = { ...rows.get('k:firing') };
  await observeAlertCondition({ key: 'k:firing', active: null, client });
  assert.deepEqual(rows.get('k:firing'), before);
});

test('observe: no state table → skipped, never the degraded send path', async () => {
  const r = await observeAlertCondition({ key: 'k:none', active: true });
  assert.equal(r.action, 'skipped');
  assert.equal(r.sent, false);
});
