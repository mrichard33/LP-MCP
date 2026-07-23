/**
 * Tag-snapshot write-through — src/services/tag-snapshot.js
 *
 * Suppression gates (src/services/suppression-check.js) read
 * contact_tag_snapshot, which is kept current by the GHL tag webhook — an
 * async round-trip of seconds to minutes. During that window an
 * executor-applied suppression tag is invisible to the gates (Gary Cina
 * dwTCMm7LN8MSwrkuLSHL kept receiving nurture email after two explicit
 * opt-outs). executeIssueHold proved the synchronous write-through pattern on
 * 2026-06-17 (Peggy Webb) for one hardcoded tag; this generalizes it for every
 * executor tag mutation.
 *
 * The write is ONE atomic Postgres call (apply_tags_to_snapshot, see
 * sql/migrations/2026-07-23_tag_snapshot_apply.sql) that unions `add` and
 * subtracts `remove` against the existing array server-side — no client
 * read-modify-write race (the old inline block in executeIssueHold had one).
 *
 * FAIL-SOFT CONTRACT: this function never throws. Any error is logged and
 * swallowed — the GHL tag webhook remains the backstop and source of truth;
 * a snapshot write failure must never fail the parent action.
 */

import supabase from '../supabase.js';

/** Parity with ghl-tag-handler.js normalizeTag: trim, lowercase, collapse
 *  internal whitespace, drop empties, dedupe. */
function normalize(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const n = String(t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Apply a tag mutation to contact_tag_snapshot immediately (write-through).
 *
 * @param {string} contactId  GHL contact ID
 * @param {object} [opts]
 * @param {string[]} [opts.add]     tags just added in GHL
 * @param {string[]} [opts.remove]  tags just removed in GHL
 * @returns {Promise<void>}  resolves always; never rejects (fail-soft)
 */
export async function applyTagsToSnapshot(contactId, { add = [], remove = [] } = {}) {
  try {
    if (!supabase || !contactId) return;
    const addTags = normalize(add);
    const removeTags = normalize(remove);
    if (addTags.length === 0 && removeTags.length === 0) return;

    const { error } = await supabase.rpc('apply_tags_to_snapshot', {
      p_contact_id: contactId,
      p_add: addTags,
      p_remove: removeTags,
    });
    if (error) {
      console.warn(`[tag-snapshot] write-through failed for ${contactId} (fail-soft): ${error.message}`);
    }
  } catch (err) {
    console.warn(`[tag-snapshot] write-through failed for ${contactId} (fail-soft): ${err?.message || err}`);
  }
}

export default { applyTagsToSnapshot };
