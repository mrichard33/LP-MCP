/**
 * scripts/test-disposition-guard-logic.js
 *
 * Unit tests for the stale-disposition rebook guard's pure logic
 * (call-dispatch-integrity 2026-07-07): terminal-set derivation from
 * KNOWN_DISPOSITION_LABELS categories, and the guard module's dedup window.
 *
 * The terminal set is DELIBERATELY closed_lost only — dead (DNC/NG) is
 * compliance-sensitive and closed_won (Sale/SW) is real business state;
 * neither may ever be auto-refreshed/cleared by the guard.
 *
 * Run: node --test scripts/test-disposition-guard-logic.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dispositionCategory,
  isStaleGuardTerminalDisposition,
} from '../src/sync-dispositions.js';
import { _internal } from '../src/services/disposition-staleness-guard.js';

test('closed_lost codes are terminal for the guard', () => {
  for (const code of ['CXL', 'NI', 'NOP NOP', 'NIS']) {
    assert.equal(dispositionCategory(code), 'closed_lost', `${code} category`);
    assert.equal(isStaleGuardTerminalDisposition(code), true, `${code} must be guard-terminal`);
  }
});

test('dead (compliance) and closed_won (real state) are NEVER guard-terminal', () => {
  for (const code of ['DNC', 'NG', 'Sale', 'SW']) {
    assert.equal(isStaleGuardTerminalDisposition(code), false, `${code} must not be guard-terminal`);
  }
});

test('active/deferred codes are not guard-terminal', () => {
  for (const code of ['Data', 'OPPFDN', 'Set', 'Cnf', 'NS', 'FDNS', 'CCC', 'OPP NOI', 'BO', '1Leg']) {
    assert.equal(isStaleGuardTerminalDisposition(code), false, `${code} must not be guard-terminal`);
  }
});

test('legacy string-only codes have no category and are not guard-terminal', () => {
  for (const code of ['NH', 'CN', 'SL', 'CB']) {
    assert.equal(dispositionCategory(code), null, `${code} is legacy string-only`);
    assert.equal(isStaleGuardTerminalDisposition(code), false);
  }
});

test('unknown / empty codes are not guard-terminal', () => {
  assert.equal(isStaleGuardTerminalDisposition('TOTALLY_MADE_UP'), false);
  assert.equal(isStaleGuardTerminalDisposition(''), false);
  assert.equal(isStaleGuardTerminalDisposition(null), false);
  assert.equal(isStaleGuardTerminalDisposition(undefined), false);
});

test('guard dedup: second run for the same contact within the TTL is suppressed', () => {
  const { dedupHit } = _internal;
  assert.equal(dedupHit('test-contact-dedup-1'), false, 'first run proceeds');
  assert.equal(dedupHit('test-contact-dedup-1'), true, 'immediate re-run deduped');
  assert.equal(dedupHit('test-contact-dedup-2'), false, 'different contact unaffected');
});

test('guard constants match the webhook idempotency window', () => {
  assert.equal(_internal.DEDUP_TTL_MS, 30 * 60 * 1000);
  assert.equal(_internal.FRESH_DISPOSITION_SKEW_MS, 5 * 60 * 1000);
  assert.equal(_internal.DISPOSITION_FIELD_ID, 'URWTGtobi9a9Y7gwGxC8');
});
