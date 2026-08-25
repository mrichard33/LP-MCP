/**
 * Tests — the stored-filename repair — scripts/test-ci-recording-filename-repair.js
 *
 * Rows ingested between 2026-08-22 and the parser fix carry a corrupted
 * ivr_module: the appended session id landed inside the module token. That is
 * not cosmetic — ci_transfer_target_map matches by EXACT equality, so every one
 * of those rows failed team classification.
 *
 * Pure planner, no env, no network, no credentials.
 *   node --test scripts/test-ci-recording-filename-repair.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { planFilenameRepairs } from './repair-ci-recording-filenames.js';

const SUFFIX = 'CB3E712B7E084D8A9BD23381B216E482300000002866719';

/** A row as it was actually stored during the break. */
const brokenRow = (over = {}) => ({
  id: 'r1',
  source_filename: `9419203087 by  @ 1_49_32 PM_Transfer to Lightfire${SUFFIX}.wav`,
  ivr_module: `Transfer to Lightfire${SUFFIX}`,
  five9_recording_id: null,
  ...over,
});

test('a broken transfer row is repaired to the clean module plus the id', () => {
  const { changes, skipped } = planFilenameRepairs([brokenRow()]);
  assert.equal(changes.length, 1);
  assert.equal(skipped.already_correct, 0);
  assert.equal(changes[0].module_from, `Transfer to Lightfire${SUFFIX}`);
  assert.equal(changes[0].module_to, 'Transfer to Lightfire');
  assert.equal(changes[0].id_to, SUFFIX);
});

test('a pre-boundary row is left completely alone', () => {
  // 101 rows predate the change and are already correct. Rewriting them to the
  // value they already hold is noise, and makes a second run look like it
  // found work to do.
  const old = {
    id: 'r2',
    source_filename: '9419203087 by  @ 4_30_12 PM_Transfer to Lightfire.wav',
    ivr_module: 'Transfer to Lightfire',
    five9_recording_id: null,
  };
  const { changes, skipped } = planFilenameRepairs([old]);
  assert.equal(changes.length, 0);
  assert.equal(skipped.already_correct, 1);
});

test('a plain agent row with no module is already correct', () => {
  const agent = {
    id: 'r3',
    source_filename: '4436170733 by cdeer @ 7_16_55 AM.wav',
    ivr_module: null,
    five9_recording_id: null,
  };
  const { changes, skipped } = planFilenameRepairs([agent]);
  assert.equal(changes.length, 0);
  assert.equal(skipped.already_correct, 1);
});

test('a row already repaired is not repaired twice — the run is idempotent', () => {
  const done = brokenRow({ ivr_module: 'Transfer to Lightfire', five9_recording_id: SUFFIX });
  const { changes, skipped } = planFilenameRepairs([done]);
  assert.equal(changes.length, 0);
  assert.equal(skipped.already_correct, 1);
});

test('a filename that still will not parse is COUNTED, never guessed at', () => {
  // If this is ever non-zero the archive holds a shape nobody has accounted
  // for. Reporting it is the whole point — a repair that silently skipped
  // these would hide the next format change exactly as the last one was hidden.
  const weird = { id: 'r4', source_filename: '4436170733 by cdeer @ 7_16_55 AMWHATNOW.wav', ivr_module: null, five9_recording_id: null };
  const { changes, skipped } = planFilenameRepairs([weird]);
  assert.equal(changes.length, 0);
  assert.equal(skipped.unparseable, 1);
});

test('a module ending in a hex character is not truncated by the repair', () => {
  // 'Transfer to Lightfire' ends in 'e', a hex digit. A repair that scanned
  // leftmost for a 32-hex run would rewrite the module to 'Transfer to
  // Lightfir' and re-break the exact-equality lookup it exists to fix.
  const { changes } = planFilenameRepairs([brokenRow()]);
  assert.equal(changes[0].module_to, 'Transfer to Lightfire');
  assert.equal(changes[0].module_to.length, 21);
});

test('an empty input plans nothing rather than throwing', () => {
  assert.deepEqual(planFilenameRepairs([]), { changes: [], skipped: { unparseable: 0, already_correct: 0 } });
  assert.deepEqual(planFilenameRepairs(null), { changes: [], skipped: { unparseable: 0, already_correct: 0 } });
});
