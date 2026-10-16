// Dynamic Hold callbacks with a blank return_to (2026-10-16).
//
// GHL's "Post Hold Complete to LP MCP" step sent return_to blank on every
// callback (Amelia Gazzaroli Hasak, 2026-10-16: 200 {"ok":false,"error":
// "return_to required"}), so no hold ever completed. These cover the recovery
// from our own issue_hold row and the shadow / live gate around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MESSAGE_ENGINE_TOKEN = process.env.MESSAGE_ENGINE_TOKEN || 'test-token';

const {
  pickEndedHold, recoverHoldTarget, completionEventType, holdRecoveryMode,
} = await import('../src/agentic/hold-target.js');
const { registerHoldCompleteRoutes } = await import('../src/agentic/hold-complete.js');

const H = 3_600_000;
const NOW = Date.parse('2026-10-16T15:40:48Z');

function hold({ id = 1, issuedAgoH, hours, returnTo = 'follow_up_due', action = 'hold_issued' }) {
  const issued = new Date(NOW - issuedAgoH * H).toISOString();
  return {
    id,
    created_at: issued,
    executed_at: issued,
    action_payload: { hold_hours: hours, return_to: returnTo, hold_reason: 'Follow-up promise', workflow_code: 'FOLLOW_UP' },
    execution_result: action === 'hold_issued'
      ? { action, return_to: returnTo, hold_hours: hours, hold_reason: 'Follow-up promise', workflow_code: 'FOLLOW_UP' }
      : { action, reason: 'active_hold_exists', return_to: returnTo },
  };
}

test('the hold due now is picked (Amelia: issued 2160h ago)', () => {
  const picked = pickEndedHold([hold({ id: 211709, issuedAgoH: 2160, hours: 2160 })], NOW);
  assert.equal(picked.action_id, 211709);
  assert.equal(picked.return_to, 'follow_up_due');
  assert.equal(picked.hold_hours, 2160);
});

test('a hold not due yet, one long past, and a serialized skip are never picked', () => {
  assert.equal(pickEndedHold([hold({ issuedAgoH: 10, hours: 336 })], NOW), null);
  assert.equal(pickEndedHold([hold({ issuedAgoH: 400, hours: 336 })], NOW), null);
  assert.equal(pickEndedHold([hold({ issuedAgoH: 168, hours: 168, action: 'issue_hold_skipped_serialized' })], NOW), null);
});

test('with a newer hold still running, the older one that is due is picked', () => {
  const picked = pickEndedHold([
    hold({ id: 2, issuedAgoH: 1, hours: 72, returnTo: 'cannot_afford_hold_complete' }),
    hold({ id: 1, issuedAgoH: 168.2, hours: 168 }),
  ], NOW);
  assert.equal(picked.action_id, 1);
  assert.equal(picked.return_to, 'follow_up_due');
});

test('return_to in the body is used as is', () => {
  const r = recoverHoldTarget({ body: { return_to: ' booking_push_timeout_s13 ' }, holds: [hold({ issuedAgoH: 72, hours: 72 })], nowMs: NOW });
  assert.deepEqual([r.returnTo, r.source], ['booking_push_timeout_s13', 'body']);
});

test('the contact field GHL may send wins over our record', () => {
  const r = recoverHoldTarget({ body: { return_to: '', hold_return_target: 'renter_recheck' }, nowMs: NOW });
  assert.deepEqual([r.returnTo, r.source], ['renter_recheck', 'body_field']);
});

test('a blank return_to is recovered from the issued hold', () => {
  const r = recoverHoldTarget({ body: { return_to: '' }, holds: [hold({ issuedAgoH: 336, hours: 336 })], nowMs: NOW });
  assert.deepEqual([r.returnTo, r.source], ['follow_up_due', 'issued_hold']);
});

test('nothing to recover from → refused', () => {
  const r = recoverHoldTarget({ body: {}, holds: [], nowMs: NOW });
  assert.equal(r.returnTo, '');
  assert.equal(r.source, null);
});

test('mode: shadow by default; recovered holds emit the real event only in live', () => {
  assert.equal(holdRecoveryMode({}), 'shadow');
  assert.equal(holdRecoveryMode({ HOLD_RETURN_RECOVERY_MODE: 'LIVE' }), 'live');
  assert.equal(holdRecoveryMode({ HOLD_RETURN_RECOVERY_MODE: 'nonsense' }), 'shadow');
  for (const mode of ['off', 'shadow', 'live']) {
    assert.equal(completionEventType({ source: 'body', mode }), 'agentic.hold_completed');
  }
  assert.equal(completionEventType({ source: 'issued_hold', mode: 'live' }), 'agentic.hold_completed');
  assert.equal(completionEventType({ source: 'issued_hold', mode: 'shadow' }), 'agentic.hold_completed_shadow');
  assert.equal(completionEventType({ source: 'issued_hold', mode: 'off' }), null);
  assert.equal(completionEventType({ source: null, mode: 'live' }), null);
});

// ── The route, end to end with fakes ─────────────────────────────────
function routeWith({ env, holds = [], readFails = false }) {
  const handlers = {};
  const app = { post: (path, fn) => { handlers[path] = fn; } };
  const events = [];
  let reads = 0;
  registerHoldCompleteRoutes(app, {
    env,
    emitEvent: async (e) => { events.push(e); },
    readRecentHolds: async () => { reads += 1; if (readFails) throw new Error('db down'); return holds; },
  });
  async function call(body) {
    const req = { path: '/api/agentic/hold-complete', headers: { authorization: `Bearer ${process.env.MESSAGE_ENGINE_TOKEN}` }, body, query: {} };
    let out;
    const res = { status() { return this; }, json(b) { out = b; return this; } };
    await handlers['/api/agentic/hold-complete'](req, res);
    return out;
  }
  return { call, events, reads: () => reads };
}

const dueHold = () => {
  const h = hold({ id: 562972, issuedAgoH: 168, hours: 168 });
  // The route uses the real clock: re-anchor the hold to now.
  const issued = new Date(Date.now() - 168 * H).toISOString();
  return { ...h, created_at: issued, executed_at: issued };
};

test('route, shadow: a blank return_to emits only the shadow event', async () => {
  const r = routeWith({ env: {}, holds: [dueHold()] });
  const out = await r.call({ contact_id: 'ep4xYxztbefMvSCwEKbQ', return_to: '', hold_hours: '' });
  assert.equal(out.ok, true);
  assert.equal(out.emitted, 'agentic.hold_completed_shadow');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].event_type, 'agentic.hold_completed_shadow');
  assert.equal(r.events[0].event_subtype, 'follow_up_due');
  assert.equal(r.events[0].bypass_filter, true);
  assert.equal(r.events[0].payload.hold_action_id, 562972);
  assert.equal(r.events[0].payload.hold_hours, 168);
});

test('route, live: a blank return_to emits the real event', async () => {
  const r = routeWith({ env: { HOLD_RETURN_RECOVERY_MODE: 'live' }, holds: [dueHold()] });
  const out = await r.call({ contact_id: 'ep4xYxztbefMvSCwEKbQ', return_to: '' });
  assert.equal(out.emitted, 'agentic.hold_completed');
  assert.equal(r.events[0].event_type, 'agentic.hold_completed');
  assert.equal(r.events[0].bypass_filter, undefined);
  assert.equal(r.events[0].payload.return_to_source, 'issued_hold');
});

test('route: a callback that carries return_to is unchanged and reads nothing', async () => {
  const r = routeWith({ env: {}, holds: [dueHold()] });
  const out = await r.call({ contact_id: 'c1', return_to: 'booking_push_timeout_s13' });
  assert.equal(out.emitted, 'agentic.hold_completed');
  assert.equal(r.reads(), 0);
  assert.equal(r.events[0].event_type, 'agentic.hold_completed');
});

test('route: off, nothing due, or a failed read → refused as before, nothing emitted', async () => {
  for (const opts of [
    { env: { HOLD_RETURN_RECOVERY_MODE: 'off' }, holds: [dueHold()] },
    { env: { HOLD_RETURN_RECOVERY_MODE: 'live' }, holds: [] },
    { env: { HOLD_RETURN_RECOVERY_MODE: 'live' }, readFails: true },
  ]) {
    const r = routeWith(opts);
    const out = await r.call({ contact_id: 'c1', return_to: '' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'return_to required');
    assert.equal(r.events.length, 0);
  }
});
