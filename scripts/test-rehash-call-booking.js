/**
 * Rehash Call booking (Mark, 2026-10-23; Kim Turko review). Kim's Rehash Call
 * (6fuXQWigbVHlFzzReCzQ) came out "Kim Turko - Rehash Call - Kim Turko", status
 * new, no note, and was followed by the post-booking email ask. Now:
 *   B. the title is "Reece Best-Offer Call: {First Last}" (and the formatter leaves it alone)
 *   D. a Rehash Call is created confirmed; every other calendar is still born new
 *   -  no post-booking email ask after a Rehash Call
 *   E. the internal note: "Booked by Reece Chatbot" first, under 700 characters, on the
 *      appointment (contact note only when GHL refuses), never the description
 *
 * Run: node --test scripts/test-rehash-call-booking.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
process.env.GHL_API_KEY = 'test-key';
process.env.GROUPME_BOT_ID = '';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
const CAL = 'ncDzLgzbfKJRfhmtlWtB';
process.env.REHASH_CALENDAR_ID = CAL;
process.env.REHASH_CALL_NOTES_MODE = 'off';   // the note has its own tests below
process.env.APPT_FORMAT_ENABLED = 'true';     // the formatter that doubled Kim's name

let calls = [];
let contactRecord = null;
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
  const raw = String(url);
  const path = raw.replace('https://services.leadconnectorhq.com', '');
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
  calls.push({ method, path, raw, body, headers: opts.headers || {} });
  if (method === 'GET' && /^\/contacts\/[^/?]+\/appointments/.test(path)) return jsonRes({ events: [] });
  if (method === 'GET' && /^\/calendars\/events\/appointments\/[^/?]+$/.test(path)) {
    const created = calls.find((c) => c.method === 'POST' && c.path === '/calendars/events/appointments');
    return jsonRes({ appointment: { id: path.split('/').pop(), appointmentStatus: created?.body?.appointmentStatus || 'new' } });
  }
  if (method === 'POST' && path === '/calendars/events/appointments') return jsonRes({ id: 'appt-1' });
  if (method === 'GET' && /^\/contacts\/[^/?]+$/.test(path)) return jsonRes({ contact: contactRecord });
  return jsonRes(raw.includes('/rest/v1/') ? [] : {});
};

const { executeBookAppointment } = await import('../src/actions/handlers/appointments.js');
const { rehashCallTitle, creationStatus, rehashCallTitleOn, rehashCallAutoConfirm, rehashCallNotesMode } = await import('../src/appointments/rehash-call-format.js');
const { applyAppointmentFormat } = await import('../src/appointments/format.js');
const { rehashCallBooking } = await import('../src/agentic/rehash-slots.js');
const { buildRehashCallNote, REHASH_CALL_NOTE_MAX, readNoteFields, BOOKED_BY_LINE } = await import('../src/appointments/rehash-call-note.js');
const { writeRehashCallNote } = await import('../src/services/rehash-call-note-io.js');

const created = () => calls.find((c) => c.method === 'POST' && c.path === '/calendars/events/appointments')?.body || null;
const emailAskInserted = () => calls.some((c) => c.method === 'POST' && /agent_actions/.test(c.raw)
  && JSON.stringify(c.body || '').includes('POST_BOOKING_EMAIL_ASK'));

test('title: name / no name / a Visitor placeholder', () => {
  assert.equal(rehashCallTitle('Kim Turko'), 'Reece Best-Offer Call: Kim Turko');
  assert.equal(rehashCallTitle(''), 'Reece Best-Offer Call');
  assert.equal(rehashCallTitle(null), 'Reece Best-Offer Call');
  // The formatter leaves a Rehash Call title alone (Kim: the name came twice).
  const body = { calendarId: CAL, title: 'Reece Best-Offer Call: Kim Turko' };
  applyAppointmentFormat(body, { firstName: 'Kim', lastName: 'Turko' });
  assert.equal(body.title, 'Reece Best-Offer Call: Kim Turko');
  const visit = { calendarId: 'aJj14ONxh1oFyDcQ706O', title: 'Window Estimate - Ann Lee' };
  applyAppointmentFormat(visit, { firstName: 'Ann', lastName: 'Lee' });
  assert.match(visit.title, /Ann Lee/);
});

test('switches: title and auto-confirm on by default, notes live by default; each turns off alone', () => {
  assert.equal(rehashCallTitleOn({}), true);
  assert.equal(rehashCallTitleOn({ REHASH_CALL_TITLE_MODE: 'off' }), false);
  assert.equal(rehashCallAutoConfirm({}), true);
  assert.equal(rehashCallAutoConfirm({ REHASH_CALL_AUTO_CONFIRM: 'off' }), false);
  assert.equal(rehashCallNotesMode({}), 'live');
  assert.equal(rehashCallNotesMode({ REHASH_CALL_NOTES_MODE: 'shadow' }), 'shadow');
  assert.equal(creationStatus({ isRehashCall: true, env: {} }), 'confirmed');
  assert.equal(creationStatus({ isRehashCall: true, env: { REHASH_CALL_AUTO_CONFIRM: 'off' } }), 'new');
  assert.equal(creationStatus({ isRehashCall: false, env: {} }), 'new');
  const b = rehashCallBooking({ slot: { iso: '2026-10-24T18:00:00Z' }, calendarId: CAL, rep: null, env: {} });
  assert.equal(b.action_payload.title, 'Reece Best-Offer Call');
  assert.equal(b.action_payload.status, 'confirmed');
  assert.equal(b.action_payload.calendar_name, 'Rehash Call', 'the calendar keeps its name');
});

test('Kim: a Rehash Call is created confirmed, titled once, and no email ask follows', async () => {
  calls = [];
  contactRecord = { id: 'fnGjYEvok31f46ZmnZQW', firstName: 'Kim', lastName: 'Turko', phone: '+13525550188', tags: ['rehash'], customFields: [] };
  const r = await executeBookAppointment({
    id: 629976, target_id: 'fnGjYEvok31f46ZmnZQW',
    action_payload: { calendar_id: CAL, calendar_name: 'Rehash Call', start_time: '2026-10-24T18:00:00+00:00', duration_minutes: 15, title: 'Rehash Call', status: 'new', source: 'sms_bot', rehash_call: true },
  }, {});
  assert.equal(r.action, 'appointment_booked', JSON.stringify(r));
  assert.equal(r.status, 'confirmed');
  const body = created();
  assert.equal(body.appointmentStatus, 'confirmed');
  assert.equal(body.title, 'Reece Best-Offer Call: Kim Turko');
  assert.ok(!('description' in body), 'nothing about the conversation goes where the lead can see it');
  assert.equal(emailAskInserted(), false);
});

test('a Visitor placeholder never reaches the title', async () => {
  calls = [];
  contactRecord = { id: 'v1', firstName: 'Kim', lastName: 'Visitor Anlxy', phone: '+13525550188', tags: ['rehash'], customFields: [] };
  await executeBookAppointment({ id: 1, target_id: 'v1', action_payload: { calendar_id: CAL, start_time: '2026-10-24T18:00:00+00:00', duration_minutes: 15, source: 'sms_bot' } }, {});
  assert.equal(created().title, 'Reece Best-Offer Call: Kim');
});

test('an in-home visit is still born new and still gets the email ask', async () => {
  calls = [];
  contactRecord = { id: 'w1', firstName: 'Ann', lastName: 'Lee', phone: '+18135551234', address1: '1 Main St', postalCode: '33618', tags: [], customFields: [] };
  const r = await executeBookAppointment({
    id: 2, target_id: 'w1',
    action_payload: { calendar_name: 'Window Estimate', start_time: '2026-10-24T18:00:00+00:00', status: 'confirmed', qualifying_data: { decision_makers_present: 'Yes' } },
  }, {});
  assert.equal(r.action, 'appointment_booked', JSON.stringify(r));
  assert.equal(r.status, 'new');
  assert.equal(created().appointmentStatus, 'new');
  assert.equal(emailAskInserted(), true);
});

// ── E. the internal note ──
const KIM_THREAD = [
  { direction: 'outbound', text: 'Hi Kim, did you get a chance to look over the proposal?' },
  { direction: 'inbound', text: 'We got another quote that was cheaper. Does yours include installation?' },
  { direction: 'outbound', text: 'If I could get you a better price, would you be open to a quick call with John?' },
  { direction: 'inbound', text: 'Yes Saturday at 2' },
];

test('note: the exact shape, "Booked by Reece Chatbot" first, unknown lines left out, capped at 700', () => {
  const note = buildRehashCallNote({
    startTime: '2026-10-24T18:00:00Z', repOnVisit: 'Barela, Craig', demoDate: '2026-10-07T00:00:00+00:00',
    fields: readNoteFields({ homeowners: 'Kim and Tom Turko', project: '12 windows, 1 slider', asked: 'Does the price include installation', concerns: 'Comparing a cheaper quote from another company', bot_said: 'may be able to get a better price', extra: 'ignored' }),
  });
  const lines = note.split('\n');
  assert.equal(lines[0], BOOKED_BY_LINE);
  assert.equal(lines[1], 'Call: Sat, Oct 24, 2:00 PM ET · Rep on visit: Craig Barela · Demo: Oct 7');
  assert.equal(lines[2], 'Homeowners: Kim and Tom Turko');
  assert.equal(lines.at(-1), 'Goal of call: get best price, then set manager visit');
  assert.ok(!/ignored/.test(note));

  const sparse = buildRehashCallNote({ startTime: '2026-10-24T18:00:00Z', fields: readNoteFields({ homeowners: 'unknown', project: '' }) });
  assert.deepEqual(sparse.split('\n'), [BOOKED_BY_LINE, 'Call: Sat, Oct 24, 2:00 PM ET', 'Goal of call: get best price, then set manager visit']);

  const long = 'x'.repeat(400);
  const capped = buildRehashCallNote({ startTime: '2026-10-24T18:00:00Z', fields: { homeowners: long, project: long, asked: long, concerns: long, bot_said: long } });
  assert.ok(capped.length <= REHASH_CALL_NOTE_MAX, String(capped.length));
  assert.ok(capped.startsWith(BOOKED_BY_LINE));
  assert.ok(capped.endsWith('Goal of call: get best price, then set manager visit'));
});

const noteDeps = (over = {}) => {
  const out = { appt: [], contact: [], logs: [] };
  return {
    out,
    deps: {
      readThread: async () => KIM_THREAD,
      getContact: async () => ({ firstName: 'Kim', lastName: 'Turko', tags: ['rehash', 'competitor-quote'] }),
      readDemoLead: async () => ({ lp_lead_id: 1, rep_name: 'Barela, Craig', demo_date: '2026-10-07T00:00:00+00:00' }),
      readVisit: async () => null,
      callLLMJson: async () => ({ data: { homeowners: 'Kim Turko', project: '', asked: 'Does it include installation', concerns: 'Cheaper quote from another company', bot_said: 'may be able to get a better price' } }),
      postAppointmentNote: async (id, body) => { out.appt.push({ id, body }); return { note: { id: 'n1' } }; },
      addContactNote: async (id, body) => { out.contact.push({ id, body }); return { success: true }; },
      log: (l) => out.logs.push(l),
      ...over,
    },
  };
};

test('note I/O: live posts an appointment note; a refusal falls back to a contact note named for the appointment', async () => {
  const a = noteDeps();
  const r = await writeRehashCallNote({ contactId: 'k1', appointmentId: '6fuXQWigbVHlFzzReCzQ', startTime: '2026-10-24T18:00:00Z', mode: 'live' }, a.deps);
  assert.equal(r.written, 'appointment_note');
  assert.equal(a.out.appt[0].id, '6fuXQWigbVHlFzzReCzQ');
  assert.ok(a.out.appt[0].body.startsWith('Booked by Reece Chatbot\n'));
  assert.match(a.out.appt[0].body, /Concerns\/objections: Cheaper quote/);
  assert.ok(!/Project:/.test(a.out.appt[0].body), 'an empty field is a line left out');

  const b = noteDeps({ postAppointmentNote: async () => { throw new Error('GHL POST → 404'); } });
  const r2 = await writeRehashCallNote({ contactId: 'k1', appointmentId: 'A1', startTime: '2026-10-24T18:00:00Z', mode: 'live' }, b.deps);
  assert.equal(r2.written, 'contact_note');
  assert.match(b.out.contact[0].body, /^Rehash Call Sat, Oct 24, 2:00 PM ET \(appointment A1\)\nBooked by Reece Chatbot/);
});

test('note I/O: shadow writes nothing; a failed model keeps the lines code knows; nothing throws', async () => {
  const s = noteDeps();
  const r = await writeRehashCallNote({ contactId: 'k1', appointmentId: 'A1', startTime: '2026-10-24T18:00:00Z', mode: 'shadow' }, s.deps);
  assert.equal(r.written, 'shadow');
  assert.equal(s.out.appt.length + s.out.contact.length, 0);

  const m = noteDeps({ callLLMJson: async () => { throw new Error('timeout'); }, readDemoLead: async () => { throw new Error('db down'); } });
  const r2 = await writeRehashCallNote({ contactId: 'k1', appointmentId: 'A1', startTime: '2026-10-24T18:00:00Z', mode: 'live' }, m.deps);
  assert.equal(r2.written, 'appointment_note');
  assert.deepEqual(m.out.appt[0].body.split('\n'), [BOOKED_BY_LINE, 'Call: Sat, Oct 24, 2:00 PM ET', 'Goal of call: get best price, then set manager visit']);
});

test('the appointment note goes out on API version 2021-04-15; every other GHL call keeps 2021-07-28', async () => {
  const { ghlFetch } = await import('../src/actions/helpers.js');
  calls = [];
  await ghlFetch('POST', '/calendars/appointments/A1/notes', { body: 'x' }, { version: '2021-04-15' });
  await ghlFetch('GET', '/contacts/abc');
  assert.equal(calls[0].headers.Version, '2021-04-15');
  assert.equal(calls[1].headers.Version, '2021-07-28');
});
