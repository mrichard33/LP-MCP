/**
 * Tests — requeueing calls out of the review queue
 * scripts/test-ci-requeue-review.js
 *
 * WHAT THIS GUARDS. 30 calls sit in review and Mark will need to clear them
 * again after every discovery backfill. The danger is not that the script
 * fails — it is that it succeeds WRONGLY and nothing says so:
 *
 *   1. IT MUST NOT WRITE ITS OWN UPDATE. Every write goes through
 *      applyResolve(), the exact function the HTTP endpoint calls. A bulk
 *      requeue with its own UPDATE is how `attempts = 0` gets forgotten, or a
 *      call gets sent back to the wrong stage — and the calls then just
 *      quietly re-fail or re-buy a transcript that already exists.
 *   2. THE RESUME STAGE COMES FROM THE ARTIFACTS, never from review_reason.
 *   3. --all NEEDS --confirm, so a fat finger cannot requeue the whole queue
 *      including the calls parked because retrying them just re-fails.
 *   4. A DRY RUN WRITES NOTHING.
 *
 * No network, no DB — the Supabase client is a double.
 *
 * Run: node --test scripts/test-ci-requeue-review.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, planSelection } from './requeue-ci-review.js';
import { applyResolve, resumeStatusFor, RESOLVE_ACTIONS } from '../src/ci/routes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── flag parsing ───────────────────────────────────────────────────────────

test('--reason is repeatable and order-independent', () => {
  const a = parseArgs(['--reason=unknown_team', '--reason=low_outcome_confidence', '--execute']);
  assert.deepEqual(a.reasons, ['unknown_team', 'low_outcome_confidence']);
  assert.equal(a.execute, true);
  assert.equal(a.all, false);
});

test('--limit parses, and junk is ignored rather than becoming 0', () => {
  assert.equal(parseArgs(['--limit=5']).limit, 5);
  assert.equal(parseArgs(['--limit=abc']).limit, null, 'a bad limit must not silently select nothing');
  assert.equal(parseArgs(['--limit=0']).limit, null);
  assert.equal(parseArgs(['--limit=-3']).limit, null);
  assert.equal(parseArgs([]).limit, null);
});

test('an empty --reason= is not a reason', () => {
  assert.deepEqual(parseArgs(['--reason=']).reasons, []);
  assert.deepEqual(parseArgs(['--reason=   ']).reasons, []);
});

// ─── the selection rules ────────────────────────────────────────────────────

test('--reason filters, and is enough on its own', () => {
  const p = planSelection(parseArgs(['--reason=unknown_team']));
  assert.equal(p.ok, true);
  assert.deepEqual(p.reasons, ['unknown_team']);
  assert.equal(p.all, false);
});

test('--ALL REQUIRES --CONFIRM', () => {
  // A fat-fingered --all --execute would requeue the entire queue, including
  // recording_missing, which has no recording to find and just re-fails.
  const without = planSelection(parseArgs(['--all', '--execute']));
  assert.equal(without.ok, false);
  assert.match(without.error, /--confirm/);

  const withConfirm = planSelection(parseArgs(['--all', '--confirm', '--execute']));
  assert.equal(withConfirm.ok, true);
  assert.equal(withConfirm.all, true);
});

test('selecting nothing is refused, not treated as "everything"', () => {
  const p = planSelection(parseArgs([]));
  assert.equal(p.ok, false);
  assert.match(p.error, /nothing selected/);
});

test('--all and --reason together are refused rather than silently ranked', () => {
  const p = planSelection(parseArgs(['--all', '--confirm', '--reason=unknown_team']));
  assert.equal(p.ok, false);
  assert.match(p.error, /mutually exclusive/);
});

// ─── the resume stage comes from the artifacts ──────────────────────────────

/** Double whose artifact tables can be turned on and off per call. */
function artifactDb({ summary = false, transcript = false, recording = false, match = false } = {}) {
  const log = [];
  const present = {
    ci_summaries: summary,
    ci_transcripts: transcript,
    ci_recordings: recording,
    ci_matches: match,
  };
  return {
    log,
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        limit: async () => ({ data: present[table] ? [{ call_id: 'c1' }] : [], error: null }),
        // A write MAKES the artifact present. Without this the double would
        // answer a probe with the state from before its own insert, and an
        // ordering bug in applyResolve (deriving the resume stage before
        // recording the match) would pass unnoticed.
        insert: async (row) => { log.push({ table, op: 'insert', row }); present[table] = true; return { error: null }; },
        upsert: async (row, opts) => { log.push({ table, op: 'upsert', row, opts }); present[table] = true; return { error: null }; },
        update(patch) {
          const thenable = {
            eq() { return thenable; },
            then: (res, rej) => { log.push({ table, op: 'update', patch }); return Promise.resolve({ error: null }).then(res, rej); },
          };
          return thenable;
        },
      };
      return chain;
    },
  };
}

test('THE RESUME STAGE IS DERIVED FROM ARTIFACTS, at every level', () => {
  // Never from review_reason — that would break the moment a reason string is
  // renamed, and would re-buy a transcript that already exists.
  const cases = [
    [{ summary: true, transcript: true, match: true, recording: true }, 'analyzed'],
    [{ transcript: true, match: true, recording: true }, 'transcribed'],
    // A match row and no transcript belongs at 'matched' (→ transcribe), NOT
    // back at 'fetched'. Matching runs at the fetch stage now, so sending it
    // to 'fetched' would re-enter a stage that has nothing left to do.
    [{ match: true, recording: true }, 'matched'],
    [{ recording: true }, 'fetched'],
    [{}, 'discovered'],
  ];
  return Promise.all(cases.map(async ([artifacts, expected]) => {
    assert.equal(await resumeStatusFor(artifactDb(artifacts), 'c1'), expected);
  }));
});

test('a call with a summary resumes at analyzed — the transcript is NOT re-bought', async () => {
  const db = artifactDb({ summary: true, transcript: true, recording: true });
  const { status } = await applyResolve(db, { id: 'c1', review_reason: 'unknown_team' }, 'retry');
  assert.equal(status, 'analyzed');
});

// ─── what a requeue writes ──────────────────────────────────────────────────

test('ATTEMPTS RESET TO 0, exactly as the endpoint does', async () => {
  // Without this a call that already burned its attempts comes straight back
  // to 'failed' on the first hiccup, and the requeue looks like a no-op.
  const db = artifactDb({ recording: true });
  await applyResolve(db, { id: 'c1', review_reason: 'unknown_team' }, 'retry');
  const upd = db.log.find((l) => l.table === 'ci_calls' && l.op === 'update');
  assert.equal(upd.patch.attempts, 0);
  assert.equal(upd.patch.status, 'fetched');
  assert.equal(upd.patch.review_reason, null, 'the reason is cleared — it is back in the pipeline');
  assert.equal(upd.patch.locked_until, null);
  assert.equal(upd.patch.locked_by, null);
  assert.equal(upd.patch.next_retry_at, null);
});

test('a requeue is recorded in ci_events, so the queue has an audit trail', async () => {
  const db = artifactDb({ recording: true });
  await applyResolve(db, { id: 'c1', review_reason: 'unknown_team' }, 'retry');
  const ev = db.log.find((l) => l.table === 'ci_events');
  assert.ok(ev, 'every resolution is auditable');
  assert.equal(ev.row.event, 'resolved');
  assert.equal(ev.row.detail.action, 'retry');
  assert.equal(ev.row.detail.to, 'fetched');
});

test('retry writes NO ci_matches row — it decides nothing about identity', async () => {
  const db = artifactDb({ recording: true });
  await applyResolve(db, { id: 'c1' }, 'retry');
  assert.equal(db.log.some((l) => l.table === 'ci_matches'), false);
});

// ─── the shared path ────────────────────────────────────────────────────────

test('THE SCRIPT WRITES NO UPDATE OF ITS OWN', () => {
  // It must go through applyResolve(), the same function the endpoint calls.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/requeue-ci-review.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /import\s*\{[\s\S]*?applyResolve[\s\S]*?\}\s*from\s*'\.\.\/src\/ci\/routes\.js'/);
  assert.equal(/\.update\(/.test(code), false, 'no bespoke UPDATE anywhere in the script');
  assert.equal(/from\('ci_calls'\)[\s\S]{0,80}\.update/.test(code), false);
  // Its only ci_calls touch is the SELECT that builds the batch.
  assert.match(code, /\.from\('ci_calls'\)[\s\S]{0,120}\.select\(/);
});

test('the endpoint and the script share ONE implementation', () => {
  // The endpoint must delegate rather than keep an inline copy that agrees
  // today and drifts tomorrow.
  const routes = fs.readFileSync(path.join(ROOT, 'src/ci/routes.js'), 'utf8');
  assert.match(routes, /await applyResolve\(supabase, call, action,/, 'the handler delegates');
  // The old inline body must be gone — one `let nextStatus;` in the module,
  // inside applyResolve itself.
  assert.equal((routes.match(/let nextStatus;/g) || []).length, 1);
});

test('applyResolve still refuses an action it does not know', async () => {
  await assert.rejects(
    () => applyResolve(artifactDb(), { id: 'c1' }, 'requeue_everything'),
    /action must be one of/,
  );
  assert.deepEqual([...RESOLVE_ACTIONS].sort(), ['fail', 'retry', 'set_match', 'skip']);
});

test('the other three actions are untouched by the extraction', async () => {
  const skip = artifactDb({ recording: true });
  assert.equal((await applyResolve(skip, { id: 'c1' }, 'skip')).status, 'skipped');

  const fail = artifactDb({ recording: true });
  const r = await applyResolve(fail, { id: 'c1', review_reason: 'recording_missing' }, 'fail', { note: 'no audio exists' });
  assert.equal(r.status, 'failed');
  assert.equal(r.patch.review_reason, 'no audio exists', 'fail keeps a reason on the record');

  // set_match naming no record is still refused.
  await assert.rejects(
    () => applyResolve(artifactDb(), { id: 'c1' }, 'set_match'),
    /at least one of lp_cst_id/,
  );
});

test('a set_match still records a human decision', async () => {
  const db = artifactDb({ recording: true });
  const { status } = await applyResolve(db, { id: 'c1' }, 'set_match', { cstId: 453297 });
  const m = db.log.find((l) => l.table === 'ci_matches');
  assert.equal(m.row.decided_by, 'human');
  assert.equal(m.row.lp_cst_id, 453297);
  // A human correction on a call that never got past the fetch stage still
  // owes that call a transcript and an analysis before it can sync.
  assert.equal(status, 'matched');
});

test('SET_MATCH UPSERTS — ci_matches.call_id is UNIQUE, so an insert would throw', async () => {
  // Since matching moved to the fetch stage, essentially every reviewed call
  // already carries the matcher's 'auto' row. A plain insert against a UNIQUE
  // call_id is not an append, it is the 2026-08-26 failure that sent 88 calls
  // to 'failed' on ci_matches_call_id_key.
  const db = artifactDb({ match: true, recording: true });
  await applyResolve(db, { id: 'c1' }, 'set_match', { cstId: 453297 });

  const writes = db.log.filter((l) => l.table === 'ci_matches');
  assert.equal(writes.length, 1, 'exactly one write to ci_matches');
  assert.equal(writes[0].op, 'upsert', 'insert would violate the unique constraint');
  assert.equal(writes[0].opts?.onConflict, 'call_id', 'the conflict target must be the unique column');
});

test('a set_match on a fully-processed call rejoins just before sync', async () => {
  // Not at 'matched'. That status now means "ready to transcribe", and a call
  // that already has a transcript and a current summary would be re-analyzed —
  // paying model tokens to reproduce a summary it is already holding.
  const db = artifactDb({ summary: true, transcript: true, match: true, recording: true });
  const { status } = await applyResolve(db, { id: 'c1' }, 'set_match', { cstId: 453297 });
  assert.equal(status, 'analyzed', 'one no-op match stage, then sync');
});
