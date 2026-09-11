/**
 * Tests — Bot Review outcomes pure core (Phase 0)
 * scripts/test-bot-outcomes-core.js
 *
 * Uses the Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-bot-outcomes-core.js
 *
 * Pure-function tests — no DB, no network. Guards the three windows (reply 24h,
 * booking 7d, opt-out 24h), the whole-word STOP match, and the rule that an
 * outcome computed against a stale HL cache is never finalized.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isOptOutText,
  hasDncTag,
  findFirstReply,
  findFirstBooking,
  findOptOut,
  isSourceFresh,
  isWindowClosed,
  computeOutcome,
} from '../src/bot-feedback/outcomes-core.js';

const SENT = '2026-09-01T12:00:00.000Z';
const at = (hours) => new Date(Date.parse(SENT) + hours * 3600 * 1000).toISOString();

// ─── STOP family ────────────────────────────────────────────────────

test('isOptOutText matches the STOP family on whole words', () => {
  for (const t of ['STOP', 'stop', 'Please unsubscribe', 'remove me from your list', 'do not contact me', 'opt out', 'opt-out']) {
    assert.equal(isOptOutText(t), true, `missed: ${t}`);
  }
});

test('isOptOutText does not fire on words that merely contain a stop word', () => {
  // The whole point of the \b anchors: these are ordinary replies, not opt-outs.
  for (const t of ['I stopped by the showroom', 'nonstop rain here', 'I cancelled my other quote', 'stopwatch']) {
    assert.equal(isOptOutText(t), false, `false positive: ${t}`);
  }
  assert.equal(isOptOutText(null), false);
  assert.equal(isOptOutText(''), false);
});

test('hasDncTag recognises the DNC family, case-insensitively', () => {
  assert.equal(hasDncTag(['agentic-active', 'DNC']), true);
  assert.equal(hasDncTag(['stage:dnc']), true);
  assert.equal(hasDncTag(['do-not-contact']), true);
  assert.equal(hasDncTag(['unsubscribed']), true);
  assert.equal(hasDncTag(['agentic-active', 'entry:calculator']), false);
  assert.equal(hasDncTag(null), false);
});

// ─── reply window ───────────────────────────────────────────────────

test('findFirstReply takes the earliest inbound inside 24h', () => {
  const messages = [
    { direction: 'inbound', sent_at: at(5) },
    { direction: 'inbound', sent_at: at(2) },
    { direction: 'outbound', sent_at: at(1) },
  ];
  assert.equal(findFirstReply(messages, SENT), at(2));
});

test('findFirstReply ignores the inbound we were replying to', () => {
  // Same millisecond as our send = the trigger, not a reply. Strictly after.
  assert.equal(findFirstReply([{ direction: 'inbound', sent_at: SENT }], SENT), null);
  assert.equal(findFirstReply([{ direction: 'inbound', sent_at: at(-1) }], SENT), null);
});

test('findFirstReply ignores outbound messages and anything past 24h', () => {
  assert.equal(findFirstReply([{ direction: 'outbound', sent_at: at(1) }], SENT), null);
  assert.equal(findFirstReply([{ direction: 'inbound', sent_at: at(25) }], SENT), null);
  assert.equal(findFirstReply([{ direction: 'inbound', sent_at: at(24) }], SENT), at(24), 'the boundary itself counts');
});

test('findFirstReply falls back to created_at and survives junk timestamps', () => {
  assert.equal(findFirstReply([{ direction: 'inbound', created_at: at(3) }], SENT), at(3));
  assert.equal(findFirstReply([{ direction: 'inbound', sent_at: 'not a date' }], SENT), null);
  assert.equal(findFirstReply(null, SENT), null);
  assert.equal(findFirstReply([], 'not a date'), null);
});

// ─── booking window ─────────────────────────────────────────────────

test('findFirstBooking keys on GHL dateAdded, not the cache row birthday', () => {
  const appts = [
    { raw_json: { dateAdded: at(48) }, created_at: at(100) },
    { raw_json: { dateAdded: at(10) }, created_at: at(100) },
  ];
  assert.equal(findFirstBooking(appts, SENT), at(10));
});

test('findFirstBooking falls back to created_at when dateAdded is absent', () => {
  assert.equal(findFirstBooking([{ created_at: at(12) }], SENT), at(12));
});

test('findFirstBooking honours the 7-day window and skips deleted rows', () => {
  assert.equal(findFirstBooking([{ raw_json: { dateAdded: at(24 * 8) } }], SENT), null);
  assert.equal(findFirstBooking([{ raw_json: { dateAdded: at(24 * 7) } }], SENT), at(24 * 7));
  assert.equal(findFirstBooking([{ raw_json: { dateAdded: at(2) }, deleted_at: at(3) }], SENT), null);
});

// ─── opt-out ────────────────────────────────────────────────────────

test('findOptOut matches a STOP-family inbound inside 24h', () => {
  const messages = [
    { direction: 'inbound', body: 'sounds good', sent_at: at(1) },
    { direction: 'inbound', body: 'STOP', sent_at: at(3) },
  ];
  assert.equal(findOptOut(messages, null, SENT), at(3));
});

test('findOptOut counts a DNC tag only when the contact changed inside the window', () => {
  const dncNow = { tags: ['dnc'], date_updated: at(2) };
  const dncLastYear = { tags: ['dnc'], date_updated: at(-24 * 300) };
  assert.equal(findOptOut([], dncNow, SENT), at(2));
  assert.equal(findOptOut([], dncLastYear, SENT), null, 'an old DNC tag is not this reply’s doing');
});

test('findOptOut returns null for an ordinary conversation', () => {
  assert.equal(findOptOut([{ direction: 'inbound', body: 'yes please', sent_at: at(1) }], null, SENT), null);
});

// ─── freshness + finality ───────────────────────────────────────────

test('isSourceFresh requires every entity to be inside the 2h bound', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const ago = (mins) => new Date(now - mins * 60000).toISOString();
  assert.equal(isSourceFresh({ messages: ago(10), appointments: ago(30) }, now), true);
  assert.equal(isSourceFresh({ messages: ago(10), appointments: ago(200) }, now), false);
  assert.equal(isSourceFresh({ messages: ago(10), appointments: null }, now), false, 'unknown is never fresh');
  assert.equal(isSourceFresh({}, now), false, 'no entities is never fresh');
});

test('isWindowClosed is true only once 7 days have passed', () => {
  assert.equal(isWindowClosed(SENT, Date.parse(at(24 * 6))), false);
  assert.equal(isWindowClosed(SENT, Date.parse(at(24 * 7 + 1))), true);
  assert.equal(isWindowClosed('not a date', Date.now()), false);
});

// ─── computeOutcome ─────────────────────────────────────────────────

test('computeOutcome fills all three signals and marks final once settled', () => {
  const now = Date.parse(at(24 * 8));
  const row = computeOutcome({
    context: { message_type: 'reply', message_ref: '4711', ghl_contact_id: 'abc', sent_at: SENT },
    messages: [{ direction: 'inbound', body: 'yes please', sent_at: at(2) }],
    appointments: [{ raw_json: { dateAdded: at(30) } }],
    sourceFresh: true,
    now,
  });
  assert.equal(row.replied_at, at(2));
  assert.equal(row.booked_at, at(30));
  assert.equal(row.opted_out_at, null);
  assert.equal(row.source_fresh, true);
  assert.equal(row.final, true);
});

test('computeOutcome NEVER finalizes against a stale cache', () => {
  // A final row is never recomputed, so finalizing on a stale read would
  // freeze a wrong answer forever. Both conditions, never one.
  const row = computeOutcome({
    context: { message_type: 'reply', message_ref: '4712', sent_at: SENT },
    messages: [],
    appointments: [],
    sourceFresh: false,
    now: Date.parse(at(24 * 9)),
  });
  assert.equal(row.final, false);
  assert.equal(row.source_fresh, false);
});

test('computeOutcome leaves an open window not final even when the cache is fresh', () => {
  const row = computeOutcome({
    context: { message_type: 'reply', message_ref: '4713', sent_at: SENT },
    messages: [],
    appointments: [],
    sourceFresh: true,
    now: Date.parse(at(24 * 2)),
  });
  assert.equal(row.final, false);
});

test('computeOutcome returns null when there is no sent_at to measure from', () => {
  assert.equal(computeOutcome({ context: { message_type: 'reply', message_ref: '1', sent_at: null } }), null);
});
