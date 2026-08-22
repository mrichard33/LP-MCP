/**
 * Tests — PR 4: deterministic lead matching (§8)
 * scripts/test-ci-matching.js
 *
 * This module decides WHICH PERSON'S RECORD a call note lands on. Every other
 * stage can fail visibly; this one fails by writing a plausible note onto a
 * stranger's file, where nobody reviewing it can tell it does not belong.
 *
 * So these tests assert the SAFE direction at every boundary, not merely that
 * the happy path works:
 *
 *   - every tier boundary (exact / high / probable / ambiguous / none)
 *   - cst vs lds note-target selection
 *   - ambiguous NEVER resolves to a writable tier
 *   - the multiple-appointment case goes to cst, never to a chosen one
 *   - canvass campaigns never phone-match (the ANI is the canvasser)
 *
 * Pure decision functions throughout — no database.
 *
 * Run: node --test scripts/test-ci-matching.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideLpTier,
  decideGhlTier,
  pickNoteTarget,
  narrowByRecency,
  nameAddressUsable,
  isCanvassCorrelation,
  phoneVariants,
  reviewReasonFor,
  WRITABLE_TIERS,
  NAME_ADDRESS_MIN_CONFIDENCE,
  APPOINTMENT_WINDOW_DAYS,
} from '../src/ci/match.js';

const CALL_START = '2026-08-21T16:00:00.000Z';
const p = (id, over = {}) => ({ lp_prospect_id: id, ...over });

/** days before the call, as an ISO string */
const daysBefore = (n) => new Date(new Date(CALL_START).getTime() - n * 86400000).toISOString();
const daysAfter = (n) => new Date(new Date(CALL_START).getTime() + n * 86400000).toISOString();

// ─── phone normalization ────────────────────────────────────────────────────

test('phone comparison covers the bare 10-digit and the 1-prefixed forms', () => {
  // LP stores bare 10-digit for 99.4% of rows and 11-digit for 118 of them.
  assert.deepEqual(phoneVariants('7273302574'), ['7273302574', '17273302574']);
  assert.deepEqual(phoneVariants('+1 (727) 330-2574'), ['7273302574', '17273302574']);
  assert.deepEqual(phoneVariants('17273302574'), ['7273302574', '17273302574']);
  // Junk yields nothing to match on, rather than a partial probe.
  assert.deepEqual(phoneVariants('555'), []);
  assert.deepEqual(phoneVariants(null), []);
});

// ─── tier boundaries ────────────────────────────────────────────────────────

test('TIER exact — ids carried by the dialing record beat every inference', () => {
  const r = decideLpTier({
    listIds: { cst_id: 453297, lds_id: 568419 },
    // Even with conflicting phone candidates present, the carried ids win.
    phoneCandidates: [p(1), p(2)],
    callStart: CALL_START,
  });
  assert.equal(r.tier, 'exact');
  assert.equal(r.method, 'list_carried_ids');
  assert.equal(r.prospectId, 453297);
  assert.equal(r.leadId, 568419);
});

test('TIER high — exactly one phone candidate', () => {
  const r = decideLpTier({ phoneCandidates: [p(101)], callStart: CALL_START });
  assert.equal(r.tier, 'high');
  assert.equal(r.method, 'phone_exact');
  assert.equal(r.prospectId, 101);
});

test('TIER probable — several phone candidates, exactly one is recent', () => {
  const r = decideLpTier({
    phoneCandidates: [
      p(201, { appointment_date: daysAfter(3) }),          // within ±14d
      p(202, { last_activity_at: daysBefore(400) }),       // long cold
    ],
    callStart: CALL_START,
  });
  assert.equal(r.tier, 'probable');
  assert.equal(r.prospectId, 201);
  assert.equal(r.reason, 'narrowed_by_recency');
  // The full candidate set is retained for the reviewer, not just the winner.
  assert.equal(r.candidates.length, 2);
});

test('TIER ambiguous — several candidates stay recent, so NO ONE is chosen', () => {
  const r = decideLpTier({
    phoneCandidates: [
      p(301, { appointment_date: daysAfter(2) }),
      p(302, { appointment_date: daysAfter(5) }),
    ],
    callStart: CALL_START,
  });
  assert.equal(r.tier, 'ambiguous');
  assert.equal(r.prospectId, null, 'must not pick the nearer appointment');
  assert.match(r.reason, /multiple_recent_candidates_2/);
});

test('TIER ambiguous — several candidates and NONE recent is still not a guess', () => {
  const r = decideLpTier({
    phoneCandidates: [p(401, { last_activity_at: daysBefore(900) }), p(402, { last_activity_at: daysBefore(800) })],
    callStart: CALL_START,
  });
  assert.equal(r.tier, 'ambiguous');
  assert.equal(r.prospectId, null);
  assert.equal(r.reason, 'no_candidate_recent');
});

test('TIER none — nothing matched', () => {
  const r = decideLpTier({ phoneCandidates: [], callStart: CALL_START });
  assert.equal(r.tier, 'none');
  assert.equal(r.prospectId, null);
});

test('AMBIGUOUS AND NONE ARE NEVER WRITABLE — the core safety property', () => {
  for (const tier of ['ambiguous', 'none']) {
    assert.equal(WRITABLE_TIERS.has(tier), false, `${tier} must never be writable`);
  }
  for (const tier of ['exact', 'high', 'probable']) {
    assert.equal(WRITABLE_TIERS.has(tier), true);
  }
});

test('an ambiguous or unmatched eligible call is routed to review', () => {
  assert.equal(reviewReasonFor({ tier: 'ambiguous' }, { eligible: true }), 'match_ambiguous');
  assert.equal(reviewReasonFor({ tier: 'none' }, { eligible: true }), 'match_none');
  // An INELIGIBLE call finding nothing is expected, not queue-worthy.
  assert.equal(reviewReasonFor({ tier: 'none' }, { eligible: false }), null);
  assert.equal(reviewReasonFor({ tier: 'high' }, { eligible: true }), null);
});

// ─── the recency window boundaries ──────────────────────────────────────────

test('the appointment window is ±14 days and is inclusive at the edge', () => {
  const at14 = narrowByRecency([p(1, { appointment_date: daysAfter(APPOINTMENT_WINDOW_DAYS) })], CALL_START);
  assert.equal(at14.length, 1, 'exactly 14 days out must still count');
  const at15 = narrowByRecency([p(1, { appointment_date: daysAfter(15) })], CALL_START);
  assert.equal(at15.length, 0);
  // It is a WINDOW, not a future-only cutoff — an appointment 10 days BEFORE
  // the call is just as relevant (the call is probably about it).
  assert.equal(narrowByRecency([p(1, { appointment_date: daysBefore(10) })], CALL_START).length, 1);
});

test('activity within 30 days also qualifies a candidate', () => {
  assert.equal(narrowByRecency([p(1, { last_activity_at: daysBefore(29) })], CALL_START).length, 1);
  assert.equal(narrowByRecency([p(1, { last_activity_at: daysBefore(31) })], CALL_START).length, 0);
});

test('a bare has_appointment boolean does NOT qualify a stale candidate', () => {
  // lp_prospects has has_appointment (boolean) but no appointment DATE. A
  // boolean cannot satisfy "within 14 days", so it must be ignored here — else
  // a two-year-old appointment turns an honest ambiguous into a confident
  // wrong probable. Prospects narrow on activity only.
  const stale = p(1, { has_appointment: true, last_activity_at: daysBefore(400) });
  assert.equal(narrowByRecency([stale], CALL_START).length, 0);

  const r = decideLpTier({
    phoneCandidates: [stale, p(2, { has_appointment: true, last_activity_at: daysBefore(500) })],
    callStart: CALL_START,
  });
  assert.equal(r.tier, 'ambiguous');
  assert.equal(r.reason, 'no_candidate_recent');
});

// ─── cst vs lds note-target selection ───────────────────────────────────────

test('NOTE TARGET — one relevant inquiry attaches to that lead (ils)', () => {
  const t = pickNoteTarget(500, [{ lp_lead_id: 9001, appointment_date: daysAfter(3) }], CALL_START);
  assert.equal(t.rectype, 'ils');
  assert.equal(t.recid, 9001);
  assert.equal(t.reason, 'single_relevant_lead');
});

test('MULTIPLE APPOINTMENTS go to the PERSON (cst), never to a chosen one', () => {
  // §8: "never guess between multiple appointments". Attaching to one silently
  // implies the wrong job context to whoever reads it.
  const t = pickNoteTarget(500, [
    { lp_lead_id: 9001, appointment_date: daysAfter(2) },
    { lp_lead_id: 9002, appointment_date: daysAfter(6) },
  ], CALL_START);
  assert.equal(t.rectype, 'cst');
  assert.equal(t.recid, 500);
  assert.equal(t.reason, 'multiple_relevant_leads');
});

test('no relevant inquiry also goes to the person, not to a stale lead', () => {
  const t = pickNoteTarget(500, [{ lp_lead_id: 9001, appointment_date: daysBefore(400) }], CALL_START);
  assert.equal(t.rectype, 'cst');
  assert.equal(t.recid, 500);
  assert.equal(t.reason, 'no_relevant_lead');
});

// ─── the name+address fallback, the only tier that trusts the model ─────────

const stated = (value, confidence) => ({ value, source: 'stated', confidence });

test('name+address requires BOTH fields stated at >= 0.85', () => {
  const good = { customer: { name: stated('Jane Doe', 0.9), address: stated('1224 Oak St', 0.88) } };
  assert.equal(nameAddressUsable(good), true);

  // exactly at the floor is accepted
  assert.equal(nameAddressUsable({ customer: {
    name: stated('Jane Doe', NAME_ADDRESS_MIN_CONFIDENCE),
    address: stated('1224 Oak St', NAME_ADDRESS_MIN_CONFIDENCE),
  } }), true);

  // just under is not
  assert.equal(nameAddressUsable({ customer: {
    name: stated('Jane Doe', 0.84), address: stated('1224 Oak St', 0.99),
  } }), false);
});

test('an INFERRED name never qualifies, however confident', () => {
  // This is the guard against a hallucinated name attaching a note to a
  // stranger. 'inferred' means the model worked it out, not that it heard it.
  assert.equal(nameAddressUsable({ customer: {
    name: { value: 'Jane Doe', source: 'inferred', confidence: 1.0 },
    address: stated('1224 Oak St', 0.99),
  } }), false);
  assert.equal(nameAddressUsable({ customer: {
    name: stated('Jane Doe', 0.99), address: { value: '1224 Oak St', source: 'unknown', confidence: 0 },
  } }), false);
  assert.equal(nameAddressUsable(null), false);
  assert.equal(nameAddressUsable({ customer: { name: stated('', 0.99), address: stated('x', 0.99) } }), false);
});

test('name+address yields probable on a unique hit, ambiguous on several', () => {
  const analysis = { customer: { name: stated('Jane Doe', 0.9), address: stated('1224 Oak St', 0.9) } };
  const one = decideLpTier({ phoneCandidates: [], nameCandidates: [p(601)], analysis, callStart: CALL_START });
  assert.equal(one.tier, 'probable');
  assert.equal(one.method, 'name_address');

  const many = decideLpTier({ phoneCandidates: [], nameCandidates: [p(601), p(602)], analysis, callStart: CALL_START });
  assert.equal(many.tier, 'ambiguous');
  assert.equal(many.prospectId, null);
});

test('a phone hit is preferred over name+address — it is the stronger signal', () => {
  const analysis = { customer: { name: stated('Jane Doe', 0.99), address: stated('1224 Oak St', 0.99) } };
  const r = decideLpTier({ phoneCandidates: [p(700)], nameCandidates: [p(999)], analysis, callStart: CALL_START });
  assert.equal(r.tier, 'high');
  assert.equal(r.prospectId, 700);
});

test('weak AI evidence means the name candidates are not even considered', () => {
  const weak = { customer: { name: stated('Jane Doe', 0.5), address: stated('1224 Oak St', 0.5) } };
  const r = decideLpTier({ phoneCandidates: [], nameCandidates: [p(601)], analysis: weak, callStart: CALL_START });
  assert.equal(r.tier, 'none');
});

// ─── the canvass exception ──────────────────────────────────────────────────

test('canvass campaigns are identified from the MAP, not a hardcoded name', () => {
  assert.equal(isCanvassCorrelation({ match_strategy: 'canvass_correlation' }), true);
  assert.equal(isCanvassCorrelation({ match_strategy: 'phone' }), false);
  assert.equal(isCanvassCorrelation(null), false);
  // The live campaign string alone must not trigger it — near-duplicate names
  // exist and the map is the authority.
  assert.equal(isCanvassCorrelation({ campaign: 'Canvass Confirmation - Inbound' }), false);
});

// ─── GHL resolution ─────────────────────────────────────────────────────────

test('an existing LP↔GHL link wins over any phone search', () => {
  const r = decideGhlTier({
    lpProspect: { ghl_contact_id: 'ghl-abc' },
    phoneCandidates: [{ ghl_contact_id: 'ghl-zzz' }],
  });
  assert.equal(r.tier, 'exact');
  assert.equal(r.ghlContactId, 'ghl-abc', 'an established link beats an inferred one');
});

test('a link on any of the person’s inquiries is used when the person has none', () => {
  const r = decideGhlTier({ lpProspect: { ghl_contact_id: null }, lpLeads: [{ ghl_contact_id: null }, { ghl_contact_id: 'ghl-lead' }] });
  assert.equal(r.tier, 'exact');
  assert.equal(r.ghlContactId, 'ghl-lead');
});

test('GHL falls to ambiguous on multiple phone candidates, never to the first', () => {
  const many = decideGhlTier({ phoneCandidates: [{ ghl_contact_id: 'a' }, { ghl_contact_id: 'b' }] });
  assert.equal(many.tier, 'ambiguous');
  assert.equal(many.ghlContactId, null);

  assert.equal(decideGhlTier({}).tier, 'none');
  assert.equal(decideGhlTier({ phoneCandidates: [{ ghl_contact_id: 'solo' }] }).tier, 'high');
});
