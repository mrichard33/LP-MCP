/**
 * Appointment timezone regression — scripts/test-contact-appointments-tz.js
 *
 * The GHL endpoint GET /contacts/{id}/appointments returns startTime/endTime as
 * NAIVE ET wall clock ("2026-07-31 18:30:00", no offset). Date.parse reads a
 * naive string as local time, so on the UTC container an appointment at 6:30 PM
 * ET was scored as 6:30 PM UTC — four hours early. fetchUpcomingAppointments
 * dropped every such appointment for the four hours preceding it, and because
 * that function is the shared pre-create guard for all three appointment
 * writers (the delegation endpoint, executeBookAppointment, and
 * reconcileLpAppointmentToGhl), each one read "no appointment exists" during
 * that window and created a duplicate. Confirmed on four contacts 2026-07-30/31.
 *
 * The fix is toEpochMsEt(): pass offset-carrying values (…Z / …±hh:mm) straight
 * to Date.parse, and route everything else through lpWallClockToGhlStartTime,
 * which reuses the wall-clock digits verbatim and stamps the DST-correct ET
 * offset onto them. The suffix guard is load-bearing in BOTH directions — see
 * the Z-passthrough test, which pins the exact wrong answer it prevents.
 *
 * Two deliberate choices make this suite deterministic for years:
 *   - process.env.TZ = 'UTC' pins the naive-parse fallback. Unpinned, the
 *     integration case would pass PRE-fix on a machine west of ET.
 *   - node:test mock timers freeze Date.now(). Verified on node 22: mocking
 *     'Date' does NOT disturb Intl.DateTimeFormat / etOffsetMinutes, which
 *     lpWallClockToGhlStartTime depends on.
 *
 * Still naive after this change, flagged not asserted: the trailing out.sort()
 * comparator Date.parse()es raw start times. All naive rows shift equally so
 * ordering holds today; it only misorders across a DST boundary. Separate change.
 *
 * Network is stubbed at global fetch; no DB.
 * Run: node --test scripts/test-contact-appointments-tz.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// NOTE: static ESM imports hoist ABOVE these assignments, which is precisely why
// the modules under test are pulled in with await import() further down.
// contact-appointments.js reads GHL_API_KEY and REECE_TIMEZONE at MODULE LOAD,
// and fetchUpcomingAppointments early-returns null on a falsy key.
process.env.TZ = 'UTC';                              // pins the naive-parse fallback
process.env.GHL_API_KEY = 'test-key';
process.env.REECE_TIMEZONE = 'America/New_York';

// ─── fetch stub (installed before import so module-load reads are safe) ──
let calls = [];
let upcomingEvents = [];   // served on GET /contacts/{id}/appointments

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path });

  if (method === 'GET' && /^\/contacts\/[^/]+\/appointments/.test(path)) {
    return jsonRes({ events: upcomingEvents });
  }
  return jsonRes({});
};

const { lpWallClockToGhlStartTime } = await import('../src/appointment-dates.js');
const { toEpochMsEt, fetchUpcomingAppointments, formatAppointmentsForPrompt } =
  await import('../src/knowledge/contact-appointments.js');

// 2026-07-31 19:11 UTC = 3:11 PM ET. An appointment ending 6:30 PM ET is still
// three hours away; pre-fix it read as 6:30 PM UTC and was already "past".
const NOW_MS = Date.parse('2026-07-31T19:11:00Z');
const WINDOW_ESTIMATE_CAL = 'aJj14ONxh1oFyDcQ706O';

function reset(events = []) {
  calls = [];
  upcomingEvents = events;
}
const evt = (over = {}) => ({
  id: 'appt-1', calendarId: WINDOW_ESTIMATE_CAL, appointmentStatus: 'confirmed',
  title: 'Window Estimate', startTime: '2026-07-31 16:30:00',
  endTime: '2026-07-31 18:30:00', ...over,
});

// ═══ 1. Naive ET wall clock — the regression ══════════════════════════

test('naive ET "2026-07-31 18:30:00" resolves to 18:30 ET, not 18:30 UTC', () => {
  assert.equal(toEpochMsEt('2026-07-31 18:30:00'), Date.parse('2026-07-31T18:30:00-04:00'));
  assert.equal(toEpochMsEt('2026-07-31 18:30:00'), 1785537000000); // absolute pin: 2026-07-31T22:30:00Z

  // The pre-fix answer, stated explicitly so the delta can never drift silently.
  assert.notEqual(toEpochMsEt('2026-07-31 18:30:00'), Date.parse('2026-07-31T18:30:00Z'));
  assert.equal(
    toEpochMsEt('2026-07-31 18:30:00') - Date.parse('2026-07-31T18:30:00Z'),
    4 * 60 * 60_000,
    'naive ET must land four hours later than the same digits read as UTC (EDT)',
  );

  // The endpoint has been observed emitting both separators.
  assert.equal(toEpochMsEt('2026-07-31T18:30:00'), Date.parse('2026-07-31T18:30:00-04:00'));
});

// ═══ 2. DST correctness — never a hardcoded -04:00 ════════════════════

test('naive winter "2026-01-15 18:30:00" resolves EST (-05:00), not EDT', () => {
  assert.equal(toEpochMsEt('2026-01-15 18:30:00'), Date.parse('2026-01-15T18:30:00-05:00'));
  assert.notEqual(toEpochMsEt('2026-01-15 18:30:00'), Date.parse('2026-01-15T18:30:00-04:00'));
  assert.equal(
    toEpochMsEt('2026-01-15 18:30:00') - Date.parse('2026-01-15T18:30:00Z'),
    5 * 60 * 60_000,
  );
});

test('DST transition days pick the offset in force on that day', () => {
  // Spring forward 2026-03-08 02:00 ET — 10 AM that day is already EDT.
  assert.equal(toEpochMsEt('2026-03-08 10:00:00'), Date.parse('2026-03-08T10:00:00-04:00'));
  assert.equal(toEpochMsEt('2026-03-07 10:00:00'), Date.parse('2026-03-07T10:00:00-05:00'));
  // Fall back 2026-11-01 — 10 AM that day is EST again.
  assert.equal(toEpochMsEt('2026-11-01 10:00:00'), Date.parse('2026-11-01T10:00:00-05:00'));
  assert.equal(toEpochMsEt('2026-10-31 10:00:00'), Date.parse('2026-10-31T10:00:00-04:00'));
});

// ═══ 3. Offset-carrying values pass through untouched ═════════════════

test('an explicit ±hh:mm offset is trusted verbatim', () => {
  assert.equal(toEpochMsEt('2026-07-31T18:30:00-04:00'), Date.parse('2026-07-31T18:30:00-04:00'));
  assert.equal(toEpochMsEt('2026-01-15T18:30:00-05:00'), Date.parse('2026-01-15T18:30:00-05:00'));
  // Compact ±hhmm form is matched by the guard too (the ':' is optional in it).
  assert.equal(toEpochMsEt('2026-07-31T18:30:00-0400'), Date.parse('2026-07-31T18:30:00-04:00'));

  // Scope boundary: an explicit +00:00 means UTC HERE. This is NOT the LP
  // wall-clock-mislabeled-as-UTC convention (lp_leads.appointment_date), which
  // is a different input domain handled by the reconciler, not by this helper.
  assert.equal(toEpochMsEt('2026-07-08T10:00:00+00:00'), Date.parse('2026-07-08T10:00:00Z'));
});

// ═══ 4. Z passthrough — the guard, and the exact bug it prevents ══════

test('a Z-suffixed value stays UTC; the suffix guard is what makes that true', () => {
  assert.equal(toEpochMsEt('2026-07-31T22:30:00Z'), Date.parse('2026-07-31T22:30:00Z'));

  // 22:30Z IS 18:30 ET — the two spellings must agree on the instant.
  assert.equal(toEpochMsEt('2026-07-31T22:30:00Z'), toEpochMsEt('2026-07-31 18:30:00'));

  // GUARD PROOF. lpWallClockToGhlStartTime ignores any offset already present
  // and re-stamps ET, so delegating a Z value to it yields 22:30-04:00 — a
  // 2026-08-01T02:30Z instant, four hours late. Pin both halves: the wrong
  // answer the helper would produce, and the fact that toEpochMsEt avoids it.
  assert.equal(lpWallClockToGhlStartTime('2026-07-31T22:30:00Z'), '2026-07-31T22:30:00-04:00');
  assert.notEqual(toEpochMsEt('2026-07-31T22:30:00Z'), Date.parse('2026-07-31T22:30:00-04:00'));
});

// ═══ 5. Unusable input → NaN (caller drops on Number.isNaN) ═══════════

test('null / undefined / empty / garbage → NaN', () => {
  for (const v of [null, undefined, '', 0, false, NaN, 'garbage', 'not-a-date', 'T18:30:00', {}, []]) {
    assert.ok(Number.isNaN(toEpochMsEt(v)), `${JSON.stringify(v)} must be NaN`);
  }
});

test('date-only and midnight fall back to Date.parse (documented, not endorsed)', () => {
  // No time-of-day → lpWallClockToGhlStartTime returns null and the raw string
  // is parsed. ISO date-only is UTC by spec, so this one is host-independent.
  assert.equal(toEpochMsEt('2026-07-31'), Date.parse('2026-07-31T00:00:00Z'));

  // Midnight is treated upstream as "date known, time unknown" and also falls
  // through. Date.parse of a naive string is LOCAL — deterministic here ONLY
  // because this file pins process.env.TZ = 'UTC'. Do not copy this assertion
  // into a suite that does not pin TZ.
  assert.equal(process.env.TZ, 'UTC');
  assert.equal(toEpochMsEt('2026-07-31 00:00:00'), Date.parse('2026-07-31T00:00:00Z'));
});

// ═══ 6. Integration: the appointment that used to vanish ══════════════

test('INTEGRATION: an appointment ending 6:30 PM ET survives a 3:11 PM ET now', async (t) => {
  assert.ok(t.mock?.timers, 'node:test mock timers required to pin Date.now()');
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });
  // If this ever fails, mock timers stopped working — everything below would
  // otherwise start failing on its own as real time passes 2026-07-31.
  assert.equal(Date.now(), NOW_MS, 'Date.now() must be frozen; this test has no meaning otherwise');

  reset([evt()]); // 4:30–6:30 PM ET, three hours in the future
  const res = await fetchUpcomingAppointments('c1');

  assert.ok(Array.isArray(res), 'must not fail closed to null');
  assert.equal(res.length, 1, 'appointment ending 6:30 PM ET must NOT be filtered as past');
  assert.equal(res[0].appointment_id, 'appt-1');
  assert.equal(res[0].calendar_name, 'Window Estimate');
  assert.equal(res[0].status, 'confirmed');
  assert.equal(res[0].start_time, '2026-07-31 16:30:00'); // raw endpoint value passes through
  assert.equal(calls.length, 1);

  // Pre-fix arithmetic, restated: endTime read as UTC is 18:30Z, before the
  // 19:11Z now, so the loop `continue`d and the caller got [].
  assert.ok(Date.parse('2026-07-31 18:30:00') < NOW_MS);
  assert.ok(toEpochMsEt('2026-07-31 18:30:00') > NOW_MS);
});

test('INTEGRATION: the past filter still works — a genuinely finished appointment is dropped', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });

  // 12:00–2:00 PM ET = ended 18:00Z, an hour and change before now.
  reset([evt({ startTime: '2026-07-31 12:00:00', endTime: '2026-07-31 14:00:00' })]);
  assert.deepEqual(await fetchUpcomingAppointments('c1'), [],
    'the fix must correct the filter, not disable it');
});

test('INTEGRATION: missing endTime uses start + 90m on the ET-correct start', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });

  // 6:00 PM ET start, no end → assumed 7:30 PM ET (23:30Z) → kept.
  reset([evt({ startTime: '2026-07-31 18:00:00', endTime: null })]);
  let res = await fetchUpcomingAppointments('c1');
  assert.equal(res.length, 1);
  assert.equal(res[0].end_time, null);

  // 1:00 PM ET start, no end → assumed 2:30 PM ET (18:30Z) → dropped.
  reset([evt({ startTime: '2026-07-31 13:00:00', endTime: null })]);
  res = await fetchUpcomingAppointments('c1');
  assert.deepEqual(res, []);
});

test('INTEGRATION: cancelled/noshow still filtered regardless of timezone handling', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });

  for (const status of ['cancelled', 'noshow', 'no-show']) {
    reset([evt({ appointmentStatus: status })]);
    assert.deepEqual(await fetchUpcomingAppointments('c1'), [], `status=${status} must be dropped`);
  }
});

test('INTEGRATION: an offset-carrying endpoint value is not double-shifted', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });

  // Same instants as the naive case, spelled with explicit offsets.
  reset([evt({ startTime: '2026-07-31T16:30:00-04:00', endTime: '2026-07-31T18:30:00-04:00' })]);
  assert.equal((await fetchUpcomingAppointments('c1')).length, 1);

  // And a Z-spelled one that is genuinely past must still be dropped — the
  // guard failure mode would have shifted it four hours forward and kept it.
  reset([evt({ startTime: '2026-07-31T16:00:00Z', endTime: '2026-07-31T18:00:00Z' })]);
  assert.deepEqual(await fetchUpcomingAppointments('c1'), [],
    'a Z value at 18:00Z is past 19:11Z now; re-stamping it as -04:00 would wrongly keep it');
});

// ═══ 7. Display: the time the bot actually quotes to the homeowner ════

test('start_time_human renders the ET wall clock, not the UTC misreading', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });

  reset([evt()]); // naive start 2026-07-31 16:30:00 = 4:30 PM ET
  const res = await fetchUpcomingAppointments('c1');

  assert.equal(res[0].start_time_human, 'Fri, Jul 31, 4:30 PM ET');
  // Pre-fix this read 12:30 PM ET — the bot told the homeowner the wrong time.
  assert.notEqual(res[0].start_time_human, 'Fri, Jul 31, 12:30 PM ET');

  // The prompt block the responder actually injects carries the corrected time.
  assert.match(formatAppointmentsForPrompt(res), /start="Fri, Jul 31, 4:30 PM ET"/);
});

test('start_time_human handles offset-carrying and unusable values', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });

  // 20:30Z IS 4:30 PM ET — same rendering as the naive spelling above.
  reset([evt({ startTime: '2026-07-31T20:30:00Z', endTime: '2026-07-31T22:30:00Z' })]);
  assert.equal((await fetchUpcomingAppointments('c1'))[0].start_time_human, 'Fri, Jul 31, 4:30 PM ET');

  // Unparseable start falls back to the raw string, as before the change.
  reset([evt({ startTime: 'garbage', endTime: '2026-07-31 18:30:00' })]);
  assert.equal((await fetchUpcomingAppointments('c1'))[0].start_time_human, 'garbage');
});
