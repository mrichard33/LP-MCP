/**
 * WE calendar de-dupe pass — scripts/test-ghl-appointment-dedupe.js
 *
 * Covers src/admin/ghl-appointment-dedupe.js:
 *   - findDuplicateGroups: only same-(contact,start) sets of size >1
 *   - chooseKeep: confirmed/showed > new, then earliest-created, then id
 *   - runGhlAppointmentDedupe: cancels exactly the extras (one kept per group),
 *     leaves non-dups + different-time appts alone, dry-run mutates nothing.
 *
 * GHL I/O bottoms out at global.fetch (ghlFetch + listEstimatePoolEvents), so
 * one stub covers the read (GET /calendars/events) and the cancel (PUT).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';

const WE = 'aJj14ONxh1oFyDcQ706O';
const MV = 'zEdPmkNccR2ovo3rQAd3';
const HPA = 'zS1wg0JqQ1zsszJyJqKX';

let calls = [];
let eventsByCalendar = {}; // calendarId -> [events]

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
  const u = String(url);
  const path = u.replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
  if (method === 'GET' && path.startsWith('/calendars/events?')) {
    const cal = new URL(u).searchParams.get('calendarId');
    return jsonRes({ events: eventsByCalendar[cal] || [] });
  }
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) {
    return jsonRes({ id: path.split('/').pop() });
  }
  return jsonRes({});
};

const {
  chooseKeep, findDuplicateGroups, runGhlAppointmentDedupe,
} = await import('../src/admin/ghl-appointment-dedupe.js');

const SLOT = '2026-07-11T10:00:00-04:00';
const SLOT2 = '2026-07-11T14:00:00-04:00';
// Mapped shape (what findDuplicateGroups/chooseKeep consume directly).
const ev = (o) => ({ appointment_id: o.id, calendar_id: WE, contact_id: o.c, start_time: o.t || SLOT, status: o.s || 'new', date_added: o.added || '2026-07-01T00:00:00Z' });
// Raw GHL /calendars/events shape (what the fetch stub returns; mapEvent maps it).
const raw = (o) => ({ id: o.id, calendarId: WE, contactId: o.c, startTime: o.t || SLOT, appointmentStatus: o.s || 'new', dateAdded: o.added || '2026-07-01T00:00:00Z' });

const cancels = () => calls.filter((c) => c.method === 'PUT' && /\/calendars\/events\/appointments\//.test(c.path));

// ═══ chooseKeep ═══════════════════════════════════════════════════════
test('chooseKeep: confirmed beats new', () => {
  const { keep, cancel } = chooseKeep([ev({ id: 'a', c: 'c1', s: 'new' }), ev({ id: 'b', c: 'c1', s: 'confirmed' })]);
  assert.equal(keep.appointment_id, 'b');
  assert.deepEqual(cancel.map((x) => x.appointment_id), ['a']);
});

test('chooseKeep: equal status → earliest-created wins', () => {
  const { keep } = chooseKeep([
    ev({ id: 'late', c: 'c1', s: 'new', added: '2026-07-05T00:00:00Z' }),
    ev({ id: 'early', c: 'c1', s: 'new', added: '2026-07-01T00:00:00Z' }),
  ]);
  assert.equal(keep.appointment_id, 'early');
});

// ═══ findDuplicateGroups ══════════════════════════════════════════════
test('findDuplicateGroups: only same-contact same-start sets of size >1', () => {
  const events = [
    ev({ id: 'a', c: 'c1' }), ev({ id: 'b', c: 'c1' }),   // dup pair (c1 @ SLOT)
    ev({ id: 'c', c: 'c1', t: SLOT2 }),                    // c1 different time — not a dup
    ev({ id: 'd', c: 'c2' }),                              // c2 alone — not a dup
  ];
  const groups = findDuplicateGroups(events);
  assert.equal(groups.size, 1);
  const [only] = [...groups.values()];
  assert.deepEqual(only.map((x) => x.appointment_id).sort(), ['a', 'b']);
});

// ═══ run loop (stub returns RAW GHL events) ═══════════════════════════
function seed(rawEvents) {
  calls = [];
  eventsByCalendar = { [WE]: rawEvents, [MV]: [], [HPA]: [] };
}

test('run: cancels the extra, keeps one, leaves singletons/other-times alone', async () => {
  seed([
    raw({ id: 'keep', c: 'c1', s: 'confirmed' }),
    raw({ id: 'dupe', c: 'c1', s: 'new' }),
    raw({ id: 'other', c: 'c1', t: SLOT2 }),  // same contact, different slot — untouched
    raw({ id: 'solo', c: 'c2' }),             // singleton — untouched
  ]);
  const s = await runGhlAppointmentDedupe({ dryRun: false });
  assert.equal(s.duplicate_groups, 1);
  assert.equal(s.cancelled, 1);
  assert.equal(cancels().length, 1);
  assert.match(cancels()[0].path, /\/dupe$/);          // only 'dupe' cancelled
  assert.equal(cancels()[0].body.appointmentStatus, 'cancelled');
});

test('run: dry-run cancels nothing but reports the group', async () => {
  seed([raw({ id: 'keep', c: 'c1', s: 'confirmed' }), raw({ id: 'dupe', c: 'c1', s: 'new' })]);
  const s = await runGhlAppointmentDedupe({ dryRun: true });
  assert.equal(s.duplicate_groups, 1);
  assert.equal(s.would_cancel, 1);   // plan reported
  assert.equal(s.cancelled, 0);      // nothing actually cancelled
  assert.equal(cancels().length, 0);
});

test('run: no duplicates → zero cancels', async () => {
  seed([raw({ id: 'a', c: 'c1' }), raw({ id: 'b', c: 'c2' }), raw({ id: 'c', c: 'c3', t: SLOT2 })]);
  const s = await runGhlAppointmentDedupe({ dryRun: false });
  assert.equal(s.duplicate_groups, 0);
  assert.equal(cancels().length, 0);
});
