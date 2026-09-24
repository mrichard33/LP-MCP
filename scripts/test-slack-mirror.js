/**
 * test-slack-mirror.js — GroupMe → Slack notification mirror (src/slack.js).
 *
 * No network. globalThis.fetch is stubbed to capture chat.postMessage calls;
 * the channel cache reads a stub supabase client via __setSlackClientForTests.
 *
 * slack.js reads env at import — the three configurations (disabled, no
 * token, live) are loaded as distinct module instances via query-string
 * dynamic imports, the same pattern test-groupme-channel-routing.js uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const CH_MAIN = 'C_MAIN';
const CH_CANVASS = 'C_CANVASS_ALL';
const CH_OPS = 'C_OPS';
const CH_FTMYR = 'C_CANVASS_FTMYR';
const CH_FTLAU = 'C_CANVASS_FTLAU';
const CH_SERVICE = 'C_SERVICE_CONTACT_CENTER';
const CH_SERVICE_ORL = 'C_SERVICE_ORLANDO';

// ─── fetch stub: capture Slack posts, script the response ───────
const posts = [];
let slackResponse = () => ({ ok: true });
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('slack.com/api/chat.postMessage')) {
    throw new Error(`unexpected fetch: ${url}`);
  }
  posts.push({ headers: opts.headers, body: JSON.parse(opts.body) });
  const r = slackResponse();
  if (r instanceof Error) throw r;
  return { ok: true, status: 200, json: async () => r };
};

// ─── supabase stub: counts loads, serves the three tables ───────
let dbCalls = 0;
const stubDb = {
  from(table) {
    dbCalls++;
    return {
      select: async () => {
        if (table === 'slack_channels') {
          return { data: [
            { channel_name: 'canvass-all', slack_channel_id: CH_CANVASS },
            { channel_name: 'canvass-fortmyers', slack_channel_id: CH_FTMYR },
            { channel_name: 'canvass-fortlauderdale', slack_channel_id: CH_FTLAU },
            { channel_name: 'lead-intelligence', slack_channel_id: CH_MAIN },
            { channel_name: 'service-orlando', slack_channel_id: CH_SERVICE_ORL },
          ] };
        }
        if (table === 'slack_market_slugs') {
          return { data: [
            { market_code: 'FTMYR', slug: 'fortmyers' },
            { market_code: 'FTLAU', slug: 'fortlauderdale' },
            { market_code: 'ORL', slug: 'orlando' },
          ] };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
  },
};

// ─── warn capture ───────────────────────────────────────────────
// Installed for the life of the process, never restored via test.after(): a
// top-level after() hook fires as soon as the first queued test finishes
// (the module is still evaluating between the awaited imports below), which
// would put the real console.warn back before the later cases run.
const warns = [];
console.warn = (...args) => { warns.push(args.join(' ')); };
console.log = () => {};

function reset(mod) {
  posts.length = 0;
  warns.length = 0;
  dbCalls = 0;
  slackResponse = () => ({ ok: true });
  mod.__resetSlackCacheForTests();
}

// ─── Config A: mirror disabled ──────────────────────────────────
process.env.SLACK_MIRROR_ENABLED = 'false';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_CHANNEL_MAIN = CH_MAIN;
process.env.SLACK_CHANNEL_CANVASS = CH_CANVASS;
process.env.SLACK_CHANNEL_OPS = CH_OPS;
process.env.SLACK_CHANNEL_SERVICE = CH_SERVICE;
const disabled = await import('../src/slack.js?disabled');

test('MIRROR_ENABLED=false → {mirrored:false, reason:disabled}, fetch never called', async () => {
  reset(disabled);
  const r = await disabled.mirrorToSlack('hello', 'main');
  assert.deepEqual(r, { mirrored: false, reason: 'disabled' });
  assert.equal(posts.length, 0);
});

// ─── Config B: enabled, token unset ─────────────────────────────
process.env.SLACK_MIRROR_ENABLED = 'true';
process.env.SLACK_BOT_TOKEN = '';
const noToken = await import('../src/slack.js?no-token');

test('token unset → reason no_token, warns once, fetch never called', async () => {
  reset(noToken);
  const r1 = await noToken.mirrorToSlack('hello', 'main');
  const r2 = await noToken.mirrorToSlack('hello again', 'ops');
  assert.deepEqual(r1, { mirrored: false, reason: 'no_token' });
  assert.deepEqual(r2, { mirrored: false, reason: 'no_token' });
  assert.equal(posts.length, 0);
  assert.equal(warns.filter((w) => w.includes('SLACK_BOT_TOKEN unset')).length, 1);
});

// ─── Config C: live ─────────────────────────────────────────────
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
const slack = await import('../src/slack.js?live');
slack.__setSlackClientForTests(stubDb);

test('channel main → exactly one POST to CH_MAIN with the exact text', async () => {
  reset(slack);
  const text = '🔔 LP Appointment Set\nJane Doe · (239) 555-0100';
  const r = await slack.mirrorToSlack(text, 'main');
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1, channelIds: [CH_MAIN] });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.channel, CH_MAIN);
  assert.equal(posts[0].body.text, text);
  assert.equal(posts[0].headers.Authorization, 'Bearer xoxb-test');
});

test('channel ops → exactly one POST to CH_OPS', async () => {
  reset(slack);
  await slack.mirrorToSlack('ops card', 'ops');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.channel, CH_OPS);
});

test('canvass + market FTMYR → market channel first, then CH_CANVASS', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('canvass card', 'canvass', { market: 'FTMYR' });
  assert.deepEqual(r, { mirrored: true, channels: 2, sent: 2, channelIds: [CH_FTMYR, CH_CANVASS] });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_FTMYR, CH_CANVASS]);
  assert.equal(posts[0].body.text, 'canvass card');
  assert.equal(posts[1].body.text, 'canvass card');
  assert.equal(warns.length, 0);
});

test('canvass + lowercase code → same two channels (case-insensitive)', async () => {
  reset(slack);
  await slack.mirrorToSlack('canvass card', 'canvass', { market: 'ftmyr' });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_FTMYR, CH_CANVASS]);
  assert.equal(warns.length, 0);
});

test('canvass + market BOCA → aliases to canvass-fortlauderdale AND CH_CANVASS', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('canvass card', 'canvass', { market: 'BOCA' });
  assert.deepEqual(r, { mirrored: true, channels: 2, sent: 2, channelIds: [CH_FTLAU, CH_CANVASS] });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_FTLAU, CH_CANVASS]);
  assert.equal(warns.length, 0);
});

test('canvass + market MIAMI → aliases to canvass-fortlauderdale AND CH_CANVASS', async () => {
  reset(slack);
  await slack.mirrorToSlack('canvass card', 'canvass', { market: 'MIAMI' });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_FTLAU, CH_CANVASS]);
});

test('canvass + market RFED (no alias, no slug) → CH_CANVASS only, one warning', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('canvass card', 'canvass', { market: 'RFED' });
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1, channelIds: [CH_CANVASS] });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_CANVASS]);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /no canvass channel for market=RFED/);
});

test('canvass + unknown market → one POST to CH_CANVASS, one warning', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('canvass card', 'canvass', { market: 'NOPE' });
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1, channelIds: [CH_CANVASS] });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_CANVASS]);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /no canvass channel for market=NOPE/);
});

test('canvass + no market → one POST to CH_CANVASS, no warning, no db load', async () => {
  reset(slack);
  await slack.mirrorToSlack('canvass card', 'canvass');
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_CANVASS]);
  assert.equal(warns.length, 0);
  assert.equal(dbCalls, 0);
});

test('unknown channel → CH_MAIN (matches _resolveBotId fallback)', async () => {
  reset(slack);
  await slack.mirrorToSlack('card', 'whatever');
  await slack.mirrorToSlack('card', undefined);
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_MAIN, CH_MAIN]);
});

test('fetch throws → {mirrored:false}, does NOT throw', async () => {
  reset(slack);
  slackResponse = () => new Error('ECONNRESET');
  const r = await slack.mirrorToSlack('card', 'main');
  assert.equal(r.mirrored, false);
  assert.equal(r.sent, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /threw: ECONNRESET/);
});

test('Slack returns ok:false → warns with the error string, does NOT throw', async () => {
  reset(slack);
  slackResponse = () => ({ ok: false, error: 'invalid_auth' });
  const r = await slack.mirrorToSlack('card', 'main');
  assert.deepEqual(r, { mirrored: false, channels: 1, sent: 0, channelIds: [] });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /post to C_MAIN failed: invalid_auth/);
});

test('cache: second resolve inside TTL makes no supabase call', async () => {
  reset(slack);
  await slack.resolveSlackChannels('canvass', { market: 'FTMYR' });
  const afterFirst = dbCalls;
  assert.equal(afterFirst, 2); // slack_channels + slack_market_slugs
  await slack.resolveSlackChannels('canvass', { market: 'FTMYR' });
  await slack.resolveSlackChannels('canvass', { market: 'BOCA' });
  assert.equal(dbCalls, afterFirst);
});

test('empty text → disabled reason, fetch never called', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('', 'main');
  assert.deepEqual(r, { mirrored: false, reason: 'disabled' });
  assert.equal(posts.length, 0);
});


// ─── service family (2026-09-21) ────────────────────────────────
// Customer service issues surfaced by a missed reply route to the market's
// service channel, not the sales floor. Same alsoRollup:false discipline as
// sales — a service issue belongs to the market that installed the job.

test('service + a market CODE resolves the market channel ONLY', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('screen is torn', 'service', { market: 'ORL' });
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1, channelIds: [CH_SERVICE_ORL] }, 'one channel — no rollup copy, alsoRollup is false for service');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.channel, CH_SERVICE_ORL);
});

test('service with NO market falls back to the contact-center channel, not main', async () => {
  // The fallback matters: an unrouted service issue must still reach someone
  // who handles service. Landing in #lead-intelligence would bury it.
  reset(slack);
  const r = await slack.mirrorToSlack('warranty question', 'service');
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1, channelIds: [CH_SERVICE] });
  assert.equal(posts[0].body.channel, CH_SERVICE);
  assert.notEqual(posts[0].body.channel, CH_MAIN);
});

test('service with an unresolvable market falls back rather than dropping', async () => {
  // The market NAME instead of the CODE is the classic mistake — the card
  // prints "Orlando / Central Florida" while slack_market_slugs is keyed on
  // ORL. It must degrade to the rollup, never to nothing.
  reset(slack);
  const r = await slack.mirrorToSlack('leak after install', 'service', { market: 'Orlando / Central Florida' });
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1, channelIds: [CH_SERVICE] });
  assert.equal(posts[0].body.channel, CH_SERVICE);
});

test('service does not disturb canvass routing', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('door knocked', 'canvass', { market: 'FTMYR' });
  assert.deepEqual(r, { mirrored: true, channels: 2, sent: 2, channelIds: [CH_FTMYR, CH_CANVASS] }, 'canvass still copies to its rollup');
  assert.deepEqual(posts.map((p) => p.body.channel).sort(), [CH_CANVASS, CH_FTMYR].sort());
});

// ─── channelIds: the DELIVERY record (2026-09-24) ───────────────
// `channels` is a count of what we aimed at. `channelIds` is what accepted.
// They diverge exactly when a card silently missed its destination, which is
// the failure this field exists to make visible.

test('channelIds records only the channels that ACCEPTED the post', async () => {
  reset(slack);
  // canvass+FTMYR fans out to the market channel, then the rollup. Fail only
  // the rollup: the record must show the market channel got it and the rollup
  // did not.
  slackResponse = () => (posts[posts.length - 1].body.channel === CH_CANVASS
    ? { ok: false, error: 'channel_not_found' }
    : { ok: true });
  const r = await slack.mirrorToSlack('canvass card', 'canvass', { market: 'FTMYR' });
  assert.deepEqual(r, { mirrored: true, channels: 2, sent: 1, channelIds: [CH_FTMYR] });
});

test('a card that reached only the rollup is distinguishable from one that reached its market', async () => {
  // The whole point. Before channelIds these two outcomes were byte-identical
  // in the record — a Boca card in #sales-all read exactly like one that
  // landed in #sales-fortlauderdale.
  reset(slack);
  const routed = await slack.mirrorToSlack('card', 'canvass', { market: 'FTMYR' });
  reset(slack);
  const rollupOnly = await slack.mirrorToSlack('card', 'canvass', { market: 'NOPE' });
  assert.ok(routed.channelIds.includes(CH_FTMYR));
  assert.deepEqual(rollupOnly.channelIds, [CH_CANVASS]);
  assert.notDeepEqual(routed.channelIds, rollupOnly.channelIds);
});
