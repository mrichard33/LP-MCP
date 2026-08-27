// ─── Sync Utilities — src/sync-utils.js ───────────────────────────
//
// Shared utilities used by all sync modules.
// Extracted from sync-engine.js to enable modular file updates.

export const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
export const PAGE_SIZE = 200;
export const RATE_LIMIT_SLEEP_MS = 150; // LP monitors for excessive use
export const REACTIVATION_CUTOFF = '2024-01-01T00:00:00Z'; // Don't trigger Day 15 for leads before this date

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '') || null;
}

// ─── US state normalization ─────────────────────────────────────
//
// LP's state column TRUNCATES TO TWO CHARACTERS, silently. Verified
// 2026-08-27 against lp_prospects: no stored value exceeds 2 chars, and the
// residue is exactly what truncation produces — 39 rows read "Fl" (from
// "Florida"), 18 read "fl", and 829 read "nu" (from the literal string
// "null"). Canvass is among the sources on all three, most recently
// 2026-08-26. So an un-normalized state is not a cosmetic wart: it lands in
// LP as a wrong value that still looks plausible, and no error is ever raised.
//
// Lives here, beside normalizePhone, because it is the same kind of thing and
// because it had already drifted — the affiliate intake normalized, the
// canvassing intake did not, and only the canvassing form feeds GHL's
// spelled-out "Florida". One definition, both callers.

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
};

// The literal strings a JS/GHL pipeline produces when a field is absent. LP
// truncates each to a 2-char value that passes for a state code — "nu" on 829
// prospects since 2021. Blanked rather than forwarded: an empty state trips
// the required-field gate and cards the operator, which is the outcome that
// gets it fixed.
const STATE_NULLISH = new Set(['null', 'undefined', 'nan', 'none', 'n/a', 'na']);

/**
 * Normalize a US state to its two-letter code.
 *
 * Two-letter passthrough (uppercased); full names mapped; the nullish literals
 * above blanked; anything else returned as-is so the caller's required-field
 * gate still sees a value and the operator card names the real problem rather
 * than a blanked field.
 */
export function normalizeState(raw) {
  const s = (raw === null || raw === undefined ? '' : String(raw)).trim();
  if (!s) return '';
  if (STATE_NULLISH.has(s.toLowerCase())) return '';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const mapped = STATE_NAMES[s.toLowerCase().replace(/[.\s]+/g, ' ').trim()];
  return mapped || s;
}

// ─── Case-insensitive field extraction ──────────────────────────
// LP API returns inconsistent casing (phone1, Phone1, PHONE1, etc.).
// Try exact keys first, then case-insensitive fallback.
export function getField(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  const objKeys = Object.keys(obj);
  for (const k of keys) {
    const lower = k.toLowerCase();
    const match = objKeys.find(ok => ok.toLowerCase() === lower);
    if (match && obj[match] !== undefined && obj[match] !== null && obj[match] !== '') return obj[match];
  }
  return null;
}

// Track whether we've logged the first record's keys for each entity type
export const loggedFirstKeys = new Set();

// ─── Extract array from LP API response ──────────────────────────
// LP may return a direct array, or nested under various keys.
export function extractArray(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  for (const key of ['data', 'leads', 'results', 'Result', 'Records', 'records', 'Customers', 'customers']) {
    if (Array.isArray(response[key])) return response[key];
  }
  // Single object with prospect ID — wrap it
  if (response.cst_id || response.ProspectID || response.prospect_id) {
    return [response];
  }
  return [];
}
