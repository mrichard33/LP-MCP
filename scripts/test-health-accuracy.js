/**
 * test-health-accuracy.js — the System Health review of 2026-10-15.
 *
 * Every case is a false (or missing) alert found on the live board that day:
 *   - Five9's agent list with more than one agent parsed to [[null]], so
 *     "Calling lists being worked" read "no agent Ready" while five were.
 *   - No agent working during call-center hours is now an alert.
 *   - The first-call clock started at LP's lead time, not the inquiry's
 *     arrival: Frederick B. was called in 17 seconds and read "not called".
 *   - A visit booked after its Conf deadline was late the moment it existed.
 *   - The call that PRODUCED an ND counted as "called again"; Reset campaigns
 *     call No Demo leads by design.
 *   - The same old never-reached-Five9 leads were Urgent every morning.
 *   - "Waiting for a first call" counted leads that had been called once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeStatistics } from '../src/five9-supervisor.js';
import {
  agentCounts, evaluateListStalled, evaluateLeadSla, arrivalMsFor, dialsAfterDisposition,
  isAllowedNeverAgainCampaign, BOOKED_GRACE_MIN,
} from '../src/health/dialer-sla.js';
import { leadLeakResults, uncalledLiveResults, splitNewOld } from '../src/health/watchdog-results.js';
import { resolveStatus } from '../src/health/record.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('../src/health/registry.snapshot.json', import.meta.url)));
const REGISTRY = new Map(SNAPSHOT.checks.map((r) => [r.check_id, r]));
const status = (e) => resolveStatus(e, REGISTRY.get(e.check_id));
const NOON = Date.parse('2026-10-15T16:00:00Z'); // Thu 12:00 PM EDT

// The shape Five9 returned on 2026-10-15 (names replaced).
const agentRow = (user, state) => ({ values: { data: [user, '0', null, '', '', '', `${user} name`, state, 'N/A', state] } });
const AGENT_STATE = {
  columns: { values: { data: ['Username', 'A', 'B', 'Call Type', 'Campaign Name', 'Customer', 'Full Name', 'X', 'Media Availability', 'State'] } },
  rows: [agentRow('a1', 'Logged Out'), agentRow('a2', 'Ready'), agentRow('a3', 'Not Ready'), agentRow('a4', 'On Call'), agentRow('a5', 'Ready')],
};

test('Five9 agent list with several agents keeps every row', () => {
  const { columns, rows } = normalizeStatistics(AGENT_STATE);
  assert.equal(columns.length, 10);
  assert.equal(rows.length, 5);
  assert.equal(rows[1][0], 'a2');
  assert.equal(rows[1][9], 'Ready');
  // One row (parsed as an object, not an array) still works.
  assert.equal(normalizeStatistics({ ...AGENT_STATE, rows: agentRow('solo', 'Ready') }).rows.length, 1);
});

test('agents: Ready counts as ready; Ready, On Call and After Call Work count as working', () => {
  const records = ['Logged Out', 'Ready', 'Not Ready', 'On Call', 'After Call Work', 'Ready'].map((State) => ({ State }));
  assert.deepEqual(agentCounts(records), { ready: 2, working: 4 });
  assert.deepEqual(agentCounts([]), { ready: 0, working: 0 });
});

function stalledDeps({ states, lastCallAt = null }) {
  return {
    runSQL: async () => [{ last_at: lastCallAt }],
    five9: {
      getCampaigns: async () => ({ campaigns: [] }),
      getStatistics: async () => ({ records: states.map((State) => ({ State })) }),
      getListsInfo: async () => ({ lists: [] }),
      getOutboundCampaign: async () => ({ lists: [] }),
    },
  };
}

test('no agent working in call-center hours is an alert; red once calls have stopped 30 minutes', async () => {
  const recent = new Date(NOON - 10 * 60e3).toISOString();
  const warn = await evaluateListStalled({ d: stalledDeps({ states: ['Logged Out', 'Not Ready'], lastCallAt: recent }), registry: REGISTRY, nowMs: NOON });
  assert.equal(warn.status, 'warn');
  assert.match(warn.summary, /No agents are logged in and available to take calls/);
  const old = new Date(NOON - 45 * 60e3).toISOString();
  assert.equal((await evaluateListStalled({ d: stalledDeps({ states: [], lastCallAt: old }), registry: REGISTRY, nowMs: NOON })).status, 'fail');
  // 9:30 PM: the call center is closed.
  const night = Date.parse('2026-10-16T01:30:00Z');
  assert.equal((await evaluateListStalled({ d: stalledDeps({ states: [] }), registry: REGISTRY, nowMs: night })).status, 'skipped');
  // Agents working: the list check runs (no list with leads → pass), never "no agent".
  const ok = await evaluateListStalled({ d: stalledDeps({ states: ['On Call', 'Ready'] }), registry: REGISTRY, nowMs: NOON });
  assert.equal(ok.status, 'pass');
});

// Frederick B. (2026-10-15): inquiry arrived 10:06:41 AM, called 10:06:58 AM,
// checked out into LP lead 583716 at 10:16 AM. LP lead times are Eastern wall
// clock tagged +00:00; the inbound queue's received_at_lp is true UTC.
const FREDERICK = { lp_lead_id: '583716', first_name: 'Frederick', last_name: 'B', phone: '(352) 615-8539', lead_source: 'Internet', lead_source_detail: 'MyHomePros', disposition_code: 'Data', appointment_date: null, created_at_lp: '2026-10-15T10:16:30.467+00:00' };

function slaDeps({ leads, visits = [], inbound = [], calls = [], lookup = async () => 'absent' }) {
  const phones = new Map();
  for (const [phone, ms] of calls) phones.set(phone, [...(phones.get(phone) || []), ms]);
  return {
    env: {},
    runSQL: async (q) => {
      if (/FROM lp_leads\s+WHERE created_at_lp/.test(q)) return leads;
      if (/disposition_code IN \('Set', 'Verif'\)/.test(q)) return visits;
      if (/FROM lp_inbound_queue/.test(q)) return inbound;
      return [];
    },
    readHistory: async () => ({ keys: new Map(), phones, last: new Map() }),
    readRates: async () => new Map(),
    lookupContact: lookup,
    five9: { getContactRecords: async () => ({}) },
  };
}

test('first call is timed from the inquiry arrival, and a call on the inquiry counts', async () => {
  const arrived = Date.parse('2026-10-15T14:06:41.54Z');
  assert.equal(arrivalMsFor(FREDERICK, new Map([['583716', arrived]])), arrived);
  assert.equal(arrivalMsFor(FREDERICK, new Map()), Date.parse('2026-10-15T14:16:30.467Z'), 'no queue row: LP lead time');
  const d = slaDeps({
    leads: [FREDERICK],
    inbound: [{ lds_id: '583716', received_at_lp: '2026-10-15T14:06:41.54+00:00' }],
    calls: [['3526158539', Date.parse('2026-10-15T14:06:58Z')]],
  });
  const [first] = await evaluateLeadSla({ d, nowMs: Date.parse('2026-10-15T15:55:00Z'), registry: REGISTRY });
  assert.equal(first.detail.never_dialed, 0);
  assert.equal(first.detail.leads.length, 0, 'called in 17 seconds is not late');
  // Without the queue row the old clock is back, and the early call does not count.
  const old = await evaluateLeadSla({ d: { ...d, runSQL: async (q) => (/FROM lp_leads\s+WHERE created_at_lp/.test(q) ? [FREDERICK] : []) }, nowMs: Date.parse('2026-10-15T15:55:00Z'), registry: REGISTRY });
  assert.equal(old[0].detail.never_dialed, 1);
});

test('a visit booked after its Conf deadline gets time to reach the list', async () => {
  // Booked at 11:41 AM for tomorrow 10 AM; the rule's deadline was 8 AM today.
  const visit = { lp_lead_id: '583744', first_name: 'M', last_name: 'G', phone: '4078797971', lead_source: 'Website', lead_source_detail: 'Reece ChatBot', disposition_code: 'Set', appointment_date: '2026-10-16T10:00:00+00:00', created_at_lp: '2026-10-15T11:41:43.41+00:00' };
  const run = (nowMs) => evaluateLeadSla({ d: slaDeps({ leads: [visit], visits: [visit] }), nowMs, registry: REGISTRY }).then((x) => x[1]);
  const early = await run(Date.parse('2026-10-15T15:55:00Z')); // 11:55 AM: 14 minutes after booking
  assert.equal(early.detail.late, 0);
  const later = await run(Date.parse('2026-10-15T15:41:43Z') + (BOOKED_GRACE_MIN + 5) * 60e3);
  assert.equal(later.detail.late, 1, 'still off the list after the grace is late');
});

test('a Simpletext lead on its texting list is its own line, never "wrong list"', async () => {
  const st = { lp_lead_id: '583662', first_name: '', last_name: '', phone: '3212638905', lead_source: 'Simpletext', lead_source_detail: 'WIRK-now', disposition_code: 'Data', appointment_date: null, created_at_lp: '2026-10-15T08:02:17.497+00:00' };
  const [, list] = await evaluateLeadSla({ d: slaDeps({ leads: [st], lookup: async () => ({ list: 'Simpletext_ASAP' }) }), nowMs: NOON, registry: REGISTRY });
  assert.equal(list.detail.late, 0);
  assert.equal(list.detail.texting_only.length, 1);
  assert.match(list.summary, /1 Simpletext lead is only on the Simpletext texting list/);
  assert.equal(status(list), 'warn');
});

test('called again: the call that produced the ND is not a breach; Reset campaigns are their own line', () => {
  // 583606: called 4:56 PM ET (20:56Z), ND set 5:05 PM ET.
  assert.deepEqual(dialsAfterDisposition(['2026-10-14T20:56:23Z'], '2026-10-14T17:05:12'), []);
  assert.equal(dialsAfterDisposition(['2026-10-14T21:30:00Z'], '2026-10-14T17:05:12').length, 1);
  assert.equal(isAllowedNeverAgainCampaign('Resets-Hot'), true);
  assert.equal(isAllowedNeverAgainCampaign('Reset-Warm'), true);
  assert.equal(isAllowedNeverAgainCampaign('DIAL ASAP'), false);
  assert.equal(isAllowedNeverAgainCampaign('Rehash'), false);
  assert.equal(isAllowedNeverAgainCampaign('Resets-Hot', { allowed_campaigns: [] }), false, 'Mark can count them');
});

test('lead leaks: only new leads decide red; old ones stay listed, yellow', () => {
  const now = Date.parse('2026-10-15T12:10:00Z');
  const row = (id, created, value = 642) => ({ reason: 'not_in_five9', lp_lead_id: id, lead_source: 'Internet', est_value: value, detail: { first_name: 'A', last_name: 'B', created_utc: created } });
  const old = Array.from({ length: 13 }, (_, i) => row(String(570000 + i), `2026-09-${String(1 + i).padStart(2, '0')}T14:00:00Z`));
  const m = { summary: { by_reason: { not_in_five9: { leads: 13, est_value: 13 * 642 } } }, rows: old, retiredFresh: [] };
  const nf = leadLeakResults({ m, nowMs: now, retiredDecision: { verdict: 'healthy' }, inboundQueueSplit: true }).find((x) => x.check_id === 'lead.not_in_five9');
  assert.equal(status(nf), 'warn');
  assert.equal(nf.value, 0);
  assert.match(nf.summary, /^13 older leads \(Sep 1 to Sep 13\) never reached Five9 and are still open/);
  const fresh = [...old, ...Array.from({ length: 10 }, (_, i) => row(String(583000 + i), '2026-10-14T15:00:00Z'))];
  const m2 = { summary: { by_reason: { not_in_five9: { leads: 23, est_value: 23 * 642 } } }, rows: fresh, retiredFresh: [] };
  const nf2 = leadLeakResults({ m: m2, nowMs: now, retiredDecision: { verdict: 'healthy' }, inboundQueueSplit: true }).find((x) => x.check_id === 'lead.not_in_five9');
  assert.equal(status(nf2), 'fail');
  assert.match(nf2.summary, /^10 new leads never reached Five9/);
  assert.equal(splitNewOld([{ created_ms: null }], now).fresh.length, 1, 'undated counts as new');
});

test('"waiting for a first call" counts only leads never called', () => {
  const now = NOON;
  const lead = (id, reason, min) => ({ lp_lead_id: id, first_name: 'P', last_name: 'Q', phone10: '3525550188', lead_source: 'Internet', reason, waitingMs: min * 60e3 });
  const e = uncalledLiveResults({ decision: { verdict: 'alert' }, offenders: [lead('1', 'called_no_retry', 993), lead('2', 'called_no_retry', 960), lead('3', 'not_on_dial_list', 20)], nowMs: now })[0];
  assert.match(e.summary, /^1 lead has not had a first call yet; the longest has waited 20 minutes\. 2 leads were called once and are waiting on a second call/);
  assert.equal(status(e), 'warn', 'a missing second call is yellow, not red');
  const red = uncalledLiveResults({ decision: { verdict: 'alert' }, offenders: [lead('4', 'not_on_dial_list', 241)], nowMs: now })[0];
  assert.equal(status(red), 'fail');
});

test('a texting campaign is never a stalled calling list', async () => {
  const d = {
    runSQL: async () => [],
    five9: {
      getCampaigns: async () => ({ campaigns: [{ name: 'Simpletext outbound', type: 'OUTBOUND', state: 'RUNNING' }] }),
      getStatistics: async () => ({ records: [{ State: 'Ready' }] }),
      getListsInfo: async () => ({ lists: [{ name: 'Simpletext_ASAP', size: 441 }] }),
      getOutboundCampaign: async () => ({ lists: [{ name: 'Simpletext_ASAP' }] }),
    },
  };
  const reg = new Map(REGISTRY);
  reg.set('dialer.campaign_running', { ...REGISTRY.get('dialer.campaign_running'), config: { expected: ['Simpletext outbound'] } });
  const e = await evaluateListStalled({ d, registry: reg, nowMs: NOON });
  assert.equal(e.status, 'pass');
  assert.equal(e.summary, 'No calling list has leads waiting.');
});

test('a visit our routing job already added to its Conf list is on the list (2026-10-15)', async () => {
  // Five9's f9_last_list is the list a record was last DIALED from, so a fresh
  // add reads as "no list" until the first call; our completed add is the proof.
  const visit = { lp_lead_id: '583749', first_name: 'Thomas', last_name: 'F', phone: '9542633605', lead_source: 'Internet', lead_source_detail: 'Lead Gurus', disposition_code: 'Set', appointment_date: '2026-10-17T14:00:00+00:00', created_at_lp: '2026-10-15T11:52:31.903+00:00' };
  const d = slaDeps({ leads: [visit], visits: [visit] });
  const base = d.runSQL;
  d.runSQL = async (q) => (/FROM agent_actions/.test(q) && /status = 'completed'/.test(q) ? [{ phone: '9542633605', list: 'Conf - 2nd Day' }] : base(q));
  let lookups = 0;
  d.lookupContact = async () => { lookups += 1; return { list: null }; };
  const [, list] = await evaluateLeadSla({ d, nowMs: Date.parse('2026-10-15T17:26:00Z'), registry: REGISTRY });
  assert.equal(list.detail.late, 0);
  assert.equal(lookups, 0, 'no Five9 lookup spent on a lead we know we added');
});

test('a campaign locked in Five9 admin is skipped, not "can\'t tell" (2026-10-15)', async () => {
  const d = {
    runSQL: async () => [],
    five9: {
      getCampaigns: async () => ({ campaigns: [{ name: 'DIAL ASAP', type: 'OUTBOUND', state: 'RUNNING' }, { name: 'Data - Warm Leads less than 30', type: 'OUTBOUND', state: 'RUNNING' }] }),
      getStatistics: async () => ({ records: [{ State: 'Ready' }] }),
      getListsInfo: async () => ({ lists: [] }),
      getOutboundCampaign: async (name) => {
        if (name.startsWith('Data')) throw new Error('CAMPAIGN ("Data - Warm Leads less than 30") is already locked');
        return { lists: [{ name: 'LP_ASAP' }] };
      },
    },
  };
  const reg = new Map(REGISTRY);
  reg.set('dialer.campaign_running', { ...REGISTRY.get('dialer.campaign_running'), config: { expected: ['DIAL ASAP', 'Data - Warm Leads less than 30'] } });
  const e = await evaluateListStalled({ d, registry: reg, nowMs: NOON });
  assert.equal(e.status, 'pass');
  assert.equal(e.summary, 'No calling list has leads waiting.');
});
