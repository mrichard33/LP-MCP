/**
 * Tests — LP address validity + appointment guards
 *   scripts/test-lp-address-validity.js
 *
 * Regression cover for the Myron Thorner incident (contact q5GehRye7DNkN6jlmjl3,
 * 2026-08-26/27): a chatbot lead reached LP with address1 = the literal string
 * "undefined", every blankness check read it as a real address, LP could not
 * resolve a market, and SetAppointment answered {Result:1, Message:"market is
 * OOA."} — which our code read as SUCCESS and tagged lp-appt-synced.
 *
 * Run: node scripts/test-lp-address-validity.js
 */

import assert from 'node:assert/strict';
import {
  isBlankAddress,
  hasRealValue,
  normalizeAddressField,
  hasUsableLpAddress,
  missingAddressFields,
  assertAddressableForLp,
  BLANKISH_SQL_OR,
} from '../src/lp-address-validity.js';
import {
  inspectAppointmentResponse,
  assertAppointmentAccepted,
  assertLeadCanTakeAppointment,
} from '../src/lp-appointment-guards.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nisBlankAddress — the placeholder tokens');
// THE live failure. If this ever goes green->red, the incident can recur.
test('"undefined" is blank', () => assert.equal(isBlankAddress('undefined'), true));
test('"undefined" with whitespace is blank', () => assert.equal(isBlankAddress('  undefined  '), true));
test('"UNDEFINED" is blank (case-insensitive)', () => assert.equal(isBlankAddress('UNDEFINED'), true));
test('"null" is blank', () => assert.equal(isBlankAddress('null'), true));
test('"N/A" is blank', () => assert.equal(isBlankAddress('N/A'), true));
test('"none" is blank', () => assert.equal(isBlankAddress('none'), true));
test('null is blank', () => assert.equal(isBlankAddress(null), true));
test('undefined is blank', () => assert.equal(isBlankAddress(undefined), true));
test('empty string is blank', () => assert.equal(isBlankAddress(''), true));
test('whitespace is blank', () => assert.equal(isBlankAddress('   '), true));

console.log('\nisBlankAddress — real values must NOT be caught');
// False positives here would blank out good LP data, which is worse than the
// original bug. UpdateProspectInfo overwrites what you send it.
test('the real address is not blank', () => assert.equal(isBlankAddress('1045 Almondwood Drive'), false));
test('a zip is not blank', () => assert.equal(isBlankAddress('34655'), false));
test('an apartment number is not blank', () => assert.equal(isBlankAddress('Apt 4'), false));
test('"Nanticoke Ave" is not blank (substring safety)', () => assert.equal(isBlankAddress('Nanticoke Ave'), false));
test('"Nome St" is not blank (substring safety)', () => assert.equal(isBlankAddress('Nome St'), false));
test('hasRealValue is the inverse', () => {
  assert.equal(hasRealValue('undefined'), false);
  assert.equal(hasRealValue('1045 Almondwood Drive'), true);
});

console.log('\nnormalizeAddressField');
test('poisoned value normalises to empty', () => assert.equal(normalizeAddressField('undefined'), ''));
test('real value is trimmed and kept', () => assert.equal(normalizeAddressField('  1045 Almondwood Drive '), '1045 Almondwood Drive'));

console.log('\nhasUsableLpAddress / missingAddressFields');
test('Myron as he ARRIVED is not usable', () => {
  assert.equal(hasUsableLpAddress({ address1: 'undefined', city: '', state: '', zip: '' }), false);
});
test('Myron as REPAIRED is usable', () => {
  assert.equal(hasUsableLpAddress({
    address1: '1045 Almondwood Drive', city: 'New Port Richey', state: 'FL', zip: '34655',
  }), true);
});
test('GHL field naming (postalCode) is accepted', () => {
  assert.equal(hasUsableLpAddress({ address1: '1045 Almondwood Drive', postalCode: '34655' }), true);
});
test('street without zip is not usable — zip drives LP market resolution', () => {
  assert.equal(hasUsableLpAddress({ address1: '1045 Almondwood Drive', zip: '' }), false);
});
test('missingAddressFields names the poisoned fields', () => {
  const missing = missingAddressFields({ address1: 'undefined', city: 'Trinity', state: 'FL', zip: null });
  assert.deepEqual(missing.sort(), ['address1', 'zip']);
});
test('missingAddressFields is empty for a good record', () => {
  assert.deepEqual(missingAddressFields({
    address1: '1045 Almondwood Drive', city: 'New Port Richey', state: 'FL', zip: '34655',
  }), []);
});

console.log('\nassertAddressableForLp — the intake gate');
test('throws on the poisoned payload', () => {
  assert.throws(
    () => assertAddressableForLp({ firstname: 'Myron', address1: 'undefined', zip: '' }, 'addLead'),
    (err) => err.code === 'LP_ADDRESS_NOT_RESOLVABLE'
  );
});
test('passes a real payload', () => {
  assert.doesNotThrow(() => assertAddressableForLp({
    firstname: 'Myron', address1: '1045 Almondwood Drive', city: 'New Port Richey', state: 'FL', zip: '34655',
  }, 'addLead'));
});

console.log('\nBLANKISH_SQL_OR');
test('covers null, empty and undefined', () => {
  assert.ok(BLANKISH_SQL_OR.includes('address.is.null'));
  assert.ok(BLANKISH_SQL_OR.includes('address.eq.'));
  assert.ok(BLANKISH_SQL_OR.includes('address.ilike.undefined'));
});

console.log('\ninspectAppointmentResponse — LP soft failures');
// The exact live payload, twice observed.
test('{Result:1, "market is OOA."} is NOT accepted', () => {
  const v = inspectAppointmentResponse({ Result: 1, Message: 'market is OOA.  ' });
  assert.equal(v.accepted, false);
  assert.equal(v.reason, 'lp_market_out_of_area');
});
test('array-wrapped response unwraps', () => {
  assert.equal(inspectAppointmentResponse([{ Result: 1, Message: 'market is OOA.' }]).accepted, false);
});
test('Result 0 is not accepted', () => {
  assert.equal(inspectAppointmentResponse({ Result: 0, Message: 'whatever' }).accepted, false);
});
test('a clean success IS accepted', () => {
  assert.equal(inspectAppointmentResponse({ Result: 1, Message: '' }).accepted, true);
});

console.log('\nassertAppointmentAccepted');
test('throws on OOA with an actionable message', () => {
  assert.throws(
    () => assertAppointmentAccepted({ Result: 1, Message: 'market is OOA.  ' }, { ldsId: '570351' }),
    (err) => err.code === 'LP_APPT_REFUSED'
      && err.reason === 'lp_market_out_of_area'
      && err.message.includes('570351')
  );
});
test('does not throw on success', () => {
  assert.doesNotThrow(() => assertAppointmentAccepted({ Result: 1, Message: '' }, { ldsId: '570351' }));
});

console.log('\nassertLeadCanTakeAppointment — the pre-flight');
test('lead 570351 (blank brn_id) is refused before any LP call', () => {
  assert.throws(
    () => assertLeadCanTakeAppointment({ id: '570351', brn_id: '', disposition: 'Data', apptset: 'false', appointments: [] }),
    (err) => err.code === 'LP_LEAD_NO_MARKET'
  );
});
test('a healthy STPET lead passes', () => {
  assert.doesNotThrow(() => assertLeadCanTakeAppointment({
    id: '570999', brn_id: 'STPET', disposition: 'Data', apptset: 'false', appointments: [],
  }));
});
test('a lead already holding an appointment is refused', () => {
  assert.throws(
    () => assertLeadCanTakeAppointment({ id: '570999', brn_id: 'STPET', apptset: 'true', appointments: [{}] }),
    (err) => err.code === 'LP_LEAD_APPT_EXISTS'
  );
});
test('existing appointment allowed when opted in', () => {
  assert.doesNotThrow(() => assertLeadCanTakeAppointment(
    { id: '570999', brn_id: 'STPET', apptset: 'true', appointments: [{}] },
    { allowExistingAppointment: true }
  ));
});

console.log(`\n${passed} assertions passed.${process.exitCode ? ' SOME TESTS FAILED.' : ''}\n`);
