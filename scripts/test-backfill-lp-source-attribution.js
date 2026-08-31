/**
 * LP source attribution — scripts/test-backfill-lp-source-attribution.js
 *
 * Covers the three pure pieces of the source-attribution change:
 *   1. combinedSourceLabel   (src/format-helpers.js)       — the data label
 *   2. opportunitySourceFor  (src/lp-source-attribution.js) — the agreement rule
 *   3. contactSourceRepair   (the backfill)                 — the write decision
 *
 * Pure-function test — no DB, no network, no GHL I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { combinedSourceLabel, formatLpSource } from '../src/format-helpers.js';
import {
  opportunitySourceFor, opportunitySourceField, sameSource, BACKSTOP_SENTINEL,
} from '../src/lp-source-attribution.js';
import { contactSourceRepair } from './backfill-lp-source-attribution.js';

const CF_LP_SOURCE    = 'IvSDubMH0FmZmlCDy5C2';
const CF_LP_SUBSOURCE = 'o8h88WeFST8euBUq3Av6';

/** A GHL contact snapshot as ghlFetch('GET', /contacts/:id) returns it. */
const contact = (source, lpSource, lpSub) => ({
  source,
  customFields: [
    ...(lpSource !== undefined ? [{ id: CF_LP_SOURCE, value: lpSource }] : []),
    ...(lpSub !== undefined ? [{ id: CF_LP_SUBSOURCE, value: lpSub }] : []),
  ],
});

// ═══ 1. combinedSourceLabel ═══════════════════════════════════════════

test('the vendor is appended to the channel, comma-separated', () => {
  assert.equal(combinedSourceLabel('Internet', 'Modernize'), 'Internet, Modernize');
  assert.equal(combinedSourceLabel('Iheart', 'Simpletext'), 'Iheart, Simpletext');
});

test('a detail that merely restates its parent is not doubled', () => {
  // LP carries thousands of these (Canvass/Canvass, Canvass Sticky/Canvass
  // Sticky). "Canvass, Canvass" is a value no reader could interpret.
  assert.equal(combinedSourceLabel('Canvass', 'Canvass'), 'Canvass');
  assert.equal(combinedSourceLabel('Canvass Sticky', 'Canvass Sticky'), 'Canvass Sticky');
});

test('the restates-parent check is trimmed and case-insensitive', () => {
  assert.equal(combinedSourceLabel('Canvass', ' canvass '), 'Canvass');
  assert.equal(combinedSourceLabel('CANVASS', 'Canvass'), 'CANVASS');
});

test('absent halves behave exactly as formatLpSource treats them', () => {
  for (const [s, d] of [['Internet', null], ['Internet', '  '], ['Internet', undefined],
                        [null, 'Modernize'], ['', 'Modernize']]) {
    assert.equal(!!combinedSourceLabel(s, d), !!formatLpSource(s, d), `${s} / ${d}`);
  }
  assert.equal(combinedSourceLabel('Internet', null), 'Internet');
  assert.equal(combinedSourceLabel('Internet', '   '), 'Internet');
  assert.equal(combinedSourceLabel(null, 'Modernize'), 'Modernize');
  assert.equal(combinedSourceLabel(null, null), null);
  assert.equal(combinedSourceLabel('', '  '), null);
});

test('punctuation is preserved — distinct vendors must not collapse', () => {
  // The tag axis slugifies (source:internet-modernize); this axis must not,
  // or "Home4Quotes" and "Home 4 Quotes" would become the same bucket.
  assert.equal(combinedSourceLabel('Internet', 'Home4Quotes'), 'Internet, Home4Quotes');
  assert.equal(combinedSourceLabel('Internet', 'Contractor Appointment-West'),
    'Internet, Contractor Appointment-West');
});

// ═══ 2. The agreement rule ════════════════════════════════════════════

test('sameSource compares trimmed and case-insensitively; absent never matches', () => {
  assert.ok(sameSource('Internet', ' internet '));
  assert.ok(!sameSource('Canvassing', 'Canvass'));
  assert.ok(!sameSource(null, null));
  assert.ok(!sameSource('', ''));
  assert.ok(!sameSource('Internet', null));
});

test('the vendor is appended when contact and LP already agree on the channel', () => {
  assert.equal(opportunitySourceFor(contact('Internet', 'Internet', 'Modernize')), 'Internet, Modernize');
  assert.equal(opportunitySourceFor(contact('Magazine', 'Magazine', 'TheHomeMag')), 'Magazine, TheHomeMag');
});

test('a contact whose vocabulary differs from LP keeps its own source untouched', () => {
  // The whole safety property. 6,666 contacts sit here — GHL-native names LP
  // spells differently. Rewriting them would overwrite a good value with a
  // clumsier one and add no information.
  assert.equal(opportunitySourceFor(contact('Canvassing', 'Canvass', 'Canvass')), 'Canvassing');
  assert.equal(opportunitySourceFor(contact('Window Estimator', 'Main Website', 'Website Estimate Calculator')),
    'Window Estimator');
  assert.equal(opportunitySourceFor(contact('Previous Customer', 'PrevCust', 'Previous Customer')),
    'Previous Customer');
  assert.equal(opportunitySourceFor(contact('Landing Page', 'Website', 'Google')), 'Landing Page');
});

test('a contact with no LP custom fields keeps its source — the pre-change behaviour', () => {
  assert.equal(opportunitySourceFor(contact('Chatbot')), 'Chatbot');
  assert.equal(opportunitySourceFor({ source: 'Chatbot' }), 'Chatbot');
});

test('a contact with no source at all yields no source key, never an invented one', () => {
  assert.equal(opportunitySourceFor(contact(null, 'Internet', 'Modernize')), null);
  assert.equal(opportunitySourceFor(contact('   ', 'Internet', 'Modernize')), null);
  assert.deepEqual(opportunitySourceField(contact(null, 'Internet', 'Modernize')), {});
  assert.deepEqual(opportunitySourceField(contact('Internet', 'Internet', 'Modernize')),
    { source: 'Internet, Modernize' });
});

test('agreement with no sub-source leaves the channel alone', () => {
  assert.equal(opportunitySourceFor(contact('Internet', 'Internet', '')), 'Internet');
  assert.equal(opportunitySourceFor(contact('Internet', 'Internet')), 'Internet');
});

test('the backstop sentinel is never propagated onto a NEW opportunity', () => {
  // A contact the backfill has not reached yet still says 'lp-backstop'. Minting
  // an opportunity that repeats it would spread the exact string this change
  // exists to remove — and 'lp-backstop, Modernize' would be a variant the
  // backfill's exact-literal gate could never see or repair. Send nothing.
  assert.equal(opportunitySourceFor(contact(BACKSTOP_SENTINEL, 'Internet', 'Modernize')), null);
  assert.equal(opportunitySourceFor(contact(BACKSTOP_SENTINEL)), null);
  assert.deepEqual(opportunitySourceField(contact(BACKSTOP_SENTINEL, 'Internet', 'Modernize')), {});

  const minted = opportunitySourceField(contact(BACKSTOP_SENTINEL, 'Internet', 'Modernize'));
  assert.ok(!('source' in minted && String(minted.source).includes(BACKSTOP_SENTINEL)));
});

// ═══ 3. contactSourceRepair ═══════════════════════════════════════════

test('a source that is not the exact literal lp-backstop is NEVER touched', () => {
  // The safety property this whole script rests on. Everything that is not the
  // one known-bad sentinel is somebody else's attribution.
  for (const current of ['Internet', 'Canvassing', '', '   ', 'LP-Backstop', 'lp-backstop ', null, undefined]) {
    const r = contactSourceRepair({ current, lpSource: 'Internet', cfSource: 'Internet' });
    assert.equal(r.write, false, `must refuse ${JSON.stringify(current)}`);
    assert.equal(r.reason, 'not_backstop');
  }
});

test('the literal is replaced with the LP parent channel', () => {
  const r = contactSourceRepair({ current: 'lp-backstop', lpSource: 'Internet', cfSource: 'Internet' });
  assert.deepEqual(r, { write: true, value: 'Internet' });
});

test('LP beats a stale contact custom field', () => {
  // lp_lead_id 571599 and 571604: LP holds the real source while the contact
  // custom field is still empty. Reading the contact first loses them.
  assert.deepEqual(
    contactSourceRepair({ current: 'lp-backstop', lpSource: 'Internet', cfSource: null }),
    { write: true, value: 'Internet' });
  assert.deepEqual(
    contactSourceRepair({ current: 'lp-backstop', lpSource: 'Iheart', cfSource: 'Internet' }),
    { write: true, value: 'Iheart' });
});

test('the custom field is used only when LP has nothing', () => {
  assert.deepEqual(
    contactSourceRepair({ current: 'lp-backstop', lpSource: null, cfSource: 'Affiliates' }),
    { write: true, value: 'Affiliates' });
  assert.deepEqual(
    contactSourceRepair({ current: 'lp-backstop', lpSource: '  ', cfSource: 'Affiliates' }),
    { write: true, value: 'Affiliates' });
});

test('a lead with no source anywhere keeps lp-backstop rather than inventing one', () => {
  // 11 rows. An honest "arrived via the backstop, origin unknown" beats a guess.
  for (const [lpSource, cfSource] of [[null, null], [undefined, undefined], ['', ''], ['  ', '  ']]) {
    const r = contactSourceRepair({ current: 'lp-backstop', lpSource, cfSource });
    assert.equal(r.write, false);
    assert.equal(r.reason, 'no_lp_source');
  }
});

test('a lead whose LP source IS the literal is left alone, not rewritten to itself', () => {
  const r = contactSourceRepair({ current: 'lp-backstop', lpSource: 'lp-backstop', cfSource: null });
  assert.equal(r.write, false);
  assert.equal(r.reason, 'unchanged');
});

test('the written value is trimmed', () => {
  assert.deepEqual(
    contactSourceRepair({ current: 'lp-backstop', lpSource: '  Internet  ', cfSource: null }),
    { write: true, value: 'Internet' });
});
