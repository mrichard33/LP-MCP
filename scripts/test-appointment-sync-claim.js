/**
 * test-appointment-sync-claim.js — cross-worker double-create guard.
 *
 * Exercises src/services/appointment-sync-claim.js against a stateful in-memory
 * mock of the appointment_sync_claims table (PRIMARY KEY (contact_id, slot_ms)):
 *   - the FIRST claim on a slot wins; a CONCURRENT second claim is held (23505);
 *   - releasing (failed create) frees the slot for a retry;
 *   - a stale claim (older than the TTL) is reclaimable;
 *   - every guard/error path fails OPEN (claimed:true) so a backstop infra issue
 *     never strands a legitimate booking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Force the module's default supabase client to null so the `client: null` path
// exercises the no-supabase fail-open (ambient env would otherwise supply a real
// client via `client ?? defaultSupabase`). Explicit mock clients are unaffected.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { claimAppointmentCreate, releaseAppointmentCreate, CLAIM_TTL_SECONDS } =
  await import('../src/services/appointment-sync-claim.js');

// Stateful mock of the claims table. rows: "contact:slot" → claimed_at epoch ms.
function mockClient(rows = new Map()) {
  const chain = (onResolve) => {
    const flt = {};
    const c = {
      eq(k, v) { flt[k] = v; return c; },
      lt(k, v) { flt[`${k}__lt`] = v; return c; },
      then(resolve, reject) { return Promise.resolve(onResolve(flt)).then(resolve, reject); },
    };
    return c;
  };
  const client = {
    _rows: rows,
    from() {
      return {
        delete() {
          return chain((flt) => {
            const key = `${flt.contact_id}:${flt.slot_ms}`;
            if (flt.claimed_at__lt !== undefined) {           // stale reclaim: only if old enough
              const t = rows.get(key);
              if (t !== undefined && t < Date.parse(flt.claimed_at__lt)) rows.delete(key);
            } else {                                          // release: unconditional
              rows.delete(key);
            }
            return { error: null };
          });
        },
        insert(row) {
          const key = `${row.contact_id}:${row.slot_ms}`;
          if (rows.has(key)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
          rows.set(key, Date.now());
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return client;
}

// A client whose INSERT always fails with a NON-conflict error.
function erroringClient() {
  return { from: () => ({
    delete: () => ({ eq() { return this; }, lt() { return this; }, then: (r) => Promise.resolve({ error: null }).then(r) }),
    insert: () => Promise.resolve({ error: { code: '42P01', message: 'relation does not exist' } }),
  }) };
}

const SLOT = Date.parse('2027-07-08T10:00:00-04:00');

test('first claim wins; a concurrent second claim on the same slot is held', async () => {
  const client = mockClient();
  const a = await claimAppointmentCreate('c1', SLOT, { client });
  assert.equal(a.claimed, true);
  const b = await claimAppointmentCreate('c1', SLOT, { client });
  assert.equal(b.claimed, false);
  assert.equal(b.reason, 'held');
});

test('release frees the slot for a retry', async () => {
  const client = mockClient();
  assert.equal((await claimAppointmentCreate('c1', SLOT, { client })).claimed, true);
  assert.equal((await claimAppointmentCreate('c1', SLOT, { client })).claimed, false); // held
  await releaseAppointmentCreate('c1', SLOT, { client });
  assert.equal((await claimAppointmentCreate('c1', SLOT, { client })).claimed, true);  // reclaimable
});

test('different slot for the same contact is independent', async () => {
  const client = mockClient();
  assert.equal((await claimAppointmentCreate('c1', SLOT, { client })).claimed, true);
  const other = Date.parse('2027-07-08T14:00:00-04:00');
  assert.equal((await claimAppointmentCreate('c1', other, { client })).claimed, true);
});

test('a stale claim (older than TTL) is reclaimable', async () => {
  const rows = new Map([[`c1:${SLOT}`, Date.now() - (CLAIM_TTL_SECONDS + 60) * 1000]]); // aged past TTL
  const client = mockClient(rows);
  const res = await claimAppointmentCreate('c1', SLOT, { client });
  assert.equal(res.claimed, true, 'a stale claim must not block the slot forever');
});

test('a FRESH claim is NOT reclaimed by the stale-delete (still held)', async () => {
  const rows = new Map([[`c1:${SLOT}`, Date.now()]]); // just claimed
  const client = mockClient(rows);
  const res = await claimAppointmentCreate('c1', SLOT, { client });
  assert.equal(res.claimed, false);
  assert.equal(res.reason, 'held');
});

test('fail-open: no supabase client → claimed', async () => {
  const res = await claimAppointmentCreate('c1', SLOT, { client: null });
  assert.equal(res.claimed, true);
  assert.equal(res.reason, 'no_supabase_open');
});

test('fail-open: bad key (NaN slot / missing contact) → claimed', async () => {
  const client = mockClient();
  assert.equal((await claimAppointmentCreate('c1', NaN, { client })).reason, 'bad_key_open');
  assert.equal((await claimAppointmentCreate('', SLOT, { client })).reason, 'bad_key_open');
});

test('fail-open: a non-conflict DB error → claimed (backstop never strands a booking)', async () => {
  const res = await claimAppointmentCreate('c1', SLOT, { client: erroringClient() });
  assert.equal(res.claimed, true);
  assert.equal(res.reason, 'error_open');
});
