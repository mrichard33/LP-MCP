/**
 * Tests — a DNC or cancellation request reaches the customer's record
 * scripts/test-ci-deferred-review.js
 *
 * WHAT WAS BROKEN. 'dnc_request' and 'cancellation_request' are raised during
 * ANALYSIS, and analysis parked the call — before matching, before sync. So
 * the two review reasons that most need to reach a rep's eyes were exactly the
 * two that never produced a note. 85 calls, measured 2026-08-25: 50
 * cancellation requests and 35 DNC requests, every one visible only inside an
 * internal queue while the customer's own record showed nothing at all. The
 * next rep to open that record has no idea the customer asked to be left
 * alone, and calls them.
 *
 * MARK'S DECISION: BOTH. Write the note, AND keep the call queued for a human.
 *
 * THE FOUR TRAPS THESE GUARD:
 *
 * 1. THE QUALITY GATE STILL WINS. A call carrying a DNC *and* an
 *    unintelligible transcript PARKS at analyze and writes nothing. A note
 *    composed from a transcript nobody could make out is not worth delivering
 *    because it also mentioned a DNC.
 * 2. A SYNC FAILURE IS STILL A SYNC FAILURE. It must not be swallowed because
 *    the call was heading to review anyway, and pending_review_reason must
 *    SURVIVE it — the write did not land, so the customer's request stays
 *    attached to the call.
 * 3. A STALE REASON PARKS AN INNOCENT CALL. stageAnalyze writes the column on
 *    every advance, null included, so a re-analysis that no longer finds the
 *    flag clears it.
 * 4. THE FLAG MUST NOT HIDE IN THE BODY. It goes in the header's outcome
 *    segment, ahead of the call's own outcome, because Key details is the line
 *    a rep skims past.
 *
 * AND THE ONE THING THAT MUST NOT HAPPEN: nothing here auto-actions anything.
 * No tag, no DNC write, no appointment cancelled. This makes the request
 * VISIBLE; acting on it stays human.
 *
 * No network, no DB — the Supabase client and the model call are doubles.
 *
 * Run: node --test scripts/test-ci-deferred-review.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeNote, formatOutcomeSegment } from '../src/ci/notes.js';
import { stageAnalyze, stageSync as stageSyncAt } from '../src/ci/worker.js';
import {
  DEFER_REVIEW_UNTIL_SYNCED,
  NON_BLOCKING_REVIEW_FLAGS,
  blockingReviewFlags,
  deferredReviewReason,
  ANALYSIS_SCHEMA_VERSION,
  FLAG_KEYS,
} from '../src/ci/analysis-schema.js';
import { parseConfig } from '../src/ci/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CFG = parseConfig({});

const CALL = {
  id: '8d41446e-403e-5d4c-a306-65d59b8e4407',
  five9_call_id: '300000010270763',
  call_start: '2026-08-21T16:00:06.000Z',
  direction: 'Outbound',
  ani: '7273302574',
  agent_name: 'John Manieri',
  agent_username: 'jmanieri',
  team: 'reece',
  attempts: 0,
  pending_review_reason: null,
};

// The clock is pinned to the fixture — see the long note in test-ci-sync.js.
// stageSync threads `now` down to syncToLp/syncToGhl, whose note-age gate
// defaults to 24h; with a real `now` the LP write is skipped as `call_too_old`,
// so "a sync FAILURE is recorded as one" saw no failure at all and read back
// the call's original pending_review_reason instead. Derived from CALL; `...o`
// last so an individual test can still override it.
const NOW = new Date(Date.parse(CALL.call_start) + 60 * 60 * 1000);
const stageSync = (c, o = {}) => stageSyncAt(c, { now: NOW, ...o });

/** A minimal valid §7 output. */
function validAnalysis(over = {}) {
  const triple = () => ({ value: null, source: 'unknown', confidence: 0 });
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    summary: 'The customer confirmed Thursday and asked to be removed from the list.',
    outcome: 'appointment_confirmed',
    outcome_confidence: 0.91,
    outcome_basis: 'stated',
    customer: { name: triple(), phone_mentioned: triple(), email: triple(), address: triple() },
    appointment: { discussed: true, date: triple(), time: triple(), notes: null },
    follow_up: { required: false, when: null, action: null },
    key_details: [],
    flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, false])),
    quality: { transcript_intelligible: true, uncertainty_notes: null },
    ...over,
  };
}

const withFlag = (flag, over = {}) => {
  const a = validAnalysis(over);
  a.flags[flag] = true;
  return a;
};

// ─── the two sets are two behaviours ────────────────────────────────────────

test('the deferred set holds exactly the two requests a human must act on', () => {
  assert.deepEqual([...DEFER_REVIEW_UNTIL_SYNCED].sort(), ['cancellation_request', 'dnc_request']);
  // NOT unknown_team. Those calls had no Reece agent on them and there is no
  // team to resolve, so queueing them queues work nobody can ever clear —
  // which is the block PR #760 removed. Deliver-then-complete and
  // deliver-then-queue are two behaviours, kept as two named sets.
  assert.equal(DEFER_REVIEW_UNTIL_SYNCED.has('unknown_team'), false);
  assert.ok(NON_BLOCKING_REVIEW_FLAGS.has('unknown_team'));
  for (const flag of DEFER_REVIEW_UNTIL_SYNCED) {
    assert.equal(NON_BLOCKING_REVIEW_FLAGS.has(flag), false, `${flag} belongs to one set, not both`);
  }
});

test('neither set stops a call at analysis, and everything else still does', () => {
  assert.deepEqual(blockingReviewFlags(['dnc_request', 'cancellation_request', 'unknown_team']), []);
  assert.deepEqual(
    blockingReviewFlags(['dnc_request', 'transcript_unintelligible', 'low_outcome_confidence']),
    ['transcript_unintelligible', 'low_outcome_confidence'],
  );
});

test('a call asking for both is queued as the DNC — it carries the legal weight', () => {
  assert.equal(deferredReviewReason(['dnc_request', 'cancellation_request']), 'dnc_request');
  assert.equal(deferredReviewReason(['cancellation_request']), 'cancellation_request');
  assert.equal(deferredReviewReason(['unknown_team', 'low_outcome_confidence']), null);
  assert.equal(deferredReviewReason([]), null);
});

// ─── the header carries the flag where a rep cannot miss it ─────────────────

test('the request LEADS the outcome segment, and the real outcome survives', () => {
  assert.equal(
    formatOutcomeSegment(withFlag('dnc_request')),
    'Outcome: DNC REQUESTED — Appointment confirmed',
  );
  assert.equal(
    formatOutcomeSegment(withFlag('cancellation_request', { outcome: 'appointment_cancelled' })),
    'Outcome: Cancellation requested — Appointment cancelled',
  );
  // Both flags: DNC wins.
  const both = withFlag('dnc_request');
  both.flags.cancellation_request = true;
  assert.equal(formatOutcomeSegment(both), 'Outcome: DNC REQUESTED — Appointment confirmed');
});

test('when the outcome IS the request, the header does not say it twice', () => {
  assert.equal(
    formatOutcomeSegment(withFlag('dnc_request', { outcome: 'dnc_request' })),
    'Outcome: DNC REQUESTED',
  );
});

test('an unflagged call renders exactly as it always has', () => {
  assert.equal(formatOutcomeSegment(validAnalysis()), 'Outcome: Appointment confirmed');
});

test('the flag is in the HEADER, not buried in Key details', () => {
  const note = composeNote(CALL, { output: withFlag('dnc_request') });
  const [header, ...rest] = note.split('\n');
  assert.match(header, /\| Outcome: DNC REQUESTED — Appointment confirmed\]$/);
  assert.equal(/DNC REQUESTED/.test(rest.join('\n')), false, 'the shout belongs in the header, once');
});

// ─── the doubles ────────────────────────────────────────────────────────────

function fakeDb({ transcript = null, match = null, summary = null } = {}) {
  const log = [];
  const syncRows = [];
  const rowFor = (table) => (table === 'ci_transcripts' ? transcript
    : table === 'ci_matches' ? match
      : table === 'ci_summaries' ? summary : null);
  return {
    log,
    syncRows,
    from(table) {
      const chain = {
        _eq: {},
        select() { return chain; },
        eq(col, val) { chain._eq[col] = val; return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({ data: rowFor(table), error: null }),
        update(patch) {
          const thenable = {
            eq(col, val) { chain._eq[col] = val; return thenable; },
            then: (res, rej) => {
              log.push({ table, op: 'update', patch });
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return thenable;
        },
        // Awaitable AND chainable: the summary insert is awaited directly,
        // while the ci_syncs insert goes .insert(row).select().maybeSingle().
        insert(row) {
          log.push({ table, op: 'insert', row });
          const stored = { id: `${table}-${log.length}`, attempts: 0, ...row };
          if (table === 'ci_syncs') syncRows.push(stored);
          const api = {
            select: () => api,
            maybeSingle: async () => ({ data: table === 'ci_syncs' ? stored : null, error: null }),
            single: async () => ({ data: table === 'ci_syncs' ? stored : null, error: null }),
            then: (res, rej) => Promise.resolve({ data: stored, error: null }).then(res, rej),
          };
          return api;
        },
        then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

const patchOf = (db) => db.log.filter((l) => l.table === 'ci_calls' && l.op === 'update').pop()?.patch;
const eventOf = (db) => db.log.filter((l) => l.table === 'ci_events' && l.op === 'insert').pop()?.row;

// ─── stageAnalyze: record the reason, do not park ───────────────────────────

test('a DNC call ADVANCES out of analysis and carries its reason forward', async () => {
  const db = fakeDb({ transcript: { call_id: CALL.id, transcript_text: 'take me off your list' } });
  const r = await stageAnalyze(CALL, {
    db, cfg: CFG, callJson: async () => ({ json: withFlag('dnc_request') }),
  });

  assert.equal(r.outcome, 'advanced');
  assert.equal(r.to, 'analyzed');
  assert.equal(r.deferred_review, 'dnc_request');

  const patch = patchOf(db);
  assert.equal(patch.status, 'analyzed', 'the call must reach sync, or no note is ever written');
  assert.equal(patch.pending_review_reason, 'dnc_request');
  assert.equal(patch.review_reason, undefined, 'it is not parked yet');

  // Same write, not two: a worker dying between them would lose the request.
  assert.equal(
    db.log.filter((l) => l.table === 'ci_calls' && l.op === 'update').length, 1,
    'status and the pending reason must land in ONE update',
  );

  // The summary is stored, flag and all.
  const stored = db.log.find((l) => l.table === 'ci_summaries' && l.op === 'insert')?.row;
  assert.deepEqual(stored.review_flags, ['dnc_request']);
});

test('a cancellation request behaves the same way', async () => {
  const db = fakeDb({ transcript: { call_id: CALL.id, transcript_text: 'I need to cancel' } });
  const r = await stageAnalyze(CALL, {
    db, cfg: CFG, callJson: async () => ({ json: withFlag('cancellation_request') }),
  });
  assert.equal(r.outcome, 'advanced');
  assert.equal(patchOf(db).pending_review_reason, 'cancellation_request');
});

test('THE QUALITY GATE WINS: a DNC on an unreadable transcript still parks', async () => {
  // And writes nothing. A note composed from a transcript nobody could make
  // out is not worth delivering because it also mentioned a DNC.
  const db = fakeDb({ transcript: { call_id: CALL.id, transcript_text: '...', low_confidence: true } });
  const r = await stageAnalyze(CALL, {
    db, cfg: CFG, callJson: async () => ({ json: withFlag('dnc_request') }),
  });

  assert.equal(r.outcome, 'review');
  assert.equal(r.reason, 'low_confidence_transcript');

  const patch = patchOf(db);
  assert.equal(patch.status, 'review');
  assert.equal(patch.pending_review_reason, undefined, 'a parked call carries no pending reason');
  // The reviewer still sees the DNC in the flag list.
  assert.ok(eventOf(db).detail.review_flags.includes('dnc_request'));
});

test('a re-analysis that no longer finds the flag CLEARS the column', async () => {
  // Otherwise a stale value parks the call for a request nobody made.
  const db = fakeDb({ transcript: { call_id: CALL.id, transcript_text: 'hello' } });
  await stageAnalyze({ ...CALL, pending_review_reason: 'dnc_request' }, {
    db, cfg: CFG, callJson: async () => ({ json: validAnalysis() }),
  });
  const patch = patchOf(db);
  assert.equal(patch.status, 'analyzed');
  assert.equal(patch.pending_review_reason, null, 'the column is written on EVERY advance');
});

// ─── stageSync: write first, then queue ─────────────────────────────────────

const MATCH = {
  call_id: CALL.id,
  tier: 'high',
  ghl_contact_id: 'ghl-contact-1',
  evidence: { note_target: { rectype: 'cst', recid: 453297 } },
};
const SUMMARY_ROW = { call_id: CALL.id, is_current: true, output: withFlag('dnc_request') };

/** Sync doubles with both CRMs off — the live state, and the harder case. */
const SHADOW_CFG = parseConfig({ CALL_INTEL_LP_WRITES: 'false', CALL_INTEL_GHL_WRITES: 'false' });

test('a deferred call is QUEUED after the write, not completed', async () => {
  const db = fakeDb({ match: MATCH, summary: SUMMARY_ROW });
  const r = await stageSync({ ...CALL, pending_review_reason: 'dnc_request' }, {
    db, cfg: SHADOW_CFG,
  });

  assert.equal(r.outcome, 'review');
  assert.equal(r.reason, 'dnc_request');
  assert.equal(r.delivered, true);

  const patch = patchOf(db);
  assert.equal(patch.status, 'review');
  assert.equal(patch.review_reason, 'dnc_request', 'queued on the CUSTOMER\'s reason, not a generic one');
  assert.equal(patch.pending_review_reason, null, 'cleared in the same write that parks it');
});

test('a call with no deferred reason still completes, untouched', async () => {
  const db = fakeDb({ match: MATCH, summary: { ...SUMMARY_ROW, output: validAnalysis() } });
  const r = await stageSync(CALL, { db, cfg: SHADOW_CFG });
  assert.equal(r.outcome, 'advanced');
  assert.equal(r.to, 'completed');
  assert.equal(patchOf(db).status, 'completed');
});

test('NOTHING IS AUTO-ACTIONED — no tag, no DNC write, no cancellation', async () => {
  const db = fakeDb({ match: MATCH, summary: SUMMARY_ROW });
  await stageSync({ ...CALL, pending_review_reason: 'dnc_request' }, { db, cfg: SHADOW_CFG });

  // Every write this stage makes must be to a ci_* table. A DNC list, a tag,
  // an appointment — none of those are this pipeline's to touch.
  for (const entry of db.log) {
    assert.match(entry.table, /^ci_/, `stageSync wrote to '${entry.table}' — it may only touch ci_*`);
  }
  assert.equal(db.log.some((l) => /dnc|tag|appointment/i.test(l.table)), false);
});

// ─── the failure path is still a failure path ───────────────────────────────

test('a sync FAILURE is recorded as one, and the request survives it', async () => {
  // The write did not land, so the call has not earned its way to the queue on
  // its own reason — and a delivery failure must never be swallowed because
  // the call was heading to review anyway.
  const db = fakeDb({ match: MATCH, summary: SUMMARY_ROW });
  // MAX_ATTEMPTS=1 makes the first failure terminal, which is the branch under
  // test — the retryable branch just defers and is covered by test-ci-sync.
  const r = await stageSync({ ...CALL, pending_review_reason: 'dnc_request' }, {
    db,
    cfg: parseConfig({
      CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true', CALL_INTEL_MAX_ATTEMPTS: '1',
    }),
    lpClient: { addNote: async () => { throw new Error('LP is down'); } },
  });

  assert.equal(r.outcome, 'review');
  assert.equal(r.reason, 'sync_failed', 'the failure is named as a failure, not as the DNC');
  assert.notEqual(r.outcome, 'advanced', 'a failed write must never complete the call');

  const patch = patchOf(db);
  assert.equal(patch.status, 'review');
  assert.equal(patch.review_reason, 'sync_failed');
  assert.equal(
    patch.pending_review_reason, undefined,
    'the request is NOT cleared — the write did not land, so it stays attached to the call',
  );

  // And the failure is on the ci_syncs row, where the audit trail lives.
  assert.ok(db.log.some((l) => l.table === 'ci_syncs' && l.op === 'update' && l.patch.status === 'failed'));
});

// ─── the schema and its mirror agree ────────────────────────────────────────

test('sql/073 adds the column, and runMigrations mirrors it exactly', () => {
  const file = read('sql/073_ci_pending_review_reason.sql');
  assert.match(file, /ALTER TABLE ci_calls ADD COLUMN IF NOT EXISTS pending_review_reason text;/);
  // A fresh deploy self-heals from the mirror. If the two disagree the column
  // depends on which one ran — schema drift that is invisible until a write
  // fails on one instance only.
  assert.match(read('src/index.js'), /ALTER TABLE ci_calls ADD COLUMN IF NOT EXISTS pending_review_reason text;/);
});

test('sql/073 writes NO data — it is additive, with no backfill', () => {
  const file = read('sql/073_ci_pending_review_reason.sql');
  const ddl = file.replace(/^--.*$/gm, '');
  assert.equal(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP TABLE\b/i.test(ddl), false);
  assert.equal(/DEFAULT/i.test(ddl), false, 'existing rows must read NULL, not a made-up reason');
});
