/**
 * test-call-cap-digest.js — the "Five9 call cap" section of the 08:00 ops digest
 * (the user, 2026-10-16: count dialer calls only toward the 3-in-24 cap, track
 * manual-call violations apart, and watch two campaigns on one lead). A day with
 * nothing adds no section; a read that fails is "could not run", never silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callCapLines, runOpsMorningDigest } from '../src/jobs/ops-morning-digest.js';

// 2026-10-15 from the live view.
const ROW = {
  call_date_et: '2026-10-15', dialer_violations: 33, manual_violations: 80, leads_over_cap: 28,
  clashes: 31, hot_after_clashes: 27, manual_by_campaign: { Dispatch: 9, Rehash: 1, 'Main Number': 70 },
};

test('a day with nothing, or no row, adds no section', () => {
  assert.deepEqual(callCapLines(null), []);
  assert.deepEqual(callCapLines({ dialer_violations: 0, manual_violations: 0, clashes: 0 }), []);
});

test('dialer and manual are separate lines; manual is split by campaign, largest first', () => {
  const lines = callCapLines(ROW);
  assert.equal(lines[0], 'Dialer: 33 calls over the 3-calls-in-24-hours cap, on 28 leads');
  assert.equal(lines[1], 'Manual: 80 calls that were a 4th call or more in 24 hours (Main Number 70, Dispatch 9, Rehash 1)');
  assert.equal(lines[2], 'Two campaigns dialed the same lead within 4 hours 31 times (Data - Hot and After DIAL ASAP: 27)');
  assert.deepEqual(callCapLines({ dialer_violations: 1, leads_over_cap: 1 }), ['Dialer: 1 call over the 3-calls-in-24-hours cap, on 1 lead']);
});

/** Every other section reads nothing here; only the cap view answers. */
function deps(capRead) {
  const empty = { data: [], error: null };
  const q = (table) => {
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, lt: () => chain, lte: () => chain,
      not: () => chain, order: () => chain, is: () => chain, like: () => chain, ilike: () => chain,
      limit: () => Promise.resolve(table === 'v_call_journey_cap_daily' ? capRead() : empty),
      then: (res, rej) => Promise.resolve(table === 'v_call_journey_cap_daily' ? capRead() : empty).then(res, rej),
    };
    return chain;
  };
  return {
    __noDefaults: true, nowMs: Date.parse('2026-10-16T12:00:00Z'),
    supabase: { from: q, rpc: async () => empty }, hlRunSQL: async () => [],
    filterNew: async ({ items }) => items || [], recordPosted: async () => {}, lastPostedCount: async () => null,
    runJob: async () => ({ status: 'skipped' }), sendAlertMessage: async () => ({ sent: true }),
  };
}

test('the digest reads yesterday (Eastern) and titles the section with that date', async () => {
  let asked = null;
  const d = deps(() => ({ data: [ROW], error: null }));
  const from = d.supabase.from;
  d.supabase.from = (t) => {
    const c = from(t);
    if (t === 'v_call_journey_cap_daily') { const eq = c.eq; c.eq = (k, v) => { asked = v; return eq(k, v); }; }
    return c;
  };
  const out = await runOpsMorningDigest({ post: false, deps: d });
  assert.equal(asked, '2026-10-15', '8 AM ET on the 16th reports the 15th');
  assert.match(out.text, /\*Five9 call cap, 2026-10-15 \(Eastern\)\*/);
  assert.match(out.text, /• Manual: 80 calls/);
});

test('a failed read of the view is a "could not run", never a quiet day', async () => {
  const out = await runOpsMorningDigest({ post: false, deps: deps(() => ({ data: null, error: { message: 'boom' } })) });
  assert.ok(out.failures.some((f) => f.label === 'Five9 call cap' && /boom/.test(f.error)));
  assert.doesNotMatch(out.text, /Five9 call cap/);
});
