/**
 * registry.js — read the health_checks registry from the LP database.
 *
 * WHY (2026-10-15). The registry is DATABASE config, like agent_rules: Mark
 * seeded 73 checks with their thresholds, cadence and mode, and a threshold or
 * a shadow→live flip is a row update, not a deploy. So code only READS it:
 * nothing here upserts at boot (that would overwrite a tuned threshold with the
 * value in the code). scripts/export-health-checks.js copies the table into
 * src/health/registry.snapshot.json for review diffs.
 *
 * Cached for 60s. A failed read keeps serving the last good copy and says so
 * (`stale: true`); with no copy at all it returns an empty Map and `ok:false`,
 * and the recorder treats an unknown check id as a reason to log, not to throw.
 */

import supabase from '../supabase.js';

export const REGISTRY_TTL_MS = 60_000;

let cache = { at: 0, map: null };

function db(client) {
  return client !== undefined ? client : supabase;
}

/**
 * @returns {Promise<Map<string, object>>} check_id → health_checks row.
 * Never throws. `loadHealthChecks.lastError` holds the most recent read error.
 */
export async function loadHealthChecks({ client, nowMs = Date.now(), refresh = false } = {}) {
  if (!refresh && cache.map && nowMs - cache.at < REGISTRY_TTL_MS) return cache.map;
  const c = db(client);
  if (!c) {
    loadHealthChecks.lastError = 'no supabase client';
    return cache.map || new Map();
  }
  try {
    const { data, error } = await c.from('health_checks').select('*');
    if (error) throw error;
    const map = new Map();
    for (const row of data || []) map.set(row.check_id, row);
    cache = { at: nowMs, map };
    loadHealthChecks.lastError = null;
    return map;
  } catch (err) {
    loadHealthChecks.lastError = err.message || String(err);
    console.error(`[Health] registry read failed: ${loadHealthChecks.lastError}`);
    return cache.map || new Map();
  }
}
loadHealthChecks.lastError = null;

/** One check row, or null. */
export async function getHealthCheck(checkId, opts = {}) {
  const map = await loadHealthChecks(opts);
  return map.get(checkId) || null;
}

/** Test seam: forget the cache. */
export function resetRegistryCache() {
  cache = { at: 0, map: null };
}

/** Test seam: preload the cache from rows (e.g. the committed snapshot). */
export function primeRegistry(rows, nowMs = Date.now()) {
  const map = new Map();
  for (const row of rows || []) map.set(row.check_id, row);
  cache = { at: nowMs, map };
  return map;
}
