/**
 * Unit coverage for src/agentic/rep-note.js — the path that turns the lead's
 * answer to the competitor decider, the Reveal, or the mistrust "what
 * happened?" into a note on the GHL contact (2026-09-23).
 *
 * The field is null on almost every turn. The two things that must never
 * happen are a stray non-string becoming a note, and a note being queued
 * with no contact to write it to.
 *
 * Run: node --test scripts/test-rep-note-capture.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRepNote, buildRepNoteAction, REP_NOTE_MAX_CHARS, REP_NOTE_RULE,
} from '../src/agentic/rep-note.js';

test('a real answer survives, whitespace collapsed', () => {
  assert.equal(normalizeRepNote('  Decider:   the warranty\n and who installs  '), 'Decider: the warranty and who installs');
});

test('null, empty, placeholders and non-strings are not notes', () => {
  for (const v of [null, undefined, '', '   ', 'null', 'None', 'n/a', 42, { note: 'x' }, ['x'], true]) {
    assert.equal(normalizeRepNote(v), null, `${JSON.stringify(v)} became a note`);
  }
});

test('a runaway field is capped before it reaches GHL', () => {
  const out = normalizeRepNote('Reveal: ' + 'x'.repeat(1000));
  assert.equal(out.length, REP_NOTE_MAX_CHARS);
  assert.ok(out.endsWith('…'));
});

test('the action is an ordinary add_note, approval-free, on the contact', () => {
  const a = buildRepNoteAction({ repNote: 'Reveal: wants to talk about the sliding door', contactId: 'c1', eventId: 'e1' });
  assert.equal(a.action_type, 'add_note');
  assert.equal(a.target_system, 'ghl');
  assert.equal(a.target_id, 'c1');
  assert.equal(a.event_id, 'e1');
  assert.equal(a.requires_approval, false);
  assert.equal(a.status, 'pending');
  assert.equal(a.rule_applied, REP_NOTE_RULE);
  assert.equal(a.action_payload.note, 'Chatbot, lead said: Reveal: wants to talk about the sliding door');
});

test('no note, or no contact, means no action', () => {
  assert.equal(buildRepNoteAction({ repNote: null, contactId: 'c1' }), null);
  assert.equal(buildRepNoteAction({ repNote: 'Decider: price', contactId: null }), null);
  assert.equal(buildRepNoteAction({ repNote: 'Decider: price', contactId: 'c1' }).event_id, null);
});
