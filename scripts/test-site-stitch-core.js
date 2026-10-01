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
  buildSummaryUpsertSql, buildRefreshCandidatesSql, refreshNoteReason, buildRetentionDeleteSql, refreshChanged,
} from '../src/site-stitch-core.js';
import { runSiteEventsRetention, retentionDays } from '../src/jobs/site-events-retention.js';

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

// ─── One row per lead + returning-visit refresh + retention (2026-10-01) ────

test('aggregate reports first_visit as well as last_visit', () => {
  const sql = buildAggregateSql({ visitorId: 'v', contactId: 'C', maxEventId: 1, recencyDays: 7 });
  assert.match(sql, /min\(created_at\) from ev\) as first_visit/);
  assert.match(sql, /max\(created_at\) from ev\) as last_visit/);
});

const AGG = {
  visitor_ids: ['b292', "v'2"], pageviews: '64', sessions: 4,
  first_visit: '2026-09-16T22:00:00Z', last_visit: '2026-10-01T14:59:18Z',
  first_touch_source: null, page_counts: { '/': 14, "/o'brien": 1 },
};

test('summary upsert: one row per contact, keyed on contact_id, values escaped', () => {
  const sql = buildSummaryUpsertSql({ contactId: 'BazzY5Ihu2heR4osVlBF', agg: AGG, score: 100, topPages: ['/', '/about/'] });
  assert.match(sql, /insert into public\.site_lead_summary/);
  assert.match(sql, /on conflict \(contact_id\) do update/);
  assert.match(sql, /array\['b292','v''2'\]::text\[\]/);
  assert.match(sql, /, 64, 4,/);
  assert.match(sql, /'2026-09-16T22:00:00Z'::timestamptz/);       // ISO passes through as-is
  assert.match(sql, /"\/o''brien":1/);           // jsonb text escaped
  assert.match(sql, /array\['\/','\/about\/'\]::text\[\]/);
});

test('summary upsert: an unknown first touch keeps the stored one', () => {
  const sql = buildSummaryUpsertSql({ contactId: 'C', agg: AGG, score: 1, topPages: [] });
  assert.match(sql, /,\s*null, 1,/);             // first_touch_source sent as null
  assert.match(sql, /first_touch_source = coalesce\(excluded\.first_touch_source, public\.site_lead_summary\.first_touch_source\)/);
  assert.match(sql, /'\{\}'::text\[\]/);           // empty top pages
});

test('summary upsert: junk numbers and dates become 0 / null, never broken SQL', () => {
  const sql = buildSummaryUpsertSql({ contactId: 'C', agg: { pageviews: 'x', first_visit: 'not a date' }, score: NaN, topPages: null });
  assert.match(sql, /'\{\}'::text\[\], 0, 0,\s*null, null, null, 0,/);
});

test('refresh candidates: backfill rows with no summary AND newer page views, capped', () => {
  const sql = buildRefreshCandidatesSql(50);
  assert.match(sql, /left join public\.site_lead_summary s on s\.contact_id = m\.contact_id/);
  assert.match(sql, /where s\.contact_id is null/);
  assert.match(sql, /e\.created_at\) > coalesce\(s\.last_visit, '-infinity'::timestamptz\)/);
  assert.match(sql, /distinct on \(m\.contact_id\)/);
  assert.match(sql, /limit 50$/);
  assert.match(buildRefreshCandidatesSql(99999), /limit 500$/);
  assert.match(buildRefreshCandidatesSql('nope'), /limit 50$/);
});

const HIGH = { threshold: 50, highPaths: ['/pricing', '/estimate', '/financing'] };

test('refresh note: never for a backfill (no previous row)', () => {
  assert.equal(refreshNoteReason({ has_summary: false }, { score: 100, page_counts: { '/estimate': 3 } }, HIGH), null);
  assert.equal(refreshNoteReason(null, { score: 100 }, HIGH), null);
});

test('refresh note: crossing the high-intent line is noted', () => {
  assert.equal(refreshNoteReason({ has_summary: true, prev_score: 40, prev_page_counts: { '/': 2 } },
    { score: 55, page_counts: { '/': 3 } }, HIGH), 'crossed_high_intent');
});

test('refresh note: a first visit to a high-intent page is noted', () => {
  assert.equal(refreshNoteReason({ has_summary: true, prev_score: 100, prev_page_counts: { '/': 9 } },
    { score: 100, page_counts: { '/': 9, '/financing/': 1 } }, HIGH), 'new_high_intent_page');
});

test('refresh note: a 20-point jump is noted; a quiet extra page view is not', () => {
  const prev = { has_summary: true, prev_score: 60, prev_page_counts: { '/': 2, '/estimate': 1 } };
  assert.equal(refreshNoteReason(prev, { score: 80, page_counts: { '/': 9, '/estimate': 1 } }, HIGH), 'score_jump');
  assert.equal(refreshNoteReason(prev, { score: 66, page_counts: { '/': 4, '/estimate': 2 } }, HIGH), null);
});

test('retention SQL: anonymous only, never identify rows, batched, refuses < 30 days', () => {
  const { count, delete: del } = buildRetentionDeleteSql(180, 5000);
  for (const sql of [count, del]) {
    assert.match(sql, /e\.event_type <> 'identify'/);
    assert.match(sql, /interval '180 days'/);
    assert.match(sql, /not exists \(select 1 from public\.visitor_identity_map m where m\.visitor_id = e\.visitor_id\)/);
    assert.match(sql, /limit 5000/);
  }
  assert.match(del, /^delete from public\.site_events where id in \(/);
  assert.throws(() => buildRetentionDeleteSql(7, 5000), /minimum 30/);
  assert.throws(() => buildRetentionDeleteSql('x', 5000), /minimum 30/);
});

test('retentionDays: 180 by default, 0 (off) for 0/garbage, else the number', () => {
  assert.equal(retentionDays({}), 180);
  assert.equal(retentionDays({ SITE_EVENTS_RETENTION_DAYS: '' }), 180);
  assert.equal(retentionDays({ SITE_EVENTS_RETENTION_DAYS: '0' }), 0);
  assert.equal(retentionDays({ SITE_EVENTS_RETENTION_DAYS: 'off' }), 0);
  assert.equal(retentionDays({ SITE_EVENTS_RETENTION_DAYS: '365' }), 365);
});

test('retention run: deletes batch by batch until nothing is left, and reports the total', async () => {
  const pending = [5000, 5000, 1234];
  const calls = [];
  const deps = { runSQL: async (sql) => {
    calls.push(sql.startsWith('delete') ? 'delete' : 'count');
    if (sql.startsWith('select')) return [{ n: pending[0] ?? 0 }];
    pending.shift(); return { status: 'ok' };
  } };
  const out = await runSiteEventsRetention({ days: 180, deps });
  assert.deepEqual(out, { ok: true, days: 180, deleted: 11234, batches: 3, more_remaining: false });
  assert.deepEqual(calls, ['count', 'delete', 'count', 'delete', 'count', 'delete']);
});

test('retention run: nothing old enough means no delete at all; disabled does nothing', async () => {
  const calls = [];
  const deps = { runSQL: async (sql) => { calls.push(sql.slice(0, 6)); return [{ n: 0 }]; } };
  assert.equal((await runSiteEventsRetention({ days: 180, deps })).deleted, 0);
  assert.deepEqual(calls, ['select']);
  const off = await runSiteEventsRetention({ days: 0, deps });
  assert.equal(off.skipped, true);
  assert.equal(calls.length, 1);
});

// ─── 2026-10-01 regression: the refresh rebuilt all 19 leads every batch ────
// last_visit went through a JS Date (milliseconds) while site_events keeps
// microseconds, so "a page view newer than last_visit" matched every lead.

test('summary upsert keeps microseconds on an ISO timestamp from Postgres', () => {
  const sql = buildSummaryUpsertSql({ contactId: 'C', score: 1, topPages: [], agg: {
    first_visit: '2026-09-15T21:38:44.237123+00:00', last_visit: '2026-10-01T14:59:18.650182+00:00' } });
  assert.match(sql, /'2026-09-15T21:38:44\.237123\+00:00'::timestamptz/);
  assert.match(sql, /'2026-10-01T14:59:18\.650182\+00:00'::timestamptz/);
  assert.doesNotMatch(sql, /14:59:18\.650Z/);
});

test('summary upsert: a Postgres-style space-separated timestamp also passes through', () => {
  const sql = buildSummaryUpsertSql({ contactId: 'C', score: 1, topPages: [], agg: { last_visit: '2026-10-01 14:59:18.650182+00' } });
  assert.match(sql, /'2026-10-01 14:59:18\.650182\+00'::timestamptz/);
});

test('refresh candidates compare page views truncated to milliseconds', () => {
  const sql = buildRefreshCandidatesSql(50);
  assert.match(sql, /date_trunc\('milliseconds', e\.created_at\) > coalesce\(s\.last_visit, '-infinity'::timestamptz\)/);
  assert.match(sql, /s\.pages_viewed as prev_pages, s\.last_visit as prev_last_visit/);
});

test('refreshChanged: identical totals are no change; any moved total, or a backfill, is', () => {
  const prev = { has_summary: true, prev_pages: 64, prev_score: 100, prev_last_visit: '2026-10-01T14:59:18.650+00:00' };
  assert.equal(refreshChanged(prev, { pageviews: '64', score: 100, last_visit: '2026-10-01T14:59:18.650182+00:00' }), false);
  assert.equal(refreshChanged(prev, { pageviews: 66, score: 100, last_visit: '2026-10-01T15:10:00+00:00' }), true);
  assert.equal(refreshChanged(prev, { pageviews: 64, score: 90, last_visit: '2026-10-01T14:59:18.650+00:00' }), true);
  assert.equal(refreshChanged({ has_summary: false }, { pageviews: 1, score: 3 }), true);
  assert.equal(refreshChanged(null, { pageviews: 1 }), true);
});
