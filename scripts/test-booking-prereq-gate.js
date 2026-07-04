/**
 * In-home booking prerequisite backstop (R2) —
 * scripts/test-booking-prereq-gate.js
 *
 * Victor Lopez incident (2026-07-04): a Saturday in-home slot was "held"
 * for a contact whose record was still "Guest Visitor bljpx" with no
 * address and no decision-maker answer. R2: an in-home appointment may
 * NEVER be created without real name + phone + street address + zip +
 * the decision-maker question having been asked.
 *
 * Tests evaluateInHomePrerequisites (the handler-level backstop) via the
 * same global-fetch stub as scripts/test-tag-safety.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';

let currentContact = { id: 'c1', tags: [] };

function jsonRes(body) {
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  if ((opts.method || 'GET') === 'GET') return jsonRes({ contact: currentContact });
  return jsonRes({ ok: true });
};

const { evaluateInHomePrerequisites } = await import('../src/actions/handlers/appointments.js');

const DM_FIELD_ID = 'GH1QGGOseMKmJAMqajiN';
const ctx = () => ({ _contactCache: new Map() });

test('placeholder name + no address blocks in-home creation', async () => {
  currentContact = {
    id: 'c1', firstName: 'Guest Visitor bljpx', lastName: '',
    phone: '+15613230334', tags: [], customFields: [],
  };
  const r = await evaluateInHomePrerequisites('c1', {}, ctx());
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('real_name'));
  assert.ok(r.missing.includes('address'));
  assert.ok(r.missing.includes('decision_maker_question'));
});

test('street + zip on file passes address; city absence never blocks', async () => {
  currentContact = {
    id: 'c1', firstName: 'Victor', lastName: 'Lopez', phone: '+15613230334',
    address1: '2885 S Oasis Dr', postalCode: '33435', city: null,
    tags: [], customFields: [{ id: DM_FIELD_ID, value: 'Uncertain' }],
  };
  const r = await evaluateInHomePrerequisites('c1', {}, ctx());
  assert.equal(r.ok, true, `expected pass, missing=${r.missing.join(',')}`);
});

test('address without zip blocks (zip proves service area)', async () => {
  currentContact = {
    id: 'c1', firstName: 'Victor', lastName: 'Lopez', phone: '+15613230334',
    address1: '2885 S Oasis Dr', city: 'Boynton Beach', postalCode: null,
    tags: [], customFields: [{ id: DM_FIELD_ID, value: 'Yes' }],
  };
  const r = await evaluateInHomePrerequisites('c1', {}, ctx());
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['address']);
});

test('DM question satisfied by field, payload, or booking:dm-pending tag', async () => {
  const base = {
    id: 'c1', firstName: 'Victor', lastName: 'Lopez', phone: '+15613230334',
    address1: '2885 S Oasis Dr', postalCode: '33435',
  };
  // Not asked anywhere → blocked.
  currentContact = { ...base, tags: [], customFields: [] };
  let r = await evaluateInHomePrerequisites('c1', {}, ctx());
  assert.deepEqual(r.missing, ['decision_maker_question']);
  // GHL field set (even "No") → question was asked → passes.
  currentContact = { ...base, tags: [], customFields: [{ id: DM_FIELD_ID, value: 'No' }] };
  r = await evaluateInHomePrerequisites('c1', {}, ctx());
  assert.equal(r.ok, true);
  // Payload qualifying_data carries the answer → passes.
  currentContact = { ...base, tags: [], customFields: [] };
  r = await evaluateInHomePrerequisites('c1', { qualifying_data: { decision_makers_present: 'Uncertain' } }, ctx());
  assert.equal(r.ok, true);
  // booking:dm-pending tag (question outstanding) → passes.
  currentContact = { ...base, tags: ['booking:dm-pending'], customFields: [] };
  r = await evaluateInHomePrerequisites('c1', {}, ctx());
  assert.equal(r.ok, true);
});

test('contact-read failure fails OPEN (prompt gate stays primary)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('GHL 502'); };
  try {
    const r = await evaluateInHomePrerequisites('c1', {}, ctx());
    assert.equal(r.ok, true);
    assert.equal(r.failOpen, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
