/**
 * LP inbound-queue mirror — scripts/test-lp-inbound-queue.js
 * src/lp-inbound-queue.js: row mapping (true UTC from LP's Eastern wall clock)
 * and fail-soft writes until sql/149 exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inboundQueueRow, upsertInboundQueue, readInboundQueueRow, insertSoft, isMissingTable,
  __resetMissingWarningsForTests,
} from '../src/lp-inbound-queue.js';

// Shelley, in1 428940 — the live row from 2026-10-06.
const SHELLEY = Object.freeze({
  id: '428940', firstname: 'Shelley', lastname: '', address1: '21296 Birwood Ave', phone: '(941)467-0700',
  brn_id: 'FTMYR', source: 'Website', srs_id: '830', sourcesubdescr: 'Reece ChatBot',
  checkoutdate: '2026-10-06T15:56:02.817', checkoutuser: '6174', checkoutusername: 'Mcintosh, Sarah',
  apptdate: '10/08/2026', appttime: '6:00 PM', datereceived: '2026-10-06T15:22:04.707',
  lognumber: 'u5JV2SkaPh8O4XqkCDyM', method: 'A', lds_id: '581671', cst_id: '463389', dsp_id: 'Set',
  killreason: '', sender: 'GHL-Chatbot',
});

test('Shelley maps to a mirror row with true-UTC times', () => {
  const r = inboundQueueRow(SHELLEY, Date.parse('2026-10-06T20:00:00Z'));
  assert.equal(r.in1_id, '428940');
  assert.equal(r.received_at_lp, '2026-10-06T19:22:04.707Z'); // EDT = UTC-4
  assert.equal(r.checkout_at_lp, '2026-10-06T19:56:02.817Z');
  assert.equal(r.checkout_user, 'Mcintosh, Sarah');
  assert.equal(r.checkout_user_id, '6174');
  assert.equal(r.phone10, '9414670700');
  assert.equal(r.appt_date, '2026-10-08');
  assert.equal(r.appt_time, '6:00 PM');
  assert.equal(r.source_sub, 'Reece ChatBot');
  assert.equal(r.kill_reason, null);
  assert.equal(r.lds_id, '581671');
});

test('a winter row converts with EST (UTC-5)', () => {
  const r = inboundQueueRow({ id: '1', datereceived: '2026-12-01T09:00:00' });
  assert.equal(r.received_at_lp, '2026-12-01T14:00:00.000Z');
  assert.equal(r.checkout_at_lp, null);
});

test('a row without an id is dropped', () => {
  assert.equal(inboundQueueRow({ firstname: 'x' }), null);
});

function fakeDb({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        upsert(rows, opts) { calls.push({ op: 'upsert', table, rows, opts }); return Promise.resolve({ error }); },
        insert(rows) { calls.push({ op: 'insert', table, rows }); return Promise.resolve({ error }); },
        select() { return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: error ? null : { in1_id: '428940' }, error }) }) }; },
      };
    },
  };
}

test('upsert dedupes by in1 and keys on in1_id', async () => {
  const db = fakeDb();
  const res = await upsertInboundQueue(db, [SHELLEY, SHELLEY, { id: '2' }, {}]);
  assert.deepEqual(res, { ok: true, upserted: 2 });
  assert.equal(db.calls[0].opts.onConflict, 'in1_id');
});

test('missing table fails soft — no throw, missing:true', async () => {
  __resetMissingWarningsForTests();
  const missing = { code: '42P01', message: 'relation "lp_inbound_queue" does not exist' };
  assert.deepEqual(await upsertInboundQueue(fakeDb({ error: missing }), [SHELLEY]), { ok: false, upserted: 0, missing: true });
  assert.equal(await readInboundQueueRow(fakeDb({ error: missing }), '428940'), null);
  assert.deepEqual(await insertSoft(fakeDb({ error: { code: 'PGRST205', message: 'Could not find the table' } }), 'booked_dial_routing_log', [{ a: 1 }]),
    { ok: false, inserted: 0, missing: true });
});

test('a thrown client is caught', async () => {
  const db = { from() { throw new Error('boom'); } };
  assert.equal((await upsertInboundQueue(db, [SHELLEY])).ok, false);
  assert.equal(await readInboundQueueRow(db, '1'), null);
});

test('isMissingTable recognises both spellings and nothing else', () => {
  assert.equal(isMissingTable({ code: '42P01' }), true);
  assert.equal(isMissingTable({ code: 'PGRST205' }), true);
  assert.equal(isMissingTable({ code: '23505', message: 'duplicate key' }), false);
});
