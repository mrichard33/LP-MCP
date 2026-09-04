/**
 * test-alert-state-set.js — set-valued alert conditions (2026-09-05).
 *
 * THE DEFECT. PR #845 made four single conditions edge-triggered. It left the
 * watchdogs that evaluate a SET per sweep, and drift-detector was the worst
 * offender in the whole repo: every 30-minute scan re-announced the ENTIRE
 * drift set, so one contact nobody fixed produced 48 cards a day, forever. Its
 * idempotency key was the scan minute, which differs on every scan by
 * construction, so it only ever deduped a retry inside the same minute.
 *
 * claimAlertConditionSet is the fix, and what is asserted here is the contract
 * that makes it safe to leave on: a stable set is announced ONCE, only genuine
 * arrivals come back as new, departures clear without a card, a resolved
 * condition can fire again, and a broken table reports "I could not tell"
 * rather than clearing live incidents or re-announcing them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GROUPME_BOT_ID = 'test-bot';

import { claimAlertConditionSet, confirmAlertSend } from '../src/alert-state.js';
import { mockAlertConditions } from './fixtures/alert-conditions-mock.js';

const PREFIX = 'drift:ghl_closed_lp_active:';
const keys = (...ids) => ids.map((id) => `${PREFIX}${id}`);

/** One shared table, swept repeatedly — the shape every caller actually has. */
function sweeper({ rows = new Map(), fail = null } = {}) {
  const client = mockAlertConditions(rows, { fail });
  return {
    rows,
    client,
    sweep: (ids, nowMs) => claimAlertConditionSet({
      prefix: PREFIX,
      activeKeys: keys(...ids),
      label: 'drift',
      client,
      nowMs,
    }),
    confirm: (ks, nowMs) => confirmAlertSend(ks, { client, nowMs }),
  };
}

test('(1) a stable set is announced ONCE, then stays silent across many sweeps', async () => {
  const s = sweeper();
  const first = await s.sweep(['a', 'b', 'c']);
  assert.equal(first.ok, true);
  assert.deepEqual(first.newlyFiring.sort(), keys('a', 'b', 'c').sort());

  // The exact scenario that produced 48 cards/day: the same set, over and over.
  for (let i = 0; i < 20; i++) {
    const again = await s.sweep(['a', 'b', 'c']);
    assert.equal(again.ok, true);
    assert.deepEqual(again.newlyFiring, [], `sweep ${i + 2} must announce nothing`);
    assert.deepEqual(again.cleared, []);
  }
});

test('(2) only a genuine arrival comes back as new', async () => {
  const s = sweeper();
  await s.sweep(['a', 'b']);
  const next = await s.sweep(['a', 'b', 'c']);
  assert.deepEqual(next.newlyFiring, keys('c'), 'the two ongoing conditions must stay silent');
  assert.deepEqual(next.cleared, []);
});

test('(3) a departure clears, and clearing is not an announcement', async () => {
  const s = sweeper();
  await s.sweep(['a', 'b']);
  const next = await s.sweep(['a']);
  assert.deepEqual(next.cleared, keys('b'));
  assert.deepEqual(next.newlyFiring, []);
  assert.equal(s.rows.get(keys('b')[0]).state, 'cleared');
});

test('(4) an empty sweep clears everything — the last item resolving is not a no-op', async () => {
  const s = sweeper();
  await s.sweep(['a', 'b']);
  const next = await s.sweep([]);
  assert.deepEqual(next.cleared.sort(), keys('a', 'b').sort());
});

test('(5) a resolved condition that returns is a NEW incident and fires again', async () => {
  const s = sweeper();
  await s.sweep(['a']);
  await s.sweep([]);                       // fixed
  const back = await s.sweep(['a']);       // and drifted again
  assert.deepEqual(back.newlyFiring, keys('a'), 're-arm must re-announce; ON CONFLICT DO NOTHING alone would swallow it');
  assert.equal(s.rows.get(keys('a')[0]).state, 'firing');
  assert.equal(s.rows.get(keys('a')[0]).notify_count, 0, 're-arm resets the notify counter');
});

test('(6) survives a restart — the state is in the table, not the process', async () => {
  const rows = new Map();
  const before = sweeper({ rows });
  await before.sweep(['a', 'b']);

  // A brand-new caller against the same table: exactly what a redeploy is.
  const after = sweeper({ rows });
  const next = await after.sweep(['a', 'b']);
  assert.deepEqual(next.newlyFiring, [], 'a redeploy must not re-announce live conditions');
});

test('(7) two concurrent sweeps produce exactly one claim per key', async () => {
  const rows = new Map();
  const a = sweeper({ rows });
  const b = sweeper({ rows });
  const [r1, r2] = await Promise.all([a.sweep(['x', 'y']), b.sweep(['x', 'y'])]);
  const all = [...r1.newlyFiring, ...r2.newlyFiring].sort();
  assert.deepEqual(all, keys('x', 'y').sort(), 'a key must be claimed by exactly one caller');
});

test('(8) confirmAlertSend stamps only what was sent', async () => {
  const s = sweeper();
  const first = await s.sweep(['a', 'b']);
  // The caller's own send succeeded for one key and failed for the other.
  const res = await s.confirm(keys('a'));
  assert.equal(res.ok, true);
  assert.equal(res.stamped, 1);
  assert.equal(s.rows.get(keys('a')[0]).notify_count, 1);
  assert.equal(s.rows.get(keys('b')[0]).notify_count, 0, 'an unsent card must not be recorded as sent');
  assert.equal(first.newlyFiring.length, 2);
});

test('(9) a key whose send failed is still firing, so it is NOT re-announced', async () => {
  const s = sweeper();
  await s.sweep(['a']);
  // notify_count stays 0 — no confirm — but the row is firing.
  const next = await s.sweep(['a']);
  assert.deepEqual(next.newlyFiring, [], 'a failed send must not turn into a repeat card on the next sweep');
});

test('(10) a broken table reports ok:false and touches NOTHING', async () => {
  const rows = new Map();
  const good = sweeper({ rows });
  await good.sweep(['a', 'b']);

  const broken = sweeper({ rows, fail: 'select' });
  const res = await broken.sweep([]);          // would clear everything if believed
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'read_failed');
  assert.deepEqual(res.cleared, []);
  assert.deepEqual(res.newlyFiring, []);
  assert.equal(rows.get(keys('a')[0]).state, 'firing', 'a failed read must never clear a live incident');
  assert.equal(rows.get(keys('b')[0]).state, 'firing');
});

test('(11) a client that throws degrades rather than propagating', async () => {
  const s = sweeper({ fail: 'throw' });
  const res = await s.sweep(['a']);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'threw');
});

test('(12) a failed clear leaves rows firing — clearing fails CLOSED', async () => {
  const rows = new Map();
  const good = sweeper({ rows });
  await good.sweep(['a']);

  const s = sweeper({ rows, fail: 'update' });
  const res = await s.sweep([]);
  assert.deepEqual(res.cleared, [], 'a clear that could not be written must not be reported as resolved');
  assert.equal(rows.get(keys('a')[0]).state, 'firing');
});

test('(13) a missing prefix is refused rather than clearing the whole table', async () => {
  const res = await claimAlertConditionSet({ activeKeys: keys('a'), client: mockAlertConditions() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_prefix');
});

test('(14) duplicate ids in one sweep collapse to one condition', async () => {
  const s = sweeper();
  const res = await s.sweep(['a', 'a', 'a']);
  assert.deepEqual(res.newlyFiring, keys('a'));
});

test('(14b) an underscore in the prefix does not capture a neighbouring namespace', async () => {
  // PostgREST `like` treats `_` as a single-character wildcard, and real
  // prefixes contain them ('fb_publish_overdue:'). Without an exact re-filter
  // one caller's sweep would clear another caller's live conditions.
  const rows = new Map();
  const client = mockAlertConditions(rows);
  await claimAlertConditionSet({ prefix: 'fb_publish_overdue:', activeKeys: ['fb_publish_overdue:1'], client });
  await claimAlertConditionSet({ prefix: 'fbXpublishXoverdue:', activeKeys: ['fbXpublishXoverdue:1'], client });

  // A sweep of the first namespace finding nothing must clear only its own.
  const res = await claimAlertConditionSet({ prefix: 'fb_publish_overdue:', activeKeys: [], client });
  assert.deepEqual(res.cleared, ['fb_publish_overdue:1']);
  assert.equal(rows.get('fbXpublishXoverdue:1').state, 'firing', 'the neighbouring namespace must be untouched');
});

test('(15) confirmAlertSend on an empty list is a no-op, not an error', async () => {
  const s = sweeper();
  const res = await s.confirm([]);
  assert.equal(res.ok, true);
  assert.equal(res.stamped, 0);
});

test('(16) confirmAlertSend skips a key another sweep already cleared', async () => {
  const s = sweeper();
  const first = await s.sweep(['a']);
  await s.sweep([]);                    // resolved between the claim and the send
  const res = await s.confirm(first.newlyFiring);
  assert.equal(res.stamped, 0, 'stamping a cleared row would make its next recovery lie');
});
