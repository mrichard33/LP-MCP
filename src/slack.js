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
 *   ops     → SLACK_CHANNEL_OPS      (#ops-alerts)
 *   unknown → main (mirrors _resolveBotId's fallback exactly)
 *
 * opts.market accepts EITHER the LP market code (FTMYR) or the display name
 * service_markets carries for it ("Ft. Myers / SW Florida"). The canvassing
 * handler resolves the market once per run via resolveMarket(), which returns
 * the display name — so the mirror must not assume it is handed a code.
 */
import supabase from './supabase.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const MIRROR_ENABLED = String(process.env.SLACK_MIRROR_ENABLED || 'false') === 'true';
const CH_MAIN = process.env.SLACK_CHANNEL_MAIN || '';
const CH_CANVASS = process.env.SLACK_CHANNEL_CANVASS || '';
const CH_OPS = process.env.SLACK_CHANNEL_OPS || '';

const CACHE_TTL_MS = 10 * 60 * 1000;
let channelCache = null;      // Map channel_name -> slack_channel_id
let slugCache = null;         // Map UPPER(market_code) | UPPER(market_name) -> slug
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

console.log(`[Slack] mirror enabled=${MIRROR_ENABLED} token=${SLACK_BOT_TOKEN ? 'set' : 'unset'} main=${CH_MAIN || '-'} canvass=${CH_CANVASS || '-'} ops=${CH_OPS || '-'}`);

function _normKey(v) {
  return String(v || '').trim().toUpperCase();
}

/**
 * Load slack_channels + slack_market_slugs (+ service_markets, so a display
 * name resolves to the same slug its code does) into memory. Refreshed on a
 * TTL so a new market does not need a redeploy. Failure leaves the previous
 * cache in place — a stale map is strictly better than dropping the mirror.
 */
async function _loadCache() {
  if (channelCache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return;
  const db = _client();
  if (!db) {
    console.warn('[Slack] no supabase client — market channel resolution unavailable');
    return;
  }
  try {
    const [{ data: chans }, { data: slugs }, { data: markets }] = await Promise.all([
      db.from('slack_channels').select('channel_name, slack_channel_id'),
      db.from('slack_market_slugs').select('market_code, slug'),
      db.from('service_markets').select('market_code, market_name'),
    ]);
    if (chans?.length) {
      channelCache = new Map(chans.map((r) => [r.channel_name, r.slack_channel_id]));
      const byCode = new Map((slugs || []).map((r) => [_normKey(r.market_code), r.slug]));
      slugCache = new Map(byCode);
      for (const m of markets || []) {
        const slug = byCode.get(_normKey(m.market_code));
        if (slug && m.market_name) slugCache.set(_normKey(m.market_name), slug);
      }
      cacheLoadedAt = Date.now();
      console.log(`[Slack] channel cache loaded: ${channelCache.size} channels, ${byCode.size} markets`);
    }
  } catch (err) {
    console.warn(`[Slack] channel cache load failed (using previous): ${err.message}`);
  }
}

/**
 * Which Slack channel ids does this card go to?
 *
 * A canvass card with a market goes to BOTH the market channel and the
 * all-markets rollup — the market team needs it, and leadership watches one
 * feed instead of seven.
 *
 * @returns {Promise<string[]>} zero or more channel ids
 */
export async function resolveSlackChannels(channel, opts = {}) {
  const chan = channel || 'main';
  if (chan === 'canvass') {
    const out = [];
    if (opts.market) {
      await _loadCache();
      const slug = slugCache?.get(_normKey(opts.market));
      const id = slug && channelCache?.get(`canvass-${slug}`);
      if (id) out.push(id);
      else console.warn(`[Slack] no canvass channel for market=${opts.market} — rollup only`);
    }
    if (CH_CANVASS && !out.includes(CH_CANVASS)) out.push(CH_CANVASS);
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
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({ channel: id, text: String(text) }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json().catch(() => ({}));
      if (body?.ok) ok++;
      else console.warn(`[Slack] post to ${id} failed: ${body?.error || res.status}`);
    } catch (err) {
      console.warn(`[Slack] post to ${id} threw: ${err.message}`);
    }
  }
  return { mirrored: ok > 0, channels: ids.length, sent: ok };
}

/** TESTS ONLY — reset the cache between cases. */
export function __resetSlackCacheForTests() {
  channelCache = null; slugCache = null; cacheLoadedAt = 0; warnedNoToken = false;
}
