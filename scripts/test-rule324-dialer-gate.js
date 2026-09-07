/**
 * scripts/test-rule324-dialer-gate.js — the HOT_CALL_IMMEDIATE (#324)
 * condition object shipped in
 * sql/seeds/2026-09-07_rule324_escalate_to_rep_dialer_push.sql, evaluated
 * through the engine's real evaluateContextConditions.
 *
 * Properties under test:
 *   - callback_request + phone_call still pushes for a prospect (no regression);
 *   - escalate_to_rep with NO escalation_category pushes for a prospect and a
 *     returning customer (Shawn's post-fix shape);
 *   - a service_customer NEVER pushes, on either branch;
 *   - a categorized escalation (legal_media, existing_customer_service, …)
 *     never pushes;
 *   - a legacy event with no customer_relationship FAILS CLOSED — this is the
 *     documented reason the seed must land after the analyzer deploy;
 *   - stop-bot still wins.
 *
 * Run: node --test scripts/test-rule324-dialer-gate.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { _internal } = await import('../src/decision-engine.js');
const { evaluateContextConditions } = _internal;

// EXACT object the seed writes. Keep in sync with the SQL.
const GATE = {
  not_has_tag: 'stop-bot',
  payload_field_in: { field: 'customer_relationship', values: ['prospect', 'returning_customer'] },
  any_of: [
    { recommended_action_eq: 'callback_request',
      payload_field_eq: { field: 'requested_fulfillment', value: 'phone_call' } },
    { recommended_action_eq: 'escalate_to_rep',
      payload_field_null: 'escalation_category' },
  ],
};

// GET /contacts/{id} for the not_has_tag read.
function mockContactFetch(tags) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ contact: { tags, customFields: [] } }),
  });
}

const D = (tags = ['lp-lead']) => ({
  deps: {
    fetch: mockContactFetch(tags),
    hasPriorInboundMessage: async () => true,
    supabase: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }) },
    sleep: async () => {},
  },
  ruleKey: 'HOT_CALL_IMMEDIATE',
});

let seq = 0;
const evt = (payload) => ({
  id: ++seq,
  event_type: 'ai.analysis_completed',
  ghl_contact_id: 'c-test',
  payload,
});

const ev = (payload, tags) => evaluateContextConditions(GATE, {}, evt(payload), D(tags));

// ── branch 1: calm callback request (existing behavior, now relationship-gated)

test('prospect + callback_request + phone_call → PUSH (no regression)', async () => {
  assert.equal(await ev({
    recommended_action: 'callback_request', requested_fulfillment: 'phone_call',
    escalation_category: null, customer_relationship: 'prospect',
  }), true);
});

test('returning_customer + callback_request + phone_call → PUSH', async () => {
  assert.equal(await ev({
    recommended_action: 'callback_request', requested_fulfillment: 'phone_call',
    escalation_category: null, customer_relationship: 'returning_customer',
  }), true);
});

test('service_customer + callback_request + phone_call → NO PUSH (CS never to dialer)', async () => {
  assert.equal(await ev({
    recommended_action: 'callback_request', requested_fulfillment: 'phone_call',
    escalation_category: null, customer_relationship: 'service_customer',
  }), false);
});

test('prospect + callback_request WITHOUT phone_call → NO PUSH (branch 1 still requires it)', async () => {
  assert.equal(await ev({
    recommended_action: 'callback_request', requested_fulfillment: 'in_home_estimate',
    escalation_category: null, customer_relationship: 'prospect',
  }), false);
});

// ── branch 2: plain sales escalation (new)

test('prospect + escalate_to_rep + null category → PUSH (Shawn, post-fix)', async () => {
  assert.equal(await ev({
    recommended_action: 'escalate_to_rep', requested_fulfillment: 'in_home_estimate',
    escalation_category: null, customer_relationship: 'prospect',
  }), true);
});

test('returning_customer + escalate_to_rep + null category → PUSH (the 92)', async () => {
  assert.equal(await ev({
    recommended_action: 'escalate_to_rep', requested_fulfillment: 'in_home_estimate',
    escalation_category: null, customer_relationship: 'returning_customer',
  }), true);
});

test('service_customer + escalate_to_rep + null category → NO PUSH', async () => {
  assert.equal(await ev({
    recommended_action: 'escalate_to_rep', requested_fulfillment: 'unspecified',
    escalation_category: null, customer_relationship: 'service_customer',
  }), false);
});

test('categorized escalations never push, on any relationship', async () => {
  for (const cat of ['existing_customer_service', 'legal_media', 'billing', 'contract_change',
                     'identity_ambiguous', 'compliance_adjacent', 'commercial_hoa']) {
    for (const rel of ['prospect', 'returning_customer']) {
      assert.equal(await ev({
        recommended_action: 'escalate_to_rep', requested_fulfillment: 'unspecified',
        escalation_category: cat, customer_relationship: rel,
      }), false, `${cat} / ${rel} must not push`);
    }
  }
});

// ── fail-closed + kill switch

test('legacy event with NO customer_relationship → NO PUSH (fails closed; seed must land after analyzer)', async () => {
  assert.equal(await ev({
    recommended_action: 'callback_request', requested_fulfillment: 'phone_call',
    escalation_category: null,
  }), false);
});

test('stop-bot tag wins on both branches', async () => {
  assert.equal(await ev({
    recommended_action: 'callback_request', requested_fulfillment: 'phone_call',
    escalation_category: null, customer_relationship: 'prospect',
  }, ['lp-lead', 'stop-bot']), false);
  assert.equal(await ev({
    recommended_action: 'escalate_to_rep', requested_fulfillment: 'unspecified',
    escalation_category: null, customer_relationship: 'prospect',
  }, ['lp-lead', 'stop-bot']), false);
});
