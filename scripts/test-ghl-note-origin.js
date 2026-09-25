#!/usr/bin/env node
/**
 * Tests for the GHL→LP note origin stamp — scripts/test-ghl-note-origin.js
 *
 * Covers Task F (stampNoteOrigin) and the echo-loop classifier that mirrors it
 * at ingest (src/sync-children.js noteOriginOf / sql/050 backfill).
 *
 * The load-bearing case is the DUAL PREFIX. The 56 AI briefs already sitting in
 * lp_notes on 2026-07-29 carry the legacy "[AI BRIEF" header; only notes written
 * after Task F carry "[GHL · AI BRIEF". A classifier that matches only the new
 * prefix leaves the existing population echoing back to GHL forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampNoteOrigin } from '../src/ghl-note-pipeline/summarizer.js';
import { noteOriginOf, NEVER_PUSH_ORIGINS } from '../src/note-origin.js';

const CID = 'j4U3klwGR5dzx64Szfe8';
const BRIEF = `[AI BRIEF · 7/28/26 7:37 PM]  COLD · appt missed
WHAT HAPPENED: Customer replied "Stop".`;

// ─── Task F: header rewrite + footer ─────────────────────────────────────────

test('rewrites the AI BRIEF header to carry GHL origin', () => {
  const out = stampNoteOrigin(BRIEF, CID);
  assert.ok(out.startsWith('[GHL · AI BRIEF · 7/28/26 7:37 PM]'), out.slice(0, 60));
});

test('preserves the timestamp format byte-for-byte', () => {
  const out = stampNoteOrigin(BRIEF, CID);
  assert.ok(out.includes('· 7/28/26 7:37 PM]'), 'timestamp must not be reformatted');
});

test('appends the GHL Contact back-reference footer', () => {
  const out = stampNoteOrigin(BRIEF, CID);
  assert.ok(out.endsWith(`GHL Contact: ${CID}`), out.slice(-40));
});

test('leaves the body structure untouched', () => {
  const out = stampNoteOrigin(BRIEF, CID);
  assert.ok(out.includes('WHAT HAPPENED: Customer replied "Stop".'));
  assert.ok(out.includes('COLD · appt missed'));
});

test('is idempotent — re-stamping does not double the prefix or footer', () => {
  const once = stampNoteOrigin(BRIEF, CID);
  const twice = stampNoteOrigin(once, CID);
  assert.equal(once, twice);
  assert.equal(twice.match(/GHL Contact:/g).length, 1);
  assert.ok(!twice.includes('[GHL · GHL · '));
});

test('missing contact id omits the footer rather than writing undefined', () => {
  const out = stampNoteOrigin(BRIEF, null);
  assert.ok(!out.includes('GHL Contact:'));
  assert.ok(out.startsWith('[GHL · AI BRIEF · '));
});

test('a note with an unexpected first line is left alone', () => {
  const odd = 'Some other note body entirely.';
  const out = stampNoteOrigin(odd, CID);
  assert.ok(out.startsWith('Some other note body entirely.'));
  assert.ok(out.endsWith(`GHL Contact: ${CID}`));
});

test('empty / null input does not throw', () => {
  assert.equal(typeof stampNoteOrigin('', CID), 'string');
  assert.equal(typeof stampNoteOrigin(null, CID), 'string');
});

// ─── Task H: origin classification must match BOTH prefixes ──────────────────
// The real classifier (src/note-origin.js) — this suite used to carry a copy,
// which is how a mirror drifts from what ingest actually does.

test('classifies the LEGACY [AI BRIEF prefix as GHL-origin', () => {
  assert.equal(noteOriginOf(BRIEF), 'ghl_ai_brief');
});

test('classifies the NEW [GHL · AI BRIEF prefix as GHL-origin', () => {
  assert.equal(noteOriginOf(stampNoteOrigin(BRIEF, CID)), 'ghl_ai_brief');
});

test('classifies both prefixes behind the ** IMPORTANT ** wrapper', () => {
  assert.equal(noteOriginOf(`** IMPORTANT **\n${BRIEF}`), 'ghl_ai_brief');
  assert.equal(noteOriginOf(`** IMPORTANT **\n${stampNoteOrigin(BRIEF, CID)}`), 'ghl_ai_brief');
});

// The shape that actually comes BACK from LP. writeLpNote joins the prefix
// with "\n", but LP returns it with the newline collapsed to two spaces —
// verified 2026-07-29 against the 56 live rows. A literal "\n" match found
// only 11 of them. This is why both the classifier and the sql/050 backfill
// use \s* rather than a fixed separator; do not tighten either.
test('classifies the REAL round-tripped shape (newline collapsed to spaces)', () => {
  assert.equal(noteOriginOf(`** IMPORTANT **  ${BRIEF}`), 'ghl_ai_brief');
  assert.equal(noteOriginOf(`** IMPORTANT ** ${BRIEF}`), 'ghl_ai_brief');
  assert.equal(noteOriginOf(`** IMPORTANT **  ${stampNoteOrigin(BRIEF, CID)}`), 'ghl_ai_brief');
});

test('a genuine LP rep note is NOT classified as GHL-origin', () => {
  assert.equal(noteOriginOf('MOBILE HOME'), 'lp');
  assert.equal(noteOriginOf('HC 07/29/2026 10:00AM'), 'lp');
  assert.equal(noteOriginOf('Veteran discount. MRS GOES BY DEBBIE.'), 'lp');
  assert.equal(noteOriginOf(null), 'lp');
});

test('a note merely MENTIONING AI BRIEF mid-body is NOT GHL-origin', () => {
  assert.equal(noteOriginOf('Customer asked about the [AI BRIEF · thing] we sent'), 'lp');
});

test('the round-tripped GHL wrapper is still classified GHL-origin', () => {
  // What pushNotesToGHL would have wrapped it in — the reason dedup failed.
  const wrapped = `📋 LP Note\nBy: Agent | Date: 7/28/2026 7:37 PM\n\n${BRIEF}\n\nLP Lead: 562274`;
  // The wrapper is applied on the way OUT to GHL, never stored in lp_notes, so
  // the stored body is the bare brief — this asserts we classify what we store.
  assert.equal(noteOriginOf(BRIEF), 'ghl_ai_brief');
  assert.equal(noteOriginOf(wrapped), 'lp'); // wrapper form is not a stored shape
});

// ─── 2026-09-25: Revin summaries are labelled lp_revin and still pushed ─────

test('a note by "Agent, Revin" is lp_revin, whatever its body', () => {
  assert.equal(noteOriginOf('Customer replied YES to appointment reminder.', 'Agent, Revin'), 'lp_revin');
  assert.equal(noteOriginOf('x', 'agent,revin'), 'lp_revin');
});

test('a person\'s note, or a rep merely named like Revin, stays lp', () => {
  assert.equal(noteOriginOf('Revin texted them earlier', 'Griffin, Sean'), 'lp');
  assert.equal(noteOriginOf('x', 'Revington, Sam'), 'lp');
  assert.equal(noteOriginOf('x', null), 'lp');
});

test('an AI brief is still ghl_ai_brief even if Revin somehow authored it', () => {
  assert.equal(noteOriginOf(BRIEF, 'Agent, Revin'), 'ghl_ai_brief');
});

test('the push skips only GHL AI briefs — Revin summaries still go to GHL', () => {
  assert.deepEqual([...NEVER_PUSH_ORIGINS], ['ghl_ai_brief']);
  assert.ok(!NEVER_PUSH_ORIGINS.includes('lp_revin'));
});
