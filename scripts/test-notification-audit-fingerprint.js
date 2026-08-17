/**
 * Tests — appointment notification auth fingerprint
 * scripts/test-notification-audit-fingerprint.js
 *
 * Covers the non-secret bearer fingerprint that lets an audit row tell an
 * unresolved GHL merge tag (empty bearer) apart from a genuine token
 * mismatch, without ever recording the token itself.
 *
 * Run with:  node --test scripts/test-notification-audit-fingerprint.js
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { _internal } from '../src/notifications/appointment-notifications.js';

const { checkBearerAuth } = _internal;

const req = (auth) => ({ headers: auth == null ? {} : { authorization: auth } });

test('empty bearer is distinguishable from a wrong token', () => {
  process.env.MESSAGE_ENGINE_TOKEN = 'a'.repeat(36);

  const empty = checkBearerAuth(req('Bearer '));
  assert.equal(empty.ok, false);
  assert.equal(empty.fingerprint.provided_len, 0);
  assert.equal(empty.fingerprint.scheme, 'bearer');

  const wrong = checkBearerAuth(req('Bearer ' + 'b'.repeat(36)));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.fingerprint.provided_len, 36);

  const missing = checkBearerAuth(req(null));
  assert.equal(missing.ok, false);
  assert.equal(missing.fingerprint.header_present, false);

  const trailing = checkBearerAuth(req('Bearer ' + 'a'.repeat(36) + '\n'));
  assert.equal(trailing.ok, false);
  assert.equal(trailing.fingerprint.provided_trimmed_len, 36);

  assert.equal(checkBearerAuth(req('Bearer ' + 'a'.repeat(36))).ok, true);
});

test('no token configured means auth is open', () => {
  delete process.env.MESSAGE_ENGINE_TOKEN;
  assert.equal(checkBearerAuth(req(null)).ok, true);
});

test('the fingerprint never carries the token or any prefix of it', () => {
  process.env.MESSAGE_ENGINE_TOKEN = 'sekret-token-value-0123456789abcdef';
  const { fingerprint } = checkBearerAuth(req('Bearer wrong-token-value-0123456789abcdef'));
  const serialized = JSON.stringify(fingerprint);
  assert.ok(!serialized.includes('sekret'), 'expected token not to appear in fingerprint');
  assert.ok(!serialized.includes('wrong'), 'provided token must not appear in fingerprint');
  assert.deepEqual(Object.keys(fingerprint).sort(), [
    'expected_len',
    'header_present',
    'provided_len',
    'provided_trimmed_len',
    'scheme',
  ]);
  delete process.env.MESSAGE_ENGINE_TOKEN;
});

test('a non-bearer scheme is reported as other', () => {
  process.env.MESSAGE_ENGINE_TOKEN = 'a'.repeat(36);
  const basic = checkBearerAuth(req('Basic dXNlcjpwYXNz'));
  assert.equal(basic.ok, false);
  assert.equal(basic.fingerprint.scheme, 'other');
  assert.equal(basic.fingerprint.header_present, true);
  assert.equal(basic.fingerprint.provided_len, null);

  const none = checkBearerAuth(req(null));
  assert.equal(none.fingerprint.scheme, 'none');
  delete process.env.MESSAGE_ENGINE_TOKEN;
});
