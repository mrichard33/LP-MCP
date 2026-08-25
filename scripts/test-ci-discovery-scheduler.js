/**
 * Tests — the poller must never lose a call it skipped
 * scripts/test-ci-discovery-scheduler.js
 *
 * WHY THIS EXISTS. `discoverCalls` had exactly one caller in the repo —
 * POST /ci/discover — so calls entered Call Intelligence only when a human
 * asked. On 2026-08-25 every downstream stage was healthy and the newest row in
 * ci_calls was still Aug 22: the pipeline was fine, the front door was shut.
 *
 * ── THE THREE THINGS THAT MUST NOT REGRESS ─────────────────────────────────
 *
 * 1. QUIET HOURS MUST NOT ADVANCE THE CURSOR. Skipping the pull is the easy
 *    half. Leaving the cursor alone is what makes the 8am tick span the night
 *    rather than start fresh from it and lose it silently.
 *
 * 2. A FAILED CHUNK MUST NOT ADVANCE PAST ITSELF. discoverCalls upserts ONCE at
 *    the end of its whole span (discovery.js:534-542), so a span that throws
 *    part-way writes NOTHING. The scheduler chunks and checkpoints so a failure
 *    costs one chunk, and the next tick re-asks for exactly the remainder.
 *
 * 3. THE COLD-START CURSOR COMES FROM max(call_start). Using created_at — the
 *    insert time, always later than the calls it covers — would start ahead of
 *    reality and under-cover permanently, with nothing to show for it.
 *
 * No fake timers: `now`, `db` and `discover` are all injected, which is the
 * house convention.
 *
 * Run: node --test scripts/test-ci-discovery-scheduler.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readDiscoverySchedulerEnv, isQuietHour, planWindow, newestCallStart,
  hadDialerActivity, completenessShortfall, runDiscoveryTick,
  __resetDiscoverySchedulerForTest,
} from '../src/jobs/ci-discovery-scheduler.js';

const H = 3600_000;
const iso = (d) => new Date(d).toISOString();

/** Pinned instants. 14:00Z = 10:00 ET (EDT) — inside business hours. */
const NOON_ET = new Date('2026-08-25T16:00:00.000Z');
const MIDNIGHT_ET = new Date('2026-08-25T04:00:00.000Z'); // 00:00 ET — quiet

const OPTS = readDiscoverySchedulerEnv({});

/** db double: newest call, webhook activity, and nothing else. */
function fakeDb({ newest = null, activity = 1, callsError = null, eventsError = null } = {}) {
  return {
    from(table) {
      if (table === 'ci_calls') {
        const chain = {
          select() { return chain; },
          order() { return chain; },
          limit: async () => ({ data: newest ? [{ call_start: newest }] : [], error: callsError }),
        };
        return chain;
      }
      const chain = {
        select() { return chain; },
        gte() { return chain; },
        lt: async () => ({ count: activity, error: eventsError }),
      };
      return chain;
    },
  };
}

test.beforeEach(() => __resetDiscoverySchedulerForTest());

// ─── the knobs ──────────────────────────────────────────────────────────────

test('it ships DISARMED — arming is a deliberate act', () => {
  // An armed poller on a wrong credential hammers Five9 every 15 minutes and
  // locks the account the entire phone room dials on.
  assert.equal(readDiscoverySchedulerEnv({}).enabled, false);
  assert.equal(readDiscoverySchedulerEnv({ CI_DISCOVERY_ENABLED: 'true' }).enabled, true);
});

test('the defaults are the ones Mark asked for', () => {
  const d = readDiscoverySchedulerEnv({});
  assert.equal(d.intervalMs, 15 * 60 * 1000, 'every 15 minutes');
  assert.equal(d.quietStartHourEt, 22);
  assert.equal(d.quietEndHourEt, 8);
  assert.equal(d.requireActivity, true);
});

test('nonsense and dangerous values fall back to the defaults', () => {
  assert.equal(readDiscoverySchedulerEnv({ CI_DISCOVERY_INTERVAL_MS: 'soon' }).intervalMs, 900000);
  assert.equal(readDiscoverySchedulerEnv({ CI_DISCOVERY_INTERVAL_MS: '5' }).intervalMs, 900000,
    'a 5ms poll would DoS the report API');
  assert.equal(readDiscoverySchedulerEnv({ CI_DISCOVERY_MAX_CHUNKS_PER_TICK: '0' }).maxChunksPerTick, 4,
    'zero chunks would silently pull nothing forever');
  assert.equal(readDiscoverySchedulerEnv({ CI_DISCOVERY_QUIET_START_HOUR_ET: '99' }).quietStartHourEt, 22);
  assert.equal(readDiscoverySchedulerEnv({ CI_DISCOVERY_MAX_CATCHUP_HOURS: '120' }).maxCatchupHours, 120);
});

// ─── quiet hours ────────────────────────────────────────────────────────────

test('the 10pm–8am pause wraps midnight correctly', () => {
  for (const h of [22, 23, 0, 3, 7]) assert.equal(isQuietHour(h, 22, 8), true, `hour ${h}`);
  for (const h of [8, 9, 12, 17, 21]) assert.equal(isQuietHour(h, 22, 8), false, `hour ${h}`);
});

test('a non-wrapping window works too', () => {
  assert.equal(isQuietHour(3, 1, 5), true);
  assert.equal(isQuietHour(6, 1, 5), false);
});

test('start === end means NEVER quiet, not always', () => {
  // The opposite reading would silently disable discovery forever on a config
  // typo — precisely the failure this whole file exists to prevent.
  for (let h = 0; h < 24; h += 1) assert.equal(isQuietHour(h, 8, 8), false);
});

test('quiet hours is evaluated in ET, across the DST boundary', async () => {
  // EDT: 02:00Z is 22:00 ET the previous day → quiet.
  const edt = await runDiscoveryTick({ db: fakeDb(), env: { CI_DISCOVERY_ENABLED: 'true' }, now: new Date('2026-08-25T02:00:00Z') });
  assert.equal(edt.skipped, 'quiet_hours');
  // EST (January): 02:00Z is 21:00 ET → NOT quiet. A fixed offset would get
  // one of these two wrong.
  __resetDiscoverySchedulerForTest();
  const est = await runDiscoveryTick({
    db: fakeDb({ newest: '2026-01-15T01:00:00Z' }),
    env: { CI_DISCOVERY_ENABLED: 'true' },
    now: new Date('2026-01-15T02:00:00Z'),
    discover: async () => ({ ok: true, calls: 0 }),
  });
  assert.notEqual(est.skipped, 'quiet_hours');
});

test('THE REGRESSION: quiet hours does NOT advance the cursor', async () => {
  // This is what makes the 8am tick span the night. Advancing here would skip
  // the pull AND declare the window covered — the silent overnight gap.
  const env = { CI_DISCOVERY_ENABLED: 'true' };
  const db = fakeDb({ newest: '2026-08-24T20:00:00Z' });
  const pulled = [];
  const discover = async ({ from, to }) => { pulled.push({ from: iso(from), to: iso(to) }); return { ok: true, calls: 1 }; };

  // A working tick sets the cursor.
  await runDiscoveryTick({ db, env, now: NOON_ET, discover });
  const before = pulled.length;
  assert.ok(before > 0);

  // Three quiet ticks change nothing.
  for (const t of ['2026-08-25T03:00:00Z', '2026-08-25T06:00:00Z', '2026-08-25T10:00:00Z']) {
    const r = await runDiscoveryTick({ db, env, now: new Date(t), discover });
    assert.equal(r.skipped, 'quiet_hours');
  }
  assert.equal(pulled.length, before, 'a quiet tick must not pull');

  // The 8am resume reaches back to where the cursor was left.
  await runDiscoveryTick({ db, env, now: new Date('2026-08-25T12:30:00Z'), discover });
  assert.ok(pulled.length > before);
  assert.ok(new Date(pulled[before].from) <= new Date(pulled[before - 1].to),
    'the resuming pull must start no later than the last covered instant — no gap');
});

// ─── the window ─────────────────────────────────────────────────────────────

test('`to` trails now by the report lag', () => {
  // The Call Log lags 5-10 minutes. Without this the cursor records coverage
  // the source could not yet have provided, and those calls are never re-asked.
  const p = planWindow({ now: NOON_ET, cursor: new Date(NOON_ET.getTime() - H), opts: OPTS });
  assert.equal(p.to.getTime(), NOON_ET.getTime() - OPTS.lagMinutes * 60_000);
});

test('the cursor is re-read with an overlap, which is free', () => {
  const cursor = new Date(NOON_ET.getTime() - H);
  const p = planWindow({ now: NOON_ET, cursor, opts: OPTS });
  assert.equal(p.from.getTime(), cursor.getTime() - OPTS.overlapMinutes * 60_000);
});

test('a window that would run backwards is skipped, not pulled', () => {
  // Two ticks in quick succession leave the cursor at the previous `to`, which
  // is now-lag. With no overlap configured, the next `from` lands exactly on
  // `to` — an empty or inverted span. Without this guard a naive checkpoint
  // writes a cursor EARLIER than the one it started from and the poller walks
  // backwards over ground it has already covered.
  const opts = { ...OPTS, overlapMinutes: 0 };
  const cursor = new Date(NOON_ET.getTime() - opts.lagMinutes * 60_000);
  assert.equal(planWindow({ now: NOON_ET, cursor, opts }).skip, 'window_empty');

  // And a cursor somehow ahead of the settled edge — a clock skew, a manual
  // run with a future bound — must also refuse rather than invert.
  const ahead = new Date(NOON_ET.getTime() + 60 * 60_000);
  assert.equal(planWindow({ now: NOON_ET, cursor: ahead, opts: OPTS }).skip, 'window_empty');
});

test('a catch-up beyond the cap is clamped, and says exactly what it dropped', () => {
  const cursor = new Date(NOON_ET.getTime() - 400 * H);
  const p = planWindow({ now: NOON_ET, cursor, opts: OPTS });
  assert.ok(p.droppedMs > 0);
  assert.ok(p.clampedFrom < p.from, 'the true intended start is reported');
  assert.equal(p.from.getTime(), NOON_ET.getTime() - OPTS.maxCatchupHours * H);
});

test('the default cap comfortably covers the current 3.5-day gap', () => {
  // Aug 22 → Aug 25 is ~84h. A cap below that would silently clamp away the
  // backlog on the very first tick.
  assert.ok(OPTS.maxCatchupHours >= 96, `maxCatchupHours ${OPTS.maxCatchupHours} would clamp the known gap`);
});

// ─── the cold start ─────────────────────────────────────────────────────────

test('the cold-start cursor is max(call_start), never created_at', async () => {
  const db = fakeDb({ newest: '2026-08-22T00:05:42Z' });
  const got = await newestCallStart(db);
  assert.equal(got.toISOString(), '2026-08-22T00:05:42.000Z');

  // And the code must not have quietly switched columns.
  const src = newestCallStart.toString();
  assert.match(src, /call_start/);
  assert.equal(/created_at/.test(src), false, 'created_at is insert time and would under-cover forever');
});

test('an empty table and a read error both fall back to the lookback', async () => {
  assert.equal(await newestCallStart(fakeDb({ newest: null })), null);
  assert.equal(await newestCallStart(fakeDb({ callsError: { message: 'boom' } })), null);
  // Falling back to "no cursor" means the lookback, not maxCatchupHours — a
  // read blip must not trigger a five-day pull on every boot.
  const p = planWindow({ now: NOON_ET, cursor: null, opts: OPTS });
  assert.equal(p.from.getTime(), NOON_ET.getTime() - OPTS.lookbackMinutes * 60_000);
});

// ─── chunking and the partial-progress rule ─────────────────────────────────

test('THE REGRESSION: a chunk that throws holds the cursor at the last COMMITTED one', async () => {
  // discoverCalls upserts once at the END of its span, so a failure part-way
  // through writes nothing. Chunk 2 failing must leave 3 and 4 unattempted and
  // the cursor at the end of chunk 1.
  const env = { CI_DISCOVERY_ENABLED: 'true', CI_DISCOVERY_REQUIRE_ACTIVITY: 'false' };
  const now = NOON_ET;
  const db = fakeDb({ newest: iso(now.getTime() - 12 * H) });
  const attempted = [];
  const discover = async ({ from }) => {
    attempted.push(iso(from));
    if (attempted.length === 2) throw new Error('runReportAndWait timed out');
    return { ok: true, calls: 5 };
  };

  const r = await runDiscoveryTick({ db, env, now, discover });
  assert.equal(r.ok, false);
  assert.equal(attempted.length, 2, 'chunks 3 and 4 must not be attempted after a failure');
  assert.equal(r.failure.at, attempted[1]);

  // The next tick re-asks for exactly the unfinished remainder — no gap.
  const resumed = [];
  await runDiscoveryTick({
    db, env, now: new Date(now.getTime() + 15 * 60_000),
    discover: async ({ from }) => { resumed.push(iso(from)); return { ok: true, calls: 1 }; },
  });
  assert.ok(new Date(resumed[0]) <= new Date(attempted[1]),
    'the retry must cover the chunk that failed');
});

test('the per-tick chunk cap is honoured, and the deferral is never silent', async () => {
  const env = {
    CI_DISCOVERY_ENABLED: 'true', CI_DISCOVERY_REQUIRE_ACTIVITY: 'false',
    CI_DISCOVERY_MAX_CHUNKS_PER_TICK: '2', CI_DISCOVERY_CHUNK_HOURS: '3',
  };
  const now = NOON_ET;
  const db = fakeDb({ newest: iso(now.getTime() - 24 * H) });
  let calls = 0;
  const r = await runDiscoveryTick({ db, env, now, discover: async () => { calls += 1; return { ok: true, calls: 1 }; } });
  assert.equal(calls, 2);
  assert.ok(r.deferred > 0, 'a throttled catch-up must report what it did not take');
});

test('the cursor never regresses across ticks', async () => {
  const env = { CI_DISCOVERY_ENABLED: 'true', CI_DISCOVERY_REQUIRE_ACTIVITY: 'false' };
  const db = fakeDb({ newest: iso(NOON_ET.getTime() - 6 * H) });
  const discover = async () => ({ ok: true, calls: 1 });
  const a = await runDiscoveryTick({ db, env, now: NOON_ET, discover });
  const b = await runDiscoveryTick({ db, env, now: new Date(NOON_ET.getTime() + 60_000), discover });
  assert.ok(new Date(b.cursor) >= new Date(a.cursor));
});

// ─── the breaker ────────────────────────────────────────────────────────────

test('an open Five9 auth breaker stops the pull before any network call', () => {
  // The breaker is process-global with no test setter (deliberately — see
  // five9-admin.js), so this asserts the ORDERING structurally: the check must
  // sit ahead of the first await on `discover`. An armed 15-minute poller
  // hammering a bad credential is what locks the account the floor dials on.
  const src = runDiscoveryTick.toString();
  const breakerAt = src.indexOf('five9AuthBreakerStatus');
  const discoverAt = src.indexOf('await discover(');
  assert.ok(breakerAt > -1, 'the breaker check was removed');
  assert.ok(discoverAt > -1, 'the pull was renamed — re-check this ordering');
  assert.ok(breakerAt < discoverAt, 'the breaker must be consulted before any pull');
});

test('a forced run bypasses the flag and quiet hours, but NOT the breaker', () => {
  // A human asking for a pull is not evidence that the password is right.
  const src = runDiscoveryTick.toString();
  assert.match(src, /!opts\.enabled && !force/);
  assert.match(src, /!force && isQuietHour/);
  const forceGuards = src.slice(src.indexOf('five9AuthBreakerStatus'), src.indexOf('_running = true'));
  assert.equal(/force/.test(forceGuards), false, 'force must not reach the breaker check');
});

// ─── the webhook activity gate ──────────────────────────────────────────────

test('no dialer activity means no report job at all', async () => {
  // A Call Log pull is a report job on Five9's side; this is an indexed count on
  // ours. Overnight it makes the cost zero without relying on the clock.
  const env = { CI_DISCOVERY_ENABLED: 'true' };
  const db = fakeDb({ newest: iso(NOON_ET.getTime() - 2 * H), activity: 0 });
  let pulled = 0;
  const r = await runDiscoveryTick({ db, env, now: NOON_ET, discover: async () => { pulled += 1; return { ok: true, calls: 0 }; } });
  assert.equal(r.skipped, 'no_dialer_activity');
  assert.equal(pulled, 0);
  assert.ok(r.cursor, 'the window IS covered — our own feed says it holds no calls — so the cursor advances');
});

test('the gate OPENS on any doubt — it may save a pull, never lose a call', async () => {
  for (const db of [fakeDb({ activity: 0, eventsError: { message: 'relation does not exist' } })]) {
    const got = await hadDialerActivity(db, new Date(0), new Date(1));
    assert.equal(got.active, true, 'a feed we cannot read must not suppress discovery');
    assert.equal(got.probed, false);
  }
  const ok = await hadDialerActivity(fakeDb({ activity: 7 }), new Date(0), new Date(1));
  assert.deepEqual({ active: ok.active, count: ok.count }, { active: true, count: 7 });
});

test('the gate can be removed entirely', async () => {
  const env = { CI_DISCOVERY_ENABLED: 'true', CI_DISCOVERY_REQUIRE_ACTIVITY: 'false' };
  const db = fakeDb({ newest: iso(NOON_ET.getTime() - 2 * H), activity: 0 });
  let pulled = 0;
  await runDiscoveryTick({ db, env, now: NOON_ET, discover: async () => { pulled += 1; return { ok: true, calls: 0 }; } });
  assert.ok(pulled > 0);
});

// ─── the completeness smoke alarm ───────────────────────────────────────────

test('a large shortfall against the webhook feed is flagged', () => {
  // The signature of the Call Log's SILENT 5,000-row cap, which today has
  // nothing watching it.
  const s = completenessShortfall(5000, 900);
  assert.ok(s);
  assert.equal(s.webhookCalls, 5000);
  assert.equal(s.ingestedRows, 900);
});

test('normal variance is NOT flagged — the two counts are not comparable', () => {
  // The webhook fires per disposition, the report returns legs. A modest
  // difference is expected, and an alarm that cries wolf gets muted.
  assert.equal(completenessShortfall(100, 80), null);
  assert.equal(completenessShortfall(100, 120), null);
  assert.equal(completenessShortfall(0, 0), null, 'a quiet window is not a shortfall');
  assert.equal(completenessShortfall(null, 10), null);
});

// ─── the guards ─────────────────────────────────────────────────────────────

test('a disabled scheduler does nothing, and force overrides only that', async () => {
  const db = fakeDb({ newest: iso(NOON_ET.getTime() - H) });
  let pulled = 0;
  const discover = async () => { pulled += 1; return { ok: true, calls: 1 }; };

  const off = await runDiscoveryTick({ db, env: {}, now: NOON_ET, discover });
  assert.equal(off.skipped, 'disabled');
  assert.equal(pulled, 0);

  const forced = await runDiscoveryTick({ db, env: {}, now: NOON_ET, discover, force: true });
  assert.notEqual(forced.skipped, 'disabled');
  assert.ok(pulled > 0, 'POST /ci/discovery/run must work while the scheduler is still disarmed');
});

test('a clamp is alerted, not just logged', async () => {
  const env = { CI_DISCOVERY_ENABLED: 'true', CI_DISCOVERY_REQUIRE_ACTIVITY: 'false' };
  const db = fakeDb({ newest: iso(NOON_ET.getTime() - 400 * H) });
  const alerts = [];
  await runDiscoveryTick({
    db, env, now: NOON_ET,
    discover: async () => ({ ok: true, calls: 1 }),
    alert: async (kind, text) => { alerts.push({ kind, text }); },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'ci_discovery_clamped');
  assert.match(alerts[0].text, /will NOT be pulled/);
});
