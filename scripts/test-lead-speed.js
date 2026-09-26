/**
 * scripts/test-lead-speed.js
 *
 * Offline coverage for time to first call (src/lead-speed.js), leads that
 * never reached LP (src/lead-intake-gap.js), the three alarms
 * (src/lead-speed-alerts.js), and how the job wires them
 * (src/jobs/lead-leak-monitor.js) — every read stubbed through deps.
 *
 * What these guard, in order of cost if broken:
 *   - LP's Eastern-labelled-UTC clock is corrected before it meets Five9's,
 *   - a call BEFORE the lead existed never counts as calling it,
 *   - overnight leads are not "late" before the call center opens,
 *   - a failed HL or Five9 read is "could not tell", never "0 missing",
 *   - shadow never sends a card; live sends one that names the leads,
 *   - a card never prints a full phone number.
 *
 * Run: node --test scripts/test-lead-speed.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  lpLocalToUtcMs, etDay, workingStartMs, firstCallAfter, minutesToFirstCall, waitingMs,
  percentile, dailySpeedRows, speedStats,
} from '../src/lead-speed.js';
import {
  buildIntakeCandidatesSql, classifyIntakeGap, summarizeIntakeGap, LP_ID_FIELDS,
} from '../src/lead-intake-gap.js';
import {
  shouldAlertSpeed, shouldAlertUncalled, shouldAlertIntakeGap, verdictToActive, alertMode, alertConfig,
  formatSpeedAlert, formatUncalledAlert, formatIntakeGapAlert, displayName, phoneTail, formatWait, shiftDay,
  ALERT_DEFAULTS,
} from '../src/lead-speed-alerts.js';
import { runLeadLeakMonitor, runLeadUncalledCheck, measureLeadLeak } from '../src/jobs/lead-leak-monitor.js';

const iso = (ms) => new Date(ms).toISOString();

/* --- the LP clock ------------------------------------------------------- */

test('LP time is Eastern wall-clock: summer is +4h to UTC, winter +5h', () => {
  // Measured 2026-09-26: 17:44 "UTC" in lp_leads was 21:44 real UTC.
  assert.equal(iso(lpLocalToUtcMs('2026-09-26T17:44:49.38+00:00')), '2026-09-26T21:44:49.380Z');
  assert.equal(iso(lpLocalToUtcMs('2026-09-26 17:44:49+00')), '2026-09-26T21:44:49.000Z');
  assert.equal(iso(lpLocalToUtcMs('2026-01-15T09:00:00+00:00')), '2026-01-15T14:00:00.000Z');
  assert.equal(lpLocalToUtcMs(null), null);
  assert.equal(lpLocalToUtcMs('not a date'), null);
  assert.equal(etDay(Date.parse('2026-09-27T02:00:00Z')), '2026-09-26', '10pm ET is still the 26th');
});

test('the clock starts when the call center is open', () => {
  const ten = Date.parse('2026-09-24T14:00:00Z');   // 10:00 ET — open
  assert.equal(workingStartMs(ten), ten);
  const late = Date.parse('2026-09-25T03:00:00Z');  // 23:00 ET on the 24th
  assert.equal(iso(workingStartMs(late)), '2026-09-25T12:00:00.000Z', '→ 08:00 ET next day');
  const early = Date.parse('2026-09-25T10:00:00Z'); // 06:00 ET
  assert.equal(iso(workingStartMs(early)), '2026-09-25T12:00:00.000Z', '→ 08:00 ET same day');
});

/* --- first call, Five9 only --------------------------------------------- */

test('firstCallAfter: earliest Five9 call at/after creation; earlier calls ignored', () => {
  const created = '2026-09-24T10:00:00+00:00';              // 10:00 ET = 14:00Z
  const before = Date.parse('2026-09-24T13:00:00Z');         // 09:00 ET — an earlier lead
  const phoneCall = Date.parse('2026-09-24T15:30:00Z');
  const keyCall = Date.parse('2026-09-24T14:20:00Z');
  const ctx = {
    five9Keys: new Map([['LDS700', [keyCall]]]),
    five9Phones: new Map([['3524453161', [before, phoneCall]]]),
  };
  assert.equal(firstCallAfter({ leadId: '700', phone10: '3524453161', createdAtLp: created }, ctx), keyCall);
  assert.equal(firstCallAfter({ leadId: '701', phone10: '3524453161', createdAtLp: created }, ctx), phoneCall,
    'the 09:00 call came before this lead existed');
  assert.equal(firstCallAfter({ leadId: '702', phone10: '9999999999', createdAtLp: created }, ctx), null);
  // Read raw (no ET correction) the 13:00Z call would look like it came after
  // "10:00Z" — exactly the 4-hour error this guards.
  assert.equal(firstCallAfter({ leadId: '703', phone10: '3524453161', createdAtLp: '2026-09-24T09:30:00+00:00' }, {
    five9Keys: new Map(), five9Phones: new Map([['3524453161', [before]]]),
  }), null);
});

test('minutesToFirstCall counts working minutes; overnight wait is not "late"', () => {
  // Created 10:00 ET, called 10:25 ET → 25.
  assert.equal(minutesToFirstCall('2026-09-24T10:00:00+00:00', Date.parse('2026-09-24T14:25:00Z')), 25);
  // Created 23:00 ET, called 08:10 ET next day → 10, not 550.
  assert.equal(minutesToFirstCall('2026-09-24T23:00:00+00:00', Date.parse('2026-09-25T12:10:00Z')), 10);
  // Called before opening (someone dialled early) → 0, never negative.
  assert.equal(minutesToFirstCall('2026-09-24T23:00:00+00:00', Date.parse('2026-09-25T11:00:00Z')), 0);
  assert.equal(minutesToFirstCall('2026-09-24T10:00:00+00:00', null), null);
  assert.equal(waitingMs('2026-09-24T23:00:00+00:00', Date.parse('2026-09-25T12:30:00Z')), 30 * 60000);
});

test('percentile, daily rows and window stats', () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentile([], 0.5), null);
  const rows = dailySpeedRows([
    { createdDay: '2026-09-24', minutes: 10, expected: true },
    { createdDay: '2026-09-24', minutes: 90, expected: true },
    { createdDay: '2026-09-24', minutes: null, expected: true },
    { createdDay: '2026-09-24', minutes: null, expected: false }, // DNC — not owed a call
    { createdDay: '2026-09-25', minutes: 5, expected: true },
  ]);
  assert.deepEqual(rows[0], {
    created_day: '2026-09-24', leads: 4, expected: 3, called: 2, never_called: 1,
    called_1h: 1, called_24h: 2, median_min: 50, p90_min: 82,
  });
  assert.equal(rows[1].created_day, '2026-09-25');
  const s = speedStats([
    { minutes: 10, expected: true }, { minutes: 2000, expected: true }, { minutes: null, expected: true },
  ]);
  assert.equal(s.median_min, 1005);
  assert.equal(Math.round(s.pct_not_called_24h * 100), 67);
});

/* --- never reached LP --------------------------------------------------- */

test('intake gap classes: in LP by phone / reached by Five9 / truly missing', () => {
  const added = Date.parse('2026-09-20T12:00:00Z');
  const env = {
    lpPhones: new Set(['3525550001']),
    five9Phones: new Map([['3525550002', [added + 3600000]], ['3525550003', [added - 3600000]]]),
  };
  assert.equal(classifyIntakeGap({ phone10: '3525550001', addedMs: added }, env), 'in_lp_unlinked');
  assert.equal(classifyIntakeGap({ phone10: '3525550002', addedMs: added }, env), 'not_in_lp_but_called');
  assert.equal(classifyIntakeGap({ phone10: '3525550003', addedMs: added }, env), 'not_in_lp',
    'a call before the contact arrived does not count');
  assert.deepEqual(summarizeIntakeGap([{ class: 'not_in_lp' }, { class: 'in_lp_unlinked' }]),
    { not_in_lp: 1, not_in_lp_but_called: 0, in_lp_unlinked: 1, checked: 2 });
  const sql = buildIntakeCandidatesSql({ sinceIso: '2026-08-27T00:00:00Z', untilIso: '2026-09-25T00:00:00Z' });
  assert.match(sql, /deleted_at IS NULL/);
  for (const id of LP_ID_FIELDS) assert.ok(sql.includes(id), `filters on ${id}`);
});

/* --- the alarms --------------------------------------------------------- */

const items = (day, n, minutes, extra = {}) => Array.from({ length: n },
  () => ({ createdDay: day, minutes, expected: true, settled24h: true, ...extra }));

test('speed alarm: slower than baseline → alert; steady → healthy; thin → insufficient', () => {
  const today = '2026-09-26';
  const baseline = [];
  for (let d = 4; d <= 31; d += 1) baseline.push(...items(shiftDay(today, -d), 2, 20));
  const slowRecent = [...items('2026-09-23', 12, 90), ...items('2026-09-24', 12, 90), ...items('2026-09-25', 12, 90)];
  const alert = shouldAlertSpeed({ leads: [...baseline, ...slowRecent], todayDay: today });
  assert.equal(alert.verdict, 'alert');
  assert.deepEqual(alert.reasons, ['slower']);
  assert.equal(alert.recent.median_min, 90);
  assert.equal(alert.baseline.median_min, 20);

  const okRecent = [...items('2026-09-23', 12, 22), ...items('2026-09-24', 12, 22), ...items('2026-09-25', 12, 22)];
  assert.equal(shouldAlertSpeed({ leads: [...baseline, ...okRecent], todayDay: today }).verdict, 'healthy');

  // Slower but still under 30 working minutes → no page.
  const mildRecent = [...items('2026-09-23', 36, 29)];
  assert.equal(shouldAlertSpeed({ leads: [...baseline, ...mildRecent], todayDay: today }).verdict, 'healthy');

  assert.equal(shouldAlertSpeed({ leads: items('2026-09-25', 5, 90), todayDay: today }).verdict, 'insufficient_evidence');

  // More leads left uncalled for 24h → alert even if the called ones were quick.
  const neglected = [...items('2026-09-24', 20, 15), ...items('2026-09-25', 16, null)];
  const n = shouldAlertSpeed({ leads: [...baseline, ...neglected], todayDay: today });
  assert.equal(n.verdict, 'alert');
  assert.ok(n.reasons.includes('more_uncalled'));
});

test('uncalled / intake alarms are three-way, and verdicts map onto `active`', () => {
  assert.equal(shouldAlertUncalled([{}]).verdict, 'alert');
  assert.equal(shouldAlertUncalled([]).verdict, 'healthy');
  assert.equal(shouldAlertUncalled(null, { readOk: false }).verdict, 'insufficient_evidence');
  assert.equal(shouldAlertIntakeGap([{ class: 'in_lp_unlinked' }]).verdict, 'healthy', 'unlinked is not missing');
  assert.equal(shouldAlertIntakeGap([{ class: 'not_in_lp' }]).verdict, 'alert');
  assert.equal(shouldAlertIntakeGap(null, { readOk: false }).verdict, 'insufficient_evidence');
  assert.equal(verdictToActive('alert'), true);
  assert.equal(verdictToActive('healthy'), false);
  assert.equal(verdictToActive('insufficient_evidence'), null);
  assert.equal(alertMode({}), 'shadow');
  assert.equal(alertMode({ LEAD_LEAK_ALERT_MODE: 'lvie' }), 'shadow');
  assert.equal(alertConfig({ LEAD_UNCALLED_GRACE_HOURS: '4' }).graceHours, 4);
});

test('cards name the leads — first name + initial, last four digits only', () => {
  const offenders = [{
    first_name: 'Jane', last_name: 'Doe', phone10: '3524453161', lead_source: 'Google PPC',
    reason: 'routing_or_automation_failure', lp_lead_id: '578472', waitingMs: 3 * 3600000 + 600000,
  }];
  const text = formatUncalledAlert(offenders, { dashboardUrl: 'https://dash.example/lead-leaks' });
  assert.match(text, /1 lead waiting more than 2h with no Five9 call/);
  assert.match(text, /Jane D\. · …3161 · Google PPC · waiting 3h 10m · Never dialled — Five9 has the number · LP 578472/);
  assert.match(text, /https:\/\/dash\.example\/lead-leaks/);
  assert.ok(!text.includes('3524453161'), 'never the full number');

  const speed = formatSpeedAlert({ reasons: ['slower'], recent: { median_min: 90 }, baseline: { median_min: 20 } }, offenders);
  assert.match(speed, /1h 30m over the last 3 days, up from 20m/);

  const gap = formatIntakeGapAlert([{ first_name: 'Sam', last_name: '', phone10: '9415550101', source: 'Modernize',
    date_added: '2026-09-20T12:00:00Z', ghl_contact_id: 'abc' }]);
  assert.match(gap, /1 lead in GHL never reached LP/);
  assert.match(gap, /Sam · …0101 · Modernize · in GHL since 2026-09-20 · GHL abc/);
  assert.equal(displayName('', ''), 'No name');
  assert.equal(phoneTail(null), 'no phone');
  assert.equal(formatWait(3 * 86400000), '3d 0h');
  assert.equal(ALERT_DEFAULTS.graceHours, 2);
});

/* --- the job, stubbed --------------------------------------------------- */

const NOW = Date.parse('2026-09-26T16:00:00Z'); // 12:00 ET

// LP-style Eastern digits labelled UTC, `hoursAgo` real hours before NOW.
const lpTs = (hoursAgo) => {
  const d = new Date(NOW - hoursAgo * 3600000 - 4 * 3600000);
  return d.toISOString().replace('Z', '+00:00');
};

const lpLead = (over = {}) => ({
  lp_lead_id: '900', lp_prospect_id: '1', first_name: 'Jane', last_name: 'Doe', phone: '3524453161',
  lead_source: 'Google PPC', disposition_code: null, call_count: 0, appointment_set: false, closed_won: false,
  created_at_lp: lpTs(3), updated_at_lp: lpTs(3), ...over,
});

function stubSQL({ leads = [], five9Fails = false, callPhones = [], lpPhonesForIntake = [] } = {}) {
  return async (sql) => {
    if (sql.includes('min(received_at)')) {
      if (five9Fails) throw new Error('statement timeout');
      return [{ first_at: '2026-07-28T20:28:17Z' }];
    }
    if (sql.includes('FROM five9_events_raw')) {
      const t = [new Date(NOW - 30 * 60000).toISOString()];
      return [{ keys: [], phones: callPhones.map((p) => [p, t]) }];
    }
    if (sql.includes('GROUP BY 1')) return [{ source: 'Google PPC', leads: 100, won: 10, avg_value: 12000 }];
    if (sql.includes(' IN (')) return lpPhonesForIntake.map((p) => ({ lp_lead_id: 'x', created_at_lp: lpTs(500), phone10: p }));
    if (sql.includes('FROM lp_leads')) return leads;
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
}

function stubDb() {
  const byTable = {};
  return {
    byTable,
    from: (table) => ({
      upsert: async (batch) => { (byTable[table] ||= []).push(...batch); return { error: null, count: batch.length }; },
    }),
  };
}

const baseDeps = (over = {}) => ({
  runSQL: stubSQL({ leads: [lpLead()] }),
  hlRunSQL: async () => [],
  checkDnc: async () => ({ on_dnc: [] }),
  getContactRecords: async () => ({ count: 1 }),
  supabase: stubDb(),
  postToSlack: async () => ({ ok: true }),
  reportAlertCondition: async () => { throw new Error('must not report'); },
  ...over,
});

test('hourly check, shadow: finds the waiting lead, sends nothing', async () => {
  const r = await runLeadUncalledCheck({ env: {}, nowMs: NOW, deps: baseDeps() });
  assert.equal(r.verdict, 'alert');
  assert.equal(r.mode, 'shadow');
});

test('hourly check, live: reports ONE card on ops that names the lead', async () => {
  const calls = [];
  const deps = baseDeps({ reportAlertCondition: async (args) => { calls.push(args); return { action: 'fired' }; } });
  const r = await runLeadUncalledCheck({ env: { LEAD_LEAK_ALERT_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.verdict, 'alert');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'lead_uncalled_fresh');
  assert.equal(calls[0].channel, 'ops');
  assert.equal(calls[0].active, true);
  const text = calls[0].text();
  assert.match(text, /Jane D\. · …3161/);
});

test('hourly check: a lead Five9 already rang is not waiting → healthy (clears)', async () => {
  const calls = [];
  const deps = baseDeps({
    runSQL: stubSQL({ leads: [lpLead()], callPhones: ['3524453161'] }),
    reportAlertCondition: async (args) => { calls.push(args); return { action: 'recovered' }; },
  });
  const r = await runLeadUncalledCheck({ env: { LEAD_LEAK_ALERT_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.verdict, 'healthy');
  assert.equal(calls[0].active, false);
});

test('hourly check: a failed Five9 read is "could not tell" — active null, never a clear', async () => {
  const calls = [];
  const deps = baseDeps({
    runSQL: stubSQL({ five9Fails: true }),
    reportAlertCondition: async (args) => { calls.push(args); return { action: 'noop' }; },
  });
  const r = await runLeadUncalledCheck({ env: { LEAD_LEAK_ALERT_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.readFailed, true);
  assert.equal(calls[0].active, null);
});

test('a lead that arrived overnight is not "waiting" before the call center opens', async () => {
  const early = Date.parse('2026-09-26T12:30:00Z'); // 08:30 ET
  const lead = lpLead({ created_at_lp: '2026-09-25T23:30:00+00:00' }); // 23:30 ET the night before
  const m = await measureLeadLeak({
    env: {}, nowMs: early, deps: baseDeps({ runSQL: stubSQL({ leads: [lead] }) }),
    opts: { windowDays: 2, lookups: false, rates: false, intake: false },
  });
  assert.equal(m.offenders.length, 0, 'only 30 working minutes have passed');
});

test('daily pass stores speed + intake rows; a failed HL read leaves intake "could not tell"', async () => {
  const deps = baseDeps({
    hlRunSQL: async () => [
      { ghl_contact_id: 'g1', first_name: 'Sam', last_name: 'Lee', phone: '(941) 555-0101', source: 'Modernize', date_added: '2026-09-20T12:00:00Z' },
      { ghl_contact_id: 'g2', first_name: 'Ann', last_name: 'Ray', phone: '941-555-0102', source: 'Chat Widget', date_added: '2026-09-21T12:00:00Z' },
    ],
    runSQL: stubSQL({ leads: [lpLead()], lpPhonesForIntake: ['9415550102'] }),
  });
  const r = await runLeadLeakMonitor({ env: {}, nowMs: NOW, deps });
  assert.equal(r.ok, true);
  const gap = deps.supabase.byTable.lead_intake_gap_daily;
  assert.deepEqual(gap.map((g) => [g.ghl_contact_id, g.class]), [['g1', 'not_in_lp'], ['g2', 'in_lp_unlinked']]);
  assert.ok(deps.supabase.byTable.lead_call_speed_daily.length >= 1);

  const failing = baseDeps({ hlRunSQL: async () => { throw new Error('HL down'); } });
  const m = await measureLeadLeak({ env: {}, nowMs: NOW, deps: failing });
  assert.equal(m.intake, null);
  assert.ok(m.errors.some((e) => /intake gap: HL down/.test(e)));
  assert.equal(shouldAlertIntakeGap(null, { readOk: false }).verdict, 'insufficient_evidence');
  assert.notEqual(m.verdict, 'insufficient_evidence', 'the leak counts still stand');
});

test('daily pass, alerts live: never-reached-LP card names the contact', async () => {
  const calls = [];
  const deps = baseDeps({
    hlRunSQL: async () => [{ ghl_contact_id: 'g1', first_name: 'Sam', last_name: 'Lee', phone: '9415550101',
      source: 'Modernize', date_added: '2026-09-20T12:00:00Z' }],
    reportAlertCondition: async (args) => { calls.push(args); return { action: 'fired' }; },
  });
  await runLeadLeakMonitor({ env: { LEAD_LEAK_ALERT_MODE: 'live' }, nowMs: NOW, deps });
  const intake = calls.find((c) => c.key === 'lead_intake_gap');
  assert.equal(intake.active, true);
  assert.match(intake.text(), /Sam L\. · …0101 · Modernize/);
  const speed = calls.find((c) => c.key === 'lead_speed_slow');
  assert.equal(speed.active, null, 'one lead is too little to judge a trend');
});

test('a lead keyed in during a live call counts as worked, and stays out of the speed numbers', async () => {
  // The inbound call began 7 minutes before the agent keyed the lead in.
  const lead = lpLead({ created_at_lp: lpTs(4) });
  const createdMs = lpLocalToUtcMs(lead.created_at_lp);
  const live = [new Date(createdMs - 7 * 60000).toISOString()];
  const runSQL = async (sql) => {
    if (sql.includes('min(received_at)')) return [{ first_at: '2026-07-28T20:28:17Z' }];
    if (sql.includes('FROM five9_events_raw')) return [{ keys: [], phones: [['3524453161', live]] }];
    if (sql.includes('FROM lp_leads')) return [lead];
    return [];
  };
  const m = await measureLeadLeak({ env: {}, nowMs: NOW, deps: baseDeps({ runSQL }), opts: { windowDays: 2, intake: false } });
  assert.equal(m.called, 1, 'the live call counts as working the lead');
  assert.equal(m.created_on_live_call, 1);
  assert.equal(m.offenders.length, 0);
  assert.equal(m.speed.daily.reduce((n, d) => n + d.leads, 0), 0, 'never waited — not in the speed rows');
  // A call more than an hour before creation is someone else's (an earlier lead).
  const old = [new Date(createdMs - 90 * 60000).toISOString()];
  const runOld = async (sql) => (sql.includes('FROM five9_events_raw') && !sql.includes('min(received_at)')
    ? [{ keys: [], phones: [['3524453161', old]] }] : runSQL(sql));
  const m2 = await measureLeadLeak({ env: {}, nowMs: NOW, deps: baseDeps({ runSQL: runOld }), opts: { windowDays: 2, intake: false, lookups: false } });
  assert.equal(m2.called, 0);
});
