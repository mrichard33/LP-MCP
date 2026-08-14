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

const {
  isQuietHoursBypassed, isInQuietHours, isHourGatedChannel, shouldHoldForQuietHours,
} = await import('../src/services/quiet-hours.js');

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

// ── channel scope: email is not hour-gated (2026-08-14) ─────────────
// The window is a courtesy/TCPA line for channels that buzz a phone at 9 PM.
// TCPA covers calls and texts; email is CAN-SPAM, which sets no time-of-day
// limit, and it lands in an inbox the lead opens when they choose. Holding an
// email overnight bought no courtesy and only delayed the answer.

test('email is never hour-gated; sms and livechat are', () => {
  assert.equal(isHourGatedChannel('email'), false);
  assert.equal(isHourGatedChannel('Email'), false, 'case-insensitive');
  assert.equal(isHourGatedChannel('  EMAIL  '), false, 'whitespace/case must not re-gate email');
  assert.equal(isHourGatedChannel('sms'), true);
  assert.equal(isHourGatedChannel('livechat'), true);
});

test('an unknown or absent channel gates by default', () => {
  // Safe direction: an ungated unknown could be an SMS.
  for (const ch of [undefined, null, '', 'something-new']) {
    assert.equal(isHourGatedChannel(ch), true, `ungated unknown channel: ${JSON.stringify(ch)}`);
  }
});

test('a bot-initiated EMAIL inside the quiet window is NOT held', () => {
  assert.equal(shouldHoldForQuietHours({
    channel: 'email', inQuietHours: true, freshInboundReply: false, bypassed: false,
  }), false, 'email must send at any hour');
});

test('a bot-initiated SMS inside the quiet window IS held', () => {
  assert.equal(shouldHoldForQuietHours({
    channel: 'sms', inQuietHours: true, freshInboundReply: false, bypassed: false,
  }), true, 'the TCPA/courtesy line must stay on for SMS');
});

test('livechat keeps the hold too', () => {
  assert.equal(shouldHoldForQuietHours({
    channel: 'livechat', inQuietHours: true, freshInboundReply: false, bypassed: false,
  }), true);
});

test('a fresh inbound reply is never held, on any channel', () => {
  for (const channel of ['sms', 'livechat', 'email']) {
    assert.equal(shouldHoldForQuietHours({
      channel, inQuietHours: true, freshInboundReply: true, bypassed: false,
    }), false, `held a fresh reply on ${channel}`);
  }
});

test('outside the window nothing is held', () => {
  for (const channel of ['sms', 'livechat', 'email']) {
    assert.equal(shouldHoldForQuietHours({
      channel, inQuietHours: false, freshInboundReply: false, bypassed: false,
    }), false);
  }
});

test('the QA bypass still exempts a gated channel', () => {
  assert.equal(shouldHoldForQuietHours({
    channel: 'sms', inQuietHours: true, freshInboundReply: false, bypassed: true,
  }), false);
});

test('defaults are safe: no args holds nothing, quiet sms holds', () => {
  assert.equal(shouldHoldForQuietHours(), false, 'not in quiet hours by default');
  assert.equal(shouldHoldForQuietHours({ channel: 'sms', inQuietHours: true }), true);
});
