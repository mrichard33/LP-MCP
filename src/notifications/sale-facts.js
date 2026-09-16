/**
 * Sale Announcements — rep performance facts
 * src/notifications/sale-facts.js
 *
 * ONE question: what is true about this rep's month, right now, that is worth
 * celebrating?
 *
 * WHY EVERY FACT IS DATED ON close_date AND NOT appointment_date
 * -------------------------------------------------------------
 * Measured live 2026-09-16: lp_leads.close_date was NULL on all 24,834
 * closed_won rows and had never been written by anything — sync-leads.js sets
 * closed_won and job_value but not close_date. The repo's get_rep_performance
 * RPC works around that by bucketing on appointment_date.
 *
 * sql/118 fixes the column instead of working around it: it backfills
 * close_date from appointment_date (marked close_date_source =
 * 'appointment_proxy') and the sale-announcement endpoint writes a real
 * close_date on every sale from here on ('sale_announcement'). So this module
 * reads close_date and the numbers silently get MORE accurate over time as real
 * close dates replace the proxy. Reading appointment_date directly would have
 * frozen us at the proxy forever.
 *
 * WHY repNameKey EXISTS
 * --------------------
 * LP stores rep names "Last, First" ("O'Connor, Tim"); GHL's Rep Display Name
 * (yxOTDIT7Um0JxkOPUbPo) sends "First Last" ("Tim O'Connor"). This is already
 * documented at src/response-generator.js (see formatRepFirstName), which
 * solves the customer-facing half of the problem by taking the first name
 * alone. Matching a rep to their LP ROWS needs the whole name, so an exact
 * string compare finds zero rows for every rep on the floor — which would have
 * made every single announcement silently factless. repNameKey normalises both
 * orders to one comparable key.
 *
 * ORDERING CONTRACT WITH THE CALLER
 * ---------------------------------
 * The caller writes THIS sale's close_date BEFORE calling buildRepFacts, so
 * "including this sale" falls out of the data instead of being special-cased.
 * rank_before is then derived by subtracting this sale from the rep's volume in
 * the same result set — one query, both ranks, no second read.
 *
 * FAILURE CONTRACT
 * ----------------
 * Hard cap FACTS_BUDGET_MS. On timeout or read failure this returns
 * { degraded: true } and compose proceeds with the sale alone. A factless
 * announcement is a good announcement; a late one is not.
 *
 * deps seam: { supabase, now, logger } so this unit-tests without a live DB.
 */

import supabaseDefault from '../supabase.js';

/** Hard cap for all reads in this module, combined. */
export const FACTS_BUDGET_MS = 3000;

/** A streak worth opening a message on (Structure F in the rulebook). */
export const NOTABLE_STREAK_DAYS = 3;

/**
 * Explicit row bounds. The Supabase client defaults to 1,000 rows, and a DEFAULT
 * is the wrong thing to rely on here: a month that quietly exceeded it would
 * compute every rank against a TRUNCATED set and publish a confidently wrong
 * number to the whole floor. Current volume is ~370-430 sales/month (measured
 * 2026-09-16), so 5,000 is ~12x headroom — and if it is ever hit, buildRepFacts
 * degrades instead of guessing. A missing fact is fine; a wrong rank is not.
 */
export const MTD_ROW_LIMIT = 5000;
export const HISTORY_ROW_LIMIT = 2000;

/**
 * Normalise a rep name to a key that matches across the LP/GHL boundary.
 * "O'Connor, Tim" and "Tim O'Connor" both → "connor o tim".
 *
 * Sorting the tokens is what makes the two orders converge. It is deliberately
 * blunt: two different reps would have to share an identical multiset of name
 * tokens to collide, and a collision costs a wrong fact, not a wrong post.
 */
export function repNameKey(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]+/g, ' ')   // drop apostrophes, commas, hyphens, digits
    .trim()
    .replace(/\s+/g, ' ');
  if (!s) return null;
  return s.split(' ').filter(Boolean).sort().join(' ');
}

/** First of the current month, UTC, as an ISO timestamp. */
export function monthStart(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Twelve months back from `date`, UTC. */
export function trailingYearStart(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Consecutive days, ending today or yesterday, on which this rep closed at
 * least one sale.
 *
 * Yesterday counts as the anchor so a rep who sold Mon-Tue-Wed still reads as a
 * 3-day streak when the Thursday-morning announcement lands before their first
 * Thursday sale. Without that, every streak would collapse to 0 or 1 for the
 * first sale of any day — which is precisely when this runs.
 */
export function computeStreak(closeDates, now) {
  const days = new Set(closeDates.filter(Boolean).map(utcDay));
  if (!days.size) return 0;

  const today = utcDay(now);
  const shift = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  let cursor = days.has(today) ? today : shift(today, -1);
  if (!days.has(cursor)) return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shift(cursor, -1);
  }
  return streak;
}

/**
 * Dense rank of `key` by descending volume. Returns { rank, field } where field
 * is the number of reps with at least one sale in the window.
 */
function rankByVolume(volumeByKey, key) {
  const field = volumeByKey.size;
  if (!volumeByKey.has(key)) return { rank: null, field };
  const mine = volumeByKey.get(key);
  let ahead = 0;
  for (const [k, v] of volumeByKey) {
    if (k !== key && v > mine) ahead += 1;
  }
  return { rank: ahead + 1, field };
}

async function withBudget(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timedOut: true }), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the celebration facts for one sale.
 *
 * Returns either { degraded: true, reason } or a facts object. Every numeric
 * field may be null — the rulebook is written to drop anything absent rather
 * than guess, and "nothing positive beyond the sale" is an allowed outcome.
 */
export async function buildRepFacts(repDisplayName, saleAmount, deps = {}) {
  const {
    supabase = supabaseDefault,
    now = () => new Date(),
    logger = console,
    budgetMs = FACTS_BUDGET_MS,
  } = deps;

  const wantedKey = repNameKey(repDisplayName);
  if (!wantedKey) return { degraded: true, reason: 'no_rep_name' };

  const amount = Number(saleAmount);
  const thisSale = Number.isFinite(amount) && amount > 0 ? amount : 0;

  const at = now();
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  const bail = (reason) => {
    logger.warn?.(`[SaleAnnounce] facts degraded (${reason}) rep="${repDisplayName}"`);
    return { degraded: true, reason };
  };

  // ─── Read 1: this month's closed-won rows, all reps ─────────────
  // One read serves the team total, the field size, both ranks and this rep's
  // own month. ~370-430 sales/month across ~66 reps (measured 2026-09-16), so
  // this is a few hundred narrow rows.
  const mtd = await withBudget(
    supabase
      .from('lp_leads')
      .select('rep_name, job_value, close_date')
      .eq('closed_won', true)
      .not('rep_name', 'is', null)
      .gte('close_date', monthStart(at))
      .limit(MTD_ROW_LIMIT),
    remaining(),
  );
  if (mtd?.__timedOut) return bail('mtd_timeout');
  if (mtd?.error) return bail(`mtd_failed:${mtd.error.message}`);

  const rows = Array.isArray(mtd.data) ? mtd.data : [];

  // Truncation would make every rank below silently wrong. Degrade instead.
  if (rows.length >= MTD_ROW_LIMIT) return bail(`mtd_truncated_at_${MTD_ROW_LIMIT}`);

  const volumeByKey = new Map();
  const countByKey = new Map();
  const canonicalByKey = new Map();
  let teamVolume = 0;

  for (const r of rows) {
    const key = repNameKey(r.rep_name);
    if (!key) continue;
    const v = Number(r.job_value) || 0;
    volumeByKey.set(key, (volumeByKey.get(key) || 0) + v);
    countByKey.set(key, (countByKey.get(key) || 0) + 1);
    if (!canonicalByKey.has(key)) canonicalByKey.set(key, r.rep_name);
    teamVolume += v;
  }

  const mtdCount = countByKey.get(wantedKey) || 0;
  const mtdVolume = volumeByKey.get(wantedKey) || 0;

  const after = rankByVolume(volumeByKey, wantedKey);

  // rank_before: the same field with this sale removed from this rep's volume.
  // A rep whose only sale this month IS this one has no "before" rank at all —
  // null, not last place. The rulebook may never frame a rep as last.
  let rankBefore = null;
  if (after.rank != null && mtdCount > 1) {
    const before = new Map(volumeByKey);
    before.set(wantedKey, Math.max(0, mtdVolume - thisSale));
    rankBefore = rankByVolume(before, wantedKey).rank;
  }

  // ─── Read 2: this rep's trailing 12 months ──────────────────────
  // Scoped by the CANONICAL LP name so the filter can run in the database.
  // Absent from this month's rows means this is their first sale of the month —
  // fall back to the display name, which matches when LP and GHL happen to
  // agree, and simply returns nothing when they do not.
  const canonical = canonicalByKey.get(wantedKey) || null;
  let largestInYear = null;
  let isPersonalRecord = null;
  let streak = null;

  if (remaining() > 0) {
    const hist = await withBudget(
      supabase
        .from('lp_leads')
        .select('job_value, close_date')
        .eq('closed_won', true)
        .eq('rep_name', canonical ?? String(repDisplayName))
        .gte('close_date', trailingYearStart(at))
        .limit(HISTORY_ROW_LIMIT),
      remaining(),
    );
    if (hist?.__timedOut) {
      logger.warn?.(`[SaleAnnounce] history read timed out rep="${repDisplayName}" — month facts kept`);
    } else if (hist?.error) {
      logger.warn?.(`[SaleAnnounce] history read failed rep="${repDisplayName}": ${hist.error.message}`);
    } else {
      const hrows = Array.isArray(hist.data) ? hist.data : [];
      const values = hrows.map((r) => Number(r.job_value) || 0).filter((v) => v > 0);
      if (values.length) largestInYear = Math.max(...values);
      // >= and not >, because of the ordering contract: the caller already
      // wrote this sale's close_date, so this sale is itself inside `values`
      // and largestInYear already accounts for it. "Nothing in the trailing
      // year beats it" is therefore thisSale >= largestInYear. A sale that
      // exactly equals an earlier one reads as equalling the record, which is
      // the generous reading and the right one for a celebration.
      if (thisSale > 0 && largestInYear != null) isPersonalRecord = thisSale >= largestInYear;
      streak = computeStreak(hrows.map((r) => r.close_date), at);
    }
  }

  const rankClimb =
    rankBefore != null && after.rank != null && after.rank < rankBefore
      ? { from: rankBefore, to: after.rank }
      : null;

  return {
    degraded: false,
    rep_lp_name: canonical,
    sale_amount: thisSale || null,
    mtd_sale_count: mtdCount || null,
    mtd_volume: mtdVolume || null,
    rank: after.rank,
    rank_field: after.field || null,
    rank_before: rankBefore,
    rank_climb: rankClimb,
    is_personal_record: isPersonalRecord,
    largest_in_trailing_year: largestInYear,
    streak_days: streak,
    notable_streak: streak != null && streak >= NOTABLE_STREAK_DAYS,
    team_mtd_volume: teamVolume || null,
  };
}

/**
 * Does this facts object contain anything the MILESTONE structure can open on?
 * Exported because the rulebook gates Structure F on exactly this, and the
 * gate belongs in code where it is testable rather than in the prompt.
 */
export function hasMilestone(facts) {
  if (!facts || facts.degraded) return false;
  return Boolean(facts.rank_climb || facts.is_personal_record || facts.notable_streak);
}
