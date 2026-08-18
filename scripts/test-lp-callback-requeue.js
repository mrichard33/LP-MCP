/**
 * LP callback re-queue guardrails — scripts/test-lp-callback-requeue.js
 *
 * Covers the C3 guardrails from the 2026-08-18 handoff:
 *   - UpdateProspectInfo NEVER sends an empty string over a populated LP
 *     field (buildProspectUpdateFields strips blanks) — LP overwrites what
 *     you send, so a blank here would erase real prospect data;
 *   - the address repair is verified by read-back and fails LOUD when the
 *     write did not take (never dispatch a rep to a lead with no address);
 *   - the queue precondition finds an existing dialable lead across the
 *     Data queues (paged) and skips the second LeadAdd;
 *   - the dedup window treats lookup errors as duplicates (fail-closed —
 *     duplication is the worse failure);
 *   - the re-queue markers carry no reporting weight and srs_id is not
 *     invented here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { buildProspectUpdateFields } = await import('../src/lp-client.js');
const {
  buildRequeueUser2,
  findLeadInDataQueues,
  repairProspectAddress,
  recentRequeueExists,
  DATA_QUEUE_IDS,
  REQUEUE_SENDER,
  _resetQueueCache,
} = await import('../src/services/lp-callback-requeue.js');

// ─── buildProspectUpdateFields — the never-blank rule ──────────────

test('blank and null fields are never transmitted', () => {
  const fields = buildProspectUpdateFields({
    firstname: 'John',
    lastname: '',
    address1: '4360 Washington Place',
    address2: null,
    city: 'Ave Maria',
    state: '  ',           // LP's own blank-state artifact must not round-trip
    zip: '34142',
    phone: undefined,
    email: '',
  });
  assert.deepEqual(fields, {
    firstname: 'John',
    address1: '4360 Washington Place',
    city: 'Ave Maria',
    zip: '34142',
  });
});

test('unknown keys are dropped — only LP-updatable prospect fields transmit', () => {
  const fields = buildProspectUpdateFields({ address1: 'X St', srs_id: '842', custnumber: '1', notes: 'nope' });
  assert.deepEqual(fields, { address1: 'X St' });
});

test('values are stringified and trimmed', () => {
  const fields = buildProspectUpdateFields({ zip: 34142, city: '  Ave Maria  ' });
  assert.deepEqual(fields, { zip: '34142', city: 'Ave Maria' });
});

// ─── re-queue markers ──────────────────────────────────────────────

test('user2 marker is requeue:callback:<ISO8601>', () => {
  const u2 = buildRequeueUser2(new Date('2026-08-18T21:00:00Z'));
  assert.equal(u2, 'requeue:callback:2026-08-18T21:00:00.000Z');
  assert.ok(u2.length <= 255, 'LP user fields cap at 255 chars');
});

test('sender marker identifies the re-queue path', () => {
  assert.equal(REQUEUE_SENDER, 'GHL-Agentic-Callback-Requeue');
});

// ─── queue precondition ────────────────────────────────────────────

test('scans the five Data queues', () => {
  assert.deepEqual(DATA_QUEUE_IDS, [8, 30, 9, 31, 26]);
});

test('finds an existing lead in a later page of a Data queue → present', async () => {
  _resetQueueCache();
  const calls = [];
  const fetchQueuePage = async (cqdId, startrow) => {
    calls.push([cqdId, startrow]);
    // queue 8 has 2 pages; the target lead sits in page 2 of queue 8.
    if (cqdId === 8 && startrow === 1) {
      return Array.from({ length: 1000 }, (_, i) => ({ Lds_ID: 100000 + i, Cqd_ID: 8 }));
    }
    if (cqdId === 8 && startrow === 1001) {
      return [{ Lds_ID: 567746, Cqd_ID: 8, NumDialingAttempts: 2, CurrentDisposition: 'Data' }];
    }
    return [];
  };
  const res = await findLeadInDataQueues(['567746'], { fetchQueuePage });
  assert.equal(res.present, true);
  assert.equal(res.lds_id, '567746');
  assert.equal(res.row.NumDialingAttempts, 2);
  assert.ok(calls.some(([q, s]) => q === 8 && s === 1001), 'paged past the first 1000 rows');
});

test('absent from every queue → not present (re-queue may proceed)', async () => {
  _resetQueueCache();
  const res = await findLeadInDataQueues(['999999'], { fetchQueuePage: async () => [] });
  assert.equal(res.present, false);
});

test('no known lead ids → not present without any API call', async () => {
  _resetQueueCache();
  let called = 0;
  const res = await findLeadInDataQueues([], { fetchQueuePage: async () => { called++; return []; } });
  assert.equal(res.present, false);
  assert.equal(called, 0);
});

// ─── address repair (F4) ───────────────────────────────────────────

test('repairs, reads back, and reports before/after', async () => {
  const writes = [];
  const res = await repairProspectAddress({
    prospectId: '452653',
    ghlContact: {
      firstName: 'John', lastName: 'Czeropski',
      address1: '4360 Washington Place', city: 'Ave Maria', state: 'FL', postalCode: '34142',
      phone: '+1 (239) 555-0100', email: '',
    },
  }, {
    updateProspectInfo: async (args) => { writes.push(args); return { Result: 1 }; },
    getCustomersByProspectID: async () => [{ Address1: '4360 Washington Place', City: 'Ave Maria' }],
  });
  assert.equal(res.repaired, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].custnumber, '452653');
  assert.equal(writes[0].updates.address1, '4360 Washington Place');
  assert.equal(writes[0].updates.phone, '2395550100');
  // the blank email was stripped BEFORE the write — the never-blank rule
  // applies at build time, then again inside updateProspectInfo itself.
  assert.equal('email' in writes[0].updates, false);
});

test('fails LOUD when the read-back still shows a blank address', async () => {
  await assert.rejects(
    () => repairProspectAddress({
      prospectId: '452653',
      ghlContact: { firstName: 'John', address1: '4360 Washington Place', city: 'Ave Maria', state: 'FL', postalCode: '34142' },
    }, {
      updateProspectInfo: async () => ({ Result: 1 }),
      getCustomersByProspectID: async () => [{ Address1: '' }],
    }),
    /did NOT take/
  );
});

test('refuses to "repair" from a GHL contact that has no address', async () => {
  await assert.rejects(
    () => repairProspectAddress({
      prospectId: '452653',
      ghlContact: { firstName: 'John', address1: '', city: 'Ave Maria' },
    }, {
      updateProspectInfo: async () => { throw new Error('must not be called'); },
      getCustomersByProspectID: async () => [],
    }),
    /no address1/
  );
});

// ─── dedup window ──────────────────────────────────────────────────

function supabaseChainMock(result) {
  const chain = {};
  const self = () => chain;
  for (const m of ['from', 'select', 'eq', 'gte', 'order']) chain[m] = self;
  chain.limit = async () => result;
  return chain;
}

test('a completed re-queue inside the window is a duplicate', async () => {
  const res = await recentRequeueExists('CONTACT1', {
    supabase: supabaseChainMock({
      data: [{ id: 42, created_at: new Date().toISOString(), execution_result: { requeued: true } }],
      error: null,
    }),
  });
  assert.equal(res.duplicate, true);
  assert.equal(res.prior_action_id, 42);
});

test('a skip-result action inside the window is NOT a duplicate', async () => {
  const res = await recentRequeueExists('CONTACT1', {
    supabase: supabaseChainMock({
      data: [{ id: 43, created_at: new Date().toISOString(), execution_result: { requeued: false, action: 'requeue_skipped_already_dialable' } }],
      error: null,
    }),
  });
  assert.equal(res.duplicate, false);
});

test('a dedup lookup error fails CLOSED (treated as duplicate)', async () => {
  const res = await recentRequeueExists('CONTACT1', {
    supabase: supabaseChainMock({ data: null, error: { message: 'boom' } }),
  });
  assert.equal(res.duplicate, true);
  assert.equal(res.reason, 'dedup_lookup_error');
});
