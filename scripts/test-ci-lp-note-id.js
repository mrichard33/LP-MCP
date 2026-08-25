/**
 * Tests — LP hands back NO note id, and the code no longer pretends otherwise
 * scripts/test-ci-lp-note-id.js
 *
 * THE ANSWER, MEASURED. /api/SalesApi/AddNotes replies with the bare string
 *
 *     "UPDATED SUCCESSFULLY!"
 *
 * and nothing else. No id, no digits. That is every live note written since
 * 2026-08-24 — a single distinct response template across all of them,
 * recorded by shapeOf's digit-masked instrumentation.
 *
 * This closes a question that had been open since 2026-07-29, when
 * lp_note_id came back NULL on all 131 rows the GHL note pipeline had written
 * and nothing captured WHY. Two things were true at once:
 *
 *   1. the extractor was broken — lpPost returns `await res.json()`, so a bare
 *      JSON string arrives as a STRING, and every lookup (`resp.note_id`,
 *      `resp.noteId`, `resp.id`, `resp.message`) misses on a string; and
 *   2. even repaired, there was never an id in the payload to find.
 *
 * (1) was fixed first, which is what made (2) provable.
 *
 * ── SO THE CI WRITE SITE RECORDS NULL ON PURPOSE ───────────────────────────
 * syncToLp no longer runs an extractor over the LP response. A permanent
 * no-op that reads like a capability is worse than an honest null: the next
 * person to look would assume external_ref is sometimes populated for LP and
 * build something on it.
 *
 * A NULL external_ref is an ABSENT ID, never an unconfirmed delivery — addNote
 * throws on any non-2xx, so reaching markSynced means LP accepted the write.
 * Conflating the two would be how a delivered note gets retried, and a retry
 * after a landed write double-posts.
 *
 * The real LP note id does exist; it simply arrives later, on the notes mirror
 * (lp_notes.lp_note_id — 2238213 for one of the 08-24 notes). That is the join
 * for an audit, not this column.
 *
 * No network, no DB double for the extractor — it is pure.
 *
 * Run: node --test scripts/test-ci-lp-note-id.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { syncToLp, shapeOf, ACK_TEMPLATE_MAX } from '../src/ci/sync.js';
import { extractNoteId } from '../src/ghl-note-pipeline/lp-write.js';
import { parseConfig } from '../src/ci/config.js';

/** LP's actual acknowledgment, verbatim from ci_syncs.response. */
const LP_ACK = 'UPDATED SUCCESSFULLY!';

const LIVE_LP = parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true' });

const CALL = {
  id: '8fff91b7-ed35-4adb-8f00-bb049d154bd8',
  five9_call_id: '300000010259758',
  call_start: '2026-08-24T21:55:00.000Z',
  direction: 'Outbound',
  agent_name: 'John Manieri',
  team: 'reece',
};

const SUMMARY = {
  output: {
    summary: 'The agent confirmed the appointment.',
    outcome: 'appointment_confirmed',
    key_details: [],
    follow_up: { required: false },
  },
};

const MATCH = { tier: 'high', evidence: { note_target: { rectype: 'cst', recid: 452742 } } };

/** ci_syncs double that records the patch written back to the row. */
function fakeDb() {
  const rows = [];
  return {
    rows,
    row: () => rows[0],
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert(row) {
          const api = {
            select: () => api,
            maybeSingle: async () => {
              const stored = { id: `sync-${rows.length + 1}`, attempts: 0, ...row };
              rows.push(stored);
              return { data: stored, error: null };
            },
            then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
          };
          return api;
        },
        update(patch) {
          return {
            eq(_c, v) {
              const row = rows.find((r) => r.id === v);
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
        then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

// ─── what LP actually returns ───────────────────────────────────────────────

test('LP\'s acknowledgment carries no digits at all — there is no id to extract', () => {
  assert.equal(/\d/.test(LP_ACK), false, 'if this ever fails, LP changed its response — revisit');
  // Even the extractor that still exists for the legacy "...: <id>" shape
  // finds nothing in it, which is the correct answer rather than a miss.
  assert.equal(extractNoteId(LP_ACK), null);
});

test('a successful LP note records external_ref NULL, by design', async () => {
  const db = fakeDb();
  const r = await syncToLp(CALL, SUMMARY, MATCH, {
    db,
    cfg: LIVE_LP,
    lpClient: { addNote: async () => LP_ACK },
  });

  assert.equal(r.synced, true);
  assert.equal(db.row().status, 'synced');
  assert.equal(db.row().external_ref, null, 'LP returns no id — null is the honest record');
  assert.equal(db.row().error, null);
});

test('a NULL external_ref is an absent id, NOT an unconfirmed delivery', async () => {
  // The distinction that matters: addNote throws on any non-2xx, so reaching
  // markSynced means LP accepted the write. Reading null as "not delivered"
  // is what would retry a landed note and double-post it.
  const db = fakeDb();
  const r = await syncToLp(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_LP, lpClient: { addNote: async () => LP_ACK },
  });
  assert.equal(r.failed, undefined);
  assert.equal(db.row().status, 'synced');
  assert.ok(db.row().synced_at, 'the delivery timestamp is the receipt, not the id');
});

test('the write site runs no extractor over the LP response any more', () => {
  // A permanent no-op that reads like a capability is worse than an honest
  // null — the next reader would assume external_ref is sometimes populated
  // for LP and build on it.
  const src = syncToLp.toString();
  assert.equal(/extractLpNoteId|idFromAck/.test(src), false,
    'LP note-id extraction was removed once LP was proven to return no id');
  assert.match(src, /externalRef:\s*null/, 'the null must be explicit at the write site');
});

// ─── the instrumentation that proved it, and still guards it ────────────────

test('shapeOf records the acknowledgment as a digit-masked template', () => {
  const s = shapeOf(LP_ACK);
  assert.deepEqual(s, { shape: 'string', length: 21, template: 'UPDATED SUCCESSFULLY!' });
  assert.equal(/\d/.test(s.template), false, 'no digit may survive into stored data');
});

test('an id-bearing response would still be visible if LP ever changed', () => {
  // The template is what would surface a change: digits mask to '#', so a new
  // format shows up as a different template in ci_syncs.response without ever
  // storing the id itself.
  const s = shapeOf('Notes added: 442119');
  assert.equal(s.template, 'Notes added: ######');
  assert.notEqual(s.template, shapeOf(LP_ACK).template, 'a format change must be visible');
});

test('a long string is measured but NOT templated', () => {
  // The guard against ever storing a note body: notes run ~1,000–1,600 bytes.
  const body = `[AI CALL NOTE | ${'x'.repeat(2000)}]`;
  const s = shapeOf(body);
  assert.equal(s.length, body.length);
  assert.equal(s.template, undefined);
  assert.ok(ACK_TEMPLATE_MAX < 200);
});

// ─── the sibling pipeline still extracts, for the endpoints that do carry ids ─

test('lp-write\'s extractor still reads the legacy "...: <id>" shape', () => {
  // Kept because AddLead-style acknowledgments DO carry an id
  // ("lead added: <in1_id>"), and because it must never invent one from prose.
  assert.equal(extractNoteId('Notes added: 442119'), '442119');
  assert.equal(extractNoteId('442119'), '442119');
  assert.equal(extractNoteId({ note_id: 442119 }), '442119');
  assert.equal(extractNoteId('Notes added for recid 452742'), null, 'a recid is not a note id');
  assert.equal(extractNoteId(LP_ACK), null);
});
