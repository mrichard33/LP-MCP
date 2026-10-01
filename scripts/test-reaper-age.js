/**
 * Reaper age per action type (2026-10-01, Dan H. action 532106). A customer
 * reply killed by a deploy is retried once its own watchdog has passed, not
 * after the generic 10 minutes; every other type keeps 10 minutes.
 *
 * Run: node --test scripts/test-reaper-age.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { reaperAgeMsFor, isStuckExecuting, REAPER_AGE_MS, SEND_MESSAGE_REAP_MARGIN_MS } = await import('../src/actions/reaper.js');
const { resolveHandlerTimeoutMs } = await import('../src/actions/index.js');

const WATCHDOG = resolveHandlerTimeoutMs('send_message');

test('send_message is reaped after its own watchdog + margin; everything else after 10 minutes', () => {
  assert.equal(REAPER_AGE_MS, 10 * 60 * 1000);
  assert.equal(reaperAgeMsFor('send_message', { sendMessageWatchdogMs: WATCHDOG }), WATCHDOG + SEND_MESSAGE_REAP_MARGIN_MS);
  assert.ok(WATCHDOG + SEND_MESSAGE_REAP_MARGIN_MS < REAPER_AGE_MS, 'a reply is recovered well before the generic 10 minutes');
  for (const t of ['create_task', 'create_lp_lead', 'add_tag', 'send_notification']) {
    assert.equal(reaperAgeMsFor(t, { sendMessageWatchdogMs: WATCHDOG }), REAPER_AGE_MS, t);
  }
  assert.equal(reaperAgeMsFor('send_message'), REAPER_AGE_MS, 'no watchdog passed in → the old 10 minutes');
  assert.equal(reaperAgeMsFor('send_message', { sendMessageWatchdogMs: 30 * 60 * 1000 }), REAPER_AGE_MS, 'never LONGER than 10 minutes');
});

test('the age is never shorter than the watchdog: a live handler is never reaped', () => {
  const now = Date.parse('2026-10-01T21:20:00Z');
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  const opts = { sendMessageWatchdogMs: WATCHDOG };
  assert.equal(isStuckExecuting({ action_type: 'send_message', updated_at: at(WATCHDOG) }, now, opts), false, 'at the watchdog, the handler may still be finishing');
  assert.equal(isStuckExecuting({ action_type: 'send_message', updated_at: at(WATCHDOG + SEND_MESSAGE_REAP_MARGIN_MS + 1000) }, now, opts), true);
  assert.equal(isStuckExecuting({ action_type: 'add_tag', updated_at: at(WATCHDOG + SEND_MESSAGE_REAP_MARGIN_MS + 1000) }, now, opts), false, 'other types still wait 10 minutes');
  assert.equal(isStuckExecuting({ action_type: 'add_tag', updated_at: at(REAPER_AGE_MS + 1000) }, now, opts), true);
  assert.equal(isStuckExecuting({ action_type: 'send_message', updated_at: null }, now, opts), false, 'an unreadable time is not stuck');
});

test('Dan H. (action 532106): claimed 21:13:08Z, process killed 21:13:20Z → recovered by ~21:16Z, not 21:23Z', () => {
  const row = { action_type: 'send_message', updated_at: '2026-10-01T21:13:08.941Z' };
  const opts = { sendMessageWatchdogMs: WATCHDOG };
  assert.equal(isStuckExecuting(row, Date.parse('2026-10-01T21:15:00Z'), opts), false);
  assert.equal(isStuckExecuting(row, Date.parse('2026-10-01T21:16:30Z'), opts), true);
});
