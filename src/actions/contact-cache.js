/**
 * Per-batch contact cache — src/actions/contact-cache.js
 *
 * GHL calls are the hard throughput bottleneck (40/min ceiling). Within a
 * single action batch (one batch_id, executed serially) the same contact is
 * frequently GET /contacts/{id}'d multiple times — e.g. a GHL_APPT_STAGE_ADVANCE
 * batch touches the same contact via set_stage, remove_tag, add_tag and
 * set_lp_appointment, each doing its own read. This helper dedupes those reads
 * to a single GET per contact per batch.
 *
 * SCOPE: the cache is a Map owned by runBatch (src/actions/index.js) and lives
 * exactly as long as one batch. It is NEVER module-global — global sharing under
 * Phase-2 concurrency would create stale-read hazards across concurrent batches.
 * A batch is serial, so within one cache there is no concurrency.
 *
 * CORRECTNESS: any handler that MUTATES a contact's tags must update the cached
 * entry (setCachedContactTags) or a later same-batch action will read stale tags
 * and make a wrong exclusivity / no-op decision.
 *
 * The cached value is the NORMALIZED inner contact object (GHL returns either
 * { contact: {...} } or {...} directly). Callers read c.tags, c.phone,
 * c.last_appointment_start_date, etc. — the same dual-shape fallbacks they used
 * before, now applied to the normalized object.
 */

import { ghlFetch } from './helpers.js';

/**
 * Get a contact, using the batch cache when present. On a miss (or force),
 * performs one GET /contacts/{id}, normalizes the response, caches and returns
 * it. Errors propagate so callers keep their existing best-effort try/catch.
 *
 * @param {string} contactId
 * @param {Map} [cache]  per-batch Map; if absent a throwaway Map is used so the
 *                       handler never breaks on the direct-execute path.
 * @param {object} [opts]
 * @param {boolean} [opts.force]  bypass the cache (re-GET + overwrite)
 * @returns {Promise<object>} normalized contact
 */
export async function getContactCached(contactId, cache, { force = false, maxWaitMs } = {}) {
  cache = cache || new Map();
  if (!force && cache.has(contactId)) {
    return cache.get(contactId);
  }
  // maxWaitMs caps the rate-limiter queue wait for THIS read (see ghlFetch).
  // Omitted → the historical 30s default. A cache hit above never waits at all.
  const res = await ghlFetch('GET', `/contacts/${contactId}`, null, { maxWaitMs });
  const contact = res?.contact || res || {};
  cache.set(contactId, contact);
  return contact;
}

/**
 * Overwrite the cached contact's tag array after a mutation so later same-batch
 * reads see fresh state. Creates a stub entry if the contact wasn't cached.
 */
export function setCachedContactTags(contactId, cache, tags) {
  if (!cache) return;
  const existing = cache.get(contactId) || { id: contactId };
  existing.tags = tags;
  cache.set(contactId, existing);
}

/** Drop a contact from the cache (force a fresh read next time). */
export function invalidateContact(contactId, cache) {
  if (!cache) return;
  cache.delete(contactId);
}
