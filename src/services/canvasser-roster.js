/**
 * Canvasser identity — validate a Pro ID before it reaches Lead Perfection
 * src/services/canvasser-roster.js
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The canvassing intake forwards a numeric id to LP as `pro_id`, and LP
 * resolves that id to a promoter NAME on the lead — the canvasser who gets the
 * credit, and the commission.
 *
 * But the number arriving from GHL is not guaranteed to be from LP's id space.
 * A SalesRabbit lead id or a GHL user id is also just digits, and LP has no way
 * to tell one from another: it looks the number up in ITS table and returns
 * whoever lives there. Pro IDs observed on the live roster run 1688..6090, a
 * range a foreign id can easily land inside — so the failure is not an error,
 * it is a DIFFERENT REAL PERSON silently credited with the lead. Nothing
 * downstream can detect that, because a wrongly-attributed lead looks exactly
 * like a correctly-attributed one.
 *
 * So the id is checked against the roster BEFORE it is sent.
 *
 * ── THIS IS INSURANCE, NOT A REPAIR ────────────────────────────────────────
 * Traced end to end on live leads (2026-08-25) BEFORE writing this, and the
 * path is currently CORRECT — no misattribution was found:
 *
 *   GHL contact dNdfHFYEb0PTeHYYJQlo  pro_id=4428  ->  LP "Clemons, Joshua - FTM"
 *   roster 4428 = "Joshua Clemons", FTMYR                        ✓ same person
 *   GHL contact pPDw6VflphQGtOCIyZbM  pro_id=5607  ->  LP "Jackson, Terrance - FTM"
 *   roster 5607 = "Terrance Jackson", FTMYR                      ✓ same person
 *
 * The canvass landing page sends `pro_id` and `sales_rabbit_lead_id` as
 * SEPARATE parameters (4428 vs 5768592), so the two id spaces are not being
 * confused today. Across the previous 7 days, 302 of 371 canvass leads
 * resolved to promoters that are on the roster.
 *
 * The guard exists because the failure it prevents is undetectable after the
 * fact: nothing downstream can tell a lead credited to the wrong canvasser
 * from one credited correctly. It is deliberately cheap — one indexed lookup
 * per canvassing lead — and it ships observing (below), so it changes nothing
 * until someone reads the verdicts and decides.
 *
 * ── UNATTRIBUTED BEATS MISATTRIBUTED ───────────────────────────────────────
 * Once enforcing, a miss means the id is WITHHELD rather than forwarded. A
 * lead with no promoter is visibly incomplete and someone fixes it; a lead
 * credited to the wrong canvasser pays the wrong person and nobody ever
 * notices. The lead itself is never blocked — the customer matters more than
 * the attribution — and every miss is reported loudly so the cause gets fixed.
 *
 * Enforcement is gated (see ENFORCE below); it ships observing, so the miss
 * rate is measured before anything stops being sent.
 *
 * ── THE ROSTER IS A SNAPSHOT, AND THAT CUTS BOTH WAYS ──────────────────────
 * ci_canvassers (sql/067) is seeded from LP and is the same Pro ID space LP
 * resolves against — that is what makes it a valid check. It is also a
 * SNAPSHOT: a canvasser hired since the last seed is a legitimate id that is
 * not in the table yet, and their leads will come back `unknown_pro_id` until
 * someone re-runs scripts/seed-ci-canvassers.js. That is the intended
 * trade — a visible gap for a new hire, rather than a silent misattribution
 * for everyone — and it is exactly why the verdict distinguishes "not on the
 * roster" from "not a number", so the two are fixed differently.
 */

import supabaseDefault from '../supabase.js';

/** Pro IDs seen on the live roster, for the shape check below. */
export const PRO_ID_MIN = 1;
export const PRO_ID_MAX = 999999;

/**
 * ── IT SHIPS IN OBSERVE MODE, DELIBERATELY ─────────────────────────────────
 *
 * Dropping a Pro ID is the right answer for a FOREIGN id and the wrong answer
 * for a canvasser the roster snapshot has not caught up with — and both look
 * identical here: digits that are not in the table.
 *
 * Measured before enabling this (7 days to 2026-08-25): 78 of 94 promoters,
 * 302 of 371 canvass leads, resolve to names that ARE on the roster, with
 * plausible markets. Most of the remaining 16 are artefacts rather than
 * misses — "Torres - Rodriguez, Sebastian - ORL" contains the market
 * delimiter, and "Unknown, Unknown" / "Canvasser, Old Lakeland" are LP's own
 * placeholders. That is not the signature of wholesale id-space collision, so
 * enforcing on day one would risk stripping credit from real canvassers to
 * prevent a misattribution we have not yet actually observed.
 *
 * So: OBSERVE first. Every lead records the verdict and the resolved name on
 * its canvassing.lead_created event, which turns "are GHL's ids really LP Pro
 * IDs?" into a query instead of an argument:
 *
 *   SELECT payload->>'pro_id_verdict', count(*) FROM system_events
 *   WHERE event_type = 'canvassing.lead_created'
 *     AND created_at > now() - interval '3 days'
 *   GROUP BY 1;
 *
 * If unknown_pro_id is rare, set CANVASS_PRO_ID_ENFORCE=true and foreign ids
 * stop reaching LP. If it is common, the roster is stale — re-seed first, or
 * the guard would drop good attribution at scale.
 */
export const ENFORCE = () => String(process.env.CANVASS_PRO_ID_ENFORCE || '').toLowerCase() === 'true';

/**
 * Is this even a plausible Pro ID? Pure — no roster needed.
 *
 * Separate from the roster lookup because the two failures have different
 * fixes: a non-numeric value means the GHL field is mapped to the wrong thing,
 * while a numeric value that is not on the roster means the id is from another
 * system (or the roster is stale).
 */
export function isProIdShaped(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= PRO_ID_MIN && n <= PRO_ID_MAX;
}

/**
 * Turn a roster lookup into a verdict. Pure, so every branch is testable
 * without a database.
 *
 * @param {*} value      the id as it arrived from GHL
 * @param {object|null} row   the matching ci_canvassers row, or null
 * @param {boolean} [enforce] withhold an unknown id (default: the env gate)
 * @returns {{send: boolean, proId: string|null, name: string|null,
 *            market: string|null, reason: string, withheld?: boolean}}
 */
export function verdictFor(value, row, enforce = ENFORCE()) {
  const s = String(value ?? '').trim();

  if (!s) return { send: false, proId: null, name: null, market: null, reason: 'absent' };

  if (!isProIdShaped(s)) {
    // Not digits at all — the GHL field is carrying something else entirely
    // (a name, a token, an unresolved merge tag).
    return { send: false, proId: null, name: null, market: null, reason: 'not_numeric' };
  }

  if (!row) {
    // THE CASE THIS MODULE EXISTS FOR. Digits that LP would happily resolve to
    // whoever occupies that id.
    //
    // Whether it is actually withheld depends on ENFORCE — see the note above.
    // In observe mode the id still goes (so a stale roster cannot silently
    // strip credit from real canvassers) but the verdict is recorded either
    // way, which is what makes the enforce decision evidence-based.
    return {
      send: !enforce,
      proId: enforce ? null : s,
      name: null,
      market: null,
      reason: 'unknown_pro_id',
      withheld: enforce,
    };
  }

  if (row.active === false) {
    // On the roster but no longer on the doors. Still a real identity, so the
    // credit is not wrong — worth naming, not worth dropping.
    return {
      send: true,
      proId: String(row.pro_id),
      name: row.name ?? null,
      market: row.market ?? null,
      reason: 'inactive_canvasser',
    };
  }

  return {
    send: true,
    proId: String(row.pro_id),
    name: row.name ?? null,
    market: row.market ?? null,
    reason: 'ok',
  };
}

/**
 * Look the id up on the roster and return the verdict.
 *
 * A database error is treated exactly like an unknown id: when the roster
 * cannot be read we do not KNOW whether the id is real. Enforcing, that means
 * withholding it — guessing "probably fine" is precisely the misattribution
 * this exists to prevent. Observing, it still goes, because a transient blip
 * must not quietly strip credit from every canvasser until it clears. The
 * lead itself is never blocked either way.
 *
 * @returns {Promise<{send, proId, name, market, reason}>}
 */
export async function resolveCanvasserProId(value, { db = supabaseDefault, enforce = ENFORCE() } = {}) {
  const s = String(value ?? '').trim();
  if (!s || !isProIdShaped(s)) return verdictFor(s, null, enforce);

  const unavailable = (why) => ({
    send: !enforce,
    proId: enforce ? null : s,
    name: null,
    market: null,
    reason: 'roster_unavailable',
    withheld: enforce,
    detail: why,
  });

  if (!db) return unavailable('no supabase client');

  const { data, error } = await db
    .from('ci_canvassers')
    .select('pro_id, name, market, active')
    .eq('pro_id', Number(s))
    .limit(1);

  if (error) {
    console.warn(
      `[Canvasser] roster lookup failed for pro_id ${s}`
      + ` (${enforce ? 'withholding attribution' : 'observing only — id still sent'}): ${error.message}`,
    );
    return unavailable(error.message);
  }

  // (pro_id, phone_last10) is the composite key, so one canvasser can hold
  // several rows — any of them proves the identity, and they carry the same
  // name and market.
  return verdictFor(s, (data && data[0]) || null, enforce);
}

export default { resolveCanvasserProId, verdictFor, isProIdShaped, ENFORCE, PRO_ID_MIN, PRO_ID_MAX };
