/**
 * test-drift-detector-alert-state.js — drift detector edge-triggering (2026-09-05).
 *
 * THE DEFECT. Every 30-minute scan emitted the ENTIRE drift set. The batch
 * emission of 2026-05-13 fixed the SHAPE of the alert — one card instead of 23
 * — but not its repetition, and the idempotency key was the scan minute, which
 * differs on every scan by construction. So a contact that drifted and was
 * never fixed produced 48 cards a day indefinitely: the worst offender by
 * volume among the watchdogs PR #845 catalogued, and the one it named as the
 * follow-on.
 *
 * What is asserted here is that the batch now names only what is NEW, that an
 * ongoing drift set is silent however long it lasts, and — the part that is
 * easy to get wrong — that neither a failed HL fetch nor a broken state table
 * is ever mistaken for "nothing is drifting".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Static imports are hoisted and run before any statement in this file, and
// src/supabase.js reads its credentials at module load — so everything below
// the env block is imported dynamically, or the client would be null and
// drift-detector would short-circuit to "no drift" for the wrong reason.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.GROUPME_BOT_ID = 'test-bot';
process.env.HL_MCP_URL = 'https://hl.test';

const { __setAlertStateClientForTests } = await import('../src/alert-state.js');
const { mockAlertConditions } = await import('./fixtures/alert-conditions-mock.js');

// ─── Harness ─────────────────────────────────────────────────────────
//
// drift-detector reaches two places: HL MCP over fetch, and lp_leads through
// the shared supabase client. Both are stubbed here; alert_conditions gets the
// same in-memory table the rest of the alert suites use.

const emitted = [];
const state = { candidates: [], hlStatus: 200, dispositions: new Map() };

globalThis.fetch = async () => ({
  ok: state.hlStatus === 200,
  status: state.hlStatus,
  json: async () => ({ contacts: state.candidates }),
});

// lp_leads is reached through the shared client. A real client is constructed
// (fake credentials, no call ever leaves the process) and its `from` replaced,
// because drift-detector short-circuits on a null client and would then find
// no drift at all — a test that passes for the wrong reason.
const { default: supabase } = await import('../src/supabase.js');
const lpLeads = {
  select: () => lpLeads,
  eq: (_c, v) => { lpLeads._prospect = String(v); return lpLeads; },
  order: () => lpLeads,
  limit: () => lpLeads,
  maybeSingle: async () => ({ data: state.dispositions.get(lpLeads._prospect) || null }),
};
supabase.from = () => lpLeads;

const { runDriftScan, __resetDriftFallback } = await import('../src/services/drift-detector.js');

// The emitted event IS the card: an agent_rule turns system.drift_batch_detected
// into the GroupMe summary, so counting events is counting cards.
const emit = async (evt) => { emitted.push(evt); return { ok: true }; };
const scan = () => runDriftScan({ emit });

function drifted(...ids) {
  state.candidates = ids.map((id) => ({ contact_id: id, lp_prospect_id: `p-${id}`, closed_at: '2026-09-01T00:00:00Z' }));
  state.dispositions = new Map(
    ids.map((id) => [`p-${id}`, { lp_lead_id: `l-${id}`, disposition_code: 'Set', synced_at: '2026-09-01T00:00:00Z' }]),
  );
}

function reset(rows = new Map()) {
  emitted.length = 0;
  __setAlertStateClientForTests(mockAlertConditions(rows));
  __resetDriftFallback();
  return rows;
}

test('(1) a new drift set is announced once, and an unchanged set stays silent', async () => {
  reset();
  drifted('a', 'b', 'c');

  const first = await scan();
  assert.equal(first.event_emitted, true);
  assert.equal(first.new_drift, 3);
  assert.equal(emitted.length, 1, 'one batch card, not one per contact');
  assert.equal(emitted[0].payload.drift_count, 3);

  // 24 more scans = 12 hours. The old code posted 24 more identical cards.
  for (let i = 0; i < 24; i++) {
    const again = await scan();
    assert.equal(again.event_emitted, false, `scan ${i + 2} must emit nothing`);
    assert.equal(again.drift, 3, 'the drift itself is still reported in the result');
  }
  assert.equal(emitted.length, 1, 'one unresolved drift set is one card, not 25');
});

test('(2) a newly drifted contact produces a batch naming only that contact', async () => {
  reset();
  drifted('a', 'b');
  await scan();
  emitted.length = 0;

  drifted('a', 'b', 'c');
  const res = await scan();
  assert.equal(res.event_emitted, true);
  assert.equal(res.new_drift, 1);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].payload.drift_details.map((d) => d.contact_id), ['c']);
  assert.equal(emitted[0].payload.drift_count, 1, 'the card counts what it announces');
  assert.equal(emitted[0].payload.total_drift_count, 3, 'the payload still describes the whole problem');
});

test('(3) a resolved contact clears silently', async () => {
  reset();
  drifted('a', 'b');
  await scan();
  emitted.length = 0;

  drifted('a');                       // b's LP disposition was fixed
  const res = await scan();
  assert.equal(res.event_emitted, false, 'a resolution is not an alert');
  assert.equal(res.cleared_drift, 1);
  assert.equal(emitted.length, 0);
});

test('(4) a fully resolved scan clears everything and emits nothing', async () => {
  reset();
  drifted('a', 'b');
  await scan();
  emitted.length = 0;

  drifted();                          // nothing left
  const res = await scan();
  assert.equal(res.drift, 0);
  assert.equal(res.cleared_drift, 2, 'an empty scan must still run the clearing pass');
  assert.equal(emitted.length, 0);
});

test('(5) a contact that drifts again after being fixed is a NEW incident', async () => {
  reset();
  drifted('a');
  await scan();
  drifted();
  await scan();
  emitted.length = 0;

  drifted('a');
  const res = await scan();
  assert.equal(res.event_emitted, true, 'a relapse must alert again');
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].payload.drift_details.map((d) => d.contact_id), ['a']);
});

test('(6) survives a restart — a live drift set is not re-announced', async () => {
  const rows = reset();
  drifted('a', 'b');
  await scan();
  assert.equal(emitted.length, 1);

  // A redeploy: new client instance over the same durable rows.
  reset(rows);
  const after = await scan();
  assert.equal(after.event_emitted, false, 'a redeploy must not re-announce live drift');
  assert.equal(emitted.length, 0);
});

test('(7) a failed HL fetch skips the scan — it must NEVER read as "nothing drifted"', async () => {
  const rows = reset();
  drifted('a', 'b');
  await scan();
  emitted.length = 0;

  state.hlStatus = 500;
  const res = await scan();
  state.hlStatus = 200;

  assert.equal(res.success, false);
  assert.equal(res.event_emitted, false);
  assert.equal(rows.get('drift:ghl_closed_lp_active:a').state, 'firing',
    'clearing on a failed fetch would re-announce everything on the next good scan');
  assert.equal(rows.get('drift:ghl_closed_lp_active:b').state, 'firing');
});

test('(8) an unusable state table falls back to the full batch, rate-limited', async () => {
  emitted.length = 0;
  __setAlertStateClientForTests(mockAlertConditions(new Map(), { fail: 'select' }));
  __resetDriftFallback();
  drifted('a', 'b', 'c');

  const first = await scan();
  assert.equal(first.event_emitted, true, 'firing fails OPEN — a broken table must not silence drift');
  assert.equal(first.alert_state, 'read_failed');
  assert.equal(emitted[0].payload.drift_count, 3, 'without per-contact state the only safe emission is the whole set');

  // But bounded: the 6h fallback cooldown, not a card every 30 minutes.
  for (let i = 0; i < 5; i++) {
    assert.equal((await scan()).event_emitted, false, 'the degraded path must not restore the storm');
  }
  assert.equal(emitted.length, 1);
});

test.after(() => { __setAlertStateClientForTests(null); });
