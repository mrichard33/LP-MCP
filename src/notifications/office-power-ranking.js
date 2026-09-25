/**
 * The OFFICE-vs-OFFICE power ranking — src/notifications/office-power-ranking.js
 *
 * ONE question: which office is winning right now?
 *
 * Not to be confused with office-ranking.js, which ranks the REPS INSIDE one
 * office and posts to that office's market channel when someone sells. This
 * one ranks the offices AGAINST EACH OTHER and posts once a day to the
 * all-markets sales rollup. Same tie rules and the same office mapping; a
 * different question.
 *
 * ─── WHY THE WINDOW IS NOT ONE DAY (2026-09-24) ─────────────────────────────
 * The ask was "rank each office daily". Measured on the only day-accurate
 * sales we have (the 77 announced between 09-17 and 09-24), a single day does
 * not carry a ranking:
 *
 *   09-20  SAR 2 · FTMYR 1 · STPET 1        — five offices sold nothing
 *   09-17  STPET 3 · FTMYR 2 · ORL 1        — five offices sold nothing
 *
 * The busiest office averages 2.8 sales a day and the quietest three average
 * 0.1-0.2. On a typical day three to five of the eight active offices sit at
 * $0, and the order among the rest turns on whether one big ticket happened to
 * land. A board like that reshuffles on noise, and a board that reshuffles on
 * noise stops being read.
 *
 * So the POST is daily — the cadence that was asked for, and the one that keeps
 * it front-of-mind — and the NUMBER behind it is a rolling window, default 7
 * days. Rank movement then means something. OFFICE_POWER_RANKING_WINDOW_DAYS=1
 * gives the literal one-day board for anyone who wants it.
 *
 * ─── WHY close_date_source IS FILTERED ──────────────────────────────────────
 * `close_date` is not all one thing (CLAUDE.md). 24,851 rows carry
 * `appointment_proxy`, backfilled from `appointment_date` — the right MONTH,
 * not the right DAY. Including those in a 7-day window would pull in sales
 * that closed somewhere else entirely in the month and silently inflate
 * whichever office happens to have old appointments in range.
 *
 * Only day-accurate sources count here. That is `sale_announcement` (written
 * when the sale was announced) and `lp` (reserved; nothing writes it until LP
 * exposes a real close date). The cost is that the board reflects ANNOUNCED
 * sales — which, measured, is effectively all of them: 11 a day announced
 * against ~10.6 a day of total close-dated volume across the top five offices.
 *
 * ─── EVERY OFFICE IS NAMED, INCLUDING LAST ──────────────────────────────────
 * This is a public league table, so someone is bottom every day. That is the
 * point of a power ranking and it was asked for knowingly — but it is also
 * exactly the shape `isCelebratableClimb` exists to guard against on the rep
 * side, where a real 50 → 41 climb could not be stated without announcing the
 * rep had been dead last. The rule that follows from that incident applies
 * here too: report the STANDING, never editorialise the bottom. No "still
 * searching for their first", no wooden spoon. The number says it.
 *
 * An office with no day-accurate sale in the window is listed at $0 rather
 * than dropped: an office that is absent reads as a bug, and a zero is the
 * honest answer. Offices with no sales at ALL in the trailing 30 days are left
 * out — that is a closed or not-yet-open branch, not a losing one.
 *
 * ─── MONTH TO DATE IS NOW THE DEFAULT (2026-09-25) ──────────────────────────
 * The sales floor asked for the board to show the 1st through today, every
 * day, and to reset for every office on the 1st. That is a different question
 * from "who is hot this week", so it is a second MODE rather than a new job:
 *
 *   OFFICE_POWER_RANKING_WINDOW=mtd      (default) the Florida calendar month
 *                                        to date, all seven offices, movement
 *                                        against the same board 24h earlier
 *   OFFICE_POWER_RANKING_WINDOW=rolling  the 7-day board described above
 *
 * The day-accuracy argument above does NOT apply to a month window:
 * `appointment_proxy` is exactly "the right MONTH", so month-to-date counts
 * every closed-won sale in the month — and a won lead with no close_date at
 * all counts by its appointment_date (wonInWindowFilter in sale-facts.js).
 * Seventeen September sales ($629,748) were invisible without that. The window
 * is monthWindowET, the same one the per-sale boards use, so the daily post,
 * the #sales-all reply and the office channels always agree and reset together
 * at midnight on the 1st, Florida time.
 */

import supabaseDefault from '../supabase.js';
import { officeMarketCode } from '../slack.js';
import { branchName, BRANCH_NAMES } from '../approval-card.js';
import { monthWindowET, wonInWindowFilter } from './sale-facts.js';
import { allOffices, rangeLabel } from './office-ranking.js';

export const POWER_RANKING_BUDGET_MS = 5000;

/** Rows to read before we call the window untrustworthy rather than publish it. */
export const POWER_RANKING_ROW_LIMIT = 5000;

/**
 * close_date values trustworthy to the DAY. `appointment_proxy` is deliberately
 * absent — see the header. Keep this in step with CLAUDE.md's table.
 */
export const DAY_ACCURATE_CLOSE_SOURCES = Object.freeze(['sale_announcement', 'lp']);

/** Default rolling window. Env override: OFFICE_POWER_RANKING_WINDOW_DAYS. */
export const DEFAULT_WINDOW_DAYS = 7;

/** 'mtd' (default) or 'rolling'. See the header. */
export function windowMode() {
  return String(process.env.OFFICE_POWER_RANKING_WINDOW || 'mtd').toLowerCase() === 'rolling' ? 'rolling' : 'mtd';
}

export function windowDays() {
  const n = parseInt(process.env.OFFICE_POWER_RANKING_WINDOW_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_DAYS;
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** ISO instant `days` before `from`. */
export function daysBefore(from, days) {
  return new Date(new Date(from).getTime() - days * 86400000).toISOString();
}

/**
 * Pure: sales rows → the ranked league table.
 *
 * `rows` are { lp_branch_id, job_value }. Branch codes are folded to their
 * OFFICE via officeMarketCode, so BOCA and MIAMI volume lands on Fort
 * Lauderdale exactly as the channel routing already treats them — one office,
 * one line.
 *
 * `eligible` is the set of office codes that should appear even at zero (see
 * the header). Omit it and only offices with sales are listed.
 *
 * Sorted by volume, then sale count, then name, so the order is stable across
 * runs. Ties on volume share a rank (1, 2, 2, 4), matching rankOffice().
 */
export function rankOffices(rows, eligible = null) {
  const byOffice = new Map();

  const ensure = (office) => {
    if (!office) return null;
    let cur = byOffice.get(office);
    if (!cur) {
      cur = { office, name: branchName(office) || office, volume: 0, count: 0 };
      byOffice.set(office, cur);
    }
    return cur;
  };

  for (const code of eligible || []) ensure(officeMarketCode(code));

  for (const r of rows || []) {
    const cur = ensure(officeMarketCode(r?.lp_branch_id));
    if (!cur) continue;
    cur.volume += Number(r.job_value) || 0;
    cur.count += 1;
  }

  const list = [...byOffice.values()].sort(
    (a, b) => b.volume - a.volume || b.count - a.count || a.name.localeCompare(b.name),
  );
  let prevVolume = null;
  let prevRank = 0;
  list.forEach((row, i) => {
    row.rank = row.volume === prevVolume ? prevRank : i + 1;
    prevVolume = row.volume;
    prevRank = row.rank;
  });
  return list;
}

/**
 * Pure: annotate `current` with movement against `previous`.
 *
 * `move` is positive for a climb, negative for a fall, 0 for held, and null
 * when the office was not in the previous board at all — which is NOT the same
 * as "held", and printing it as a hold would invent a history it never had.
 */
export function withMovement(current, previous) {
  const was = new Map((previous || []).map((r) => [r.office, r.rank]));
  return (current || []).map((r) => ({
    ...r,
    move: was.has(r.office) ? was.get(r.office) - r.rank : null,
  }));
}

/** ▲2 / ▼1 / — / '' — the movement marker for one row. */
function moveMark(move) {
  if (move === null || move === undefined) return '';
  if (move > 0) return ` ▲${move}`;
  if (move < 0) return ` ▼${Math.abs(move)}`;
  return ' —';
}

/**
 * Pure: the Slack post. Returns null when there is nothing worth posting, so
 * the caller can stay silent rather than publish an empty board.
 *
 *   🏆 Office power ranking — last 7 days
 *   1. Ft. Myers / SW Florida — $312,400 (14) ▲1
 *   2. Orlando — $298,100 (12) ▼1
 *   3. Jacksonville — $0 (0) —
 *   Across all offices: $610,500 · 26 sales
 */
export function formatOfficePowerRanking({ ranking = null, now = new Date(), days = DEFAULT_WINDOW_DAYS } = {}) {
  if (!ranking || ranking.degraded) return null;
  const rows = ranking.rows || [];
  if (!rows.length) return null;

  // Every office at zero is not a board, it is an outage or a quiet holiday.
  // Either way there is no ranking in it, so say nothing.
  const totalCount = rows.reduce((t, r) => t + r.count, 0);
  if (totalCount === 0) return null;

  let title;
  if (ranking.mode === 'mtd') {
    title = ranking.window?.complete
      ? `🏁 ${ranking.window.monthName} final standings`
      : `🏆 Office power ranking — ${rangeLabel(ranking.window)}`;
  } else {
    title = `🏆 Office power ranking — ${days === 1 ? 'today' : `last ${days} days`}`;
  }
  const lines = [title];
  for (const r of rows) {
    lines.push(`${r.rank}. ${r.name} — ${money(r.volume)} (${r.count})${moveMark(r.move)}`);
  }
  const totalVolume = rows.reduce((t, r) => t + r.volume, 0);
  const noun = totalCount === 1 ? 'sale' : 'sales';
  lines.push(`Across all offices: ${money(totalVolume)} · ${totalCount} ${noun}`);
  return lines.join('\n');
}

/**
 * One windowed read of day-accurate closed-won sales.
 * Returns { ok: true, data } or { ok: false, reason }. Never throws.
 */
async function readWindow({ supabase, sinceIso, untilIso, budgetMs, monthMode = false }) {
  let res;
  let timer;
  try {
    const base = supabase
      .from('lp_leads')
      .select('lp_branch_id, job_value')
      .eq('closed_won', true);
    // Month mode counts every won sale in the window, proxy dates and no-date
    // leads included; rolling mode keeps to day-accurate sources (header).
    const query = monthMode
      ? base.or(wonInWindowFilter(sinceIso, untilIso))
      : base
        .in('close_date_source', DAY_ACCURATE_CLOSE_SOURCES)
        .gte('close_date', sinceIso)
        .lt('close_date', untilIso);
    res = await Promise.race([
      query.limit(POWER_RANKING_ROW_LIMIT),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true }), budgetMs); }),
    ]);
  } catch (err) {
    return { ok: false, reason: `threw:${err.message}` };
  } finally {
    clearTimeout(timer);
  }
  if (res?.__timedOut) return { ok: false, reason: 'timeout' };
  if (res?.error) return { ok: false, reason: `read_failed:${res.error.message}` };
  const data = Array.isArray(res?.data) ? res.data : [];
  // A truncated read would publish a confidently wrong league table to every
  // office at once. Degrade instead — same rule as buildOfficeRanking.
  if (data.length >= POWER_RANKING_ROW_LIMIT) return { ok: false, reason: `truncated_at_${POWER_RANKING_ROW_LIMIT}` };
  return { ok: true, data };
}

/**
 * Build the league table: the current window, ranked, with movement against
 * the window immediately before it.
 *
 * Movement is derived from a second read rather than a stored snapshot on
 * purpose — a table of yesterday's ranks is a thing to maintain, migrate and
 * get wrong, and two bounded reads answer the same question from the sales
 * themselves.
 *
 * Returns { degraded: false, rows, days, ... } or { degraded: true, reason }.
 * Never throws.
 */
export async function buildOfficePowerRanking(deps = {}) {
  const mode = deps.mode || windowMode();
  if (mode === 'mtd') return buildMonthToDate(deps);

  const {
    supabase = supabaseDefault,
    now = () => new Date(),
    logger = console,
    budgetMs = POWER_RANKING_BUDGET_MS,
    days = windowDays(),
  } = deps;

  const bail = (reason) => {
    logger.warn?.(`[OfficePowerRanking] degraded (${reason})`);
    return { degraded: true, reason };
  };

  const nowIso = new Date(now()).toISOString();
  const currentSince = daysBefore(nowIso, days);
  const previousSince = daysBefore(nowIso, days * 2);

  const current = await readWindow({ supabase, sinceIso: currentSince, untilIso: nowIso, budgetMs });
  if (!current.ok) return bail(current.reason);

  // Which offices belong on the board at all: anything that has sold in the
  // trailing 30 days. A branch with nothing in a month is closed or not yet
  // open, not losing, and listing it at $0 every day would be noise.
  const roster = await readWindow({
    supabase, sinceIso: daysBefore(nowIso, 30), untilIso: nowIso, budgetMs,
  });
  const eligible = roster.ok
    ? [...new Set(roster.data.map((r) => r.lp_branch_id).filter(Boolean))]
    : null;   // unreadable roster → rank only what sold; never block the post

  const previous = await readWindow({
    supabase, sinceIso: previousSince, untilIso: currentSince, budgetMs,
  });

  const currentRows = rankOffices(current.data, eligible);
  // A failed previous read costs the arrows, not the board.
  const rows = previous.ok
    ? withMovement(currentRows, rankOffices(previous.data, eligible))
    : currentRows.map((r) => ({ ...r, move: null }));

  return {
    degraded: false,
    days,
    rows,
    totalVolume: rows.reduce((t, r) => t + r.volume, 0),
    totalCount: rows.reduce((t, r) => t + r.count, 0),
    movementAvailable: previous.ok,
  };
}

/**
 * The month-to-date board: every office, the Florida calendar month from the
 * 1st to now (or the whole month, for a closed `window` — the final standings
 * posted on the 1st), with movement against the same board 24 hours earlier.
 *
 * Offices are the seven named offices (allOffices), always listed, $0
 * included. A sale on a branch code nobody can name is left off rather than
 * shown under a raw code.
 *
 * Returns { degraded: false, mode: 'mtd', window, rows, ... } or
 * { degraded: true, reason }. Never throws.
 */
export async function buildMonthToDate(deps = {}) {
  const {
    supabase = supabaseDefault,
    now = () => new Date(),
    logger = console,
    budgetMs = POWER_RANKING_BUDGET_MS,
  } = deps;
  const at = new Date(now());
  const win = deps.window || monthWindowET(at);

  const bail = (reason) => {
    logger.warn?.(`[OfficePowerRanking] month-to-date degraded (${reason})`);
    return { degraded: true, reason };
  };

  const named = (rows) => rows.filter((r) => BRANCH_NAMES[officeMarketCode(r?.lp_branch_id)]);
  const untilIso = win.complete ? win.endIso : at.toISOString();

  const current = await readWindow({ supabase, sinceIso: win.startIso, untilIso, budgetMs, monthMode: true });
  if (!current.ok) return bail(current.reason);
  const currentRows = rankOffices(named(current.data), allOffices());

  // Movement since yesterday: the same month's board as it stood 24h ago. Not
  // for a closed month (final standings are the result, not a race), and not
  // when that board was empty — ranking seven offices tied at $0 would print
  // an arrow on every line that means nothing.
  let rows = currentRows.map((r) => ({ ...r, move: null }));
  let movementAvailable = false;
  const dayAgo = new Date(at.getTime() - 86400000).toISOString();
  if (!win.complete && dayAgo > win.startIso) {
    const previous = await readWindow({ supabase, sinceIso: win.startIso, untilIso: dayAgo, budgetMs, monthMode: true });
    if (previous.ok && named(previous.data).length) {
      rows = withMovement(currentRows, rankOffices(named(previous.data), allOffices()));
      movementAvailable = true;
    }
  }

  return {
    degraded: false,
    mode: 'mtd',
    window: win,
    rows,
    totalVolume: rows.reduce((t, r) => t + r.volume, 0),
    totalCount: rows.reduce((t, r) => t + r.count, 0),
    movementAvailable,
  };
}
