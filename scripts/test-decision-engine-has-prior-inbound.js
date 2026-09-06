/**
 * test-decision-engine-has-prior-inbound.js — the has_prior_inbound context
 * operator and the canvassing engagement gate (decision-engine v2.20,
 * 2026-09-05).
 *
 * Background: over the eight days to 2026-09-05, canvassing contacts opted out
 * of SMS at 14.3% (24 STOPs / 168 texted) while every other source ran 0–12%.
 * Split by engagement, ALL 24 opt-outs came from the 162 contacts who had never
 * sent us anything (14.8%); the 6 who had ever messaged us opted out at 0%.
 * Each opt-out had received exactly one message from us, ever. That is a
 * consent defect at the door, not message fatigue, so the four S5.2 enrollment
 * rules now carry:
 *
 *   any_of: [ {not_has_tag: "active-entry:canvassing"}, {has_prior_inbound: true} ]
 *
 * The properties under test:
 *   - has_prior_inbound passes on a verified inbound and blocks on a verified none;
 *   - an UNREADABLE inbound history (null) FAILS CLOSED and records the rule as
 *     suppressed, per the 2026-07-03 doctrine — we do not text someone we cannot
 *     confirm has talked to us;
 *   - the any_of wrapper short-circuits, so non-canvassing traffic never issues
 *     the inbound lookup at all (no added GHL load on the other ~90% of volume);
 *   - a canvassing contact with no inbound is blocked by the wrapper as a whole.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { _internal } = await import('../src/decision-engine.js');
const { evaluateContextConditions } = _internal;

const CANVASS_TAG = 'active-entry:canvassing';
const GATE = {
  any_of: [
    { not_has_tag: CANVASS_TAG },
    { has_prior_inbound: true },
  ],
};

// ── mocks ───────────────────────────────────────────────────────────

// The inbound-history helper, recording its calls. `result` is the three-valued
// return: true = has inbound, false = verified none, null = unreadable.
function mockPriorInbound(result) {
  const calls = [];
  const fn = async (contactId) => {
    calls.push(contactId);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

// GET /contacts/{id} for the tag reads inside the any_of wrapper.
function mockContactFetch(tags) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ contact: { tags, customFields: [] } }),
    };
  };
  fn.calls = calls;
  return fn;
}

const evt = () => ({ id: 1, event_type: 'ghl.appointment_cancelled', ghl_contact_id: 'c-test', payload: {} });

const D = (priorInbound, contactFetch) => ({
  deps: {
    hasPriorInboundMessage: priorInbound,
    fetch: contactFetch,
    supabase: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }) },
    sleep: async () => {},
  },
});

// ── 1. the bare operator ────────────────────────────────────────────

test('has_prior_inbound: true PASSES when the contact has ever messaged us', async () => {
  const helper = mockPriorInbound(true);
  const event = evt();

  assert.equal(
    await evaluateContextConditions({ has_prior_inbound: true }, {}, event, { ...D(helper), ruleKey: 'ENROLL_S5_2_v2_NO_SHOW_ON_US' }),
    true,
  );
  assert.deepEqual(helper.calls, ['c-test'], 'the gate reads the contact it is gating');
});

test('has_prior_inbound: true BLOCKS a contact with a verified-none inbound history', async () => {
  const helper = mockPriorInbound(false);
  const event = evt();

  assert.equal(
    await evaluateContextConditions({ has_prior_inbound: true }, {}, event, { ...D(helper), ruleKey: 'ENROLL_S5_2_v2_NO_SHOW_ON_US' }),
    false,
  );
  assert.equal(helper.calls.length, 1);
  assert.equal(event._failClosedRules, undefined, 'a verified none is a real answer, not a fail-closed suppression');
});

test('an UNREADABLE inbound history fails CLOSED and records the suppression', async () => {
  const helper = mockPriorInbound(null);
  const event = evt();

  assert.equal(
    await evaluateContextConditions({ has_prior_inbound: true }, {}, event, { ...D(helper), ruleKey: 'ENROLL_S5_2_v2_NO_SHOW_ON_US' }),
    false,
    'if we cannot verify the person ever talked to us, we do not text them',
  );
  // emitConditionFailClosed accumulates the rule key on the event as it emits
  // rule.condition_failed_closed — the observable half of that telemetry.
  assert.ok(event._failClosedRules instanceof Set, 'the fail-closed path ran');
  assert.ok(
    event._failClosedRules.has('ENROLL_S5_2_v2_NO_SHOW_ON_US'),
    'rule.condition_failed_closed names the suppressed rule',
  );
});

test('a missing ghl_contact_id fails closed without calling the helper', async () => {
  const helper = mockPriorInbound(true);
  const event = { id: 2, event_type: 'ghl.appointment_cancelled', payload: {} };

  assert.equal(
    await evaluateContextConditions({ has_prior_inbound: true }, {}, event, { ...D(helper), ruleKey: 'LP_DISP_CANCEL_COLD_TO_S5_2' }),
    false,
  );
  assert.equal(helper.calls.length, 0, 'no contact id means nothing to look up');
});

// ── 2. the any_of canvassing wrapper (the shipped gate) ─────────────

test('a NON-canvassing contact passes the gate WITHOUT any inbound lookup', async () => {
  const helper = mockPriorInbound(false); // would block if it were ever consulted
  const contacts = mockContactFetch(['lp-lead', 'active-entry:web-form']);
  const event = evt();

  assert.equal(
    await evaluateContextConditions(GATE, {}, event, { ...D(helper, contacts), ruleKey: 'GHL_APPT_CANCELLED_REBOOK_COLD' }),
    true,
    'the gate constrains canvassing only — every other source is untouched',
  );
  assert.equal(
    helper.calls.length, 0,
    'any_of short-circuits on not_has_tag: no extra GHL load on non-canvassing traffic',
  );
});

test('a CANVASSING contact with no prior inbound is BLOCKED by the gate', async () => {
  const helper = mockPriorInbound(false);
  const contacts = mockContactFetch(['lp-lead', CANVASS_TAG]);
  const event = evt();

  assert.equal(
    await evaluateContextConditions(GATE, {}, event, { ...D(helper, contacts), ruleKey: 'GHL_APPT_CANCELLED_REBOOK_COLD' }),
    false,
    'no consent signal from the homeowner → confirmer call queue, not an SMS',
  );
  assert.equal(helper.calls.length, 1, 'the canvassing arm falls through to the inbound check');
});

test('a CANVASSING contact who HAS messaged us still enrolls', async () => {
  const helper = mockPriorInbound(true);
  const contacts = mockContactFetch(['lp-lead', CANVASS_TAG]);
  const event = evt();

  assert.equal(
    await evaluateContextConditions(GATE, {}, event, { ...D(helper, contacts), ruleKey: 'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED' }),
    true,
    'the 0/6 cohort — engaged canvassing leads keep their rescue path',
  );
});

test('a CANVASSING contact with an unreadable inbound history is BLOCKED (fail-closed)', async () => {
  const helper = mockPriorInbound(null);
  const contacts = mockContactFetch(['lp-lead', CANVASS_TAG]);
  const event = evt();

  assert.equal(
    await evaluateContextConditions(GATE, {}, event, { ...D(helper, contacts), ruleKey: 'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED' }),
    false,
    'an outage costs missed rescues on one source, never an unconsented text',
  );
});
