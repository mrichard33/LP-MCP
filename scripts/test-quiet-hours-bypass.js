/**
 * test-quiet-hours-bypass.js — QA exemption from the quiet-hours hold
 * (2026-08-14).
 *
 * The quiet-hours window (8AM–9PM ET) holds bot-INITIATED sends so a proactive
 * push can't land at 9:09 PM. That is a courtesy/TCPA line and must stay on for
 * real customers. QUIET_HOURS_BYPASS_CONTACT_IDS exempts named test contacts so
 * the full loop — including hold returns and follow-up re-engagements, which
 * are precisely what the window suppresses — can be exercised after hours.
 *
 * The property under test: the allowlist is EXACT-MATCH and inert by default.
 * A partial or fuzzy match here would silently expose real customers to
 * after-hours sends, so the matching is asserted directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { isQuietHoursBypassed, isInQuietHours } = await import('../src/services/quiet-hours.js');

const TEST_ID = '61LmNFIppYRWUzNyIJbq';
const REAL_ID = 'gUihunGyOa6SiGbJCJ3K';

function withEnv(value, fn) {
  const prior = process.env.QUIET_HOURS_BYPASS_CONTACT_IDS;
  if (value === undefined) delete process.env.QUIET_HOURS_BYPASS_CONTACT_IDS;
  else process.env.QUIET_HOURS_BYPASS_CONTACT_IDS = value;
  try { fn(); } finally {
    if (prior === undefined) delete process.env.QUIET_HOURS_BYPASS_CONTACT_IDS;
    else process.env.QUIET_HOURS_BYPASS_CONTACT_IDS = prior;
  }
}

// ── inert by default ────────────────────────────────────────────────

test('unset env → nobody is bypassed', () => {
  withEnv(undefined, () => {
    assert.equal(isQuietHoursBypassed(TEST_ID), false);
    assert.equal(isQuietHoursBypassed(REAL_ID), false);
  });
});

test('empty env → nobody is bypassed', () => {
  withEnv('', () => assert.equal(isQuietHoursBypassed(TEST_ID), false));
  withEnv('   ', () => assert.equal(isQuietHoursBypassed(TEST_ID), false));
  withEnv(',,', () => assert.equal(isQuietHoursBypassed(TEST_ID), false));
});

test('a null/empty contact id is never bypassed', () => {
  withEnv(TEST_ID, () => {
    assert.equal(isQuietHoursBypassed(null), false);
    assert.equal(isQuietHoursBypassed(undefined), false);
    assert.equal(isQuietHoursBypassed(''), false);
    assert.equal(isQuietHoursBypassed('   '), false);
  });
});

// ── the allowlist works ─────────────────────────────────────────────

test('the named test contact IS bypassed', () => {
  withEnv(TEST_ID, () => assert.equal(isQuietHoursBypassed(TEST_ID), true));
});

test('a real customer is NOT bypassed while a test contact is listed', () => {
  withEnv(TEST_ID, () => assert.equal(isQuietHoursBypassed(REAL_ID), false));
});

test('multiple ids, with whitespace, all resolve', () => {
  withEnv(` ${TEST_ID} , abc123 ,, def456 `, () => {
    assert.equal(isQuietHoursBypassed(TEST_ID), true);
    assert.equal(isQuietHoursBypassed('abc123'), true);
    assert.equal(isQuietHoursBypassed('def456'), true);
    assert.equal(isQuietHoursBypassed(REAL_ID), false);
  });
});

test('the contact id is trimmed before comparison', () => {
  withEnv(TEST_ID, () => assert.equal(isQuietHoursBypassed(`  ${TEST_ID}  `), true));
});

// ── exact match only (the safety property) ──────────────────────────

test('a PREFIX of a listed id is not bypassed', () => {
  withEnv(TEST_ID, () => {
    assert.equal(isQuietHoursBypassed(TEST_ID.slice(0, 8)), false);
    assert.equal(isQuietHoursBypassed(TEST_ID.slice(0, -1)), false);
  });
});

test('a SUPERSTRING of a listed id is not bypassed', () => {
  withEnv(TEST_ID, () => assert.equal(isQuietHoursBypassed(TEST_ID + 'X'), false));
});

test('matching is case-sensitive (GHL ids are case-sensitive)', () => {
  withEnv(TEST_ID, () => assert.equal(isQuietHoursBypassed(TEST_ID.toLowerCase()), false));
});

// ── the window itself is untouched ──────────────────────────────────

test('isInQuietHours still honors the configured window regardless of the allowlist', () => {
  const priorStart = process.env.QUIET_HOURS_START;
  const priorEnd = process.env.QUIET_HOURS_END;
  try {
    // A window that covers the entire day: every instant is quiet.
    process.env.QUIET_HOURS_START = '00:01';
    process.env.QUIET_HOURS_END = '00:00';
    withEnv(TEST_ID, () => {
      assert.equal(isInQuietHours(new Date('2026-08-14T18:00:00Z')), true,
        'the allowlist must not change the window — only who is held by it');
    });
  } finally {
    if (priorStart === undefined) delete process.env.QUIET_HOURS_START;
    else process.env.QUIET_HOURS_START = priorStart;
    if (priorEnd === undefined) delete process.env.QUIET_HOURS_END;
    else process.env.QUIET_HOURS_END = priorEnd;
  }
});
