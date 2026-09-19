// scripts/test-prospect-link-election.js
//
// The election that decides which GHL contact a conflicted LP prospect belongs
// to. Every refusal case is tested explicitly: electing between two plausible
// contacts staples one customer's history to another's, and nothing downstream
// would notice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { electProspectLink, _internal } from '../src/prospect-link-election.js';

const GOOD = 'GoodContactId000001';
const OTHER = 'OtherContactId00002';
const THIRD = 'ThirdContactId00003';

const lead = (id, contactId, source = 'phone_email_match', phone = '3865551234') =>
  ({ lp_lead_id: id, ghl_contact_id: contactId, ghl_link_source: source, phone });

const contacts = (entries) => new Map(Object.entries(entries));
const live = (phone) => ({ deleted_at: null, phone });
const gone = (phone) => ({ deleted_at: '2026-01-01T00:00:00Z', phone });

test('one candidate → elected unanimously, no ladder needed', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD), lead('2', GOOD)],
    contacts: contacts({ [GOOD]: live('3865551234') }),
  });
  assert.equal(r.verdict, 'elected');
  assert.equal(r.contactId, GOOD);
  assert.equal(r.reason, 'unanimous');
});

test('no linked leads → no_candidates, not a refusal', () => {
  const r = electProspectLink({ leads: [], contacts: contacts({}) });
  assert.equal(r.verdict, 'no_candidates');
  assert.equal(r.contactId, null);
});

test('rung 1: a soft-deleted contact is not a rival claim', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD), lead('2', OTHER)],
    contacts: contacts({ [GOOD]: live('3865551234'), [OTHER]: gone('3865551234') }),
  });
  assert.equal(r.verdict, 'elected');
  assert.equal(r.contactId, GOOD);
  assert.ok(r.dropped.some((d) => d.contactId === OTHER && d.reason === 'contact_deleted_or_absent'));
});

test('rung 1: a contact absent from the mirror is treated as gone', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD), lead('2', OTHER)],
    contacts: contacts({ [GOOD]: live('3865551234') }),
  });
  assert.equal(r.contactId, GOOD);
});

test('rung 2: a source the corroborator already refused is dropped', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD), lead('2', OTHER, 'rejected_conflict')],
    contacts: contacts({ [GOOD]: live('3865551234'), [OTHER]: live('3865551234') }),
  });
  assert.equal(r.contactId, GOOD);
  assert.ok(r.dropped.some((d) => d.reason === 'source_rejected'));
});

test('rung 3: phone agreement separates a digit-transposition pair', () => {
  // The live shape: 5184217073 vs 5814217083 under one prospect.
  const r = electProspectLink({
    leads: [lead('1', GOOD, 'phone_email_match', '5184217073'),
            lead('2', OTHER, 'phone_email_match', '5184217073')],
    contacts: contacts({ [GOOD]: live('5184217073'), [OTHER]: live('5814217083') }),
  });
  assert.equal(r.verdict, 'elected');
  assert.equal(r.contactId, GOOD);
  assert.ok(r.dropped.some((d) => d.contactId === OTHER && d.reason === 'phone_disagrees'));
});

test('rung 3: agreeing with ANY of the prospect’s phones is agreement', () => {
  // A prospect legitimately carries a mobile on one lead and a landline on
  // another; the contact matching the second must not be dropped.
  const r = electProspectLink({
    leads: [lead('1', GOOD, 'phone_email_match', '3865551234'),
            lead('2', OTHER, 'legacy_unverified', '7275559999')],
    contacts: contacts({ [GOOD]: live('9999999999'), [OTHER]: live('7275559999') }),
  });
  assert.equal(r.verdict, 'elected');
  assert.equal(r.contactId, OTHER, 'matched the second lead’s phone');
});

test('rung 4: among phone-agreeing candidates, the higher-trust source wins', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD, 'phone_email_match'), lead('2', OTHER, 'legacy_unverified')],
    contacts: contacts({ [GOOD]: live('3865551234'), [OTHER]: live('3865551234') }),
  });
  assert.equal(r.contactId, GOOD);
  assert.ok(r.dropped.some((d) => d.reason === 'weaker_source'));
});

test('counting leads is NOT evidence — a majority never breaks the tie', () => {
  // Removed rung, pinned so it cannot come back. Two contacts, both live, both
  // agreeing on phone, one held by twice as many leads. Live data showed this
  // shape is two real people about equally often as it is one duplicate.
  const r = electProspectLink({
    leads: [lead('1', GOOD), lead('2', GOOD), lead('3', OTHER)],
    contacts: contacts({ [GOOD]: live('3865551234'), [OTHER]: live('3865551234') }),
  });
  assert.equal(r.verdict, 'ambiguous');
  assert.equal(r.contactId, null);
});

test('two contacts each matching a DIFFERENT phone on the prospect → refuse', () => {
  // The live shape behind 6 of the 10 unsafe elections: 4079534440 vs
  // 4079226099, each corroborated by a real phone. Two corroborated contacts
  // is the signature of two people, and merging them is unrecoverable.
  const r = electProspectLink({
    leads: [lead('1', GOOD, 'phone_email_match', '4079534440'),
            lead('2', GOOD, 'phone_email_match', '4079534440'),
            lead('3', OTHER, 'phone_email_match', '4079226099')],
    contacts: contacts({ [GOOD]: live('4079534440'), [OTHER]: live('4079226099') }),
  });
  assert.equal(r.verdict, 'ambiguous');
  assert.equal(r.contactId, null, 'the majority must not carry this');
});

test('no candidate matching any of the prospect’s phones → refuse, not a guess', () => {
  // The other 4: LP knows 7272421300; the candidates are 3525873286 and
  // 8029529651. Nothing to elect on.
  const r = electProspectLink({
    leads: [lead('1', GOOD, 'phone_email_match', '7272421300'),
            lead('2', GOOD, 'phone_email_match', '7272421300'),
            lead('3', OTHER, 'phone_email_match', '7272421300')],
    contacts: contacts({ [GOOD]: live('3525873286'), [OTHER]: live('8029529651') }),
  });
  assert.equal(r.verdict, 'ambiguous');
  assert.equal(r.reason, 'no_phone_evidence');
});

test('REFUSES when two candidates survive every rung', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD), lead('2', OTHER)],
    contacts: contacts({ [GOOD]: live('3865551234'), [OTHER]: live('3865551234') }),
  });
  assert.equal(r.verdict, 'ambiguous');
  assert.equal(r.contactId, null, 'a refusal never returns an id');
  assert.deepEqual(new Set(r.survivors), new Set([GOOD, OTHER]));
});

test('a drop rung that would empty the set discriminates nothing and is skipped', () => {
  // Both contacts soft-deleted, but one carries a source the other does not.
  // Rung 1 must not empty the set and report no_candidates on a prospect that
  // plainly has candidates; rung 4 decides instead.
  const r = electProspectLink({
    leads: [lead('1', GOOD, 'phone_email_match'), lead('2', OTHER, 'legacy_unverified')],
    contacts: contacts({ [GOOD]: gone('3865551234'), [OTHER]: gone('3865551234') }),
  });
  assert.equal(r.verdict, 'elected');
  assert.equal(r.contactId, GOOD, 'fell through past the rung that dropped everything');
  assert.ok(!r.dropped.some((d) => d.reason === 'contact_deleted_or_absent'),
    'a rung that dropped everything leaves no drop record behind');
});

test('three candidates reduce to one when only one phone agrees', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD), lead('2', OTHER), lead('3', THIRD)],
    contacts: contacts({
      [GOOD]: live('3865551234'), [OTHER]: live('1111111111'), [THIRD]: gone('3865551234'),
    }),
  });
  assert.equal(r.verdict, 'elected');
  assert.equal(r.contactId, GOOD);
});

test('a lead with no phone never fabricates agreement', () => {
  const r = electProspectLink({
    leads: [lead('1', GOOD, 'phone_email_match', null), lead('2', OTHER, 'phone_email_match', null)],
    contacts: contacts({ [GOOD]: live(null), [OTHER]: live(null) }),
  });
  assert.equal(r.verdict, 'ambiguous', 'no evidence anywhere means refuse');
});

test('phone10 compares the last ten digits, ignoring formatting and country code', () => {
  const { phone10 } = _internal;
  assert.equal(phone10('+1 (386) 555-1234'), '3865551234');
  assert.equal(phone10('386-555-1234'), '3865551234');
  assert.equal(phone10('5551234'), '', 'too short to compare is not a match');
  assert.equal(phone10(null), '');
});
