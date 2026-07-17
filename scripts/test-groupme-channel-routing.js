/**
 * test-groupme-channel-routing.js — per-purpose GroupMe channel routing
 * (Pilot v2 v1.4).
 *
 * channel:'canvass' → GROUPME_CANVASS_BOT_ID; unset canvass var → warn +
 * fall back to the main bot (never drop); debounce buffers are keyed per
 * channel so canvass and main streams flush to their own bots.
 *
 * groupme.js reads env at import — the two configurations are loaded as
 * distinct module instances via query-string dynamic imports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

process.env.GROUPME_BOT_ID = 'main-bot';
process.env.GROUPME_DEBOUNCE_MS = '40';

// Capture GroupMe bot posts; pass everything else through untouched.
const realFetch = globalThis.fetch;
const posts = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.groupme.com')) {
    posts.push(JSON.parse(opts.body));
    return { ok: true, text: async () => '' };
  }
  return realFetch(url, opts);
};

// ─── Config A: canvass var UNSET → fallback to main bot ─────────
delete process.env.GROUPME_CANVASS_BOT_ID;
const gmFallback = await import('../src/groupme.js');

test('canvass channel falls back to main bot when GROUPME_CANVASS_BOT_ID unset (never drop)', async () => {
  posts.length = 0;
  const result = await gmFallback.sendGroupMeMessage('fallback card', { channel: 'canvass', flushNow: true });
  assert.equal(result.sent, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].bot_id, 'main-bot');
});

// ─── Config B: canvass var SET → dedicated bot ──────────────────
process.env.GROUPME_CANVASS_BOT_ID = 'canvass-bot';
const gm = await import('../src/groupme.js?with-canvass');

test('channel:canvass routes to the canvass bot; default routes to main', async () => {
  posts.length = 0;
  await gm.sendGroupMeMessage('canvass card', { channel: 'canvass' }); // no contactId → immediate
  await gm.sendGroupMeMessage('main card');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].bot_id, 'canvass-bot');
  assert.equal(posts[0].text, 'canvass card');
  assert.equal(posts[1].bot_id, 'main-bot');
});

test('flushNow + channel bypasses debounce and hits the canvass bot', async () => {
  posts.length = 0;
  const result = await gm.sendGroupMeMessage('urgent canvass', {
    contactId: 'C1',
    channel: 'canvass',
    flushNow: true,
  });
  assert.equal(result.sent, true);
  assert.equal(posts[0].bot_id, 'canvass-bot');
});

test('debounce buffers are keyed per channel — same contact, two channels, two bots', async () => {
  posts.length = 0;
  const r1 = await gm.sendGroupMeMessage('canvass line', { contactId: 'C2', channel: 'canvass' });
  const r2 = await gm.sendGroupMeMessage('main line', { contactId: 'C2' });
  assert.equal(r1.reason, 'queued');
  assert.equal(r2.reason, 'queued');
  // Separate buffers → both are queue_size 1, not consolidated together.
  assert.equal(r1.queue_size, 1);
  assert.equal(r2.queue_size, 1);

  await new Promise((resolve) => setTimeout(resolve, 150)); // > GROUPME_DEBOUNCE_MS

  assert.equal(posts.length, 2);
  const botIds = posts.map((p) => p.bot_id).sort();
  assert.deepEqual(botIds, ['canvass-bot', 'main-bot']);
  const canvassPost = posts.find((p) => p.bot_id === 'canvass-bot');
  assert.equal(canvassPost.text, 'canvass line');
});

test('unknown channel value routes to the main bot', async () => {
  posts.length = 0;
  await gm.sendGroupMeMessage('mystery channel', { channel: 'does-not-exist' });
  assert.equal(posts[0].bot_id, 'main-bot');
});
