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
  percentile, dailySpeedRows, speedStats, isOpenAt, BUSINESS_HOURS,
} from '../src/lead-speed.js';
import {
  buildIntakeCandidatesSql, classifyIntakeGap, summarizeIntakeGap, LP_ID_FIELDS,
} from '../src/lead-intake-gap.js';
import {
  shouldAlertSpeed, shouldAlertUncalled, shouldAlertIntakeGap, verdictToActive, alertMode, alertConfig,
  formatSpeedAlert, formatUncalledAlert, formatIntakeGapAlert, displayName, phoneTail, formatWait, shiftDay,
  ALERT_DEFAULTS,
} from '../src/lead-speed-alerts.js';
import {
  runLeadLeakMonitor, runLeadUncalledCheck, measureLeadLeak, cleanupOldRows, cleanupConfig,
} from '../src/jobs/lead-leak-monitor.js';

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
  assert.match(text, /1 lead waiting more than 2h for a Five9 call/);
  assert.match(text, /\*Never dialled — Five9 has the number — 1\*/, 'grouped under its reason');
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

function stubSQL({
  leads = [], five9Fails = false, callPhones = [], lpPhonesForIntake = [], inAreaZips = [], serviceAreaFails = false,
} = {}) {
  return async (sql) => {
    if (sql.includes('service_area_zips')) {
      if (serviceAreaFails) throw new Error('service_area_zips unreadable');
      return inAreaZips.map((zip) => ({ zip }));
    }
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

// Upserts are recorded per table; `old` seeds rows the cleanup can see, as
// { table: [{ run_date | created_day }] }. delete/select(head) honour .lt().
function stubDb({ old = {}, failTable = null } = {}) {
  const byTable = {};
  const deleted = {};
  const seeded = Object.fromEntries(Object.entries(old).map(([t, rows]) => [t, [...rows]]));
  const lt = (table, op) => ({
    lt: async (col, cutoff) => {
      if (table === failTable) return { error: { message: 'boom' }, count: null };
      const rows = seeded[table] || [];
      const hit = rows.filter((r) => String(r[col]) < cutoff);
      if (op === 'delete') {
        seeded[table] = rows.filter((r) => !(String(r[col]) < cutoff));
        deleted[table] = (deleted[table] || 0) + hit.length;
      }
      return { error: null, count: hit.length };
    },
  });
  return {
    byTable,
    deleted,
    seeded,
    from: (table) => ({
      upsert: async (batch) => { (byTable[table] ||= []).push(...batch); return { error: null, count: batch.length }; },
      delete: () => lt(table, 'delete'),
      select: () => lt(table, 'select'),
    }),
  };
}

const baseDeps = (over = {}) => ({
  runSQL: stubSQL({ leads: [lpLead()] }),
  hlRunSQL: async () => [],
  checkDnc: async () => ({ on_dnc: [] }),
  getContactRecords: async () => ({ count: 1 }),
  findLeadInDataQueues: async () => ({ present: false, row: null, truncated_queues: [] }),
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
  // 2026-09-29: a call more than an hour before creation is no longer "someone
  // else's" — it is the inquiry-stage dial (LEAD_PRECREATE_CALL_HOURS, 48h).
  // Called, and kept out of the speed numbers like the live call.
  const phonesAt = (times) => async (sql) => (sql.includes('FROM five9_events_raw') && !sql.includes('min(received_at)')
    ? [{ keys: [], phones: [['3524453161', times]] }] : runSQL(sql));
  const opts = { windowDays: 2, intake: false, lookups: false };
  const early = [new Date(createdMs - 90 * 60000).toISOString()];
  const m2 = await measureLeadLeak({ env: {}, nowMs: NOW, deps: baseDeps({ runSQL: phonesAt(early) }), opts });
  assert.equal(m2.called, 1);
  assert.equal(m2.called_before_creation, 1);
  assert.equal(m2.speed.daily.reduce((n, d) => n + d.leads, 0), 0, 'no negative or zero minutes in the speed rows');
  // Past the pre-create window it is not this lead's call.
  const tooEarly = [new Date(createdMs - 49 * 3600000).toISOString()];
  const m3 = await measureLeadLeak({ env: {}, nowMs: NOW, deps: baseDeps({ runSQL: phonesAt(tooEarly) }), opts });
  assert.equal(m3.called, 0);
  const m4 = await measureLeadLeak({
    env: { LEAD_PRECREATE_CALL_HOURS: '72' }, nowMs: NOW, deps: baseDeps({ runSQL: phonesAt(tooEarly) }), opts,
  });
  assert.equal(m4.called, 1, 'LEAD_PRECREATE_CALL_HOURS widens it');
});

/* --- close-out fixes (2026-09-28) ------------------------------------- */

const OLD = {
  lead_leak_daily: [{ run_date: '2026-06-01' }, { run_date: '2026-06-29' }, { run_date: '2026-09-27' }],
  lead_intake_gap_daily: [{ run_date: '2026-06-01' }, { run_date: '2026-09-27' }],
  lead_call_speed_daily: [{ created_day: '2026-06-15' }, { created_day: '2026-08-01' }],
};

test('cleanup: dry run counts rows older than 90 days and deletes nothing', async () => {
  const db = stubDb({ old: OLD });
  const c = await cleanupOldRows({ db, runDate: '2026-09-28', env: {} });
  assert.equal(c.mode, 'dry_run', 'the code default is a dry run');
  assert.equal(c.cutoff, '2026-06-30');
  assert.deepEqual(c.byTable, { lead_leak_daily: 2, lead_intake_gap_daily: 1, lead_call_speed_daily: 1 });
  assert.equal(c.removed, 4);
  assert.deepEqual(db.deleted, {});
});

test('cleanup: live deletes exactly those rows; off does nothing; a failing table is reported, not thrown', async () => {
  const db = stubDb({ old: OLD });
  const c = await cleanupOldRows({ db, runDate: '2026-09-28', env: { LEAD_LEAK_CLEANUP_MODE: 'live' } });
  assert.equal(c.removed, 4);
  assert.deepEqual(db.deleted, { lead_leak_daily: 2, lead_intake_gap_daily: 1, lead_call_speed_daily: 1 });
  assert.equal(db.seeded.lead_leak_daily.length, 1, 'yesterday survives');

  const off = await cleanupOldRows({ db: stubDb({ old: OLD }), runDate: '2026-09-28', env: { LEAD_LEAK_CLEANUP_MODE: 'off' } });
  assert.equal(off.removed, null);

  const bad = await cleanupOldRows({ db: stubDb({ old: OLD, failTable: 'lead_intake_gap_daily' }),
    runDate: '2026-09-28', env: { LEAD_LEAK_CLEANUP_MODE: 'live' } });
  assert.equal(bad.removed, null);
  assert.match(bad.errors[0], /cleanup lead_intake_gap_daily: boom/);
  assert.equal(bad.byTable.lead_leak_daily, 2, 'the other tables still ran');
  assert.equal(cleanupConfig({ LEAD_LEAK_RETENTION_DAYS: '30' }).retentionDays, 30);
});

test('daily pass runs the cleanup AFTER storing, reports its count, and a cleanup failure never fails the pass', async () => {
  const order = [];
  const db = stubDb({ old: OLD });
  const wrapped = {
    ...db,
    from: (table) => {
      const t = db.from(table);
      return {
        upsert: async (b) => { order.push(`store:${table}`); return t.upsert(b); },
        delete: () => ({ lt: async (c, v) => { order.push(`delete:${table}`); return t.delete().lt(c, v); } }),
        select: () => ({ lt: async (c, v) => { order.push(`count:${table}`); return t.select().lt(c, v); } }),
      };
    },
  };
  const sent = [];
  const deps = baseDeps({ supabase: wrapped, postToSlack: async (text) => { sent.push(text); return { ok: true }; } });
  const r = await runLeadLeakMonitor({ env: { LEAD_LEAK_MONITOR_MODE: 'live', LEAD_LEAK_CLEANUP_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.ok, true);
  assert.ok(order.indexOf('store:lead_leak_daily') < order.indexOf('delete:lead_leak_daily'), order.join(' '));
  // This file's NOW is 2026-09-26 → cutoff 2026-06-28: three seeded rows are older.
  assert.match(sent[0], /🧹 Cleanup: removed 3 rows older than 90 days/);
  assert.match(r.summary, /cleanup_live=3/);

  const failing = baseDeps({ supabase: stubDb({ old: OLD, failTable: 'lead_leak_daily' }) });
  const r2 = await runLeadLeakMonitor({ env: { LEAD_LEAK_CLEANUP_MODE: 'live' }, nowMs: NOW, deps: failing });
  assert.equal(r2.ok, true, 'a failed cleanup is a note, not a failed monitor');
  assert.ok(r2.notes.some((n) => /cleanup lead_leak_daily/.test(n)));
});

test('NOC zip lookup: in-area stays a leak, out-of-area goes to review, a failed lookup keeps it a leak', async () => {
  const noc = (id, zip) => lpLead({ lp_lead_id: id, phone: `35255500${id.slice(-2)}`, disposition_code: 'NOC', zip });
  const leads = [noc('911', '33914'), noc('912', '90210')];
  const m = await measureLeadLeak({ env: {}, nowMs: NOW, deps: baseDeps({ runSQL: stubSQL({ leads, inAreaZips: ['33914'] }) }),
    opts: { intake: false } });
  const byId = Object.fromEntries(m.rows.map((r) => [r.lp_lead_id, r.reason]));
  assert.deepEqual(byId, { 911: 'not_covered_by_rep', 912: 'noc_out_of_area' });
  assert.equal(m.rows.find((r) => r.lp_lead_id === '912').est_value, null, '$0 — not priced');

  const failed = await measureLeadLeak({ env: {}, nowMs: NOW,
    deps: baseDeps({ runSQL: stubSQL({ leads, serviceAreaFails: true }) }), opts: { intake: false } });
  assert.ok(failed.rows.every((r) => r.reason === 'not_covered_by_rep'));
  assert.ok(failed.errors.some((e) => /service area: .*NOC kept as leaks/.test(e)));
});

test('daily pass, alerts live: a NIS2 set in the last day fires the retired-code card naming the lead', async () => {
  const calls = [];
  const fresh = lpLead({ lp_lead_id: '930', first_name: 'Pat', last_name: 'Lee', phone: '3525550930',
    disposition_code: 'NIS2', created_at_lp: lpTs(48), updated_at_lp: lpTs(2) });
  const old = lpLead({ lp_lead_id: '931', phone: '3525550931', disposition_code: 'NIS2',
    created_at_lp: lpTs(400), updated_at_lp: lpTs(300) });
  const deps = baseDeps({
    runSQL: stubSQL({ leads: [fresh, old] }),
    reportAlertCondition: async (args) => { calls.push(args); return { action: 'fired' }; },
  });
  await runLeadLeakMonitor({ env: { LEAD_LEAK_ALERT_MODE: 'live' }, nowMs: NOW, deps });
  const card = calls.find((c) => c.key === 'lead_retired_code');
  assert.equal(card.active, true);
  assert.equal(card.channel, 'ops');
  const text = card.text();
  assert.match(text, /Retired code used on 1 lead/);
  assert.match(text, /Pat L\. · coded NIS2 · LP 930/);
  assert.ok(!text.includes('LP 931'), 'an old NIS2 is history, not a new use');
});

/* --- business hours only (2026-09-29) -------------------------------- */
// The user's ruling: only business hours count — 8am–8pm ET Monday–Friday,
// 9am–5pm ET Saturday–Sunday. 2026-09-26 is a Saturday, 09-28 a Monday. LP
// timestamps below are Eastern digits (see lpLocalToUtcMs); Five9 times are UTC
// (ET = UTC−4 in late September).

test('a lead that arrives at 4am has waited 0 until 8am, and 1h at 9am', () => {
  const at4am = '2026-09-29T04:00:00+00:00'; // Tuesday 04:00 ET
  assert.equal(waitingMs(at4am, Date.parse('2026-09-29T11:30:00Z')), 0, '7:30am ET — still closed');
  assert.equal(waitingMs(at4am, Date.parse('2026-09-29T13:00:00Z')), 60 * 60000, '9am ET');
});

test('closed hours overnight are not counted', () => {
  // Monday 3pm ET → Tuesday 9am ET: 5h Monday + 1h Tuesday, not 18h.
  assert.equal(waitingMs('2026-09-28T15:00:00+00:00', Date.parse('2026-09-29T13:00:00Z')), 6 * 3600000);
  // Monday 7pm ET, first call Tuesday 8:30am ET → 60 + 30 business minutes.
  assert.equal(minutesToFirstCall('2026-09-28T19:00:00+00:00', Date.parse('2026-09-29T12:30:00Z')), 90);
});

test('weekends open 9am–5pm', () => {
  const iso = (ms) => new Date(ms).toISOString();
  // Saturday 8:30am ET → opens 9am ET.
  assert.equal(iso(workingStartMs(Date.parse('2026-09-26T12:30:00Z'))), '2026-09-26T13:00:00.000Z');
  // Saturday 6pm ET (after the 5pm close) → Sunday 9am ET.
  assert.equal(iso(workingStartMs(Date.parse('2026-09-26T22:00:00Z'))), '2026-09-27T13:00:00.000Z');
  // Friday 9pm ET → Saturday 9am ET, not 8am.
  assert.equal(iso(workingStartMs(Date.parse('2026-09-26T01:00:00Z'))), '2026-09-26T13:00:00.000Z');
  // Sunday 6pm ET → Monday 8am ET.
  assert.equal(iso(workingStartMs(Date.parse('2026-09-27T22:00:00Z'))), '2026-09-28T12:00:00.000Z');
  // Saturday 4pm ET → Sunday 10am ET: 1h Saturday + 1h Sunday.
  assert.equal(waitingMs('2026-09-26T16:00:00+00:00', Date.parse('2026-09-27T14:00:00Z')), 2 * 3600000);
  assert.equal(isOpenAt(Date.parse('2026-09-26T12:30:00Z')), false, 'Sat 8:30am');
  assert.equal(isOpenAt(Date.parse('2026-09-26T13:30:00Z')), true, 'Sat 9:30am');
  assert.equal(isOpenAt(Date.parse('2026-09-26T21:30:00Z')), false, 'Sat 5:30pm');
  assert.equal(isOpenAt(Date.parse('2026-09-28T23:30:00Z')), true, 'Mon 7:30pm');
  assert.deepEqual(BUSINESS_HOURS, { weekday: { open: 8, close: 20 }, weekend: { open: 9, close: 17 } });
});
