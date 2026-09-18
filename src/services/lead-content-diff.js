// ─── lp_leads content diff — src/services/lead-content-diff.js ────────────
//
// WHAT
//   Pure comparison of a stored lp_leads row against the row buildLeadRow()
//   would write for the same lead. Returns the list of LP-derived columns
//   whose value would change. Mode resolver for the gate that consumes it.
//
// WHY
//   Both lead writers skip the upsert when LP's lastchangedon is unchanged.
//   LP does not bump lastchangedon for many field edits (setter rename,
//   address correction, rep reassignment, phone fix), so the skip gate has
//   grown a list of hand-coded exceptions and everything off the list rots.
//   Comparing CONTENT instead of a timestamp is the general fix.
//
// CONTRACT
//   - Only LEAD_CONTENT_COLUMNS are compared. GHL link columns, raw_lp_data,
//     synced_at, lp_payload_hash, lp_verified_at are deliberately excluded:
//     they are ours, not LP's, and each has its own write rule.
//   - A candidate key that is undefined is SKIPPED ("absent never
//     overwrites" — the same contract buildLeadRow already relies on).
//   - null and '' are equal. Strings compare trimmed (LP pads with spaces).
//     Timestamps compare by instant so '2026-09-13T16:25:00+00:00' equals
//     '2026-09-13T16:25:00Z'. Booleans and numbers compare strictly.

export const LEAD_CONTENT_COLUMNS = Object.freeze([
  'first_name', 'last_name', 'email', 'phone', 'phone_alt',
  'address', 'city', 'state', 'zip',
  'lead_source', 'lead_source_detail', 'promoter_name', 'lp_branch_id',
  'disposition_code', 'rep_name',
  'appointment_set', 'appointment_confirmed', 'appointment_verified', 'appointment_date',
  'demo_completed', 'demo_date', 'closed_won', 'job_value',
  'set_by_name', 'confirmed_by_name', 'verified_by_name', 'set_date', 'confirmed_date',
  'ever_set', 'ever_confirmed', 'ever_sat', 'ever_issued', 'ever_net_issued',
  'created_at_lp', 'updated_at_lp',
]);

const TIMESTAMP_COLUMNS = new Set([
  'appointment_date', 'demo_date', 'set_date', 'confirmed_date', 'created_at_lp', 'updated_at_lp',
]);

const MODES = new Set(['off', 'shadow', 'enforce']);

/** off | shadow (default) | enforce. Unknown values fall back to shadow. */
export function contentDiffMode(env = process.env) {
  const m = String(env.LP_LEAD_CONTENT_DIFF_MODE || 'shadow').toLowerCase().trim();
  return MODES.has(m) ? m : 'shadow';
}

function norm(field, v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (TIMESTAMP_COLUMNS.has(field)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? String(v).trim() : t;
  }
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (field === 'job_value') {
    const n = Number(v);
    return Number.isNaN(n) ? String(v).trim() : n;
  }
  return String(v).trim();
}

/**
 * @param {object|null} existing  stored lp_leads row (must include the columns compared)
 * @param {object|null} candidate row buildLeadRow().row / flatRow would write
 * @returns {Array<{field:string, stored:any, incoming:any}>} changed columns, [] if none
 */
export function diffLeadContent(existing, candidate, columns = LEAD_CONTENT_COLUMNS) {
  const out = [];
  if (!existing || !candidate) return out;
  for (const field of columns) {
    if (!(field in candidate) || candidate[field] === undefined) continue;
    const a = norm(field, existing[field]);
    const b = norm(field, candidate[field]);
    if (a !== b) out.push({ field, stored: existing[field] ?? null, incoming: candidate[field] ?? null });
  }
  return out;
}
