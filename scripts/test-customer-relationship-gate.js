/**
 * scripts/test-customer-relationship-gate.js
 *
 * Regression coverage for the 2026-09-07 customer-relationship fix (Shawn
 * Friend, contact 19zXvwBKo8RISXbafGHC, event 3460420).
 *
 * Four quadrants of (has_prior_sale × open_sales_lead), the SERVICE_ISSUE_REGEX
 * boundary, and deriveCustomerRelationship() against the real shapes:
 *   - a prospect with CXL (Shawn)
 *   - a returning customer: Sale row, then a NEWER CXL-with-appointment row
 *     (92 of these in the last 180 days)
 *   - a service customer: Sale row is the newest thing on record
 *   - tag-only customer (p2-stage:*) with no LP rows
 *
 * Run: node --test scripts/test-customer-relationship-gate.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCustomerRelationshipGate,
  SERVICE_ISSUE_REGEX,
} from '../src/message-analyzer.js';
import {
  deriveCustomerRelationship,
  SERVICE_SIDE_DISPOSITIONS,
} from '../src/context-builder.js';

// ── fixtures ──────────────────────────────────────────────────────────

const csAnalysis = () => ({
  buyer_stage: 4,
  buyer_stage_confidence: 0.8,
  objection_type: 'trust',
  objection_confidence: 0.9,
  buying_signals: [],
  emotional_state: 'anger',
  engagement_quality: 'meaningful',
  fast_track_eligible: false,
  recommended_story_arc: null,
  recommended_action: 'escalate_to_rep',
  dq_detected: null,
  requested_fulfillment: 'in_home_estimate',
  escalation_category: 'existing_customer_service',
  guide_type: null,
  follow_up_bucket: null,
  call_purpose: null,
  reasoning: 'fixture',
});

const ctx = (customer_relationship) => ({
  lead: { current_tags: [] },
  lp: { matched: true, customer_relationship },
  conversation_recent: [],
});

// Representative of event 3460420 (prospect, cancelled sales appointment,
// no service language). Pull the real text with:
//   SELECT payload->>'message_text' FROM system_events WHERE id = 3460420;
const SHAWN_MSG =
  'We came back from vacation early for this appointment and nobody showed up ' +
  'and nobody called. This is unacceptable. I need someone to call me today and ' +
  'reschedule the estimate.';

const RETURNING_APPT_MSG =
  'You guys did our front windows last year. We booked you for the back of the ' +
  'house and the appointment got cancelled with no explanation. What happened?';

const WARRANTY_MSG =
  'The windows you installed last year are leaking at the bottom corner when ' +
  'it rains. I need a warranty service call.';

// ── gate: four quadrants ──────────────────────────────────────────────

test('prospect: existing_customer_service is cleared (Shawn quadrant)', () => {
  const out = applyCustomerRelationshipGate(csAnalysis(), SHAWN_MSG, ctx('prospect'), 'test');
  assert.equal(out.escalation_category, null);
  assert.equal(out.recommended_action, 'escalate_to_rep', 'action is not changed by the gate');
});

test('prospect: cleared even when the message contains service words', () => {
  const out = applyCustomerRelationshipGate(csAnalysis(), WARRANTY_MSG, ctx('prospect'), 'test');
  assert.equal(out.escalation_category, null, 'a prospect cannot be a service customer no matter what they say');
});

test('returning_customer: appointment complaint on the NEW lead is cleared (sales)', () => {
  const out = applyCustomerRelationshipGate(csAnalysis(), RETURNING_APPT_MSG, ctx('returning_customer'), 'test');
  assert.equal(out.escalation_category, null);
});

test('returning_customer: warranty complaint on the OLD work stands', () => {
  const out = applyCustomerRelationshipGate(csAnalysis(), WARRANTY_MSG, ctx('returning_customer'), 'test');
  assert.equal(out.escalation_category, 'existing_customer_service');
});

test('service_customer: untouched regardless of wording', () => {
  const a = applyCustomerRelationshipGate(csAnalysis(), SHAWN_MSG, ctx('service_customer'), 'test');
  assert.equal(a.escalation_category, 'existing_customer_service');
  const b = applyCustomerRelationshipGate(csAnalysis(), WARRANTY_MSG, ctx('service_customer'), 'test');
  assert.equal(b.escalation_category, 'existing_customer_service');
});

test('missing relationship defaults to prospect (fail closed on the CS label)', () => {
  const out = applyCustomerRelationshipGate(csAnalysis(), SHAWN_MSG, { lp: {} }, 'test');
  assert.equal(out.escalation_category, null);
});

test('other escalation categories pass through untouched', () => {
  for (const cat of ['legal_media', 'billing', 'contract_change', 'identity_ambiguous', null]) {
    const a = { ...csAnalysis(), escalation_category: cat };
    const out = applyCustomerRelationshipGate(a, SHAWN_MSG, ctx('prospect'), 'test');
    assert.equal(out.escalation_category, cat);
  }
});

test('gate tolerates null analysis', () => {
  assert.equal(applyCustomerRelationshipGate(null, SHAWN_MSG, ctx('prospect'), 'test'), null);
});

// ── SERVICE_ISSUE_REGEX boundary ──────────────────────────────────────

test('SERVICE_ISSUE_REGEX matches installed-product / service language', () => {
  const hits = [
    'the windows are leaking',
    'is this covered under warranty',
    'the slider won\'t lock',
    'one pane is fogging up',
    'need a service call',
    'the install team left the trim crooked',
    'my final payment / balance due',
    'the seals failed on two units',
  ];
  for (const s of hits) assert.ok(SERVICE_ISSUE_REGEX.test(s), `expected match: "${s}"`);
});

test('SERVICE_ISSUE_REGEX does NOT match sales-appointment complaints', () => {
  const misses = [
    SHAWN_MSG,
    RETURNING_APPT_MSG,
    'nobody showed up for the estimate',
    'you cancelled my appointment',
    'I want to reschedule the quote visit',
    'how much longer do I have to wait',
    'we want to install windows in the back of the house',   // "install" alone is a sales word
  ];
  for (const s of misses) assert.ok(!SERVICE_ISSUE_REGEX.test(s), `unexpected match: "${s}"`);
});

// ── deriveCustomerRelationship ────────────────────────────────────────

test('SERVICE_SIDE_DISPOSITIONS is the post-sale set', () => {
  for (const d of ['SALE', 'SW', 'PM', 'P2']) assert.ok(SERVICE_SIDE_DISPOSITIONS.has(d));
  for (const d of ['CXL', 'SET', 'DATA', 'OPPFDN', 'ISSUE']) assert.ok(!SERVICE_SIDE_DISPOSITIONS.has(d));
});

test('prospect: single CXL row, no sale (Shawn, LP lead 573369)', () => {
  const r = deriveCustomerRelationship({
    history: [{ lp_lead_id: '573369', closed_won: false, disposition_code: 'CXL', created_at_lp: '2026-09-05T15:43:03.7+00:00', appointment_set: true }],
    lpLead: { lp_lead_id: '573369', closed_won: false, disposition_code: 'CXL' },
    tags: ['appt-cancelled', 'esc:existing-customer'],   // the WRONG tag must not make him a customer
    pipeline: { pipeline_id: 'P1', status: 'open' },
  });
  assert.equal(r.customer_relationship, 'prospect');
  assert.equal(r.has_prior_sale, false);
  assert.equal(r.open_sales_lead, true);
});

test('returning_customer: Sale row, then a NEWER CXL-with-appointment row', () => {
  const r = deriveCustomerRelationship({
    history: [
      { lp_lead_id: '900002', closed_won: false, disposition_code: 'CXL', created_at_lp: '2026-08-20T14:00:00+00:00', appointment_set: true },
      { lp_lead_id: '900001', closed_won: true,  disposition_code: 'Sale', created_at_lp: '2025-03-10T14:00:00+00:00', job_value: 18450 },
    ],
    lpLead: { lp_lead_id: '900002', closed_won: false, disposition_code: 'CXL' },
    tags: [],
    pipeline: null,
  });
  assert.equal(r.customer_relationship, 'returning_customer');
  assert.equal(r.has_prior_sale, true);
  assert.equal(r.open_sales_lead, true);
  assert.equal(r.latest_lead_disposition, 'CXL');
  assert.equal(r.prior_sale_date, '2025-03-10T14:00:00+00:00');
});

test('returning_customer: history order does not matter', () => {
  const r = deriveCustomerRelationship({
    history: [
      { closed_won: true,  disposition_code: 'Sale', created_at_lp: '2025-03-10T14:00:00+00:00' },
      { closed_won: false, disposition_code: 'Set',  created_at_lp: '2026-09-01T14:00:00+00:00', appointment_set: true },
    ],
  });
  assert.equal(r.customer_relationship, 'returning_customer');
});

test('service_customer: the Sale row is the newest thing on record', () => {
  const r = deriveCustomerRelationship({
    history: [
      { closed_won: true,  disposition_code: 'Sale', created_at_lp: '2026-05-10T14:00:00+00:00' },
      { closed_won: false, disposition_code: 'Set',  created_at_lp: '2026-04-01T14:00:00+00:00' },
    ],
    lpLead: { closed_won: true, disposition_code: 'Sale' },
  });
  assert.equal(r.customer_relationship, 'service_customer');
  assert.equal(r.open_sales_lead, false);
});

test('service_customer: PM (post-sale production) counts as service-side', () => {
  const r = deriveCustomerRelationship({
    history: [{ closed_won: false, disposition_code: 'PM', created_at_lp: '2026-06-01T00:00:00+00:00' }],
  });
  assert.equal(r.customer_relationship, 'service_customer');
});

test('tag-only customer (p2-stage:*) with no LP rows → service_customer', () => {
  const r = deriveCustomerRelationship({
    history: [],
    lpLead: null,
    tags: ['p2-stage:install-completed'],
    pipeline: null,
  });
  assert.equal(r.has_prior_sale, true, 'isCustomerP2 signal honored');
  assert.equal(r.open_sales_lead, false);
  assert.equal(r.customer_relationship, 'service_customer');
});

test('falls back to the single resolved row when history is empty', () => {
  const r = deriveCustomerRelationship({
    history: [],
    lpLead: { closed_won: false, disposition_code: 'Data', created_at_lp: '2026-09-06T00:00:00+00:00' },
  });
  assert.equal(r.customer_relationship, 'prospect');
  assert.equal(r.open_sales_lead, true);
  assert.equal(r.lead_history_count, 1);
});

test('no data at all → prospect, no open lead', () => {
  const r = deriveCustomerRelationship({});
  assert.equal(r.customer_relationship, 'prospect');
  assert.equal(r.has_prior_sale, false);
  assert.equal(r.open_sales_lead, false);
  assert.equal(r.lead_history_count, 0);
});
