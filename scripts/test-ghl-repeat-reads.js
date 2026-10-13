/**
 * Stop re-asking GHL what we already know (2026-10-13). #1248's per-caller
 * counts: the capacity sweep's lead loop made 60,253 of ~125,600 GHL requests
 * in 24h, mostly a phone/email search for leads whose link was already stored.
 * A capacity pass now reuses a stored, classified link (storedLinkToReuse) and
 * skips an active-entry add the tag snapshot already shows.
 *
 * Run: node --test scripts/test-ghl-repeat-reads.js
 */
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { storedLinkToReuse, activeEntryAlreadySet } = await import('../src/sync-leads.js');

const C = 'aBcDeFgHiJkLmNoPqRsT';
const D = 'zYxWvUtSrQpOnMlKjIhG';
const lead = (id, extra = {}) => ({ id, ...extra });
const row = (id, ghl = C, src = 'phone_email_match') => ({ lp_lead_id: id, ghl_contact_id: ghl, ghl_link_source: src });

test('reuse: every lead linked to the same contact with a classified source', () => {
  assert.equal(storedLinkToReuse([lead('1'), lead('2')], [row('1'), row('2', C, 'lognumber_verified')]), C);
});

test('full match: an unlinked lead, a missing row, or no leads', () => {
  assert.equal(storedLinkToReuse([lead('1'), lead('2')], [row('1')]), null);
  assert.equal(storedLinkToReuse([lead('1')], [row('1', null)]), null);
  assert.equal(storedLinkToReuse([], []), null);
});

test('full match: a legacy_unverified or unclassified link is corroborated as before', () => {
  assert.equal(storedLinkToReuse([lead('1')], [row('1', C, 'legacy_unverified')]), null);
  assert.equal(storedLinkToReuse([lead('1')], [row('1', C, null)]), null);
});

test('full match: two different contacts, or a lognumber naming another contact', () => {
  assert.equal(storedLinkToReuse([lead('1'), lead('2')], [row('1'), row('2', D)]), null);
  assert.equal(storedLinkToReuse([lead('1', { lognumber: D })], [row('1')]), null);
  assert.equal(storedLinkToReuse([lead('1', { lognumber: C })], [row('1')]), C, 'a lognumber that agrees is fine');
});

test('active-entry: skip the add only when exactly that tag is already there', () => {
  assert.equal(activeEntryAlreadySet(['x', 'active-entry:canvassing'], 'active-entry:canvassing'), true);
  assert.equal(activeEntryAlreadySet(['active-entry:canvassing', 'active-entry:other'], 'active-entry:canvassing'), false, 'a conflicting tag needs the executor');
  assert.equal(activeEntryAlreadySet(['active-entry:other'], 'active-entry:canvassing'), false);
  assert.equal(activeEntryAlreadySet(null, 'active-entry:canvassing'), false);
});
