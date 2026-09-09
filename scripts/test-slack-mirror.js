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
            { channel_name: 'lead-intelligence', slack_channel_id: CH_MAIN },
          ] };
        }
        if (table === 'slack_market_slugs') {
          return { data: [{ market_code: 'FTMYR', slug: 'fortmyers' }] };
        }
        if (table === 'service_markets') {
          return { data: [{ market_code: 'FTMYR', market_name: 'Ft. Myers / SW Florida' }] };
        }
        return { data: [] };
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
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1 });
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
  assert.deepEqual(r, { mirrored: true, channels: 2, sent: 2 });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_FTMYR, CH_CANVASS]);
  assert.equal(posts[0].body.text, 'canvass card');
  assert.equal(posts[1].body.text, 'canvass card');
  assert.equal(warns.length, 0);
});

test('canvass + market display name (what resolveMarket returns) → same two channels', async () => {
  reset(slack);
  await slack.mirrorToSlack('canvass card', 'canvass', { market: 'Ft. Myers / SW Florida' });
  assert.deepEqual(posts.map((p) => p.body.channel), [CH_FTMYR, CH_CANVASS]);
  assert.equal(warns.length, 0);
});

test('canvass + unknown market → one POST to CH_CANVASS, one warning', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('canvass card', 'canvass', { market: 'NOPE' });
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1 });
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
  assert.deepEqual(r, { mirrored: false, channels: 1, sent: 0 });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /post to C_MAIN failed: invalid_auth/);
});

test('cache: second resolve inside TTL makes no supabase call', async () => {
  reset(slack);
  await slack.resolveSlackChannels('canvass', { market: 'FTMYR' });
  const afterFirst = dbCalls;
  assert.equal(afterFirst, 3); // slack_channels + slack_market_slugs + service_markets
  await slack.resolveSlackChannels('canvass', { market: 'FTMYR' });
  await slack.resolveSlackChannels('canvass', { market: 'Ft. Myers / SW Florida' });
  assert.equal(dbCalls, afterFirst);
});

test('empty text → disabled reason, fetch never called', async () => {
  reset(slack);
  const r = await slack.mirrorToSlack('', 'main');
  assert.deepEqual(r, { mirrored: false, reason: 'disabled' });
  assert.equal(posts.length, 0);
});
