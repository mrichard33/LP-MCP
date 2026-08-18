/**
 * Market Phone Resolver — src/services/market-phone.js
 *
 * 2026-08-18 (invented-phone incident): the customer-facing dispatch number
 * for a contact lives in service_markets (zip → service_area_zips.market_code
 * → service_markets.service_phone), but the LAYER3_DISPATCH reply path never
 * resolved it — the model was left to fill the gap and invented
 * (954) 282-0505. This module is the one place the agentic reply paths get
 * that number from, so a phone number in a prompt is always a real one.
 *
 * service_markets is tiny (10 rows) and cached in-process for 1h — same
 * pattern as src/actions/enrichment.js. Every failure path falls back to the
 * GENERAL line, mirroring the /service-area REST handler's contract: the
 * resolver never throws and never returns an empty phone.
 */

import supabase from '../supabase.js';

// GENERAL fallback, duplicated from the service_markets seed on purpose so a
// DB outage can never leave a reply without a real number to give out.
export const GENERAL_SERVICE_PHONE = '(954) 800-8906';
export const GENERAL_SERVICE_PHONE_E164 = '+19548008906';

const CACHE_TTL_MS = 60 * 60 * 1000;
let _cache = { rows: null, at: 0 };

async function loadMarkets() {
  if (_cache.rows && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.rows;
  if (!supabase) throw new Error('supabase client unavailable');
  const { data, error } = await supabase
    .from('service_markets')
    .select('market_code, market_name, service_phone, service_phone_e164');
  if (error) throw new Error(`service_markets load failed: ${error.message}`);
  _cache = { rows: data || [], at: Date.now() };
  return _cache.rows;
}

/**
 * Resolve the dispatch phone for a market code (from
 * checkServiceAreaZip().market_code). Unknown/null codes and every error
 * path resolve to the GENERAL line.
 *
 * @returns {Promise<{market_code: string, phone_display: string,
 *                    phone_e164: (string|null), fallback: boolean}>}
 */
export async function resolveServicePhone(marketCode) {
  const code = String(marketCode || '').trim().toUpperCase();
  try {
    const rows = await loadMarkets();
    const row = (code && rows.find((r) => r.market_code === code))
      || rows.find((r) => r.market_code === 'GENERAL');
    if (row?.service_phone) {
      return {
        market_code: row.market_code,
        phone_display: row.service_phone,
        phone_e164: row.service_phone_e164 || null,
        fallback: row.market_code !== code,
      };
    }
  } catch (err) {
    console.warn(`[MarketPhone] resolve failed for "${code || 'GENERAL'}": ${err.message} — using GENERAL fallback`);
  }
  return {
    market_code: 'GENERAL',
    phone_display: GENERAL_SERVICE_PHONE,
    phone_e164: GENERAL_SERVICE_PHONE_E164,
    fallback: true,
  };
}

/** Test hook — drops the in-process cache. */
export function _resetMarketPhoneCache() {
  _cache = { rows: null, at: 0 };
}

export default { resolveServicePhone, _resetMarketPhoneCache, GENERAL_SERVICE_PHONE };
