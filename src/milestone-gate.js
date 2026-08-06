/**
 * Milestone Achievement Gate — src/milestone-gate.js
 *
 * ONE predicate answering ONE question: has this LP milestone actually
 * HAPPENED yet?
 *
 * WHY THIS EXISTS
 * ---------------
 * Both milestone fire paths (syncJobAndMilestones in src/sync-children.js
 * and processMilestoneTriggers in src/milestones.js) treated
 * "act_date IS NOT NULL" as "achieved". That is wrong. Lead Perfection is
 * routinely used to record SCHEDULED actuals — the coordinator books the
 * install and stamps act_date with the future date.
 *
 * Measured on 2026-08-06, production LP Supabase:
 *   - 209 milestone rows carry an act_date in the FUTURE
 *   - 56 of them had ALREADY FIRED their GHL tag
 *   - S (Install Start): 64 future rows, out to 2026-11-12
 *   - F (Install End):   47 future rows, out to 2026-12-29, 6 already fired
 *   - V (Receive Win):   54 future rows, 29 already fired
 * Plus corrupt entry: a "Received All Product" dated 2206-01-23 and an
 * "Inspection Passed" dated 2046-04-01, both fired.
 *
 * With the C.x Customer Journey workflows dark, the blast radius so far is
 * a wrong tag and a premature P2 stage move. The moment C.2 publishes,
 * those six F fires become "how did the install go?" texts sent to
 * customers four months before the crew arrives. Gate it first.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not stop the ROW from being written. A future act_date is real
 * data — it is the scheduled date, and reporting wants it. Only the GHL
 * tag and the lp.milestone_completed event are held back. The sweeper
 * (processMilestoneTriggers) re-evaluates every unfired row on each sync,
 * so a gated milestone fires on the day it actually lands. Nothing is
 * lost; it just fires on the right day.
 */

// Reece has operated in Florida since 2005. An act_date before that is
// data entry corruption, not history.
const MIN_PLAUSIBLE_YEAR = 2005;

// A date this far out is corruption, not scheduling (the 2206 and 2046
// rows above). Kept separate from the "future" test so the reason codes
// stay distinguishable in logs.
const MAX_FUTURE_YEARS = 2;

/**
 * Classify a milestone act_date. Pure — no I/O, no clock capture beyond
 * the injected `now`, so it is unit-testable.
 *
 * @param {string|Date|null} actDate  ET-normalised act_date (post lpDateToEastern)
 * @param {Date} [now]
 * @returns {{ achieved: boolean, reason: string }}
 *
 * reason ∈ no_act_date | unparseable | corrupt_past | corrupt_future
 *          | scheduled_not_yet_reached | achieved
 */
export function classifyMilestoneDate(actDate, now = new Date()) {
  if (!actDate) return { achieved: false, reason: 'no_act_date' };

  const t = actDate instanceof Date ? actDate.getTime() : Date.parse(actDate);
  if (Number.isNaN(t)) return { achieved: false, reason: 'unparseable' };

  const year = new Date(t).getUTCFullYear();
  if (year < MIN_PLAUSIBLE_YEAR) return { achieved: false, reason: 'corrupt_past' };
  if (year > now.getUTCFullYear() + MAX_FUTURE_YEARS) {
    return { achieved: false, reason: 'corrupt_future' };
  }

  // The real gate. act_date is stored midnight-ET-normalised, so a
  // milestone completed TODAY parses to an instant already behind `now`
  // and passes; one dated tomorrow does not.
  if (t > now.getTime()) return { achieved: false, reason: 'scheduled_not_yet_reached' };

  return { achieved: true, reason: 'achieved' };
}

/** Boolean shorthand for the common call site. */
export function isMilestoneAchieved(actDate, now = new Date()) {
  return classifyMilestoneDate(actDate, now).achieved;
}

/**
 * Lower bound for the sweeper's act_date range filter, so the gate is
 * pushed into Postgres rather than filtering thousands of rows in Node.
 * Pairs with an upper bound of now().
 */
export const MIN_PLAUSIBLE_ACT_DATE = `${MIN_PLAUSIBLE_YEAR}-01-01T00:00:00.000Z`;

export const __testing = { MIN_PLAUSIBLE_YEAR, MAX_FUTURE_YEARS };
