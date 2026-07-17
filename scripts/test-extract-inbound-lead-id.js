/**
 * test-extract-inbound-lead-id.js — LP addLead response parsing.
 *
 * Replaces the retired I.CC custom-code parser (`message.split(': ')[1]`)
 * that threw on any LP error response. extractInboundLeadId must be
 * tolerant of every response shape and NEVER throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractInboundLeadId } from '../src/lp-client.js';

test('happy path: legacy "lead added: NNNNNN" message', () => {
  assert.equal(extractInboundLeadId({ status: 'OK', message: 'lead added: 384191' }), '384191');
  assert.equal(extractInboundLeadId({ status: 'OK', message: 'Lead Added:384191' }), '384191');
});

test('happy path: explicit id keys win', () => {
  assert.equal(extractInboundLeadId({ in1_id: 123 }), '123');
  assert.equal(extractInboundLeadId({ id: '456' }), '456');
  assert.equal(extractInboundLeadId({ leadId: 789 }), '789');
  assert.equal(extractInboundLeadId({ lead_id: '321' }), '321');
});

test('error-status body → null, no throw', () => {
  assert.equal(extractInboundLeadId({ status: 'ERROR', error: 'invalid srs_id', message: 'rejected' }), null);
});

test('empty / null / undefined bodies → null, no throw', () => {
  assert.equal(extractInboundLeadId({}), null);
  assert.equal(extractInboundLeadId(null), null);
  assert.equal(extractInboundLeadId(undefined), null);
});

test('non-JSON-object bodies → null-ish, no throw', () => {
  assert.doesNotThrow(() => extractInboundLeadId('lead added: 99'));
  assert.doesNotThrow(() => extractInboundLeadId(42));
  assert.doesNotThrow(() => extractInboundLeadId(true));
  assert.equal(extractInboundLeadId({ message: 12345 }), '12345'); // numeric message coerced
  assert.equal(extractInboundLeadId({ message: { nested: true } }), null);
});

test('message without trailing digits → null', () => {
  assert.equal(extractInboundLeadId({ status: 'OK', message: 'welcome to the machine' }), null);
});
