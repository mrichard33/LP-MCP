/**
 * Rehash Call times (the user, 2026-10-09): "check this calendar for
 * availability before offering times to the user, ensuring we book only when
 * the calendar shows real availability." Calendar ncDzLgzbfKJRfhmtlWtB
 * (REHASH_CALENDAR_ID).
 *
 * Run: node --test scripts/test-rehash-call-slots.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rehashCallSlotsMode, readRehashCallSlots, rehashCallBooking } from '../src/agentic/rehash-slots.js';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { recheckSlot } from '../src/agentic/slot-recheck.js';
import { postDemoRehash } from '../src/prompts/response-generator/playbooks.js';

const NOW = Date.parse('2026-10-09T16:00:00Z'); // Fri noon ET
const CAL = 'ncDzLgzbfKJRfhmtlWtB';
const JOHN = 'TYcZ9DcNkuPCFYsFxRFV';
const ENV = { REHASH_CALENDAR_ID: CAL };
const S = (iso, day, time, rel) => ({ iso, day, time, dayOfWeek: day.slice(0, 3), ...(rel ? { rel } : {}), tz: 'ET' });
const ALL = [
  S('2026-10-09T18:00:00Z', 'Fri, Oct 9', '2:00 PM', 'today'),
  S('2026-10-09T19:30:00Z', 'Fri, Oct 9', '3:30 PM', 'today'),
  S('2026-10-10T14:00:00Z', 'Sat, Oct 10', '10:00 AM', 'tomorrow'),
  S('2026-10-12T20:00:00Z', 'Mon, Oct 12', '4:00 PM'),
];
const CALL_SLOTS = { calendarId: CAL, rep: JOHN, offer: ALL.slice(0, 2), all: ALL };
const BRIDGE = { direction: 'outbound', text: 'I may be able to do something for you on that, and it is easier to go over on a quick call. Would a quick call help?' };

const plan = (trigger, conversation = [BRIDGE], callSlots = CALL_SLOTS) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: [], tzLabel: 'ET', firstName: 'Pat',
  discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep: 'John', callSlots,
});

test('REHASH_CALL_SLOTS_MODE: default shadow, a typo is shadow', () => {
  assert.equal(rehashCallSlotsMode({}), 'shadow');
  assert.equal(rehashCallSlotsMode({ REHASH_CALL_SLOTS_MODE: 'live' }), 'live');
  assert.equal(rehashCallSlotsMode({ REHASH_CALL_SLOTS_MODE: 'nope' }), 'shadow');
});

test('readRehashCallSlots: no calendar set → null, nothing read', async () => {
  let reads = 0;
  const r = await readRehashCallSlots({ contactId: 'c1', timezone: 'America/New_York', env: {} }, { getOwner: async () => null, fetchFreeSlots: async () => { reads++; return null; }, selectOfferableSlots: () => null, isOpen: () => true });
  assert.equal(r, null);
  assert.equal(reads, 0);
});

test('readRehashCallSlots: read for the rep the booking will name', async () => {
  const seen = [];
  const deps = {
    fetchFreeSlots: async (cal, opts) => { seen.push({ cal, userId: opts.userId }); return { slots: ALL, timezone: 'America/New_York' }; },
    selectOfferableSlots: (av, _p, opts) => ({ slots: opts.maxOffer ? av.slots : av.slots.slice(0, 2) }),
    isOpen: () => true,
  };
  // The owner is not on the rehash team → the Rehash rep (John).
  const a = await readRehashCallSlots({ contactId: 'c1', timezone: 'America/New_York', env: ENV }, { ...deps, getOwner: async () => 'someone-else' });
  assert.deepEqual(seen[0], { cal: CAL, userId: JOHN });
  assert.equal(a.rep, JOHN);
  assert.equal(a.offer.length, 2);
  assert.equal(a.all.length, 4);
  // The owner is on the team → that rep.
  await readRehashCallSlots({ contactId: 'c1', timezone: 'America/New_York', env: { ...ENV, REHASH_TEAM_USER_IDS: `${JOHN},rep2` } }, { ...deps, getOwner: async () => 'rep2' });
  assert.equal(seen[1].userId, 'rep2');
});

test('readRehashCallSlots: one opening in 48 hours → the two soonest in the 14 days', async () => {
  const { spreadCallOffer } = await import('../src/knowledge/calendar-availability.js');
  const r = await readRehashCallSlots({ contactId: 'c1', timezone: 'America/New_York', env: ENV }, {
    getOwner: async () => null,
    fetchFreeSlots: async () => ({ slots: ALL, timezone: 'America/New_York' }),
    // The 48-hour window holds one time; the 14-day pool holds all four.
    selectOfferableSlots: (av, _p, opts) => ({ slots: opts.maxOffer ? av.slots : av.slots.slice(0, 1) }),
    spreadCallOffer, isOpen: () => true,
  });
  assert.deepEqual(r.offer.map(s => s.iso), [ALL[0].iso, ALL[1].iso]);
});

test('readRehashCallSlots: a failed read is null (the old reply), never a guess', async () => {
  const r = await readRehashCallSlots({ contactId: 'c1', timezone: 'America/New_York', env: ENV }, {
    getOwner: async () => null, fetchFreeSlots: async () => { throw new Error('GHL 500'); }, selectOfferableSlots: () => null, isOpen: () => true,
  });
  assert.equal(r, null);
});

test('a yes to the call → two REAL openings, booking allowed', () => {
  const p = plan('Yes that would be great');
  assert.equal(p.step, 'rehash_offer');
  assert.deepEqual(p.slots_to_offer.map(s => s.iso), [ALL[0].iso, ALL[1].iso]);
  assert.match(p.fixed_line, /^I have today at 2:00 PM ET or today at 3:30 PM ET/);
  assert.equal(p.booking.allowed, true);
  assert.equal(p.post_demo, true);
});

test('"can someone call me" with open times → the times, not the card', () => {
  const p = plan('Can someone call me?', [{ direction: 'outbound', text: 'Where are you landing on the proposal?' }]);
  assert.equal(p.step, 'rehash_offer');
});

test('no open times → the old callback hand-off (the #contact-rehash card)', () => {
  const p = plan('Can someone call me?', [{ direction: 'outbound', text: 'Where are you landing on the proposal?' }], { ...CALL_SLOTS, offer: [], all: [] });
  assert.equal(p.step, 'handoff');
  assert.equal(p.handoff.reason, 'callback_request');
});

test('a pick from our offer → confirm that exact slot', () => {
  const conv = [BRIDGE, { direction: 'inbound', text: 'Yes' }, { direction: 'outbound', text: 'I have today at 2:00 PM ET or today at 3:30 PM ET. Which works better?' }];
  const p = plan('The second one', conv);
  assert.equal(p.step, 'rehash_confirm');
  assert.equal(p.rehash_pick.iso, ALL[1].iso);
  assert.match(p.reference_line, /on the calendar for a quick call today at 3:30 PM ET/);
});

test('a typed time the calendar does not show → the two nearest real openings, never a booking', () => {
  const p = plan('How about 5 PM?', [BRIDGE]);
  assert.equal(p.step, 'rehash_offer');
  assert.ok(p.slots_to_offer.every(s => ALL.some(a => a.iso === s.iso)));
  assert.equal(p.rehash_pick, undefined);
});

test('a follow-up date still wins over the call times', () => {
  const p = plan('Call me in November please', [BRIDGE]);
  assert.equal(p.step, 'defer');
  assert.deepEqual(p.slots_to_offer, []);
});

test('the model may not name a time the calendar did not give', () => {
  const p = plan('Yes that would be great');
  const bad = enforceNepqPlan('Sure. I can call you at 6 PM tonight. Does that work?', p);
  assert.ok(bad.changes.includes('backup_line'), bad.changes.join(','));
  assert.equal(bad.text, p.fixed_line);
  const good = enforceNepqPlan('Great. I have today at 2:00 PM ET or today at 3:30 PM ET. Which works better for you?', p);
  assert.ok(!good.changes.includes('backup_line'), good.changes.join(','));
});

test('rehashCallBooking: that slot, the Rehash Call calendar, the rep, status new', () => {
  const b = rehashCallBooking({ slot: ALL[1], calendarId: CAL, rep: JOHN, env: {} });
  assert.equal(b.action_type, 'book_appointment');
  assert.deepEqual(
    [b.action_payload.calendar_id, b.action_payload.start_time, b.action_payload.assigned_user_id, b.action_payload.status, b.action_payload.duration_minutes, b.action_payload.rehash_call],
    [CAL, ALL[1].iso, JOHN, 'new', 15, true],
  );
});

test('the pre-booking re-check reads the same rep and offers call times 30 minutes out', async () => {
  const seen = [];
  const r = await recheckSlot({ calendarId: CAL, startIso: ALL[1].iso, nowMs: NOW, userId: JOHN, noticeMs: 30 * 60_000 }, {
    fetchFreeSlots: async (cal, opts) => { seen.push(opts.userId); return { slots: [ALL[0], ALL[2]] }; },
  });
  assert.deepEqual(seen, [JOHN]);
  assert.equal(r.open, false);
  assert.ok(r.alternatives.some(s => s.iso === ALL[0].iso), 'today 2 PM is 2h out: offered for a call');
});

test('the rehash prompt lets the reply name times only when real ones were read', () => {
  const off = postDemoRehash('John').join('\n');
  const on = postDemoRehash('John', { callTimes: true }).join('\n');
  assert.match(off, /You cannot see a calendar/);
  assert.doesNotMatch(on, /You cannot see a calendar/);
  assert.match(on, /REAL open call times/);
});
