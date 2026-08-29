/**
 * test-ghl-link-probe.js — matching rules for the Tier B reconciliation probe.
 *
 * The probe decides, per stranded LP lead, whether a GHL contact corroborates
 * it. Three rules matter enough to pin, because getting any of them wrong
 * either invents a link to a stranger or buries a real one:
 *
 *  1. MANY LP LEADS TO ONE GHL CONTACT IS NORMAL. Repeat inquiries from one
 *     household; 3,872 contacts already map to more than one lead. A matcher
 *     that called that a conflict would reject most of the genuine matches.
 *     Only the REVERSE — one lead, several candidate contacts — is ambiguity.
 *  2. The "NA" email sentinel is not an email. Wanda's LP email is literally
 *     "NA"; comparing it naively false-matches every LP-origin lead to every
 *     other one.
 *  3. LP stores bare 10-digit numbers, GHL stores +1XXXXXXXXXX. The comparison
 *     is on the last 10 digits, and the lookup must ask for both forms or the
 *     indexed .in() finds nothing.
 *
 * No network and no DB: classify() is pure over the two lookup maps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('./probe-ghl-link-candidates.js');
const { last10, phoneVariants, classify } = _internal;

const contact = (id, phone, email) => ({ ghl_contact_id: id, phone, email, deleted_at: null });

// Build the two maps classify() reads, the way fetchCandidates() would.
function maps(contacts) {
  const byPhone = new Map();
  const byEmail = new Map();
  for (const c of contacts) {
    const p = last10(c.phone);
    if (p) byPhone.set(p, [...(byPhone.get(p) || []), c]);
    const e = (c.email || '').trim().toLowerCase();
    if (e) byEmail.set(e, [...(byEmail.get(e) || []), c]);
  }
  return { byPhone, byEmail };
}

test('last10 pulls the comparable digits from either storage format', () => {
  assert.equal(last10('7275551234'), '7275551234');
  assert.equal(last10('+17275551234'), '7275551234');
  assert.equal(last10('(727) 555-1234'), '7275551234');
  assert.equal(last10('5551234'), null, 'a 7-digit number has no area code and must not match');
  assert.equal(last10(''), null);
  assert.equal(last10(null), null);
});

test('phoneVariants asks for the E.164 form GHL actually stores', () => {
  const v = phoneVariants('7275551234');
  assert.ok(v.includes('+17275551234'), 'missing +1 form — 17,354 of 18,229 contacts store this');
  assert.ok(v.includes('7275551234'), 'missing bare form');
});

test('one corroborating contact is a match', () => {
  const c = contact('AAAAAAAAAAAAAAAAAAAA', '+17275551234', 'a@example.com');
  const lead = { phone: '7275551234', phone_alt: null, email: null };
  const r = classify(lead, ...Object.values(maps([c])));
  assert.equal(r.verdict, 'match');
  assert.equal(r.contacts[0].ghl_contact_id, 'AAAAAAAAAAAAAAAAAAAA');
});

test('MANY LP LEADS TO ONE CONTACT IS NOT A CONFLICT — two leads, same household phone', () => {
  const c = contact('AAAAAAAAAAAAAAAAAAAA', '+17275551234', null);
  const m = maps([c]);
  for (const leadId of ['lead-1', 'lead-2', 'lead-3']) {
    const lead = { lp_lead_id: leadId, phone: '7275551234', phone_alt: null, email: null };
    const r = classify(lead, m.byPhone, m.byEmail);
    assert.equal(r.verdict, 'match', `${leadId} must resolve to the shared contact, not a conflict`);
  }
});

test('one lead with two DIFFERENT candidate contacts is ambiguous, never guessed', () => {
  const m = maps([
    contact('AAAAAAAAAAAAAAAAAAAA', '+17275551234', null),
    contact('BBBBBBBBBBBBBBBBBBBB', '+17275559999', 'shared@example.com'),
  ]);
  const lead = { phone: '7275551234', phone_alt: null, email: 'shared@example.com' };
  const r = classify(lead, m.byPhone, m.byEmail);
  assert.equal(r.verdict, 'ambiguous');
  assert.equal(r.contacts.length, 2);
});

test('the "NA" email sentinel never matches', () => {
  const m = maps([contact('AAAAAAAAAAAAAAAAAAAA', null, 'NA')]);
  for (const sentinel of ['NA', 'na', 'N/A', 'none', '']) {
    const lead = { phone: null, phone_alt: null, email: sentinel };
    const r = classify(lead, m.byPhone, m.byEmail);
    assert.equal(r.verdict, 'no_candidate', `"${sentinel}" must not corroborate anything`);
  }
});

test('a contact whose identity contradicts the lead is not a match', () => {
  // Present in the lookup map only because a phone_alt pulled it in; the
  // shared corroboration predicate must still reject it.
  const c = contact('AAAAAAAAAAAAAAAAAAAA', '+19995550000', 'someone@example.com');
  const byPhone = new Map([['7275551234', [c]]]);
  const lead = { phone: '7275551234', phone_alt: null, email: 'other@example.com' };
  const r = classify(lead, byPhone, new Map());
  assert.equal(r.verdict, 'no_candidate', 'corroborateIdentity must veto a join-only hit');
});

test('phone_alt is corroborating identity too', () => {
  const m = maps([contact('AAAAAAAAAAAAAAAAAAAA', '+17275559999', null)]);
  const lead = { phone: '7275551234', phone_alt: '727-555-9999', email: null };
  assert.equal(classify(lead, m.byPhone, m.byEmail).verdict, 'match');
});
