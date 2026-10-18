/**
 * Fix 8 — the watchdog corrects sync-created estimates that drifted from LP
 * (handoff v3.4, 2026-10-16). ESTIMATE_DRIFT_FIX_MODE off | shadow | live,
 * default shadow. Never `cancelled`, never an LP write, never a person's booking.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { decideDrift: decideDriftAt, inDriftScope, overCap, estimateDriftMode, DRIFT_RULE } = await import('../src/appointments/estimate-drift.js');
const { runEstimateDriftFix, correctConflictIfSyncCreated } = await import('../src/appointments/estimate-drift-io.js');
const { wallClockToIso } = await import('../src/appointment-dates.js');

const WE = 'aJj14ONxh1oFyDcQ706O';
const NOW = Date.parse('2026-10-16T16:00:00Z');
// The pure tests run at the fixed NOW, so the November fixtures stay in the future.
const decideDrift = (a) => decideDriftAt({ nowMs: NOW, ...a });
const today = '2026-10-16T12:00:00+00:00';
const lead = (code = 'Set', extra = {}) => ({ lp_lead_id: '475840', disposition_code: code, appointment_date: '2026-11-03T10:00:00+00:00', synced_at: today, updated_at_lp: today, created_at_lp: today, ...extra });
const live = (time = '10:00', date = '2026-11-03', disposition = 'Set') => ({ ok: true, date, time, timeStatus: 'known', disposition });
const appt = (start, extra = {}) => ({ ghl_appointment_id: 'ap1', ghl_contact_id: 'c1', ghl_calendar_id: WE, status: 'new', start_time: start, ...extra });

// Gilles/Edouard-style: synced 15:00 off a stale UTC row, LP live says 10:00.
const NOV_15 = wallClockToIso('2026-11-03', '15:00');
const NOV_10 = wallClockToIso('2026-11-03', '10:00');

test('November time is labelled -05:00, October -04:00 (ET via wallClockToIso)', () => {
  assert.match(NOV_10, /-05:00$/);
  assert.match(wallClockToIso('2026-10-20', '10:00'), /-04:00$/);
});

test('sync-created 15:00 vs LP 10:00 → reschedule to 10:00 ET', () => {
  const p = decideDrift({ appt: appt(NOV_15), lead: lead(), live: live('10:00'), createdStartTime: NOV_15 });
  assert.deepEqual([p.op, p.startTime], ['reschedule', NOV_10]);
});

test('year-typo date → mark_invalid + an LP-looks-wrong card', () => {
  const ghost = lead('Set', { updated_at_lp: '2025-11-26T00:00:00+00:00', created_at_lp: '2025-11-20T00:00:00+00:00', set_date: null });
  const ghostLive = { ...live('10:00'), setDate: '2025-11-20', lastChangedOn: '2025-11-26' };
  const p = decideDrift({ appt: appt(NOV_10), lead: ghost, live: ghostLive, createdStartTime: NOV_10 });
  assert.equal(p.op, 'mark_invalid');
  assert.equal(p.card.reason, 'implausible_future_appointment');
});

test('CXL / Verif / ND / No Demo are never touched here; human-edited and LP unreadable skip', () => {
  assert.equal(decideDrift({ appt: appt(NOV_15), lead: lead('CXL'), live: live(), createdStartTime: NOV_15 }).op, 'none');
  assert.equal(decideDrift({ appt: appt(NOV_15), lead: lead('Verif'), live: live(), createdStartTime: NOV_15 }).reason, 'verif_hold');
  for (const c of ['ND', 'No Demo']) assert.equal(decideDrift({ appt: appt(NOV_15), lead: lead(c), live: live(), createdStartTime: NOV_15 }).reason, 'disqualified_owned_by_fix2');
  // A person moved it: it no longer sits where our create put it.
  assert.equal(decideDrift({ appt: appt(NOV_15), lead: lead(), live: live(), createdStartTime: NOV_10 }).reason, 'edited_since_create');
  assert.equal(decideDrift({ appt: appt(NOV_15), lead: lead(), live: { ok: false }, createdStartTime: NOV_15 }).reason, 'lp_unreadable');
  assert.equal(decideDrift({ appt: appt(NOV_10), lead: lead(), live: live('10:00'), createdStartTime: NOV_10 }).reason, 'in_sync');
});

test('scope: active, future, estimate pool only', () => {
  assert.equal(inDriftScope(appt(NOV_10), NOW), true);
  assert.equal(inDriftScope(appt(NOV_10, { status: 'invalid' }), NOW), false);
  assert.equal(inDriftScope(appt(NOV_10, { ghl_calendar_id: 'gFWoSQrlKIdfRbAPV842' }), NOW), false);
  assert.equal(inDriftScope(appt('2026-10-01T10:00:00-04:00'), NOW), false);
});

test('mode defaults to shadow; a typo is shadow', () => {
  assert.equal(estimateDriftMode({}), 'shadow');
  assert.equal(estimateDriftMode({ ESTIMATE_DRIFT_FIX_MODE: 'lvie' }), 'shadow');
  assert.equal(estimateDriftMode({ ESTIMATE_DRIFT_FIX_MODE: 'live' }), 'live');
});

function ioDeps(over = {}) {
  const rec = { puts: [], rows: [], events: [], alerts: [], cards: [], marks: [] };
  const deps = {
    nowMs: NOW,
    readSyncCreatedStarts: async () => new Map([['ap1', NOV_15]]),
    resolveLead: async () => lead(),
    readLive: async () => live('10:00'),
    putReschedule: async (a) => { rec.puts.push(a); },
    markRescheduleInflight: async (c) => { rec.marks.push(c); },
    queueRows: async (rows) => { rec.rows.push(...rows); },
    notify: async (a) => { rec.cards.push(a); },
    emitEvent: async (e) => { rec.events.push(e); return { id: 1 }; },
    sendAlert: async (t) => { rec.alerts.push(t); },
    log: () => {},
    ...over,
  };
  return { deps, rec };
}

test('shadow: logs and records appt.drift_detected, writes nothing', async () => {
  const { deps, rec } = ioDeps({ mode: 'shadow' });
  const s = await runEstimateDriftFix({ ghlActive: new Map([['c1', appt(NOV_15)]]), deps });
  assert.equal(s.would.reschedule, 1);
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.events.filter((e) => e.event_type === 'appt.drift_detected').length, 1);
});

test('live: reschedules in place after marking reschedule-inflight', async () => {
  const { deps, rec } = ioDeps({ mode: 'live' });
  const s = await runEstimateDriftFix({ ghlActive: new Map([['c1', appt(NOV_15)]]), deps });
  assert.equal(s.applied.reschedule, 1);
  assert.deepEqual(rec.marks, ['c1']);
  assert.deepEqual(rec.puts[0], { appointmentId: 'ap1', calendarId: WE, startTime: NOV_10 });
});

test('live, year-typo: invalid (never cancelled), A.WE-1 out, reminder tags off, one card', async () => {
  const ghost = lead('Set', { updated_at_lp: '2025-11-26T00:00:00+00:00', created_at_lp: '2025-11-20T00:00:00+00:00' });
  const { deps, rec } = ioDeps({
    mode: 'live', readSyncCreatedStarts: async () => new Map([['ap1', NOV_10]]),
    resolveLead: async () => ghost, readLive: async () => ({ ...live('10:00'), setDate: '2025-11-20', lastChangedOn: '2025-11-26' }),
  });
  const s = await runEstimateDriftFix({ ghlActive: new Map([['c1', appt(NOV_10)]]), deps });
  assert.equal(s.applied.mark_invalid, 1);
  assert.deepEqual(rec.rows.map((r) => r.action_type), ['update_appointment_status', 'remove_from_workflow', 'remove_tag']);
  assert.equal(rec.rows[0].action_payload.status, 'invalid');
  assert.ok(rec.rows.every((r) => r.rule_applied === DRIFT_RULE));
  assert.equal(rec.cards.length, 1);
});

test('a person or workflow made it (no sync created event) → untouched', async () => {
  const { deps, rec } = ioDeps({ mode: 'live', readSyncCreatedStarts: async () => new Map() });
  const s = await runEstimateDriftFix({ ghlActive: new Map([['c1', appt(NOV_15)]]), deps });
  assert.equal(s.sync_created, 0);
  assert.equal(rec.puts.length, 0);
});

test('report mode (watchdog dry run) never writes, even with the mode live', async () => {
  const { deps, rec } = ioDeps({ mode: 'live' });
  await runEstimateDriftFix({ ghlActive: new Map([['c1', appt(NOV_15)]]), dryRun: true, deps });
  assert.equal(rec.puts.length, 0);
});

test('more than 25 corrections → none applied, ONE ops card', async () => {
  const many = new Map();
  for (let i = 0; i < 26; i++) many.set(`c${i}`, appt(NOV_15, { ghl_appointment_id: `ap${i}`, ghl_contact_id: `c${i}` }));
  const starts = new Map([...many.values()].map((a) => [a.ghl_appointment_id, NOV_15]));
  const { deps, rec } = ioDeps({ mode: 'live', readSyncCreatedStarts: async () => starts });
  const s = await runEstimateDriftFix({ ghlActive: many, deps });
  assert.equal(s.capped, true);
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.alerts.length, 1);
  assert.equal(overCap(Array.from({ length: 25 }, () => ({ op: 'reschedule' }))), false);
});

test('conflict branch: sync-created → corrected, no card; a human booking → card as before', async () => {
  const base = ioDeps({ mode: 'live' }).deps;
  const deps = { ...base, fetchUpcomingAppointments: async () => [{ appointment_id: 'ap1', calendar_id: WE, status: 'new', start_time: NOV_15 }] };
  const fixed = await correctConflictIfSyncCreated({ contactId: 'c1', lpLeadId: '475840', ghlStartIso: NOV_15, deps });
  assert.equal(fixed.corrected, true);
  const human = await correctConflictIfSyncCreated({ contactId: 'c1', lpLeadId: '475840', ghlStartIso: NOV_15, deps: { ...deps, readSyncCreatedStarts: async () => new Map() } });
  assert.deepEqual([human.corrected, human.reason], [false, 'not_sync_created']);
  const shadow = await correctConflictIfSyncCreated({ contactId: 'c1', lpLeadId: '475840', ghlStartIso: NOV_15, deps: { ...deps, mode: 'shadow' } });
  assert.deepEqual([shadow.corrected, shadow.would], [false, 'reschedule']);
});

// Affeld (vg8HD7VB3E9jtHUZvB8y, 2026-10-17): the endpoint booked Sun 10/18 10 AM for a
// canvass lead; the contact linked only to 2016 lead 48501, whose stored visit was 9/28.
// With the mode live the fix moved the visit to 9/28. Never again.
const AFFELD_NOW = Date.parse('2026-10-17T20:14:00Z');
const OCT18 = wallClockToIso('2026-10-18', '10:00');
const affeldLead = lead('Set', { lp_lead_id: '48501', appointment_date: '2026-09-28T10:00:00+00:00', created_at_lp: '2016-11-14T14:37:17+00:00', updated_at_lp: '2026-10-17T15:44:49+00:00', synced_at: '2026-10-17T19:45:26+00:00' });

test('Affeld: LP time already passed → skip lp_time_past, never a reschedule into the past', () => {
  const p = decideDriftAt({ appt: appt(OCT18), lead: affeldLead, live: live('10:00', '2026-09-28'), createdStartTime: OCT18, createdBy: 'endpoint', createdAt: '2026-10-17T19:47:39Z', nowMs: AFFELD_NOW });
  assert.deepEqual([p.op, p.reason], ['skip', 'lp_time_past']);
});

test('a correction never lands under 60 minutes from now', () => {
  const soon = new Date(NOW + 30 * 60_000);
  const hhmm = soon.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  const p = decideDrift({ appt: appt(NOV_15), lead: lead(), live: live(hhmm, '2026-10-16'), createdStartTime: NOV_15 });
  assert.equal(p.reason, 'lp_time_past');
});

test('endpoint booked after the LP lead last changed → skip lp_unchanged_since_booking (future LP date too)', () => {
  const stale = lead('Set', { updated_at_lp: '2026-10-15T09:00:00+00:00' });
  const p = decideDrift({ appt: appt(NOV_15), lead: stale, live: live('10:00'), createdStartTime: NOV_15, createdBy: 'endpoint', createdAt: '2026-10-15T20:00:00Z' });
  assert.deepEqual([p.op, p.reason], ['skip', 'lp_unchanged_since_booking']);
  // A reconciler create was built from the lead, so the same mismatch is still ours to fix.
  const ours = decideDrift({ appt: appt(NOV_15), lead: stale, live: live('10:00'), createdStartTime: NOV_15, createdBy: 'reconciler', createdAt: '2026-10-15T20:00:00Z' });
  assert.equal(ours.op, 'reschedule');
  // LP changed after the booking (it moved the visit) → follow LP.
  const moved = decideDrift({ appt: appt(NOV_15), lead: lead('Set', { updated_at_lp: '2026-10-16T09:00:00+00:00' }), live: live('10:00'), createdStartTime: NOV_15, createdBy: 'endpoint', createdAt: '2026-10-15T20:00:00Z' });
  assert.equal(moved.op, 'reschedule');
});

test('Affeld through the I/O: live mode, no PUT, nothing auto-fixed', async () => {
  const { deps, rec } = ioDeps({
    mode: 'live', nowMs: AFFELD_NOW,
    readSyncCreatedStarts: async () => new Map([['ap1', { startTime: OCT18, createdBy: 'endpoint', createdAt: '2026-10-17T19:47:39Z' }]]),
    resolveLead: async () => affeldLead, readLive: async () => live('10:00', '2026-09-28'),
  });
  const s = await runEstimateDriftFix({ ghlActive: new Map([['c1', appt(OCT18)]]), deps });
  assert.equal(rec.puts.length, 0);
  assert.equal(s.skipped.lp_time_past, 1);
  assert.equal(rec.events.filter((e) => e.event_type === 'appointment.parity_auto_fixed').length, 0);
});
