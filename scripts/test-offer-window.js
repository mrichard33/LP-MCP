/**
 * Offer-window selection tests — scripts/test-offer-window.js
 *
 * Locks in the v1.1 48-hour offer window (2026-07-24 Engelke incident):
 *   1. Standard window trims a wide (14-day) list to the next 48 hours.
 *   2. A lead-requested far date passes through (the only >48h path).
 *   3. A vague / non-day preference does NOT unlock the far path.
 *   4. The minimum-notice floor discards imminent slots.
 *   5. Nothing open in 48h → escalation with the true hours-out.
 *   6. Nothing bookable after the floor → window 'none'.
 *   7. buildOfferWindowPrompt copy per window.
 *
 * Pure-function tests — no DB, no network. Slots are built relative to
 * Date.now() so the assertions hold whenever the suite runs.
 *
 * Run: node --test scripts/test-offer-window.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-key';
process.env.REECE_TIMEZONE = 'America/New_York';
process.env.BOOKING_OFFER_WINDOW_HOURS = '48';
process.env.BOOKING_MIN_NOTICE_HOURS = '4';
process.env.BOOKING_ESCALATION_LADDER = '48,72,96,168';

const {
  selectOfferableSlots,
  buildOfferWindowPrompt,
} = await import('../src/knowledge/calendar-availability.js');

const TZ = 'America/New_York';
const HOUR = 3600_000;
const slotAt = (hoursFromNow) => ({ iso: new Date(Date.now() + hoursFromNow * HOUR).toISOString() });
const civilDate = (iso) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const avail = (slots) => ({ slots, calendar_id: 'CAL_TEST', timezone: TZ, slots_total_count: slots.length });
const maxMsWithin = (slots, hours) => slots.every((s) => new Date(s.iso).getTime() <= Date.now() + hours * HOUR);

// ─── 1. Standard window trims a 14-day list to 48h ─────────────────────

test('standard window keeps only slots inside 48h and caps at 2', () => {
  const a = avail([slotAt(5), slotAt(30), slotAt(47), slotAt(72), slotAt(240)]);
  const sel = selectOfferableSlots(a, null);
  assert.equal(sel.window, 'standard_48h');
  assert.equal(sel.slots.length, 2);
  assert.ok(maxMsWithin(sel.slots, 48), 'no offered slot beyond 48h');
  assert.equal(sel.preferred_honored, false);
  // formatter-facing pool count reflects all in-window slots (3), not the 2 shown.
  assert.equal(sel.availability.slots_total_count, 3);
});

// ─── 2. Lead-requested far date passes through ─────────────────────────

test('a lead-requested far date is offered even though it is beyond 48h', () => {
  const far = slotAt(240); // 10 days out
  const preferred = { date_iso: civilDate(far.iso), specificity: 'day_only', raw: 'that day' };
  const sel = selectOfferableSlots(avail([slotAt(5), far]), preferred);
  assert.equal(sel.window, 'lead_requested');
  assert.equal(sel.preferred_honored, true);
  assert.equal(civilDate(sel.slots[0].iso), preferred.date_iso);
});

// ─── 3. Vague / non-day preference does NOT unlock the far path ────────

test('a non-day preference does not unlock the far path (falls to escalated)', () => {
  const far = slotAt(240);
  const preferred = { date_iso: civilDate(far.iso), specificity: 'time_only', raw: '3 pm' };
  // Only far slots exist → without the day unlock this must escalate, not lead_requested.
  const sel = selectOfferableSlots(avail([far, slotAt(260)]), preferred);
  assert.notEqual(sel.window, 'lead_requested');
  assert.equal(sel.window, 'escalated');
});

test('null preference with far-only slots escalates', () => {
  const sel = selectOfferableSlots(avail([slotAt(100), slotAt(150)]), null);
  assert.equal(sel.window, 'escalated');
});

// ─── 4. Minimum-notice floor discards imminent slots ───────────────────

test('slots inside the min-notice floor are never offered', () => {
  const sel = selectOfferableSlots(avail([slotAt(1), slotAt(6), slotAt(30)]), null);
  assert.equal(sel.window, 'standard_48h');
  assert.ok(sel.slots.every((s) => new Date(s.iso).getTime() >= Date.now() + 4 * HOUR), 'no slot inside 4h floor');
  assert.equal(sel.slots.length, 2);
});

// ─── 5. Empty 48h → escalation with true hours-out ─────────────────────

test('nothing open in 48h escalates and reports hours out', () => {
  const sel = selectOfferableSlots(avail([slotAt(100), slotAt(150)]), null);
  assert.equal(sel.window, 'escalated');
  assert.ok(sel.escalated_to_hours >= 99 && sel.escalated_to_hours <= 101, `hours out ~100, got ${sel.escalated_to_hours}`);
  assert.ok(sel.slots.length >= 1);
});

// ─── 6. Nothing bookable after the floor → 'none' ──────────────────────

test('only sub-floor slots yield window none', () => {
  const sel = selectOfferableSlots(avail([slotAt(1), slotAt(2)]), null);
  assert.equal(sel.window, 'none');
  assert.equal(sel.slots.length, 0);
});

test('null availability yields window none', () => {
  const sel = selectOfferableSlots(null, null);
  assert.equal(sel.window, 'none');
});

// ─── 7. buildOfferWindowPrompt copy ────────────────────────────────────

test('offer-window prompt copy per window', () => {
  assert.match(buildOfferWindowPrompt({ window: 'standard_48h' }), /next 48 hours/);
  assert.match(
    buildOfferWindowPrompt({ window: 'escalated', escalated_to_hours: 100 }),
    /100 hours out[\s\S]*next two days are full/,
  );
  assert.match(
    buildOfferWindowPrompt({ window: 'lead_requested' }, { raw: 'Monday at 3 PM' }),
    /Monday at 3 PM/,
  );
  assert.equal(buildOfferWindowPrompt({ window: 'none' }), null);
  assert.equal(buildOfferWindowPrompt(null), null);
});
