/**
 * Rep roster lookup — src/rep-roster.js
 *
 * Answers one question: which market does the sales rep on this lead belong to?
 *
 * The only rep key Lead Perfection actually gives us is a NAME. `lp_leads.rep_id`
 * is NULL on all 227,710 rows and no LP source field for it is known, and the
 * 4-digit `pro_id` on a lead is the PROMOTER credited with it, not the rep. So
 * this matches on the name string, normalised.
 *
 * The roster is `team_members`, filled in by the Slack onboarding form
 * (OPS.SLK-A in the n8n repo). Until reps are onboarded through that form this
 * will miss for almost everyone — that is expected, and callers are required to
 * have a fallback. Every miss is logged with a reason so the gap is measurable
 * rather than invisible.
 *
 * LP writes rep names as "Last, First". Real examples: "Dorsett, Beverly",
 * "O'Connor, Tim", "Colón, Angelo". Some surfaces give "First Last" instead, so
 * both orders are tried.
 */
import supabase from './supabase.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
let rosterCache = null;   // Map "first|last" -> { market_code, count }
let cacheLoadedAt = 0;

// Test seam, same rationale as groupme.js and slack.js: the roster reads the
// module-level supabase singleton and this is reached from the action layer
// with no injection point. null = production client.
let _clientOverride = null;

/** TESTS ONLY — point the roster cache at a stub client. */
export function __setRosterClientForTests(client) {
  _clientOverride = client;
}

/** TESTS ONLY — reset the cache between cases. */
export function __resetRosterCacheForTests() {
  rosterCache = null;
  cacheLoadedAt = 0;
}

function _client() {
  return _clientOverride || supabase;
}

/**
 * Lower-case, strip accents, drop everything that is not a letter or digit.
 * "O'Connor" and "OConnor" must land on the same key, and so must "Colón" and
 * "Colon" — LP and the onboarding form disagree about both often enough.
 */
export function normalizeNamePart(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Split a rep name into { first, last } normalised parts.
 * "Dorsett, Beverly" -> { first: 'beverly', last: 'dorsett' }
 * "Beverly Dorsett"  -> { first: 'beverly', last: 'dorsett' }
 * Returns null when there are not two usable parts.
 */
export function splitRepName(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',');
    const first = rest.join(' ');
    const f = normalizeNamePart(first);
    const l = normalizeNamePart(last);
    return f && l ? { first: f, last: l } : null;
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  // "First Last" -> the two tokens. With three or more tokens this takes the
  // first and the last, which is right for a middle name and WRONG for a
  // two-word surname or first name: "Mary Ann van der Berg" becomes
  // mary|berg and will not match a roster row of "Mary Ann" / "van der Berg".
  // That is accepted. LP writes rep names as "Last, First", which the comma
  // branch above splits correctly in every one of those cases; this branch is
  // a best-effort fallback for the surfaces that do not.
  const f = normalizeNamePart(parts[0]);
  const l = normalizeNamePart(parts[parts.length - 1]);
  return f && l ? { first: f, last: l } : null;
}

/**
 * Load the non-departed roster into memory, keyed "first|last".
 *
 * A key claimed by more than one person is recorded with its count so the
 * lookup can refuse it: two different Beverly Dorsetts in different markets is
 * exactly the case where guessing sends a complaint to the wrong team.
 * A failed load leaves the previous cache in place — stale beats empty.
 */
async function _loadRoster() {
  if (rosterCache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return;
  const db = _client();
  if (!db) return;
  try {
    const { data } = await db
      .from('team_members')
      .select('first_name, last_name, market_code, status')
      .neq('status', 'departed');
    if (!Array.isArray(data)) return;
    const next = new Map();
    for (const r of data) {
      const key = `${normalizeNamePart(r.first_name)}|${normalizeNamePart(r.last_name)}`;
      if (key === '|') continue;
      const seen = next.get(key);
      if (seen) {
        seen.count += 1;
        // Same name, same market is not a conflict worth refusing.
        if (seen.market_code !== (r.market_code || null)) seen.ambiguous = true;
      } else {
        next.set(key, { market_code: r.market_code || null, count: 1, ambiguous: false });
      }
    }
    rosterCache = next;
    cacheLoadedAt = Date.now();
    console.log(`[RepRoster] loaded ${rosterCache.size} roster names`);
  } catch (err) {
    console.warn(`[RepRoster] load failed (using previous): ${err.message}`);
  }
}

/**
 * Resolve the market CODE for a rep name.
 *
 * Never throws. Returns { code, reason } — `code` is null whenever the caller
 * must fall back to the lead's own market, and `reason` says why:
 *   no_name        — nothing to match on
 *   unparsed_name  — could not split into a first and last name
 *   no_match       — nobody on the roster by that name
 *   ambiguous      — more than one person, in different markets
 *   no_market      — matched, but that person is company-wide
 *   ok             — `code` is usable
 */
export async function resolveRepMarketCode(repName) {
  if (!repName) return { code: null, reason: 'no_name' };
  const parts = splitRepName(repName);
  if (!parts) {
    console.warn(`[RepRoster] could not parse rep name "${repName}"`);
    return { code: null, reason: 'unparsed_name' };
  }
  await _loadRoster();
  const hit = rosterCache?.get(`${parts.first}|${parts.last}`);
  if (!hit) {
    console.log(`[RepRoster] no roster match for "${repName}" — falling back to the lead's market`);
    return { code: null, reason: 'no_match' };
  }
  if (hit.ambiguous) {
    console.warn(`[RepRoster] "${repName}" matches ${hit.count} people in different markets — falling back`);
    return { code: null, reason: 'ambiguous' };
  }
  if (!hit.market_code) return { code: null, reason: 'no_market' };
  return { code: String(hit.market_code).toUpperCase(), reason: 'ok' };
}
