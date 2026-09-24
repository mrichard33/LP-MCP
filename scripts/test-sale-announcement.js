/**
 * Tests — Agentic Sale Announcements
 * scripts/test-sale-announcement.js
 *
 * Node 18+ built-in runner (`node:test`). Run with:
 *
 *   node --test scripts/test-sale-announcement.js
 *
 * No DB, no network, no Slack, no model. Every external dependency arrives
 * through the `deps` seam.
 *
 * The case that matters most is "two leads under one prospect, both sold".
 * An earlier version of this design keyed idempotency on LP Prospect ID, which
 * would have suppressed a repeat customer's second sale as a false duplicate.
 * Measured live: 241,625 distinct lp_lead_id vs 146,595 distinct
 * lp_prospect_id, so that is a large and silent class of miss. That test is the
 * guard.
 */

process.env.SALE_ANNOUNCE_ENABLED ||= 'true';
process.env.SALE_ANNOUNCE_TOKEN ||= 'test_token_0123456789';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSaleBearer,
  extractSaleFields,
  isUsableRepName,
  parseSaleAmount,
  idempotencyKey,
  makeSaleAnnouncementHandler,
  completeAnnouncement,
  stampCloseDate,
  STATUSES,
} from '../src/notifications/sale-announcement.js';

import { resolveLeadId, canWriteBack, dayStamp } from '../src/notifications/resolve-lead.js';
import { repNameKey, computeStreak, hasMilestone } from '../src/notifications/sale-facts.js';
import {
  cleanMessage,
  validateMessage,
  buildFactsBlock,
  formatStatsLine,
  isCelebratableClimb,
  gitBlobSha,
} from '../src/notifications/sale-announcement-body-generator.js';
import {
  postSaleAnnouncement,
  postSaleStats,
  postSaleToMarket,
  resolveSaleMarketChannel,
} from '../src/notifications/slack-sale.js';
import { __setSlackClientForTests, __resetSlackCacheForTests } from '../src/slack.js';

const TOKEN = process.env.SALE_ANNOUNCE_TOKEN;

// ─────────────────────────────────────────────────────────────────
// Harness: a tiny in-memory stand-in for the two tables we touch.
// Mirrors only what the code actually calls, and enforces the one
// constraint the whole design rests on: unique idempotency_key.
// ─────────────────────────────────────────────────────────────────
function makeDb({ leads = [] } = {}) {
  const announcements = [];
  const leadRows = leads.map((l) => ({ ...l }));
  let nextId = 1;

  function announcementsTable() {
    return {
      insert(row) {
        const dup = announcements.find((a) => a.idempotency_key === row.idempotency_key);
        const chain = {
          select() { return chain; },
          async single() {
            if (dup) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
            const saved = { id: nextId++, ...row };
            announcements.push(saved);
            return { data: saved, error: null };
          },
        };
        return chain;
      },
      select() {
        const filters = [];
        const chain = {
          eq(col, val) { filters.push([col, val]); return chain; },
          not() { return chain; },
          gte() { return chain; },
          order() { return chain; },
          limit() { return chain; },
          async single() {
            const hit = announcements.find((a) => filters.every(([c, v]) => String(a[c]) === String(v)));
            return { data: hit || null, error: hit ? null : { message: 'no rows' } };
          },
        };
        return chain;
      },
      update(patch) {
        return {
          async eq(col, val) {
            for (const a of announcements) {
              if (String(a[col]) === String(val)) Object.assign(a, patch);
            }
            return { error: null };
          },
        };
      },
    };
  }

  function leadsTable() {
    return {
      select() {
        const eqs = [];
        const chain = {
          eq(col, val) { eqs.push([col, val]); return chain; },
          not() { return chain; },
          gte() { return chain; },
          order() { return chain; },
          limit() {
            const rows = leadRows.filter((r) => eqs.every(([c, v]) => String(r[c]) === String(v)));
            return Promise.resolve({ data: rows, error: null });
          },
          async single() {
            const hit = leadRows.find((r) => eqs.every(([c, v]) => String(r[c]) === String(v)));
            return { data: hit || null, error: hit ? null : { message: 'no rows' } };
          },
          then(onFulfilled) {
            const rows = leadRows.filter((r) => eqs.every(([c, v]) => String(r[c]) === String(v)));
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
          },
        };
        return chain;
      },
      update(patch) {
        return {
          async eq(col, val) {
            for (const r of leadRows) {
              if (String(r[col]) === String(val)) Object.assign(r, patch);
            }
            return { error: null };
          },
        };
      },
    };
  }

  return {
    announcements,
    leadRows,
    supabase: {
      from(table) {
        if (table === 'sale_announcements') return announcementsTable();
        if (table === 'lp_leads') return leadsTable();
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
}

function makeRes() {
  const out = { statusCode: null, body: null, sent: false };
  return {
    out,
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; out.sent = true; return this; },
  };
}

const quietLogger = { log() {}, warn() {}, error() {} };

/** deps that exercise the real orchestration but stub Slack and the model. */
function makeDeps(db, overrides = {}) {
  const slackCalls = [];
  const statsCalls = [];
  const opsAlerts = [];
  const deferred = [];

  const deps = {
    supabase: db.supabase,
    logger: quietLogger,
    now: () => new Date('2026-09-16T15:00:00Z'),
    // Stub the model: deterministic, valid, names the rep.
    compose: async ({ repDisplayName, saleAmount }) => ({
      text: `🔥 ${repDisplayName} puts $${Math.round(saleAmount).toLocaleString('en-US')} on the board.`,
      source: 'llm',
      model: 'stub',
      rulebook_sha: 'deadbeef',
      reason: null,
    }),
    facts: async () => ({ degraded: false, mtd_sale_count: 2, mtd_volume: 50000, rank: 4, rank_field: 40 }),
    post: async (text) => {
      slackCalls.push(text);
      return { ok: true, ts: `ts-${slackCalls.length}`, channel: 'C_SALES', error: null, attempts: 1 };
    },
    postStats: async (text, threadTs) => {
      statsCalls.push({ text, threadTs });
      return { ok: true, ts: `stats-${statsCalls.length}`, error: null };
    },
    mirror: async () => ({ mirrored: false, reason: 'disabled' }),
    alert: async (detail) => { opsAlerts.push(detail); return { ok: true }; },
    // Collect the detached work so a test can await it deterministically.
    defer: (fn) => { deferred.push(fn); },
    ...overrides,
  };

  return {
    deps,
    slackCalls,
    statsCalls,
    opsAlerts,
    async drain() {
      while (deferred.length) await deferred.shift()();
    },
  };
}

function payload(over = {}) {
  return {
    contact_id: 'ghl_contact_1',
    lp_lead_id: '573581',
    lp_prospect_id: 'prospect_9',
    rep_display_name: 'Tim O’Connor',
    lp_gross_sale_amount: '31500',
    ...over,
  };
}

function req(body, token = TOKEN) {
  return { body, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

// ═════════════════════════════════════════════════════════════════
// 1. Valid payload → 200, row written, composed, Slack once
// ═════════════════════════════════════════════════════════════════
test('valid payload posts once and records the ts', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', close_date: null, job_value: null }] });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);

  const res = makeRes();
  await handler(req(payload()), res);
  assert.equal(res.out.statusCode, 200);
  assert.equal(res.out.body.status, STATUSES.PENDING);

  await h.drain();

  assert.equal(db.announcements.length, 1);
  assert.equal(h.slackCalls.length, 1);
  const row = db.announcements[0];
  assert.equal(row.status, STATUSES.POSTED);
  assert.equal(row.key_source, 'lead_id');
  assert.equal(row.slack_ts, 'ts-1');
  assert.equal(row.slack_channel, 'C_SALES');
  assert.match(row.message_text, /Tim/);
  assert.match(row.message_text, /31,500/);
});

// ═════════════════════════════════════════════════════════════════
// 2. Same payload twice → one row, one Slack call
// ═════════════════════════════════════════════════════════════════
test('a replayed disposition posts exactly once', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);

  const r1 = makeRes();
  await handler(req(payload()), r1);
  await h.drain();

  const r2 = makeRes();
  await handler(req(payload()), r2);
  await h.drain();

  assert.equal(r2.out.statusCode, 200, 'a replay is never an error back to GHL');
  assert.equal(r2.out.body.duplicate, true);
  assert.equal(db.announcements.length, 1);
  assert.equal(h.slackCalls.length, 1);
});

// ═════════════════════════════════════════════════════════════════
// 3. Same lead, different amount → two rows, two posts
// ═════════════════════════════════════════════════════════════════
test('a corrected sale amount on the same lead posts again', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();
  await handler(req(payload({ lp_gross_sale_amount: '42000' })), makeRes());
  await h.drain();

  assert.equal(db.announcements.length, 2);
  assert.equal(h.slackCalls.length, 2);
});

// ═════════════════════════════════════════════════════════════════
// 4. THE REGRESSION: two leads, one prospect, both sold
// ═════════════════════════════════════════════════════════════════
test('a repeat customer’s second lead posts its own announcement', async () => {
  const db = makeDb({
    leads: [
      { lp_lead_id: '573581', lp_prospect_id: 'prospect_9' },
      { lp_lead_id: '601244', lp_prospect_id: 'prospect_9' },
    ],
  });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);

  // Same person, same amount, two different leads. Keyed on the prospect this
  // would collapse into one post and the second sale would vanish.
  await handler(req(payload({ lp_lead_id: '573581' })), makeRes());
  await h.drain();
  await handler(req(payload({ lp_lead_id: '601244' })), makeRes());
  await h.drain();

  assert.equal(db.announcements.length, 2, 'two leads under one prospect are two sales');
  assert.equal(h.slackCalls.length, 2);
  assert.notEqual(
    db.announcements[0].idempotency_key,
    db.announcements[1].idempotency_key,
    'the key must differ per LEAD, not per prospect',
  );
});

// ═════════════════════════════════════════════════════════════════
// 5. GHL sent a lead id lp_leads does not have → corrected
// ═════════════════════════════════════════════════════════════════
test('an unknown lp_lead_id is corrected from the prospect and warned', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', created_at_lp: '2026-09-01' }] });
  const warnings = [];
  const h = makeDeps(db, { logger: { log() {}, error() {}, warn: (m) => warnings.push(m) } });
  const handler = makeSaleAnnouncementHandler(h.deps);

  // 575065 is the real observed defect: GHL carried the Last Appointment ID.
  await handler(req(payload({ lp_lead_id: '575065' })), makeRes());
  await h.drain();

  const row = db.announcements[0];
  assert.equal(row.key_source, 'lead_id_corrected');
  assert.equal(row.lp_lead_id, '573581', 'keyed on the lead LP actually has');
  assert.ok(
    warnings.some((w) => w.includes('575065') && w.includes('573581')),
    'the warning must carry BOTH ids so the upstream defect rate is measurable',
  );
});

// ═════════════════════════════════════════════════════════════════
// 6. rep_display_name "0" → skipped, nothing posted
// ═════════════════════════════════════════════════════════════════
test('the rep-name "0" bug never reaches the sales board', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);

  const res = makeRes();
  await handler(req(payload({ rep_display_name: '0' })), res);
  await h.drain();

  assert.equal(res.out.statusCode, 200);
  assert.equal(res.out.body.status, STATUSES.SKIPPED_INVALID);
  assert.equal(db.announcements[0].status, STATUSES.SKIPPED_INVALID);
  assert.equal(h.slackCalls.length, 0, 'zero Slack calls');
});

test('other unusable rep names are rejected too, real ones are not', () => {
  for (const bad of ['0', '', '   ', '12345', '--', '0.00', null, undefined]) {
    assert.equal(isUsableRepName(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
  for (const good of ['Tim O’Connor', 'O’Connor, Tim', 'Ed', 'Jean-Luc Picard']) {
    assert.equal(isUsableRepName(good), true, `${good} must be accepted`);
  }
});

test('an unusable sale amount is skipped', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);

  const res = makeRes();
  await handler(req(payload({ lp_gross_sale_amount: '0' })), res);
  await h.drain();

  assert.equal(res.out.body.status, STATUSES.SKIPPED_INVALID);
  assert.equal(h.slackCalls.length, 0);
});

test('parseSaleAmount tolerates GHL money formatting and rejects junk', () => {
  assert.equal(parseSaleAmount('$31,500.00'), 31500);
  assert.equal(parseSaleAmount('31500'), 31500);
  assert.equal(parseSaleAmount(' 42000 '), 42000);
  for (const bad of ['0', '-5', '', 'abc', null, undefined, '{{contact.lp_gross_sale_amount}}']) {
    assert.equal(parseSaleAmount(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

// ═════════════════════════════════════════════════════════════════
// 7. Bad or missing bearer → 401, no row
// ═════════════════════════════════════════════════════════════════
test('a bad or missing bearer is 401 and writes no row', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);

  for (const token of [null, 'wrong_token_0123456789', '']) {
    const res = makeRes();
    await handler(req(payload(), token), res);
    assert.equal(res.out.statusCode, 401, `token ${JSON.stringify(token)} must be rejected`);
  }
  assert.equal(db.announcements.length, 0, 'a rejected request writes nothing');
  assert.equal(h.slackCalls.length, 0);
});

test('an unset SALE_ANNOUNCE_TOKEN fails CLOSED', () => {
  // The shared authenticate() middleware passes everything through when its
  // token is unset. This endpoint must not: it posts to a channel the whole
  // company reads.
  const verdict = checkSaleBearer({ headers: { authorization: 'Bearer anything' } }, '');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'token_not_configured');
  assert.equal(verdict.fingerprint.token_configured, false);
});

test('the auth fingerprint never leaks the token', () => {
  const v = checkSaleBearer({ headers: { authorization: 'Bearer nope' } }, TOKEN);
  assert.equal(v.ok, false);
  const serialized = JSON.stringify(v);
  assert.ok(!serialized.includes(TOKEN), 'expected token must not appear');
  assert.ok(!serialized.includes('nope'), 'provided token must not appear');
  assert.equal(v.fingerprint.provided_len, 4);
});

// ═════════════════════════════════════════════════════════════════
// 8. Facts timeout → degraded compose still posts
// ═════════════════════════════════════════════════════════════════
test('degraded facts still post the sale', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, { facts: async () => ({ degraded: true, reason: 'mtd_timeout' }) });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(db.announcements[0].status, STATUSES.POSTED);
  assert.equal(h.slackCalls.length, 1);
  assert.equal(db.announcements[0].facts_json.degraded, true);
});

test('a facts function that THROWS still posts the sale', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, { facts: async () => { throw new Error('supabase exploded'); } });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(db.announcements[0].status, STATUSES.POSTED);
  assert.equal(h.slackCalls.length, 1);
});

// ═════════════════════════════════════════════════════════════════
// 9. Empty model output → static fallback posts
// ═════════════════════════════════════════════════════════════════
test('an empty model response falls back to the approved static line', async () => {
  const { generateSaleAnnouncement } = await import('../src/notifications/sale-announcement-body-generator.js');
  const out = await generateSaleAnnouncement(
    { repDisplayName: 'Tim O’Connor', saleAmount: 31500, facts: { degraded: true } },
    { llm: async () => ({ text: '   ', model: 'stub' }), logger: quietLogger },
  );
  assert.equal(out.source, 'fallback');
  assert.equal(out.reason, 'empty');
  assert.ok(out.text.length > 0);
  assert.ok(!out.text.includes('undefined'));
  // The fallback names nobody, so it can never misname a rep.
  assert.ok(!/Tim/.test(out.text));
});

test('a model that throws falls back, and never throws onward', async () => {
  const { generateSaleAnnouncement } = await import('../src/notifications/sale-announcement-body-generator.js');
  const out = await generateSaleAnnouncement(
    { repDisplayName: 'Tim', saleAmount: 1000, facts: { degraded: true } },
    { llm: async () => { throw new Error('529 overloaded'); }, logger: quietLogger },
  );
  assert.equal(out.source, 'fallback');
  assert.match(out.reason, /llm_failed/);
});

// ═════════════════════════════════════════════════════════════════
// 10. Slack failure → slack_failed, ops alert, endpoint still 200
// ═════════════════════════════════════════════════════════════════
test('a Slack outage marks the row, alerts ops, and still returned 200', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, {
    post: async () => ({ ok: false, ts: null, channel: 'C_SALES', error: '500', attempts: 3 }),
  });
  const handler = makeSaleAnnouncementHandler(h.deps);

  const res = makeRes();
  await handler(req(payload()), res);
  assert.equal(res.out.statusCode, 200, 'GHL is told 200 before Slack is ever tried');

  await h.drain();

  const row = db.announcements[0];
  assert.equal(row.status, STATUSES.SLACK_FAILED);
  assert.match(row.error_message, /slack:500/);
  assert.equal(h.opsAlerts.length, 1, 'a dropped sale is never silent');
  assert.equal(h.opsAlerts[0].rep_display_name, 'Tim O’Connor');
  // The message survives on the row so it can be reposted without recomposing.
  assert.ok(row.message_text);
});

test('Slack retries a transient failure then succeeds, reusing the same text', async () => {
  let calls = 0;
  const seen = [];
  const res = await postSaleAnnouncement('🔥 one sale', {
    channelId: 'C_SALES',
    delayMs: 0,
    wait: async () => {},
    logger: quietLogger,
    post: async (text) => {
      seen.push(text);
      calls += 1;
      return calls < 3
        ? { ok: false, ts: null, channel: 'C_SALES', error: 'ratelimited' }
        : { ok: true, ts: 'ts-9', channel: 'C_SALES', error: null };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(new Set(seen).size, 1, 'retry must reuse the composed text, never recompose');
});

test('a permanent Slack refusal is not retried; a transient one is', async () => {
  // invalid_auth answers identically every time — three attempts would only
  // delay the ops alert by fifteen seconds on the likeliest misconfiguration.
  let perm = 0;
  const p = await postSaleAnnouncement('x', {
    channelId: 'C_SALES', delayMs: 0, wait: async () => {}, logger: quietLogger,
    post: async () => { perm += 1; return { ok: false, ts: null, channel: 'C_SALES', error: 'invalid_auth', threw: false }; },
  });
  assert.equal(p.ok, false);
  assert.equal(perm, 1, 'a permanent refusal is attempted once');
  assert.equal(p.attempts, 1, 'and reports one attempt, not the configured three');

  // A transport throw is exactly what the retry exists for.
  let threw = 0;
  const t = await postSaleAnnouncement('x', {
    channelId: 'C_SALES', delayMs: 0, wait: async () => {}, logger: quietLogger,
    post: async () => { threw += 1; return { ok: false, ts: null, channel: 'C_SALES', error: 'ECONNRESET', threw: true }; },
  });
  assert.equal(t.ok, false);
  assert.equal(threw, 3, 'a transport failure uses every attempt');

  // Rate limiting is a refusal, but a transient one.
  let rl = 0;
  await postSaleAnnouncement('x', {
    channelId: 'C_SALES', delayMs: 0, wait: async () => {}, logger: quietLogger,
    post: async () => { rl += 1; return { ok: false, ts: null, channel: 'C_SALES', error: 'ratelimited', threw: false }; },
  });
  assert.equal(rl, 3, 'ratelimited must NOT be treated as permanent');
});

test('an unset sales channel does not burn three retries', async () => {
  const res = await postSaleAnnouncement('x', { channelId: '', logger: quietLogger });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_channel');
  assert.equal(res.attempts, 0);
});

// ═════════════════════════════════════════════════════════════════
// 11. repNameKey bridges the LP/GHL name formats
// ═════════════════════════════════════════════════════════════════
test('repNameKey matches "Last, First" against "First Last"', () => {
  assert.equal(repNameKey('O’Connor, Tim'), repNameKey('Tim O’Connor'));
  assert.equal(repNameKey('Inlay, Douglas'), repNameKey('Douglas Inlay'));
  assert.equal(repNameKey('Marino, Ethan'), repNameKey('Ethan Marino'));
  // Apostrophe styles must not matter either.
  assert.equal(repNameKey("O'Connor, Tim"), repNameKey('O’Connor, Tim'));
  // Different reps must not collide.
  assert.notEqual(repNameKey('Inlay, Douglas'), repNameKey('Inlay, Katie'));
  assert.equal(repNameKey(''), null);
  assert.equal(repNameKey(null), null);
});

test('computeStreak counts consecutive selling days and anchors on yesterday', () => {
  const now = new Date('2026-09-16T15:00:00Z');
  // Sold today and the two days before → 3.
  assert.equal(computeStreak(['2026-09-16T10:00:00Z', '2026-09-15T10:00:00Z', '2026-09-14T10:00:00Z'], now), 3);
  // No sale yet today, but Mon-Tue-Wed → still 3, because this runs BEFORE the
  // first sale of the day is in the data.
  assert.equal(computeStreak(['2026-09-15T10:00:00Z', '2026-09-14T10:00:00Z', '2026-09-13T10:00:00Z'], now), 3);
  // A gap breaks it.
  assert.equal(computeStreak(['2026-09-16T10:00:00Z', '2026-09-13T10:00:00Z'], now), 1);
  // Stale history is not a streak.
  assert.equal(computeStreak(['2026-08-01T10:00:00Z'], now), 0);
  assert.equal(computeStreak([], now), 0);
  // Two sales on one day are one day.
  assert.equal(computeStreak(['2026-09-16T09:00:00Z', '2026-09-16T17:00:00Z'], now), 1);
});

// ═════════════════════════════════════════════════════════════════
// 12. The two fallbacks never stamp a lead row
// ═════════════════════════════════════════════════════════════════
test('prospect_fallback and contact_fallback never write to lp_leads', async () => {
  assert.equal(canWriteBack('lead_id'), true);
  assert.equal(canWriteBack('lead_id_corrected'), true);
  assert.equal(canWriteBack('prospect_fallback'), false);
  assert.equal(canWriteBack('contact_fallback'), false);

  // End to end: a prospect with no lead rows must leave lp_leads untouched.
  const db = makeDb({ leads: [] });
  let stamped = 0;
  const h = makeDeps(db, { stamp: async () => { stamped += 1; return { written: true }; } });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(db.announcements[0].key_source, 'prospect_fallback');
  assert.equal(stamped, 0, 'a key we invented is not a lead we found');
  assert.equal(h.slackCalls.length, 1, 'the announcement still goes out');
});

test('contact_fallback keys on the UTC day so a later sale is not deduped', async () => {
  const db = makeDb({ leads: [] });
  const h = makeDeps(db);
  const resolved = await resolveLeadId(
    { contact_id: 'ghl_contact_1' },
    { ...h.deps, now: () => new Date('2026-09-16T23:59:00Z') },
  );
  assert.equal(resolved.key_source, 'contact_fallback');
  assert.equal(resolved.key_input, 'contact:ghl_contact_1:2026-09-16');
  assert.equal(dayStamp(new Date('2026-09-17T00:01:00Z')), '2026-09-17');
});

test('no identifier at all is a 400, not a silent drop', async () => {
  const db = makeDb({ leads: [] });
  const h = makeDeps(db);
  const handler = makeSaleAnnouncementHandler(h.deps);
  const res = makeRes();
  await handler(req({ rep_display_name: 'Tim', lp_gross_sale_amount: '100' }), res);
  assert.equal(res.out.statusCode, 400);
  assert.equal(db.announcements.length, 0);
});

// ═════════════════════════════════════════════════════════════════
// The close-date write
// ═════════════════════════════════════════════════════════════════
test('stampCloseDate fills blanks and never overwrites what LP owns', async () => {
  const db = makeDb({
    leads: [
      { lp_lead_id: 'A', close_date: null, job_value: null, closed_won: false },
      { lp_lead_id: 'B', close_date: '2026-01-05T00:00:00Z', job_value: 99999, closed_won: false },
    ],
  });
  const now = new Date('2026-09-16T15:00:00Z');

  await stampCloseDate({ leadId: 'A', amount: 31500, now }, { supabase: db.supabase, logger: quietLogger });
  const a = db.leadRows.find((r) => r.lp_lead_id === 'A');
  assert.equal(a.closed_won, true);
  assert.equal(a.close_date, now.toISOString());
  assert.equal(a.close_date_source, 'sale_announcement');
  assert.equal(a.job_value, 31500);

  await stampCloseDate({ leadId: 'B', amount: 31500, now }, { supabase: db.supabase, logger: quietLogger });
  const b = db.leadRows.find((r) => r.lp_lead_id === 'B');
  assert.equal(b.closed_won, true, 'the Sold branch is authoritative for closed_won');
  assert.equal(b.close_date, '2026-01-05T00:00:00Z', 'an existing close_date is never overwritten');
  assert.equal(b.close_date_source, undefined, 'and its provenance is left alone');
  assert.equal(b.job_value, 99999, 'LP stays the owner of a job_value it already has');
});

test('stampCloseDate on a missing lead is a no-op, not a throw', async () => {
  const db = makeDb({ leads: [] });
  const out = await stampCloseDate(
    { leadId: 'ghost', amount: 1, now: new Date() },
    { supabase: db.supabase, logger: quietLogger },
  );
  assert.equal(out.written, false);
  assert.equal(out.reason, 'lead_unreadable');
});

test('the lead is stamped BEFORE facts are gathered', async () => {
  // The ordering contract: "including this sale" falls out of the data only if
  // close_date is already written when the facts query runs.
  const order = [];
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, {
    stamp: async () => { order.push('stamp'); return { written: true }; },
    facts: async () => { order.push('facts'); return { degraded: true }; },
  });
  await completeAnnouncement(
    { rowId: 1, repDisplayName: 'Tim', amount: 100, leadId: '573581', keySource: 'lead_id' },
    h.deps,
  );
  assert.deepEqual(order, ['stamp', 'facts']);
});

// ═════════════════════════════════════════════════════════════════
// Disabled flag
// ═════════════════════════════════════════════════════════════════
test('SALE_ANNOUNCE_ENABLED unset records disabled and still returns 200', async () => {
  const prev = process.env.SALE_ANNOUNCE_ENABLED;
  process.env.SALE_ANNOUNCE_ENABLED = 'false';
  try {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
    const h = makeDeps(db);
    const handler = makeSaleAnnouncementHandler(h.deps);
    const res = makeRes();
    await handler(req(payload()), res);
    await h.drain();

    assert.equal(res.out.statusCode, 200, 'GHL must not retry a deliberate no-op');
    assert.equal(res.out.body.status, STATUSES.DISABLED);
    assert.equal(db.announcements[0].status, STATUSES.DISABLED);
    assert.equal(h.slackCalls.length, 0);
  } finally {
    process.env.SALE_ANNOUNCE_ENABLED = prev;
  }
});

// ═════════════════════════════════════════════════════════════════
// Payload shape + key derivation
// ═════════════════════════════════════════════════════════════════
test('extractSaleFields reads a flat body and a customData wrapper', () => {
  const flat = extractSaleFields(payload());
  assert.equal(flat.lp_lead_id, '573581');
  assert.equal(flat.rep_display_name, 'Tim O’Connor');

  const wrapped = extractSaleFields({ customData: payload() });
  assert.deepEqual(wrapped, flat);

  // GHL also sends customData as a JSON string depending on how the action is
  // configured. Unparsed this reads as "no fields" and every sale 400s.
  const asString = extractSaleFields({ customData: JSON.stringify(payload()) });
  assert.deepEqual(asString, flat);

  // Unparseable customData must not throw; it degrades to the top level.
  const broken = extractSaleFields({ customData: '{not json', contact_id: 'c1' });
  assert.equal(broken.contact_id, 'c1');

  const empty = extractSaleFields({ lp_lead_id: '   ', contact_id: 'c1' });
  assert.equal(empty.lp_lead_id, null, 'whitespace is not a value');
  assert.equal(empty.contact_id, 'c1');
});

test('idempotencyKey rounds the amount and separates lead from prospect keys', () => {
  assert.equal(idempotencyKey('573581', 31500), idempotencyKey('573581', 31500.4));
  assert.notEqual(idempotencyKey('573581', 31500), idempotencyKey('573581', 42000));
  assert.notEqual(idempotencyKey('573581', 31500), idempotencyKey('601244', 31500));
  assert.notEqual(idempotencyKey('prospect:9', 31500), idempotencyKey('573581', 31500));
  assert.match(idempotencyKey('573581', 1), /^[0-9a-f]{64}$/);
});

// ═════════════════════════════════════════════════════════════════
// Composer validation + the celebration-only rule
// ═════════════════════════════════════════════════════════════════
test('validateMessage hard-rejects breakage and only warns on tone', () => {
  assert.equal(validateMessage('🔥 Tim puts $31,500 on the board.').ok, true);

  assert.equal(validateMessage('').ok, false);
  assert.equal(validateMessage('🔥 {{contact.rep_display_name}} closed.').reason, 'unresolved_merge_tag');
  assert.equal(validateMessage('🔥 undefined puts $0 on the board.').reason, 'null_leak');
  assert.match(validateMessage('🎉 Tim closed a sale.').reason, /banned_emoji/);
  assert.match(validateMessage(`🔥 ${'x'.repeat(400)}`).reason, /too_long/);

  // Tone: shipped, with a warning.
  const tone = validateMessage('🔥 Tim is crushing it with $31,500.');
  assert.equal(tone.ok, true, 'a banned word must not cost us a specific message');
  assert.deepEqual(tone.warnings, ['banned_word:crushing it']);
});

test('cleanMessage strips fences, quotes, markdown and newlines', () => {
  assert.equal(cleanMessage('```\n🔥 Tim closed.\n```'), '🔥 Tim closed.');
  assert.equal(cleanMessage('"🔥 Tim closed."'), '🔥 Tim closed.');
  assert.equal(cleanMessage('🔥 **Tim** closed.'), '🔥 Tim closed.');
  assert.equal(cleanMessage('🔥 Tim closed.\n\nBig day.'), '🔥 Tim closed. Big day.');
});

test('buildFactsBlock never hands the model a fact that could shame a rep', () => {
  assert.equal(buildFactsBlock({ degraded: true }), 'none');
  assert.equal(buildFactsBlock(null), 'none');

  // A bare low rank is exactly the fact the rulebook forbids — it must not even
  // reach the prompt.
  const low = buildFactsBlock({ degraded: false, rank: 41, rank_field: 48, mtd_sale_count: 1 });
  assert.ok(!low.includes('41'), 'a low rank must be filtered, not trusted to the prompt');
  assert.ok(!low.includes('48'), 'the field size invites the forbidden subtraction');

  // A climb and a top-3 standing are allowed. rank_field is REQUIRED for a
  // climb: without it we cannot tell whether the landing spot is respectable,
  // and per the repo's fail-closed doctrine unreadable data is never a wildcard
  // pass. buildRepFacts always sets it alongside a rank, so real facts qualify.
  assert.match(
    buildFactsBlock({ degraded: false, rank_climb: { from: 4, to: 2 }, rank_field: 40, rank: 2 }),
    /4 to 2/,
  );
  assert.ok(
    !/4 to 2/.test(buildFactsBlock({ degraded: false, rank_climb: { from: 4, to: 2 }, rank: 2 })),
    'a climb with an unknown field size is suppressed, not guessed at',
  );
  assert.match(buildFactsBlock({ degraded: false, rank: 1 }), /1st/);

  // Streak and record.
  const rich = buildFactsBlock({
    degraded: false, notable_streak: true, streak_days: 3, is_personal_record: true,
  });
  assert.match(rich, /3 consecutive days/);
  assert.match(rich, /largest sale/);
});

test('hasMilestone gates Structure F on a real achievement', () => {
  assert.equal(hasMilestone(null), false);
  assert.equal(hasMilestone({ degraded: true }), false);
  assert.equal(hasMilestone({ degraded: false, rank: 30 }), false);
  assert.equal(hasMilestone({ degraded: false, notable_streak: true }), true);
  assert.equal(hasMilestone({ degraded: false, is_personal_record: true }), true);
  assert.equal(hasMilestone({ degraded: false, rank_climb: { from: 5, to: 3 } }), true);
});

test('gitBlobSha matches git hash-object', () => {
  // `printf '' | git hash-object --stdin` is the well-known empty-blob sha.
  assert.equal(gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  // `printf 'hello' | git hash-object --stdin`
  assert.equal(gitBlobSha('hello'), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
});

test('the shipped rulebook carries all six structures and the comparison rule', async () => {
  const { loadRulebook, __resetRulebookCache } = await import('../src/notifications/sale-announcement-body-generator.js');
  __resetRulebookCache();
  const { system, sha } = loadRulebook();
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
    assert.ok(new RegExp(`^${letter} —`, 'm').test(system), `structure ${letter} missing`);
  }
  assert.match(system, /Comparisons may only ever be upward or neutral/);
  assert.match(system, /destroys more than a hundred good posts create/);
  // The human-facing preamble must not reach the model.
  assert.ok(!system.includes('Change it only by PR'));
  assert.match(sha, /^[0-9a-f]{40}$/);
  __resetRulebookCache();
});

// ═════════════════════════════════════════════════════════════════
// The threaded stats reply (2026-09-17)
// ═════════════════════════════════════════════════════════════════
test('the stats line posts as a reply in the announcement’s thread', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, {
    facts: async () => ({
      degraded: false, mtd_sale_count: 3, mtd_volume: 36300,
      rank: 41, rank_field: 50, team_mtd_volume: 4214968,
    }),
  });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(h.slackCalls.length, 1, 'one channel message');
  assert.equal(h.statsCalls.length, 1, 'one threaded reply');
  // The reply must carry the PARENT message's ts, or it lands as its own post.
  assert.equal(h.statsCalls[0].threadTs, 'ts-1');
  assert.match(h.statsCalls[0].text, /3 sales/);
  assert.match(h.statsCalls[0].text, /36,300/);
  assert.equal(db.announcements[0].slack_stats_ts, 'stats-1');
  assert.equal(db.announcements[0].status, STATUSES.POSTED);
});

test('a failed stats reply leaves the row posted and raises NO ops alert', async () => {
  // The sale reached the board. Losing the footnote is a log line, not an
  // incident — alerting on it is how a channel gets muted.
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, {
    facts: async () => ({ degraded: false, mtd_sale_count: 2, mtd_volume: 1000 }),
    postStats: async () => ({ ok: false, ts: null, error: 'ratelimited' }),
  });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(db.announcements[0].status, STATUSES.POSTED, 'still posted');
  assert.equal(db.announcements[0].slack_stats_ts, undefined, 'no ts recorded');
  assert.equal(h.opsAlerts.length, 0, 'a missing footnote must never page anyone');
});

test('a stats reply that THROWS cannot un-post the announcement', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, {
    facts: async () => ({ degraded: false, mtd_sale_count: 2, mtd_volume: 1000 }),
    postStats: async () => { throw new Error('socket hang up'); },
  });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(db.announcements[0].status, STATUSES.POSTED);
  assert.equal(h.opsAlerts.length, 0);
});

test('degraded facts post the sale with no stats reply at all', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, { facts: async () => ({ degraded: true, reason: 'mtd_timeout' }) });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(h.slackCalls.length, 1);
  assert.equal(h.statsCalls.length, 0, 'nothing countable, so nothing to reply with');
});

test('a rep’s first sale of the month still gets a stats reply', async () => {
  const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9' }] });
  const h = makeDeps(db, {
    facts: async () => ({ degraded: false, mtd_sale_count: 1, mtd_volume: 1500 }),
  });
  const handler = makeSaleAnnouncementHandler(h.deps);

  await handler(req(payload()), makeRes());
  await h.drain();

  assert.equal(h.statsCalls.length, 1);
  assert.match(h.statsCalls[0].text, /1 sale in/, 'singular, not "1 sales"');
});

test('postSaleStats never retries and never alerts', async () => {
  let calls = 0;
  const res = await postSaleStats('📊 stats', 'ts-parent', {
    channelId: 'C_SALES',
    logger: quietLogger,
    post: async (text, channel, opts) => {
      calls += 1;
      assert.equal(opts.threadTs, 'ts-parent', 'threadTs must reach postToSlack');
      return { ok: false, ts: null, error: 'ratelimited', threw: false };
    },
  });
  assert.equal(res.ok, false);
  assert.equal(calls, 1, 'exactly one attempt — the celebration already landed');
});

test('postSaleStats refuses to post without a parent ts', async () => {
  // Without thread_ts this would land as a second top-level message and double
  // the length of the board — the thing the threading exists to avoid.
  let called = false;
  const res = await postSaleStats('📊 stats', null, {
    channelId: 'C_SALES', logger: quietLogger,
    post: async () => { called = true; return { ok: true, ts: 'x' }; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_thread_ts');
  assert.equal(called, false, 'must not post at all rather than post unthreaded');
});

// ═════════════════════════════════════════════════════════════════
// formatStatsLine + the hardened rank-climb guard
// ═════════════════════════════════════════════════════════════════
test('formatStatsLine handles singular, plural and a missing team total', () => {
  const now = new Date('2026-09-17T16:48:00Z');
  const one = formatStatsLine('Craig Barela', { degraded: false, mtd_sale_count: 1, mtd_volume: 1500 }, now);
  assert.match(one, /^📊 Craig Barela — 1 sale in September, \$1,500\.$/);

  const many = formatStatsLine('Craig Barela', {
    degraded: false, mtd_sale_count: 3, mtd_volume: 36300, team_mtd_volume: 4214968,
  }, now);
  assert.match(many, /3 sales in September, \$36,300\./);
  assert.match(many, /Team month to date: \$4,214,968\./);

  assert.equal(formatStatsLine('X', { degraded: true }, now), null);
  assert.equal(formatStatsLine('X', null, now), null);
  assert.equal(formatStatsLine('X', { degraded: false, mtd_sale_count: 0 }, now), null);
});

test('a rank climb out of the bottom of the board is never stated', () => {
  // The real case, from live row 4 on 2026-09-17: a genuine climb that starts at
  // dead last. Stating it tells the floor exactly where they were.
  assert.equal(isCelebratableClimb({ from: 50, to: 41 }, 50), false);
  // The other real case, row 1: a climb that lands near the top.
  assert.equal(isCelebratableClimb({ from: 19, to: 6 }, 50), true);
  // Boundary: top third of 50 is 17.
  assert.equal(isCelebratableClimb({ from: 30, to: 17 }, 50), true);
  assert.equal(isCelebratableClimb({ from: 30, to: 18 }, 50), false);
  // Small fields keep a floor of 3 so 2nd place still counts.
  assert.equal(isCelebratableClimb({ from: 5, to: 3 }, 5), true);
  // Not a climb at all.
  assert.equal(isCelebratableClimb({ from: 6, to: 6 }, 50), false);
  assert.equal(isCelebratableClimb({ from: 3, to: 9 }, 50), false);
  assert.equal(isCelebratableClimb(null, 50), false);
  assert.equal(isCelebratableClimb({ from: 5, to: 1 }, null), false);
});

test('the FACTS block no longer carries any bookkeeping', () => {
  // This is the defect the whole change exists for. Fed the month total, the
  // model wrote "$1,500 today, $36,300 on the month" — a ledger entry.
  const ledgerish = buildFactsBlock({
    degraded: false, mtd_sale_count: 3, mtd_volume: 36300,
    team_mtd_volume: 4214968, rank: 41, rank_field: 50, rank_climb: null,
  });
  assert.equal(ledgerish, 'none', 'nothing to cheer here, so the sale stands alone');

  // Milestones still reach the model.
  const rich = buildFactsBlock({
    degraded: false, rank_climb: { from: 19, to: 6 }, rank_field: 50,
    is_personal_record: true, notable_streak: true, streak_days: 4,
    mtd_sale_count: 9, mtd_volume: 500000, team_mtd_volume: 4214968,
  });
  assert.match(rich, /19 to 6/);
  assert.match(rich, /largest sale/);
  assert.match(rich, /4 consecutive days/);
  assert.ok(!rich.includes('500,000'), 'month volume must not appear');
  assert.ok(!rich.includes('4,214,968'), 'team total must not appear');
  assert.ok(!/9 sales/.test(rich), 'month count must not appear');
});

// ═════════════════════════════════════════════════════════════════
// The market channel (2026-09-24)
//
// Every sale landed in #sales-all only — rows 80–90 (FTMYR / JAX / STPET / ORL)
// all carry C0C0AQMARE1 — because nothing ever looked up a market. With
// SALE_ANNOUNCE_MARKET_ENABLED the same text also posts to #sales-<market>,
// and a market failure must never un-post the sale.
// ═════════════════════════════════════════════════════════════════
const C_SALES_FTMYR = 'C_SALES_FTMYR';
const C_SALES_FTLAU = 'C_SALES_FTLAU';

async function withMarketFlag(value, fn) {
  const prev = process.env.SALE_ANNOUNCE_MARKET_ENABLED;
  if (value === undefined) delete process.env.SALE_ANNOUNCE_MARKET_ENABLED;
  else process.env.SALE_ANNOUNCE_MARKET_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SALE_ANNOUNCE_MARKET_ENABLED;
    else process.env.SALE_ANNOUNCE_MARKET_ENABLED = prev;
  }
}

/** makeDeps plus stubs for the market post, and a stats stub that records the channel. */
function makeMarketDeps(db, overrides = {}) {
  const marketCalls = [];
  const marketAlerts = [];
  const statsCalls = [];
  const h = makeDeps(db, {
    facts: async () => ({ degraded: false, mtd_sale_count: 3, mtd_volume: 36300 }),
    resolveMarket: async (market) => ({ FTMYR: C_SALES_FTMYR, FTLAU: C_SALES_FTLAU })[market] || null,
    postMarket: async (text, channel) => {
      marketCalls.push({ text, channel });
      return { ok: true, ts: `mts-${marketCalls.length}`, channel, error: null, attempts: 1 };
    },
    postStats: async (text, threadTs, d = {}) => {
      statsCalls.push({ text, threadTs, channelId: d.channelId ?? null });
      return { ok: true, ts: `stats-${statsCalls.length}`, error: null };
    },
    marketAlert: async (detail) => { marketAlerts.push(detail); return { ok: true }; },
    ...overrides,
  });
  return { ...h, marketCalls, marketAlerts, statsCalls };
}

async function runSale(h) {
  const handler = makeSaleAnnouncementHandler(h.deps);
  await handler(req(payload()), makeRes());
  await h.drain();
}

test('an FTMYR sale posts to #sales-all AND #sales-fortmyers with identical text', async () => {
  await withMarketFlag('true', async () => {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'FTMYR' }] });
    const h = makeMarketDeps(db);
    await runSale(h);

    assert.equal(h.slackCalls.length, 1, 'one rollup post');
    assert.equal(h.marketCalls.length, 1, 'one market post');
    assert.equal(h.marketCalls[0].channel, C_SALES_FTMYR);
    assert.equal(h.marketCalls[0].text, h.slackCalls[0], 'never recomposed');

    const row = db.announcements[0];
    assert.equal(row.status, STATUSES.POSTED);
    assert.equal(row.slack_channel, 'C_SALES', '#sales-all fields unchanged');
    assert.equal(row.market_code, 'FTMYR');
    assert.equal(row.slack_market_channel, C_SALES_FTMYR);
    assert.equal(row.slack_market_ts, 'mts-1');
    assert.equal(row.market_error, null);
    assert.equal(h.opsAlerts.length, 0);
  });
});

test('a BOCA sale posts to #sales-all AND #sales-fortlauderdale (real alias)', async () => {
  // Uses the REAL resolveSaleMarketChannel → resolveSlackChannels path, so the
  // BOCA → FTLAU alias in slack.js is what is under test, not a stub of it.
  __resetSlackCacheForTests();
  __setSlackClientForTests({
    from(table) {
      return {
        select: async () => {
          if (table === 'slack_channels') {
            return { data: [
              { channel_name: 'sales-all', slack_channel_id: 'C_SALES' },
              { channel_name: 'sales-fortmyers', slack_channel_id: C_SALES_FTMYR },
              { channel_name: 'sales-fortlauderdale', slack_channel_id: C_SALES_FTLAU },
            ] };
          }
          if (table === 'slack_market_slugs') {
            return { data: [
              { market_code: 'FTMYR', slug: 'fortmyers' },
              { market_code: 'FTLAU', slug: 'fortlauderdale' },
            ] };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
    },
  });
  try {
    await withMarketFlag('true', async () => {
      const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'BOCA' }] });
      const h = makeMarketDeps(db, { resolveMarket: resolveSaleMarketChannel });
      await runSale(h);

      assert.equal(h.slackCalls.length, 1);
      assert.deepEqual(h.marketCalls.map((c) => c.channel), [C_SALES_FTLAU]);
      assert.equal(db.announcements[0].market_code, 'BOCA', 'the raw code is recorded');
      assert.equal(db.announcements[0].slack_market_channel, C_SALES_FTLAU);
    });
  } finally {
    __setSlackClientForTests(null);
    __resetSlackCacheForTests();
  }
});

test('resolveSaleMarketChannel never returns the rollup id', async () => {
  const resolveChannels = async () => ['C_ROLLUP'];
  assert.equal(await resolveSaleMarketChannel('ORL', { resolveChannels, rollupId: 'C_ROLLUP', logger: quietLogger }), null);
  assert.equal(await resolveSaleMarketChannel(null, { resolveChannels, rollupId: 'C_ROLLUP', logger: quietLogger }), null);
  const boom = async () => { throw new Error('db down'); };
  assert.equal(await resolveSaleMarketChannel('FTMYR', { resolveChannels: boom, logger: quietLogger }), null);
});

test('a lead with no branch posts to #sales-all only, cleanly', async () => {
  await withMarketFlag('true', async () => {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: null }] });
    const h = makeMarketDeps(db);
    await runSale(h);

    assert.equal(h.slackCalls.length, 1);
    assert.equal(h.marketCalls.length, 0);
    const row = db.announcements[0];
    assert.equal(row.status, STATUSES.POSTED);
    assert.equal(row.market_code, undefined);
    assert.equal(row.market_error, undefined, 'no market is not an error');
    assert.equal(h.opsAlerts.length + h.marketAlerts.length, 0);
  });
});

test('a market code with no channel is recorded, and the sale still posts', async () => {
  await withMarketFlag('true', async () => {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'ZZZ' }] });
    const h = makeMarketDeps(db);
    await runSale(h);

    assert.equal(h.marketCalls.length, 0);
    assert.equal(db.announcements[0].status, STATUSES.POSTED);
    assert.equal(db.announcements[0].market_code, 'ZZZ');
    assert.equal(db.announcements[0].market_error, 'no_market_channel');
  });
});

test('a market post refused with not_in_channel stays posted and pages ops once', async () => {
  await withMarketFlag('true', async () => {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'FTMYR' }] });
    const h = makeMarketDeps(db, {
      postMarket: async (text, channel) => ({ ok: false, ts: null, channel, error: 'not_in_channel', attempts: 1 }),
    });
    await runSale(h);

    const row = db.announcements[0];
    assert.equal(row.status, STATUSES.POSTED, 'the sale reached #sales-all');
    assert.equal(row.market_error, 'slack:not_in_channel after 1 attempts');
    assert.equal(row.slack_market_channel, C_SALES_FTMYR);
    assert.equal(row.slack_market_ts, undefined);
    assert.equal(h.marketAlerts.length, 1, 'one ops line naming the channel');
    assert.equal(h.marketAlerts[0].channel, C_SALES_FTMYR);
    assert.equal(h.opsAlerts.length, 0, 'not a dropped-sale alert');
    assert.equal(h.statsCalls.length, 1, 'no stats reply under a post that never landed');
  });
});

test('a transient market failure is recorded but does not page ops', async () => {
  await withMarketFlag('true', async () => {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'FTMYR' }] });
    const h = makeMarketDeps(db, {
      postMarket: async (text, channel) => ({ ok: false, ts: null, channel, error: 'ratelimited', attempts: 3 }),
    });
    await runSale(h);
    assert.equal(db.announcements[0].status, STATUSES.POSTED);
    assert.equal(db.announcements[0].market_error, 'slack:ratelimited after 3 attempts');
    assert.equal(h.marketAlerts.length, 0);
  });
});

test('a market post that THROWS cannot un-post the announcement', async () => {
  await withMarketFlag('true', async () => {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'FTMYR' }] });
    const h = makeMarketDeps(db, { postMarket: async () => { throw new Error('socket hang up'); } });
    await runSale(h);
    assert.equal(db.announcements[0].status, STATUSES.POSTED);
    assert.equal(h.opsAlerts.length, 0);
  });
});

test('postSaleToMarket does not retry not_in_channel, and does retry a transient error', async () => {
  const calls = [];
  const refused = await postSaleToMarket('hello', C_SALES_FTMYR, {
    post: async (text, channel) => { calls.push(channel); return { ok: false, channel, error: 'not_in_channel', threw: false }; },
    wait: async () => {},
    logger: quietLogger,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.attempts, 1);
  assert.deepEqual(calls, [C_SALES_FTMYR]);

  let n = 0;
  const flaky = await postSaleToMarket('hello', C_SALES_FTMYR, {
    post: async (text, channel) => (++n < 2
      ? { ok: false, channel, error: 'ratelimited', threw: false }
      : { ok: true, ts: 'm1', channel, error: null }),
    wait: async () => {},
    logger: quietLogger,
  });
  assert.equal(flaky.ok, true);
  assert.equal(flaky.attempts, 2);
  assert.equal(flaky.channel, C_SALES_FTMYR);
});

test('flag off: exactly one post, no market read, no market fields', async () => {
  await withMarketFlag(undefined, async () => {
    let reads = 0;
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'FTMYR' }] });
    const h = makeMarketDeps(db, { readMarket: async () => { reads++; return 'FTMYR'; } });
    await runSale(h);

    assert.equal(h.slackCalls.length, 1);
    assert.equal(h.marketCalls.length, 0);
    assert.equal(reads, 0, 'the off path does not even read the market');
    assert.equal(h.statsCalls.length, 1);
    const row = db.announcements[0];
    assert.equal(row.status, STATUSES.POSTED);
    for (const k of ['market_code', 'slack_market_channel', 'slack_market_ts', 'slack_market_stats_ts', 'market_error']) {
      assert.equal(row[k], undefined, `${k} untouched`);
    }
  });
});

test('the stats reply is threaded under EACH celebration, in that post’s channel', async () => {
  await withMarketFlag('true', async () => {
    const db = makeDb({ leads: [{ lp_lead_id: '573581', lp_prospect_id: 'prospect_9', lp_branch_id: 'FTMYR' }] });
    const h = makeMarketDeps(db);
    await runSale(h);

    assert.equal(h.statsCalls.length, 2);
    // Rollup reply: under the rollup ts, default (rollup) channel.
    assert.equal(h.statsCalls[0].threadTs, 'ts-1');
    assert.equal(h.statsCalls[0].channelId, null);
    // Market reply: under the market ts, in the market channel.
    assert.equal(h.statsCalls[1].threadTs, 'mts-1');
    assert.equal(h.statsCalls[1].channelId, C_SALES_FTMYR);
    assert.equal(h.statsCalls[0].text, h.statsCalls[1].text);

    const row = db.announcements[0];
    assert.equal(row.slack_stats_ts, 'stats-1');
    assert.equal(row.slack_market_stats_ts, 'stats-2');
  });
});
