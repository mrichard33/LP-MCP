/**
 * Straggler cancel pass (Change D2) — scripts/test-ghl-straggler-cancel.js
 *
 * The thing under test is a SCOPE decision, not a mutation: ~300 past-dated
 * open GHL appointments land every week and must not be touched, while the
 * handful whose contact also holds a live forward LP appointment must be.
 * These tests therefore lean on the pure selector, and drive the I/O path
 * through the `deps` seam so nothing reaches GHL or either Supabase.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectStragglers,
  stragglerScopeGuardMax,
  runStragglerCancelPass,
  STRAGGLER_OPEN_STATUSES,
  DEFAULT_STRAGGLER_LOOKBACK_DAYS,
} from '../src/admin/ghl-straggler-cancel.js';
import { ESTIMATE_CALENDAR_IDS } from '../src/services/lp-ghl-appointment-reconciler.js';

const WE = Array.from(ESTIMATE_CALENDAR_IDS)[0];
const NOW = Date.parse('2026-09-14T18:00:00Z');
const PAST = '2026-09-08T10:00:00-04:00';
const FUTURE = '2026-09-20T10:00:00-04:00';

function row(over = {}) {
  return {
    ghl_contact_id: 'C1',
    ghl_appointment_id: 'A1',
    ghl_calendar_id: WE,
    status: 'new',
    start_time: PAST,
    deleted_at: null,
    ...over,
  };
}

// ── The pure selector ────────────────────────────────────────────────

test('selects a past-dated open estimate appointment for an in-scope contact', () => {
  const got = selectStragglers({
    mirrorRows: [row()],
    scopeContactIds: new Set(['C1']),
    nowMs: NOW,
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].appointment_id, 'A1');
  assert.equal(got[0].stale_start_time, PAST);
});

test('THE SCOPE RULE: a contact with no live forward LP appointment is never a candidate', () => {
  // This is the ~300/week population. Same row, contact simply not in scope.
  const got = selectStragglers({
    mirrorRows: [row()],
    scopeContactIds: new Set(['someone-else']),
    nowMs: NOW,
  });
  assert.deepEqual(got, []);
});

test('rejects rows that are not past / not open / not estimate-pool / tombstoned', () => {
  const rows = [
    row({ ghl_appointment_id: 'future', start_time: FUTURE }),
    row({ ghl_appointment_id: 'cancelled', status: 'cancelled' }),
    row({ ghl_appointment_id: 'showed', status: 'showed' }),
    row({ ghl_appointment_id: 'noshow', status: 'no_show' }),
    row({ ghl_appointment_id: 'phone', ghl_calendar_id: 'some-phone-calendar' }),
    row({ ghl_appointment_id: 'deleted', deleted_at: '2026-09-01T00:00:00Z' }),
    row({ ghl_appointment_id: 'unparseable', start_time: 'not a date' }),
    row({ ghl_appointment_id: null }),
  ];
  const got = selectStragglers({ mirrorRows: rows, scopeContactIds: new Set(['C1']), nowMs: NOW });
  assert.deepEqual(got, []);
});

test('only new and confirmed count as open', () => {
  assert.deepEqual(Array.from(STRAGGLER_OPEN_STATUSES).sort(), ['confirmed', 'new']);
});

test('an appointment the create/reschedule pass just wrote is excluded', () => {
  // The HL mirror still carries the OLD start time after a reschedule, so
  // without this the pass would cancel the booking it had just fixed.
  const got = selectStragglers({
    mirrorRows: [row()],
    scopeContactIds: new Set(['C1']),
    touchedAppointmentIds: new Set(['A1']),
    nowMs: NOW,
  });
  assert.deepEqual(got, []);
});

test('de-duplicates repeated mirror rows and sorts oldest first', () => {
  const got = selectStragglers({
    mirrorRows: [
      row({ ghl_appointment_id: 'B', start_time: '2026-09-11T10:00:00-04:00' }),
      row({ ghl_appointment_id: 'A', start_time: '2026-09-02T10:00:00-04:00' }),
      row({ ghl_appointment_id: 'B', start_time: '2026-09-11T10:00:00-04:00' }),
    ],
    scopeContactIds: new Set(['C1']),
    nowMs: NOW,
  });
  assert.deepEqual(got.map((c) => c.appointment_id), ['A', 'B']);
});

// ── The scope guard ──────────────────────────────────────────────────

test('guard is the measured 14-day bound and scales with a wider horizon', () => {
  assert.equal(stragglerScopeGuardMax(14), 20);
  assert.equal(stragglerScopeGuardMax(7), 20);   // never below the floor
  assert.equal(stragglerScopeGuardMax(45), 65);
});

test('a candidate list past the guard cancels NOTHING and reports why', async () => {
  const scope = new Map();
  const mirrorRows = [];
  for (let i = 0; i < 40; i++) {
    scope.set(`C${i}`, { lead: { lp_lead_id: `L${i}` } });
    mirrorRows.push(row({ ghl_contact_id: `C${i}`, ghl_appointment_id: `A${i}` }));
  }
  let puts = 0;
  const res = await runStragglerCancelPass({
    dryRun: false,
    scope,
    horizonDays: 14,
    deps: {
      nowMs: NOW,
      getHlSupabase: () => stubHl(mirrorRows),
      ghlFetch: async () => { puts++; return {}; },
      markRescheduleInflight: async () => ({ marked: true }),
    },
  });
  assert.equal(res.guard_tripped, true);
  assert.equal(res.ran, false);
  assert.equal(res.cancelled, 0);
  assert.equal(puts, 0, 'guard trip must reach GHL zero times');
  assert.match(res.reason, /scope_guard_tripped/);
  assert.deepEqual(res.planned, [], 'a guard trip plans nothing');
  assert.ok(res.guard_sample.length > 0, 'but shows a diagnostic sample');
});

// ── The I/O path ─────────────────────────────────────────────────────

/** Minimal supabase-js query-builder stub: every filter returns `this`. */
function stubHl(rows) {
  const builder = {
    select: () => builder,
    is: () => builder,
    in: () => builder,
    lt: () => builder,
    gte: () => builder,
    then: undefined,
  };
  // Awaiting the builder resolves to { data, error }.
  builder.then = (resolve) => resolve({ data: rows, error: null });
  return { from: () => builder };
}

test('dry run plans the cancel with contact id, appointment id and stale start time, and mutates nothing', async () => {
  let calls = 0;
  const res = await runStragglerCancelPass({
    dryRun: true,
    scope: new Map([['C1', { lead: { lp_lead_id: '571742', first_name: 'Donald', last_name: 'Jacob', appointment_date: '2026-09-20T10:00:00+00:00' } }]]),
    horizonDays: 14,
    deps: {
      nowMs: NOW,
      getHlSupabase: () => stubHl([row()]),
      ghlFetch: async () => { calls++; return {}; },
      markRescheduleInflight: async () => ({ marked: true }),
    },
  });
  assert.equal(res.ran, true);
  assert.equal(res.guard_tripped, false);
  assert.equal(calls, 0, 'dry run must not call GHL');
  assert.deepEqual(res.planned, [{
    contact_id: 'C1',
    appointment_id: 'A1',
    stale_start_time: PAST,
    status: 'new',
    lp_lead_id: '571742',
    lp_appointment_date: '2026-09-20T10:00:00+00:00',
    name: 'Donald Jacob',
  }]);
});

test('live run re-reads GHL and cancels only what is still past and still open', async () => {
  const seen = [];
  const live = {
    A1: { id: 'A1', appointmentStatus: 'new', startTime: PAST },              // still stale
    A2: { id: 'A2', appointmentStatus: 'cancelled', startTime: PAST },        // already cancelled
    A3: { id: 'A3', appointmentStatus: 'confirmed', startTime: FUTURE },      // moved forward since the mirror
  };
  const res = await runStragglerCancelPass({
    dryRun: false,
    scope: new Map([['C1', { lead: {} }], ['C2', { lead: {} }], ['C3', { lead: {} }]]),
    horizonDays: 14,
    deps: {
      nowMs: NOW,
      getHlSupabase: () => stubHl([
        row({ ghl_contact_id: 'C1', ghl_appointment_id: 'A1' }),
        row({ ghl_contact_id: 'C2', ghl_appointment_id: 'A2' }),
        row({ ghl_contact_id: 'C3', ghl_appointment_id: 'A3', status: 'confirmed' }),
      ]),
      ghlFetch: async (method, path, body) => {
        seen.push({ method, path, body });
        if (method === 'GET') return live[path.split('/').pop()];
        return {};
      },
      markRescheduleInflight: async () => ({ marked: true }),
    },
  });
  assert.equal(res.cancelled, 1);
  const puts = seen.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/calendars/events/appointments/A1');
  assert.deepEqual(puts[0].body, { appointmentStatus: 'cancelled' });
  assert.deepEqual(res.skipped.map((s) => s.reason).sort(), ['start_time_now_forward', 'status_now_cancelled']);
});

test('a failed live read cancels nothing for that appointment (fail closed)', async () => {
  const res = await runStragglerCancelPass({
    dryRun: false,
    scope: new Map([['C1', { lead: {} }]]),
    deps: {
      nowMs: NOW,
      getHlSupabase: () => stubHl([row()]),
      ghlFetch: async (method) => {
        if (method === 'GET') throw new Error('502 from GHL');
        throw new Error('must not PUT after a failed read');
      },
      markRescheduleInflight: async () => ({ marked: true }),
    },
  });
  assert.equal(res.cancelled, 0);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].error, /502 from GHL/);
});

test('an unreadable mirror reports instead of proceeding blind', async () => {
  const res = await runStragglerCancelPass({
    dryRun: true,
    scope: new Map([['C1', { lead: {} }]]),
    deps: {
      nowMs: NOW,
      getHlSupabase: () => { throw new Error('HL fallback not configured'); },
    },
  });
  assert.equal(res.ran, false);
  assert.equal(res.candidates, 0);
  assert.match(res.reason, /mirror_read_failed/);
});

test('an empty scope short-circuits before any read', async () => {
  const res = await runStragglerCancelPass({
    dryRun: true,
    scope: new Map(),
    deps: { nowMs: NOW, getHlSupabase: () => { throw new Error('must not read'); } },
  });
  assert.equal(res.ran, false);
  assert.equal(res.reason, 'no_contacts_with_live_forward_lp_appointment');
  assert.equal(res.lookback_days, DEFAULT_STRAGGLER_LOOKBACK_DAYS);
});
