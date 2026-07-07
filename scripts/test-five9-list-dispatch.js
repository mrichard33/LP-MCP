/**
 * scripts/test-five9-list-dispatch.js
 *
 * Offline unit tests for the Five9 list-dispatch module
 * (call-dispatch-integrity 2026-07-07): the pure addRecordToList SOAP-body
 * builder (column order, key flag, XML escaping, parity), the already-exists
 * fault matcher, and the dormant-by-default config gate. No network.
 *
 * Run: node --test scripts/test-five9-list-dispatch.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAddRecordToListXml,
  isAlreadyExistsFault,
  five9DispatchConfigured,
} from '../src/five9/list-dispatch.js';

test('buildAddRecordToListXml: column order, key flag, and settings', () => {
  const xml = buildAddRecordToListXml(
    'GHL Confirmation Callbacks',
    ['number1', 'first_name', 'last_name', 'call_purpose'],
    ['5551234567', 'Mark', 'Test', 'pricing_questions'],
  );

  assert.match(xml, /<listName>GHL Confirmation Callbacks<\/listName>/);
  // number1 is column 1 and the key; others are not keys.
  assert.match(xml, /<fieldsMapping><columnNumber>1<\/columnNumber><fieldName>number1<\/fieldName><key>true<\/key><\/fieldsMapping>/);
  assert.match(xml, /<fieldsMapping><columnNumber>2<\/columnNumber><fieldName>first_name<\/fieldName><key>false<\/key><\/fieldsMapping>/);
  assert.match(xml, /<fieldsMapping><columnNumber>4<\/columnNumber><fieldName>call_purpose<\/fieldName><key>false<\/key><\/fieldsMapping>/);
  // Update settings: add-new, update-first, list-add-first.
  assert.match(xml, /<crmAddMode>ADD_NEW<\/crmAddMode>/);
  assert.match(xml, /<crmUpdateMode>UPDATE_FIRST<\/crmUpdateMode>/);
  assert.match(xml, /<listAddMode>ADD_FIRST<\/listAddMode>/);
  // Values arrive in column order.
  assert.match(xml, /<record><values>5551234567<\/values><values>Mark<\/values><values>Test<\/values><values>pricing_questions<\/values><\/record>/);
});

test('buildAddRecordToListXml: XML-escapes user values and handles null/undefined', () => {
  const xml = buildAddRecordToListXml(
    'A&B <List>',
    ['number1', 'notes'],
    ['5551234567', null],
  );
  assert.match(xml, /<listName>A&amp;B &lt;List&gt;<\/listName>/);
  assert.match(xml, /<values><\/values>/, 'null value renders as empty <values>');
  const xml2 = buildAddRecordToListXml('L', ['number1', 'first_name'], ['5550000000', 'O\'Brien & Sons <QA>']);
  assert.match(xml2, /<values>O&apos;Brien &amp; Sons &lt;QA&gt;<\/values>/);
});

test('buildAddRecordToListXml: throws on fields/values count mismatch', () => {
  assert.throws(
    () => buildAddRecordToListXml('L', ['number1', 'first_name'], ['5551234567']),
    /mismatch/,
  );
});

test('isAlreadyExistsFault matches the known Five9 duplicate-fault phrasings', () => {
  assert.equal(isAlreadyExistsFault('List "X" already exists'), true);
  assert.equal(isAlreadyExistsFault('An object with the same name already exists in the domain'), true);
  assert.equal(isAlreadyExistsFault('Duplicate list name'), true);
  assert.equal(isAlreadyExistsFault('ALREADY EXIST'), true);
  assert.equal(isAlreadyExistsFault('Insufficient permissions for createList'), false);
  assert.equal(isAlreadyExistsFault(''), false);
  assert.equal(isAlreadyExistsFault(null), false);
});

test('five9DispatchConfigured: dormant by default and with partial config', () => {
  const saved = {};
  for (const k of ['FIVE9_DIRECT_DISPATCH', 'FIVE9_CALLBACK_LIST', 'FIVE9_CALLBACK_CAMPAIGN', 'FIVE9_USERNAME', 'FIVE9_PASSWORD']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    assert.equal(five9DispatchConfigured(), false, 'all env absent → dormant');

    process.env.FIVE9_DIRECT_DISPATCH = 'true';
    assert.equal(five9DispatchConfigured(), false, 'flag alone is not enough');

    process.env.FIVE9_CALLBACK_LIST = 'GHL Confirmation Callbacks';
    process.env.FIVE9_CALLBACK_CAMPAIGN = 'GHL Callbacks';
    assert.equal(five9DispatchConfigured(), false, 'still needs credentials');

    process.env.FIVE9_USERNAME = 'svc';
    process.env.FIVE9_PASSWORD = 'pw';
    assert.equal(five9DispatchConfigured(), true, 'full config → live');

    process.env.FIVE9_DIRECT_DISPATCH = 'false';
    assert.equal(five9DispatchConfigured(), false, 'explicit false wins over full config');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
