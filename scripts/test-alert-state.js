/**
 * test-alert-state.js — durable, edge-triggered alert state (2026-09-04).
 *
 * THE DEFECT. Every watchdog kept its "already announced" memory in a
 * process-local variable and suppressed by elapsed time. A cooldown that
 * lapsed while the condition was STILL bad re-announced it, and any restart
 * wiped the memory entirely. Measured over 18h on 2026-09-03/04: the GHL
 * limiter alert fired 11x, the capacity watchdog 4x in 90min, agentic-silence
 * 4x in 90min, LP report #134 6x — every one of them a single ongoing
 * condition, re-announcing.
 *
 * What is asserted here is the contract that makes the layer safe to leave on:
 * one card per incident across restarts and replicas, exactly one recovery and
 * only if the alert was actually seen, `null` touching nothing at all, and a
 * DB failure degrading to the OLD cooldown rather than to silence or a storm.
 *
 * alert-state.js reads env at import, so the kill switch is exercised as its
 * own module instance via a query-string dynamic import (idiom:
 * test-groupme-dedup.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GROUPME_BOT_ID = 'test-bot';

const MOD = '../src/alert-state.js';
const { reportAlertCondition, humanDuration, formatRecovered, __resetAlertStateFallback } =
  await import(MOD);

/**
 * Stateful mock of alert_conditions.
 *
 * insert() models the real PRIMARY KEY: a second insert for the same
 * alert_key returns 23505 rather than overwriting. That collision is the whole
 * serialization mechanism — it is what makes two concurrent sweeps safe.
 *
 * update() models a guarded UPDATE ... RETURNING: `.select()` resolves to only
 * the rows that actually matched every filter, which is what makes the
 * clear/re-arm/remind transitions compare-and-swap rather than read-modify-write.
 *
 * `fail` forces an error onto one operation: 'insert', 'update' or 'throw'.
 */
function mockClient(rows = new Map(), { fail = null } = {}) {
  const match = (row, filters) => filters.every(([op, col, val]) => {
    const v = row[col];
    if (op === 'eq') return v === val;
    if (op === 'lt') return v != null && String(v) < String(val);
    return false;
  });

  const builder = (kind, patch) => {
    const filters = [];
    const run = () => {
      if (fail === 'throw') throw new Error('client exploded');
      if (fail === 'update') return { data: null, error: { message: 'update boom' } };
      const hits = [...rows.values()].filter((r) => match(r, filters));
      if (kind === 'delete') for (const r of hits) rows.delete(r.alert_key);
      else for (const r of hits) Object.assign(r, patch);
      return { data: hits.map((r) => ({ ...r })), error: null };
    };
    const self = {
      eq: (c, v) => { filters.push(['eq', c, v]); return self; },
      lt: (c, v) => { filters.push(['lt', c, v]); return self; },
      select: () => self,
      then: (res, rej) => { try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).catch(rej); } },
    };
    return self;
  };

  return {
    from: () => ({
      insert: (row) => Promise.resolve().then(() => {
        if (fail === 'throw') throw new Error('client exploded');
        if (fail === 'insert') return { error: { message: 'insert boom', code: '42P01' } };
        if (rows.has(row.alert_key)) return { error: { code: '23505', message: 'duplicate key' } };
        rows.set(row.alert_key, { ...row });
        return { error: null };
      }),
      update: (patch) => builder('update', patch),
      delete: () => builder('delete'),
    }),
  };
}

/** A condition reporter bound to one shared table + one capture array. */
function harness({ rows = new Map(), fail = null } = {}) {
  const sent = [];
  const client = mockClient(rows, { fail });
  const call = (active, extra = {}) => reportAlertCondition({
    key: 'test:condition',
    active,
    label: 'the thing',
    text: () => 'ALERT BODY',
    client,
    send: async (body) => { sent.push(body); return { sent: true }; },
    ...extra,
  });
  return { rows, sent, call, client };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── The core contract ──────────────────────────────────────────────────

test('fires ONCE on entry, then stays silent however long it persists', async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) await h.call(true, { nowMs: i * 5 * 60000 });
  assert.deepEqual(h.sent, ['ALERT BODY'], '20 sweeps of one condition is one card');
});

test('survives a restart — the whole point of moving state to the database', async () => {
  const rows = new Map();
  await harness({ rows }).call(true);
  // A fresh module instance is a redeployed process. The table is what remembers.
  const restarted = await import(`${MOD}?restart=1`);
  const sent = [];
  const res = await restarted.reportAlertCondition({
    key: 'test:condition',
    active: true,
    text: () => 'ALERT BODY',
    client: mockClient(rows),
    send: async (b) => { sent.push(b); return { sent: true }; },
  });
  assert.equal(res.action, 'silent');
  assert.deepEqual(sent, [], 'a redeploy must not re-announce a live incident');
});

test('two concurrent sweeps produce exactly one card', async () => {
  const rows = new Map();
  const a = harness({ rows });
  const b = harness({ rows });
  const [ra, rb] = await Promise.all([a.call(true), b.call(true)]);
  assert.equal(a.sent.length + b.sent.length, 1, 'the PK collision serializes them');
  assert.equal([ra, rb].filter((r) => r.action === 'fired').length, 1);
});

test('recovery is announced exactly once, and only after a real alert', async () => {
  const h = harness();
  await h.call(true);
  const r1 = await h.call(false);
  const r2 = await h.call(false);
  assert.equal(r1.action, 'recovered');
  assert.equal(r1.sent, true);
  assert.equal(r2.action, 'idle', 'the second healthy sweep is a no-op');
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /RECOVERED/);
  assert.match(h.sent[1], /the thing/);
});

test('a fresh incident after a recovery alerts again', async () => {
  const h = harness();
  await h.call(true);
  await h.call(false);
  const again = await h.call(true);
  assert.equal(again.action, 'fired');
  assert.equal(h.sent.length, 3, 'alert, recovery, alert — silence is scoped to one incident');
});

// ─── null: the guard against false all-clears ───────────────────────────

test('null never fires and never clears, from every prior state', async () => {
  // A failed read, a sweep outside the alerting window, or a deliberately
  // inhibited check is NOT evidence of health. Treating it as such would
  // announce a recovery for something still broken.
  const fresh = harness();
  assert.equal((await fresh.call(null)).action, 'noop');
  assert.deepEqual(fresh.sent, []);
  assert.equal(fresh.rows.size, 0, 'no row is even created');

  const firing = harness();
  await firing.call(true);
  assert.equal((await firing.call(null)).action, 'noop');
  assert.equal(firing.sent.length, 1, 'no recovery card from "I could not tell"');
  assert.equal(firing.rows.get('test:condition').state, 'firing', 'still open');

  const cleared = harness();
  await cleared.call(true);
  await cleared.call(false);
  const before = cleared.sent.length;
  assert.equal((await cleared.call(undefined)).action, 'noop');
  assert.equal(cleared.sent.length, before);
});

// ─── The first-deploy / kill-switch guarantee ───────────────────────────

test('a condition whose alert was never sent recovers SILENTLY', async () => {
  // Covers first deploy, kill-switch toggles, hand-seeded rows, and any fire
  // whose send failed: never announce the end of an incident nobody saw begin.
  const rows = new Map([['test:condition', {
    alert_key: 'test:condition', state: 'firing', notify_count: 0,
    first_seen_at: new Date(0).toISOString(),
  }]]);
  const h = harness({ rows });
  const res = await h.call(false);
  assert.equal(res.action, 'recovered');
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'no_alert_was_sent');
  assert.deepEqual(h.sent, []);
});

test('a send failure leaves the incident un-notified so the next sweep retries', async () => {
  const rows = new Map();
  const client = mockClient(rows);
  let attempts = 0;
  const sent = [];
  const call = () => reportAlertCondition({
    key: 'test:condition', active: true, text: () => 'ALERT BODY', client,
    send: async (b) => {
      attempts += 1;
      if (attempts === 1) throw new Error('GroupMe 500');
      sent.push(b);
      return { sent: true };
    },
  });
  await call();
  assert.deepEqual(sent, [], 'first attempt failed');
  assert.equal(rows.get('test:condition').notify_count, 0, 'so it is not marked as announced');
  // Silent while GroupMe is down, exactly one card when it comes back.
  await call();
  assert.equal(rows.get('test:condition').notify_count, 0);
});

// ─── Reminders: only where a human must act ─────────────────────────────

test('remindMs 0 never re-reminds, however long the condition runs', async () => {
  const h = harness();
  await h.call(true, { nowMs: 0 });
  for (const t of [HOUR, 6 * HOUR, DAY, 3 * DAY]) await h.call(true, { nowMs: t });
  assert.equal(h.sent.length, 1, 'live-ops states clear on their own — no nagging');
});

test('a daily reminder fires at 24h and NOT at 4h', async () => {
  const h = harness();
  await h.call(true, { nowMs: 0, remindMs: DAY });
  await h.call(true, { nowMs: 4 * HOUR, remindMs: DAY });
  assert.equal(h.sent.length, 1, 'four hours is not a day');
  await h.call(true, { nowMs: DAY + 60000, remindMs: DAY });
  assert.equal(h.sent.length, 2, 'still broken a day later — say so once');
  await h.call(true, { nowMs: DAY + 2 * HOUR, remindMs: DAY });
  assert.equal(h.sent.length, 2, 'and then quiet again');
});

test('a failed reminder retries on the next sweep, not a day later', async () => {
  // The reminder CAS moves last_notified_at forward to claim the send. If the
  // send then fails, winding it back only to now-1 would leave it un-due until
  // the NEXT full interval — the nag would silently skip a day.
  const rows = new Map();
  const client = mockClient(rows);
  const sent = [];
  let failNext = false;
  const call = (nowMs) => reportAlertCondition({
    key: 'test:condition', active: true, text: () => 'ALERT BODY', client, remindMs: DAY,
    send: async (b) => {
      if (failNext) throw new Error('GroupMe 500');
      sent.push(b);
      return { sent: true };
    },
    nowMs,
  });

  await call(0);
  assert.equal(sent.length, 1);
  failNext = true;
  await call(DAY + 60000);
  assert.equal(sent.length, 1, 'the reminder send failed');
  failNext = false;
  await call(DAY + 2 * 60000);
  assert.equal(sent.length, 2, 'so it is due again two minutes later, not tomorrow');
});

test('the alert body is not built when the sweep is silent', async () => {
  // Bodies can be expensive to build. A silent sweep must cost nothing.
  const h = harness();
  let built = 0;
  const text = () => { built += 1; return 'ALERT BODY'; };
  await h.call(true, { text });
  await h.call(true, { text });
  await h.call(true, { text });
  assert.equal(built, 1, 'built once, for the one card actually sent');
});

// ─── Failure posture: firing degrades, clearing stays shut ──────────────

test('a broken state table degrades firing to the OLD cooldown, not to a storm', async () => {
  __resetAlertStateFallback();
  const h = harness({ fail: 'insert' });
  const r1 = await h.call(true, { nowMs: 0, fallbackCooldownMs: 15 * 60000 });
  assert.equal(r1.action, 'fallback_fired');
  assert.equal(h.sent.length, 1, 'a missed page is the worse failure — still send');

  const r2 = await h.call(true, { nowMs: 60000, fallbackCooldownMs: 15 * 60000 });
  assert.equal(r2.action, 'fallback_silent');
  assert.equal(h.sent.length, 1, 'but bounded by the cooldown it replaced — never a storm');

  await h.call(true, { nowMs: 16 * 60000, fallbackCooldownMs: 15 * 60000 });
  assert.equal(h.sent.length, 2, 'exactly the pre-2026-09-04 behavior while the DB is down');
});

test('a client that throws also degrades rather than dying', async () => {
  __resetAlertStateFallback();
  const h = harness({ fail: 'throw' });
  const res = await h.call(true, { fallbackCooldownMs: 0 });
  assert.equal(res.action, 'fallback_fired');
  assert.equal(h.sent.length, 1);
});

test('clearing fails CLOSED — a false all-clear is worse than a missing one', async () => {
  const rows = new Map();
  await harness({ rows }).call(true);
  const broken = harness({ rows, fail: 'update' });
  const res = await broken.call(false);
  assert.equal(res.sent, false);
  assert.deepEqual(broken.sent, [], 'never claim recovery we could not record');
});

test('ALERT_STATE_ENABLED=false drops straight onto the fallback cooldown', async () => {
  process.env.ALERT_STATE_ENABLED = 'false';
  const off = await import(`${MOD}?killswitch=1`);
  delete process.env.ALERT_STATE_ENABLED;

  const sent = [];
  const send = async (b) => { sent.push(b); return { sent: true }; };
  const args = { key: 'k', active: true, text: () => 'BODY', send, fallbackCooldownMs: 15 * 60000 };
  await off.reportAlertCondition({ ...args, nowMs: 0 });
  await off.reportAlertCondition({ ...args, nowMs: 60000 });
  assert.equal(sent.length, 1, 'today’s behavior exactly, with no redeploy needed');
});

// ─── Presentation ───────────────────────────────────────────────────────

test('humanDuration reads like an operator wrote it', () => {
  assert.equal(humanDuration(45 * 1000), '45s');
  assert.equal(humanDuration(18 * 60000), '18m');
  assert.equal(humanDuration(HOUR + 42 * 60000), '1h 42m');
  assert.equal(humanDuration(2 * DAY + 3 * HOUR), '2d 3h');
  assert.equal(humanDuration(-5), '0s', 'clock skew never renders as nonsense');
});

test('the recovery card is one line and carries the outage length', () => {
  const opened = new Date(1_000_000);
  const card = formatRecovered('GHL rate limiter healthy again', opened, 1_000_000 + HOUR + 42 * 60000);
  assert.equal(card, '✅ RECOVERED — GHL rate limiter healthy again (was firing 1h 42m)');
  assert.ok(!card.includes('\n'), 'good news does not need a whole card');
  assert.match(formatRecovered('x', null), /^✅ RECOVERED — x$/, 'no duration, no parenthetical');
});
