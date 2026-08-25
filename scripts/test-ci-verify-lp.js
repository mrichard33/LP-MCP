/**
 * Tests — a note is delivered when we have SEEN it, and not one moment sooner
 * scripts/test-ci-verify-lp.js
 *
 * THE DEFECT. /api/SalesApi/AddNotes answers every write with the constant
 * string "UPDATED SUCCESSFULLY!" — byte-identical whether the note landed on
 * the record or vanished. `synced` used to be written on the strength of that
 * non-throw, so on 2026-08-24, 286 rows recorded delivery over four hours and
 * nothing in the database could say which of them a rep could actually read.
 *
 * The fix has two halves and both are asserted here:
 *   1. syncToLp records 'sent_unconfirmed' — sent, not proven.
 *   2. verifyPendingLpNotes reads the note back out of LP and promotes it,
 *      picking up the real lp_note_id AddNotes refuses to return.
 *
 * ── THE ONE RULE THAT MUST NEVER REGRESS ───────────────────────────────────
 * UNKNOWN IS NOT ABSENT. If the LP read fails we change NOTHING — not the
 * status, not the attempt count. Treating "we could not ask" as "it is not
 * there" releases the idempotency key on a note that may have landed, and the
 * retry puts a second note on a customer's record. Several tests below exist
 * only to hold that line.
 *
 * No network, no DB, no fake timers — the LP reader is a function and `now` is
 * injected, the house convention.
 *
 * Run: node --test scripts/test-ci-verify-lp.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readVerifyEnv, groupByProspect, summarise, verdictOf, verifyPendingLpNotes, UNCONFIRMED,
} from '../src/ci/verify.js';
import { collectLpNotes, findCiNote, markerFor, readProspect } from '../src/ci/lp-readback.js';
import { syncToLp } from '../src/ci/sync.js';
import { parseConfig } from '../src/ci/config.js';

const CALL_ID = '13a24c9e-6eb9-4ff1-8827-6e554468ea3e';
const MARKER = '[AI-CI:13a24c9e';
const OTHER_CALL = '99999999-0000-4000-8000-000000000000';

/** A note body shaped like the real thing, ending in the provenance marker. */
const noteFor = (callId, five9 = '300000010262436') =>
  `[AI CALL NOTE | 08/19 2:07 PM ET | inbound | Agent: Shari Walker (lightfire) | Outcome: Appointment rescheduled]\n`
  + `The customer confirmed the appointment.\n`
  + `[AI-CI:${String(callId).replace(/-/g, '').slice(0, 8)} | Five9 ${five9} | AI-generated from call recording — verify commitments before acting]`;

/** A GetLead prospect payload: notes on the person, notes on each inquiry. */
function prospectWith({ prospectNotes = [], leadNotes = {} } = {}) {
  return {
    id: '244594',
    notes: prospectNotes,
    leads: Object.entries(leadNotes).map(([lds, notes]) => ({ id: lds, notes })),
  };
}

// ─── reading the LP payload ─────────────────────────────────────────────────

test('collectLpNotes tags which SIDE each note is attached to', () => {
  // The distinction the incident turned on: "in LP" and "where a rep reads"
  // are different facts, and a checker that only asked "found?" would have
  // called 2026-08-24 a success.
  const p = prospectWith({
    prospectNotes: [{ id: '1', note: 'on the person' }],
    leadNotes: { 300757: [{ id: '2', note: 'on the inquiry' }] },
  });
  const notes = collectLpNotes(p);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.side).sort(), ['lead', 'prospect']);
  assert.equal(notes.find((n) => n.side === 'lead').ldsId, '300757');
});

test('a bare STRING note still carries the marker and is not skipped', () => {
  // LP returns note arrays that sometimes hold strings rather than objects
  // (see safeNotes in src/safe-notes.js). Skipping those for lacking an id
  // would report a delivered note as missing.
  const p = prospectWith({ prospectNotes: [noteFor(CALL_ID)] });
  assert.equal(findCiNote(p, CALL_ID).found, true);
});

test('the marker is matched, never the timestamp', () => {
  // LP returns `enteredon` as a naive Eastern string that lpDateToEastern tags
  // '+00:00', so every lp_notes.created_at_lp is 4–5 hours early. Correlating
  // by time would inherit that skew; the marker is ours and cannot drift.
  assert.equal(markerFor(CALL_ID), MARKER);
  const p = prospectWith({ prospectNotes: [{ id: '9', note: noteFor(CALL_ID), enteredon: '2026-08-24T20:12:03.02' }] });
  const hit = findCiNote(p, CALL_ID);
  assert.equal(hit.found, true);
  assert.equal(hit.lpNoteId, '9');
});

test('another call\'s note is not this call\'s note', () => {
  const p = prospectWith({ prospectNotes: [noteFor(OTHER_CALL)] });
  assert.equal(findCiNote(p, CALL_ID).found, false);
});

test('a prospect-side copy is reported over a lead-side one, and both are counted', () => {
  const p = prospectWith({
    prospectNotes: [{ id: 'P', note: noteFor(CALL_ID) }],
    leadNotes: { 300757: [{ id: 'L', note: noteFor(CALL_ID) }] },
  });
  const hit = findCiNote(p, CALL_ID);
  assert.equal(hit.side, 'prospect');
  assert.equal(hit.lpNoteId, 'P');
  assert.equal(hit.copies, 2, 'the duplicate must stay visible');
});

test('readProspect keeps "could not ask" distinct from "not there"', async () => {
  const failed = await readProspect(1, { lpReader: async () => { throw new Error('ETIMEDOUT'); } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ETIMEDOUT/);

  const absent = await readProspect(1, { lpReader: async () => [] });
  assert.equal(absent.ok, true, 'LP answered — it simply has no such prospect');
  assert.equal(absent.prospect, null);
});

// ─── the write site no longer claims delivery ───────────────────────────────

const LIVE_LP = parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true' });

const CALL = {
  id: CALL_ID,
  five9_call_id: '300000010262436',
  call_start: '2026-08-24T21:55:00.000Z',
  direction: 'Outbound',
  agent_name: 'John Manieri',
  team: 'reece',
};
const SUMMARY = { output: { summary: 'Confirmed.', outcome: 'appointment_confirmed', key_details: [], follow_up: { required: false } } };
const MATCH = { tier: 'high', evidence: { note_target: { rectype: 'cst', recid: 244594 } } };

/** ci_syncs double recording the patch written back to the row. */
function fakeDb(seed = []) {
  const rows = [...seed];
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

test('THE FIX: a successful LP write records sent_unconfirmed, not synced', async () => {
  const db = fakeDb();
  const r = await syncToLp(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_LP, lpClient: { addNote: async () => 'UPDATED SUCCESSFULLY!' },
  });
  assert.equal(r.sent, true);
  assert.equal(r.confirmed, false);
  assert.equal(db.row().status, UNCONFIRMED, 'a constant acknowledgment is not a receipt');
  assert.ok(db.row().synced_at, 'when it went out is still recorded');
  assert.equal(db.row().error, null);
});

test('the write site no longer calls markSynced for LP at all', () => {
  // The regression that would quietly restore the defect: one edit putting
  // markSynced back and every note reports delivered again on a non-throw.
  const src = syncToLp.toString();
  assert.match(src, /markSentUnconfirmed/);
  assert.equal(/markSynced\(/.test(src), false, 'only the read-back may mark an LP note synced');
});

test('a failed LP write is still a failure, not an unconfirmed one', async () => {
  const db = fakeDb();
  const r = await syncToLp(CALL, SUMMARY, MATCH, {
    db, cfg: LIVE_LP, lpClient: { addNote: async () => { throw new Error('HTTP 500'); } },
  });
  assert.equal(r.failed, true);
  assert.notEqual(db.row().status, UNCONFIRMED);
});

// ─── the sweep ──────────────────────────────────────────────────────────────

const SETTLED = '2026-08-25T00:00:00.000Z';   // older than the delay
const NOW = new Date('2026-08-25T01:00:00.000Z');

/**
 * A ci_syncs double for the sweep: serves loadSyncRows' two reads and records
 * every update, so a test can assert what did NOT change as easily as what did.
 */
function sweepDb(syncRows, matchRows) {
  const updates = [];
  return {
    updates,
    from(table) {
      if (table === 'ci_syncs') {
        const chain = {
          _rows: syncRows,
          select() { return chain; },
          eq() { return chain; },
          lt() { return chain; },
          order() { return chain; },
          update(patch) {
            return { eq(_c, id) { return { eq() { updates.push({ id, patch }); return Promise.resolve({ error: null }); } }; } };
          },
          then: (res, rej) => Promise.resolve({ data: chain._rows, error: null }).then(res, rej),
        };
        return chain;
      }
      const chain = {
        select() { return chain; },
        in: async () => ({ data: matchRows, error: null }),
      };
      return chain;
    },
  };
}

const syncRow = (over = {}) => ({
  id: 'sync-1', call_id: CALL_ID, status: UNCONFIRMED, synced_at: SETTLED,
  created_at: SETTLED, external_ref: null, verify_attempts: 0,
  ci_calls: { lp_cst_id: '244594', five9_call_id: '300000010262436' },
  ...over,
});
const matchRow = (rectype = 'cst', recid = 244594) => ({ call_id: CALL_ID, evidence: { note_target: { rectype, recid } } });

test('a note FOUND in LP is promoted, and captures the id AddNotes never returns', async () => {
  const db = sweepDb([syncRow()], [matchRow()]);
  const stats = await verifyPendingLpNotes({
    db, now: () => NOW,
    lpReader: async () => [prospectWith({ prospectNotes: [{ id: '2238213', note: noteFor(CALL_ID) }] })],
  });
  assert.equal(stats.verified, 1);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0].patch.status, 'synced');
  assert.equal(db.updates[0].patch.external_ref, '2238213', 'the real lp_note_id, recovered on read-back');
  assert.ok(db.updates[0].patch.verified_at);
});

test('THE RULE: a FAILED read changes nothing — not the status, not the attempts', async () => {
  // Unknown is not absent. Burning an attempt here would fail delivered notes
  // during an LP outage, and releasing their keys would double-post.
  const db = sweepDb([syncRow()], [matchRow()]);
  const stats = await verifyPendingLpNotes({
    db, now: () => NOW,
    lpReader: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(stats.unread, 1);
  assert.equal(stats.missing, 0);
  assert.equal(stats.verified, 0);
  assert.equal(db.updates.length, 0, 'not one field may move on a read we could not make');
});

test('a SUCCESSFUL read that lacks the note counts a miss, and retries first', async () => {
  const db = sweepDb([syncRow()], [matchRow()]);
  const stats = await verifyPendingLpNotes({
    db, now: () => NOW,
    lpReader: async () => [prospectWith({ prospectNotes: [{ id: 'x', note: 'someone else\'s note' }] })],
  });
  assert.equal(stats.missing, 1);
  assert.equal(stats.failed, 0, 'one absent read is not a verdict');
  assert.equal(db.updates[0].patch.status, UNCONFIRMED);
  assert.equal(db.updates[0].patch.verify_attempts, 1);
});

test('after maxAttempts absent reads it FAILS the row and alerts', async () => {
  const db = sweepDb([syncRow({ verify_attempts: 2 })], [matchRow()]);
  const alerts = [];
  const stats = await verifyPendingLpNotes({
    db, now: () => NOW,
    lpReader: async () => [prospectWith()],
    alert: async (kind, text) => { alerts.push({ kind, text }); },
  });
  assert.equal(stats.failed, 1);
  assert.equal(db.updates[0].patch.status, 'failed');
  assert.match(db.updates[0].patch.error, /not_present_in_lp/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'ci_note_not_in_lp');
});

test('a note found on the LEAD is still promoted — delivered is delivered', async () => {
  // It IS in LP; it is simply not where a rep reads. Failing it would be a
  // second lie in the opposite direction. The warning is what surfaces it, and
  // the note-target fix is what stops it happening.
  const db = sweepDb([syncRow()], [matchRow('ils', 568072)]);
  const stats = await verifyPendingLpNotes({
    db, now: () => NOW,
    lpReader: async () => [prospectWith({ leadNotes: { 568072: [{ id: 'L1', note: noteFor(CALL_ID) }] } })],
  });
  assert.equal(stats.verified, 1);
  assert.equal(db.updates[0].patch.external_ref, 'L1');
});

test('rows that have not settled yet are not claimed', async () => {
  // loadSyncRows filters by synced_at < now - delayMs; the double records the
  // bound rather than applying it, so assert the cutoff is actually passed.
  let cutoff = null;
  const db = sweepDb([], []);
  const inner = db.from('ci_syncs');
  inner.lt = (_col, v) => { cutoff = v; return inner; };
  const stats = await verifyPendingLpNotes({
    db: { from: (t) => (t === 'ci_syncs' ? inner : db.from(t)) },
    now: () => NOW,
    env: { CI_VERIFY_DELAY_MS: '600000' },
    lpReader: async () => [],
  });
  assert.equal(stats.checked, 0);
  assert.equal(cutoff, '2026-08-25T00:50:00.000Z', 'ten minutes before now');
});

test('several notes on ONE prospect cost ONE LP read', async () => {
  const second = '77777777-0000-4000-8000-000000000000';
  const db = sweepDb(
    [syncRow(), syncRow({ id: 'sync-2', call_id: second })],
    [matchRow(), { call_id: second, evidence: { note_target: { rectype: 'cst', recid: 244594 } } }],
  );
  let reads = 0;
  const stats = await verifyPendingLpNotes({
    db, now: () => NOW,
    lpReader: async () => {
      reads += 1;
      return [prospectWith({ prospectNotes: [{ id: 'A', note: noteFor(CALL_ID) }, { id: 'B', note: noteFor(second) }] })];
    },
  });
  assert.equal(reads, 1, 'GetLead returns every note on a person');
  assert.equal(stats.verified, 2);
});

test('a row with no prospect id is UNREAD, never missing', async () => {
  const db = sweepDb([syncRow({ ci_calls: { lp_cst_id: null, five9_call_id: '1' } })], [matchRow('ils', 568072)]);
  const stats = await verifyPendingLpNotes({ db, now: () => NOW, lpReader: async () => [prospectWith()] });
  assert.equal(stats.unread, 1);
  assert.equal(stats.missing, 0);
  assert.equal(db.updates.length, 0);
});

test('an idle queue makes NO LP call at all', async () => {
  // Not a micro-optimisation. The sweep runs on every worker tick and defaults
  // to the REAL getLead, so a version that read LP before checking whether it
  // had anything to verify would hit the live API from every test run that
  // happens to have credentials in its environment. That is exactly the leak
  // that had `npm test` making authenticated Five9 calls until 2026-08-25.
  const db = sweepDb([], []);
  let touched = false;
  const stats = await verifyPendingLpNotes({
    db, now: () => NOW,
    lpReader: async () => { touched = true; return []; },
  });
  assert.equal(stats.checked, 0);
  assert.equal(touched, false, 'nothing to verify must mean nothing asked');
});

test('the sweep is a no-op when disabled, and never guesses without a reader', async () => {
  const db = sweepDb([syncRow()], [matchRow()]);
  const off = await verifyPendingLpNotes({ db, now: () => NOW, env: { CI_VERIFY_ENABLED: 'false' }, lpReader: async () => [] });
  assert.equal(off.skipped, 'disabled');
  const noReader = await verifyPendingLpNotes({ db, now: () => NOW, lpReader: null });
  assert.equal(noReader.skipped, 'no_lp_reader');
  assert.equal(db.updates.length, 0);
});

// ─── the knobs ──────────────────────────────────────────────────────────────

test('verification defaults ON — it is the safety net, not an opt-in', () => {
  const d = readVerifyEnv({});
  assert.equal(d.enabled, true, 'an unset variable must not remove the check that would have caught 08-24');
  assert.equal(d.delayMs, 120000);
  assert.equal(d.maxAttempts, 3);
  assert.equal(readVerifyEnv({ CI_VERIFY_ENABLED: 'false' }).enabled, false);
});

test('nonsense and dangerous knob values fall back to the defaults', () => {
  assert.equal(readVerifyEnv({ CI_VERIFY_DELAY_MS: 'soon' }).delayMs, 120000);
  assert.equal(readVerifyEnv({ CI_VERIFY_DELAY_MS: '0' }).delayMs, 120000, 'a zero delay would read back before LP has committed');
  assert.equal(readVerifyEnv({ CI_VERIFY_MAX_ATTEMPTS: '0' }).maxAttempts, 3, 'zero attempts would fail every note on sight');
  assert.equal(readVerifyEnv({ CI_VERIFY_BATCH: '-5' }).batch, 50);
});

// ─── the audit tally, which decides the repair ──────────────────────────────

test('groupByProspect keeps an unresolvable row OUT of the work list', () => {
  const { byProspect, unresolved } = groupByProspect([
    { lp_cst_id: '1' }, { lp_cst_id: '1' }, { lp_cst_id: null, rectype: 'ils', recid: 9 },
  ]);
  assert.equal(byProspect.get('1').length, 2);
  assert.equal(unresolved.length, 1, '"never checked" must not merge into "not in LP"');
});

test('a lead-attached find is counted apart from a prospect-attached one', () => {
  const acc = summarise([
    { rectype: 'cst', read_ok: true, found: true, side: 'prospect' },
    { rectype: 'ils', read_ok: true, found: true, side: 'lead' },
    { rectype: 'ils', read_ok: true, found: false },
    { rectype: 'ils', read_ok: false },
  ]);
  assert.equal(acc.cst.found_on_prospect, 1);
  assert.equal(acc.ils.found_on_lead, 1);
  assert.equal(acc.ils.missing, 1);
  assert.equal(acc.ils.unread, 1);
  assert.equal(acc.ils.found, 1, 'an invisible note is still a delivered one');
});

test('the verdict names the visibility case rather than calling it a miss', () => {
  const v = verdictOf(summarise([
    { rectype: 'cst', read_ok: true, found: true, side: 'prospect' },
    { rectype: 'ils', read_ok: true, found: true, side: 'lead' },
  ]));
  assert.match(v, /DELIVERED BUT INVISIBLE/);
  assert.match(v, /second copy/, 'the re-send trade must be stated, not implied');
});

test('the verdict names a genuine no-op as safe to re-send', () => {
  const v = verdictOf(summarise([
    { rectype: 'cst', read_ok: true, found: true, side: 'prospect' },
    { rectype: 'ils', read_ok: true, found: false },
  ]));
  assert.match(v, /NOT DELIVERED/);
});

test('the verdict REFUSES to conclude anything from reads that all failed', () => {
  const v = verdictOf(summarise([{ rectype: 'cst', read_ok: false }, { rectype: 'ils', read_ok: false }]));
  assert.match(v, /INCONCLUSIVE/);
  assert.match(v, /no repair may act on this/);
});

test('neither rectype present stops the investigation rather than blaming rectype', () => {
  const v = verdictOf(summarise([
    { rectype: 'cst', read_ok: true, found: false },
    { rectype: 'ils', read_ok: true, found: false },
  ]));
  assert.match(v, /NEITHER rectype/);
  assert.match(v, /byte-for-byte/);
});
