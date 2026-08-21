/**
 * Team classification rules — src/ci/teams.js
 *
 * ONE home for the team-derivation rules, shared by discovery (which sees a
 * call's AGENT NAME) and the seed script (which sees a Five9 user record).
 * Duplicating a load-bearing mapping rule is how partners' calls get
 * mis-attributed, so both callers import from here.
 *
 * ── WHY THIS FILE EXISTS AT ALL, AND A CORRECTION ──────────────────────────
 * PR #725 concluded the handoff's " - LF" / " - NC" / " - FTM" suffixes did
 * not exist on the Five9 side, because zero of 48 users returned by
 * getUsersGeneralInfo carried one. That was true of the USER RECORDS and false
 * of the CALL LOG: verified live 2026-08-21, the report's AGENT NAME column
 * returns 'Shari Walker - LF', 'Craig Deer - LF', 'Carla Wright - LF' — the
 * suffix is right there, exactly as handoff decision #5 said.
 *
 * So both signals are real and they agree. The suffix is authoritative when
 * present (it is what the dialer itself records against the call); the email
 * domain is the fallback used at seed time, where no suffix is available. The
 * nine agents the email rule classified as lightfire are the same nine the
 * suffix identifies, which is a useful independent confirmation that the
 * seeded map is correct.
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
