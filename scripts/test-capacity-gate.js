/**
 * Tests — scripts/test-capacity-gate.js
 *
 * The market capacity gate for bot bookings and the 6:30 / 7:00 request
 * (Mark, 2026-10-15, handoff v3): src/knowledge/market-capacity-gate.js,
 * src/agentic/evening-request.js, the SMS booking facts that pin 6:00 PM
 * (src/agentic/sms-booking-turn.js), the side effects after the booking lands
 * (src/services/evening-request-io.js), the field overwrite
 * (src/services/preferred-time.js) and the no-times prompt (R6).
 *
 * Handoff cases 1–8 and 13–16. The LP note (9–12) is in
 * scripts/test-time-change-lp-note.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-key';

const gate = await import('../src/knowledge/market-capacity-gate.js');
const ev = await import('../src/agentic/evening-request.js');
const { smsBookingTurn, enforceBookingFacts } = await import('../src/agentic/sms-booking-turn.js');
const { recordEveningRequest } = await import('../src/services/evening-request-io.js');
const { overwriteRequestedTime, persistPreferredTime } = await import('../src/services/preferred-time.js');
const cal = await import('../src/knowledge/calendar-availability.js');
const { fakeSupabase } = await import('./lib/fake-supabase.js');

const WE = 'aJj14ONxh1oFyDcQ706O';          // Window Estimate (in-home)
const PPR = 'DQYMaJ22N6zL4SXjHukw';         // a phone calendar
const NOW = Date.parse('2026-10-14T14:00:00Z');   // Wed Oct 14, 10:00 AM ET
const THU = '2026-10-15';
const THU_6PM = '2026-10-15T22:00:00.000Z';      // 6:00 PM ET
const THU_10AM = '2026-10-15T14:00:00.000Z';
const ON = { CAPACITY_GATE_ENABLED: 'true', CAPACITY_GATE_CACHE_SECONDS: '0' };
const OFF = { CAPACITY_GATE_ENABLED: 'false' };

function deps({ cap = [], horizon = '2026-10-25', meetings = [], pending = [], branch = [{ brn_id: 'SAR', market_code: 'SAR_MKT' }, { brn_id: 'BOCA', market_code: 'FTLAU_MKT' }] } = {}) {
  return {
    readBranchMap: async () => branch,
    readCapacity: async () => cap,
    readHorizon: async () => horizon,
    readMeetings: async () => meetings,
    readPendingBot: async () => pending,
  };
}
const slot = (iso) => ({ iso, day: 'Thu, Oct 15', time: new Date(iso).getUTCHours() === 22 ? '6:00 PM' : '10:00 AM', dayOfWeek: 'Thursday' });
const reset = () => gate._resetCapacityGateCache();

// ── 1–6: the gate ────────────────────────────────────────────────────────────

test('1. an open band keeps the slot', async () => {
  reset();
  const r = await gate.filterSlotsByCapacity({ calendarId: WE, marketCode: 'SAR', slots: [slot(THU_6PM)] },
    deps({ cap: [{ slot_date: THU, slot_id: 3, has_appt: false }, { slot_date: THU, slot_id: 3, has_appt: false }] }), { nowMs: NOW, env: ON });
  assert.equal(r.gated, true);
  assert.equal(r.market, 'SAR_MKT');
  assert.deepEqual(r.slots.map(s => s.iso), [THU_6PM]);
});

test('2. a full band (has_appt + pending_bot = capacity) removes the slot', async () => {
  reset();
  const d = deps({
    cap: [{ slot_date: THU, slot_id: 3, has_appt: true }, { slot_date: THU, slot_id: 3, has_appt: false }],
    pending: [{ start_iso: THU_6PM }],
  });
  const r = await gate.filterSlotsByCapacity({ calendarId: WE, marketCode: 'SAR', slots: [slot(THU_6PM)] }, d, { nowMs: NOW, env: ON });
  assert.equal(r.slots.length, 0);
  assert.equal(r.removed, 1);
  const o = (await gate.getMarketBandOpenings('SAR_MKT', THU, THU, d, { nowMs: NOW, env: ON })).find(x => x.band === 3);
  assert.deepEqual({ capacity: o.capacity, lp_booked: o.lp_booked, pending_bot: o.pending_bot, open: o.open, closed_reason: o.closed_reason },
    { capacity: 2, lp_booked: 1, pending_bot: 1, open: 0, closed_reason: 'full' });
});

test('3. a date past the horizon is closed: unfiled', async () => {
  reset();
  const r = await gate.isSlotBookable('SAR_MKT', THU_6PM, deps({ cap: [{ slot_date: THU, slot_id: 3, has_appt: false }], horizon: '2026-10-14' }), { nowMs: NOW, env: ON, log: false });
  assert.deepEqual(r, { ok: false, band: 3, closed_reason: 'unfiled', date: THU, open: 0 });
  reset();
  const never = await gate.isSlotBookable('SAR_MKT', THU_6PM, deps({ cap: [], horizon: null }), { nowMs: NOW, env: ON, log: false });
  assert.equal(never.closed_reason, 'unfiled', 'a market that never filed is unfiled, not open');
});

test('4. a meeting that overlaps the band closes it (weekly and one-day rows)', async () => {
  const cap = [{ slot_date: THU, slot_id: 1, has_appt: false }, { slot_date: THU, slot_id: 3, has_appt: false }];
  reset();
  const weekly = deps({ cap, meetings: [{ day_of_week: 4, start_local: '09:00:00', end_local: '11:00:00', active: true }] });
  assert.equal((await gate.isSlotBookable('SAR_MKT', THU_10AM, weekly, { nowMs: NOW, env: ON, log: false })).closed_reason, 'meeting');
  assert.equal((await gate.isSlotBookable('SAR_MKT', THU_6PM, weekly, { nowMs: NOW, env: ON, log: false })).ok, true, 'the evening is untouched');
  reset();
  const oneDay = deps({ cap, meetings: [{ specific_date: THU, start_local: '17:30', end_local: '19:00', active: true }] });
  assert.equal((await gate.isSlotBookable('SAR_MKT', THU_6PM, oneDay, { nowMs: NOW, env: ON, log: false })).closed_reason, 'meeting');
  reset();
  const otherDay = deps({ cap, meetings: [{ specific_date: '2026-10-16', start_local: '17:30', end_local: '19:00', active: true }] });
  assert.equal((await gate.isSlotBookable('SAR_MKT', THU_6PM, otherDay, { nowMs: NOW, env: ON, log: false })).ok, true);
  assert.equal(gate.meetingClosesBand([{ day_of_week: 4, start_local: '13:00', end_local: '14:00', active: false }], THU, 2), false, 'an inactive row closes nothing');
});

test('5. a manual 18:30 appointment uses up the Evening band: 18:00 closed at capacity 1', async () => {
  reset();
  // LP shows the rep's evening slot taken (the 6:30 a person set by hand).
  const lpSide = deps({ cap: [{ slot_date: THU, slot_id: 3, has_appt: true }] });
  assert.equal((await gate.isSlotBookable('SAR_MKT', THU_6PM, lpSide, { nowMs: NOW, env: ON, log: false })).ok, false);
  // A bot booking at 18:30 not yet in LP counts against the same band.
  reset();
  const botSide = deps({ cap: [{ slot_date: THU, slot_id: 3, has_appt: false }], pending: [{ start_iso: '2026-10-15T22:30:00.000Z' }] });
  assert.equal((await gate.isSlotBookable('SAR_MKT', THU_6PM, botSide, { nowMs: NOW, env: ON, log: false })).closed_reason, 'full');
});

test('6. an unmapped market is not gated and logs capacity_gate_skipped', async () => {
  reset();
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(String(m));
  try {
    const hou = await gate.filterSlotsByCapacity({ calendarId: WE, marketCode: 'HOU', slots: [slot(THU_6PM)] }, deps(), { nowMs: NOW, env: ON });
    const none = await gate.filterSlotsByCapacity({ calendarId: WE, marketCode: null, slots: [slot(THU_6PM)] }, deps(), { nowMs: NOW, env: ON });
    assert.equal(hou.gated, false); assert.equal(hou.skipped, 'not_in_universe'); assert.equal(hou.slots.length, 1);
    assert.equal(none.skipped, 'unresolved'); assert.equal(none.slots.length, 1);
  } finally { console.log = orig; }
  assert.ok(logs.some(l => l.includes('capacity_gate_skipped:not_in_universe')));
  assert.ok(logs.some(l => l.includes('capacity_gate_skipped:unresolved')));
  // A phone calendar is never gated.
  const ppr = await gate.filterSlotsByCapacity({ calendarId: PPR, marketCode: 'SAR', slots: [slot(THU_6PM)] }, deps({ cap: [] }), { nowMs: NOW, env: ON });
  assert.equal(ppr.gated, false);
  // A read that fails opens the gate (fail open), never closes the calendar.
  reset();
  const broken = { ...deps(), readCapacity: async () => { throw new Error('db down'); } };
  const r = await gate.filterSlotsByCapacity({ calendarId: WE, marketCode: 'SAR', slots: [slot(THU_6PM)] }, broken, { nowMs: NOW, env: ON });
  assert.equal(r.skipped, 'read_failed'); assert.equal(r.slots.length, 1);
  // Service codes map like the capacity tools do: BOCA → FTLAU_MKT.
  assert.deepEqual(await gate.toCapacityMarket('BOCA', deps()), { code: 'FTLAU_MKT' });
});

// ── 7–8: the 6:30 / 7:00 request ─────────────────────────────────────────────

const PLAN = { required_move: 'offer_slots', last_offer: '', step: 'offer' };
const thread = (text) => [{ direction: 'outbound', text: 'What day works best for you?' }, { direction: 'inbound', text }];

test('7. "Can you do 6:30 Thursday?" with 18:00 open books 18:00 and writes everything once', async () => {
  const slots = [slot(THU_10AM), slot(THU_6PM)];
  const pin = ev.findSixPmSlot({ text: 'Can you do 6:30 Thursday?', slots, timeZone: 'America/New_York', nowMs: NOW });
  assert.equal(pin.slot.iso, THU_6PM);
  assert.equal(pin.requested_time, '6:30 PM');
  assert.equal(pin.requested_label, '6:30 PM on Thu Oct 15');

  const facts = smsBookingTurn({ plan: PLAN, trigger: 'Can you do 6:30 Thursday?', thread: thread('Can you do 6:30 Thursday?'), slots, tz: 'ET',
    gateMissing: [], pinnedSlot: pin.slot, evening: { requested_time: pin.requested_time, minutes: pin.requested_minutes }, calendar: { calendar_id: WE, calendar_name: 'Window Estimate' } });
  assert.equal(facts.kind, 'book');
  assert.equal(facts.companion.action_payload.start_time, THU_6PM, 'the booking is 6:00 PM');
  const exact = "I'm putting you for 6:00, with a note that you would like the appointment for 6:30 PM. Our team will be reaching out to confirm the details and make that adjustment for you.";
  assert.equal(facts.fallback, exact, 'the reference is the handoff sentence, word for word');
  assert.equal(enforceBookingFacts(exact, facts).fallback_used, false);
  // The model's own wording stands when it keeps the facts; a plain confirm does not.
  assert.equal(enforceBookingFacts("Got it. I'm putting you down for 6:00 PM with a note that you'd like 6:30 PM. Our team will reach out to confirm the details and move it for you.", facts).fallback_used, false);
  const bad = enforceBookingFacts("You're all set for Thursday at 6:00 PM. Someone will call to confirm the details.", facts);
  assert.equal(bad.fallback_used, true);
  assert.equal(bad.message, exact);

  // Side effects after the booking landed.
  const db = fakeSupabase();
  const notes = []; const writes = []; const cards = [];
  const d = {
    supabase: db,
    addNote: async (id, body) => { notes.push(body); },
    overwrite: (id, value) => overwriteRequestedTime(id, value, { updateFields: async (cid, fields) => { writes.push(fields); return true; } }),
    capacityMarketFor: async () => 'SAR_MKT',
    postCard: async (a) => { cards.push(a); return true; },
  };
  const request = { requested_time: '6:30 PM', requested_label: pin.requested_label, slot_iso: THU_6PM, time_zone: 'America/New_York', market_code: 'SAR', first_name: 'Dana' };
  const first = await recordEveningRequest({ contactId: 'c1', appointmentId: 'appt1', request }, d);
  const again = await recordEveningRequest({ contactId: 'c1', appointmentId: 'appt1', request }, d);
  assert.equal(first.created, true); assert.equal(again.created, false);
  assert.equal(cards.length, 1, 'exactly one #contact-center card');
  assert.equal(db.tables.appt_time_change_requests.length, 1, 'one request row');
  assert.equal(db.tables.appt_time_change_requests[0].status, 'pending');
  assert.equal(notes[0], 'Customer requested 6:30 PM. Bot booked 6:00 PM on Thu Oct 15. Please confirm and adjust.');
  // The field is OVERWRITTEN (no read of the old value) with { customFields } only: no tags.
  assert.deepEqual(writes[0], [{ id: '7lpRWFDM8DZbLd3viHEG', field_value: '6:30 PM on Thu Oct 15' }]);
  assert.ok(!JSON.stringify(writes).includes('tags'));
  assert.ok(!Object.keys(d).some(k => /tag/i.test(k)), 'nothing here can add a tag');
});

test('7b. "can you do 7pm tomorrow", "after 6" and "7" read as evening asks; counts and mornings do not', () => {
  assert.equal(ev.detectEveningRequest('can you do 7pm tomorrow').requested_time, '7:00 PM');
  assert.equal(ev.detectEveningRequest('after 6 works').requested_time, 'after 6:00 PM');
  assert.equal(ev.detectEveningRequest('maybe at 7').requested_time, '7:00 PM');
  for (const t of ['7 windows', '2 or 3 doors', '7 am please', '6pm is fine', 'Thursday at 6']) assert.equal(ev.detectEveningRequest(t), null, t);
});

test('8. the same request with 18:00 closed books nothing and writes nothing', () => {
  // The gate already removed 18:00 from the slots the turn sees.
  const pin = ev.findSixPmSlot({ text: 'Can you do 6:30 Thursday?', slots: [slot(THU_10AM)], timeZone: 'America/New_York', nowMs: NOW });
  assert.equal(pin, null, 'no pin → the normal flow offers the nearest open times');
  const facts = smsBookingTurn({ plan: PLAN, trigger: 'Can you do 6:30 Thursday?', thread: thread('Can you do 6:30 Thursday?'), slots: [slot(THU_10AM)], gateMissing: [], pinnedSlot: null, evening: { requested_time: '6:30 PM', minutes: 1110 } });
  assert.equal(facts, null, 'no booking facts, so no booking and no side effects');
});

// ── 13–16 ────────────────────────────────────────────────────────────────────

test('13. everything gated empty: the prompt sends no booking link', () => {
  const text = cal.formatSlotsForPrompt({ slots: [], capacity_gated_empty: true, calendar_id: WE, timezone: 'America/New_York' });
  assert.match(text, /Do NOT send a booking link/);
  assert.doesNotMatch(text, /send the booking link as the primary CTA/);
  const src = readFileSync(new URL('../src/response-generator.js', import.meta.url), 'utf8');
  assert.match(src, /capacityGate && !\(availability\?\.slots \|\| \[\]\)\.length\) \{\s*if \(kbPack\?\.booking_context\) kbPack\.booking_context\.booking_url = null;/,
    'the generator clears booking_url when the gate empties the offer');
});

// A fake GHL free-slots answer for the fetchFreeSlots wrapper, three days from
// the real clock (fetchFreeSlots filters past times), at 10 AM and 6 PM ET.
function etIso(ymd, hour) {
  for (const off of ['-04:00', '-05:00']) {
    const iso = `${ymd}T${String(hour).padStart(2, '0')}:00:00${off}`;
    const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    if (Number(h) === hour) return iso;
  }
  throw new Error('no ET offset');
}
function stubFetch() {
  const orig = globalThis.fetch;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + 3 * 86_400_000));
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ [ymd]: { slots: [etIso(ymd, 10), etIso(ymd, 18)] } }) });
  return () => { globalThis.fetch = orig; };
}

test('14. an LP→GHL sync never passes a market, so a closed band is never gated there', async () => {
  for (const f of ['../src/lp-appointment-sync.js', '../src/services/lp-ghl-appointment-reconciler.js', '../src/jobs/appointment-parity-watchdog.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /marketCode|market-capacity-gate|isSlotBookable/, `${f} must not reach the gate`);
  }
  const restore = stubFetch();
  try {
    cal._resetFreeSlotsCache(); reset();
    const closed = deps({ cap: [] });   // nothing open anywhere
    const read = await cal.fetchFreeSlots(WE, { maxSlots: 50, minNoticeHours: 0, capacityDeps: closed });
    assert.equal(read.capacity_gate, undefined);
    assert.equal(read.slots.length, 2, 'no market named → GHL slots come back untouched');
  } finally { restore(); }
});

test('15. CAPACITY_GATE_ENABLED=false: the read and the slots are exactly as before', async () => {
  const restore = stubFetch();
  const prev = process.env.CAPACITY_GATE_ENABLED;
  try {
    cal._resetFreeSlotsCache(); reset();
    const before = await cal.fetchFreeSlots(WE, { maxSlots: 50, minNoticeHours: 0 });
    assert.equal(before.slots.length, 2);
    process.env.CAPACITY_GATE_ENABLED = 'false';
    cal._resetFreeSlotsCache();
    const after = await cal.fetchFreeSlots(WE, { maxSlots: 50, minNoticeHours: 0, marketCode: 'SAR', capacityDeps: deps({ cap: [] }) });
    assert.deepEqual(after, before);
    const r = await gate.filterSlotsByCapacity({ calendarId: WE, marketCode: 'SAR', slots: [slot(THU_6PM)] }, deps({ cap: [] }), { env: OFF });
    assert.equal(r.gated, false); assert.equal(r.skipped, 'disabled');
    assert.equal(await gate.capacityMarketFor('SAR', deps()), null, 'no capacity_market stamp');
    // With the gate ON the same read is thinned.
    process.env.CAPACITY_GATE_ENABLED = 'true';
    cal._resetFreeSlotsCache(); reset();
    const gated = await cal.fetchFreeSlots(WE, { maxSlots: 50, minNoticeHours: 0, marketCode: 'SAR', capacityDeps: deps({ cap: [] }) });
    assert.equal(gated.slots.length, 0);
    assert.equal(gated.capacity_gate.market, 'SAR_MKT');
  } finally {
    restore();
    if (prev === undefined) delete process.env.CAPACITY_GATE_ENABLED; else process.env.CAPACITY_GATE_ENABLED = prev;
  }
  // R5 code paths all sit behind capacityGateEnabled().
  for (const f of ['../src/response-generator.js', '../src/live-chat/fast-lane.js']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /capacityGateEnabled\(\)/, `${f} gates R5 on the switch`);
  }
});

test('16. persistPreferredTime still fills only an empty field', async () => {
  const contact = { customFields: [{ id: '7lpRWFDM8DZbLd3viHEG', value: 'Monday at 10:00 AM' }, { id: 'x', value: '' }] };
  const n = await persistPreferredTime('c1', { raw: 'Thursday at 6:30 PM', source: 'inbound' }, { contact });
  assert.equal(n, 0, 'a value already there is never clobbered by the normal path');
});

test('7c. a held 6:00 PM says the evening note once, even when the model writes "7" without PM', () => {
  const slot6 = slot(THU_6PM);
  const facts = smsBookingTurn({ plan: PLAN, trigger: 'Can you do 7pm tomorrow?', thread: thread('Can you do 7pm tomorrow?'), slots: [slot6], tz: 'ET',
    gateMissing: ['address'], pinnedSlot: slot6, evening: { requested_time: '7:00 PM', minutes: 1140 } });
  assert.equal(facts.kind, 'hold');
  const draft = `I'm holding Thu, Oct 15 at 6:00 PM ET for you. We start visits at 6, but I noted you'd prefer 7. ${facts.ask_line}`;
  const out = enforceBookingFacts(draft, facts);
  assert.equal((out.message.match(/\bnote/gi) || []).length, 1, out.message);
  assert.match(out.message, /I'm holding Thu, Oct 15 at 6:00 PM ET for you\./);
  assert.ok(out.message.endsWith(facts.ask_line));
  // A draft with no note at all still gets ours.
  const bare = enforceBookingFacts(`I'm holding Thu, Oct 15 at 6:00 PM ET for you. ${facts.ask_line}`, facts);
  assert.match(bare.message, /I've made a note that you would like 7:00 PM\./);
});
