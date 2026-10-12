// 2026-10-12 — LP's webhook and GHL's appointment change each report the same
// cancellation; the second copy must not become "rescue attempt 2".
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { isSameStateRepeat } = await import('../src/actions/handlers/objection-state.js');

const NOW = Date.parse('2026-10-12T16:00:00Z');
const H = 3600000;
const open = (state_code, agoMs) => ({ id: 1, state_code, entered_at: new Date(NOW - agoMs).toISOString() });
const STATE = 'APPOINTMENT_DISRUPTION.cancelled';

test('the same state again within minutes is the same event', () => {
  assert.equal(isSameStateRepeat({ current: open(STATE, 2 * 60000), proposed_state: STATE, nowMs: NOW }), true);
  assert.equal(isSameStateRepeat({ current: open(STATE, 5 * H), proposed_state: STATE, nowMs: NOW }), true);
});

test('the same state after the window is a new attempt', () => {
  assert.equal(isSameStateRepeat({ current: open(STATE, 7 * H), proposed_state: STATE, nowMs: NOW }), false);
});

test('a different state is a real transition', () => {
  assert.equal(isSameStateRepeat({ current: open('APPOINTMENT_DISRUPTION.no_show', 60000), proposed_state: STATE, nowMs: NOW }), false);
});

test('no open row, or an unreadable time, counts as new (fail open)', () => {
  assert.equal(isSameStateRepeat({ current: null, proposed_state: STATE, nowMs: NOW }), false);
  assert.equal(isSameStateRepeat({ current: { state_code: STATE, entered_at: 'garbage' }, proposed_state: STATE, nowMs: NOW }), false);
  assert.equal(isSameStateRepeat({ current: { state_code: STATE, entered_at: new Date(NOW + 60000).toISOString() }, proposed_state: STATE, nowMs: NOW }), false);
});

test('the window can be set', () => {
  assert.equal(isSameStateRepeat({ current: open(STATE, 2 * H), proposed_state: STATE, nowMs: NOW, windowMs: 1 * H }), false);
  assert.equal(isSameStateRepeat({ current: open(STATE, 30 * 60000), proposed_state: STATE, nowMs: NOW, windowMs: 1 * H }), true);
});
