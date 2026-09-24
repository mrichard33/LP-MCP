/**
 * test-groupme-mirror-result.js — sendGroupMeMessage returns the mirror's
 * result (2026-09-24).
 *
 * WHY: until now the mirror was fired and forgotten, so a card's Slack
 * destination was never recorded anywhere. A market card that quietly fell
 * into the all-markets rollup was byte-identical in the record to one that
 * reached its market, and nobody could answer "did this reach the Fort
 * Lauderdale floor?" after the fact.
 *
 * Two things this locks down:
 *   1. the returned `slack` carries the resolved channel ids;
 *   2. the mirror stays FAIL-SILENT — awaiting it must never become a new way
 *      to fail a GroupMe send. That is the regression risk in capturing it.
 *
 * No network: globalThis.fetch is stubbed for both GroupMe and Slack.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const CH_MAIN = 'C_MAIN';
const CH_CANVASS = 'C_CANVASS_ALL';
const CH_FTMYR = 'C_CANVASS_FTMYR';

process.env.GROUPME_BOT_ID = 'main-bot';
process.env.SLACK_MIRROR_ENABLED = 'true';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_CHANNEL_MAIN = CH_MAIN;
process.env.SLACK_CHANNEL_CANVASS = CH_CANVASS;

const groupmePosts = [];
const slackPosts = [];
let groupmeResponse = () => ({ ok: true });
let slackResponse = () => ({ ok: true });

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.groupme.com')) {
    groupmePosts.push(JSON.parse(opts.body));
    const r = groupmeResponse();
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status || 200, text: async () => '' };
  }
  if (u.includes('slack.com/api/chat.postMessage')) {
    slackPosts.push(JSON.parse(opts.body));
    const r = slackResponse();
    if (r instanceof Error) throw r;
    return { ok: true, status: 200, json: async () => r };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

console.warn = () => {};
console.error = () => {};
console.log = () => {};

const slack = await import('../src/slack.js');
const gm = await import('../src/groupme.js');

slack.__setSlackClientForTests({
  from(table) {
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
        throw new Error(`unexpected table: ${table}`);
      },
    };
  },
});

function reset() {
  groupmePosts.length = 0;
  slackPosts.length = 0;
  groupmeResponse = () => ({ ok: true });
  slackResponse = () => ({ ok: true });
  slack.__resetSlackCacheForTests();
}

test('the send returns the channel ids the card actually reached', async () => {
  reset();
  const r = await gm.sendGroupMeMessage('canvass card', { channel: 'canvass', market: 'FTMYR' });
  assert.equal(r.sent, true);
  assert.deepEqual(r.slack.channelIds, [CH_FTMYR, CH_CANVASS]);
  assert.equal(groupmePosts.length, 1);
  assert.equal(slackPosts.length, 2);
});

test('an unroutable market records the rollup only — the misroute is now visible', async () => {
  reset();
  const r = await gm.sendGroupMeMessage('canvass card', { channel: 'canvass', market: 'NOPE' });
  assert.equal(r.sent, true);
  assert.deepEqual(r.slack.channelIds, [CH_CANVASS]);
});

test('a Slack failure does NOT fail the GroupMe send (fail-silent survives the await)', async () => {
  reset();
  slackResponse = () => new Error('ECONNRESET');
  const r = await gm.sendGroupMeMessage('main card');
  assert.equal(r.sent, true, 'the card still went out');
  assert.equal(r.slack.mirrored, false);
  assert.equal(groupmePosts.length, 1);
});

test('a GroupMe failure still reports the mirror result', async () => {
  reset();
  groupmeResponse = () => ({ ok: false, status: 502 });
  const r = await gm.sendGroupMeMessage('main card');
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'http_502');
  assert.deepEqual(r.slack.channelIds, [CH_MAIN]);
});
