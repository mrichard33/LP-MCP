/**
 * test-lp-ghl-appointment-lead-select.js — which LP lead drives the GHL write.
 *
 * Run: node --test scripts/test-lp-ghl-appointment-lead-select.js
 *
 * This is the file that guards the 2026-08-02 defect and the WORSE defect that
 * the first fix attempt would have introduced.
 *
 * The defect: executeSyncLpAppointmentToGhl re-read the NEWEST lp_leads row by
 * created_at_lp, so lead 563790 (Set, 13:00) drove contact 4qcX45ReKbXPbKKQTLka's
 * calendar while sibling 563787 held the Cnf the customer had agreed to (17:00).
 *
 * The near-miss: "pick the highest-ranked sibling instead" inverts every
 * cancellation. CXL ranks 0, so on a CXL event a Cnf sibling (rank 2) wins,
 * classifyDisposition('Cnf') returns 'confirm', and the customer's cancellation
 * silently becomes a confirmation — a dead appointment left live on the
 * calendar and a rep sent to the house. The fix is to mirror the lead that
 * actually changed, which the event row has carried all along
 * (system_events.entity_id / lp_lead_id — see src/sync-leads.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { resolveSyncLead } = await import('../src/actions/handlers/lp-ghl-appointment-sync.js');
const { classifyDisposition } = await import('../src/services/lp-ghl-appointment-reconciler.js');

// The real incident's three sibling leads, all on GHL contact CONTACT1.
const LEADS = {
  563753: { lp_lead_id: '563753', ghl_contact_id: 'CONTACT1', disposition_code: 'Set', appointment_date: '2026-08-05T11:00:00+00:00', created_at_lp: '2026-08-02T11:48:12Z', updated_at_lp: '2026-08-02T16:32:15Z' },
  563787: { lp_lead_id: '563787', ghl_contact_id: 'CONTACT1', disposition_code: 'Cnf', appointment_date: '2026-08-05T17:00:00+00:00', created_at_lp: '2026-08-02T15:52:46Z', updated_at_lp: '2026-08-02T17:57:18Z' },
  563790: { lp_lead_id: '563790', ghl_contact_id: 'CONTACT1', disposition_code: 'Set', appointment_date: '2026-08-05T13:00:00+00:00', created_at_lp: '2026-08-02T15:58:40Z', updated_at_lp: '2026-08-02T17:38:45Z' },
};

/**
 * Mock db. `events` maps event id → { entity_id, lp_lead_id }; `leads` maps
 * lp_lead_id → row. Newest-by-created_at_lp is computed, not assumed.
 */
function mockDb({ leads = LEADS, events = {}, leadError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const flt = {};
      const q = {
        select() { return q; },
        eq(k, v) { flt[k] = v; return q; },
        order(k, o) { flt.__order = [k, o]; return q; },
        limit(n) { flt.__limit = n; return q; },
        maybeSingle() {
          calls.push({ table, flt: { ...flt } });
          if (table === 'system_events') {
            return Promise.resolve({ data: events[flt.id] ?? null, error: null });
          }
          if (leadError) return Promise.resolve({ data: null, error: { message: leadError } });
          if (flt.lp_lead_id !== undefined) {
            return Promise.resolve({ data: leads[flt.lp_lead_id] ?? null, error: null });
          }
          const forContact = Object.values(leads)
            .filter((l) => l.ghl_contact_id === flt.ghl_contact_id)
            .sort((a, b) => String(b.created_at_lp).localeCompare(String(a.created_at_lp)));
          return Promise.resolve({ data: forContact[0] ?? null, error: null });
        },
      };
      return q;
    },
  };
}

// ── The regression this file exists for ────────────────────────────────────
test('CANARY: a CXL event mirrors the CXL lead, not the higher-ranked Cnf sibling', async () => {
  // Rank-max would pick 563787 (Cnf, rank 2) over the cancelling lead (rank 0)
  // and turn the cancellation into a confirmation. Mirror the lead that changed.
  const leads = {
    ...LEADS,
    563753: { ...LEADS[563753], disposition_code: 'CXL' },
  };
  const db = mockDb({ leads, events: { 900: { entity_id: '563753', lp_lead_id: '563753' } } });

  const { lead, source } = await resolveSyncLead({ event_id: 900 }, {}, 'CONTACT1', db);

  assert.equal(lead.lp_lead_id, '563753');
  assert.equal(source, 'event_lead');
  assert.equal(classifyDisposition(lead.disposition_code), 'cancel',
    'the reconciler must see a cancel, not a confirm');
});

test('CANARY (2026-08-02): a Cnf event mirrors 563787, not the newest sibling 563790', async () => {
  // Newest by created_at_lp is 563790 (Set 13:00). The customer confirmed
  // 563787's 17:00. Under the old newest-wins read the calendar got 13:00.
  const db = mockDb({ events: { 901: { entity_id: '563787', lp_lead_id: '563787' } } });
  const { lead, source } = await resolveSyncLead({ event_id: 901 }, {}, 'CONTACT1', db);
  assert.equal(lead.lp_lead_id, '563787');
  assert.equal(lead.appointment_date, '2026-08-05T17:00:00+00:00');
  assert.equal(source, 'event_lead');
});

// ── Precedence ─────────────────────────────────────────────────────────────
test('payload.lp_lead_id beats the event lead (backfill / manual override)', async () => {
  const db = mockDb({ events: { 902: { entity_id: '563787' } } });
  const { lead, source } = await resolveSyncLead(
    { event_id: 902 }, { lp_lead_id: '563753' }, 'CONTACT1', db);
  assert.equal(lead.lp_lead_id, '563753');
  assert.equal(source, 'payload_override');
  assert.equal(db.calls.some((c) => c.table === 'system_events'), false,
    'an explicit override must not bother reading the event');
});

test('no event id falls back to newest-by-created_at_lp — unchanged behaviour', async () => {
  const db = mockDb();
  const { lead, source } = await resolveSyncLead({}, {}, 'CONTACT1', db);
  assert.equal(lead.lp_lead_id, '563790', 'newest by created_at_lp');
  assert.equal(source, 'newest_lead');
  const scan = db.calls.find((c) => c.flt.ghl_contact_id);
  assert.deepEqual(scan.flt.__order, ['created_at_lp', { ascending: false }],
    'ordering must stay created_at_lp to agree with isNewestLeadForContact');
});

test('an event with no lead falls back to newest', async () => {
  const db = mockDb({ events: { 903: { entity_id: null, lp_lead_id: null } } });
  const { source } = await resolveSyncLead({ event_id: 903 }, {}, 'CONTACT1', db);
  assert.equal(source, 'newest_lead');
});

test('a missing event row falls back to newest', async () => {
  const db = mockDb({ events: {} });
  const { lead, source } = await resolveSyncLead({ event_id: 999 }, {}, 'CONTACT1', db);
  assert.equal(source, 'newest_lead');
  assert.equal(lead.lp_lead_id, '563790');
});

test('entity_id alone is enough — lp_lead_id is not required on the event row', async () => {
  const db = mockDb({ events: { 904: { entity_id: '563753' } } });
  const { lead, source } = await resolveSyncLead({ event_id: 904 }, {}, 'CONTACT1', db);
  assert.equal(lead.lp_lead_id, '563753');
  assert.equal(source, 'event_lead');
});

// ── Cross-contact guard ────────────────────────────────────────────────────
test('an event lead belonging to a DIFFERENT contact cannot redirect the write', async () => {
  // action.target_id is the contact; the event's lead must agree with it or we
  // would mirror one contact's appointment onto another's calendar.
  const leads = {
    ...LEADS,
    999999: { lp_lead_id: '999999', ghl_contact_id: 'OTHER', disposition_code: 'Cnf', created_at_lp: '2026-08-02T23:00:00Z' },
  };
  const db = mockDb({ leads, events: { 905: { entity_id: '999999' } } });
  const { lead, source } = await resolveSyncLead({ event_id: 905 }, {}, 'CONTACT1', db);
  assert.equal(source, 'newest_lead');
  assert.equal(lead.ghl_contact_id, 'CONTACT1');
});

test('an event lead absent from lp_leads falls back to newest', async () => {
  const db = mockDb({ events: { 906: { entity_id: '404404' } } });
  const { source } = await resolveSyncLead({ event_id: 906 }, {}, 'CONTACT1', db);
  assert.equal(source, 'newest_lead');
});

// ── Errors and empties ─────────────────────────────────────────────────────
test('a contact with no leads resolves to null, not a throw', async () => {
  const db = mockDb();
  const { lead } = await resolveSyncLead({}, {}, 'NOBODY', db);
  assert.equal(lead, null);
});

test('an lp_leads read error throws so the executor retries', async () => {
  const db = mockDb({ leadError: 'connection reset' });
  await assert.rejects(() => resolveSyncLead({}, {}, 'CONTACT1', db), /lp_leads read failed/);
});

// ── The columns the claim depends on ───────────────────────────────────────
test('the select carries the columns authority needs', async () => {
  // updated_at_lp → lp_appointment_seen_at (the staleness clock);
  // lp_prospect_id → the authority row; created_at_lp → the fallback ordering.
  // These used to exist only inside .order().
  const db = mockDb();
  let selected = '';
  const spy = { from: (t) => { const q = db.from(t); const s = q.select.bind(q); q.select = (cols) => { if (t === 'lp_leads' && cols) selected = cols; return s(cols); }; return q; } };
  await resolveSyncLead({}, {}, 'CONTACT1', spy);
  for (const col of ['lp_prospect_id', 'created_at_lp', 'updated_at_lp', 'disposition_code', 'appointment_date', 'ghl_contact_id']) {
    assert.ok(selected.includes(col), `lp_leads select must carry ${col}`);
  }
});

// ── Authority gating policy (pure) ─────────────────────────────────────────
const { shouldBlockOnAuthority, authorityFollowUp } =
  await import('../src/actions/handlers/lp-ghl-appointment-sync.js');

const DENIED = { granted: false, shadowDenied: false, ownerLeadId: '563787' };
const GRANTED = { granted: true, shadowDenied: false };
const SHADOW = { granted: true, shadowDenied: true, ownerLeadId: '563787' };

test('CANARY: a denied CXL still cancels — authority never gates a cancellation', () => {
  // CXL ranks 0, so a non-owner cancellation loses every arbitration clause.
  // Blocking it would leave a dead appointment live on the calendar and send a
  // rep to a house the customer cancelled. The reconciler carves cancel out of
  // its consent, impossible-hour and multi-appointment guards for the same
  // reason; converging a dead appointment to zero is never the unsafe direction.
  assert.equal(shouldBlockOnAuthority(DENIED, 'CXL'), false);
  assert.equal(shouldBlockOnAuthority(DENIED, ' CXL '), false, 'codes are trimmed');
});

test('a denied Set/Cnf/Verif IS blocked', () => {
  for (const code of ['Set', 'Cnf', 'Verif']) {
    assert.equal(shouldBlockOnAuthority(DENIED, code), true, `${code} must be blocked`);
  }
});

test('a granted claim never blocks, whatever the disposition', () => {
  for (const code of ['Set', 'Cnf', 'Verif', 'CXL', null]) {
    assert.equal(shouldBlockOnAuthority(GRANTED, code), false);
  }
  assert.equal(shouldBlockOnAuthority(SHADOW, 'Set'), false, 'dark mode reports granted');
});

test('follow-up: a successful cancel RELEASES the seat, it does not record', () => {
  // Otherwise the next writer waits out the full 14-day staleness window for a
  // seat whose appointment is already gone.
  const f = authorityFollowUp(GRANTED, { outcome: 'cancelled', appointment_id: 'hXMB' });
  assert.equal(f.release, true);
  assert.equal(f.record, null);
});

test('follow-up: a successful write records the real appointment id', () => {
  // This is what arms the "no live appointment" clause for the NEXT claimant —
  // skipping it quietly disables enforcement, since the claim itself always
  // passes a null appointment id.
  const f = authorityFollowUp(GRANTED, {
    outcome: 'created', appointment_id: 'new-1', start_time: '2026-08-05T17:00:00-04:00',
  });
  assert.equal(f.release, false);
  assert.deepEqual(f.record, { appointmentId: 'new-1', appointmentStart: '2026-08-05T17:00:00-04:00' });
});

test('CANARY: a DARK-MODE shadow denial persists NOTHING', () => {
  // The write went through, but the appointment belongs to the DENIED lead
  // while the row names a different owner. Recording it would corrupt exactly
  // the data the dark soak exists to read.
  assert.deepEqual(authorityFollowUp(SHADOW, { outcome: 'created', appointment_id: 'new-1' }),
    { release: false, record: null });
  assert.deepEqual(authorityFollowUp(SHADOW, { outcome: 'cancelled' }),
    { release: false, record: null });
});

test('follow-up: noops and denials persist nothing', () => {
  for (const result of [
    { outcome: 'noop', reason: 'already_in_sync' },
    { outcome: 'noop', reason: 'dnc_consent' },
    null, undefined,
  ]) {
    assert.deepEqual(authorityFollowUp(GRANTED, result), { release: false, record: null });
  }
  assert.deepEqual(authorityFollowUp(DENIED, { outcome: 'created', appointment_id: 'x' }),
    { release: false, record: null });
});
