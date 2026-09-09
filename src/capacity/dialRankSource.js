// ─── Live Five9 dial rank — src/capacity/dialRankSource.js ──────────────────
//
// Reads the LIVE list order on "Data - Hot Leads less than 7" and returns
// market_code → rank 1..7 (1 dials first). This is what the TV board's corner
// badge prints, so it must reflect Five9 itself — including a reorder a human
// made in the admin UI, which dial_priority_log would never see.
//
// DENSE-RANKED, not raw. Five9's dialingPriority can have gaps, and the
// non-market "Data - Hot - Unmapped" list sits at the end. Only the 7 market
// lists are ranked, sorted by their raw priority, and numbered 1..7 — so a card
// can never print an 8.
//
// FAILS OPEN. A Five9 error returns the last good ranks (or {}), never throws.
// The board is a wall display: a missing badge is fine, a blank screen is not.

import { getOutboundCampaign } from '../five9-admin.js';
import { MARKET_LISTS, CAMPAIGNS } from './applyDialPriority.js';

const TTL_MS       = parseInt(process.env.CAPACITY_DIAL_RANK_TTL_MS || '300000', 10);
const ERROR_TTL_MS = parseInt(process.env.CAPACITY_DIAL_RANK_ERROR_TTL_MS || '60000', 10);

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** normalized hot-tier list name → market code. */
const LIST_TO_MARKET = new Map(
  Object.entries(MARKET_LISTS).map(([market, lists]) => [norm(lists.hot), market]),
);

let cache = { ranks: {}, read_at: null, error: null, nextTryAt: 0 };

/** Test seam only. */
export function _resetDialRankCache() {
  cache = { ranks: {}, read_at: null, error: null, nextTryAt: 0 };
}

/**
 * @returns {Promise<{ranks:Object<string,number>, read_at:string|null,
 *                     error:string|null, cached:boolean, campaign:string}>}
 */
export async function getDialRanks({
  now = Date.now(),
  getCampaign = getOutboundCampaign,
  ttlMs = TTL_MS,
  errorTtlMs = ERROR_TTL_MS,
  log = console.log,
} = {}) {
  const shape = (cached) => ({
    ranks: cache.ranks, read_at: cache.read_at, error: cache.error,
    cached, campaign: CAMPAIGNS.hot,
  });

  if (now < cache.nextTryAt) return shape(true);

  try {
    const campaign = await getCampaign(CAMPAIGNS.hot);
    const lists = Array.isArray(campaign?.lists) ? campaign.lists : null;
    if (!lists) throw new Error(`could not read the lists attached to "${CAMPAIGNS.hot}"`);

    const marketLists = lists
      .map((l) => ({
        market: LIST_TO_MARKET.get(norm(l?.name ?? l?.listName)),
        priority: Number(l?.dialingPriority),
      }))
      .filter((l) => l.market && Number.isFinite(l.priority))
      // Ties break on market code so the order is deterministic run to run.
      .sort((a, b) => a.priority - b.priority || a.market.localeCompare(b.market));

    const ranks = {};
    marketLists.forEach((l, i) => { ranks[l.market] = i + 1; });

    cache = {
      ranks,
      read_at: new Date(now).toISOString(),
      error: null,
      nextTryAt: now + ttlMs,
    };
    return shape(false);
  } catch (err) {
    // Keep the last good ranks and back off briefly — never hammer Five9 and
    // never take the board down over a badge.
    cache = { ...cache, error: err.message, nextTryAt: now + errorTtlMs };
    log(`[DialRank] WARN could not read Five9 list order (${err.message}) — serving ${cache.read_at ? 'the last good read' : 'no ranks'}`);
    return shape(false);
  }
}
