/**
 * Team classification rules — src/ci/teams.js
 *
 * ONE home for the team-derivation rules, shared by discovery (which sees a
 * call's AGENT NAME) and the seed script (which sees a Five9 user record).
 * Duplicating a load-bearing mapping rule is how partners' calls get
 * mis-attributed, so both callers import from here.
 *
 * ── WHY THIS FILE EXISTS AT ALL, AND TWO CORRECTIONS ───────────────────────
 * PR #725 concluded the handoff's " - LF" / " - NC" / " - FTM" suffixes did
 * not exist on the Five9 side, because zero of 48 users returned by
 * getUsersGeneralInfo carried one. That conclusion is WRONG, and an earlier
 * revision of this comment repeated it in a softer form ("true of the user
 * records, false of the call log"). That was wrong too.
 *
 * Verified live 2026-08-21 against all 54 users: the suffix is in the USER
 * RECORD as well, carried on lastName —
 *
 *     firstName 'Brian'  lastName 'Lovette - NC'   fullName 'Brian Lovette - NC'
 *     firstName 'Shari'  lastName 'Walker - LF'    fullName 'Shari Walker - LF'
 *
 * — and in the call log's AGENT NAME. BOTH sources carry it. Whatever the
 * original 48-user check looked at, it was not lastName or fullName.
 *
 * This is not cosmetic. The map seeded on 2026-08-20 classified by email
 * ONLY, which left the entire North Carolina team — ten agents whose emails
 * are @reecebuilders.com or unlabelled personal gmails — sitting in
 * 'unknown', i.e. bound for the review queue on every call. Their team was
 * spelled out in their own name field the whole time. Re-seeded 2026-08-21:
 * unknown went 11 -> 1.
 *
 * Order of authority: suffix first (both sources carry it, and it is what the
 * dialer records against the call), email domain as fallback, then 'unknown'.
 *
 * Pure module: no env, no clients, no import-time work.
 */

/** LP-name suffixes, authoritative when present. */
const TEAM_SUFFIXES = [
  [/\s*-\s*LF$/i, 'lightfire'],
  [/\s*-\s*NC$/i, 'north_carolina'],
  [/\s*-\s*FTM$/i, 'ftm'],
];

/**
 * Email → team. Measured against the live domain 2026-08-20; used at seed
 * time, where the Five9 user record carries no suffix.
 */
const TEAM_EMAIL_RULES = [
  [/@lightfirepartners\.com$/i, 'lightfire'],
  [/lfpc@gmail\.com$/i, 'lightfire'],       // LightFire Partners call-centre gmails
  [/@reecewindows\.com$/i, 'reece'],
  [/\.reece@gmail\.com$/i, 'reece'],        // the ".reece@gmail.com" agent convention
];

/** The LP-name suffix rule. Returns null when no suffix is present. */
export function teamFromName(name) {
  const s = String(name || '').trim();
  for (const [re, team] of TEAM_SUFFIXES) {
    if (re.test(s)) return team;
  }
  return null;
}

/** The email-domain rule. Returns null when no pattern matches. */
export function teamFromEmail(email) {
  const s = String(email || '').trim();
  if (!s) return null;
  for (const [re, team] of TEAM_EMAIL_RULES) {
    if (re.test(s)) return team;
  }
  return null;
}

/**
 * Strip the team suffix to get the person's actual name.
 * 'Shari Walker - LF' → 'Shari Walker', so the same human matches the seeded
 * ci_agent_map row (seeded from the user record, which has no suffix).
 */
export function stripTeamSuffix(name) {
  let s = String(name || '').trim();
  for (const [re] of TEAM_SUFFIXES) s = s.replace(re, '');
  return s.trim();
}

/**
 * Five9 renders "no agent on this leg" as the literal string '[None]', not as
 * an empty cell. Treating it as a name would make every agentless transfer leg
 * and every unanswered dial look agent-handled — and would sail straight past
 * the no_agent eligibility check.
 */
export const NO_AGENT_SENTINELS = new Set(['[none]', 'none', '-', 'n/a']);

export function normalizeAgentField(value) {
  const s = String(value ?? '').trim();
  if (!s || NO_AGENT_SENTINELS.has(s.toLowerCase())) return null;
  return s;
}
