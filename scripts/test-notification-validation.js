/**
 * Tests — appointment notification request validation
 * scripts/test-notification-validation.js
 *
 * Locks the ALLOW_EMPTY contract that caused the 2026-08-17 outage: GHL omits a
 * customData key entirely when its merge tag resolves to empty, so lp_source /
 * lp_subsource must be OPTIONAL, not "required but may be blank". Every other
 * field keeps strict validation.
 *
 * Run with:  node --test scripts/test-notification-validation.js
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { validateRequest } from '../src/notifications/appointment-notifications.js';

const base = {
  status: 'cancelled',
  contact_id: 'abc123',
  contact_name: 'Jane Doe',
  contact_first_name: 'Jane',
  contact_last_name: 'Doe',
  contact_phone: '+15551234567',
  calendar_id: 'aJj14ONxh1oFyDcQ706O',
  appointment_title: 'Window Estimate',
  start_time: '2:00 PM',
  start_date: '2026-08-19',
  lp_source: 'Canvass',
  lp_subsource: 'Canvass',
};

test('omitted lp_source / lp_subsource are optional (the outage)', () => {
  const b = { ...base };
  delete b.lp_source;
  delete b.lp_subsource;
  const r = validateRequest(b);
  assert.equal(r.valid, true, r.errors.join('; '));
  assert.equal(r.normalized.lp_source, '');
  assert.equal(r.normalized.lp_subsource, '');
});

test('empty-string lp_source still passes', () => {
  const r = validateRequest({ ...base, lp_source: '', lp_subsource: '' });
  assert.equal(r.valid, true, r.errors.join('; '));
});

test('genuinely required fields still fail when omitted', () => {
  for (const k of ['contact_id', 'contact_name', 'contact_phone', 'start_date', 'appointment_title']) {
    const b = { ...base };
    delete b[k];
    const r = validateRequest(b);
    assert.equal(r.valid, false, `${k} should be required`);
    assert.ok(r.errors.some((e) => e.includes(k)));
  }
});

test('whitespace-only still fails for required fields', () => {
  const r = validateRequest({ ...base, contact_name: '   ' });
  assert.equal(r.valid, false);
});

test('rescheduled still demands the previous slot', () => {
  const r = validateRequest({ ...base, status: 'rescheduled' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('previous_start_time')));
});

test('null lp_source is tolerated the same as an omitted one', () => {
  const r = validateRequest({ ...base, lp_source: null, lp_subsource: null });
  assert.equal(r.valid, true, r.errors.join('; '));
  assert.equal(r.normalized.lp_source, '');
});

test('a null required field still fails', () => {
  const r = validateRequest({ ...base, contact_id: null });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('contact_id')));
});
