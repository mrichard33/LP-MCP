/**
 * test-appt-event-dedup.js — sequence-aware appointment-event dedup.
 *
 * Exercises src/services/appt-event-dedup.js against an in-memory mock of the
 * system_events table. The core property under test: dedup keys on the SLOT and
 * the LAST EVENT TYPE, never on a status-bearing key, so:
 *   - duplicate booked / duplicate cancelled collapse to one event;
 *   - a rebook after a cancel (book → cancel → book, same slot) still EMITS —
 *     the production regression that a status-bearing key would have swallowed
 *     (canary YHSGdUigcsLWrToPpFAc);
 *   - appointment_id makes an event permanently idempotent (no window), but only
 *     against the SAME event_type — alternation still emits;
 *   - any lookup error fails OPEN (emit).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { buildApptSlotKey, checkApptEventDedup } = await import('../src/services/appt-event-dedup.js');

const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();

// SQL LIKE → RegExp (% → .*, _ → any single char) so the mock matches PostgREST.
function likeToRegex(pat) {
  let re = '^';
  for (const ch of pat) {
    if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

// Stateful mock of system_events. Each row: { entity_id, idempotency_key,
// event_type, created_at }.
function mockClient(rows = []) {
  return {
    from() {
      const st = { filters: [], order: null, limit: null };
      const api = {
        select() { return api; },
        eq(k, v) { st.filters.push((r) => String(r[k]) === String(v)); return api; },
        like(k, v) { const re = likeToRegex(v); st.filters.push((r) => re.test(String(r[k] || ''))); return api; },
        gte(k, v) { st.filters.push((r) => r[k] && new Date(r[k]).getTime() >= new Date(v).getTime()); return api; },
        order(k, o) { st.order = { k, asc: o?.ascending === true }; return api; },
        limit(n) { st.limit = n; return api; },
        then(resolve, reject) {
          try {
            let out = rows.slice();
            for (const f of st.filters) out = out.filter(f);
            if (st.order) out.sort((a, b) => (new Date(a[st.order.k]) - new Date(b[st.order.k])) * (st.order.asc ? 1 : -1));
            if (st.limit != null) out = out.slice(0, st.limit);
            return Promise.resolve({ data: out, error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return api;
    },
  };
}

// A client whose lookup throws (simulates a timeout / infra error).
function throwingClient() {
  return { from: () => ({
    select() { return this; }, eq() { return this; }, like() { return this; },
    gte() { return this; }, order() { return this; }, limit() { return this; },
    then(_res, rej) { return Promise.reject(new Error('boom')).then(_res, rej); },
  }) };
}

// Seed a stored event row for a slot at a given status/time.
function seedEvent({ contactId, calendarId, appointmentId, startDate, startTime, status, eventType, createdAt }) {
  const slotKey = buildApptSlotKey({ contactId, calendarId, appointmentId, startDate, startTime });
  return {
    entity_id: contactId,
    idempotency_key: `${slotKey}_${status}_${new Date(createdAt).getTime()}`,
    event_type: eventType,
    created_at: createdAt,
  };
}

const SLOT = { contactId: 'C1', calendarId: 'CAL', startDate: '2026-07-30', startTime: '2026-07-30T13:30:00-04:00', appointmentId: null };

// ═══ buildApptSlotKey — no status segment ═════════════════════════════
test('buildApptSlotKey: slot-key shape (no appointment id, no status)', () => {
  const k = buildApptSlotKey({ contactId: 'C1', calendarId: 'CAL', startDate: '2026-07-30', startTime: 'T', appointmentId: null });
  assert.equal(k, 'ghl_appt_C1_slot:CAL:2026-07-30:T');
  assert.ok(!/booked|cancelled|_new_/.test(k), 'key must carry no status segment');
});

test('buildApptSlotKey: id-key shape when appointment id present', () => {
  const k = buildApptSlotKey({ contactId: 'C1', appointmentId: 'APPT9' });
  assert.equal(k, 'ghl_appt_C1_id:APPT9');
});

// ═══ duplicate same-type collapses ════════════════════════════════════
test('booked → booked, same slot, straddling :30 boundary → second deduped', async () => {
  // Prior booked at 13:29:20 (created 100s ago), second booked "now" at 13:31 —
  // straddles :30. Under the old bucket these were different keys; here both are
  // the same slot + same event_type → deduped.
  const rows = [seedEvent({ ...SLOT, status: 'new', eventType: 'ghl.appointment_booked', createdAt: ago(100_000) })];
  const res = await checkApptEventDedup(
    { ...SLOT, status: 'new', eventType: 'ghl.appointment_booked' },
    { client: mockClient(rows), windowMinutes: 60 },
  );
  assert.equal(res.deduped, true);
});

test('cancelled → cancelled, same slot, inside window → deduped', async () => {
  const rows = [seedEvent({ ...SLOT, status: 'cancelled', eventType: 'ghl.appointment_cancelled', createdAt: ago(90_000) })];
  const res = await checkApptEventDedup(
    { ...SLOT, status: 'cancelled', eventType: 'ghl.appointment_cancelled' },
    { client: mockClient(rows), windowMinutes: 60 },
  );
  assert.equal(res.deduped, true);
});

// ═══ THE REGRESSION — rebook must emit (canary YHSGdUigcsLWrToPpFAc) ═══
test('booked → cancelled → booked, same slot, all within window → third EMITS', async () => {
  // canary YHSGdUigcsLWrToPpFAc: booked 17:27:43 → cancelled 17:29:14 →
  // rebooked 17:31:17. The most recent slot event is the cancel; the incoming
  // rebook has a different event_type → NOT deduped → the rebooking emits.
  const rows = [
    seedEvent({ ...SLOT, status: 'new', eventType: 'ghl.appointment_booked', createdAt: ago(214_000) }),      // booked (older)
    seedEvent({ ...SLOT, status: 'cancelled', eventType: 'ghl.appointment_cancelled', createdAt: ago(123_000) }), // cancelled (most recent)
  ];
  const res = await checkApptEventDedup(
    { ...SLOT, status: 'new', eventType: 'ghl.appointment_booked' },
    { client: mockClient(rows), windowMinutes: 60 },
  );
  assert.equal(res.deduped, false, 'rebook after cancel must emit');
});

// ═══ appointment_id → permanent idempotency, but only per event_type ══
test('appointment_id present: same event_type dedupes regardless of age', async () => {
  const withId = { contactId: 'C2', appointmentId: 'APPT-XYZ', calendarId: 'CAL', startDate: null, startTime: null };
  // Prior booked TWO HOURS ago — outside any 60-min window — must still dedupe a
  // repeat booked because appointment_id is permanently idempotent.
  const rows = [seedEvent({ ...withId, status: 'new', eventType: 'ghl.appointment_booked', createdAt: ago(2 * 3600 * 1000) })];
  const res = await checkApptEventDedup(
    { ...withId, status: 'new', eventType: 'ghl.appointment_booked' },
    { client: mockClient(rows), windowMinutes: 60 },
  );
  assert.equal(res.deduped, true);
});

test('appointment_id present: alternation (booked → cancelled) still emits', async () => {
  const withId = { contactId: 'C2', appointmentId: 'APPT-XYZ', calendarId: 'CAL', startDate: null, startTime: null };
  const rows = [seedEvent({ ...withId, status: 'new', eventType: 'ghl.appointment_booked', createdAt: ago(2 * 3600 * 1000) })];
  const res = await checkApptEventDedup(
    { ...withId, status: 'cancelled', eventType: 'ghl.appointment_cancelled' },
    { client: mockClient(rows), windowMinutes: 60 },
  );
  assert.equal(res.deduped, false, 'cancel of a booked appointment must emit');
});

// ═══ fail-open ════════════════════════════════════════════════════════
test('dedup query throws → deduped:false (fail-open, event emits)', async () => {
  const res = await checkApptEventDedup(
    { ...SLOT, status: 'new', eventType: 'ghl.appointment_booked' },
    { client: throwingClient(), windowMinutes: 60 },
  );
  assert.equal(res.deduped, false);
  assert.equal(res.reason, 'error_open');
});

test('no prior event → emits, and idempotencyKey carries status + is unique-suffixed', async () => {
  const res = await checkApptEventDedup(
    { ...SLOT, status: 'new', eventType: 'ghl.appointment_booked' },
    { client: mockClient([]), windowMinutes: 60 },
  );
  assert.equal(res.deduped, false);
  assert.match(res.idempotencyKey, /^ghl_appt_C1_slot:CAL:2026-07-30:.*_new_\d+$/);
});
