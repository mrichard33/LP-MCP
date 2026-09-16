/**
 * Slack Notification Mirror — src/slack.js
 *
 * Every card LP-MCP sends to GroupMe is mirrored here, byte-identical, so the
 * two systems stay in lockstep during the GroupMe → Slack migration. The
 * mirror sits below the card builders on purpose: there is no second copy of
 * any message format to keep in sync.
 *
 * FAIL-SILENT BY DESIGN. A Slack outage, a bad token or a missing channel must
 * never delay or fail a GroupMe send — GroupMe is still the system of record
 * until Mark cuts over. Every failure logs and returns.
 *
 * Channel map (logical → Slack):
 *   main    → SLACK_CHANNEL_MAIN     (#lead-intelligence)
 *   canvass → market channel from slack_channels (when opts.market is given)
 *             PLUS SLACK_CHANNEL_CANVASS (#canvass-all)
 *   sales   → market channel from slack_channels (when opts.market is given)
 *             PLUS SLACK_CHANNEL_SALES (#sales-all)
 *   ops     → SLACK_CHANNEL_OPS      (#ops-alerts)
 *   unknown → main (mirrors _resolveBotId's fallback exactly)
 *
 * opts.market is the LP market code (FTMYR, JAX, …), case-insensitive. Codes
 * with no channel of their own map through MARKET_ALIASES first.
 */
import supabase from './supabase.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const MIRROR_ENABLED = String(process.env.SLACK_MIRROR_ENABLED || 'false') === 'true';
const CH_MAIN = process.env.SLACK_CHANNEL_MAIN || '';
const CH_CANVASS = process.env.SLACK_CHANNEL_CANVASS || '';
const CH_SALES = process.env.SLACK_CHANNEL_SALES || '';
const CH_OPS = process.env.SLACK_CHANNEL_OPS || '';

// Codes with no Slack channel of their own. Boca and Miami are worked out of
// the Fort Lauderdale office and post to its channels.
const MARKET_ALIASES = { BOCA: 'FTLAU', MIAMI: 'FTLAU' };

// Logical channel -> the slack_channels name prefix its market channels use,
// and the env var holding its all-markets rollup. Adding a market-scoped
// channel family is a row here, not a new branch below.
const MARKET_FAMILIES = {
  canvass: { prefix: 'canvass', rollup: () => CH_CANVASS },
  sales: { prefix: 'sales', rollup: () => CH_SALES },
};

const CACHE_TTL_MS = 10 * 60 * 1000;
let channelCache = null;      // Map channel_name -> slack_channel_id
let slugCache = null;         // Map UPPER(market_code) -> slug
let cacheLoadedAt = 0;
let warnedNoToken = false;

// Test seam, same rationale as groupme.js's __setDedupClientForTests: the
// channel cache reads the module-level supabase singleton, and the mirror is
// reached from ~40 emitters with no injection point. null = production client.
let _clientOverride = null;

/** TESTS ONLY — point the channel cache at a stub client. */
export function __setSlackClientForTests(client) {
  _clientOverride = client;
}

function _client() {
  return _clientOverride || supabase;
}

console.log(`[Slack] mirror enabled=${MIRROR_ENABLED} token=${SLACK_BOT_TOKEN ? 'set' : 'unset'} main=${CH_MAIN || '-'} canvass=${CH_CANVASS || '-'} sales=${CH_SALES || '-'} ops=${CH_OPS || '-'}`);

function _normKey(v) {
  return String(v || '').trim().toUpperCase();
}

/**
 * Load slack_channels + slack_market_slugs into memory. Refreshed on a TTL so
 * a new market does not need a redeploy. Failure leaves the previous cache in
 * place — a stale map is strictly better than dropping the mirror.
 */
async function _loadCache() {
  if (channelCache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return;
  const db = _client();
  if (!db) {
    console.warn('[Slack] no supabase client — market channel resolution unavailable');
    return;
  }
  try {
    const [{ data: chans }, { data: slugs }] = await Promise.all([
      db.from('slack_channels').select('channel_name, slack_channel_id'),
      db.from('slack_market_slugs').select('market_code, slug'),
    ]);
    if (chans?.length) {
      channelCache = new Map(chans.map((r) => [r.channel_name, r.slack_channel_id]));
      slugCache = new Map((slugs || []).map((r) => [_normKey(r.market_code), r.slug]));
      cacheLoadedAt = Date.now();
      console.log(`[Slack] channel cache loaded: ${channelCache.size} channels, ${slugCache.size} markets`);
    }
  } catch (err) {
    console.warn(`[Slack] channel cache load failed (using previous): ${err.message}`);
  }
}

/**
 * Which Slack channel ids does this card go to?
 *
 * A market-scoped card (canvass or sales) with a market goes to BOTH that
 * market's channel and the all-markets rollup — the market team needs it, and
 * leadership watches one feed instead of seven. With no market, or a market
 * that has no channel, it still reaches the rollup rather than vanishing.
 *
 * @returns {Promise<string[]>} zero or more channel ids
 */
export async function resolveSlackChannels(channel, opts = {}) {
  const chan = channel || 'main';
  const family = MARKET_FAMILIES[chan];
  if (family) {
    const out = [];
    if (opts.market) {
      await _loadCache();
      const code = MARKET_ALIASES[_normKey(opts.market)] || _normKey(opts.market);
      const slug = slugCache?.get(code);
      const id = slug && channelCache?.get(`${family.prefix}-${slug}`);
      if (id) out.push(id);
      else console.warn(`[Slack] no ${family.prefix} channel for market=${opts.market} — rollup only`);
    }
    const rollup = family.rollup();
    if (rollup && !out.includes(rollup)) out.push(rollup);
    return out;
  }
  if (chan === 'ops') return CH_OPS ? [CH_OPS] : [];
  return CH_MAIN ? [CH_MAIN] : [];
}

/**
 * Mirror one card. Never throws, never blocks the caller's GroupMe send.
 */
export async function mirrorToSlack(text, channel, opts = {}) {
  if (!MIRROR_ENABLED || !text) return { mirrored: false, reason: 'disabled' };
  if (!SLACK_BOT_TOKEN) {
    if (!warnedNoToken) {
      console.warn('[Slack] SLACK_BOT_TOKEN unset — mirror is a no-op');
      warnedNoToken = true;
    }
    return { mirrored: false, reason: 'no_token' };
  }
  let ids = [];
  try {
    ids = await resolveSlackChannels(channel, opts);
  } catch (err) {
    console.warn(`[Slack] channel resolve failed: ${err.message}`);
    return { mirrored: false, reason: 'resolve_failed' };
  }
  if (!ids.length) return { mirrored: false, reason: 'no_channel' };

  let ok = 0;
  for (const id of ids) {
    const res = await postToSlack(text, id);
    if (res.ok) ok++;
    else console.warn(`[Slack] post to ${id} failed: ${res.error}`);
  }
  return { mirrored: ok > 0, channels: ids.length, sent: ok };
}

/**
 * Post ONE message to ONE resolved channel id and return Slack's message ts.
 *
 * Added 2026-09-16 for the sale-announcement endpoint, which has to store the
 * ts and channel on its row so a post can be traced, edited or threaded later.
 * mirrorToSlack cannot serve that: it fans out to several channels and reduces
 * the whole thing to a count, discarding every ts.
 *
 * mirrorToSlack was refactored onto this function rather than a third copy of
 * chat.postMessage being written, because there must be exactly one place that
 * knows how this repo talks to Slack.
 *
 * TWO DELIBERATE DIFFERENCES FROM mirrorToSlack:
 *   - It does NOT check SLACK_MIRROR_ENABLED. That flag gates the GroupMe
 *     MIRROR during the migration. This function is also used for posts where
 *     Slack is the PRIMARY destination, and gating those on a mirror flag would
 *     make "Slack is the system of record" depend on a migration switch.
 *   - It reports failure instead of swallowing it, so a caller that must know
 *     (retry, mark the row slack_failed, raise an ops alert) can. It still never
 *     throws.
 */
export async function postToSlack(text, channelId) {
  if (!text) return { ok: false, ts: null, channel: channelId || null, error: 'no_text' };
  if (!channelId) return { ok: false, ts: null, channel: null, error: 'no_channel' };
  if (!SLACK_BOT_TOKEN) {
    if (!warnedNoToken) {
      console.warn('[Slack] SLACK_BOT_TOKEN unset — post is a no-op');
      warnedNoToken = true;
    }
    return { ok: false, ts: null, channel: channelId, error: 'no_token' };
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: channelId, text: String(text) }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (body?.ok) {
      return { ok: true, ts: body.ts || null, channel: body.channel || channelId, error: null };
    }
    return {
      ok: false,
      ts: null,
      channel: channelId,
      error: String(body?.error || res.status),
    };
  } catch (err) {
    return { ok: false, ts: null, channel: channelId, error: err.message };
  }
}

/** The #sales-all rollup channel id, or '' when unset. */
export function salesRollupChannelId() {
  return CH_SALES;
}

/** The #ops-alerts channel id, or '' when unset. */
export function opsChannelId() {
  return CH_OPS;
}

/** TESTS ONLY — reset the cache between cases. */
export function __resetSlackCacheForTests() {
  channelCache = null; slugCache = null; cacheLoadedAt = 0; warnedNoToken = false;
}
