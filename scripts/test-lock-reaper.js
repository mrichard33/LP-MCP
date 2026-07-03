/**
 * test-lock-reaper.js — stale agentic-reply-lock predicate
 * (2026-07-03 evening hotfix).
 *
 * The heartbeat sweeps agentic_reply_locks every cycle because lazy
 * TTL-reclaim only happens when a NEW acquirer shows up — in the incident a
 * watchdog-orphaned holder + redeploy-killed timers meant no acquirer ever
 * came, and the in_flight row sat until manual deletion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { isStaleLockRow } = await import('../src/actions/reaper.js');

const NOW = Date.parse('2026-07-03T21:50:00Z');
const iso = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();

test('fresh in_flight row is kept', () => {
  assert.equal(isStaleLockRow({ status: 'in_flight', locked_at: iso(-30) }, NOW, 120), false);
});

test('in_flight row exactly at TTL is kept (strictly-past semantics)', () => {
  assert.equal(isStaleLockRow({ status: 'in_flight', locked_at: iso(-120) }, NOW, 120), false);
});

test('in_flight row past TTL is stale', () => {
  assert.equal(isStaleLockRow({ status: 'in_flight', locked_at: iso(-121) }, NOW, 120), true);
});

test('sent rows are NEVER reaped — they carry the cooldown + sent marker', () => {
  assert.equal(isStaleLockRow({ status: 'sent', locked_at: iso(-9999) }, NOW, 120), false);
});

test('unparseable locked_at on an in_flight row is pathological → stale', () => {
  assert.equal(isStaleLockRow({ status: 'in_flight', locked_at: 'garbage' }, NOW, 120), true);
});

test('missing row is not stale', () => {
  assert.equal(isStaleLockRow(null, NOW, 120), false);
});
