/**
 * GHL location custom values — src/services/ghl-custom-values.js
 *
 * 2026-10-01 (Mark): F.0's texts are signed {{custom_values.rehash_rep_name}}
 * and a post-demo lead's reply must come from that same person. A merge tag
 * can never ship in an agentic body (assertNoUnresolvedTokens in
 * response-generator.js — the 2026-07-29 {{custom_values.rep_name}} leak), so
 * the value is read here and written into the prompt as a literal.
 *
 * Before this, the only custom-value read in the repo was the inline
 * lp_active_token lookup in src/n8n-helpers.js.
 *
 * Cached in-process for an hour (the src/services/market-phone.js pattern): a
 * custom value changes when a person edits it in GHL, not per message. A
 * failed read is NOT cached, so "could not tell" is asked again next time, and
 * it resolves to null — the caller falls back to the team identity rather than
 * guessing a name.
 */

import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';

export const CACHE_TTL_MS = 60 * 60 * 1000;
let _cache = { rows: null, at: 0 };

/** "{{ custom_values.rehash_rep_name }}" / "Rehash Rep Name" → "rehash_rep_name". Pure. */
export function customValueKey(raw) {
  const s = String(raw || '').replace(/[{}]/g, '').trim().replace(/^custom_values\./i, '');
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Find one value by key in GHL's customValues list. Pure. */
export function pickCustomValue(rows, key) {
  const want = customValueKey(key);
  const row = (Array.isArray(rows) ? rows : []).find((r) => customValueKey(r?.fieldKey) === want || customValueKey(r?.name) === want);
  const value = row?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The value of one location custom value, or null (missing, blank, or the
 * read failed). Never throws.
 */
export async function getCustomValue(key, { deps = {}, nowMs = Date.now() } = {}) {
  const fetchImpl = deps.ghlFetch || ghlFetch;
  const locationId = deps.locationId || GHL_LOCATION_ID;
  try {
    if (!_cache.rows || nowMs - _cache.at >= CACHE_TTL_MS) {
      const res = await fetchImpl('GET', `/locations/${locationId}/customValues`, null, { priority: 'high', maxWaitMs: 1500 });
      const rows = res?.customValues;
      if (!Array.isArray(rows)) throw new Error('customValues: no list in response');
      _cache = { rows, at: nowMs };
    }
    return pickCustomValue(_cache.rows, key);
  } catch (err) {
    console.warn(`[CustomValues] read failed for ${key}: ${err.message}`);
    return null;
  }
}

export function __resetCustomValuesCacheForTest() {
  _cache = { rows: null, at: 0 };
}
