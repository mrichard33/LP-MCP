/**
 * Tests — Five9 callback push record + cross-list suppression
 * scripts/test-five9-callback-push.js
 *
 *   node --test scripts/test-five9-callback-push.js
 *
 * This is the mapping that decides whether an agent's screen opens the right
 * customer on a call we promised. What must not regress:
 *
 *   1. CustID present, or nothing is pushed. The LeadPerfection connector
 *      fires OnCallAccepted with F9key=CustID and reads the FIVE9 CONTACT
 *      RECORD. No CustID, no screen pop, and the agent takes a call blind.
 *   2. No Five9-owned field is ever written. "Contact create time and date"
 *      in particular is what the profile's 48-HOURS-Ago filter reads; setting
 *      it ourselves risks a record born outside its own filter that never
 *      dials, and nothing would report that.
 *   3. cqd_id is never sent. It reads 51 on every export row, but LP's stored
 *      values for those same leads are 8, 31 and 51 — it belongs to LP's feed.
 *   4. LPRecKey is derived, not invented, and omitted when there is no in1_id.
 *   5. The cross-list check fails OPEN while the CustID check fails CLOSED.
 *      That asymmetry is deliberate and is the whole safety argument.
 *
 * Offline and pure — every Five9/GHL read is injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCallbackRecord,
  findContactInOtherLists,
  deriveLpRecKey,
  normalizeNumber1,
  callbackListName,
  callbackCallNowMode,
  callbackLpRecType,
  FIVE9_OWNED_FIELDS,
} from '../src/five9/callback-push.js';

/** A contact/lead pair that should map cleanly. Robert Pederson's shape. */
const ghlContact = {
  phone: '+1 (727) 555-0142',
  firstName: 'Robert',
  lastName: 'Pederson',
  address1: '123 Palm Ave',
  city: 'Clearwater',
  state: 'FL',
  postalCode: '33755',
  email: 'robert@example.com',
};
const lpRow = {
  lp_prospect_id: '369848',
  lp_lead_id: '573111',
  raw_lp_data: { in1_id: '420972' },
};
const CONTACT_ID = 'zLDD7V1eosF8vldF5U7i';

/** field -> value, for readable assertions. */
function asMap(rec) {
  return Object.fromEntries(rec.fieldNames.map((f, i) => [f, rec.values[i]]));
}

function withEnv(vars, body) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return body(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/* --- helpers ------------------------------------------------------------- */

test('number1 is ten digits, no +1 and no punctuation', () => {
  assert.equal(normalizeNumber1('+1 (727) 555-0142'), '7275550142');
  assert.equal(normalizeNumber1('7275550142'), '7275550142');
  assert.equal(normalizeNumber1('17275550142'), '7275550142');
  assert.equal(normalizeNumber1('555-0142'), '', 'too short is empty, not a padded guess');
  assert.equal(normalizeNumber1(null), '');
});

test('LPRecKey is INQ + in1_id, verified against the export', () => {
  // The six pairs confirmed 6/6 against Data_Hot_Sample on 2026-09-04.
  for (const [in1, key] of [
    ['419729', 'INQ419729'], ['419681', 'INQ419681'], ['420255', 'INQ420255'],
    ['420336', 'INQ420336'], ['420359', 'INQ420359'], ['420775', 'INQ420775'],
  ]) {
    assert.equal(deriveLpRecKey(in1), key);
  }
});

test('a blank in1_id yields no LPRecKey — never the string "INQ"', () => {
  // Lead 573055 is real and has a blank in1_id: a setter created it directly
  // in LP, so there is no inbound record. That is expected, not an error.
  for (const blank of ['', null, undefined, '   ']) {
    assert.equal(deriveLpRecKey(blank), null);
  }
});

/* --- the record ---------------------------------------------------------- */

test('a complete contact maps every verified field', () => {
  const rec = buildCallbackRecord({ contactId: CONTACT_ID, ghlContact, lpRow });
  const m = asMap(rec);
  assert.equal(m.number1, '7275550142');
  assert.equal(m.first_name, 'Robert');
  assert.equal(m.last_name, 'Pederson');
  assert.equal(m.street, '123 Palm Ave');
  assert.equal(m.city, 'Clearwater');
  assert.equal(m.state, 'FL');
  assert.equal(m.zip, '33755');
  assert.equal(m.email, 'robert@example.com');
  assert.equal(m.CustID, '369848', 'CustID is lp_prospect_id — the screen-pop key');
  assert.equal(m.lead_id, '573111');
  assert.equal(m.LPRecKey, 'INQ420972');
  assert.equal(m.call_ID, CONTACT_ID, 'the GHL contact id rides call_ID for reconciliation');
  assert.equal(rec.fieldNames.length, rec.values.length, 'fieldsMapping pairs positionally with values');
});

test('a missing CustID is a hard refusal, not a partial push', () => {
  assert.throws(
    () => buildCallbackRecord({ contactId: CONTACT_ID, ghlContact, lpRow: { lp_lead_id: '573111' } }),
    /no CustID/,
  );
  // Blank and whitespace are the same as absent — a record with CustID=""
  // pops a blank LP screen just as surely as one with no field at all.
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(
      () => buildCallbackRecord({ contactId: CONTACT_ID, ghlContact, lpRow: { lp_prospect_id: bad } }),
      /no CustID/,
      `lp_prospect_id=${JSON.stringify(bad)} must refuse`,
    );
  }
});

test('a contact with no dialable number is refused too', () => {
  assert.throws(
    () => buildCallbackRecord({ contactId: CONTACT_ID, ghlContact: { ...ghlContact, phone: '' }, lpRow }),
    /no usable 10-digit phone/,
  );
});

test('no Five9-owned field is ever written', () => {
  const rec = buildCallbackRecord({ contactId: CONTACT_ID, ghlContact, lpRow });
  for (const owned of FIVE9_OWNED_FIELDS) {
    assert.ok(!rec.fieldNames.includes(owned), `${owned} is Five9's — writing it risks a record outside its own 48h filter`);
  }
});

test('cqd_id is never sent', () => {
  const rec = buildCallbackRecord({ contactId: CONTACT_ID, ghlContact, lpRow });
  assert.ok(!rec.fieldNames.includes('cqd_id'));
});

test('LPRecType is omitted unless explicitly configured', () => {
  withEnv({ FIVE9_CALLBACK_LPRECTYPE: undefined }, () => {
    const rec = buildCallbackRecord({ contactId: CONTACT_ID, ghlContact, lpRow });
    assert.ok(!rec.fieldNames.includes('LPRecType'), 'omitted cannot match another campaign filter; a guess can');
    assert.equal(rec.lpRecType, null);
  });
  withEnv({ FIVE9_CALLBACK_LPRECTYPE: 'cst' }, () => {
    const rec = buildCallbackRecord({ contactId: CONTACT_ID, ghlContact, lpRow });
    assert.equal(asMap(rec).LPRecType, 'cst');
  });
});

test('blank optional fields are dropped, not sent as empty strings', () => {
  // An empty value would overwrite whatever Five9 already holds. A contact
  // with no email on file must not blank the email Five9 has.
  const rec = buildCallbackRecord({
    contactId: CONTACT_ID,
    ghlContact: { phone: '7275550142', firstName: 'Robert', lastName: 'Pederson' },
    lpRow: { lp_prospect_id: '369848' },
  });
  for (const f of ['email', 'street', 'city', 'state', 'zip', 'lead_id']) {
    assert.ok(!rec.fieldNames.includes(f), `${f} should be dropped when blank`);
  }
  assert.deepEqual(rec.fieldNames, ['number1', 'first_name', 'last_name', 'CustID', 'call_ID']);
  assert.equal(rec.values.length, rec.fieldNames.length);
});

test('LP row fills address gaps the GHL contact does not have', () => {
  const rec = buildCallbackRecord({
    contactId: CONTACT_ID,
    ghlContact: { phone: '7275550142', firstName: 'R', lastName: 'P' },
    lpRow: { ...lpRow, address: '9 LP St', city: 'Tampa', state: 'FL', zip: '33601' },
  });
  const m = asMap(rec);
  assert.equal(m.street, '9 LP St');
  assert.equal(m.city, 'Tampa');
});

/* --- env --------------------------------------------------------------- */

test('list name and callNowMode default to the live Five9 values', () => {
  withEnv({ FIVE9_CALLBACK_LIST_NAME: undefined, FIVE9_CALLBACK_CALL_NOW_MODE: undefined }, () => {
    assert.equal(callbackListName(), 'Callback Request');
    assert.equal(callbackCallNowMode(), 'ANY', 'ANY, so an existing CRM match still gets marked call-now');
  });
  withEnv({ FIVE9_CALLBACK_CALL_NOW_MODE: 'NONE' }, () => {
    assert.equal(callbackCallNowMode(), 'NONE', 'dialing can be turned off from Railway without a deploy');
  });
  withEnv({ FIVE9_CALLBACK_LPRECTYPE: '  ' }, () => {
    assert.equal(callbackLpRecType(), null, 'whitespace is not a value');
  });
});

/* --- cross-list suppression --------------------------------------------- */

test('a contact live in another list is suppressed', async () => {
  const res = await findContactInOtherLists('7275550142', {
    listName: 'Callback Request',
    deps: { getContactRecords: async () => ({ records: [{ number1: '7275550142', f9_last_list: 'LP_ASAP' }] }) },
  });
  assert.equal(res.suppress, true);
  assert.deepEqual(res.lists, ['LP_ASAP']);
  assert.equal(res.failed_open, false);
});

test('our own list does not suppress us', async () => {
  const res = await findContactInOtherLists('7275550142', {
    listName: 'Callback Request',
    deps: { getContactRecords: async () => ({ records: [{ f9_last_list: 'Callback Request' }] }) },
  });
  assert.equal(res.suppress, false, 'a prior callback is not a reason to refuse the next one');
});

test('no records means no suppression', async () => {
  const res = await findContactInOtherLists('7275550142', {
    deps: { getContactRecords: async () => ({ records: [] }) },
  });
  assert.equal(res.suppress, false);
  assert.equal(res.failed_open, false);
});

test('a Five9 read error FAILS OPEN and says so', async () => {
  // The asymmetry that matters: a missing CustID refuses (the record would be
  // unworkable), but an unreadable list proceeds (silence is the worse harm).
  const res = await findContactInOtherLists('7275550142', {
    deps: { getContactRecords: async () => { throw new Error('five9 timeout'); } },
  });
  assert.equal(res.suppress, false, 'a promised call must not die on an unreadable list');
  assert.equal(res.failed_open, true, 'and the fail-open must be visible');
  assert.match(res.error, /five9 timeout/);
});

test('a malformed Five9 response does not throw', async () => {
  for (const bad of [null, {}, { records: null }, { records: 'nope' }]) {
    const res = await findContactInOtherLists('7275550142', { deps: { getContactRecords: async () => bad } });
    assert.equal(res.suppress, false);
  }
});

test('blank f9_last_list values are ignored', async () => {
  const res = await findContactInOtherLists('7275550142', {
    deps: { getContactRecords: async () => ({ records: [{ f9_last_list: '' }, { f9_last_list: '   ' }, {}] }) },
  });
  assert.equal(res.suppress, false, 'a contact Five9 has never worked is not "in another list"');
});

/* --- the builder change that makes it dial -------------------------------- */

test('callNowMode sits between skipHeaderLine and cleanListBeforeUpdate', async () => {
  // JAXB rejects out-of-order elements, so this position is not cosmetic. The
  // live v13 WSDL puts the four callNow/callTime elements at the head of the
  // listUpdateSettings extension, i.e. after every basicImportSettings field
  // (skipHeaderLine is the last of those) and before cleanListBeforeUpdate.
  // LIST_UPDATE_SETTINGS_FIELD_ORDER is diffed against the artifact in
  // scripts/test-five9-wsdl-schema.js; this asserts the emitted XML agrees.
  const { buildAddRecordToListXml } = await import('../src/five9/admin-writes.js');
  const xml = buildAddRecordToListXml('Callback Request', ['number1'], ['7275550142'], 'ANY');
  assert.match(xml, /<skipHeaderLine>false<\/skipHeaderLine><callNowMode>ANY<\/callNowMode><cleanListBeforeUpdate>/);
});

test('omitting callNowMode leaves the pre-existing XML byte-identical', async () => {
  // Every caller before the callback push appends without dialing. That
  // behaviour must not change underneath them.
  const { buildAddRecordToListXml } = await import('../src/five9/admin-writes.js');
  const plain = buildAddRecordToListXml('L', ['number1'], ['7275550142']);
  assert.ok(!plain.includes('callNowMode'));
  assert.match(plain, /<skipHeaderLine>false<\/skipHeaderLine><cleanListBeforeUpdate>/);
  assert.equal(plain, buildAddRecordToListXml('L', ['number1'], ['7275550142'], null));
});

test('an invalid callNowMode is refused rather than sent', async () => {
  const { buildAddRecordToListXml, CALL_NOW_MODES } = await import('../src/five9/admin-writes.js');
  assert.deepEqual([...CALL_NOW_MODES], ['NONE', 'NEW_CRM_ONLY', 'NEW_LIST_ONLY', 'ANY']);
  for (const bad of ['ASAP', 'any', 'TRUE', 'callAsap']) {
    assert.throws(() => buildAddRecordToListXml('L', ['number1'], ['7275550142'], bad), /invalid call_now_mode/);
  }
});

test('LP_REQUEUE_MODE selects the path and is typo-safe', async () => {
  const { requeueMode } = await import('../src/actions/handlers/lp-requeue.js');
  withEnv({ LP_REQUEUE_MODE: undefined }, () => assert.equal(requeueMode(), 'five9', 'five9 is the default'));
  withEnv({ LP_REQUEUE_MODE: 'lp_leadadd' }, () => assert.equal(requeueMode(), 'lp_leadadd'));
  withEnv({ LP_REQUEUE_MODE: '  LP_LeadAdd  ' }, () => assert.equal(requeueMode(), 'lp_leadadd', 'case and padding tolerated'));
  // A typo must not take the callback path down entirely — it falls back to
  // the current default rather than throwing on every callback.
  for (const typo of ['five', 'lp_lead_add', 'xyz', '']) {
    withEnv({ LP_REQUEUE_MODE: typo }, () => assert.equal(requeueMode(), 'five9', `"${typo}" falls back`));
  }
});
