/**
 * Unit tests for the map-driven entry resolver — src/entry-source-map.js
 *
 * Uses Node's built-in test runner (`node:test`). Run with:
 *   node --test scripts/test-entry-source-map.js
 *
 * No DB: the lp_source_mapping snapshot is seeded into the in-process cache
 * via the __setCacheForTest seam, so resolveEntryFromSourceMap reads memory
 * and never touches Supabase. Fixture values match the handoff's §9 cases.
 */

// Harmless Supabase dummies so the module import doesn't warn (the seeded
// cache means no query is ever issued).
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveEntryFromSourceMap,
  entryTagSuffix,
  __setCacheForTest,
} from '../src/entry-source-map.js';

const CF_LP_SUBSOURCE = 'o8h88WeFST8euBUq3Av6';
const CF_LP_SOURCE = 'IvSDubMH0FmZmlCDy5C2';

// Representative snapshot of lp_source_mapping (subset).
const ROWS = [
  { lp_source_subdetail: 'Lead Gurus',     lp_source_raw: null, ghl_intent_bucket: 'paid-internet',       ghl_entry_tag: 'entry:high-intent-digital', ghl_bridge_wf_id: 'W0.7' },
  { lp_source_subdetail: 'Google Organic', lp_source_raw: null, ghl_intent_bucket: 'high-intent-digital', ghl_entry_tag: 'entry:high-intent-digital', ghl_bridge_wf_id: null },
  { lp_source_subdetail: 'TheHomeMag',     lp_source_raw: null, ghl_intent_bucket: 'media',               ghl_entry_tag: 'entry:media',               ghl_bridge_wf_id: null },
  { lp_source_subdetail: 'Canvass',        lp_source_raw: null, ghl_intent_bucket: 'canvassing',          ghl_entry_tag: 'entry:canvassing',          ghl_bridge_wf_id: null },
  { lp_source_subdetail: null,             lp_source_raw: 'Internet', ghl_intent_bucket: 'other',         ghl_entry_tag: 'entry:other',               ghl_bridge_wf_id: null },
];

function withSubsource(value) {
  return { customFields: [{ id: CF_LP_SUBSOURCE, value }] };
}

test.beforeEach(() => __setCacheForTest(ROWS));

test('Lead Gurus → paid-internet / entry:high-intent-digital (subdetail match)', async () => {
  const r = await resolveEntryFromSourceMap(withSubsource('Lead Gurus'));
  assert.equal(r.bucket, 'paid-internet');
  assert.equal(r.entryTag, 'entry:high-intent-digital');
  assert.equal(r.matchedOn, 'subdetail');
});

test('Google Organic → high-intent-digital', async () => {
  const r = await resolveEntryFromSourceMap(withSubsource('Google Organic'));
  assert.equal(r.bucket, 'high-intent-digital');
  assert.equal(entryTagSuffix(r.entryTag), 'high-intent-digital');
});

test('TheHomeMag → media', async () => {
  const r = await resolveEntryFromSourceMap(withSubsource('TheHomeMag'));
  assert.equal(r.bucket, 'media');
  assert.equal(entryTagSuffix(r.entryTag), 'media');
});

test('Canvass → canvassing', async () => {
  const r = await resolveEntryFromSourceMap(withSubsource('Canvass'));
  assert.equal(r.bucket, 'canvassing');
  assert.equal(entryTagSuffix(r.entryTag), 'canvassing');
});

test('zzz-unknown → null (falls through to existing default)', async () => {
  const r = await resolveEntryFromSourceMap(withSubsource('zzz-unknown'));
  assert.equal(r, null);
});

test('raw fallback: LP Source "Internet" with no subdetail → raw match', async () => {
  const r = await resolveEntryFromSourceMap({ customFields: [{ id: CF_LP_SOURCE, value: 'Internet' }] });
  assert.equal(r.matchedOn, 'raw');
  assert.equal(r.bucket, 'other');
});

test('contact.source is used as the raw fallback when custom fields are absent', async () => {
  const r = await resolveEntryFromSourceMap({ customFields: [], source: 'Internet' });
  assert.equal(r.matchedOn, 'raw');
  assert.equal(r.entryTag, 'entry:other');
});

test('subdetail wins over raw when both are present', async () => {
  const contact = {
    customFields: [
      { id: CF_LP_SUBSOURCE, value: 'Lead Gurus' },
      { id: CF_LP_SOURCE, value: 'Internet' },
    ],
  };
  const r = await resolveEntryFromSourceMap(contact);
  assert.equal(r.matchedOn, 'subdetail');
  assert.equal(r.bucket, 'paid-internet');
});

test('no source signal at all → null', async () => {
  const r = await resolveEntryFromSourceMap({ customFields: [] });
  assert.equal(r, null);
});

test('entryTagSuffix strips the entry: prefix and passes through bare suffixes', () => {
  assert.equal(entryTagSuffix('entry:high-intent-digital'), 'high-intent-digital');
  assert.equal(entryTagSuffix('media'), 'media');
  assert.equal(entryTagSuffix(null), null);
});
