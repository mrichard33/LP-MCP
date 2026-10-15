/**
 * Tests — scripts/test-time-change-lp-note.js
 *
 * R8 (Mark, 2026-10-15): a 6:30 / 7:00 request booked at 6:00 PM becomes ONE
 * IMPORTANT note on the LP prospect once the appointment is in LP
 * (src/services/time-change-lp-note.js), from the LP sync's success path or
 * the 15-minute sweep. Handoff cases 9–12, plus the hook on
 * syncAppointmentToLP and the late-filing alert (src/jobs/capacity-gate-jobs.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const note = await import('../src/services/time-change-lp-note.js');
const jobs = await import('../src/jobs/capacity-gate-jobs.js');
const { fakeSupabase } = await import('./lib/fake-supabase.js');

const BOOKED = '2026-10-15T22:00:00.000Z';   // 6:00 PM ET Thu Oct 15
const CREATED = '2026-10-15T13:00:00.000Z';
const ROW = {
  id: 'r1', ghl_contact_id: 'c1', ghl_appointment_id: 'a1', market_code: 'SAR_MKT', booked_start: BOOKED,
  requested_time: '6:30 PM', requested_label: '6:30 PM on Thu Oct 15', status: 'pending',
  lp_note_written_at: null, alerted_at: null, created_at: CREATED,
};
const TEXT = 'Customer requested 6:30 PM on Thu Oct 15. Bot booked 6:00 PM. Please confirm with the customer and move the appointment to 6:30 PM.';

function harness({ row = ROW, appointment = { cancelled: false, start: BOOKED }, prospect = null, writeFails = 0 } = {}) {
  const db = fakeSupabase({ appt_time_change_requests: [{ ...row }] });
  const written = []; const cards = [];
  let fails = writeFails;
  const d = {
    supabase: db,
    writeLpNote: async (prospectId, text, important) => {
      if (fails > 0) { fails--; throw new Error('LP AddNotes 500'); }
      written.push({ prospectId, text, important });
      return { noteId: '9001', confirmed: true };
    },
    sameStartTime: (a, b) => Date.parse(a) === Date.parse(b),
    readAppointment: async () => appointment,
    readLpProspect: async () => prospect,
    contactName: async () => 'Dana Smith',
    postCard: async (a) => { cards.push(a); return true; },
  };
  return { db, d, written, cards, row: () => db.tables.appt_time_change_requests[0] };
}

test('the note text is the handoff\'s, word for word', () => {
  assert.equal(note.buildTimeChangeNote(ROW), TEXT);
});

test('9. the appointment reaches LP: exactly one IMPORTANT note, status written; hook and sweep again write nothing', async () => {
  const h = harness({ prospect: '555123' });
  const hook = await note.onLpAppointmentSynced({ contactId: 'c1', prospectId: '555123', apptDate: '10/15/2026', apptTime: '6:00 PM' }, h.d);
  assert.equal(hook.written, 1);
  assert.deepEqual(h.written, [{ prospectId: '555123', text: TEXT, important: true }]);
  assert.equal(h.row().status, 'written');
  assert.equal(h.row().lp_note_id, '9001');
  assert.equal(h.row().lp_prospect_id, '555123');
  assert.ok(h.row().lp_note_written_at);
  await note.onLpAppointmentSynced({ contactId: 'c1', prospectId: '555123', apptDate: '2026-10-15' }, h.d);
  await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 3 * 3600_000 }, h.d);
  assert.equal(h.written.length, 1, 'never a second note');
  // An LP appointment for another day is not this request's.
  const other = harness();
  assert.equal((await note.onLpAppointmentSynced({ contactId: 'c1', prospectId: '1', apptDate: '2026-10-20' }, other.d)).written, 0);
});

test('9b. the sweep writes the note when the appointment is in LP', async () => {
  const h = harness({ prospect: '777' });
  const out = await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 20 * 60_000 }, h.d);
  assert.equal(out.written, 1);
  assert.equal(h.row().status, 'written');
});

test('10. not in LP yet: pending, then ONE #contact-center alert after LP_NOTE_ALERT_AFTER_MINUTES, never repeated', async () => {
  const h = harness({ prospect: null });
  const env = { LP_NOTE_ALERT_AFTER_MINUTES: '120' };
  let out = await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 60 * 60_000, env }, h.d);
  assert.equal(out.waiting, 1); assert.equal(h.cards.length, 0); assert.equal(h.row().status, 'pending');
  out = await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 121 * 60_000, env }, h.d);
  assert.equal(out.alerted, 1);
  assert.equal(h.cards.length, 1);
  assert.deepEqual(h.cards[0], { contactId: 'c1', name: 'Dana Smith', requestedLabel: '6:30 PM on Thu Oct 15' });
  assert.ok(h.row().alerted_at);
  await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 180 * 60_000, env }, h.d);
  assert.equal(h.cards.length, 1, 'the alert never repeats');
  assert.equal(h.row().status, 'pending');
  // 24h on: failed, no extra alert.
  await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 25 * 3600_000, env }, h.d);
  assert.equal(h.row().status, 'failed');
  assert.equal(h.cards.length, 1);
});

test('11. cancelled, or moved off 6:00 PM, before LP: superseded, no note', async () => {
  const cancelled = harness({ appointment: { cancelled: true, start: BOOKED }, prospect: '555' });
  await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 30 * 60_000 }, cancelled.d);
  assert.equal(cancelled.row().status, 'superseded');
  assert.equal(cancelled.written.length, 0);
  const moved = harness({ appointment: { cancelled: false, start: '2026-10-15T22:30:00.000Z' }, prospect: '555' });
  await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 30 * 60_000 }, moved.d);
  assert.equal(moved.row().status, 'superseded');
  assert.equal(moved.written.length, 0);
  // The LP sync landing the same day at 6:30 (the team moved it) supersedes too.
  const lpMoved = harness();
  await note.onLpAppointmentSynced({ contactId: 'c1', prospectId: '555', apptDate: '2026-10-15', apptTime: '6:30 PM' }, lpMoved.d);
  assert.equal(lpMoved.row().status, 'superseded');
  assert.equal(lpMoved.written.length, 0);
  // A superseded row is never written by the sync hook either.
  await note.onLpAppointmentSynced({ contactId: 'c1', prospectId: '555', apptDate: '2026-10-15' }, moved.d);
  assert.equal(moved.written.length, 0);
});

test('12. LP AddNotes throws: last_error recorded, retried on the next sweep, one note on success', async () => {
  const h = harness({ prospect: '555', writeFails: 1 });
  let out = await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 20 * 60_000 }, h.d);
  assert.equal(out.errors, 1);
  assert.equal(h.row().status, 'pending');
  assert.match(h.row().last_error, /LP AddNotes 500/);
  assert.equal(h.row().lp_note_written_at, null, 'the claim is released for the retry');
  out = await note.sweepTimeChangeNotes({ nowMs: Date.parse(CREATED) + 35 * 60_000 }, h.d);
  assert.equal(out.written, 1);
  assert.equal(h.written.length, 1);
  assert.equal(h.row().status, 'written');
});

test('a claimed row is never written twice (hook and sweep at once)', async () => {
  const h = harness({ prospect: '555' });
  const [a, b] = await Promise.all([
    note.writeTimeChangeNote({ ...ROW }, '555', h.d),
    note.writeTimeChangeNote({ ...ROW }, '555', h.d),
  ]);
  assert.deepEqual([a, b].sort(), ['skipped', 'written']);
  assert.equal(h.written.length, 1);
});

test('decideRow and the helpers', () => {
  assert.equal(note.prospectFromDedupKey('c1:555123:582001:2026-10-15:6:00 PM'), '555123');
  assert.equal(note.prospectFromDedupKey('c1:noprospect:582001:2026-10-15'), null);
  assert.equal(note.normDate('10/5/2026'), '2026-10-05');
  assert.equal(note.decideRow({ row: ROW, appointment: null, prospectId: null, sameStart: true, nowMs: Date.parse(CREATED) + 60_000 }), 'wait',
    'an unreadable GHL appointment never supersedes');
});

test('the sync hook runs after a successful LP sync and never changes its result', async () => {
  const { syncAppointmentToLP } = await import('../src/lp-appointment-sync.js');
  const calls = [];
  const res = await syncAppointmentToLP({ contactId: 'c1', calendarId: 'gFWoSQrlKIdfRbAPV842', appointmentDate: '2026-10-15', appointmentTime: '6:00 PM' },
    { onLpAppointmentSynced: async (a) => { calls.push(a); } });
  assert.equal(res.action, 'skipped_ghl_only_calendar', 'the sync result is untouched');
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 0, 'no hook without an LP appointment');
});

// ── Late-filing alert (R2) ───────────────────────────────────────────────────

test('unfiled days in the next N days, per market', () => {
  const horizons = new Map([['SAR_MKT', '2026-10-25'], ['FTLAU_MKT', '2026-10-16']]);
  const late = jobs.unfiledByMarket(horizons, { today: '2026-10-15', days: 3, markets: ['SAR_MKT', 'FTLAU_MKT', 'JAX_MKT'] });
  assert.deepEqual(late, [
    { market: 'FTLAU_MKT', dates: ['2026-10-17', '2026-10-18'] },
    { market: 'JAX_MKT', dates: ['2026-10-16', '2026-10-17', '2026-10-18'] },
  ]);
  assert.equal(jobs.buildUnfiledText(['2026-10-17', '2026-10-18']), "Availability not filed for Sat, Oct 17, Sun, Oct 18. The bot can't book these days until reps file.");
});

test('the late-filing alert posts once per market per day, to the market channel, Slack only', async () => {
  const posted = new Set(); const posts = [];
  const d = {
    readHorizons: async () => new Map([['SAR_MKT', '2026-10-25'], ['FTLAU_MKT', '2026-10-16'], ['FTMYR_MKT', '2026-10-25'], ['JAX_MKT', '2026-10-25'], ['ORL_MKT', '2026-10-25'], ['STPET_MKT', '2026-10-25']]),
    resolveChannels: async (fam, { market }) => [`C-${fam}-${market}`],
    postToSlack: async (text, channel) => { posts.push({ text, channel }); return { ok: true }; },
    filterNew: async ({ items }) => ({ fresh: items.filter(i => !posted.has(`${i.key}|${i.reason}`)) }),
    recordPosted: async ({ items }) => { for (const i of items) posted.add(`${i.key}|${i.reason}`); },
  };
  const nowMs = Date.parse('2026-10-15T14:00:00Z');
  const env = { CAPACITY_GATE_ENABLED: 'true', UNFILED_ALERT_DAYS_AHEAD: '3' };
  const first = await jobs.runUnfiledAlert({ nowMs, env }, d);
  assert.equal(first.posted, 1);
  assert.deepEqual(posts[0].channel, 'C-sales-FTLAU', 'the short code reaches slack_market_slugs');
  await jobs.runUnfiledAlert({ nowMs: nowMs + 3600_000, env }, d);
  assert.equal(posts.length, 1, 'first detection only, never repeated that day');
  const off = await jobs.runUnfiledAlert({ nowMs, env: { CAPACITY_GATE_ENABLED: 'false' } }, d);
  assert.equal(off.skipped, true);
  const unreadable = await jobs.runUnfiledAlert({ nowMs, env }, { ...d, readHorizons: async () => { throw new Error('down'); } });
  assert.equal(unreadable.checked, false, 'could not tell posts nothing');
});
