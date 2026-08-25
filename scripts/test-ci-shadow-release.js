/**
 * Tests — shadow mode must not silently spend a call's one chance to write
 * scripts/test-ci-shadow-release.js
 *
 * THE DEFECT. claimSync inserts the ci_syncs row — carrying its
 * UNIQUE(idempotency_key) — BEFORE it knows whether the write will go out. That
 * ordering is what makes idempotency structural instead of a check with a race
 * in it, and it is right. But it means SHADOW mode holds the key too: a call
 * processed while CALL_INTEL_LP_WRITES is false composes its note, stores the
 * body, marks the row 'shadow', and permanently spends that call's opportunity.
 * Turning the flag on later delivers nothing for it — claimSync hits the
 * constraint and returns `duplicate`, forever.
 *
 * Measured 2026-08-25: 82 such rows, every one tier 'high', every one carrying
 * a composed note_body, every one on a call already 'completed'. 82 finished
 * summaries that could never reach a customer record, growing by ~12 an hour.
 *
 * ── WHY RELEASING THESE IS SAFE ────────────────────────────────────────────
 * The proof is STRUCTURAL, not statistical. In syncToLp,
 * `status: live ? 'pending' : 'shadow'` decides the row and the very next
 * statement is `if (!live) return`. A 'shadow' row is one whose code path
 * RETURNED BEFORE lpClient.addNote existed — not "probably didn't call", but
 * "the function returned first". No request means no note means no double-post.
 *
 * That is stronger than either sibling repair (one trusts an error string, the
 * other a live LP read), and it is the only reason this path may touch rows
 * without reading LP. Which makes the filter's narrowness the whole safety
 * story, and every test below a fence around it.
 *
 * Pure planners only — no network, no DB.
 *
 * Run: node --test scripts/test-ci-shadow-release.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyShadowRow, planShadowRelease, planParentResume,
  PARENT_RESUME_PATCH, releaseShadowSyncs, RELEASABLE_TARGETS,
} from '../src/ci/shadow-release.js';

/** A genuine shadow row, shaped like ci_syncs. */
const row = (over = {}) => ({
  id: 'sync-1',
  call_id: '13a24c9e-6eb9-4ff1-8827-6e554468ea3e',
  target: 'lp',
  status: 'shadow',
  external_ref: null,
  response: null,
  note_body: '[AI CALL NOTE | …]',
  ...over,
});

// ─── the one case that may be released ──────────────────────────────────────

test('a genuine shadow row is released', () => {
  const v = classifyShadowRow(row());
  assert.equal(v.releasable, true);
  assert.match(v.reason, /returned before the request/);
});

// ─── and everything that is not one ─────────────────────────────────────────

test('THE GUARD: a row that reached the API is refused, whatever its status says', () => {
  // The early-return proof covers 'shadow' and nothing else. These rows made a
  // request, so a re-send could put a second note on a customer's record.
  for (const status of ['synced', 'sent_unconfirmed', 'pending', 'failed', 'skipped']) {
    const v = classifyShadowRow(row({ status }));
    assert.equal(v.releasable, false, `wrongly released a '${status}' row`);
    assert.match(v.reason, /no-request proof does not apply/);
  }
});

test('THE GUARD: a "shadow" row carrying a CRM response is not a shadow row', () => {
  // Shadow returns before any request, so a response cannot exist. If one does,
  // the row is something we do not understand — and an unexplained row is
  // exactly what must not be deleted.
  const v = classifyShadowRow(row({ response: { shape: 'string' } }));
  assert.equal(v.releasable, false);
  assert.match(v.reason, /not what it says it is/);
});

test('THE GUARD: a "shadow" row carrying an external_ref is refused', () => {
  const v = classifyShadowRow(row({ external_ref: '2238213' }));
  assert.equal(v.releasable, false);
  assert.match(v.reason, /a CRM identified a note/);
});

test('GHL rows are refused while the target is lp — and vice versa', () => {
  // 177 ghl:shadow rows carry the same burn, but CALL_INTEL_GHL_WRITES is
  // false: releasing them would re-run the sync, hit shadow again and burn a
  // fresh key for nothing. They are released when GHL writes are turned on.
  assert.equal(classifyShadowRow(row({ target: 'ghl' }), 'lp').releasable, false);
  assert.equal(classifyShadowRow(row({ target: 'lp' }), 'ghl').releasable, false);
  assert.equal(classifyShadowRow(row({ target: 'ghl' }), 'ghl').releasable, true);
  assert.deepEqual(RELEASABLE_TARGETS, ['lp', 'ghl']);
});

// ─── the plan ───────────────────────────────────────────────────────────────

test('planShadowRelease splits every row and loses none', () => {
  const rows = [
    row({ id: 'a' }),
    row({ id: 'b', status: 'synced' }),
    row({ id: 'c', response: {} }),
    row({ id: 'd', target: 'ghl' }),
  ];
  const { release, refuse } = planShadowRelease(rows, 'lp');
  assert.deepEqual(release.map((r) => r.row.id), ['a']);
  assert.equal(release.length + refuse.length, rows.length);
});

test('an empty read releases nothing rather than everything', () => {
  assert.deepEqual(planShadowRelease([]).release, []);
  assert.deepEqual(planShadowRelease(undefined).release, []);
});

// ─── the parent calls ───────────────────────────────────────────────────────

test('only calls whose key was released come back to matched', () => {
  const calls = [
    { id: 'c1', status: 'completed' },
    { id: 'c2', status: 'completed' },  // key not touched — none of our business
    { id: 'c3', status: 'review' },
    { id: 'c4', status: 'transcribed' }, // mid-pipeline — shoving it back redoes work
  ];
  const resume = planParentResume(calls, ['c1', 'c3', 'c4']);
  assert.deepEqual(resume.map((c) => c.id), ['c1', 'c3']);
});

test('the resume clears the lease and the retry timer, not just the status', () => {
  // A call put back to 'matched' while still holding a lease is invisible to
  // the claimer until the lease expires — it would look repaired and do nothing.
  assert.equal(PARENT_RESUME_PATCH.status, 'matched');
  assert.equal(PARENT_RESUME_PATCH.locked_until, null);
  assert.equal(PARENT_RESUME_PATCH.locked_by, null);
  assert.equal(PARENT_RESUME_PATCH.next_retry_at, null);
  assert.equal(PARENT_RESUME_PATCH.attempts, 0);
});

// ─── the run ────────────────────────────────────────────────────────────────

/** ci_syncs / ci_calls double recording every delete and update. */
function fakeDb(syncRows, calls = []) {
  const deletes = [];
  const updates = [];
  const events = [];
  return {
    deletes, updates, events,
    from(table) {
      if (table === 'ci_events') return { insert: async (r) => { events.push(r); return { error: null }; } };
      if (table === 'ci_calls') {
        const chain = {
          select() { return chain; },
          in: async () => ({ data: calls, error: null }),
          update(patch) { return { eq: async (_c, id) => { updates.push({ id, patch }); return { error: null }; } }; },
        };
        return chain;
      }
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        limit: async () => ({ data: syncRows, error: null }),
        delete() {
          const d = {
            _id: null,
            eq(col, v) { if (col === 'id') d._id = v; return d; },
            is() { return d; },
            select: async () => {
              const r = syncRows.find((x) => x.id === d._id);
              // Mirror the real delete's re-assertion: a row that moved since
              // the plan matches nothing.
              const ok = r && r.status === 'shadow' && r.external_ref == null && r.response == null;
              if (ok) deletes.push(d._id);
              return { data: ok ? [{ id: d._id }] : [], error: null };
            },
          };
          return d;
        },
      };
      return chain;
    },
  };
}

test('DRY-RUN is the default and writes nothing', async () => {
  const db = fakeDb([row()], [{ id: row().call_id, status: 'completed' }]);
  const r = await releaseShadowSyncs({ db });
  assert.equal(r.execute, false);
  assert.equal(r.releasable, 1);
  assert.equal(r.released, 0);
  assert.equal(db.deletes.length, 0, 'a dry run that writes is not a dry run');
  assert.equal(db.updates.length, 0);
});

test('executing releases the key, audits it, and puts the call back to matched', async () => {
  const r0 = row();
  const db = fakeDb([r0], [{ id: r0.call_id, status: 'completed' }]);
  const r = await releaseShadowSyncs({ db, execute: true });
  assert.equal(r.released, 1);
  assert.equal(r.resumed, 1);
  assert.deepEqual(db.deletes, ['sync-1']);
  assert.equal(db.updates[0].patch.status, 'matched');

  // The row is gone; the fact is not.
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event, 'key_released');
  assert.equal(db.events[0].stage, 'sync');
  assert.match(db.events[0].detail.note, /returns before the request/);
});

test('a refused row is reported, never quietly dropped', async () => {
  const db = fakeDb([row({ id: 'bad', status: 'synced' })]);
  const r = await releaseShadowSyncs({ db, execute: true });
  assert.equal(r.released, 0);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].sync_id, 'bad');
  assert.equal(db.deletes.length, 0);
});

test('a row that turned into a real send between plan and delete is left alone', async () => {
  // The read that classified the row and the delete are separate statements.
  // The delete re-asserts its conditions, so a concurrent real sync survives.
  const r0 = row();
  const db = fakeDb([r0], [{ id: r0.call_id, status: 'completed' }]);
  // Mutate only AFTER the plan has read the row, so this exercises the delete's
  // re-assertion rather than the planner's filter.
  const original = db.from;
  let syncReads = 0;
  db.from = (t) => {
    if (t === 'ci_syncs' && syncReads++ > 0) r0.status = 'synced'; // a worker got there first
    return original.call(db, t);
  };
  const r = await releaseShadowSyncs({ db, execute: true });
  assert.equal(r.released, 0);
  assert.equal(db.deletes.length, 0, 'deleting this would erase the record of a note that went out');
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].error, /changed underneath/);
});

test('an unknown target is refused outright, not silently coerced', async () => {
  await assert.rejects(() => releaseShadowSyncs({ db: fakeDb([]), target: 'salesforce' }), /unknown target/);
});
