/**
 * Tests — LP note-id extraction from a STRING acknowledgment
 * scripts/test-ci-lp-note-id.js
 *
 * THE BUG THIS LOCKS OUT. lpPost returns `await res.json()`, and LP's AddNotes
 * answers with a bare JSON string — so `resp` is a STRING, not an object. Both
 * extractors walked `resp.note_id` / `resp.noteId` / `resp.id` (all undefined
 * on a string) and then fell back to `resp.message`, which a string does not
 * have either. The one branch that could have matched an id never saw the
 * payload, so EVERY note ever written recorded a null id:
 *
 *   - ci_syncs.external_ref: null on all 5 of the first live AI call notes
 *   - lp_notes.lp_note_id:   null on all 131 rows (recorded 2026-07-29)
 *
 * The shape was logged faithfully the whole time — `string` — and nobody could
 * tell "LP hands back no id" from "our extractor is wrong". That is the
 * ambiguity these tests close.
 *
 * ── WHY THE MATCH IS ANCHORED, NOT "THE TRAILING NUMBER" ───────────────────
 * The obvious rule is wrong against prose. LP's exact acknowledgment string is
 * not recorded anywhere — the repo, the docs and the retained logs all keep the
 * shape and discard the content (§10) — so the extractor must be safe against
 * every plausible format, including ones that end in a number that is NOT a
 * note id. `Notes added for recid 452742` would put a CUSTOMER RECORD ID in
 * external_ref, labelled as a note id, and nothing downstream would flag it.
 * Null is honest. A plausible wrong id is not.
 *
 * No network, no DB — both extractors are pure.
 *
 * Run: node --test scripts/test-ci-lp-note-id.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLpNoteId, shapeOf, ACK_TEMPLATE_MAX } from '../src/ci/sync.js';
import { extractNoteId } from '../src/ghl-note-pipeline/lp-write.js';

/** Both mirrors, so every case below is asserted against each. */
const EXTRACTORS = [
  ['ci/sync.js extractLpNoteId', extractLpNoteId],
  ['ghl-note-pipeline/lp-write.js extractNoteId', extractNoteId],
];

const each = (name, fn) => {
  for (const [label, extract] of EXTRACTORS) test(`${name} — ${label}`, () => fn(extract));
};

// ─── the fix: a string response ─────────────────────────────────────────────

each('a bare numeric string IS the note id', (extract) => {
  assert.equal(extract('442119'), '442119');
  assert.equal(extract('  442119  '), '442119', 'whitespace must not defeat it');
});

each('the documented "...: <id>" acknowledgment yields the id', (extract) => {
  assert.equal(extract('Notes added: 442119'), '442119');
  assert.equal(extract('Note added successfully: 442119'), '442119');
  assert.equal(extract('note_id=442119'), '442119');
  assert.equal(extract('Added #442119'), '442119');
});

each('an acknowledgment with NO id yields null, not a guess', (extract) => {
  assert.equal(extract('Success'), null);
  assert.equal(extract('Notes added successfully'), null);
  assert.equal(extract(''), null);
  assert.equal(extract('   '), null);
});

// ─── the reason the match is anchored ───────────────────────────────────────

each('prose ending in a RECID does not become a note id', (extract) => {
  // The whole point. A bare /(\d+)\s*$/ returns '452742' for every one of
  // these, and external_ref would then hold a customer record id.
  assert.equal(extract('Notes added for recid 452742'), null);
  assert.equal(extract('Note attached to cst 452742'), null);
  assert.equal(extract('Added note to lead 566628'), null);
});

// ─── the object paths still work exactly as before ──────────────────────────

each('a structured response is read by key, in priority order', (extract) => {
  assert.equal(extract({ note_id: 442119 }), '442119');
  assert.equal(extract({ noteId: 442119 }), '442119');
  assert.equal(extract({ id: 442119 }), '442119');
  assert.equal(extract({ note_id: 1, noteId: 2, id: 3 }), '1', 'note_id wins');
  assert.equal(extract({ message: 'Notes added: 442119' }), '442119');
  assert.equal(extract({ message: 'Success' }), null);
  assert.equal(extract({ status: 'ok' }), null);
});

each('null, undefined and empty stay null', (extract) => {
  assert.equal(extract(null), null);
  assert.equal(extract(undefined), null);
  assert.equal(extract(0), null);
  assert.equal(extract(''), null);
});

// ─── the two mirrors must not drift ─────────────────────────────────────────

test('both extractors agree on every input, character for character', () => {
  // sync.js calls itself a mirror of lp-write.js. Two copies that disagree are
  // worse than one: the same LP response would produce a note id in one
  // pipeline and null in the other, and nothing would say why.
  const inputs = [
    '442119', ' 442119 ', 'Notes added: 442119', 'note_id=442119', 'Added #442119',
    'Success', 'Notes added successfully', 'Notes added for recid 452742', '', '   ',
    null, undefined, 0, 17, true,
    { note_id: 1 }, { noteId: 2 }, { id: 3 }, { message: 'x: 9' }, { message: 'x 9' }, {},
  ];
  for (const input of inputs) {
    assert.equal(
      extractLpNoteId(input), extractNoteId(input),
      `mirrors disagree on ${JSON.stringify(input) ?? String(input)}`,
    );
  }
});

// ─── the instrumentation that answers the open question ─────────────────────

test('a string response records a DIGIT-MASKED template, never the digits', () => {
  const s = shapeOf('Notes added: 442119');
  assert.equal(s.shape, 'string');
  assert.equal(s.length, 19);
  assert.equal(s.template, 'Notes added: ######');
  assert.equal(/\d/.test(s.template), false, 'no digit may survive into stored data');
});

test('a long string is measured but NOT templated', () => {
  // The guard against ever storing a note body: a composed note is ~1,000–1,600
  // bytes, an order of magnitude past this cap, so it can never be templated
  // even if LP started echoing the body back.
  const body = `[AI CALL NOTE | ${'x'.repeat(2000)}]`;
  const s = shapeOf(body);
  assert.equal(s.shape, 'string');
  assert.equal(s.length, body.length);
  assert.equal(s.template, undefined, 'a note-sized string must never be templated');
  assert.ok(ACK_TEMPLATE_MAX < 200, 'the cap must stay far below a note body');
});

test('object and null responses are described exactly as before', () => {
  assert.deepEqual(shapeOf(null), { shape: 'null' });
  assert.deepEqual(shapeOf(undefined), { shape: 'null' });
  assert.deepEqual(shapeOf({ a: 1, b: 2 }), { shape: 'object', keys: ['a', 'b'] });
  assert.deepEqual(shapeOf(17), { shape: 'number' });
});

// ─── what this would have produced for the five live notes ──────────────────

test('a null id is still recorded as a successful sync, not a failure', () => {
  // addNote throws on a non-2xx, so reaching extraction at all means LP accepted
  // the write. The id is an audit convenience; its absence must never be read as
  // a failed delivery — that reading is what would send a delivered note back
  // for a retry, and a retry after a landed write double-posts.
  assert.equal(extractLpNoteId('Success'), null);
  assert.deepEqual(shapeOf('Success'), { shape: 'string', length: 7, template: 'Success' });
});
