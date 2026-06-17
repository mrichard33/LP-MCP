/**
 * Entry Source Map — src/entry-source-map.js
 *
 * Map-driven entry routing (routing fix, Step 2). Resolves a GHL contact's
 * granular LP source to its mapped intent bucket + entry tag using the
 * `lp_source_mapping` table (populated + verified out-of-band; this module
 * only READS it — never writes/recreates data).
 *
 * Resolution mirrors src/normalization.js (the LP-lead sync path): the LP
 * Subsource custom field wins; on a miss we fall back to the LP Source
 * (parent channel) custom field, then to contact.source.
 *
 * The table is small, so the whole thing is cached in-process (5 min TTL) and
 * every lookup runs against the in-memory snapshot — no per-contact query.
 *
 * Side-effect free: callers gate invocation behind the ENTRY_RESOLVER_MAP_DRIVEN
 * feature flag (entry-event-handler.js Priority 0, behavioral-emitter.js
 * Insertion Point B).
 */

import supabase from './supabase.js';

// GHL custom field IDs for the LP source split. Canonical registry:
// src/ghl-field-decoder.js / src/actions/enrichment.js.
const CF_LP_SUBSOURCE = 'o8h88WeFST8euBUq3Av6'; // LP Subsource (specific origin, e.g. "Lead Gurus")
const CF_LP_SOURCE    = 'IvSDubMH0FmZmlCDy5C2'; // LP Source (parent channel, e.g. "Internet")

const SOURCE_MAP_TTL_MS = parseInt(process.env.ENTRY_SOURCE_MAP_TTL_MS || '300000', 10); // 5 min

let _cache = null;   // Array<row> snapshot of lp_source_mapping
let _cacheAt = 0;

/** Read a custom field value off a GHL contact snapshot. Mirrors enrichment.readCF. */
function readCF(contact, fieldId) {
  const arr = contact?.customFields || [];
  const f = arr.find((x) => x.id === fieldId);
  if (!f) return null;
  const raw = f.value;
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Load (and cache) the whole lp_source_mapping table. On error, serve the last
 * good snapshot if we have one, else an empty array (callers treat as no-match).
 */
async function loadSourceMap() {
  const now = Date.now();
  if (_cache && now - _cacheAt < SOURCE_MAP_TTL_MS) return _cache;
  if (!supabase) return _cache || [];
  const { data, error } = await supabase
    .from('lp_source_mapping')
    .select('lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, ghl_bridge_wf_id');
  if (error) {
    console.error(`[EntrySourceMap] load failed: ${error.message}`);
    return _cache || [];
  }
  _cache = Array.isArray(data) ? data : [];
  _cacheAt = now;
  return _cache;
}

/** Force the next lookup to re-read the table (e.g. after a source sync). */
export function reloadSourceMap() {
  _cache = null;
  _cacheAt = 0;
}

/** TEST SEAM — seed the in-memory cache so unit tests run without a DB. */
export function __setCacheForTest(rows) {
  _cache = Array.isArray(rows) ? rows : [];
  _cacheAt = Date.now();
}

/**
 * Resolve { subdetail, raw } against the cached rows. Subdetail wins; on a
 * subdetail miss, fall back to a raw match on a row that has no subdetail.
 * Returns { row, matchedOn } or null.
 */
function lookup(rows, subdetail, raw) {
  if (subdetail) {
    const row = rows.find((r) => r.lp_source_subdetail === subdetail);
    if (row) return { row, matchedOn: 'subdetail' };
  }
  if (raw) {
    const row = rows.find((r) => !r.lp_source_subdetail && r.lp_source_raw === raw);
    if (row) return { row, matchedOn: 'raw' };
  }
  return null;
}

/**
 * Resolve a GHL contact's granular LP source to its mapped entry routing.
 * Returns { bucket, entryTag, bridgeWfId, matchedOn:'subdetail'|'raw' } or
 * null when nothing maps (caller falls through to existing behavior).
 */
export async function resolveEntryFromSourceMap(contact) {
  const subdetail = readCF(contact, CF_LP_SUBSOURCE);
  const raw =
    readCF(contact, CF_LP_SOURCE) ||
    (contact?.source ? String(contact.source).trim() : null);
  if (!subdetail && !raw) return null;

  const rows = await loadSourceMap();
  if (!rows || rows.length === 0) return null;

  const hit = lookup(rows, subdetail, raw);
  if (!hit || !hit.row.ghl_entry_tag) return null;

  return {
    bucket: hit.row.ghl_intent_bucket || null,
    entryTag: hit.row.ghl_entry_tag || null,
    bridgeWfId: hit.row.ghl_bridge_wf_id || null,
    matchedOn: hit.matchedOn,
  };
}

/** Strip a leading "entry:" from a mapped entry tag → the bare suffix. */
export function entryTagSuffix(entryTag) {
  if (!entryTag) return null;
  return entryTag.startsWith('entry:') ? entryTag.slice('entry:'.length) : entryTag;
}

export const _internal = { readCF, lookup, loadSourceMap };
