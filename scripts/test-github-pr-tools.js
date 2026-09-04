// Tests for the pure logic in src/tools/admin/github-pr-tools.js.
// Network paths (ghPaged / ghRequest) are not exercised here; the two
// things that can silently give a WRONG ANSWER are the overlap
// intersection and the backup-branch filter, and both are pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isBackupBranch,
  computeOverlaps,
} from '../src/tools/admin/github-pr-tools.js';

const set = (...paths) => new Set(paths);
const pr = (number, title = `PR ${number}`, head = `feat/${number}`) =>
  ({ number, title, head });

// ─── isBackupBranch ──────────────────────────────────────────────

test('isBackupBranch matches the daily backup format', () => {
  assert.equal(isBackupBranch('bk-06-03-2026'), true);
  assert.equal(isBackupBranch('bk-12-31-2026'), true);
  assert.equal(isBackupBranch('BK-06-03-2026'), true); // case-insensitive
});

test('isBackupBranch does NOT swallow real branches that start with bk', () => {
  // The filter exists to hide noise. Hiding real work would be worse
  // than the noise it removes, so the pattern is anchored and exact.
  assert.equal(isBackupBranch('bk-fix/something'), false);
  assert.equal(isBackupBranch('backfill-coverage-probe'), false);
  assert.equal(isBackupBranch('bk-06-03-2026-hotfix'), false);
  assert.equal(isBackupBranch('feat/bk-06-03-2026'), false);
  assert.equal(isBackupBranch('main'), false);
  assert.equal(isBackupBranch('bk-6-3-2026'), false); // wrong width
});

test('isBackupBranch tolerates missing input', () => {
  assert.equal(isBackupBranch(undefined), false);
  assert.equal(isBackupBranch(null), false);
  assert.equal(isBackupBranch(''), false);
});

// ─── computeOverlaps ─────────────────────────────────────────────

test('no shared files means no collision', () => {
  const { collisions, clean } = computeOverlaps([
    { pr: pr(1), files: set('src/a.js') },
    { pr: pr(2), files: set('src/b.js') },
  ]);
  assert.equal(collisions.length, 0);
  assert.deepEqual(clean.map((c) => c.number), [1, 2]);
});

test('a shared file is reported once, with the path named', () => {
  const { collisions, clean } = computeOverlaps([
    { pr: pr(822, 'capacity ranker cycle'), files: set('src/capacity/applyDialPriority.js', 'src/routes/capacityRanker.js') },
    { pr: pr(825, 'restart verify timing'), files: set('src/capacity/applyDialPriority.js', 'scripts/test-capacity-ranker.js') },
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].pr_a.number, 822);
  assert.equal(collisions[0].pr_b.number, 825);
  assert.equal(collisions[0].shared_file_count, 1);
  assert.deepEqual(collisions[0].shared_files, ['src/capacity/applyDialPriority.js']);
  // Both PRs collided, so neither is clean.
  assert.equal(clean.length, 0);
});

test('every colliding pair is emitted, not just the first', () => {
  // Three PRs all touching one file is three pairs, not one cluster.
  // Collapsing them would hide which specific pair to read.
  const { collisions } = computeOverlaps([
    { pr: pr(1), files: set('shared.js') },
    { pr: pr(2), files: set('shared.js') },
    { pr: pr(3), files: set('shared.js') },
  ]);
  assert.equal(collisions.length, 3);
  const pairs = collisions.map((c) => [c.pr_a.number, c.pr_b.number]);
  assert.deepEqual(pairs.sort(), [[1, 2], [1, 3], [2, 3]]);
});

test('pairs sort by shared-file count, worst first', () => {
  const { collisions } = computeOverlaps([
    { pr: pr(1), files: set('a.js', 'b.js', 'c.js') },
    { pr: pr(2), files: set('a.js') },
    { pr: pr(3), files: set('a.js', 'b.js', 'c.js') },
  ]);
  assert.equal(collisions[0].shared_file_count, 3);
  assert.deepEqual(
    [collisions[0].pr_a.number, collisions[0].pr_b.number],
    [1, 3]
  );
});

test('a PR overlapping one sibling but not another is not listed as clean', () => {
  const { collisions, clean } = computeOverlaps([
    { pr: pr(1), files: set('a.js') },
    { pr: pr(2), files: set('a.js') },
    { pr: pr(3), files: set('z.js') },
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(clean.map((c) => c.number), [3]);
});

test('shared_files is sorted so the same pair reads identically every run', () => {
  const { collisions } = computeOverlaps([
    { pr: pr(1), files: set('z.js', 'a.js', 'm.js') },
    { pr: pr(2), files: set('m.js', 'z.js', 'a.js') },
  ]);
  assert.deepEqual(collisions[0].shared_files, ['a.js', 'm.js', 'z.js']);
});

test('a single open PR cannot collide with itself', () => {
  const { collisions, clean } = computeOverlaps([
    { pr: pr(1), files: set('a.js', 'b.js') },
  ]);
  assert.equal(collisions.length, 0);
  assert.deepEqual(clean, [{ number: 1, title: 'PR 1', files: 2 }]);
});

test('an empty PR list yields nothing rather than throwing', () => {
  const { collisions, clean } = computeOverlaps([]);
  assert.deepEqual(collisions, []);
  assert.deepEqual(clean, []);
});

test('a PR with no files never collides', () => {
  // GitHub can report an empty file list for an empty or reverted PR.
  const { collisions, clean } = computeOverlaps([
    { pr: pr(1), files: set() },
    { pr: pr(2), files: set('a.js') },
  ]);
  assert.equal(collisions.length, 0);
  assert.deepEqual(clean.map((c) => c.number), [1, 2]);
});
