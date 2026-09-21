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
 *   sales   → market channel from slack_channels ALONE when one resolves;
 *             SLACK_CHANNEL_SALES (#sales-all) only as the fallback
 *   ops     → SLACK_CHANNEL_OPS      (#ops-alerts)
 *   unknown → main (mirrors _resolveBotId's fallback exactly)
 *
 * opts.market is the LP market code (FTMYR, JAX, …), case-insensitive. Codes
 * with no channel of their own map through MARKET_ALIASES first.
 */
import supabase from './supabase.js';
import { buildApprovalBlocks } from './slack-approvals-core.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const MIRROR_ENABLED = String(process.env.SLACK_MIRROR_ENABLED || 'false') === 'true';
const CH_MAIN = process.env.SLACK_CHANNEL_MAIN || '';
const CH_CANVASS = process.env.SLACK_CHANNEL_CANVASS || '';
const CH_SALES = process.env.SLACK_CHANNEL_SALES || '';
const CH_OPS = process.env.SLACK_CHANNEL_OPS || '';
// 2026-09-21 — #contact-center. Customer service issues found in a missed
// reply route here, not to the sales floor: a screen repair or a warranty
// question is not a lead, and putting it in #sales-<market> buries it.
const CH_SERVICE = process.env.SLACK_CHANNEL_SERVICE || '';
// Slack approval buttons (2026-09-21). Off unless the literal 'true'.
const APPROVALS_ENABLED = String(process.env.SLACK_APPROVALS_ENABLED || 'false') === 'true';
const CH_APPROVALS = process.env.SLACK_CHANNEL_APPROVALS || '';

// Codes with no Slack channel of their own. Boca and Miami are worked out of
// the Fort Lauderdale office and post to its channels.
const MARKET_ALIASES = { BOCA: 'FTLAU', MIAMI: 'FTLAU' };

// Logical channel -> the slack_channels name prefix its market channels use,
// and the env var holding its all-markets rollup. Adding a market-scoped
// channel family is a row here, not a new branch below.
//
// alsoRollup (2026-09-21) — do market cards ALSO go to the all-markets feed?
//   canvass: yes. The market team needs it and leadership watches one feed
//            instead of seven. Unchanged.
//   sales:   NO. A customer issue belongs to one market's floor. In practice
//            #sales-all had become the only place any of them landed, because
//            a poisoned market value resolved no channel and every card fell
//            back to the rollup, so nobody read the market channels at all.
// The divergence is deliberate; do not "tidy" it back into one rule.
//   service: NO, same reasoning as sales — a customer waiting on a service
//            call belongs to the market that installed the job. With no
//            market resolved it falls back to SLACK_CHANNEL_SERVICE, which
//            is the contact-center channel, never #lead-intelligence: an
//            unrouted service issue must still reach someone who handles
//            service.
const MARKET_FAMILIES = {
  canvass: { prefix: 'canvass', rollup: () => CH_CANVASS, alsoRollup: true },
  sales: { prefix: 'sales', rollup: () => CH_SALES, alsoRollup: false },
  service: { prefix: 'service', rollup: () => CH_SERVICE, alsoRollup: false },
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

console.log(`[Slack] mirror enabled=${MIRROR_ENABLED} token=${SLACK_BOT_TOKEN ? 'set' : 'unset'} main=${CH_MAIN || '-'} canvass=${CH_CANVASS || '-'} sales=${CH_SALES || '-'} ops=${CH_OPS || '-'} service=${CH_SERVICE || '-'}`);

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
 * A CANVASS card with a market goes to BOTH that market's channel and the
 * all-markets rollup — the market team needs it, and leadership watches one
 * feed instead of seven.
 *
 * A SALES card with a resolvable market goes to that market's channel ONLY
 * (2026-09-21, alsoRollup: false above). With no market, or a market that has
 * no channel, EITHER family still reaches its rollup rather than vanishing.
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
    // A family that does not rollup keeps ONLY its market channel — but only
    // once one actually resolved. With no market, or a market with no channel,
    // the rollup is still the destination: a card must never have nowhere to
    // go, and the mirror is fail-silent, so a dropped card looks like a quiet
    // night rather than an error.
    if (out.length && family.alsoRollup === false) return out;
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
    // "threw" and "failed" are not the same diagnosis and the log must keep them
    // apart: threw means we never reached Slack (DNS, TLS, reset, timeout),
    // failed means Slack answered and refused (invalid_auth, channel_not_found).
    // One is our network, the other is our configuration.
    else console.warn(`[Slack] post to ${id} ${res.threw ? 'threw' : 'failed'}: ${res.error}`);
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
 *
 * `threw: true` marks a transport failure — we never got an answer from Slack.
 * `threw: false` with an error means Slack answered and refused. Retrying helps
 * with the first and almost never with the second.
 *
 * opts.threadTs posts the message as a REPLY under that parent message instead
 * of as a new message in the channel. Added 2026-09-17 so the sale-announcement
 * stats line can sit under its celebration rather than doubling the length of
 * the sales board — ~400 sales a month is ~800 messages if every stat is a
 * top-level post.
 */
export async function postToSlack(text, channelId, opts = {}) {
  if (!text) return { ok: false, ts: null, channel: channelId || null, error: 'no_text', threw: false };
  if (!channelId) return { ok: false, ts: null, channel: null, error: 'no_channel', threw: false };
  if (!SLACK_BOT_TOKEN) {
    if (!warnedNoToken) {
      console.warn('[Slack] SLACK_BOT_TOKEN unset — post is a no-op');
      warnedNoToken = true;
    }
    return { ok: false, ts: null, channel: channelId, error: 'no_token', threw: false };
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: channelId,
        text: String(text),
        // A reply, when the caller has a parent ts. Slack ignores the key when
        // it is absent, so the ordinary post path is byte-identical to before.
        ...(opts.threadTs ? { thread_ts: String(opts.threadTs) } : {}),
        // Interactive cards (approval buttons). `text` stays as the
        // notification fallback Slack requires alongside blocks.
        ...(Array.isArray(opts.blocks) && opts.blocks.length ? { blocks: opts.blocks } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (body?.ok) {
      return { ok: true, ts: body.ts || null, channel: body.channel || channelId, error: null, threw: false };
    }
    return {
      ok: false,
      ts: null,
      channel: channelId,
      error: String(body?.error || res.status),
      threw: false,
    };
  } catch (err) {
    return { ok: false, ts: null, channel: channelId, error: err.message, threw: true };
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

/** True only when the flag is on AND a bot token exists. */
export function slackApprovalsEnabled() {
  return APPROVALS_ENABLED && !!SLACK_BOT_TOKEN;
}

/** Where approval cards go: SLACK_CHANNEL_APPROVALS, else #lead-intelligence. */
export function approvalsChannelId() {
  return CH_APPROVALS || CH_MAIN;
}

/**
 * Post an approval card with Approve / Reject buttons. Never throws; returns
 * postToSlack's shape so the caller can fall back to the plain-text mirror.
 */
export async function postSlackApprovalCard(text, shortRef) {
  if (!slackApprovalsEnabled()) return { ok: false, ts: null, channel: null, error: 'disabled', threw: false };
  const channel = approvalsChannelId();
  if (!channel) return { ok: false, ts: null, channel: null, error: 'no_channel', threw: false };
  return postToSlack(text, channel, { blocks: buildApprovalBlocks(text, shortRef) });
}

console.log(`[Slack] approvals enabled=${APPROVALS_ENABLED} channel=${CH_APPROVALS || CH_MAIN || '-'}`);

/** TESTS ONLY — reset the cache between cases. */
export function __resetSlackCacheForTests() {
  channelCache = null; slugCache = null; cacheLoadedAt = 0; warnedNoToken = false;
}
