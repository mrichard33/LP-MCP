#!/usr/bin/env node
/**
 * Unit tests — market CODE / NAME resolution (src/actions/enrichment.js).
 *
 * THE INCIDENT (2026-09-21). A sales card printed
 *   🌍 Market: LAKE, FTMYR
 * and landed in #sales-all instead of a market channel.
 *
 * "LAKE, FTMYR" is not a market. n8n-enrichment.js joined every branch a
 * prospect had ever been worked by into a field that is single-valued by
 * contract, and both resolvers here passed it straight through — so
 * slack_market_slugs matched nothing and the card fell back to the rollup.
 * 135 of 15,949 contacts span two branches and every one of them did this.
 *
 * The writer is fixed, but the 135 stored values are still joined in GHL. What
 * makes those route correctly TODAY is the validation below: a value that is
 * not a known market code is discarded, which lets the zip lookup — correct all
 * along — produce the real market. These tests are that guarantee.
 *
 * No network, no database: the supabase singleton is stubbed via the seam.
 *
 *   node --test scripts/test-market-code-resolution.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import {
  normalizeMarketCode,
  toKnownMarketCode,
  resolveMarket,
  resolveMarketCode,
  __setEnrichmentClientForTests,
  __resetMarketCacheForTests,
} from '../src/actions/enrichment.js';

const CF_MARKET_CODE = 'z0MV6mXi0w9WwdCOFThh';

// Real rows, copied from the live tables.
const MARKETS = [
  { market_code: 'FTMYR', market_name: 'Ft. Myers / SW Florida' },
  { market_code: 'LAKE', market_name: 'Lakeland' },
  { market_code: 'FTLAU', market_name: 'Ft. Lauderdale' },
  { market_code: 'BOCA', market_name: 'Boca Raton / Palm Beach' },
];
// Naples 34116 is the zip on the lead that produced the incident card.
const ZIPS = { '34116': 'FTMYR', '33801': 'LAKE' };

let zipLookups = 0;
const stubDb = {
  from(table) {
    if (table === 'service_markets') {
      return { select: async () => ({ data: MARKETS }) };
    }
    if (table === 'service_area_zips') {
      return {
        select: () => ({
          eq: (_col, zip) => ({
            maybeSingle: async () => {
              zipLookups++;
              const code = ZIPS[zip];
              return { data: code ? { market_code: code } : null };
            },
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  },
};

function reset() {
  zipLookups = 0;
  __setEnrichmentClientForTests(stubDb);
  __resetMarketCacheForTests();
}

/** A GHL contact whose market custom field holds `value`. */
function contactWithCF(value, extra = {}) {
  return { customFields: [{ id: CF_MARKET_CODE, value }], ...extra };
}

// ─── normalizeMarketCode (pure) ──────────────────────────────────

test('a known code is accepted and upper-cased', () => {
  const m = new Map(MARKETS.map((r) => [r.market_code, r.market_name]));
  assert.equal(normalizeMarketCode('FTMYR', m), 'FTMYR');
  assert.equal(normalizeMarketCode('ftmyr', m), 'FTMYR');
  assert.equal(normalizeMarketCode('  FTMYR  ', m), 'FTMYR');
});

test('the joined value from the incident is NOT a code', () => {
  const m = new Map(MARKETS.map((r) => [r.market_code, r.market_name]));
  assert.equal(normalizeMarketCode('LAKE, FTMYR', m), null);
  assert.equal(normalizeMarketCode('FTMYR, LAKE', m), null);
  assert.equal(normalizeMarketCode('LAKE,FTMYR', m), null);
});

test('unknown, empty and absent values are all null', () => {
  const m = new Map(MARKETS.map((r) => [r.market_code, r.market_name]));
  for (const v of ['NOPE', '', '   ', null, undefined]) {
    assert.equal(normalizeMarketCode(v, m), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test('an empty market map rejects everything rather than throwing', () => {
  // getMarketMap returns an empty Map on a cold-start read failure. Rejecting
  // is the safe direction: resolution degrades to the zip, and the card still
  // reaches the rollup. It must never throw on the notification path.
  assert.equal(normalizeMarketCode('FTMYR', new Map()), null);
  assert.equal(normalizeMarketCode('FTMYR', undefined), null);
});

// ─── resolveMarketCode — routing ─────────────────────────────────

test('REGRESSION: a joined custom field falls through to the zip', async () => {
  reset();
  const code = await resolveMarketCode({
    ghlContact: contactWithCF('LAKE, FTMYR', { postalCode: '34116' }),
  });
  assert.equal(code, 'FTMYR', 'must resolve the real market, not the joined string');
  assert.equal(zipLookups, 1, 'the zip lookup has to actually run');
});

test("this lead's branch beats the contact-level field", async () => {
  reset();
  // Exactly the incident contact: the card is about the FTMYR lead, while the
  // contact field is polluted by a stale 2025 Lakeland lead.
  const code = await resolveMarketCode({
    ghlContact: contactWithCF('LAKE, FTMYR', { postalCode: '34116' }),
    lpLead: { lp_branch_id: 'FTMYR', zip: '34116' },
  });
  assert.equal(code, 'FTMYR');
  assert.equal(zipLookups, 0, 'the lead answered it — no lookup needed');
});

test('a valid custom field is still used, and costs no zip lookup', async () => {
  reset();
  const code = await resolveMarketCode({ ghlContact: contactWithCF('LAKE', { postalCode: '34116' }) });
  assert.equal(code, 'LAKE');
  assert.equal(zipLookups, 0);
});

test('an unknown code falls through instead of routing on it', async () => {
  reset();
  const code = await resolveMarketCode({ ghlContact: contactWithCF('WAT', { postalCode: '33801' }) });
  assert.equal(code, 'LAKE');
});

test('a junk lead branch does not block the other sources', async () => {
  reset();
  const code = await resolveMarketCode({
    lpLead: { lp_branch_id: 'LAKE, FTMYR', zip: '34116' },
  });
  assert.equal(code, 'FTMYR');
});

test('nothing resolvable → null, never a guess', async () => {
  reset();
  assert.equal(await resolveMarketCode({}), null);
  assert.equal(await resolveMarketCode({ ghlContact: contactWithCF('WAT') }), null);
  assert.equal(await resolveMarketCode({ ghlContact: { postalCode: '00000' } }), null);
});

// ─── resolveMarket — what the card prints ────────────────────────

test('REGRESSION: the card prints a market NAME, never the joined string', async () => {
  reset();
  const name = await resolveMarket({
    ghlContact: contactWithCF('LAKE, FTMYR', { postalCode: '34116' }),
  });
  assert.equal(name, 'Ft. Myers / SW Florida');
  assert.notEqual(name, 'LAKE, FTMYR');
});

test('a valid code prints its display name, not the code', async () => {
  reset();
  assert.equal(await resolveMarket({ ghlContact: contactWithCF('LAKE') }), 'Lakeland');
});

test("the lead's branch drives the printed name too", async () => {
  reset();
  const name = await resolveMarket({
    ghlContact: contactWithCF('LAKE'),
    lpLead: { lp_branch_id: 'FTMYR' },
  });
  assert.equal(name, 'Ft. Myers / SW Florida');
});

test('city remains the last-resort label when no market resolves', async () => {
  reset();
  const name = await resolveMarket({ ghlContact: { postalCode: '00000', city: 'Naples' } });
  assert.equal(name, 'Naples');
});

// ─── toKnownMarketCode — the canvassing intake's entry point ─────

test('toKnownMarketCode loads the map itself and rejects the joined value', async () => {
  reset();
  assert.equal(await toKnownMarketCode('FTMYR'), 'FTMYR');
  assert.equal(await toKnownMarketCode('LAKE, FTMYR'), null);
  assert.equal(await toKnownMarketCode(''), null);
  assert.equal(await toKnownMarketCode(null), null);
});
