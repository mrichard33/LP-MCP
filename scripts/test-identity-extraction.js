/**
 * Identity extraction / promotion / booking-gate tests —
 * scripts/test-identity-extraction.js
 *
 * Locks in the v1.1 contract (Victor Lopez incident 2026-07-04):
 *   1. Placeholder-name regex: matches live-chat widget placeholders,
 *      never real names ("Guy Visitorson").
 *   2. Promotion payload NEVER contains a `tags` key (tag-wipe hazard —
 *      Kristen Nichols 2026-05-19, LP Enrichment 2026-05-15).
 *   3. Booking gate: missing address → blocked; decision_maker false /
 *      unknown → status "new"; true → "confirmed". Never defaults to
 *      confirmed.
 *   4. R5 never-re-ask: fields already on the GHL record hydrate as known
 *      and are never in the missing list.
 *   5. Extraction: the verbatim Victor Lopez transcript yields name,
 *      phone (E.164), street address, decision_maker_confirmed=false.
 *
 * Pure-function tests — no DB, no network, no LLM (heuristic layer only).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-key';

const {
  PLACEHOLDER_NAME_RE,
  isPlaceholderName,
  normalizePhoneE164,
  hydrateIdentityFromRecord,
  heuristicExtract,
  mergeIdentity,
  buildIdentityState,
  assertBookingPrerequisites,
  buildPromotionPayload,
  EMAIL_ASKED_TAG,
} = await import('../src/services/identity-extraction.js');

// ─── 1. Placeholder regex ──────────────────────────────────────────────

test('placeholder regex matches live-chat widget placeholders', () => {
  assert.equal(PLACEHOLDER_NAME_RE.test('Guest Visitor bljpx'), true);
  assert.equal(PLACEHOLDER_NAME_RE.test('guest visitor x9q'), true);
  assert.equal(PLACEHOLDER_NAME_RE.test('GUEST  VISITOR abc'), true);
  assert.equal(PLACEHOLDER_NAME_RE.test('Guest Visitor'), true);
});

test('placeholder regex does NOT match real names', () => {
  assert.equal(PLACEHOLDER_NAME_RE.test('Guy Visitorson'), false);
  assert.equal(PLACEHOLDER_NAME_RE.test('Victor Lopez'), false);
  assert.equal(PLACEHOLDER_NAME_RE.test('Guestavo Ramirez'), false);
});

test('isPlaceholderName treats empty as placeholder (missing, not known)', () => {
  assert.equal(isPlaceholderName(''), true);
  assert.equal(isPlaceholderName(null), true);
  assert.equal(isPlaceholderName('Victor Lopez'), false);
});

// ─── 2. Promotion payload: no tags key, ever ───────────────────────────

test('promotion payload never contains tags (or customFields) key', () => {
  // Adversarial inputs: tags smuggled on both sides.
  const current = { firstName: 'Guest Visitor bljpx', tags: ['a', 'b'] };
  const identity = {
    first_name: 'Victor', last_name: 'Lopez',
    phone: '+15613230334', email: 'v@x.com',
    address_line1: '2885 S Oasis Dr', city: 'Boynton Beach', state: 'FL', postal_code: '33435',
    tags: ['evil'], customFields: [{ id: 'x' }],
    _source: {
      first_name: 'extracted', last_name: 'extracted', phone: 'extracted',
      email: 'extracted', address_line1: 'extracted', city: 'extracted',
      state: 'extracted', postal_code: 'extracted',
    },
  };
  const { payload, wroteRealName } = buildPromotionPayload(current, identity);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tags'), false, 'payload must never contain tags');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'customFields'), false, 'payload must never contain customFields');
  assert.equal(wroteRealName, true);
  assert.equal(payload.firstName, 'Victor');
  assert.equal(payload.lastName, 'Lopez');
  assert.equal(payload.address1, '2885 S Oasis Dr');
  assert.equal(payload.city, 'Boynton Beach');
});

test('promotion overwrites name ONLY when current is empty or placeholder', () => {
  const identity = {
    first_name: 'Victor', last_name: 'Lopez',
    _source: { first_name: 'extracted', last_name: 'extracted' },
  };
  // Placeholder → overwrite.
  let r = buildPromotionPayload({ firstName: 'Guest Visitor bljpx' }, identity);
  assert.equal(r.payload.firstName, 'Victor');
  // Empty → overwrite.
  r = buildPromotionPayload({ firstName: '' }, identity);
  assert.equal(r.payload.firstName, 'Victor');
  // Real differing name → conflict, NO overwrite.
  r = buildPromotionPayload({ firstName: 'Maria', lastName: 'Santos' }, identity);
  assert.equal(r.payload.firstName, undefined, 'must not overwrite a real name');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].field, 'name');
});

test('promotion fills empty fields, conflicts (not overwrites) on differing values', () => {
  const identity = {
    phone: '+15550001111', email: 'new@x.com', address_line1: '1 Main St', city: 'Miami',
    _source: { phone: 'extracted', email: 'extracted', address_line1: 'extracted', city: 'extracted' },
  };
  const r = buildPromotionPayload(
    { firstName: 'Ann', phone: '+15559998888', email: null, address1: null, city: null },
    identity,
  );
  assert.equal(r.payload.phone, undefined, 'differing phone must not overwrite');
  assert.ok(r.conflicts.find(c => c.field === 'phone'));
  assert.equal(r.payload.email, 'new@x.com');
  assert.equal(r.payload.address1, '1 Main St');
  assert.equal(r.payload.city, 'Miami');
});

// ─── 3 + 4. Booking gate ───────────────────────────────────────────────

function stateFrom(identity, tags = []) {
  return { identity: { decision_maker_confirmed: 'unknown', decision_maker_question_asked: false, _source: {}, ...identity }, tags };
}

// These three are about ADDRESS and ZIP. They used decision_maker_confirmed:false
// as a stand-in for "answered", which stopped being a pass on 2026-09-18 — see
// the ALL DECISION MAKERS ATTEND test below. They now set `true` so the
// assertions stay about the thing they are testing.
test('gate: missing address + zip blocks slot offers', () => {
  const gate = assertBookingPrerequisites(stateFrom({
    first_name: 'Victor', last_name: 'Lopez', phone: '+15613230334',
    decision_maker_confirmed: true,
  }));
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing, ['address', 'zip']);
});

test('gate: zip is hard-required, city is not (zip proves service area)', () => {
  const noZip = assertBookingPrerequisites(stateFrom({
    first_name: 'Victor', last_name: 'Lopez', phone: '+15613230334',
    address_line1: '2885 S Oasis Dr', city: 'Boynton Beach',
    decision_maker_confirmed: true,
  }));
  assert.equal(noZip.ok, false);
  assert.deepEqual(noZip.missing, ['zip']);

  const noCity = assertBookingPrerequisites(stateFrom({
    first_name: 'Victor', last_name: 'Lopez', phone: '+15613230334',
    address_line1: '2885 S Oasis Dr', postal_code: '33435',
    decision_maker_confirmed: true,
  }));
  assert.equal(noCity.ok, true, 'city absence never blocks — it derives from the zip');
});

// 2026-09-18 — ALL DECISION MAKERS ATTEND (Mark's ruling). This test asserted
// the OPPOSITE until this date: decision_maker_confirmed=false meant "asked and
// answered", the gate passed, and slots were offered to one person while a
// partner who would not attend was on record. That was the ONE-LEGGER policy,
// and it is reversed. Having asked is the first bar, not the only one.
test('gate: all present but decision_maker=false → BLOCKED, status new', () => {
  const gate = assertBookingPrerequisites(stateFrom({
    first_name: 'Victor', last_name: 'Lopez', phone: '+15613230334',
    address_line1: '2885 S Oasis Dr', city: 'Boynton Beach', postal_code: '33435',
    decision_maker_confirmed: false,
  }));
  assert.equal(gate.ok, false, 'an answered-No must not clear the way to a slot offer');
  assert.deepEqual(gate.missing, ['decision_maker_unresolved']);
  assert.equal(gate.appointment_status, 'new');
});

test('gate: decision_maker=true → status confirmed', () => {
  const gate = assertBookingPrerequisites(stateFrom({
    first_name: 'Victor', last_name: 'Lopez', phone: '+15613230334',
    address_line1: '2885 S Oasis Dr', city: 'Boynton Beach', postal_code: '33435',
    decision_maker_confirmed: true,
  }));
  assert.equal(gate.ok, true);
  assert.equal(gate.appointment_status, 'confirmed');
});

test('gate: decision_maker unknown (never asked) → blocked AND status new', () => {
  const gate = assertBookingPrerequisites(stateFrom({
    first_name: 'Victor', last_name: 'Lopez', phone: '+15613230334',
    address_line1: '2885 S Oasis Dr', city: 'Boynton Beach', postal_code: '33435',
  }));
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing, ['decision_maker_question']);
  assert.equal(gate.appointment_status, 'new', 'never defaults to confirmed');
});

test('gate: placeholder name counts as MISSING', () => {
  const state = { identity: hydrateIdentityFromRecord({ first_name: 'Guest Visitor bljpx', phone: '+15613230334' }), tags: [] };
  const gate = assertBookingPrerequisites(state);
  assert.equal(gate.ok, false);
  assert.ok(gate.missing.includes('name'));
});

test('R5: fields on the GHL record hydrate as known and are never asked', async () => {
  // Contact with email + address already on record; conversation never
  // mentions them. Only the decision-maker question may fire.
  const context = {
    lead: {
      ghl_contact_id: 'c-r5',
      first_name: 'Ann', last_name: 'Smith',
      email: 'ann@x.com', phone: '+15550001111',
      address1: '10 Palm Way', city: 'Tampa', state: 'FL', postal_code: '33601',
      decision_makers_present: null,
      current_tags: [],
    },
    conversation_recent: [
      { direction: 'inbound', text: 'Do you do impact sliders too?' },
    ],
  };
  const state = await buildIdentityState(context, { useLLM: false });
  const gate = assertBookingPrerequisites(state);
  assert.deepEqual(gate.missing, ['decision_maker_question'], 'only the DM question is missing');
  assert.equal(gate.known.email, 'ann@x.com');
  assert.equal(gate.known.address, '10 Palm Way, Tampa, FL, 33601');
  assert.equal(gate.should_ask_email, false, 'email on record → never ask');
  assert.equal(state.identity._source.email, 'ghl_record');
});

test('gate: email soft-ask fires once — suppressed by the asked-once tag', () => {
  const id = {
    first_name: 'Victor', last_name: 'Lopez', phone: '+15613230334',
    address_line1: '2885 S Oasis Dr', city: 'Boynton Beach', postal_code: '33435',
    decision_maker_confirmed: false,
  };
  assert.equal(assertBookingPrerequisites(stateFrom(id)).should_ask_email, true);
  assert.equal(assertBookingPrerequisites(stateFrom(id, [EMAIL_ASKED_TAG])).should_ask_email, false);
});

// ─── 5. Extraction — Victor Lopez transcript, verbatim ─────────────────

const VICTOR_TRANSCRIPT = 'do you install ..or is it a 3rd party? / 15 windows 1 sliding door on 2nd floor... 3 story end unit, aluminum and low E , 9/16 windows / 5613230334 / Victor Lopez / text me please...and I can answer after talking with my wife / 2885 S Oasis Dr / oh...this is a bot...lol / 5613230334';

test('extraction: Victor transcript yields name, phone, address, DM=false', () => {
  const id = heuristicExtract([{ direction: 'inbound', text: VICTOR_TRANSCRIPT }]);
  assert.equal(id.first_name, 'Victor');
  assert.equal(id.last_name, 'Lopez');
  assert.equal(id.phone, '+15613230334');
  assert.equal(id.address_line1, '2885 S Oasis Dr');
  assert.equal(id.decision_maker_confirmed, false, '"after talking with my wife" → false');
});

test('extraction: address with city/state/zip parses all components', () => {
  const id = heuristicExtract(['my address is 2885 S Oasis Dr, Boynton Beach, FL 33435']);
  assert.equal(id.address_line1, '2885 S Oasis Dr');
  assert.equal(id.city, 'Boynton Beach');
  assert.equal(id.state, 'FL');
  assert.equal(id.postal_code, '33435');
});

test('extraction: DM confirmed phrases map to true', () => {
  const id = heuristicExtract(["yes we'll both be there Saturday"]);
  assert.equal(id.decision_maker_confirmed, true);
  const solo = heuristicExtract(["it's just me, I make all the decisions"]);
  assert.equal(solo.decision_maker_confirmed, true);
});

test('extraction: bot words never become customer identity', () => {
  const id = heuristicExtract([
    { direction: 'outbound', text: 'Thanks John Smith, is 123 Ocean Ave the right spot? Will everyone who is part of the decision be home?' },
  ]);
  assert.equal(id.first_name, null);
  assert.equal(id.address_line1, null);
  assert.equal(id.decision_maker_question_asked, true, 'outbound DM question IS detected');
});

test('extraction: placeholder name in chat never extracted as a name', () => {
  const id = heuristicExtract(['Guest Visitor bljpx']);
  assert.equal(id.first_name, null);
});

test('extraction: conversational fragments never extracted as names (dry-run 2026-07-04 regressions)', () => {
  // Every one of these was a false-positive "promoted" row in the first
  // remediation DRY RUN — each must extract NO name.
  const fragments = [
    'never mind', 'trying to', 'looking for', 'real person', 'all set',
    'planning to', 'gathering info', 'interested in', 'unable to',
    'very sorry', 'Exploring options', 'The existing one', 'In Spanish',
    'Facebook group recommendation', 'my free gifts', 'tax credit',
    'contact email', 'replacement options', 'family tree', 'talking to',
    'just need prices', 'surfing the wen', "Vincent's house", 'so supposed',
    'thirty-three thousand sixty-eight', 'Janie from', 'McHale and',
  ];
  for (const f of fragments) {
    const id = heuristicExtract([f]);
    assert.equal(id.first_name, null, `"${f}" must not extract as a name (got "${id.first_name}")`);
  }
});

test('extraction: capitalized real names still extract; stated names title-case', () => {
  assert.equal(heuristicExtract(['Edward Vogel']).first_name, 'Edward');
  assert.equal(heuristicExtract(['Sharon Shively']).last_name, 'Shively');
  assert.equal(heuristicExtract(['Victor Lopez']).first_name, 'Victor');
  // lowercase bare names are rejected (weak evidence)…
  assert.equal(heuristicExtract(['victor lopez']).first_name, null);
  // …but explicit phrasing accepts any casing and normalizes it.
  const stated = heuristicExtract(['my name is victor lopez']);
  assert.equal(stated.first_name, 'Victor');
  assert.equal(stated.last_name, 'Lopez');
});

// ─── merge: record wins, extraction fills gaps ─────────────────────────

test('merge: record value wins; extraction fills gaps; conflicts reported', () => {
  const rec = hydrateIdentityFromRecord({ first_name: 'Ann', last_name: 'Smith', phone: '+15550001111' });
  const ext = heuristicExtract(['this is Bob Jones', 'call me at 561-323-0334', 'I live at 5 Elm St, Miami']);
  const { identity, conflicts } = mergeIdentity(rec, ext);
  assert.equal(identity.first_name, 'Ann', 'record name wins');
  assert.equal(identity.address_line1, '5 Elm St', 'extraction fills the gap');
  assert.ok(conflicts.find(c => c.field === 'phone'), 'differing phone is a conflict');
});

test('extraction: zip captured standalone and with keyword (service-area priority)', () => {
  // Bare FL-range zip as its own message.
  assert.equal(heuristicExtract(['33435']).postal_code, '33435');
  // Keyword form, any range.
  assert.equal(heuristicExtract(['zip is 33076']).postal_code, '33076');
  assert.equal(heuristicExtract(['Zip code: 34112-1234']).postal_code, '34112');
  // Non-FL bare 5-digit numbers are NOT eaten as zips (window counts, prices).
  assert.equal(heuristicExtract(['15775']).postal_code, null);
  // Victor-style transcript segment numbers never parse as zips.
  assert.equal(heuristicExtract(['15 windows 1 sliding door, 9/16 windows']).postal_code, null);
});

test('enrichIdentityFromServiceArea backfills city + FL from a verified zip', async () => {
  const { enrichIdentityFromServiceArea } = await import('../src/services/identity-extraction.js');
  const id = { address_line1: '2885 S Oasis Dr', city: null, state: null, postal_code: '33435', _source: {} };
  enrichIdentityFromServiceArea(id, { checked: true, in_service_area: true, zip: '33435', city: 'Boynton Beach' });
  assert.equal(id.city, 'Boynton Beach');
  assert.equal(id.state, 'FL');
  // Out-of-area / unchecked never backfills.
  const id2 = { city: null, state: null, _source: {} };
  enrichIdentityFromServiceArea(id2, { checked: true, in_service_area: false, zip: '99999' });
  assert.equal(id2.state, null);
});

test('census geocode parse: single match → zip; ambiguous/none → null', async () => {
  const { parseCensusGeocodeResponse } = await import('../src/services/identity-extraction.js');
  const single = {
    result: { addressMatches: [{
      matchedAddress: '2885 S OASIS DR, BOYNTON BEACH, FL, 33435',
      addressComponents: { zip: '33435', city: 'BOYNTON BEACH', state: 'FL' },
    }] },
  };
  const parsed = parseCensusGeocodeResponse(single);
  assert.equal(parsed.zip, '33435');
  assert.equal(parsed.state, 'FL');
  // Two candidates → never guess.
  const multi = { result: { addressMatches: [
    { addressComponents: { zip: '33435' } },
    { addressComponents: { zip: '33436' } },
  ] } };
  assert.equal(parseCensusGeocodeResponse(multi), null);
  // No match / malformed → null.
  assert.equal(parseCensusGeocodeResponse({ result: { addressMatches: [] } }), null);
  assert.equal(parseCensusGeocodeResponse({}), null);
  assert.equal(parseCensusGeocodeResponse({ result: { addressMatches: [{ addressComponents: {} }] } }), null);
});

test('promotion: geocoded zip is promotable, fills empty postalCode only', () => {
  const identity = {
    address_line1: '2885 S Oasis Dr', postal_code: '33435',
    _source: { address_line1: 'extracted', postal_code: 'geocoded' },
  };
  let r = buildPromotionPayload({ firstName: 'Victor', postalCode: null }, identity);
  assert.equal(r.payload.postalCode, '33435');
  // Existing differing zip → conflict, never overwritten.
  r = buildPromotionPayload({ firstName: 'Victor', postalCode: '33436' }, identity);
  assert.equal(r.payload.postalCode, undefined);
  assert.ok(r.conflicts.find(c => c.field === 'postalCode'));
});

test('phone normalization to E.164', () => {
  assert.equal(normalizePhoneE164('5613230334'), '+15613230334');
  assert.equal(normalizePhoneE164('(561) 323-0334'), '+15613230334');
  assert.equal(normalizePhoneE164('1-561-323-0334'), '+15613230334');
  assert.equal(normalizePhoneE164('12345'), null);
});
