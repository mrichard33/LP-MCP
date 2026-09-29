/**
 * test-lead-leak-reasons.js — every name on the waiting card gets a real
 * reason (2026-09-29).
 *
 * The hourly "📵 N leads waiting" card said "Never dialled" on all twelve
 * lines of the 2026-09-29 card. A live check found two different problems it
 * could not show:
 *   Group A — in Five9 but on NO dialing list (f9_last_list empty, 0 attempts):
 *             LP 579216, 579206, 579248, 579249, 579252, 579253.
 *   Group B — rung 1–3× by DIAL ASAP at the inquiry stage (before LP stamped
 *             the lead), then never retried: LP 579244, 579246, 579254, 579257,
 *             579259, 579263.
 * The fixtures below are those leads, with the record shape getContactRecords
 * really returns (read live on 2026-09-29).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  finalizeReason, summarizeContactRecord, contactRecordRows, LEAK_REASONS,
} from '../src/lead-leak-classify.js';
import { precreateCalls, callsSince, workingMsBetween, lpLocalToUtcMs } from '../src/lead-speed.js';
import { formatUncalledAlert, reasonText, REASON_LABELS } from '../src/lead-speed-alerts.js';
import { measureLeadLeak, runLeadUncalledCheck } from '../src/jobs/lead-leak-monitor.js';

const HOUR = 3600 * 1000;

/* --- Five9 contact records --------------------------------------------- */

const FIELDS = ['number1', 'number2', 'number3', 'first_name', 'last_name', 'company', 'street', 'city', 'state',
  'zip', 'email', 'Last Agent', 'call_ID', 'Contact create time and date', 'CustID', 'LPRecType', 'lead_id',
  'cqd_id', 'LPRecKey', 'Number of attempts', 'x1', 'x2', 'x3', 'f9_last_list', 'f9_last_campaign',
  'f9_last_dispo_date_time'];

/** A getContactRecords answer: one `fields` header, `records` single or array. */
function f9Record(...recs) {
  const rows = recs.map((r) => ({ values: { data: FIELDS.map((f) => r[f] ?? '') } }));
  return { count: rows.length, records: [{ fields: FIELDS, records: rows.length === 1 ? rows[0] : rows }] };
}

const RON = { number1: '9046135153', first_name: 'Ron', last_name: 'allen', lead_id: '579248',
  LPRecKey: 'INQ426698', 'Number of attempts': '00000', f9_last_list: '', f9_last_campaign: '',
  'Contact create time and date': '2026-09-27 23:03:37.000' };

test('record parsing: single and multi-record answers, matched on lead_id', () => {
  const rows = contactRecordRows(f9Record(RON));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lead_id, '579248');

  const other = { ...RON, lead_id: '500000', f9_last_list: 'Data - Hot - JAX less than 7', 'Number of attempts': '00003',
    'Contact create time and date': '2026-09-28 23:00:00.000' };
  const s = summarizeContactRecord(f9Record(other, RON), '579248');
  assert.equal(s.leadIdMatch, true, 'the record for THIS lead, not the newer one for the phone');
  assert.equal(s.onList, false);
  assert.equal(s.attempts, 0);

  const fallback = summarizeContactRecord(f9Record(other, RON), '999');
  assert.equal(fallback.leadIdMatch, false);
  assert.equal(fallback.list, 'Data - Hot - JAX less than 7', 'no lead_id match → the newest record');
});

test('classifier: not_on_dial_list, routing failure, not_in_five9, unverified', () => {
  // Group A (Ron A., LP 579248): in Five9, no list, never attempted.
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(RON), '579248')), 'not_on_dial_list');
  // On a list but never dialled — the older finding, still its own reason.
  const listed = { ...RON, f9_last_list: 'Data - Hot - JAX less than 7' };
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(listed), '579248')), 'routing_or_automation_failure');
  // A blank attempts field is unreadable, never "0" — so never "not on a list".
  const blank = { ...RON, 'Number of attempts': '' };
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(blank), '579248')), 'routing_or_automation_failure');
  assert.equal(finalizeReason('absent'), 'not_in_five9');
  assert.equal(finalizeReason('error'), 'unverified');
  assert.equal(finalizeReason('present'), 'routing_or_automation_failure', 'unparseable record keeps the old answer');
  assert.ok(LEAK_REASONS.includes('not_on_dial_list'), 'priced and counted like any leak');
});

/* --- inquiry-stage calls ----------------------------------------------- */

// Donna B. (LP 579263): LP stamped the lead 10:04 ET on 9/28 — its digits are
// Eastern labelled UTC. DIAL ASAP rang her twice before that.
const DONNA_CREATED = '2026-09-28T10:04:38.783+00:00';
const DONNA_MS = lpLocalToUtcMs(DONNA_CREATED);

test('a Five9 call 2h before created_at_lp counts as called, recorded apart', () => {
  const ctx = { five9Keys: new Map(), five9Phones: new Map([['4079211871', [DONNA_MS - 2 * HOUR]]]) };
  const who = { leadId: '579263', phone10: '4079211871', createdAtLp: DONNA_CREATED };
  assert.deepEqual(precreateCalls(who, ctx), { count: 1, lastMs: DONNA_MS - 2 * HOUR });
  assert.equal(precreateCalls(who, ctx, 1), null, 'outside a 1h window');
  assert.deepEqual(callsSince(who, ctx), [DONNA_MS - 2 * HOUR]);
});

test('workingMsBetween counts call-center hours only', () => {
  const at = (iso) => Date.parse(iso);
  // 19:00 ET → next day 09:00 ET: 1h that evening + 1h next morning.
  assert.equal(workingMsBetween(at('2026-09-28T23:00:00Z'), at('2026-09-29T13:00:00Z')), 2 * HOUR);
  assert.equal(workingMsBetween(at('2026-09-29T14:00:00Z'), at('2026-09-29T15:30:00Z')), 1.5 * HOUR);
  assert.equal(workingMsBetween(5, 5), 0);
});

/* --- the pass ----------------------------------------------------------- */

const NOW = Date.parse('2026-09-29T18:00:00Z'); // 14:00 ET

const lpLead = (over) => ({
  lp_prospect_id: '1', lead_source: 'Internet', disposition_code: 'Data', call_count: 0,
  appointment_set: false, closed_won: false, updated_at_lp: over.created_at_lp, zip: '32257', ...over,
});

const DONNA = lpLead({ lp_lead_id: '579263', first_name: 'Donna', last_name: 'Brown', phone: '4079211871',
  created_at_lp: DONNA_CREATED });
const RON_LEAD = lpLead({ lp_lead_id: '579248', first_name: 'Ron', last_name: 'allen', phone: '9046135153',
  created_at_lp: '2026-09-28T10:00:28.317+00:00' });
// Rung an hour ago → retried recently, not owed yet.
const FRESH = lpLead({ lp_lead_id: '579300', first_name: 'Pat', last_name: 'Lane', phone: '3525550100',
  created_at_lp: '2026-09-28T11:00:00+00:00' });

const iso = (ms) => new Date(ms).toISOString();

/** Day-slice stub in the shape the job reads: [phone, times, last dispo, last time]. */
function stubSQL(leads) {
  const donnaCalls = [DONNA_MS - 2 * HOUR, DONNA_MS - 40 * 60000 - HOUR];
  const phones = [
    ['4079211871', donnaCalls.map(iso), 'Answering Machine', iso(Math.max(...donnaCalls))],
    ['3525550100', [iso(NOW - HOUR)], 'Hung Up', iso(NOW - HOUR)],
  ];
  return async (sql) => {
    if (sql.includes('min(received_at)')) return [{ first_at: '2026-07-28T20:28:17Z' }];
    if (sql.includes('FROM five9_events_raw')) return [{ keys: [], phones }];
    if (sql.includes(' IN (')) return [];
    if (sql.includes('FROM lp_leads')) return leads;
    return [];
  };
}

const deps = (over = {}) => ({
  runSQL: stubSQL([DONNA, RON_LEAD, FRESH]),
  hlRunSQL: async () => [],
  checkDnc: async () => ({ on_dnc: [] }),
  getContactRecords: async ({ criteria }) => (criteria[0].value === '9046135153' ? f9Record(RON) : { count: 0 }),
  findLeadInDataQueues: async () => ({ present: false, row: null, truncated_queues: [] }),
  ...over,
});

test('Donna B. reads called_no_retry, Ron A. reads not_on_dial_list — nobody "Never dialled"', async () => {
  const m = await measureLeadLeak({
    env: {}, nowMs: NOW, deps: deps(), opts: { windowDays: 2, lookups: 'card', rates: false, intake: false },
  });
  const byId = Object.fromEntries(m.offenders.map((o) => [o.lp_lead_id, o]));
  assert.equal(byId['579263'].reason, 'called_no_retry');
  assert.equal(byId['579263'].calls.count, 2);
  assert.equal(byId['579263'].calls.before_creation, 2);
  assert.equal(byId['579263'].calls.lastDispo, 'Answering Machine');
  assert.equal(byId['579248'].reason, 'not_on_dial_list');
  assert.equal(byId['579300'], undefined, 'rung an hour ago — not owed a retry yet');
  assert.equal(m.called_no_retry, 1);
  assert.equal(m.called_before_creation, 1, 'Donna was only ever rung at the inquiry stage');
  assert.equal(m.speed.daily.reduce((n, d) => n + d.leads, 0), 2, 'Ron (never called) and Pat are in the speed rows; Donna is not');

  assert.match(reasonText(byId['579263'], NOW), /^Called 2× \(last: Answering Machine, 29h 35m ago\) — no retry since$/);
});

test('a called lead that is not "Data" any more is not owed a retry', async () => {
  const set = { ...DONNA, disposition_code: 'Set', appointment_set: true };
  const m = await measureLeadLeak({
    env: {}, nowMs: NOW, deps: deps({ runSQL: stubSQL([set]) }),
    opts: { windowDays: 2, lookups: 'card', rates: false, intake: false },
  });
  assert.equal(m.offenders.length, 0);
});

test('a called lead on the Five9 DNC list is not owed a retry', async () => {
  const m = await measureLeadLeak({
    env: {}, nowMs: NOW, deps: deps({ runSQL: stubSQL([DONNA]), checkDnc: async () => ({ on_dnc: ['4079211871'] }) }),
    opts: { windowDays: 2, lookups: 'card', rates: false, intake: false },
  });
  assert.equal(m.offenders.length, 0);
});

test('hourly pass: lookups only for leads the card names, capped by LEAD_UNCALLED_LOOKUP_CAP', async () => {
  const young = lpLead({ lp_lead_id: '579400', first_name: 'New', last_name: 'Lead', phone: '3525550200',
    created_at_lp: '2026-09-29T13:30:00+00:00' }); // 13:30 ET — 30 minutes ago, inside the grace
  const others = [1, 2, 3].map((i) => lpLead({ lp_lead_id: `57950${i}`, first_name: 'Old', last_name: `N${i}`,
    phone: `352555030${i}`, created_at_lp: '2026-09-28T12:00:00+00:00' }));
  const looked = [];
  const calls = [];
  const d = deps({
    runSQL: stubSQL([young, ...others]),
    getContactRecords: async ({ criteria }) => { looked.push(criteria[0].value); return { count: 0 }; },
    reportAlertCondition: async (args) => { calls.push(args); return { action: 'fired' }; },
  });
  const r = await runLeadUncalledCheck({
    env: { LEAD_LEAK_ALERT_MODE: 'live', LEAD_UNCALLED_LOOKUP_CAP: '2' }, nowMs: NOW, deps: d,
  });
  assert.equal(r.verdict, 'alert');
  assert.ok(!looked.includes('3525550200'), 'not looked up — it is not on the card');
  assert.equal(looked.length, 2, 'the cap holds');
  const text = calls[0].text();
  assert.match(text, /\*Not in Five9 at all \(2\)\*/);
  assert.match(text, /\*Not verified — Five9 lookup failed or skipped \(1\)\*/, 'the one over the cap says so');
});

test('card: grouped by reason with counts, the cap, "…and N more", and the dashboard link', () => {
  const o = (id, reason, extra = {}) => ({ first_name: 'A', last_name: 'B', phone10: '3525550000', lead_source: 'Internet',
    reason, lp_lead_id: id, waitingMs: 22 * HOUR + 4 * 60000, ...extra });
  const offenders = [
    ...[1, 2, 3].map((i) => o(`a${i}`, 'not_on_dial_list')),
    ...[1, 2, 3].map((i) => o(`b${i}`, 'called_no_retry', { calls: { count: 1, lastMs: NOW - 20 * HOUR, lastDispo: 'Hung Up' } })),
  ];
  const text = formatUncalledAlert(offenders, { cfg: { graceHours: 2, maxNamed: 4 }, dashboardUrl: 'https://d/leaks', nowMs: NOW });
  const lines = text.split('\n');
  assert.match(lines[0], /6 leads waiting more than 2h for a Five9 call/);
  // Called-no-retry first, then not-on-a-list; headers carry the FULL count.
  const h1 = lines.indexOf('*Called, no retry since (3)*');
  const h2 = lines.indexOf('*In Five9 but not on any dialing list (3)*');
  assert.ok(h1 > 0 && h2 > h1, 'both group headers, in order');
  assert.match(text, /A B\. · …0000 · Internet · waiting 22h 4m · Called 1× \(last: Hung Up, 20h 0m ago\) — no retry since · LP b1/);
  assert.equal(lines.filter((l) => l.startsWith('• ')).length, 4, 'maxNamed caps named lines across groups');
  assert.ok(lines.includes('…and 2 more'));
  assert.equal(lines[lines.length - 1], 'Full list: https://d/leaks', 'every card ends with the link');
  for (const l of lines.filter((x) => x.startsWith('• '))) {
    assert.ok(!l.includes(`· ${REASON_LABELS.unverified} ·`), 'a successful lookup never reads unverified');
    assert.ok(!/· Never dialled ·/.test(l));
  }
});
