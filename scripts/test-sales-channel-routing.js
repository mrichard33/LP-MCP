/**
 * test-sales-channel-routing.js — the 'sales' logical channel and the rep →
 * market bridge that feeds it.
 *
 * No network. globalThis.fetch is stubbed; both caches read stub supabase
 * clients through their test seams. slack.js reads env at import, so the live
 * configuration is loaded as its own module instance via a query-string
 * dynamic import — the same pattern test-slack-mirror.js uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const CH_MAIN = 'C_MAIN';
const CH_CANVASS_ALL = 'C_CANVASS_ALL';
const CH_SALES_ALL = 'C_SALES_ALL';
const CH_SALES_FTMYR = 'C_SALES_FTMYR';
const CH_SALES_FTLAU = 'C_SALES_FTLAU';
const CH_CANVASS_FTMYR = 'C_CANVASS_FTMYR';
const CH_OPS = 'C_OPS';

const posts = [];
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('slack.com/api/chat.postMessage')) throw new Error(`unexpected fetch: ${url}`);
  posts.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const stubDb = {
  from(table) {
    return {
      select: async () => {
        if (table === 'slack_channels') {
          return { data: [
            { channel_name: 'sales-all', slack_channel_id: CH_SALES_ALL },
            { channel_name: 'sales-fortmyers', slack_channel_id: CH_SALES_FTMYR },
            { channel_name: 'sales-fortlauderdale', slack_channel_id: CH_SALES_FTLAU },
            { channel_name: 'canvass-all', slack_channel_id: CH_CANVASS_ALL },
            { channel_name: 'canvass-fortmyers', slack_channel_id: CH_CANVASS_FTMYR },
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

const warns = [];
console.warn = (...a) => { warns.push(a.join(' ')); };
console.log = () => {};

process.env.SLACK_MIRROR_ENABLED = 'true';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_CHANNEL_MAIN = CH_MAIN;
process.env.SLACK_CHANNEL_CANVASS = CH_CANVASS_ALL;
process.env.SLACK_CHANNEL_SALES = CH_SALES_ALL;
process.env.SLACK_CHANNEL_OPS = CH_OPS;

const slack = await import('../src/slack.js?sales');
slack.__setSlackClientForTests(stubDb);

function reset() {
  posts.length = 0;
  warns.length = 0;
  slack.__resetSlackCacheForTests();
}

// ─── the sales channel family ───────────────────────────────────

// 2026-09-21 — sales no longer ALSO posts to #sales-all. The rollup was
// removed on purpose (slack.js MARKET_FAMILIES.alsoRollup); a customer issue
// belongs to one market's floor. Do not "restore" it as a regression: the two
// tests below it, where nothing resolves, are what keep a card from vanishing.
test('sales + a known market → that market channel ONLY', async () => {
  reset();
  const ids = await slack.resolveSlackChannels('sales', { market: 'FTMYR' });
  assert.deepEqual(ids, [CH_SALES_FTMYR]);
});

test('sales market code is case-insensitive', async () => {
  reset();
  assert.deepEqual(await slack.resolveSlackChannels('sales', { market: 'ftmyr' }), [CH_SALES_FTMYR]);
});

test('sales with no market → rollup only, no warning', async () => {
  reset();
  assert.deepEqual(await slack.resolveSlackChannels('sales', {}), [CH_SALES_ALL]);
  assert.equal(warns.length, 0);
});

test('a market with a slug but no sales channel → rollup only, warns once', async () => {
  reset();
  // ORL has a slug but no sales-orlando row in the stub.
  assert.deepEqual(await slack.resolveSlackChannels('sales', { market: 'ORL' }), [CH_SALES_ALL]);
  assert.equal(warns.filter((w) => w.includes('no sales channel for market=ORL')).length, 1);
});

test('BOCA and MIAMI alias to Fort Lauderdale on the sales channel too', async () => {
  reset();
  assert.deepEqual(await slack.resolveSlackChannels('sales', { market: 'BOCA' }), [CH_SALES_FTLAU]);
  assert.deepEqual(await slack.resolveSlackChannels('sales', { market: 'MIAMI' }), [CH_SALES_FTLAU]);
});

test('sales routes to the market channel ONLY; canvass still posts to both', async () => {
  // The load-bearing assertion of the 2026-09-21 change: the two families
  // deliberately differ, driven by MARKET_FAMILIES.alsoRollup. Asserting the
  // pair together is what stops someone collapsing them back into one rule.
  reset();
  assert.deepEqual(await slack.resolveSlackChannels('sales', { market: 'FTMYR' }), [CH_SALES_FTMYR]);
  assert.deepEqual(await slack.resolveSlackChannels('canvass', { market: 'FTMYR' }), [CH_CANVASS_FTMYR, CH_CANVASS_ALL]);
});

test('adding sales did not disturb canvass, ops or main', async () => {
  reset();
  assert.deepEqual(await slack.resolveSlackChannels('canvass', { market: 'FTMYR' }), [CH_CANVASS_FTMYR, CH_CANVASS_ALL]);
  assert.deepEqual(await slack.resolveSlackChannels('ops', {}), [CH_OPS]);
  assert.deepEqual(await slack.resolveSlackChannels('main', {}), [CH_MAIN]);
  assert.deepEqual(await slack.resolveSlackChannels(undefined, {}), [CH_MAIN]);
});

test('a sales card actually posts to the one market channel', async () => {
  reset();
  const r = await slack.mirrorToSlack('rep never sent the quote', 'sales', { market: 'FTMYR' });
  assert.deepEqual(r, { mirrored: true, channels: 1, sent: 1, channelIds: [CH_SALES_FTMYR] });
  assert.deepEqual(posts.map((p) => p.channel), [CH_SALES_FTMYR]);
  assert.equal(posts[0].text, 'rep never sent the quote');
});

// ─── rep name → market ──────────────────────────────────────────

const roster = await import('../src/rep-roster.js');

function rosterDb(rows) {
  return {
    from() {
      return {
        select() {
          return { neq: async () => ({ data: rows }) };
        },
      };
    },
  };
}

function useRoster(rows) {
  roster.__setRosterClientForTests(rosterDb(rows));
  roster.__resetRosterCacheForTests();
}

test('splitRepName handles both orders, accents and punctuation', () => {
  assert.deepEqual(roster.splitRepName('Dorsett, Beverly'), { first: 'beverly', last: 'dorsett' });
  assert.deepEqual(roster.splitRepName('Beverly Dorsett'), { first: 'beverly', last: 'dorsett' });
  assert.deepEqual(roster.splitRepName("O'Connor, Tim"), { first: 'tim', last: 'oconnor' });
  assert.deepEqual(roster.splitRepName('Colón, Angelo'), { first: 'angelo', last: 'colon' });
  assert.equal(roster.splitRepName('Madonna'), null);
  assert.equal(roster.splitRepName(''), null);
  assert.equal(roster.splitRepName(null), null);
});

test('the comma form, which is what LP writes, survives a multi-word name', () => {
  // This is the path that matters: LP writes "Last, First".
  assert.deepEqual(roster.splitRepName('van der Berg, Mary Ann'), { first: 'maryann', last: 'vanderberg' });
  // The space-separated fallback cannot know where the surname starts. It
  // takes the first and last token and therefore misses here — a documented
  // limitation, asserted so a future change to splitRepName is deliberate.
  assert.deepEqual(roster.splitRepName('Mary Ann van der Berg'), { first: 'mary', last: 'berg' });
});

test('a rep on the roster resolves to their market code', async () => {
  useRoster([
    { first_name: 'Beverly', last_name: 'Dorsett', market_code: 'FTMYR', status: 'active' },
    { first_name: 'Angelo', last_name: 'Colón', market_code: 'ORL', status: 'invited' },
  ]);
  assert.deepEqual(await roster.resolveRepMarketCode('Dorsett, Beverly'), { code: 'FTMYR', reason: 'ok' });
  // An invited-but-not-yet-joined person still counts — they are on the team.
  assert.deepEqual(await roster.resolveRepMarketCode('Colon, Angelo'), { code: 'ORL', reason: 'ok' });
});

test('an unknown rep falls back rather than guessing', async () => {
  useRoster([{ first_name: 'Beverly', last_name: 'Dorsett', market_code: 'FTMYR', status: 'active' }]);
  assert.deepEqual(await roster.resolveRepMarketCode('Travis, Howard'), { code: null, reason: 'no_match' });
  assert.deepEqual(await roster.resolveRepMarketCode(''), { code: null, reason: 'no_name' });
  assert.deepEqual(await roster.resolveRepMarketCode('Madonna'), { code: null, reason: 'unparsed_name' });
});

test('two people with the same name in different markets refuse to resolve', async () => {
  useRoster([
    { first_name: 'Chris', last_name: 'Rech', market_code: 'STPET', status: 'active' },
    { first_name: 'Chris', last_name: 'Rech', market_code: 'ORL', status: 'active' },
  ]);
  assert.deepEqual(await roster.resolveRepMarketCode('Rech, Chris'), { code: null, reason: 'ambiguous' });
});

test('the same name twice in the SAME market is not a conflict', async () => {
  useRoster([
    { first_name: 'Chris', last_name: 'Rech', market_code: 'STPET', status: 'active' },
    { first_name: 'Chris', last_name: 'Rech', market_code: 'STPET', status: 'invited' },
  ]);
  assert.deepEqual(await roster.resolveRepMarketCode('Rech, Chris'), { code: 'STPET', reason: 'ok' });
});

test('a company-wide person has no market to route to', async () => {
  useRoster([{ first_name: 'Mark', last_name: 'Richard', market_code: null, status: 'active' }]);
  assert.deepEqual(await roster.resolveRepMarketCode('Richard, Mark'), { code: null, reason: 'no_market' });
});

test('a roster read that fails never throws at the caller', async () => {
  roster.__resetRosterCacheForTests();
  roster.__setRosterClientForTests({
    from() { return { select() { return { neq: async () => { throw new Error('boom'); } }; } }; },
  });
  assert.deepEqual(await roster.resolveRepMarketCode('Dorsett, Beverly'), { code: null, reason: 'no_match' });
});
