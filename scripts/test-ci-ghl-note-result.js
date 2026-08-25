/**
 * Tests — a GHL note that was NOT written must not record as 'synced'
 * scripts/test-ci-ghl-note-result.js
 *
 * THE BUG THIS LOCKS OUT. addGHLNote does not signal failure by throwing. It
 * returns four different things (src/ghl.js):
 *
 *   data object          the note was written
 *   {skipped:true,...}   an identical note is already on the contact
 *   'not_found'          the contact is unreachable — PERMANENT, never retry
 *   null                 GHL disabled, empty body, or a transient failure
 *
 * syncToGhl called markSynced unconditionally on all four. A deleted contact
 * and a GHL outage both wrote status='synced' with a null external_ref —
 * byte-identical to a delivered note. Nothing retried, nothing alerted, and the
 * review queue stayed empty while notes went nowhere.
 *
 * It is the same shape as the missing-client default: a non-exception result
 * meaning "no write happened", read as "write happened". That one was invisible
 * because no test ran the production path; this one is invisible because
 * `null` and a note id are both just "whatever addGHLNote returned".
 *
 * ── WHY A DUPLICATE COUNTS AS DELIVERED ────────────────────────────────────
 * The note IS on the contact — ghl.js's dedupe guard only stopped a second
 * copy. Calling that a failure would retry forever against a guard designed to
 * keep winning, and would eventually park a perfectly noted call in review.
 *
 * No network, no DB double for the classifier — it is pure.
 *
 * Run: node --test scripts/test-ci-ghl-note-result.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyGhlNoteResult, syncToGhl, markSyncFailed } from '../src/ci/sync.js';
import { parseConfig } from '../src/ci/config.js';

const LIVE_GHL = parseConfig({
  CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true', CALL_INTEL_GHL_WRITES: 'true',
});

const CALL = {
  id: 'b7f72a34-69ca-4821-bc11-1cebed849d54',
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

const MATCH = { tier: 'high', ghl_contact_id: 'ghl-contact-1', evidence: { note_target: {} } };

/** ci_syncs double honouring UNIQUE(idempotency_key), recording every patch. */
function fakeDb() {
  const rows = [];
  const patches = [];
  return {
    rows,
    patches,
    row: () => rows[0],
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        limit() { return chain; },
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
              patches.push({ patch, id: v });
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

const ghlReturning = (value) => ({ addGHLNote: async () => value });

// ─── the classifier ─────────────────────────────────────────────────────────

test('a real note payload is delivered, and its id becomes the external_ref', () => {
  assert.deepEqual(classifyGhlNoteResult({ id: 'note-1' }), { delivered: true, externalRef: 'note-1' });
  assert.deepEqual(classifyGhlNoteResult({ note: { id: 'note-2' } }), { delivered: true, externalRef: 'note-2' });
  // A bare success marker with no id is still a delivery.
  assert.deepEqual(classifyGhlNoteResult({ success: true }), { delivered: true, externalRef: null });
});

test("'not_found' is a PERMANENT failure — and is tested before truthiness", () => {
  // The trap: 'not_found' is a truthy string, so any `if (resp)` check reads it
  // as a delivered note. ghl.js's own header warns about exactly this.
  const v = classifyGhlNoteResult('not_found');
  assert.equal(v.delivered, false);
  assert.equal(v.permanent, true);
  assert.equal(v.reason, 'contact_not_found');
});

test('null is a TRANSIENT failure — retry, do not give up', () => {
  const v = classifyGhlNoteResult(null);
  assert.equal(v.delivered, false);
  assert.equal(v.permanent, false);
  assert.equal(v.reason, 'ghl_unavailable');
  assert.deepEqual(classifyGhlNoteResult(undefined), v, 'undefined must not read as delivered either');
});

test('a deduped note IS delivered — it is already on the contact', () => {
  const v = classifyGhlNoteResult({ skipped: true, reason: 'duplicate_note', matched_note_id: 'note-9' });
  assert.equal(v.delivered, true);
  assert.equal(v.reason, 'duplicate_note');
  assert.equal(v.externalRef, 'note-9');
});

// ─── what the write site records ────────────────────────────────────────────

test("a dead contact does NOT record as synced, and does NOT retry", async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_GHL, ghlClient: ghlReturning('not_found'),
  });

  assert.equal(r.synced, undefined, 'this is the bug: a missing contact used to report synced');
  assert.equal(r.failed, true);
  assert.equal(r.terminal, true, 'permanent — retrying cannot conjure the contact');
  assert.equal(r.reason, 'contact_not_found');
  assert.equal(db.row().status, 'failed');
  assert.notEqual(db.row().status, 'synced');
  assert.match(String(db.row().error), /not found/i);
});

test('a GHL outage records a RETRYABLE failure, not a delivered note', async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_GHL, ghlClient: ghlReturning(null),
  });

  assert.equal(r.synced, undefined);
  assert.equal(r.failed, true);
  assert.equal(r.terminal, false, 'an outage is temporary — it must come back around');
  assert.equal(r.reason, 'ghl_unavailable');
  assert.equal(db.row().status, 'pending', 'pending is what makes the worker retry it');
  assert.equal(db.row().attempts, 1);
});

test('a written note records synced with its id', async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_GHL, ghlClient: ghlReturning({ id: 'note-77' }),
  });
  assert.equal(r.synced, true);
  assert.equal(db.row().status, 'synced');
  assert.equal(db.row().external_ref, 'note-77');
});

test('a duplicate records synced, tagged so it reads honestly', async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_GHL, ghlClient: ghlReturning({ skipped: true, reason: 'duplicate_note', matched_note_id: 'note-3' }),
  });
  assert.equal(r.synced, true);
  assert.equal(r.reason, 'duplicate_note');
  assert.equal(db.row().status, 'synced');
  assert.equal(db.row().external_ref, 'note-3');
});

test('a THROWN error still behaves exactly as before', async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_GHL, ghlClient: { addGHLNote: async () => { throw new Error('GHL 500'); } },
  });
  assert.equal(r.failed, true);
  assert.equal(r.terminal, false);
  assert.match(r.error, /GHL 500/);
  assert.equal(db.row().status, 'pending');
});

// ─── shadow mode is untouched ───────────────────────────────────────────────

test('shadow still calls no client at all, whatever the client would return', async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH, {
    db,
    cfg: parseConfig({}),
    ghlClient: { addGHLNote: async () => { throw new Error('called in shadow — THIS IS A LIVE WRITE'); } },
  });
  assert.equal(r.shadow, true);
  assert.equal(db.row().status, 'shadow');
});

// ─── the permanent flag on markSyncFailed ───────────────────────────────────

test('permanent goes terminal on attempt 1; ordinary failures keep their budget', async () => {
  const cfg = parseConfig({ CALL_INTEL_MAX_ATTEMPTS: '5' });
  const db = fakeDb();
  db.rows.push({ id: 'sync-1', attempts: 0 });

  const ordinary = await markSyncFailed(db, { id: 'sync-1', attempts: 0 }, new Error('boom'), cfg);
  assert.equal(ordinary.terminal, false);
  assert.equal(ordinary.attempts, 1);

  const permanent = await markSyncFailed(db, { id: 'sync-1', attempts: 0 }, new Error('gone'), cfg, { permanent: true });
  assert.equal(permanent.terminal, true, 'no point spending five attempts on a contact that does not exist');
  assert.equal(permanent.attempts, 1);
});
