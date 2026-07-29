/**
 * Tests — GHL slot-uniqueness check (src/appointments/slot-check.js)
 * scripts/test-appt-slot-check.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-appt-slot-check.js
 *
 * Pure-function tests for the slot-matching predicate — no DB, no network.
 * Guards the invariants that actually decide whether a duplicate gets created:
 *
 *   • the match window is a TOLERANCE on absolute instants, not a string compare
 *   • equivalent instants written with different UTC offsets are the same slot
 *   • only 'new'/'confirmed' occupy a slot (a cancelled one frees it)
 *   • a different calendar is never a match
 *   • GHL's misspelled `appoinmentStatus` is still read
 */

// Supabase client construction in src/supabase.js reads env at import time, and
// slot-check imports it transitively via the event emitter. Harmless dummies so
// the module graph loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.APPT_SLOT_MATCH_WINDOW_S ||= '60';

import test from 'node:test';
import assert from 'node:assert/strict';

import { occupiesSlot, readStatus, matchWindowSeconds, isSlotCheckEnabled } from '../src/appointments/slot-check.js';

const CAL = 'aJj14ONxh1oFyDcQ706O';
const TARGET = '2026-07-29T19:00:00-04:00';
const targetMs = Date.parse(TARGET);
const windowMs = 60 * 1000;

const appt = (over = {}) => ({
  appointment_id: 'appt_1',
  calendar_id: CAL,
  start_time: TARGET,
  status: 'confirmed',
  ...over,
});

test('exact instant on the same calendar is a match', () => {
  assert.equal(occupiesSlot(appt(), { calendarId: CAL, targetMs, windowMs }), true);
});

test('within the window matches; outside it does not', () => {
  const at30s = appt({ start_time: '2026-07-29T19:00:30-04:00' });
  const at90s = appt({ start_time: '2026-07-29T19:01:30-04:00' });
  assert.equal(occupiesSlot(at30s, { calendarId: CAL, targetMs, windowMs }), true, '30s inside a 60s window');
  assert.equal(occupiesSlot(at90s, { calendarId: CAL, targetMs, windowMs }), false, '90s outside a 60s window');
});

test('window is symmetric — 30s EARLIER also matches', () => {
  const before = appt({ start_time: '2026-07-29T18:59:30-04:00' });
  assert.equal(occupiesSlot(before, { calendarId: CAL, targetMs, windowMs }), true);
});

test('same instant written with a different offset is the same slot', () => {
  // 23:00Z === 19:00-04:00. A wall-clock string compare would miss this, which
  // is the whole reason the comparison is on epoch ms.
  const utc = appt({ start_time: '2026-07-29T23:00:00Z' });
  assert.equal(occupiesSlot(utc, { calendarId: CAL, targetMs, windowMs }), true);
});

test('a different calendar is never a match', () => {
  const other = appt({ calendar_id: 'zEdPmkNccR2ovo3rQAd3' });
  assert.equal(occupiesSlot(other, { calendarId: CAL, targetMs, windowMs }), false);
});

test('only new/confirmed occupy the slot', () => {
  assert.equal(occupiesSlot(appt({ status: 'new' }), { calendarId: CAL, targetMs, windowMs }), true);
  for (const status of ['cancelled', 'noshow', 'showed', 'invalid', '']) {
    assert.equal(
      occupiesSlot(appt({ status }), { calendarId: CAL, targetMs, windowMs }),
      false,
      `status '${status}' must not occupy the slot`,
    );
  }
});

test('a GHL-deleted appointment does not occupy the slot', () => {
  assert.equal(occupiesSlot(appt({ deleted: true }), { calendarId: CAL, targetMs, windowMs }), false);
});

test('unparseable start times never match (never silently free or occupy)', () => {
  assert.equal(occupiesSlot(appt({ start_time: 'not-a-date' }), { calendarId: CAL, targetMs, windowMs }), false);
  assert.equal(occupiesSlot(appt({ start_time: null }), { calendarId: CAL, targetMs, windowMs }), false);
  assert.equal(occupiesSlot(null, { calendarId: CAL, targetMs, windowMs }), false);
});

test("readStatus absorbs GHL's misspelled appoinmentStatus", () => {
  // Real quirk: 7,410 of 8,087 cached rows carry `appoinmentStatus` (no 't')
  // alongside the correct spelling.
  assert.equal(readStatus({ appoinmentStatus: 'Confirmed' }), 'confirmed');
  assert.equal(readStatus({ appointmentStatus: 'NEW' }), 'new');
  assert.equal(readStatus({ status: 'confirmed' }), 'confirmed');
  assert.equal(readStatus({}), '');
  assert.equal(readStatus(null), '');
});

test('an appointment carrying ONLY the misspelled status still occupies the slot', () => {
  const misspelled = { appointment_id: 'a', calendar_id: CAL, start_time: TARGET, appoinmentStatus: 'confirmed' };
  assert.equal(occupiesSlot(misspelled, { calendarId: CAL, targetMs, windowMs }), true);
});

test('matchWindowSeconds reads env and falls back to 60', () => {
  const prev = process.env.APPT_SLOT_MATCH_WINDOW_S;
  process.env.APPT_SLOT_MATCH_WINDOW_S = '120';
  assert.equal(matchWindowSeconds(), 120);
  process.env.APPT_SLOT_MATCH_WINDOW_S = 'garbage';
  assert.equal(matchWindowSeconds(), 60, 'unparseable falls back to the default');
  delete process.env.APPT_SLOT_MATCH_WINDOW_S;
  assert.equal(matchWindowSeconds(), 60, 'unset falls back to the default');
  process.env.APPT_SLOT_MATCH_WINDOW_S = prev;
});

test('the feature flag is strictly true-only (ships dark)', () => {
  const prev = process.env.APPT_SLOT_CHECK_ENABLED;
  for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE ']) {
    if (v === undefined) delete process.env.APPT_SLOT_CHECK_ENABLED;
    else process.env.APPT_SLOT_CHECK_ENABLED = v;
    const expected = String(v || '').trim().toLowerCase() === 'true';
    assert.equal(isSlotCheckEnabled(), expected, `APPT_SLOT_CHECK_ENABLED='${v}'`);
  }
  process.env.APPT_SLOT_CHECK_ENABLED = prev;
});

// ─── Event contract (added with the appt.booking retarget) ──────────
//
// These guard the three defects that made the PR #581 emitter unobservable.
// The most important is bypass_filter: event-intake-filter.js is a default-DROP
// allowlist, 'appt.booking' is deliberately NOT in ALLOWED_EVENT_TYPES (that
// list is for types with a consuming agent_rules row), so without the bypass
// every row lands in system_events_filtered and expires in 72h — the 24h
// observation window would produce NOTHING.

test('emitSlotCheckEvent emits appt.booking with bypass_filter and a unique key', async () => {
  const { emitSlotCheckEvent } = await import('../src/appointments/slot-check.js');
  const calls = [];

  await emitSlotCheckEvent('created', {
    contactId: 'c1', calendarId: CAL, startTime: TARGET, matched: null,
    extra: { caller: 'endpoint', duration_ms: 42 },
  }, { emit: async (opts) => { calls.push(opts); return null; } });

  assert.equal(calls.length, 1);
  const e = calls[0];
  assert.equal(e.event_type, 'appt.booking', 'retargeted from appt.slot_check');
  assert.equal(e.event_subtype, 'created');
  assert.equal(e.source, 'lp_mcp');
  assert.equal(e.entity_type, 'contact');
  assert.equal(e.entity_id, 'c1');
  assert.equal(e.ghl_contact_id, 'c1');
  assert.equal(e.bypass_filter, true, 'MUST bypass the default-DROP intake filter');
  assert.ok(e.idempotency_key.startsWith('book_c1_'), 'book_<contact>_<calendar>_<epochms> prefix');
  assert.ok(e.idempotency_key.includes('created'), 'subtype in the key so decisions do not collide');
  assert.equal(e.payload.caller, 'endpoint');
  assert.equal(e.payload.duration_ms, 42);
  assert.ok('matched_appointment_id' in e.payload);
});

test('every subtype carries bypass_filter — a missed one is silently dropped', async () => {
  const { emitSlotCheckEvent } = await import('../src/appointments/slot-check.js');
  for (const subtype of ['created', 'updated', 'noop_already_exists', 'error', 'budget_exceeded', 'query_failed']) {
    const calls = [];
    await emitSlotCheckEvent(subtype, {
      contactId: 'c1', calendarId: CAL, startTime: TARGET, matched: null,
    }, { emit: async (o) => { calls.push(o); return null; } });
    assert.equal(calls[0].bypass_filter, true, `${subtype} must bypass the filter`);
    assert.equal(calls[0].event_subtype, subtype);
  }
});

test('budget_exceeded is its own subtype, never folded into error', async () => {
  // It is the ONLY outcome that can leave an abandoned create in flight and so
  // produce a duplicate. It has to be countable on its own.
  const { emitSlotCheckEvent } = await import('../src/appointments/slot-check.js');
  const calls = [];
  const emit = async (o) => { calls.push(o); return null; };
  await emitSlotCheckEvent('budget_exceeded', { contactId: 'c1', calendarId: CAL, startTime: TARGET }, { emit });
  await emitSlotCheckEvent('error', { contactId: 'c1', calendarId: CAL, startTime: TARGET }, { emit });
  assert.equal(calls[0].event_subtype, 'budget_exceeded');
  assert.equal(calls[1].event_subtype, 'error');
  assert.notEqual(calls[0].idempotency_key, calls[1].idempotency_key, 'distinct keys so neither dedups the other away');
});

test('repeat decisions on the same slot do NOT collide on the idempotency key', async () => {
  // The PR #581 key was slot_<contact>_<calendar>_<slotMs> — no subtype, no
  // time — so only the FIRST decision per slot ever persisted.
  const { emitSlotCheckEvent } = await import('../src/appointments/slot-check.js');
  const keys = new Set();
  for (let i = 0; i < 3; i++) {
    await emitSlotCheckEvent('created', {
      contactId: 'c1', calendarId: CAL, startTime: TARGET,
    }, { emit: async (o) => { keys.add(o.idempotency_key); return null; } });
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(keys.size, 3, 'each decision gets its own row');
});

test('emitSlotCheckEvent never throws, even when the emitter rejects', async () => {
  // Observability must never be able to fail a booking. Callers `void` this, so
  // a rejected promise would surface as an unhandled rejection.
  const { emitSlotCheckEvent } = await import('../src/appointments/slot-check.js');
  await assert.doesNotReject(() => emitSlotCheckEvent('error', {
    contactId: 'c-nonexistent', calendarId: CAL, startTime: 'not-a-date', matched: null,
  }));
});
