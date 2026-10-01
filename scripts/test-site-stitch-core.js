/**
 * Tests — I.STITCH pure helpers (2026-10-01 overwrite fix)
 * scripts/test-site-stitch-core.js
 *
 *   node --test scripts/test-site-stitch-core.js
 *
 * Guards three things that broke on the Mark Test live check (2026-10-01):
 *  - a returning contact on a new browser had their GHL site totals REPLACED by
 *    the new visitor's alone (31 pages / score 100 → 5 / 30);
 *  - an unknown first touch was written as '' and could erase a real one;
 *  - an email shared by 7 GHL contacts resolved to whichever GHL listed first.
 * No DB, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAggregateSql, buildSiteFieldUpdates, exactMatches, pickContact, buildMappedContactsSql,
} from '../src/site-stitch-core.js';

const FIELDS = { last_site_visit: 'f_last', site_intent_score: 'f_score', site_pages_viewed: 'f_pages', first_touch_source: 'f_ft' };

test('aggregate covers every visitor already mapped to the contact, not just this one', () => {
  const sql = buildAggregateSql({ visitorId: 'v_new', contactId: 'C1', maxEventId: 42, recencyDays: 7 });
  // the new visitor seeds the set …
  assert.match(sql, /select 'v_new'::text as vid/);
  // … and so does every visitor previously stitched to this contact
  assert.match(sql, /select visitor_id from public\.visitor_identity_map where contact_id = 'C1'/);
  // links are followed from the WHOLE seed, not only the new visitor
  assert.match(sql, /l\.id_a in \(select vid from seed\) or l\.id_b in \(select vid from seed\)/);
  assert.match(sql, /interval '7 days'/);
  assert.match(sql, /42::bigint as max_site_event_id/);
});

test('aggregate SQL escapes quotes in ids', () => {
  const sql = buildAggregateSql({ visitorId: "v'x", contactId: "C'1", maxEventId: 1, recencyDays: 7 });
  assert.match(sql, /'v''x'::text/);
  assert.match(sql, /contact_id = 'C''1'/);
  assert.doesNotMatch(sql, /'v'x'/);
});

test('a blank first touch is never written (it would erase the one GHL holds)', () => {
  for (const ft of [null, undefined, '', '   ']) {
    const cf = buildSiteFieldUpdates(FIELDS, { last_visit: '2026-10-01T00:00:00Z', pageviews: 5, first_touch_source: ft }, 30);
    assert.equal(cf.find(f => f.id === 'f_ft'), undefined, `first touch ${JSON.stringify(ft)} must not be sent`);
    assert.deepEqual(cf.map(f => f.id), ['f_last', 'f_score', 'f_pages']);
  }
});

test('a real first touch is written, along with the other three fields', () => {
  const cf = buildSiteFieldUpdates(FIELDS, { last_visit: '2026-10-01T00:00:00Z', pageviews: '64', first_touch_source: ' google ' }, 100);
  assert.deepEqual(cf, [
    { id: 'f_last', field_value: '2026-10-01T00:00:00Z' },
    { id: 'f_score', field_value: 100 },
    { id: 'f_pages', field_value: 64 },
    { id: 'f_ft', field_value: 'google' },
  ]);
});

test('missing field ids or a missing last visit are skipped, not sent empty', () => {
  assert.deepEqual(buildSiteFieldUpdates({}, { pageviews: 3 }, 10), []);
  assert.deepEqual(buildSiteFieldUpdates(FIELDS, { pageviews: 0, last_visit: null }, 0).map(f => f.id), ['f_score', 'f_pages']);
  assert.deepEqual(buildSiteFieldUpdates(null, null, 0), []);
});

test('exactMatches: email is case-insensitive and exact; phone compares the last 10 digits', () => {
  const contacts = [
    { id: 'a', email: 'Mark@Example.com', phone: '+19545081512' },
    { id: 'b', email: 'mark@example.com.au', phone: '+19543792151' },
    { id: 'c', email: null, phone: '(954) 379-2151' },
  ];
  assert.deepEqual(exactMatches(contacts, { email: 'mark@example.com' }).map(c => c.id), ['a']);
  assert.deepEqual(exactMatches(contacts, { phone: '9543792151' }).map(c => c.id), ['b', 'c']);
  assert.deepEqual(exactMatches(contacts, { phone: '12345' }), []);
  assert.deepEqual(exactMatches(null, { email: 'x@y.z' }), []);
});

// The 2026-10-01 shape: one real contact, six bare risk-report duplicates.
const MAIN = { id: 'MAIN', email: 'm@x.com', firstName: 'Mark', lastName: 'Test', phone: '+19545081512', dateUpdated: '2026-10-01T04:48:51Z' };
const SHELL = (id, updated) => ({ id, email: 'm@x.com', contactName: 'm@x.com', firstName: null, lastName: null, phone: null, dateUpdated: updated });
const DUPES = [SHELL('D1', '2026-10-01T09:00:00Z'), SHELL('D2', '2026-06-10T20:10:31Z'), MAIN, SHELL('D3', '2026-05-29T15:51:15Z')];

test('pickContact: duplicates resolve to the complete record, not to GHL list order', () => {
  // D1 is first AND most recently updated, but a bare shell — MAIN must win.
  assert.equal(pickContact(DUPES, {}).id, 'MAIN');
});

test('pickContact: the contact this visitor is already stitched to wins over everything', () => {
  assert.equal(pickContact(DUPES, { visitorContactId: 'D2', mappedContactIds: ['D2'] }).id, 'D2');
});

test('pickContact: a phone match beats record quality and other visitors\' stitches', () => {
  const withPhone = [...DUPES, { id: 'P', email: 'm@x.com', phone: '+19543792151', dateUpdated: '2020-01-01T00:00:00Z' }];
  assert.equal(pickContact(withPhone, { phone: '954/379/2151', mappedContactIds: ['MAIN'] }).id, 'P');
});

test('pickContact: a contact some other visitor was stitched to beats an unmapped one', () => {
  const twoReal = [MAIN, { ...MAIN, id: 'MAIN2', dateUpdated: '2026-10-02T00:00:00Z' }];
  assert.equal(pickContact(twoReal, {}).id, 'MAIN2');                          // tie → most recent
  assert.equal(pickContact(twoReal, { mappedContactIds: ['MAIN'] }).id, 'MAIN'); // mapped wins
});

test('pickContact: empty and single inputs', () => {
  assert.equal(pickContact([], {}), null);
  assert.equal(pickContact(null, {}), null);
  assert.equal(pickContact([MAIN], {}).id, 'MAIN');
});

test('buildMappedContactsSql: escaped ids, null when there is nothing to ask', () => {
  const sql = buildMappedContactsSql(['A', "B'1"], "v'1");
  assert.match(sql, /contact_id in \('A','B''1'\)/);
  assert.match(sql, /visitor_id = 'v''1'/);
  assert.equal(buildMappedContactsSql([], 'v'), null);
});
