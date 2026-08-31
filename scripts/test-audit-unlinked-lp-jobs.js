/**
 * scripts/test-audit-unlinked-lp-jobs.js
 *
 * Unit coverage for the relink decision in scripts/audit-unlinked-lp-jobs.js.
 *
 * Nothing here writes, and neither does the script — but the decision still
 * needs pinning down, because its output is what a human would act on. The
 * failure to guard against is a match that LOOKS deterministic and is not:
 * a junk phone number shared by fifty records, or a household number held by
 * two contacts. Either would attach a real contract to the wrong person, which
 * is strictly worse than leaving the job unlinked.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-audit-unlinked-lp-jobs.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { relinkDecision, phoneKey, isImplausiblePhone } from './audit-unlinked-lp-jobs.js';

const lead = (over = {}) => ({
  lp_lead_id: '5551', ghl_contact_id: null, lp_prospect_id: null,
  phone: '9412689512', first_name: 'Dana', last_name: 'Okonkwo', ...over,
});
const decide = (o) => relinkDecision({
  lead: lead(), prospect: null, contactsForPhone: [], leadsForPhone: [1], ...o,
});

// ─── the deterministic case ─────────────────────────────────────────────

test('a unique plausible phone reaching exactly one contact is a candidate', () => {
  const d = decide({ contactsForPhone: ['contact_A'], leadsForPhone: [1] });
  assert.equal(d.verdict, 'relink_candidate');
  assert.equal(d.contactId, 'contact_A');
});

// ─── the refusals, each of which prevents a wrong link ──────────────────

test('a number held by two GHL contacts is refused, not coin-flipped', () => {
  const d = decide({ contactsForPhone: ['contact_A', 'contact_B'] });
  assert.equal(d.verdict, 'ambiguous_contact');
  assert.equal(d.contactId, null);
});

test('a number owned by several LP leads is refused', () => {
  // The number no longer identifies WHICH lead this job belongs to.
  const d = decide({ contactsForPhone: ['contact_A'], leadsForPhone: [1, 1, 1] });
  assert.equal(d.verdict, 'ambiguous_lead');
  assert.equal(d.contactId, null);
});

test('a junk number is never matched, even against exactly one contact', () => {
  // The dangerous case: junk numbers are shared, so "exactly one contact"
  // is an accident of which records happen to exist, not identity.
  for (const junk of ['0000000000', '1234567890', '1111111111']) {
    const d = decide({ lead: lead({ phone: junk }), contactsForPhone: ['contact_A'] });
    assert.equal(d.verdict, 'implausible_phone', `${junk} must be refused`);
    assert.equal(d.contactId, null);
  }
});

test('no GHL contact on the number is "not in the CRM", not "broken link"', () => {
  // This is the 3,136-row answer. Distinguishing it from ambiguity is the
  // whole point: one is a repair, the other is a decision to create records.
  const d = decide({ contactsForPhone: [] });
  assert.equal(d.verdict, 'no_ghl_contact');
});

test('a lead with no usable phone has nothing to match on', () => {
  assert.equal(decide({ lead: lead({ phone: null }) }).verdict, 'no_phone');
  assert.equal(decide({ lead: lead({ phone: '12345' }) }).verdict, 'no_phone');
});

test('a job whose lead does not exist is reported, not guessed at', () => {
  assert.equal(relinkDecision({ lead: null }).verdict, 'no_lead');
});

// ─── the ID paths win over the phone path ───────────────────────────────

test('an already-linked lead is answered by its own id, never by phone', () => {
  const d = decide({ lead: lead({ ghl_contact_id: 'contact_REAL' }), contactsForPhone: ['contact_OTHER'] });
  assert.equal(d.verdict, 'lead_already_linked');
  assert.equal(d.contactId, 'contact_REAL');
});

test('the prospect id is preferred over a phone match', () => {
  const d = decide({
    lead: lead({ lp_prospect_id: 'p1' }),
    prospect: { lp_prospect_id: 'p1', ghl_contact_id: 'contact_VIA_PROSPECT' },
    contactsForPhone: ['contact_VIA_PHONE'],
  });
  assert.equal(d.verdict, 'prospect_linked');
  assert.equal(d.contactId, 'contact_VIA_PROSPECT');
});

test('a prospect row carrying no contact id falls through to phone', () => {
  const d = decide({
    lead: lead({ lp_prospect_id: 'p1' }),
    prospect: { lp_prospect_id: 'p1', ghl_contact_id: null },
    contactsForPhone: ['contact_A'],
  });
  assert.equal(d.verdict, 'relink_candidate');
});

// ─── phone normalisation ────────────────────────────────────────────────

test('phones normalise to the last ten digits across both systems formats', () => {
  // LP stores bare 10 digits, the HL mirror stores +1-prefixed E.164.
  assert.equal(phoneKey('9412689512'), '9412689512');
  assert.equal(phoneKey('+19412689512'), '9412689512');
  assert.equal(phoneKey('(941) 268-9512'), '9412689512');
  assert.equal(phoneKey(''), '');
  assert.equal(phoneKey(null), '');
  assert.equal(phoneKey('941268'), '');
});

test('implausible numbers are rejected on NANP rules, real ones kept', () => {
  assert.equal(isImplausiblePhone('9412689512'), false);
  assert.equal(isImplausiblePhone('0000000000'), true);
  assert.equal(isImplausiblePhone('5555555555'), true);
  assert.equal(isImplausiblePhone('1234567890'), true);
  assert.equal(isImplausiblePhone('0170212474'), true);  // area code starts 0
  assert.equal(isImplausiblePhone('1170212474'), true);  // area code starts 1
  assert.equal(isImplausiblePhone('9410689512'), true);  // exchange starts 0
  assert.equal(isImplausiblePhone('941'), true);
});
