/**
 * Tests — the sale announcement backstop
 * scripts/test-sale-backstop.js
 *
 * 2026-09-25: LP's webhook to GHL I.LP-IN stopped delivering sales on 09-24,
 * so 15 of 16 sales never reached the board. The backstop announces from our
 * own sync. What matters here:
 *   - it never races a healthy GHL path (30-minute grace, same idempotency key);
 *   - it never announces twice (anything with a row is skipped; claim first);
 *   - old sales go in ONE catch-up message, not a burst of celebrations;
 *   - GroupMe goes only to the sales board bot, and never mirrors to Slack.
 */

process.env.SALE_ANNOUNCE_ENABLED = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findMissedSales,
  runSaleBackstop,
  postDigest,
  formatDigest,
  backstopRow,
  sendSalesBoardGroupMe,
  GRACE_MS,
} from '../src/notifications/sale-backstop.js';
import { idempotencyKey } from '../src/notifications/sale-announcement.js';

const quiet = { log() {}, warn() {}, error() {} };
const NOW = new Date('2026-09-25T21:00:00Z');

const lead = (id, over = {}) => ({
  lp_lead_id: id, lp_prospect_id: `p${id}`, ghl_contact_id: `c${id}`,
  rep_name: 'Wheeler, Donte', job_value: 28002, lp_branch_id: 'JAX', closed_won: true,
  appointment_date: '2026-09-25T14:00:00Z', ...over,
});

// ─── finding missed sales ────────────────────────────────────────

test('finds a won sale nobody announced, and skips the ones that were', async () => {
  let window = null;
  const out = await findMissedSales({
    now: () => NOW,
    readEvents: async (w) => {
      window = w;
      return [
        { lp_lead_id: '578357', created_at: '2026-09-25T19:48:00Z' },
        { lp_lead_id: '578357', created_at: '2026-09-25T19:53:28Z' }, // repeat event, same lead
        { lp_lead_id: '578156', created_at: '2026-09-25T18:49:05Z' }, // announced by GHL
      ];
    },
    readAnnounced: async () => new Set(['578156']),
    readLeadRows: async ({ leadIds }) => {
      assert.deepEqual(leadIds, ['578357']);
      return [lead('578357')];
    },
  });
  assert.equal(window.untilIso, new Date(NOW.getTime() - GRACE_MS).toISOString(), '30 minutes of grace');
  assert.deepEqual(out.map((s) => [s.leadId, s.repDisplayName, s.amount, s.firstSeenAt]), [
    ['578357', 'Donte Wheeler', 28002, '2026-09-25T19:48:00Z'],
  ]);
});

test('a sale reversed since, a $0 job or an unusable rep name is not announced', async () => {
  const out = await findMissedSales({
    now: () => NOW,
    readEvents: async () => [{ lp_lead_id: '1', created_at: 'x' }, { lp_lead_id: '2', created_at: 'x' }, { lp_lead_id: '3', created_at: 'x' }],
    readAnnounced: async () => new Set(),
    readLeadRows: async () => [lead('1', { closed_won: false }), lead('2', { job_value: 0 }), lead('3', { rep_name: '0' })],
  });
  assert.equal(out.length, 0);
});

test('an OLD sale LP re-sent (Sale → Sale) or first seen now is never announced', async () => {
  // Live dry run 2026-09-25: 25 of 46 "missed" sales were jobs from 2017-2026
  // that LP re-sent unchanged. None of them may reach the board as news.
  const out = await findMissedSales({
    now: () => NOW,
    readEvents: async () => [
      { lp_lead_id: '51507', created_at: '2026-09-24T15:49:44Z', previous_state: { disposition_code: 'Sale' } },
      { lp_lead_id: '76113', created_at: '2026-09-23T23:52:32Z', previous_state: null },
      { lp_lead_id: '578357', created_at: '2026-09-25T19:48:00Z', previous_state: { disposition_code: 'Issue' } },
      { lp_lead_id: '578176', created_at: '2026-09-23T23:58:04Z', previous_state: null },
    ],
    readAnnounced: async () => new Set(),
    readLeadRows: async () => [
      lead('51507', { appointment_date: '2017-03-07T14:00:00Z' }),
      lead('76113', { appointment_date: '2019-04-09T14:00:00Z' }),
      lead('578357'),
      lead('578176', { appointment_date: '2026-09-23T14:00:00Z' }),
    ],
  });
  assert.deepEqual(out.map((s) => s.leadId).sort(), ['578176', '578357'],
    'the re-sent 2017 sale and the first-seen 2019 lead are excluded; a new lead first seen as Sale this week is kept');
});

test('the backstop row carries the SAME idempotency key the GHL path would build', () => {
  // resolve-lead.js keys a lead_id sale on String(lp_lead_id); a late GHL call
  // for the same sale must be a replay, not a second Slack post.
  const row = backstopRow({ leadId: '578357', amount: 28002.4, repDisplayName: 'Donte Wheeler' });
  assert.equal(row.idempotency_key, idempotencyKey('578357', 28002));
  assert.equal(row.key_source, 'lead_id');
  assert.equal(row.announce_source, 'backstop');
});

// ─── one pass ────────────────────────────────────────────────────

test('a fresh sale is announced through the normal pipeline, with GroupMe as the mirror', async () => {
  const completed = [];
  const groupMe = [];
  const out = await runSaleBackstop({
    now: () => NOW, logger: quiet, supabase: {}, startedAt: 0,
    find: async () => [{ leadId: '578357', repDisplayName: 'Donte Wheeler', amount: 28002, branch: 'JAX', firstSeenAt: '2026-09-25T19:48:00Z' }],
    claim: async (row) => ({ claimed: true, row: { id: 92, ...row } }),
    complete: async (ctx, deps) => { completed.push(ctx); await deps.mirror('celebration text'); return { ok: true }; },
    groupMe: async (text) => { groupMe.push(text); return { mirrored: true }; },
    digest: async () => { throw new Error('no digest expected'); },
  });
  assert.equal(out.ok, true);
  assert.equal(out.announced, 1);
  assert.deepEqual(completed[0], { rowId: 92, repDisplayName: 'Donte Wheeler', amount: 28002, leadId: '578357', keySource: 'lead_id' });
  assert.deepEqual(groupMe, ['celebration text']);
});

test('a sale someone else already claimed is left alone', async () => {
  let completed = 0;
  const out = await runSaleBackstop({
    now: () => NOW, logger: quiet, supabase: {}, startedAt: 0,
    find: async () => [{ leadId: '1', repDisplayName: 'A B', amount: 5, firstSeenAt: '2026-09-25T20:00:00Z' }],
    claim: async () => ({ claimed: false, duplicate: true, row: { id: 1 } }),
    complete: async () => { completed += 1; return { ok: true }; },
  });
  assert.equal(completed, 0);
  assert.equal(out.announced, 0);
  assert.equal(out.ok, true);
});

test('sales older than 6 hours go in one digest, not individual celebrations', async () => {
  let digested = null;
  let completed = 0;
  const out = await runSaleBackstop({
    now: () => NOW, logger: quiet, supabase: {}, startedAt: 0,
    find: async () => [
      { leadId: 'old1', repDisplayName: 'Joel Pignotti', amount: 99160, branch: 'FTMYR', firstSeenAt: '2026-09-25T12:10:40Z' },
      { leadId: 'old2', repDisplayName: 'Andy Cox', amount: 44500, branch: 'STPET', firstSeenAt: '2026-09-24T17:21:48Z' },
      { leadId: 'new1', repDisplayName: 'Donte Wheeler', amount: 28002, branch: 'JAX', firstSeenAt: '2026-09-25T19:48:00Z' },
    ],
    claim: async (row) => ({ claimed: true, row: { id: row.lp_lead_id } }),
    complete: async () => { completed += 1; return { ok: true }; },
    digest: async (stale) => { digested = stale.map((s) => s.leadId); return { ok: true, posted: stale.length }; },
  });
  assert.deepEqual(digested, ['old1', 'old2']);
  assert.equal(completed, 1, 'only the fresh one is celebrated on its own');
  assert.equal(out.digested, 2);
});

test('everything already waiting when the process starts goes in ONE catch-up digest', async () => {
  let digested = null;
  let completed = 0;
  await runSaleBackstop({
    now: () => NOW, logger: quiet, supabase: {},
    startedAt: new Date('2026-09-25T20:45:00Z').getTime(), // deployed after these were seen
    find: async () => [
      { leadId: 'a', repDisplayName: 'Donte Wheeler', amount: 28002, firstSeenAt: '2026-09-25T19:48:00Z' },
      { leadId: 'b', repDisplayName: 'Beverly Dorsett', amount: 25895, firstSeenAt: '2026-09-25T20:07:32Z' },
    ],
    claim: async (row) => ({ claimed: true, row: { id: row.lp_lead_id } }),
    complete: async () => { completed += 1; return { ok: true }; },
    digest: async (stale) => { digested = stale.map((x) => x.leadId); return { ok: true, posted: stale.length }; },
  });
  assert.deepEqual(digested, ['a', 'b']);
  assert.equal(completed, 0, 'no burst of individual celebrations on deploy');
});

test('an unreadable source fails the run rather than guessing', async () => {
  const out = await runSaleBackstop({
    now: () => NOW, logger: quiet, supabase: {},
    find: async () => { throw new Error('db down'); },
  });
  assert.equal(out.ok, false);
});

test('does nothing while SALE_ANNOUNCE_ENABLED is off', async () => {
  process.env.SALE_ANNOUNCE_ENABLED = 'false';
  try {
    const out = await runSaleBackstop({ find: async () => { throw new Error('must not read'); } });
    assert.equal(out.ok, true);
    assert.match(out.skipped, /SALE_ANNOUNCE_ENABLED/);
  } finally {
    process.env.SALE_ANNOUNCE_ENABLED = 'true';
  }
});

// ─── the digest ──────────────────────────────────────────────────

test('the digest lists each sale with rep, amount, office and day', () => {
  const text = formatDigest([
    { repDisplayName: 'Joel Pignotti', amount: 99160, branch: 'FTMYR', firstSeenAt: '2026-09-25T12:10:40Z' },
    { repDisplayName: 'David Carter', amount: 5814, branch: 'LAKE', firstSeenAt: '2026-09-25T20:11:35Z' },
  ]);
  assert.equal(text, [
    "📋 2 sales that didn't reach the board when they closed:",
    '• Joel Pignotti — $99,160 (Fort Myers) · Sep 25',
    '• David Carter — $5,814 (Lakeland) · Sep 25',
    'Congratulations to all of you. 🎉',
  ].join('\n'));
});

function fakeDb() {
  const updates = [];
  return {
    updates,
    from() {
      return { update(patch) { return { async eq(col, id) { updates.push({ id, patch }); return { error: null }; } }; } };
    },
  };
}

test('the digest claims first, posts only what it claimed, and records the ts', async () => {
  const db = fakeDb();
  const posts = [];
  const gm = [];
  const out = await postDigest(
    [
      { leadId: 'a', repDisplayName: 'Joel Pignotti', amount: 99160, branch: 'FTMYR', firstSeenAt: '2026-09-25T12:10:40Z' },
      { leadId: 'b', repDisplayName: 'Andy Cox', amount: 44500, branch: 'STPET', firstSeenAt: '2026-09-24T17:21:48Z' },
    ],
    {
      supabase: db, logger: quiet, now: () => NOW, channelId: 'C_SALES',
      claim: async (row) => (row.lp_lead_id === 'a' ? { claimed: true, row: { id: 1 } } : { claimed: false, duplicate: true }),
      post: async (text, channel) => { posts.push({ text, channel }); return { ok: true, ts: 'd1', channel }; },
      groupMe: async (text) => { gm.push(text); return { mirrored: true }; },
    },
  );
  assert.equal(out.posted, 1);
  assert.match(posts[0].text, /Joel Pignotti/);
  assert.doesNotMatch(posts[0].text, /Andy Cox/, 'a sale another path owns is not repeated');
  assert.equal(db.updates[0].patch.status, 'posted');
  assert.equal(db.updates[0].patch.slack_ts, 'd1');
  assert.equal(gm.length, 1);
});

test('a digest that fails to post marks its rows slack_failed and skips GroupMe', async () => {
  const db = fakeDb();
  let gm = 0;
  const out = await postDigest(
    [{ leadId: 'a', repDisplayName: 'Joel Pignotti', amount: 1, firstSeenAt: '2026-09-25T12:00:00Z' }],
    {
      supabase: db, logger: quiet, now: () => NOW, channelId: 'C_SALES',
      claim: async () => ({ claimed: true, row: { id: 1 } }),
      post: async () => ({ ok: false, error: 'not_in_channel' }),
      groupMe: async () => { gm += 1; },
    },
  );
  assert.equal(out.ok, false);
  assert.equal(db.updates[0].patch.status, 'slack_failed');
  assert.equal(gm, 0);
});

// ─── GroupMe ─────────────────────────────────────────────────────

test('GroupMe goes to the sales board bot only, never mirrored back to Slack', async () => {
  const sent = [];
  const send = async (text, opts) => { sent.push(opts); };
  const off = await sendSalesBoardGroupMe('x', { send, logger: quiet, configured: false });
  assert.equal(off.mirrored, false);
  assert.equal(sent.length, 0, 'the main GroupMe group is not the sales board');

  const on = await sendSalesBoardGroupMe('x', { send, logger: quiet, configured: true });
  assert.equal(on.mirrored, true);
  assert.equal(sent[0].channel, 'sales');
  assert.equal(sent[0].noSlackMirror, true);
});
