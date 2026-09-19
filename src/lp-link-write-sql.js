/**
 * LP↔GHL link repair — write statements — src/lp-link-write-sql.js
 *
 * Pure string builders for the four statements scripts/repair-lp-ghl-links.js
 * issues when it writes a link. No I/O, no imports. Extracted so the SHAPE of
 * each statement is unit-testable without a database, because the shape is what
 * broke.
 *
 * ─── WHY A BARE UPDATE AND NOT A DATA-MODIFYING CTE ─────────────────────────
 * CLAUDE.md prescribes `WITH u AS (... RETURNING 1) SELECT count(*) FROM u` for
 * asserting a write's row count. That is correct for the Supabase MCP query
 * tool. It is WRONG through this repo's own `runSQL`, and the difference cost a
 * live run on 2026-09-18: all 42 writes were refused with
 *
 *     WITH clause containing a data-modifying statement must be at the top level
 *
 * `runSQL` goes through the `public.run_sql` RPC (sql/run_sql.sql), which wraps
 * any statement beginning with SELECT or WITH in
 * `jsonb_agg(row_to_json(sub))` so every column round-trips. That wrapper puts
 * the CTE below the top level, and Postgres rejects it outright. Non-SELECT
 * statements run unchanged, so a BARE UPDATE is the only form that works here.
 *
 * The failure was safe — the statement is refused whole, so nothing was
 * partially applied and zero rows were written. But it is silent about WHY at
 * the call site, which is what these builders and their tests now pin.
 *
 * ─── HOW THE OUTCOME IS DETERMINED WITHOUT rows_affected ────────────────────
 * The RPC returns a status object for a non-SELECT, not a row count, so the
 * caller cannot learn from the UPDATE itself whether the guard held. It READS
 * THE ROW BACK instead (CLAUDE.md: "verify with a follow-up count"). That is
 * strictly better than a count here: whatever `ghl_contact_id` holds after the
 * write IS the outcome, and it distinguishes the three cases by value rather
 * than by a second predicate —
 *
 *   equals ours  → written
 *   another id   → raced; the live sync linked it first, and its link stands
 *   NULL/missing → the row is gone or the id never matched. A real failure.
 */

/** Single-quote escape for a SQL string literal. */
function q(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Write the link onto one lead.
 *
 * `AND ghl_contact_id IS NULL` is the race guard: the live 15-minute sync runs
 * while the repair does, and a lead legitimately linked between our read and
 * our write must be left alone. That is the one outcome the rollback log could
 * not undo.
 */
export function buildLeadLinkUpdate(lpLeadId, contactId, source) {
  return `UPDATE lp_leads
     SET ghl_contact_id = '${q(contactId)}', ghl_link_source = '${q(source)}'
   WHERE lp_lead_id = '${q(lpLeadId)}'
     AND ghl_contact_id IS NULL`;
}

/** Read the lead's link back, so the outcome is observed rather than assumed. */
export function buildLeadLinkReadback(lpLeadId) {
  return `SELECT ghl_contact_id FROM lp_leads WHERE lp_lead_id = '${q(lpLeadId)}'`;
}

/** Propagate the link to the lead's jobs. Same guard, same reason. */
export function buildJobsLinkUpdate(lpLeadId, contactId) {
  return `UPDATE lp_jobs
     SET ghl_contact_id = '${q(contactId)}'
   WHERE lp_lead_id = '${q(lpLeadId)}'
     AND ghl_contact_id IS NULL`;
}

/** How many of the lead's jobs now carry our link. */
export function buildJobsLinkCount(lpLeadId, contactId) {
  return `SELECT count(*) AS n FROM lp_jobs
   WHERE lp_lead_id = '${q(lpLeadId)}'
     AND ghl_contact_id = '${q(contactId)}'`;
}

/**
 * Clear a link the corroborator refused, keeping the verdict as the audit trail.
 *
 * 2026-09-19. Used by scripts/repair-rejected-links.js for rows whose stored
 * ghl_contact_id IS the rejected candidate — LP's own lognumber, verified
 * against the GHL contact's phone/email and found to disagree. The id is the
 * wrong part; ghl_link_source is the record of why it went, so it stays.
 *
 * Both guards matter. `ghl_contact_id = <the id we read>` leaves a row alone if
 * the live sync changed it between our read and our write, and the source
 * predicate means a row reclassified in the meantime is no longer ours to
 * clear. A bare UPDATE, for the run_sql reason documented at the top of this
 * file.
 */
export function buildRejectedLinkClear(lpLeadId, seenContactId) {
  return `UPDATE lp_leads
     SET ghl_contact_id = NULL
   WHERE lp_lead_id = '${q(lpLeadId)}'
     AND ghl_contact_id = '${q(seenContactId)}'
     AND ghl_link_source IN ('rejected_conflict', 'rejected_uncorroborated')`;
}

/**
 * Restore an honest classification on a link that was never itself rejected.
 *
 * The other shape behind the same symptom: the stored id came from a good
 * phone match and a DIFFERENT lognumber candidate was rejected, which
 * overwrote the row's classification. The id is fine and must not be cleared;
 * only the label is wrong. legacy_unverified is the honest floor — it says
 * "linked, not corroborated", which is exactly what is true — and it puts the
 * row back in scope for normal verification.
 */
export function buildRejectedSourceReset(lpLeadId, seenContactId) {
  return `UPDATE lp_leads
     SET ghl_link_source = 'legacy_unverified'
   WHERE lp_lead_id = '${q(lpLeadId)}'
     AND ghl_contact_id = '${q(seenContactId)}'
     AND ghl_link_source IN ('rejected_conflict', 'rejected_uncorroborated')`;
}

/** Read both columns back, so each outcome is observed rather than assumed. */
export function buildRejectedLinkReadback(lpLeadId) {
  return `SELECT ghl_contact_id, ghl_link_source FROM lp_leads
   WHERE lp_lead_id = '${q(lpLeadId)}'`;
}

export const _internal = { q };
