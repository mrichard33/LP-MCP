/**
 * test-lp-appointment-authority-resolution.js — the GHL→LP leg's use of the
 * appointment-authority owner.
 *
 * Run: node --test scripts/test-lp-appointment-authority-resolution.js
 *
 * The whole point: the authority owner is a value that WON AN ARBITRATION. It
 * has never been checked against LP. resolveLPLeadId's Step 0 exists precisely
 * because lp_leads.ghl_contact_id is a Supabase-side derivation that is not
 * trustworthy on its own (see ghl_link_source's rejected_* values), so Step 0a
 * demands a live lognumber match and Step 0b demands a bookable disposition.
 *
 * Preferring the owner must therefore REORDER those candidates, never replace
 * them — otherwise we could write an appointment onto a lead that is Sold, DNC,
 * cancelled, deleted in LP, linked to another contact, or on another prospect.
 * preferCandidate is that reordering, and these tests pin its contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { preferCandidate } = await import('../src/lp-appointment-sync.js');

// Step 0's candidate list: up to 5 lp_leads rows, synced_at DESC. That ordering
// churns on every ~15-minute LP poll, which is why resolution_source flipped
// supabase_link_trusted_bookable → supabase_hlcid_validated twenty minutes
// apart on the 2026-08-02 contact.
const CANDIDATES = [
  { lp_lead_id: '563790', disposition_code: 'Set' },
  { lp_lead_id: '563787', disposition_code: 'Cnf' },
  { lp_lead_id: '563753', disposition_code: 'Set' },
];

test('the owner moves to the front and everything else keeps its order', () => {
  const out = preferCandidate(CANDIDATES, '563753');
  assert.deepEqual(out.map((c) => c.lp_lead_id), ['563753', '563790', '563787']);
});

test('the list is REORDERED, never filtered — every candidate still faces the gates', () => {
  // If preferring the owner dropped candidates, an owner that fails validation
  // would leave the resolver with nothing instead of falling through.
  const out = preferCandidate(CANDIDATES, '563787');
  assert.equal(out.length, CANDIDATES.length);
  assert.deepEqual([...out].map((c) => c.lp_lead_id).sort(), ['563753', '563787', '563790']);
});

test('an owner that is NOT among the contact’s leads is not conjured into the list', () => {
  // A preferred lead absent from lp_leads for this contact was never a
  // candidate. Injecting it would be exactly the unvalidated short-circuit this
  // design refuses.
  const out = preferCandidate(CANDIDATES, '999999');
  assert.deepEqual(out, CANDIDATES);
});

test('no preference, empty, or already-first inputs pass through untouched', () => {
  assert.equal(preferCandidate(CANDIDATES, null), CANDIDATES);
  assert.equal(preferCandidate(CANDIDATES, undefined), CANDIDATES);
  assert.equal(preferCandidate(CANDIDATES, ''), CANDIDATES);
  assert.equal(preferCandidate(CANDIDATES, '563790'), CANDIDATES, 'already first → same reference');
  assert.equal(preferCandidate(null, '563787'), null);
  assert.deepEqual(preferCandidate([], '563787'), []);
});

test('lead ids compare as strings, so a numeric owner still matches', () => {
  const out = preferCandidate(CANDIDATES, 563753);
  assert.equal(out[0].lp_lead_id, '563753');
});

test('malformed candidate rows do not throw', () => {
  const messy = [null, { lp_lead_id: null }, { lp_lead_id: '563787' }];
  const out = preferCandidate(messy, '563787');
  assert.equal(out[0].lp_lead_id, '563787');
  assert.equal(out.length, 3);
});

test('preferring is stable — running it twice is the same as running it once', () => {
  // The point of preferring at all is to stop resolution_source oscillating
  // between passes.
  const once = preferCandidate(CANDIDATES, '563753');
  const twice = preferCandidate(once, '563753');
  assert.deepEqual(twice.map((c) => c.lp_lead_id), once.map((c) => c.lp_lead_id));
});
