/**
 * test-appointment-parity-live-check.js — v1.5 of the appointment parity watchdog.
 *
 * THE DEFECT (2026-09-28 20:37Z). Ops was paged that SANDRA WATSON / Rose Nelson
 * (contact Bq3lxQMhFduSVV1FX7PF, LP lead 579074) was "booked in LP, missing from
 * GHL." She was not. Two causes, one card:
 *
 *   1. The GHL book is the HL Supabase `appointments` CACHE. GHL held
 *      PlB224EDUJYZJ2xnJ7mr (created 20:30:23Z; reconciler already_in_sync at
 *      20:35:50Z) but the cache never got the row, and the sweep trusted it.
 *   2. The 90-minute grace aged the LEAD (created 9/27) instead of the
 *      APPOINTMENT (set 9/28 16:28 ET), so a lead that booked a day after it was
 *      created skipped the grace entirely.
 *
 * These tests pin both halves, and — just as important — that every way the
 * live read can fail still escalates. The live check may only remove a finding
 * GHL itself contradicts; it must never hide one it could not see.
 */

// Read at module load — must be set BEFORE the import below.
process.env.PARITY_GHL_MISSING_MIN_AGE_MIN = '90';     // the documented default
delete process.env.PARITY_GHL_LIVE_CHECK;              // default: ON
delete process.env.PARITY_GHL_LIVE_CHECK_MAX;          // default: 40

import test from 'node:test';
import assert from 'node:assert/strict';

const { runAppointmentParityWatchdog } =
  await import('../src/jobs/appointment-parity-watchdog.js');
const { utcToLpStoredIso } = await import('../src/lp-dates.js');

const DAY = 86400000;

/**
 * An lp_leads timestamp as the database holds it: ET WALL CLOCK wearing a
 * +00:00 offset. A plain toISOString() would read ~4h off and defeat the gate.
 */
const lpStamp = (minutesAgo) => utcToLpStoredIso(Date.now() - minutesAgo * 60000);

/** A GHL start time, true UTC with offset, `days` from now. */
const ghlStart = (days) => new Date(Date.now() + days * DAY).toISOString();

/** One LP row with no GHL counterpart in the cache: a Class B candidate. */
function lpRow(id, { createdMinAgo = 180, setMinAgo = 180, apptDays = 2 } = {}) {
  return {
    ghl_contact_id: id,
    lp_lead_id: 579074,
    first_name: 'SANDRA',
    last_name: 'WATSON',
    disposition_code: 'SET',
    appointment_confirmed: false,
    appointment_date: ghlStart(apptDays),
    set_date: setMinAgo === null ? null : lpStamp(setMinAgo),
    created_at_lp: lpStamp(createdMinAgo),
    updated_at_lp: lpStamp(createdMinAgo),
  };
}

/**
 * deps with every network/database edge stubbed. `live` is what the GHL live
 * lookup returns (or a function to compute it); every call is recorded.
 */
function deps({ lpBook, live = [], calls = [] }) {
  return {
    readGhlBook: async () => ({ active: new Map(), cancelled: new Map() }),   // the stale cache: empty
    readLpBook: async () => ({ active: lpBook, resolved: new Map() }),
    getGHLContact: async () => ({ tags: [] }),
    syncAppointmentToLP: async () => ({ success: true, action: 'lp_appointment_set' }),
    emitEvent: async () => ({ id: 1 }),
    fetchUpcomingAppointments: async (cid) => {
      calls.push(cid);
      return typeof live === 'function' ? live(cid) : live;
    },
    // Alerting itself is covered by test-appointment-parity-alerts.js.
    claimAlertConditionSet: async () => ({ ok: true, newlyFiring: [], cleared: [] }),
    confirmAlertSend: async () => ({ ok: true }),
    send: async () => ({ sent: true }),
  };
}

const gapFindings = (r) => r.findings.filter((f) => f.class === 'ghl_missing_appointment');

async function sweep(opts) {
  return runAppointmentParityWatchdog({ dryRun: true, deps: deps(opts) });
}

// ═══════════════════════════════════════════════════════════════════
// 1. set_date clock — the Sandra regression
// ═══════════════════════════════════════════════════════════════════

test('Sandra regression: lead created 36h ago, SET 10 min ago → held by the grace, no live read', async () => {
  const calls = [];
  const lpBook = new Map([['Bq3lxQMhFduSVV1FX7PF', lpRow('Bq3lxQMhFduSVV1FX7PF', { createdMinAgo: 36 * 60, setMinAgo: 10 })]]);
  const r = await sweep({ lpBook, calls });

  assert.equal(r.counts.ghl_missing_too_new, 1, 'the grace must age the appointment, not the lead');
  assert.equal(r.counts.ghl_missing_appointment, 0);
  assert.equal(gapFindings(r).length, 0);
  assert.equal(calls.length, 0, 'a held row never spends a live read');
});

test('no set_date: falls back to the v1.3 clock (created 3h ago) and reaches the live check', async () => {
  const calls = [];
  const lpBook = new Map([['c-noset', lpRow('c-noset', { createdMinAgo: 180, setMinAgo: null })]]);
  const r = await sweep({ lpBook, calls, live: [] });

  assert.equal(r.counts.ghl_missing_too_new, 0, 'a 3h-old row is past the grace');
  assert.equal(calls.length, 1, 'and it proceeds to the live read');
  assert.equal(r.counts.ghl_missing_appointment, 1);
});

// ═══════════════════════════════════════════════════════════════════
// 2. Live check — suppress only on a positive, active, in-window hit
// ═══════════════════════════════════════════════════════════════════

test('stale cache: GHL live holds an active in-window appointment → suppressed and counted', async () => {
  const calls = [];
  const lpBook = new Map([['c-stale', lpRow('c-stale')]]);
  const r = await sweep({
    lpBook, calls,
    live: [{ appointment_id: 'X', status: 'new', start_time: ghlStart(2) }],
  });

  assert.equal(calls.length, 1);
  assert.equal(r.counts.ghl_missing_cache_stale, 1, 'the suppression is COUNTED, never silent');
  assert.equal(r.counts.ghl_missing_appointment, 0);
  assert.equal(gapFindings(r).length, 0, 'no finding means no ops card');
});

test('real gap: GHL live returns nothing → escalates', async () => {
  const lpBook = new Map([['c-gap', lpRow('c-gap')]]);
  const r = await sweep({ lpBook, live: [] });

  assert.equal(r.counts.ghl_missing_appointment, 1);
  assert.equal(r.counts.ghl_missing_cache_stale, 0);
  assert.equal(gapFindings(r).length, 1);
});

test('lookup failed (null) → counted as failed and STILL escalates', async () => {
  const lpBook = new Map([['c-null', lpRow('c-null')]]);
  const r = await sweep({ lpBook, live: null });

  assert.equal(r.counts.ghl_live_check_failed, 1);
  assert.equal(r.counts.ghl_missing_appointment, 1, '"I could not ask GHL" must not silence a gap');
  assert.equal(gapFindings(r).length, 1);
});

test('lookup throws → counted as failed and STILL escalates', async () => {
  const lpBook = new Map([['c-throw', lpRow('c-throw')]]);
  const r = await sweep({ lpBook, live: () => { throw new Error('GHL 503'); } });

  assert.equal(r.counts.ghl_live_check_failed, 1);
  assert.equal(r.counts.ghl_missing_appointment, 1);
  assert.equal(gapFindings(r).length, 1);
});

test('dead status: only a "canceled" (one L) appointment live → escalates', async () => {
  const lpBook = new Map([['c-dead', lpRow('c-dead')]]);
  const r = await sweep({
    lpBook,
    live: [{ appointment_id: 'D', status: 'canceled', start_time: ghlStart(2) }],
  });

  assert.equal(r.counts.ghl_missing_cache_stale, 0, 'a cancelled appointment is not a booking');
  assert.equal(r.counts.ghl_missing_appointment, 1);
});

test('out of window: an active appointment 60 days out → escalates', async () => {
  const lpBook = new Map([['c-far', lpRow('c-far')]]);
  const r = await sweep({
    lpBook,
    live: [{ appointment_id: 'F', status: 'confirmed', start_time: ghlStart(60) }],
  });

  assert.equal(r.counts.ghl_missing_cache_stale, 0, 'outside the window it does not answer LP\'s appointment');
  assert.equal(r.counts.ghl_missing_appointment, 1);
});

// ═══════════════════════════════════════════════════════════════════
// 3. Budget — the cap is a guard, and exhausting it escalates
// ═══════════════════════════════════════════════════════════════════

test('budget: 41 real gaps → 40 live reads, all 41 escalate', async () => {
  const calls = [];
  const lpBook = new Map();
  for (let i = 0; i < 41; i++) lpBook.set(`c-${i}`, lpRow(`c-${i}`));
  const r = await sweep({ lpBook, calls, live: [] });

  assert.equal(calls.length, 40, 'PARITY_GHL_LIVE_CHECK_MAX defaults to 40');
  assert.equal(r.counts.ghl_missing_appointment, 41, 'the 41st is unchecked and escalates as before');
  assert.equal(gapFindings(r).length, 41);
});
