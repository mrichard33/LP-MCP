/**
 * scripts/test-send-delivery-verify.js
 *
 * Drives verifyRecentSends (src/services/send-delivery-verify.js) — the
 * reconciler that re-reads recently-completed sends against GHL and flips the
 * ones the carrier rejected.
 *
 * WHY THIS SUITE EXISTS (2026-09-25). The recovery decisions
 * (src/agentic/carrier-resend.js) and the runner (carrier-resend-runner.js)
 * were both well covered. The GLUE between them was not — nothing imported this
 * module. That glue owns the two things a carrier incident turns on:
 *
 *   1. WHICH ROW the runner is handed. It must already carry delivery_verified
 *      and delivery_status, because the runner's idempotency stamp is written
 *      onto whatever it receives. Hand it the stale row and the stamp loses the
 *      verification.
 *   2. WHICH EVENT fires. Exactly one of send_recovered_after_block /
 *      send_delivery_failed, never both and never neither. Emitting the wrong
 *      one either pages a human for a send that recovered, or — far worse —
 *      files nothing for a lead the bot went silent on.
 *
 * The fail-open cases matter just as much: a GHL lookup that ERRORS is not
 * evidence of a failed send, and must never flip a row to failed.
 *
 * No network, no env, no clock — everything through the deps seam.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyRecentSends } from '../src/services/send-delivery-verify.js';

console.warn = () => {};
console.log = () => {};

const ROW = {
  id: 487694,
  target_id: 'hZOcPk6XmMvWVvjZJ7mz',
  executed_at: '2026-09-22T18:04:00.000Z',
  execution_result: {
    message_id: 'ghmZnX5TZjeFeagYwaaR',
    sent_body: "we can't take Bitcoin directly, but our team has other financing options",
  },
};

/**
 * Minimal supabase double. Records every update so a test can assert what was
 * written — and, just as importantly, that nothing was written when the
 * reconciler could not tell.
 */
function fakeSupabase(rows) {
  const updates = [];
  const client = {
    updates,
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        gte: () => q,
        lte: () => q,
        order: () => q,
        limit: async () => ({ data: rows, error: null }),
        update(patch) {
          updates.push(patch);
          const u = { eq: () => u, then: (res) => res({ error: null }) };
          return u;
        },
      };
      return q;
    },
  };
  return client;
}

function harness({ rows = [ROW], status = 'failed', recovery = { queued: false, reason: 'no_carrier_risk_term' }, ghlThrows = false } = {}) {
  const events = [];
  const handed = [];
  const supabase = fakeSupabase(rows);
  const deps = {
    supabase,
    ghlFetch: async () => {
      if (ghlThrows) throw new Error('ECONNRESET');
      return { message: { status } };
    },
    emitEvent: async (e) => { events.push(e); return { id: 1 }; },
    attemptCarrierResend: async (row) => {
      handed.push(row);
      if (recovery instanceof Error) throw recovery;
      return recovery;
    },
  };
  return { deps, events, handed, supabase };
}

// ── the row handed to the runner ──────────────────────────────────────────

test('the runner is handed the VERIFIED row, not the stale one', async () => {
  // The runner stamps its idempotency record onto the row it receives. If that
  // row predates the verification, the stamp overwrites delivery_verified back
  // to absent and the next pass re-checks a row it already decided.
  const { deps, handed } = harness({ status: 'undelivered' });
  await verifyRecentSends(deps);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].execution_result.delivery_verified, true);
  assert.equal(handed[0].execution_result.delivery_status, 'undelivered');
  assert.equal(handed[0].execution_result.sent_body, ROW.execution_result.sent_body, 'the body must survive — the runner needs it to detect the blocked term');
});

// ── exactly one event ─────────────────────────────────────────────────────

test('a recovered send emits ONLY send_recovered_after_block — no human task', async () => {
  const { deps, events } = harness({ recovery: { queued: true, reason: 'queued', newActionId: 999 } });
  const out = await verifyRecentSends(deps);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'agentic.send_recovered_after_block');
  assert.equal(events[0].payload.resend_action_id, 999);
  assert.equal(events[0].priority, 'normal', 'a send that recovered is not a page');
  assert.equal(out.flagged, 1);
});

test('an unrecovered send emits ONLY send_delivery_failed, carrying the refusal reason', async () => {
  const { deps, events } = harness({ recovery: { queued: false, reason: 'inbound_since_send' } });
  await verifyRecentSends(deps);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'agentic.send_delivery_failed');
  assert.equal(events[0].payload.resend_outcome, 'inbound_since_send');
  assert.equal(events[0].priority, 'high');
  assert.equal(events[0].bypass_filter, true, 'the escalation rule only sees it if it bypasses the intake filter');
});

test('a resend that THROWS still files the failure — a crash must not silence the alert', async () => {
  // The whole point of the catch in send-delivery-verify: recovery is
  // best-effort, escalation is not.
  const { deps, events } = harness({ recovery: new Error('boom') });
  await verifyRecentSends(deps);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'agentic.send_delivery_failed');
  assert.equal(events[0].payload.resend_outcome, 'threw');
});

// ── fail-open: "could not tell" is never "failed" ─────────────────────────

test('a GHL lookup error counts unknown and writes NOTHING', async () => {
  const { deps, events, supabase, handed } = harness({ ghlThrows: true });
  const out = await verifyRecentSends(deps);
  assert.equal(out.unknown, 1);
  assert.equal(out.flagged, 0);
  assert.equal(events.length, 0, 'a read that failed is not evidence of a failed send');
  assert.equal(handed.length, 0);
  assert.equal(supabase.updates.length, 0, 'the row must not be touched');
});

test('an empty status counts unknown rather than guessing', async () => {
  const { deps, events, supabase } = harness({ status: '' });
  const out = await verifyRecentSends(deps);
  assert.equal(out.unknown, 1);
  assert.equal(events.length, 0);
  assert.equal(supabase.updates.length, 0);
});

// ── the healthy case ──────────────────────────────────────────────────────

test('a delivered send is stamped and emits nothing', async () => {
  const { deps, events, supabase, handed } = harness({ status: 'delivered' });
  const out = await verifyRecentSends(deps);
  assert.equal(out.confirmed, 1);
  assert.equal(out.flagged, 0);
  assert.equal(events.length, 0);
  assert.equal(handed.length, 0, 'no carrier recovery on a send that landed');
  assert.equal(supabase.updates.length, 1);
  assert.equal(supabase.updates[0].execution_result.delivery_verified, true);
  assert.equal(supabase.updates[0].execution_result.delivery_status, 'delivered');
  assert.equal(supabase.updates[0].status, undefined, 'a delivered send is never flipped');
});

// ── rows the reconciler must skip ─────────────────────────────────────────

test('rows with no message id, or already verified, or deduped are skipped', async () => {
  const rows = [
    { ...ROW, id: 1, execution_result: { sent_body: 'x' } },                          // no message_id
    { ...ROW, id: 2, execution_result: { ...ROW.execution_result, delivery_verified: true } },
    { ...ROW, id: 3, execution_result: { ...ROW.execution_result, deduped_prior_send: true } },
  ];
  const { deps, events, supabase } = harness({ rows });
  const out = await verifyRecentSends(deps);
  assert.equal(out.checked, 0);
  assert.equal(events.length, 0);
  assert.equal(supabase.updates.length, 0);
});

test('every failure status GHL can report is treated as a failure', async () => {
  for (const status of ['failed', 'undelivered', 'rejected', 'error']) {
    const { deps, events } = harness({ status });
    const out = await verifyRecentSends(deps);
    assert.equal(out.flagged, 1, `${status} must flag`);
    assert.equal(events[0].payload.delivery_status, status);
  }
});

test('SEND_VERIFY_ENABLED=false is a full stop — no query, no event', async () => {
  const prior = process.env.SEND_VERIFY_ENABLED;
  process.env.SEND_VERIFY_ENABLED = 'false';
  try {
    const { deps, events, supabase } = harness();
    const out = await verifyRecentSends(deps);
    assert.deepEqual(out, { skipped: true, reason: 'disabled' });
    assert.equal(events.length, 0);
    assert.equal(supabase.updates.length, 0);
  } finally {
    if (prior === undefined) delete process.env.SEND_VERIFY_ENABLED;
    else process.env.SEND_VERIFY_ENABLED = prior;
  }
});
