/**
 * Contact time zone from zip — src/services/contact-timezone.js
 *
 * zip → service_area_zips.market_code → src/config/market-timezones.js.
 * Fail-soft: no zip, an unknown zip, or a lookup that fails all resolve to
 * Eastern, which is what every contact got before Houston existed.
 *
 * Cached in-process for an hour (the same horizon as market-phone.js), so a
 * reply costs at most one indexed read per zip per hour. A failed lookup is
 * NOT cached: it means "could not tell", and the next reply should ask again.
 */

import { checkServiceAreaZip, normalizeZip5 } from './identity-extraction.js';
import { DEFAULT_TIMEZONE, marketTimezone, tzLabel } from '../config/market-timezones.js';

const TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // zip → { market_code, at }

/** The answer for "no market known". */
export function defaultMarketZone() {
  return { timezone: DEFAULT_TIMEZONE, label: tzLabel(DEFAULT_TIMEZONE), market_code: null };
}

/** Pure. A service-area lookup result → { timezone, label, market_code }. */
export function zoneForServiceArea(result) {
  if (!result?.in_service_area || !result.market_code) return defaultMarketZone();
  const timezone = marketTimezone(result.market_code);
  return { timezone, label: tzLabel(timezone), market_code: result.market_code };
}

/**
 * @param {string|null} zip
 * @param {{ lookup?: Function, nowMs?: number }} [deps]
 * @returns {Promise<{ timezone: string, label: string, market_code: string|null }>}
 */
export async function timezoneForZip(zip, { lookup = checkServiceAreaZip, nowMs = Date.now() } = {}) {
  const z = normalizeZip5(zip);
  if (!z) return defaultMarketZone();
  const hit = cache.get(z);
  if (hit && nowMs - hit.at < TTL_MS) return zoneForServiceArea({ in_service_area: !!hit.market_code, market_code: hit.market_code });
  try {
    const res = await lookup(z);
    if (!res?.checked) return defaultMarketZone();
    cache.set(z, { market_code: res.in_service_area ? res.market_code : null, at: nowMs });
    return zoneForServiceArea(res);
  } catch {
    return defaultMarketZone();
  }
}

export function __resetContactTimezoneCacheForTest() { cache.clear(); }
