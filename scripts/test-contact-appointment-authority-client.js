/**
 * test-contact-appointment-authority-client.js — the RPC client surface.
 *
 * Run: node --test scripts/test-contact-appointment-authority-client.js
 *
 * Exercises claimAppointmentAuthority / record / release against a mock
 * supabase client. The three things worth guarding here, in order of how badly
 * they fail if wrong:
 *
 *   1. RETURN SHAPE. The RPC returns jsonb, so supabase-js hands back an
 *      object. If it is ever redefined as RETURNS TABLE, PostgREST returns an
 *      ARRAY and a bare `data.granted` reads undefined → falsy → EVERY write
 *      silently denied under enforcement. Both shapes are asserted.
 *   2. ERROR POLICY, three outcomes not two. A missing object fails OPEN
 *      (deploy-before-DDL); any other error is authority_unavailable and
 *      RETRYABLE, never a terminal denial.
 *   3. DARK MODE writes no appointment state. On a shadow denial the
 *      appointment about to be created belongs to the DENIED lead; attaching
 *      its id to the owner's row would corrupt the soak data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Force the module's default supabase client to null so `client: null`
// exercises the no-supabase path (ambient env would otherwise supply a real
// client via `client ?? defaultSupabase`). Explicit mocks are unaffected.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.APPT_AUTHORITY_ENFORCE;

const {
  claimAppointmentAuthority, recordAppointmentAuthorityResult,
  releaseAppointmentAuthority,
} = await import('../src/services/contact-appointment-authority.js');

/** Mock client whose .rpc() returns a fixed { data, error } and records calls. */
function rpcClient(result, calls = []) {
  return {
    calls,
    rpc(fn, params) { calls.push({ fn, params }); return Promise.resolve(result); },
  };
}
const throwingClient = (calls = []) => ({
  calls,
  rpc(fn, params) { calls.push({ fn, params }); throw new Error('socket hang up'); },
});

const BASE = { contactId: 'CONTACT1', leadId: '563790', dispositionCode: 'Set' };

async function enforced(fn) {
  const prior = process.env.APPT_AUTHORITY_ENFORCE;
  process.env.APPT_AUTHORITY_ENFORCE = 'true';
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.APPT_AUTHORITY_ENFORCE;
    else process.env.APPT_AUTHORITY_ENFORCE = prior;
  }
}

// ── Return shape ───────────────────────────────────────────────────────────
test('jsonb object shape: granted', async () => {
  const r = await claimAppointmentAuthority({
    ...BASE,
    client: rpcClient({ data: { granted: true, owner_lp_lead_id: '563790', version: 3 }, error: null }),
  });
  assert.equal(r.granted, true);
  assert.equal(r.ownerLeadId, '563790');
  assert.equal(r.version, 3);
  assert.equal(r.shadowDenied, false);
});

test('ARRAY shape is unwrapped too — a RETURNS TABLE regression must not read as denied', async () => {
  // The failure this guards: PostgREST returns rows for RETURNS TABLE, so
  // `data.granted` would be undefined → falsy → every write denied under
  // enforcement, silently.
  const r = await enforced(() => claimAppointmentAuthority({
    ...BASE,
    client: rpcClient({ data: [{ granted: true, owner_lp_lead_id: '563790', version: 1 }], error: null }),
  }));
  assert.equal(r.granted, true, 'array-wrapped grant must still be a grant');
  assert.equal(r.ownerLeadId, '563790');
});

test('the RPC is called with every parameter the SQL signature declares', async () => {
  const calls = [];
  await claimAppointmentAuthority({
    ...BASE, seenAt: '2026-08-02T17:57:18+00:00', prospectId: 449759,
    appointmentStart: '2026-08-05T13:00:00-04:00', source: 'lp_disposition',
    client: rpcClient({ data: { granted: true }, error: null }, calls),
  });
  assert.equal(calls[0].fn, 'claim_appointment_authority');
  assert.deepEqual(Object.keys(calls[0].params).sort(), [
    'p_appointment_id', 'p_appointment_start', 'p_contact_id', 'p_lead_id',
    'p_prospect_id', 'p_rank', 'p_seen_at', 'p_source', 'p_stale_after_seconds',
  ]);
  assert.equal(calls[0].params.p_rank, 1, 'Set → rank 1');
  assert.equal(calls[0].params.p_prospect_id, '449759', 'ids are stringified');
  assert.equal(calls[0].params.p_stale_after_seconds, 14 * 24 * 3600);
});

// ── Error policy ───────────────────────────────────────────────────────────
test('a MISSING table/function fails OPEN — code deploys before DDL', async () => {
  // There is no migration runner in this repo; the DDL is pasted into the
  // Supabase SQL editor by hand, so a missing object must never strand
  // appointment sync. Same stance as claim_agent_actions.
  for (const message of [
    'function public.claim_appointment_authority does not exist',
    'relation "contact_appointment_authority" does not exist',
    'Could not find the function in the schema cache',
    'PGRST202: no matching function',
    '42883 undefined function',
    '42P01',
  ]) {
    const r = await enforced(() => claimAppointmentAuthority({
      ...BASE, client: rpcClient({ data: null, error: { message } }),
    }));
    assert.equal(r.granted, true, `should fail open: ${message}`);
    assert.equal(r.reason, 'rpc_missing_open');
    assert.equal(r.retryable, false);
  }
});

test('any OTHER error is authority_unavailable and RETRYABLE, never a denial', async () => {
  // A terminal noop on a transient 503 would mark the action completed with
  // the calendar unsynced — no retry, no card. The caller throws on retryable.
  const r = await enforced(() => claimAppointmentAuthority({
    ...BASE, client: rpcClient({ data: null, error: { message: 'timeout of 5000ms exceeded' } }),
  }));
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'authority_unavailable');
  assert.equal(r.retryable, true);
});

test('a thrown rpc is authority_unavailable, not a crash', async () => {
  const r = await enforced(() => claimAppointmentAuthority({ ...BASE, client: throwingClient() }));
  assert.equal(r.reason, 'authority_unavailable');
  assert.equal(r.retryable, true);
  assert.equal(r.granted, false);
});

test('infra failure never blocks in DARK mode', async () => {
  const r = await claimAppointmentAuthority({
    ...BASE, client: rpcClient({ data: null, error: { message: 'timeout' } }),
  });
  assert.equal(r.granted, true, 'dark mode must not block, not even on infra');
  assert.equal(r.retryable, true);
  assert.equal(r.enforced, false);
});

test('no supabase and bad keys fail open without calling the rpc', async () => {
  const noClient = await claimAppointmentAuthority({ ...BASE, client: null });
  assert.equal(noClient.granted, true);
  assert.equal(noClient.reason, 'no_supabase_open');

  const calls = [];
  const badKey = await enforced(() => claimAppointmentAuthority({
    contactId: null, leadId: '1', client: rpcClient({ data: null, error: null }, calls),
  }));
  assert.equal(badKey.granted, true);
  assert.equal(badKey.reason, 'bad_key_open');
  assert.equal(calls.length, 0, 'must not round-trip on a bad key');
});

// ── Denial ─────────────────────────────────────────────────────────────────
test('enforced denial: not granted, owner reported, nothing retryable', async () => {
  const r = await enforced(() => claimAppointmentAuthority({
    ...BASE,
    client: rpcClient({ data: { granted: false, owner_lp_lead_id: '563787', reason: 'authority_denied' }, error: null }),
  }));
  assert.equal(r.granted, false);
  assert.equal(r.ownerLeadId, '563787');
  assert.equal(r.reason, 'authority_denied');
  assert.equal(r.retryable, false);
  assert.equal(r.shadowDenied, false);
});

test('DARK denial returns granted but flags shadowDenied', async () => {
  const r = await claimAppointmentAuthority({
    ...BASE,
    client: rpcClient({ data: { granted: false, owner_lp_lead_id: '563787', reason: 'authority_denied' }, error: null }),
  });
  assert.equal(r.granted, true, 'dark mode must not change call-site behaviour');
  assert.equal(r.shadowDenied, true, 'callers key off this to skip recording appointment state');
  assert.equal(r.enforced, false);
  assert.equal(r.ownerLeadId, '563787');
});

// ── record / release ───────────────────────────────────────────────────────
test('record and release call their RPCs with owner-guard params', async () => {
  const recCalls = [];
  await recordAppointmentAuthorityResult('CONTACT1', '563787',
    { appointmentId: 'hXMB', calendarId: 'cal1', appointmentStart: '2026-08-05T17:00:00-04:00' },
    { client: rpcClient({ error: null }, recCalls) });
  assert.equal(recCalls[0].fn, 'record_appointment_authority');
  assert.equal(recCalls[0].params.p_lead_id, '563787');
  assert.equal(recCalls[0].params.p_appointment_id, 'hXMB');

  const relCalls = [];
  await releaseAppointmentAuthority('CONTACT1', '563787', { client: rpcClient({ error: null }, relCalls) });
  assert.equal(relCalls[0].fn, 'release_appointment_authority');
  assert.deepEqual(relCalls[0].params, { p_contact_id: 'CONTACT1', p_lead_id: '563787' });
});

test('record and release are best-effort: they never throw and never round-trip on bad keys', async () => {
  const calls = [];
  assert.equal(await recordAppointmentAuthorityResult(null, '1', {}, { client: rpcClient({ error: null }, calls) }), false);
  assert.equal(await releaseAppointmentAuthority('C', null, { client: rpcClient({ error: null }, calls) }), false);
  assert.equal(calls.length, 0);

  assert.equal(await releaseAppointmentAuthority('C', '1', { client: throwingClient() }), false);
  assert.equal(
    await recordAppointmentAuthorityResult('C', '1', {}, { client: rpcClient({ error: { message: 'boom' } }) }),
    false,
  );
});
