/**
 * test-e0-reentry-dnc-lift.js — E.0 re-entry lifts Five9 DNC (2026-09-21)
 *
 * Mark's ruling: a lead who re-enters through a fresh first-party submission
 * has DNC lifted everywhere, Five9 included. Until now the Five9 arm could
 * not be lifted at all — general removal was deleted 2026-08-21 by ruling —
 * so a re-entered lead was routed, worked, and then silently skipped by the
 * dialer, and DNC_LIFT_ON_REENTRY_E0's own card had to tell the floor to
 * dial manually.
 *
 * The danger in adding this back is obvious, so the tests are mostly about
 * what the op REFUSES. What makes it safe is not a gate a caller can
 * satisfy — it is that the op is welded to one rule and re-proves the
 * consent at execution time:
 *
 *   1. rule_applied must be exactly DNC_LIFT_ON_REENTRY_E0
 *   2. the contact must STILL carry consent:new-submission when it runs
 *   3. the triggering ghl.entry_detected/reentry event must be <= 15 min old
 *
 * Plus: the approval exemption keys on the ACTION's rule_applied, not on the
 * action type, so the exemption cannot be picked up by naming the type.
 *
 * Offline and pure: every I/O seam is injected, and FIVE9_WRITES_ENABLED is
 * left unset so withFive9WriteGate runs in dry-run. Dry-run alone is NOT
 * enough to keep this offline — it short-circuits the WRITE, not the
 * checkDncForNumbers read-back — so that read is injected too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';
delete process.env.FIVE9_WRITES_ENABLED;   // dry-run: guardrails run, the write does not

const {
  executeRemoveNumbersFromDncReentry,
  REENTRY_DNC_LIFT_RULE_KEY,
  REENTRY_CONSENT_TAG,
  REENTRY_MAX_EVENT_AGE_MS,
} = await import('../src/five9/admin-writes.js');

const NOW = Date.parse('2026-09-22T15:00:00.000Z');
const CONTACT = 'qSdA8tKUbfAyCC8pd80n';

const action = (over = {}) => ({
  id: 771,
  action_type: 'five9_remove_numbers_from_dnc_reentry',
  target_id: CONTACT,
  event_id: 4100001,
  rule_applied: REENTRY_DNC_LIFT_RULE_KEY,
  requires_approval: false,
  retry_count: 0,
  action_payload: { numbers_from_contact: true },
  ...over,
});

const freshEvent = {
  id: 4100001, event_type: 'ghl.entry_detected', event_subtype: 'reentry',
  created_at: new Date(NOW - 2 * 60 * 1000).toISOString(),   // 2 min old
};

const deps = (over = {}) => ({
  now: () => NOW,
  readContactTags: async () => [REENTRY_CONSENT_TAG, 'dnc', 'stop-bot'],
  readTriggerEvent: async () => freshEvent,
  resolveContactDncNumbers: async () => ({ numbers: ['8134166946'], sources: { '8134166946': 'ghl_primary' } }),
  // checkDncForNumbers is a LIVE SOAP read that runs even in dry-run, so it
  // MUST be stubbed. Without this the suite reaches Five9 and its result
  // depends on whether FIVE9_USERNAME/PASSWORD happen to be set — green on a
  // machine that has them, red in CI, which does not. That is how this was caught.
  checkDncForNumbers: async (nums) => ({ checked: nums, on_dnc: nums, not_on_dnc: [] }),
  emitEvent: async () => ({ id: 1 }),
  ...over,
});

// ── 1. the happy path ────────────────────────────────────────────────

test('lifts the contact\'s numbers and writes a named audit event', async () => {
  const emitted = [];
  const res = await executeRemoveNumbersFromDncReentry(action(), deps({
    emitEvent: async (e) => { emitted.push(e); return { id: 1 }; },
  }));

  assert.equal(res.numbers_submitted, 1);
  assert.equal(res.event_id, freshEvent.id);

  // The audit event is separate from withFive9WriteGate's generic
  // five9.admin_write row on purpose: a DNC REMOVAL is the one write someone
  // will come looking for by name.
  const audit = emitted.find((e) => e.event_type === 'five9.dnc_removed_reentry');
  assert.ok(audit, 'a DNC removal must be findable by name, not by filtering a generic write log');
  assert.deepEqual(audit.payload.numbers, ['8134166946']);
  assert.equal(audit.payload.consent_tag_seen, true);
  assert.equal(audit.payload.event_id, freshEvent.id);
  assert.equal(audit.payload.rule_applied, REENTRY_DNC_LIFT_RULE_KEY);
});

// ── 2. every refusal ─────────────────────────────────────────────────

test('REFUSES any caller that is not DNC_LIFT_ON_REENTRY_E0', async () => {
  // The whole safety argument rests on this one. General Five9 DNC removal
  // was deleted 2026-08-21 by ruling; this op must not become a way back in.
  for (const ruleApplied of ['DNC_LIFT_ON_REENGAGEMENT_LP', 'BEHAVIORAL_DNC_REPLY', 'MANUAL', null, undefined, '']) {
    await assert.rejects(
      () => executeRemoveNumbersFromDncReentry(action({ rule_applied: ruleApplied }), deps()),
      /REFUSED: five9_remove_numbers_from_dnc_reentry runs only for DNC_LIFT_ON_REENTRY_E0/,
      `rule_applied=${JSON.stringify(ruleApplied)} must be refused`,
    );
  }
});

test('REFUSES when the consent tag is gone by execution time', async () => {
  // The rule checks consent at QUEUE time and removes the tag itself at
  // action priority 200. Queue-time consent is not execution-time consent.
  await assert.rejects(
    () => executeRemoveNumbersFromDncReentry(action(), deps({
      readContactTags: async () => ['dnc', 'stop-bot'],
    })),
    /no longer carries consent:new-submission/,
  );
});

test('REFUSES when the tags cannot be read — unreadable is not absent', async () => {
  await assert.rejects(
    () => executeRemoveNumbersFromDncReentry(action(), deps({ readContactTags: async () => null })),
    /refusing to lift Five9 DNC on an unverified consent/,
  );
});

test('REFUSES a stale re-entry event', async () => {
  // A stale event means the row sat in a queue through an incident or a
  // deploy. Re-consenting on a submission from hours ago is not consent.
  const stale = { ...freshEvent, created_at: new Date(NOW - REENTRY_MAX_EVENT_AGE_MS - 60_000).toISOString() };
  await assert.rejects(
    () => executeRemoveNumbersFromDncReentry(action(), deps({ readTriggerEvent: async () => stale })),
    /is 16 min old \(max 15\)/,
  );
});

test('an event exactly at the age limit is still accepted', async () => {
  const edge = { ...freshEvent, created_at: new Date(NOW - REENTRY_MAX_EVENT_AGE_MS).toISOString() };
  const res = await executeRemoveNumbersFromDncReentry(action(), deps({ readTriggerEvent: async () => edge }));
  assert.equal(res.numbers_submitted, 1);
});

test('REFUSES when the trigger event is missing or is not a re-entry', async () => {
  await assert.rejects(
    () => executeRemoveNumbersFromDncReentry(action(), deps({ readTriggerEvent: async () => null })),
    /no ghl.entry_detected\/reentry event found/,
  );
});

test('REFUSES without a target contact', async () => {
  await assert.rejects(
    () => executeRemoveNumbersFromDncReentry(action({ target_id: null }), deps()),
    /requires action.target_id/,
  );
});

test('a number-resolution failure propagates rather than removing nothing quietly', async () => {
  await assert.rejects(
    () => executeRemoveNumbersFromDncReentry(action(), deps({
      resolveContactDncNumbers: async () => { throw new Error('found no valid phone number'); },
    })),
    /found no valid phone number/,
  );
});

// ── 3. the approval exemption is the RULE's, not the action type's ───

test('the approval exemption keys on rule_applied, not on the action type', async () => {
  const { resolveRequiresApproval } = await import('../src/tools/agent-tools.js');
  const TYPE = 'five9_remove_numbers_from_dnc_reentry';

  const fromTheRule = resolveRequiresApproval(TYPE, false, REENTRY_DNC_LIFT_RULE_KEY);
  assert.equal(fromTheRule.requiresApproval, false, 'the lift must actually happen when the rule queues it');

  // Anyone else naming the same action type is still armed. This is what
  // stops the exemption being a reusable removal capability.
  for (const other of [null, 'MANUAL', 'DNC_LIFT_ON_REENGAGEMENT_FIVE9']) {
    const out = resolveRequiresApproval(TYPE, false, other);
    assert.equal(out.requiresApproval, true, `rule_applied=${other} must stay armed`);
    assert.equal(out.coerced, true);
  }
});

test('the executor refuses an unarmed row queued by the wrong rule', async () => {
  const { executeFive9Write } = await import('../src/actions/handlers/five9.js');
  await assert.rejects(
    () => executeFive9Write({
      action_type: 'five9_remove_numbers_from_dnc_reentry',
      rule_applied: 'MANUAL', requires_approval: false, action_payload: {},
    }),
    /must be queued with requires_approval=true/,
  );
});

test('the op is registered and the OLD general removal still is not', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  assert.equal(typeof ACTION_HANDLERS.five9_remove_numbers_from_dnc_reentry, 'function');
  // The 2026-08-21 ruling stands for the general op. A different action type
  // on purpose: nothing queued against the old name can start working again.
  assert.equal(ACTION_HANDLERS.five9_remove_numbers_from_dnc, undefined,
    'general Five9 DNC removal must stay deleted');
});

// ── 4. the entry route that makes any of this reachable ──────────────

// ── 4. the entry route that makes any of this reachable ──────────────
// DNC_LIFT_ON_REENTRY_E0 has been enabled and DORMANT since 2026-09-21 for
// exactly one reason: /webhook/ghl/entry answered 400 to source=reentry.

const { normalizeEntrySource, VALID_SOURCES } = await import('../src/entry-event-handler.js');

test("'reentry' is accepted and is what E.0 will POST", () => {
  assert.equal(normalizeEntrySource('reentry'), 'reentry');
  assert.ok(VALID_SOURCES.has('reentry'));
});

test('case and whitespace are forgiven — a GHL custom value is not typed', () => {
  assert.equal(normalizeEntrySource('REENTRY'), 'reentry');
  assert.equal(normalizeEntrySource('  ReEntry  '), 'reentry');
});

test('an unknown source is still rejected — reentry did not open the gate', () => {
  for (const bad of ['re-entry', 're_entry', 'reentrys', 'bogus', '', '   ', null, undefined]) {
    assert.equal(normalizeEntrySource(bad), null, `${JSON.stringify(bad)} must not be accepted`);
  }
});

test('the existing sources are untouched', () => {
  for (const s of ['calculator', 'hrr', 'chatbot', 'canvassing', 'referral', 'high_intent_digital', 'manual', 'other']) {
    assert.equal(normalizeEntrySource(s), s);
  }
});

test("'reentry' is deliberately NOT a routing-tag source", async () => {
  // It names an EVENT ("this person came back"), not an entry SOURCE. The
  // contact already has an entry:* lineage from when they first arrived;
  // writing one here would erase the original lead's attribution.
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/entry-event-handler.js', 'utf8'));
  const map = src.slice(src.indexOf('const ROUTING_TAG_MAP'), src.indexOf('export function normalizeEntrySource'));
  assert.ok(!map.includes('reentry'), 'reentry must stay out of ROUTING_TAG_MAP');
});
