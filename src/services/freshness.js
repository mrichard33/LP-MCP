// ─── Mirror freshness — src/services/freshness.js ─────────────────────────
//
// WHAT
//   One place for: (a) the verified stamp every mirror writer applies, and
//   (b) the field-level precedence rulebook, as executable constants rather
//   than prose someone has to remember.
//
// WHY
//   "Stale" was a feeling. synced_at only moves on a WRITE, so a row that is
//   correct and untouched for a year is indistinguishable from one nobody has
//   checked in a year. verified_at answers "when did we last COMPARE this
//   against the live system", which is the question that actually matters.
//
// SCOPE — what counts as a mirror (verified live 2026-09-18)
//   A table is a mirror when its rows shadow a record that can CHANGE in an
//   upstream system: lp_leads, lp_prospects, lp_notes, lp_jobs,
//   lp_job_milestones, and HL contacts. Event logs (lp_activities,
//   lp_call_logs, five9_events_raw, lp_lead_disposition_history), derived
//   aggregates (lp_source_scorecard_daily, lp_appt_fill_hourly) and deliberate
//   snapshots (five9_config_snapshots, lp_link_propagate_undo_*) are NOT
//   mirrors and get no stamp — an event that happened does not go stale, and a
//   derived row is fixed by rerunning its derivation, not by re-pulling LP.

/** Sources a row can be verified against. */
export const VERIFIED_FROM = Object.freeze({
  LP: 'lp',
  GHL: 'ghl',
  FIVE9: 'five9',
});

/**
 * Enabled by LP_VERIFIED_AT_ENABLED (default false). The same flag sql/120 put
 * on lp_leads, deliberately reused so there is ONE freshness switch rather than
 * one per table.
 *
 * 2026-09-18: that flag is already true in production, so these columns go live
 * the moment this deploys — there is nothing to flip afterwards. sql/121 is
 * mirrored in runMigrations() (src/index.js), which is awaited BEFORE
 * startSyncScheduler(), so the columns exist before the first sync pass. If
 * that mirror is ever removed, a select naming verified_at fails, the prospect
 * skip gate below collapses, and all 147k prospects are rewritten every sync.
 */
export const verifiedAtEnabled = (env = process.env) =>
  String(env.LP_VERIFIED_AT_ENABLED || 'false').toLowerCase() === 'true';

/**
 * The stamp, as a spreadable object. Returns {} when disabled so the keys drop
 * out of the row entirely — the same "absent never overwrites" contract
 * buildLeadRow already relies on.
 */
export function verifiedStamp(source = VERIFIED_FROM.LP, env = process.env) {
  if (!verifiedAtEnabled(env)) return {};
  return { verified_at: new Date().toISOString(), verified_from: source };
}

/** Columns a diff must never compare — ours, not the upstream system's. */
export const FRESHNESS_VOLATILE_COLUMNS = Object.freeze([
  'synced_at', 'verified_at', 'verified_from', 'lp_verified_at', 'lp_payload_hash',
]);

/**
 * FIELD-LEVEL PRECEDENCE — the rulebook, as data.
 *
 * Two systems can both hold an opinion about the same lead. Without a stated
 * winner, whichever writer runs last wins, and the two paths overwrite each
 * other forever. Prose in a doc drifts from code; this is the doc.
 *
 * Read docs/data-freshness-rulebook.md for the reasoning. This is the
 * enforceable half.
 */
export const FIELD_PRECEDENCE = Object.freeze({
  // LP is the system of record for the sales process itself.
  disposition_code:      VERIFIED_FROM.LP,
  appointment_set:       VERIFIED_FROM.LP,
  appointment_date:      VERIFIED_FROM.LP,
  appointment_confirmed: VERIFIED_FROM.LP,
  appointment_verified:  VERIFIED_FROM.LP,
  demo_completed:        VERIFIED_FROM.LP,
  closed_won:            VERIFIED_FROM.LP,
  job_status:            VERIFIED_FROM.LP,
  job_value:             VERIFIED_FROM.LP,
  rep_name:              VERIFIED_FROM.LP,
  set_by_name:           VERIFIED_FROM.LP,

  // GHL owns the conversation layer and the consent state.
  tags:                  VERIFIED_FROM.GHL,
  dnc:                   VERIFIED_FROM.GHL,
  consent:               VERIFIED_FROM.GHL,
  engagement:            VERIFIED_FROM.GHL,
  last_inbound_at:       VERIFIED_FROM.GHL,
});

/**
 * Who wins for a field. Anything not named above: newest verified value wins,
 * signalled by null so the caller compares verified_at rather than guessing.
 */
export function precedenceFor(field) {
  return FIELD_PRECEDENCE[field] ?? null;
}

/**
 * True when `source` may overwrite `field`. A source that does not own a field
 * can still write it when it is the freshest observation — that is the
 * newest-wins default, and it is the caller's job to pass verifiedAt values.
 */
export function mayOverwrite(field, source, { storedVerifiedAt, incomingVerifiedAt } = {}) {
  const owner = precedenceFor(field);
  if (owner) return owner === source;
  if (!storedVerifiedAt) return true;
  if (!incomingVerifiedAt) return false;
  return Date.parse(incomingVerifiedAt) >= Date.parse(storedVerifiedAt);
}
