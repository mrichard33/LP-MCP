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
  finalizeReason, summarizeContactRecord, contactRecordRows, LEAK_REASONS, isRetryOwedDispo,
  isEmptyFive9Value, parseFive9Attempts,
} from '../src/lead-leak-classify.js';
import { precreateCalls, callsSince, workingMsBetween, lpLocalToUtcMs } from '../src/lead-speed.js';
import {
  formatUncalledAlert, formatSpeedAlert, reasonText, REASON_LABELS, allocateLines,
} from '../src/lead-speed-alerts.js';
import { measureLeadLeak, runLeadUncalledCheck, leadLeakResponse } from '../src/jobs/lead-leak-monitor.js';

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

test('classifier: not_on_dial_list, on_list_not_dialed, routing failure, not_in_five9, unverified', () => {
  // Group A (Ron A., LP 579248): in Five9, no list, never attempted.
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(RON), '579248')), 'not_on_dial_list');
  // On a list with no call in our history → on_list_not_dialed (2026-09-29).
  const listed = { ...RON, f9_last_list: 'Data - Hot - JAX less than 7' };
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(listed), '579248')), 'on_list_not_dialed');
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(listed), '579248'), { calledInHistory: true }),
    'routing_or_automation_failure', 'on a list AND a call in history is not this reason');
  // No list, but Five9 says it attempted: still unnamed — the routing bucket.
  const attempted = { ...RON, 'Number of attempts': '00002' };
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(attempted), '579248')), 'routing_or_automation_failure');
  // Attempts that are not digits are unreadable, never 0.
  const junk = { ...RON, 'Number of attempts': 'n/a' };
  assert.equal(summarizeContactRecord(f9Record(junk), '579248').attempts, null);
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(junk), '579248')), 'routing_or_automation_failure');
  assert.equal(finalizeReason('absent'), 'not_in_five9');
  assert.equal(finalizeReason('error'), 'unverified');
  assert.equal(finalizeReason('present'), 'routing_or_automation_failure', 'unparseable record keeps the old answer');
  assert.ok(LEAK_REASONS.includes('not_on_dial_list'), 'priced and counted like any leak');
  assert.ok(LEAK_REASONS.includes('on_list_not_dialed'), 'priced and counted like any leak');
});

test('Five9 empty values: null, "", whitespace, "0", "00000" and 0 are all empty; "00001" is 1', () => {
  for (const v of [null, undefined, '', '   ', '0', '00000', 0]) {
    assert.equal(isEmptyFive9Value(v), true, JSON.stringify(v));
    assert.equal(parseFive9Attempts(v), 0, `attempts ${JSON.stringify(v)} → 0`);
  }
  assert.equal(parseFive9Attempts('00001'), 1);
  assert.equal(parseFive9Attempts(' 3 '), 3);
  assert.equal(isEmptyFive9Value('LP_ASAP'), false);
});

/* --- the live cases from 2026-09-29 (after #1079) ----------------------- */

test('LP 579216: list null, campaign null, attempts null, lead_id match → not_on_dial_list', () => {
  // Five9 left every field blank; #1079 read blank attempts as "unreadable".
  const rec = { number1: '3525551216', lead_id: '579216', f9_last_list: null, f9_last_campaign: null,
    'Number of attempts': null, 'Contact create time and date': '2026-09-28 20:00:00.000' };
  const s = summarizeContactRecord(f9Record(rec), '579216');
  assert.equal(s.leadIdMatch, true);
  assert.equal(s.list, null);
  assert.equal(s.attempts, 0);
  assert.equal(finalizeReason(s), 'not_on_dial_list');
});

test('list "" and attempts "00000" → not_on_dial_list', () => {
  const rec = { number1: '3525550001', lead_id: '579206', f9_last_list: '', 'Number of attempts': '00000' };
  assert.equal(finalizeReason(summarizeContactRecord(f9Record(rec), '579206')), 'not_on_dial_list');
});

test('LP 579486 (Sherrod W.): no list, campaign set, 0 attempts, NO lead_id match → not_on_dial_list', () => {
  const rec = { number1: '7275550486', lead_id: '512345', f9_last_list: '', f9_last_campaign: 'St Pete Sticky',
    'Number of attempts': '0' };
  const s = summarizeContactRecord(f9Record(rec), '579486');
  assert.equal(s.leadIdMatch, false);
  assert.equal(s.campaign, 'St Pete Sticky');
  assert.equal(finalizeReason(s), 'not_on_dial_list', 'lead_id_match is not required');
});

test('LP 565211: on LP_ASAP, attempts "00001", no Five9 call → on_list_not_dialed, and the card names LP_ASAP', () => {
  const rec = { number1: '8135555211', lead_id: '565211', f9_last_list: 'LP_ASAP', f9_last_campaign: 'LP_ASAP',
    'Number of attempts': '00001' };
  const s = summarizeContactRecord(f9Record(rec), '565211');
  assert.equal(s.attempts, 1);
  assert.equal(finalizeReason(s), 'on_list_not_dialed');
  const o = { reason: 'on_list_not_dialed', five9_record: { list: s.list } };
  assert.equal(reasonText(o), 'On LP_ASAP in Five9 but no call recorded');
  assert.equal(REASON_LABELS.on_list_not_dialed, 'On a Five9 list but no call recorded');
  assert.equal(finalizeReason('error'), 'unverified', 'a lookup error is still unverified');
});

test('several records for one phone: lead_id match wins, else the newest create time', () => {
  const older = { number1: '1', lead_id: '1', f9_last_list: 'OLD', 'Contact create time and date': '2026-08-01 10:00:00.000' };
  const newer = { number1: '1', lead_id: '2', f9_last_list: 'NEW', 'Contact create time and date': '2026-09-01 10:00:00.000' };
  assert.equal(summarizeContactRecord(f9Record(older, newer), '1').list, 'OLD');
  assert.equal(summarizeContactRecord(f9Record(older, newer), '999').list, 'NEW');
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

test('a lead Five9 last dispositioned as reached-and-decided is not owed a retry', async () => {
  // First live hour (2026-09-29): Appointment Set / Not Interested / Do Not Call
  // / Bad Data leads still coded "Data" in LP were named as "no retry since".
  for (const dispo of ['Appointment Set', 'Not Interested', 'Do Not Call', 'Bad Data', 'Callback']) {
    const donnaCalls = [DONNA_MS - 2 * HOUR];
    const runSQL = async (sql) => {
      if (sql.includes('min(received_at)')) return [{ first_at: '2026-07-28T20:28:17Z' }];
      if (sql.includes('FROM five9_events_raw')) {
        return [{ keys: [], phones: [['4079211871', donnaCalls.map(iso), dispo, iso(donnaCalls[0])]] }];
      }
      if (sql.includes('FROM lp_leads')) return [DONNA];
      return [];
    };
    const m = await measureLeadLeak({
      env: {}, nowMs: NOW, deps: deps({ runSQL }), opts: { windowDays: 2, lookups: 'card', rates: false, intake: false },
    });
    assert.equal(m.offenders.length, 0, `${dispo} is not "no retry"`);
  }
  assert.equal(isRetryOwedDispo('Hung Up'), true);
  assert.equal(isRetryOwedDispo('answering machine'), true, 'case-insensitive');
  assert.equal(isRetryOwedDispo(null), true, 'no readable disposition stays visible');
  assert.equal(isRetryOwedDispo('Some New Outcome'), false, 'allowlist: a new disposition does not page by default');
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
    // 2026-10-02 — reads the card through the edge-triggered path that
    // ALERT_DIGEST_ENABLED=false restores; the lookup cap is the same on both.
    env: { LEAD_LEAK_ALERT_MODE: 'live', LEAD_UNCALLED_LOOKUP_CAP: '2', ALERT_DIGEST_ENABLED: 'false' }, nowMs: NOW, deps: d,
  });
  assert.equal(r.verdict, 'alert');
  assert.ok(!looked.includes('3525550200'), 'not looked up — it is not on the card');
  assert.equal(looked.length, 2, 'the cap holds');
  const text = calls[0].text();
  assert.match(text, /\*Not in Five9 at all — 2\*/);
  assert.match(text, /\*Not verified — Five9 lookup failed or skipped — 1\*/, 'the one over the cap says so');
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
  // Equal fresh counts → the tie-break order; headers carry the FULL count.
  const h1 = lines.indexOf('*Called, no retry since — 3 (showing 2)*');
  const h2 = lines.indexOf('*In Five9 but not on any dialing list — 3 (showing 2)*');
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

/* --- freshest leads first (2026-09-29) ---------------------------------- */

// An offender created `hoursAgo` real hours before NOW.
const aged = (id, reason, hoursAgo, extra = {}) => ({
  first_name: 'Lee', last_name: `N${id}`, phone10: '3525550000', lead_source: 'Simpletext', reason,
  lp_lead_id: String(id), createdMs: NOW - hoursAgo * HOUR, waitingMs: hoursAgo * HOUR, ...extra,
});
const namedIds = (text) => text.split('\n').filter((l) => l.startsWith('• ')).map((l) => l.split(' · LP ')[1]);

test('card: a lead created today is listed before one from 2 days ago', () => {
  const offenders = [aged(1, 'not_in_five9', 50), aged(2, 'not_in_five9', 3), aged(3, 'not_in_five9', 26)];
  const text = formatUncalledAlert(offenders, { cfg: { graceHours: 2, maxNamed: 15 }, nowMs: NOW });
  assert.deepEqual(namedIds(text), ['2', '3', '1']);
});

test('card: groups ordered by leads from the last 24 call-center hours, most first', () => {
  // Five old leads (a week ago) vs two from this morning: the fresh group leads.
  const offenders = [
    ...[1, 2, 3, 4, 5].map((i) => aged(`o${i}`, 'not_in_five9', 24 * 7 + i)),
    aged('f1', 'on_list_not_dialed', 3, { five9_record: { list: 'LP_ASAP' } }),
    aged('f2', 'on_list_not_dialed', 4, { five9_record: { list: 'LP_ASAP' } }),
  ];
  const lines = formatUncalledAlert(offenders, { cfg: { graceHours: 2, maxNamed: 15 }, nowMs: NOW }).split('\n');
  const fresh = lines.indexOf('*On a Five9 list but no call recorded — 2*');
  const old = lines.indexOf('*Not in Five9 at all — 5*');
  assert.ok(fresh > 0 && old > fresh, 'the group holding today\'s leads comes first');
  assert.ok(lines.some((l) => l.includes('· On LP_ASAP in Five9 but no call recorded · LP f1')));
});

test('card: 40 offenders across 3 reasons, maxNamed 15 → every group shows ≥3 lines and its full count', () => {
  const offenders = [
    ...Array.from({ length: 31 }, (_, i) => aged(`a${i}`, 'not_on_dial_list', 3 + i)),
    ...Array.from({ length: 6 }, (_, i) => aged(`b${i}`, 'not_in_five9', 30 + i)),
    ...Array.from({ length: 3 }, (_, i) => aged(`c${i}`, 'unverified', 60 + i)),
  ];
  const text = formatUncalledAlert(offenders, { cfg: { graceHours: 2, maxNamed: 15 }, nowMs: NOW });
  const lines = text.split('\n');
  const headers = lines.filter((l) => /^\*.+ — \d+/.test(l));
  assert.deepEqual(headers, [
    '*In Five9 but not on any dialing list — 31 (showing 6)*',
    '*Not in Five9 at all — 6*',
    '*Not verified — Five9 lookup failed or skipped — 3*',
  ]);
  // Lines under each header.
  const counts = headers.map((h) => {
    let n = 0;
    for (let i = lines.indexOf(h) + 1; i < lines.length && lines[i].startsWith('• '); i += 1) n += 1;
    return n;
  });
  for (const n of counts) assert.ok(n >= 3, `every group gets at least 3 lines (${counts})`);
  assert.equal(counts.reduce((a, b) => a + b, 0), 15, 'the cap is the whole card');
  assert.ok(lines.includes('…and 25 more'));
  assert.deepEqual(allocateLines([31, 6, 3], 15), [6, 6, 3]);
  assert.deepEqual(allocateLines([31, 6, 3, 2, 9], 7), [2, 2, 1, 1, 1], 'too many groups: spread, never one hogging');
  assert.deepEqual(allocateLines([2], 15), [2]);
});

test('speed card: leads from August are counted, not named', () => {
  const decision = { reasons: ['slower'], recent: { median_min: 90 }, baseline: { median_min: 20 } };
  const august = [1, 2, 3].map((i) => aged(`aug${i}`, 'not_in_five9', 24 * 50 + i));
  const text = formatSpeedAlert(decision, [aged('new', 'not_on_dial_list', 5), ...august], { nowMs: NOW });
  assert.deepEqual(namedIds(text), ['new']);
  assert.match(text, /^\+ 3 older leads \(8\+ days\) — see dashboard$/m);
  assert.match(text, /Leads waiting right now for a call \(4\):/, 'the headline still counts everyone');
  const onlyOld = formatSpeedAlert(decision, august, { nowMs: NOW });
  assert.deepEqual(namedIds(onlyOld), []);
  assert.match(onlyOld, /\+ 3 older leads \(8\+ days\)/);
});

test('endpoint: waiting[0] is the newest lead; waiting_by_reason totals every offender', async () => {
  const lead = (id, created, phone) => lpLead({ lp_lead_id: id, first_name: 'X', last_name: id, phone, created_at_lp: created });
  const leads = [
    lead('579001', '2026-09-28T09:30:00+00:00', '3525551001'),
    lead('579003', '2026-09-29T10:00:00+00:00', '3525551003'), // 10:00 ET today — the newest
    lead('579002', '2026-09-28T15:00:00+00:00', '3525551002'),
  ];
  const listed = { number1: '3525551002', lead_id: '579002', f9_last_list: 'LP_ASAP', 'Number of attempts': '00001' };
  const m = await measureLeadLeak({
    env: {}, nowMs: NOW,
    deps: deps({
      runSQL: stubSQL(leads),
      getContactRecords: async ({ criteria }) => (criteria[0].value === '3525551002' ? f9Record(listed) : { count: 0 }),
    }),
    opts: { windowDays: 2, rates: false, intake: false, queues: false },
  });
  const body = leadLeakResponse(m);
  assert.deepEqual(body.waiting.map((w) => w.lp_lead_id), ['579003', '579002', '579001']);
  assert.deepEqual(body.waiting_by_reason, { not_in_five9: 2, on_list_not_dialed: 1 });
  assert.equal(Object.values(body.waiting_by_reason).reduce((a, b) => a + b, 0), m.offenders.length);
});

test('a record left in routing_or_automation_failure is logged with its raw Five9 values', async () => {
  const attempted = { number1: '3525551009', lead_id: '579009', f9_last_list: '', f9_last_campaign: 'DIAL ASAP',
    'Number of attempts': '00002' };
  const logged = [];
  const orig = console.log;
  console.log = (msg, ...rest) => { logged.push(String(msg)); if (!String(msg).startsWith('[LeadLeak] unmatched')) orig(msg, ...rest); };
  try {
    const m = await measureLeadLeak({
      env: {}, nowMs: NOW,
      deps: deps({
        runSQL: stubSQL([lpLead({ lp_lead_id: '579009', first_name: 'R', last_name: 'L', phone: '3525551009',
          created_at_lp: '2026-09-28T12:00:00+00:00' })]),
        getContactRecords: async () => f9Record(attempted),
      }),
      opts: { windowDays: 2, rates: false, intake: false, queues: false },
    });
    assert.equal(m.rows[0].reason, 'routing_or_automation_failure');
  } finally {
    console.log = orig;
  }
  assert.ok(logged.includes('[LeadLeak] unmatched five9 record lp_lead_id=579009 list="" campaign="DIAL ASAP" attempts="00002"'),
    logged.join('\n'));
});
