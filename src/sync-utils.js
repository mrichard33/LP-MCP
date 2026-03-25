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
