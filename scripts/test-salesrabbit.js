/**
 * test-salesrabbit.js — server-side SalesRabbit lead update.
 *
 * Replaces the I.CC inline-token Custom Webhook. Asserts the request
 * shape captured from the live workflow (PUT /leads/{id}, { data: ... }
 * envelope, Appointment Set status, counts/spouse custom fields,
 * propertyType omitted) and that the helper NEVER throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { updateSalesRabbitLead } from '../src/salesrabbit.js';

function captureFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ...response, text: async () => response._text || '' };
  };
  return { calls, fetchImpl };
}

test('PUT shape: url, bearer auth, Appointment Set, custom fields, no propertyType', async () => {
  const { calls, fetchImpl } = captureFetch();
  const result = await updateSalesRabbitLead(
    '4746413',
    { windowCount: '15', doorCount: '1', sliderCount: '2', spouseName: 'Paloma' },
    { fetchImpl, token: 'tok-123' }
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.salesrabbit.com/leads/4746413');
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-123');

  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.data.status, 'Appointment Set');
  assert.deepEqual(body.data.customFields, {
    windowCount: '15',
    doorCount: '1',
    sliderCount: '2',
    spouseName: 'Paloma',
  });
  assert.equal('propertyType' in body.data.customFields, false);
});

test('proID included only when proId provided', async () => {
  const { calls, fetchImpl } = captureFetch();
  await updateSalesRabbitLead('1', { windowCount: '5', proId: '5152' }, { fetchImpl, token: 't' });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.data.customFields.proID, '5152');
});

test('missing counts serialize as empty strings (SalesRabbit tolerates empty)', async () => {
  const { calls, fetchImpl } = captureFetch();
  await updateSalesRabbitLead('1', {}, { fetchImpl, token: 't' });
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.data.customFields, {
    windowCount: '',
    doorCount: '',
    sliderCount: '',
    spouseName: '',
  });
});

test('no token → { ok:false, reason:no_token }, fetch never called', async () => {
  const { calls, fetchImpl } = captureFetch();
  const result = await updateSalesRabbitLead('1', {}, { fetchImpl, token: undefined });
  assert.deepEqual(result, { ok: false, reason: 'no_token' });
  assert.equal(calls.length, 0);
});

test('no salesrabbit id → { ok:false, reason:no_salesrabbit_id }', async () => {
  const result = await updateSalesRabbitLead('', {}, { token: 't' });
  assert.deepEqual(result, { ok: false, reason: 'no_salesrabbit_id' });
});

test('HTTP failure → ok:false with status, never throws', async () => {
  const { fetchImpl } = captureFetch({ ok: false, status: 500, _text: 'server error' });
  const result = await updateSalesRabbitLead('1', {}, { fetchImpl, token: 't' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test('network/timeout error → ok:false with reason, never throws', async () => {
  const fetchImpl = async () => {
    throw new Error('aborted');
  };
  const result = await updateSalesRabbitLead('1', {}, { fetchImpl, token: 't' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'aborted');
});
