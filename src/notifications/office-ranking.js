/**
 * Sale Announcements — the office power ranking
 * src/notifications/office-ranking.js
 *
 * ONE question: this month, how does every rep in THIS office stand?
 *
 * WHY THE MARKET CHANNEL GETS A RANKING AND NOT THE CELEBRATION
 * ------------------------------------------------------------
 * 2026-09-24 (sales-floor request). #sales-all carries the celebration, as before. The
 * market channel is the office floor, and what a floor wants when one of its
 * own sells is the scoreboard: the rep's month line, then every rep in the
 * office ranked by month-to-date volume. Posting the same celebration twice
 * would just be noise in a channel whose members already saw it in #sales-all.
 *
 * WHICH SALES COUNT FOR AN OFFICE
 * -------------------------------
 * A sale belongs to the office its lead's lp_branch_id posts to — the same
 * mapping the channel routing uses (officeMarketCodes in src/slack.js), so a
 * BOCA sale that lands in #sales-fortlauderdale also counts on Fort
 * Lauderdale's board. There is no rep → office roster: a rep who sold in two
 * offices this month appears on both boards with each office's share. That is
 * the honest reading of "the office's month", and it needs no table nobody
 * maintains.
 *
 * Dated on close_date for the same reasons as sale-facts.js, and bounded the
 * same way: a truncated read would publish a confidently wrong board to the
 * whole office, so it degrades instead.
 *
 * FULL BOARD, BY REQUEST
 * ----------------------
 * Every rep with a sale this month is listed, bottom included (requested
 * 2026-09-24). Nobody with zero sales is listed — that would need a roster, and
 * a rep who has not sold is not on a sales board.
 */

import supabaseDefault from '../supabase.js';
import { officeMarketCode, officeMarketCodes } from '../slack.js';
import { branchName } from '../approval-card.js';
import { repNameKey, monthStart, MTD_ROW_LIMIT } from './sale-facts.js';

export const RANKING_BUDGET_MS = 3000;

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function monthName(date) {
  return new Date(date).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

/** LP "Wheeler, Donte" → "Donte Wheeler". Anything without a comma is left as is. */
export function displayRepName(raw) {
  const s = String(raw ?? '').trim();
  if (!s.includes(',')) return s;
  const [last, ...rest] = s.split(',');
  const first = rest.join(',').trim();
  return first ? `${first} ${last.trim()}` : last.trim();
}

/**
 * Pure: rows of { rep_name, job_value } → the ranked board.
 * Sorted by volume, then sale count, then name, so the order is stable.
 * Ties on volume share a rank (1, 2, 2, 4).
 */
export function rankOffice(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const key = repNameKey(r.rep_name);
    if (!key) continue;
    const cur = byKey.get(key) || { key, name: displayRepName(r.rep_name), volume: 0, count: 0 };
    cur.volume += Number(r.job_value) || 0;
    cur.count += 1;
    byKey.set(key, cur);
  }
  const list = [...byKey.values()].sort(
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
 * Read this month's closed-won sales for one office and rank them.
 * Returns { degraded: false, office, officeName, rows, totalVolume, totalCount }
 * or { degraded: true, reason }. Never throws.
 */
export async function buildOfficeRanking(market, deps = {}) {
  const {
    supabase = supabaseDefault,
    now = () => new Date(),
    logger = console,
    budgetMs = RANKING_BUDGET_MS,
  } = deps;

  const office = officeMarketCode(market);
  if (!office) return { degraded: true, reason: 'no_market' };
  const codes = officeMarketCodes(office);

  const bail = (reason) => {
    logger.warn?.(`[SaleAnnounce] office ranking degraded (${reason}) office=${office}`);
    return { degraded: true, reason };
  };

  let res;
  let timer;
  try {
    res = await Promise.race([
      supabase
        .from('lp_leads')
        .select('rep_name, job_value')
        .eq('closed_won', true)
        .not('rep_name', 'is', null)
        .in('lp_branch_id', codes)
        .gte('close_date', monthStart(now()))
        .limit(MTD_ROW_LIMIT),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true }), budgetMs); }),
    ]);
  } catch (err) {
    return bail(`threw:${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res?.__timedOut) return bail('timeout');
  if (res?.error) return bail(`read_failed:${res.error.message}`);

  const data = Array.isArray(res?.data) ? res.data : [];
  if (data.length >= MTD_ROW_LIMIT) return bail(`truncated_at_${MTD_ROW_LIMIT}`);

  const rows = rankOffice(data);
  return {
    degraded: false,
    office,
    officeName: branchName(office) || office,
    rows,
    totalVolume: rows.reduce((t, r) => t + r.volume, 0),
    totalCount: rows.reduce((t, r) => t + r.count, 0),
  };
}

/**
 * Pure: the market-channel post. `repLine` (the rep's month) and the ranking
 * are each optional; returns null when there is nothing to say.
 *
 *   📊 Donte Wheeler — 7 sales in September, $185,801.
 *
 *   🏆 Jacksonville — September power ranking
 *   1. Donte Wheeler — $185,801 (7)  ← today
 *   2. Beverly Dorsett — $107,297 (5)
 *   Office total: $292,098 · 12 sales
 */
export function formatOfficeRanking({ repLine = null, ranking = null, repDisplayName = null, now = new Date() } = {}) {
  const parts = [];
  if (repLine) parts.push(repLine);

  if (ranking && !ranking.degraded && ranking.rows?.length) {
    const today = repNameKey(repDisplayName);
    const lines = [`🏆 ${ranking.officeName} — ${monthName(now)} power ranking`];
    for (const r of ranking.rows) {
      lines.push(
        `${r.rank}. ${r.name} — ${money(r.volume)} (${r.count})` + (today && r.key === today ? '  ← today' : ''),
      );
    }
    const noun = ranking.totalCount === 1 ? 'sale' : 'sales';
    lines.push(`Office total: ${money(ranking.totalVolume)} · ${ranking.totalCount} ${noun}`);
    parts.push(lines.join('\n'));
  }

  return parts.length ? parts.join('\n\n') : null;
}
