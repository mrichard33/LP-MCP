/**
 * test-lp-appt-false-failure.js — false SYNC-FAILED cards + exactly-once notices.
 *
 * Covers the 2026-07-22 fix in src/lp-appointment-sync.js:
 *   1. isBookableDisposition() — the confirmation family (CCC/Cnf/Verif/…) now
 *      counts as bookable, case- and whitespace-insensitive, so Step 0b/2b's
 *      link-trusted fallbacks resolve canvass leads instead of firing a card.
 *   2. Regression — every disposition in the original bookable set still passes.
 *   3. lpAlreadyHasAppointment() Pass 2 — a linked lp_leads row matching date AND
 *      time is a duplicate (skip); a same-date time change falls through to the
 *      resolver so SetAppointment can move it.
 *   4. claimFailureNotice() — claim-before-send: first insert wins (true), a
 *      23505 conflict loses (false), a 42P01 (table missing) fails OPEN (true).
 *
 * Supabase is stubbed via the injected `client` param (the module singleton is
 * null here because SUPABASE_* env is cleared, mirroring test-appointment-sync-claim.js).
 * ghlFetch's Pass-1 read bottoms out at globalThis.fetch, stubbed below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Null the module's default supabase client; the injected stub is what each
// effectful helper actually uses. GHL key required so ghlFetch runs.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GHL_API_KEY = 'test-key';

// ─── GHL fetch stub (installed before import) ──────────────────────────────
// Pass 1 of lpAlreadyHasAppointment reads GET /contacts/{id}. Return an empty
// contact so Pass 1 never short-circuits and control reaches the Supabase Pass 2.
function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
globalThis.fetch = async (url) => {
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  if (/^\/contacts\/[^/]+$/.test(path)) {
    return jsonRes({ contact: { id: 'c1', customFields: [], tags: [] } });
  }
  return jsonRes({});
};

const {
  isBookableDisposition,
  lpAlreadyHasAppointment,
  claimFailureNotice,
} = await import('../src/lp-appointment-sync.js');

// ─── Chainable Supabase stub ───────────────────────────────────────────────
// Every query-builder method returns the builder; the builder is thenable and
// resolves to `result`, so awaiting at any terminal (.limit / .insert / .eq)
// yields the preset value regardless of chain shape.
function chainable(result) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: () => builder,
    delete: () => builder,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}
function mockClient(resultByTable) {
  return { from: (table) => chainable(resultByTable[table] ?? { data: [], error: null }) };
}

// ─── 1. isBookableDisposition — confirmation family + normalization ─────────
test('isBookableDisposition accepts the confirmation family, case/space-insensitive', () => {
  for (const d of ['CCC', 'Cnf', 'ccc', ' verif ', 'Verif', 'Soft Confirm', 'reset']) {
    assert.equal(isBookableDisposition(d), true, `expected ${JSON.stringify(d)} bookable`);
  }
});

test('isBookableDisposition rejects non-bookable / empty dispositions', () => {
  for (const d of ['CXL', 'DNC', null, undefined, '', '   ']) {
    assert.equal(isBookableDisposition(d), false, `expected ${JSON.stringify(d)} NOT bookable`);
  }
});

// ─── 2. Regression — original bookable set still passes ─────────────────────
test('isBookableDisposition regression: original set still bookable', () => {
  for (const d of ['Data', 'Issue', 'Set', 'NIS', 'NIS2', 'NI', 'BO', '1Leg', 'NoHome']) {
    assert.equal(isBookableDisposition(d), true, `expected legacy ${JSON.stringify(d)} bookable`);
  }
});

// ─── 3. lpAlreadyHasAppointment Pass 2 — date+time match vs reschedule ──────
test('lpAlreadyHasAppointment: linked row matching date AND time is a duplicate', async () => {
  const client = mockClient({
    lp_leads: { data: [{ lp_lead_id: '560474', appointment_date: '2026-07-22T18:00:00+00:00' }] },
  });
  const dup = await lpAlreadyHasAppointment('CAwbNPzDvyEMiefW2axI', '2026-07-22', '18:00', client);
  assert.equal(dup, true);
});

test('lpAlreadyHasAppointment: same date but different time falls through (reschedule)', async () => {
  const client = mockClient({
    lp_leads: { data: [{ lp_lead_id: '560474', appointment_date: '2026-07-22T18:00:00+00:00' }] },
  });
  const dup = await lpAlreadyHasAppointment('CAwbNPzDvyEMiefW2axI', '2026-07-22', '19:00', client);
  assert.equal(dup, false);
});

// ─── 4. claimFailureNotice — claim-before-send return paths ─────────────────
test('claimFailureNotice: first claim wins → send card', async () => {
  const client = mockClient({ lp_sync_failure_notices: { error: null } });
  const send = await claimFailureNotice(
    { noticeKey: 'fail:c1:2026-07-22:18:00', contactId: 'c1', apptDate: '2026-07-22', apptTime: '18:00' },
    client,
  );
  assert.equal(send, true);
});

test('claimFailureNotice: 23505 conflict → suppress card', async () => {
  const client = mockClient({ lp_sync_failure_notices: { error: { code: '23505', message: 'duplicate key' } } });
  const send = await claimFailureNotice(
    { noticeKey: 'fail:c1:2026-07-22:18:00', contactId: 'c1', apptDate: '2026-07-22', apptTime: '18:00' },
    client,
  );
  assert.equal(send, false);
});

test('claimFailureNotice: 42P01 (table missing) fails OPEN → send card unguarded', async () => {
  const client = mockClient({ lp_sync_failure_notices: { error: { code: '42P01', message: 'relation does not exist' } } });
  const send = await claimFailureNotice(
    { noticeKey: 'fail:c1:2026-07-22:18:00', contactId: 'c1', apptDate: '2026-07-22', apptTime: '18:00' },
    client,
  );
  assert.equal(send, true);
});
