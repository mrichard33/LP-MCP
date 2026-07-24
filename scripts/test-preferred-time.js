/**
 * Preferred-time capture / match / prompt tests —
 * scripts/test-preferred-time.js
 *
 * Locks in the v1.1 contract (2026-07-24 Engelke incident):
 *   1. Relative weekdays resolve FORWARD in REECE_TIMEZONE (Friday→"Monday"
 *      = the next Monday, never today).
 *   2. Explicit "August 2nd 10am" parses to date + time.
 *   3. Bot acceptance is detected on OUTBOUND turns only, and only when an
 *      acceptance marker co-occurs with a day/time token.
 *   4. specificity classification: day_and_time / day_only / time_only.
 *   5. Vague input ("sometime next week", "whenever") → null (no preference).
 *   6. Weekday resolution is DST-safe across the 2026-11-01 fall-back.
 *   7. matchPreferredToSlots: exact / same_day / nearest / gap_days.
 *   8. formatPreferredTimeForPrompt: walk-back only when a bot-accepted time
 *      is no longer available.
 *
 * Pure-function tests — no DB, no network, no LLM.
 *
 * Run: node --test scripts/test-preferred-time.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-key';
process.env.REECE_TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';

const {
  extractPreferredTime,
  matchPreferredToSlots,
  formatPreferredTimeForPrompt,
} = await import('../src/services/preferred-time.js');

// 2026-07-24 is a Friday; noon ET.
const FRIDAY = new Date('2026-07-24T16:00:00Z');
const inbound = (text) => [{ direction: 'inbound', text }];

// ─── 1. Friday → "Monday" = the next Monday ────────────────────────────

test('Friday "Monday at 3 pm" resolves to the next Monday', () => {
  const p = extractPreferredTime(inbound('Can we schedule for Monday at 3 pm'), { now: FRIDAY });
  assert.ok(p, 'should extract');
  assert.equal(p.date_iso, '2026-07-27');
  assert.equal(p.weekday, 'monday');
  assert.equal(p.time_24h, '15:00');
  assert.equal(p.specificity, 'day_and_time');
  assert.equal(p.source, 'inbound');
});

// ─── 2. "August 2nd 10am" ──────────────────────────────────────────────

test('"August 2nd 10am" parses to date + time', () => {
  const p = extractPreferredTime(inbound('August 2nd 10am works for me'), { now: FRIDAY });
  assert.ok(p);
  assert.equal(p.date_iso, '2026-08-02');
  assert.equal(p.time_24h, '10:00');
  assert.equal(p.specificity, 'day_and_time');
});

// ─── 3. Bot acceptance detected on outbound only ───────────────────────

test('bot acceptance is captured on an outbound turn with an acceptance marker', () => {
  const p = extractPreferredTime(
    [{ direction: 'outbound', text: 'Monday at 3 PM works great, Michael.' }],
    { now: FRIDAY },
  );
  assert.ok(p);
  assert.equal(p.source, 'bot_accepted');
  assert.equal(p.date_iso, '2026-07-27');
});

test('an outbound turn WITHOUT an acceptance marker is not captured', () => {
  const p = extractPreferredTime(
    [{ direction: 'outbound', text: 'Our soonest openings are Sunday at 10 AM or Wednesday at 2 PM.' }],
    { now: FRIDAY },
  );
  assert.equal(p, null);
});

test('inbound wins as source over a plain (non-accepting) outbound', () => {
  const p = extractPreferredTime(
    [
      { direction: 'inbound', text: 'Monday at 3 pm please' },
      { direction: 'outbound', text: 'Let me check the calendar for you.' },
    ],
    { now: FRIDAY },
  );
  assert.ok(p);
  assert.equal(p.source, 'inbound');
  assert.equal(p.date_iso, '2026-07-27');
});

// ─── 4. specificity classification ─────────────────────────────────────

test('specificity: day_only for a weekday with no clock time', () => {
  const p = extractPreferredTime(inbound('tuesday works'), { now: FRIDAY });
  assert.ok(p);
  assert.equal(p.weekday, 'tuesday');
  assert.equal(p.date_iso, '2026-07-28');
  assert.equal(p.specificity, 'day_only');
  assert.equal(p.time_24h, null);
});

test('specificity: time_only for a bare clock time', () => {
  const p = extractPreferredTime(inbound('3 pm'), { now: FRIDAY });
  assert.ok(p);
  assert.equal(p.date_iso, null);
  assert.equal(p.time_24h, '15:00');
  assert.equal(p.specificity, 'time_only');
});

// ─── 5. Vague input → null ─────────────────────────────────────────────

test('vague "sometime next week" is not a preference', () => {
  assert.equal(extractPreferredTime(inbound('sometime next week'), { now: FRIDAY }), null);
});

test('vague "whenever works" is not a preference', () => {
  assert.equal(extractPreferredTime(inbound('whenever works for you'), { now: FRIDAY }), null);
});

// ─── 6. DST-safe across the 2026-11-01 fall-back ───────────────────────

test('weekday resolution is DST-safe across the Nov 1 2026 fall-back', () => {
  // 2026-10-30 is a Friday; "Monday" lands on 2026-11-02, crossing the DST
  // boundary. The noon-anchored civil-date math must not slip a day.
  const preDst = new Date('2026-10-30T16:00:00Z');
  const p = extractPreferredTime(inbound('Monday at 2 pm'), { now: preDst });
  assert.ok(p);
  assert.equal(p.date_iso, '2026-11-02');
  assert.equal(p.weekday, 'monday');
});

// ─── 7. matchPreferredToSlots ──────────────────────────────────────────

test('matchPreferredToSlots finds exact / same_day / nearest', () => {
  const preferred = extractPreferredTime(inbound('Monday at 3 pm'), { now: FRIDAY });
  const availability = {
    timezone: 'America/New_York',
    slots: [
      { iso: '2026-07-27T15:00:00-04:00' }, // Mon 3:00 PM — exact
      { iso: '2026-07-27T17:00:00-04:00' }, // Mon 5:00 PM — same day
      { iso: '2026-07-29T10:00:00-04:00' }, // Wed
    ],
  };
  const m = matchPreferredToSlots(preferred, availability);
  assert.equal(m.exact.iso, '2026-07-27T15:00:00-04:00');
  assert.equal(m.same_day.iso, '2026-07-27T15:00:00-04:00');
  assert.equal(m.nearest.iso, '2026-07-27T15:00:00-04:00');
  assert.equal(m.gap_days, 0);
});

test('matchPreferredToSlots reports gap_days when the requested day is closed', () => {
  const preferred = extractPreferredTime(inbound('August 2nd 10am'), { now: FRIDAY });
  const availability = {
    timezone: 'America/New_York',
    slots: [
      { iso: '2026-08-05T14:00:00-04:00' }, // Wed Aug 5 — 3 days after Aug 2
      { iso: '2026-08-06T10:00:00-04:00' },
    ],
  };
  const m = matchPreferredToSlots(preferred, availability);
  assert.equal(m.exact, null);
  assert.equal(m.same_day, null);
  assert.equal(m.nearest.iso, '2026-08-05T14:00:00-04:00');
  assert.equal(m.gap_days, 3);
});

// ─── 8. formatPreferredTimeForPrompt ───────────────────────────────────

test('walk-back fires when a bot-accepted time is no longer available', () => {
  const preferred = extractPreferredTime(
    [{ direction: 'outbound', text: 'Monday at 3 PM works great' }],
    { now: FRIDAY },
  );
  const match = { exact: null, same_day: null, nearest: { iso: '2026-08-05T14:00:00-04:00' }, gap_days: 9 };
  const block = formatPreferredTimeForPrompt(preferred, match);
  assert.ok(block, 'should produce a block');
  assert.match(block, /walking back a commitment/);
  assert.match(block, /NOT AVAILABLE/);
});

test('no walk-back when the accepted time is still available', () => {
  const preferred = extractPreferredTime(
    [{ direction: 'outbound', text: 'Monday at 3 PM works great' }],
    { now: FRIDAY },
  );
  const match = { exact: { iso: '2026-07-27T15:00:00-04:00' }, same_day: { iso: '2026-07-27T15:00:00-04:00' }, nearest: null, gap_days: 0 };
  const block = formatPreferredTimeForPrompt(preferred, match);
  assert.equal(block, null);
});

test('null preferred yields a null prompt block', () => {
  assert.equal(formatPreferredTimeForPrompt(null, null), null);
});
