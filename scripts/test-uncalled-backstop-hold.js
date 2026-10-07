/**
 * The uncalled-leads card waits for the new-lead dial backstop (Mark, 2026-10-07).
 * src/uncalled-backstop-hold.js (rules) and holdForBackstop in
 * src/jobs/lead-leak-monitor.js (the reads).
 *
 * Run: node --test scripts/test-uncalled-backstop-hold.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { backstopView, holdReason, applyBackstopHold, leadIdFromPush } from '../src/uncalled-backstop-hold.js';
import { holdForBackstop } from '../src/jobs/lead-leak-monitor.js';

const NOW = Date.parse('2026-10-07T16:00:00Z'); // 12:00 ET, dial window open
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const push = (leadId, atMs, extra = {}) => ({
  status: 'completed', created_at: iso(atMs),
  action_payload: { field_names: ['number1', 'lead_id'], records: [['3524453161', leadId]], card_line: `• X → Reece Chatbot (LP lead ${leadId})` },
  ...extra,
});
const okRun = (byReason = {}, atMs = NOW - 3 * MIN) => ({ status: 'ok', started_at: iso(atMs), detail: { by_reason: byReason } });

test('leadIdFromPush: the record\'s lead_id, else the card line', () => {
  assert.equal(leadIdFromPush(push('581413', NOW).action_payload), '581413');
  assert.equal(leadIdFromPush({ card_line: '• Donna → Reece Chatbot (LP lead 581500)' }), '581500');
  assert.equal(leadIdFromPush({}), null);
});

test('backstop not live, or no fresh ok pass → nothing is held', () => {
  assert.equal(backstopView({ mode: 'shadow', run: okRun(), nowMs: NOW }).active, false);
  assert.equal(backstopView({ mode: 'live', run: null, nowMs: NOW }).active, false);
  assert.equal(backstopView({ mode: 'live', run: { ...okRun(), status: 'failed' }, nowMs: NOW }).active, false);
  assert.equal(backstopView({ mode: 'live', run: okRun({}, NOW - 40 * MIN), nowMs: NOW }).active, false, 'a stalled backstop holds nothing');
  const off = backstopView({ mode: 'off', run: okRun(), pushRows: [push('1', NOW - MIN)], nowMs: NOW });
  assert.equal(holdReason('1', { view: off, nowMs: NOW }), null);
});

test('a lead the backstop pushed is held for 30 dial minutes, then named', () => {
  const view = backstopView({ mode: 'live', run: okRun(), pushRows: [push('581413', NOW - 10 * MIN)], nowMs: NOW });
  assert.equal(holdReason('581413', { view, nowMs: NOW }), 'pushed_recently');
  assert.equal(holdReason('581413', { view, nowMs: NOW + 25 * MIN }), null, '35 min after the push, still uncalled → named');
  // Pushed overnight (2 AM ET): the 30 minutes start at 8:00 ET.
  const night = Date.parse('2026-10-07T06:00:00Z');
  const v2 = backstopView({ mode: 'live', run: okRun({}, Date.parse('2026-10-07T12:20:00Z')), pushRows: [push('7', night)], nowMs: Date.parse('2026-10-07T12:25:00Z') });
  assert.equal(holdReason('7', { view: v2, nowMs: Date.parse('2026-10-07T12:25:00Z') }), 'pushed_recently', '8:25 ET');
  assert.equal(holdReason('7', { view: v2, nowMs: Date.parse('2026-10-07T12:31:00Z') }), null, '8:31 ET');
});

test('a lead the backstop is still waiting on is held; a skipped or failed one is not', () => {
  const view = backstopView({
    mode: 'live', nowMs: NOW,
    run: okRun({ queued_elsewhere: ['10'], dnc_unreadable: ['11'], deferred: ['12'], too_new: ['13'], push_failed: ['14'], dnc: ['15'] }),
  });
  for (const id of ['10', '11', '12', '13']) assert.equal(holdReason(id, { view, nowMs: NOW }), 'backstop_waiting', id);
  assert.equal(holdReason('14', { view, nowMs: NOW }), null, 'a failed push needs a person');
  assert.equal(holdReason('15', { view, nowMs: NOW }), null);
});

test('a lead the backstop watchdog already named in #ops is not named twice', () => {
  const view = backstopView({ mode: 'live', run: okRun(), nowMs: NOW });
  const out = applyBackstopHold([{ lp_lead_id: '20' }, { lp_lead_id: '21' }], { view, namedByBackstop: new Set(['20']), nowMs: NOW });
  assert.deepEqual(out.named.map((o) => o.lp_lead_id), ['21']);
  assert.deepEqual(out.held, [{ lp_lead_id: '20', hold: 'named_by_backstop' }]);
});

// ── holdForBackstop: the reads ──────────────────────────────────────────────
function fakeDb({ runs = [], pushes = [], fail = null } = {}) {
  return {
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
        then(res, rej) {
          if (fail === table) return Promise.resolve({ data: null, error: { message: 'down' } }).then(res, rej);
          return Promise.resolve({ data: table === 'job_runs' ? runs : pushes, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}
const LIVE = { NEW_LEAD_DIAL_BACKSTOP_MODE: 'live' };
const offenders = [{ lp_lead_id: '581413' }, { lp_lead_id: '581414' }, { lp_lead_id: '581415' }, { lp_lead_id: '581416' }];
const store = (named = []) => ({ filterNew: async ({ audit, items }) => {
  assert.equal(audit, 'dial_backstop_unhandled');
  return { fresh: items.filter((i) => !named.includes(i.key)) };
} });

test('holdForBackstop: pushed / waiting / already named are held; the rest are named', async () => {
  const deps = {
    supabase: fakeDb({
      runs: [{ status: 'running', started_at: iso(NOW) }, okRun({ queued_elsewhere: ['581414'] })],
      pushes: [push('581413', NOW - 5 * MIN), push('581416', NOW - 5 * MIN, { status: 'failed' })],
    }),
    ...store(['581415']),
  };
  const out = await holdForBackstop(offenders, { env: LIVE, nowMs: NOW, deps });
  assert.deepEqual(out.held.map((h) => [h.lp_lead_id, h.hold]), [
    ['581413', 'pushed_recently'], ['581414', 'backstop_waiting'], ['581415', 'named_by_backstop'],
  ]);
  assert.deepEqual(out.named.map((o) => o.lp_lead_id), ['581416'], 'a failed push is not "in hand"');
});

test('holdForBackstop: a failed read or a backstop in shadow holds nothing (the card is unchanged)', async () => {
  const failing = await holdForBackstop(offenders, { env: LIVE, nowMs: NOW, deps: { supabase: fakeDb({ fail: 'agent_actions', runs: [okRun()] }), ...store() } });
  assert.equal(failing.named.length, 4);
  assert.match(failing.why, /read failed/);
  const shadow = await holdForBackstop(offenders, { env: {}, nowMs: NOW, deps: { supabase: fakeDb({ runs: [okRun()], pushes: [push('581413', NOW - MIN)] }), ...store() } });
  assert.equal(shadow.named.length, 4);
  assert.match(shadow.why, /shadow/);
});
