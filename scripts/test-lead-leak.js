/**
 * scripts/test-lead-leak.js
 *
 * Offline coverage for the Lead Leak Monitor: the pure classifier
 * (src/lead-leak-classify.js) and the measure/run pass
 * (src/jobs/lead-leak-monitor.js) with every read stubbed through deps.
 *
 * What these guard, in order of cost if broken:
 *   - a failed Five9 read is `insufficient_evidence`, never "0 leaks",
 *   - a booked/sold lead with no calls is never counted as a leak,
 *   - "Data" leads stay out of the $ headline until Mark rules,
 *   - first match wins in the handoff's order,
 *   - phone normalisation and the LDS lead key (the join that makes this work),
 *   - shadow never posts to Slack.
 *
 * Run: node --test scripts/test-lead-leak.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePhone10, leadKey, wasCalled, classifyUncalledLead, finalizeReason,
  buildRates, estimateValue, summarize, formatSlackSummary, REASONS, LEAK_REASONS,
  REP_HOLD_DAYS, holdDateUnknown, needsDncCheck,
} from '../src/lead-leak-classify.js';
import {
  measureLeadLeak, runLeadLeakMonitor, leadLeakMode, leadLeakConfig,
} from '../src/jobs/lead-leak-monitor.js';

const lead = (over = {}) => ({
  lp_lead_id: '600001',
  lp_prospect_id: '423639',
  phone: '(352) 445-3161',
  lead_source: 'Google PPC',
  disposition_code: null,
  call_count: 0,
  appointment_set: false,
  closed_won: false,
  created_at_lp: '2026-09-20T12:00:00Z',
  ...over,
});

/* --- pure classifier ---------------------------------------------------- */

test('phone normalisation: +1 and punctuated forms are the same number', () => {
  assert.equal(normalizePhone10('+13524453161'), '3524453161');
  assert.equal(normalizePhone10('(352) 445-3161'), '3524453161');
  assert.equal(normalizePhone10('+13524453161'), normalizePhone10('(352) 445-3161'));
  assert.equal(normalizePhone10('352-445-316'), null, 'nine digits is not a phone');
  assert.equal(normalizePhone10('0524453161'), null, 'no NANP area code starts with 0');
  assert.equal(normalizePhone10(''), null);
  assert.equal(normalizePhone10(null), null);
});

test('key build: lead 600001 → LDS600001 — the LEAD id, not INQ || prospect', () => {
  // The handoff named 'INQ' || lp_prospect_id. Measured 2026-09-26 its phones
  // agreed 0 times in 601 joins; LDS || lp_lead_id agreed 27 of 28.
  assert.equal(leadKey(600001), 'LDS600001');
  assert.equal(leadKey('600001'), 'LDS600001');
  assert.equal(leadKey(null), null);
  const inqOnly = { five9Keys: new Map([['INQ423639', [Date.parse('2026-09-21T00:00:00Z')]]]), five9Phones: new Map() };
  assert.equal(wasCalled(lead(), inqOnly), false, 'an INQ key never marks a lead called');
});

test('called = LDS key match OR a phone call on/after the lead was created (Five9 times)', () => {
  const none = { five9Keys: new Map(), five9Phones: new Map() };
  const after = Date.parse('2026-09-21T00:00:00Z');
  const before = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(wasCalled(lead(), none), false);
  assert.equal(wasCalled(lead(), { ...none, five9Keys: new Map([['LDS600001', [after]]]) }), true);
  assert.equal(wasCalled(lead(), { ...none, five9Phones: new Map([['3524453161', [after]]]) }), true);
  assert.equal(wasCalled(lead({ phone: '+13524453161' }), { ...none, five9Phones: new Map([['3524453161', [after]]]) }), true);
  // Dialled weeks before this lead existed — that was some earlier lead.
  assert.equal(wasCalled(lead(), { ...none, five9Phones: new Map([['3524453161', [before]]]) }), false);
  // LP call_count is a hint only — it never makes a lead "called".
  assert.equal(wasCalled(lead({ call_count: 9 }), none), false);
});

test('first match wins: a DNC lead that is also Data is `dnc`', () => {
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'DNC' })), 'dnc');
  const onFive9Dnc = { five9Dnc: new Set(['3524453161']) };
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'Data' }), onFive9Dnc), 'dnc');
});

test('Set / Sale with zero calls → already_progressed (by code), never a leak', () => {
  for (const code of ['Set', 'Sale', 'Cnf', 'Verif', 'Issue', 'Reset']) {
    assert.equal(classifyUncalledLead(lead({ disposition_code: code })), 'already_progressed', code);
  }
  // Progressed beats DNC — it is a data-quality number, not a dial decision.
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'Sale' }), { five9Dnc: new Set(['3524453161']) }), 'already_progressed');

  const s = summarize([{ reason: 'already_progressed', lead_source: 'X', est_value: null }]);
  assert.equal(s.real_leaks, 0);
  assert.equal(s.by_reason.already_progressed.leads, 1);
});

test('progressed only by LP flag → already_progressed_flag, its own line', () => {
  assert.equal(classifyUncalledLead(lead({ appointment_set: true })), 'already_progressed_flag');
  assert.equal(classifyUncalledLead(lead({ closed_won: true })), 'already_progressed_flag');
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'CXL', appointment_set: true })), 'already_progressed_flag');
  assert.ok(!LEAK_REASONS.includes('already_progressed_flag'));
});

/* --- NIS / NoRehash / NOC / NIS2 (ruled 2026-09-26) --------------------- */

const daysAgo = (d) => new Date(NOW - d * 24 * 3600 * 1000).toISOString();

test('NIS → not_issued_call_center, a priced leak — even with appointment_set = true', () => {
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'NIS' }), { nowMs: NOW }), 'not_issued_call_center');
  assert.equal(
    classifyUncalledLead(lead({ disposition_code: 'NIS', appointment_set: true }), { nowMs: NOW }),
    'not_issued_call_center',
    'the current code wins over the flag (39 of 39 live NIS leads carry it)',
  );
  assert.ok(LEAK_REASONS.includes('not_issued_call_center'));
  const rates = buildRates([{ source: 'Google PPC', leads: 100, won: 10, avg_value: 12000 }]);
  assert.equal(estimateValue(lead(), 'not_issued_call_center', rates), 1200);
});

test('NoRehash 3 days old → rep_hold: not a leak, $0', () => {
  const l = lead({ disposition_code: 'NoRehash', updated_at_lp: daysAgo(3) });
  assert.equal(classifyUncalledLead(l, { nowMs: NOW }), 'rep_hold');
  assert.equal(holdDateUnknown(l), false);
  assert.ok(!LEAK_REASONS.includes('rep_hold'));
  const rates = buildRates([{ source: 'Google PPC', leads: 100, won: 10, avg_value: 12000 }]);
  assert.equal(estimateValue(l, 'rep_hold', rates), null);
});

test('NoRehash 10 days old → rep_hold_expired: the hold is over, a priced leak', () => {
  assert.equal(REP_HOLD_DAYS, 7);
  const l = lead({ disposition_code: 'NoRehash', updated_at_lp: daysAgo(10) });
  assert.equal(classifyUncalledLead(l, { nowMs: NOW }), 'rep_hold_expired');
  assert.ok(LEAK_REASONS.includes('rep_hold_expired'));
  const rates = buildRates([{ source: 'Google PPC', leads: 100, won: 10, avg_value: 12000 }]);
  assert.equal(estimateValue(l, 'rep_hold_expired', rates), 1200);
});

test('NoRehash with no date → rep_hold + hold_date_unknown, never guessed', () => {
  const l = lead({ disposition_code: 'NoRehash', updated_at_lp: null });
  assert.equal(classifyUncalledLead(l, { nowMs: NOW }), 'rep_hold');
  assert.equal(holdDateUnknown(l), true);
  const s = summarize([{ reason: 'rep_hold', lead_source: 'A', est_value: null, detail: { hold_date_unknown: true } }]);
  assert.equal(s.hold_date_unknown, 1);
  assert.equal(s.real_leaks, 0);
});

test('NoRehash with appointment_set = true → rep_hold / rep_hold_expired, not progressed', () => {
  const inHold = lead({ disposition_code: 'NoRehash', appointment_set: true, updated_at_lp: daysAgo(3) });
  const over = lead({ disposition_code: 'NoRehash', appointment_set: true, updated_at_lp: daysAgo(10) });
  assert.equal(classifyUncalledLead(inHold, { nowMs: NOW }), 'rep_hold');
  assert.equal(classifyUncalledLead(over, { nowMs: NOW }), 'rep_hold_expired');
  assert.equal(needsDncCheck(over, NOW), false, 'decided by its code — no DNC lookup spent on it');
});

test('NOC → not_covered_by_rep, a priced leak — even with appointment_set = true', () => {
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'NOC' }), { nowMs: NOW }), 'not_covered_by_rep');
  assert.equal(
    classifyUncalledLead(lead({ disposition_code: 'NOC', appointment_set: true }), { nowMs: NOW }),
    'not_covered_by_rep',
    'the current code wins over the flag (49 of 49 live NOC leads carry it)',
  );
  assert.ok(LEAK_REASONS.includes('not_covered_by_rep'));
  const rates = buildRates([{ source: 'Google PPC', leads: 100, won: 10, avg_value: 12000 }]);
  assert.equal(estimateValue(lead(), 'not_covered_by_rep', rates), 1200);
  const s = summarize([{ reason: 'not_covered_by_rep', lead_source: 'A', est_value: 1200 }]);
  assert.equal(s.real_leaks, 1);
  const text = formatSlackSummary({ runDate: '2026-09-26', windowDays: 60, summary: s });
  assert.match(text, /Set, but no rep covered it \(NOC\): 1/);
});

test('NIS2 → dead_status and counted as a retired code in use', () => {
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'NIS2' })), 'dead_status');
  const s = summarize([{ reason: 'dead_status', lead_source: 'A', est_value: null }], { retiredCodeInUse: 1 });
  assert.equal(s.retired_code_in_use, 1);
  const text = formatSlackSummary({ runDate: '2026-09-26', windowDays: 60, summary: s });
  assert.match(text, /Retired codes still in use \(NIS2\): 1/);
});

test('the rest of the order: missing_phone > duplicate > missing_source > data > dead', () => {
  assert.equal(classifyUncalledLead(lead({ phone: '123' })), 'missing_phone');
  const dup = { dupCalledPhones: new Set(['3524453161']) };
  assert.equal(classifyUncalledLead(lead({ lead_source: '' }), dup), 'duplicate');
  assert.equal(classifyUncalledLead(lead({ lead_source: '  ', disposition_code: 'Data' })), 'missing_source');
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'Data' })), 'data_undecided');
  assert.equal(classifyUncalledLead(lead({ disposition_code: 'data' })), 'data_undecided', 'case-insensitive');
  for (const code of ['CXL', 'NoHome', 'No Demo', 'ND', 'OPPFDN', 'CCC', '1Leg']) {
    assert.equal(classifyUncalledLead(lead({ disposition_code: code })), 'dead_status', code);
  }
  assert.equal(classifyUncalledLead(lead()), null, 'clean and callable → needs the Five9 lookup');
});

test('finalizeReason: absent / present / anything else', () => {
  assert.equal(finalizeReason('absent'), 'not_in_five9');
  assert.equal(finalizeReason('present'), 'routing_or_automation_failure');
  assert.equal(finalizeReason('over_cap'), 'unverified');
  assert.equal(finalizeReason('error'), 'unverified');
});

test('Data → data_undecided, excluded from the $ headline', () => {
  const rates = buildRates([{ source: 'Google PPC', leads: 100, won: 10, avg_value: 12000 }]);
  assert.equal(estimateValue(lead(), 'data_undecided', rates), null);
  assert.equal(estimateValue(lead(), 'routing_or_automation_failure', rates), 1200);
  const s = summarize([
    { reason: 'data_undecided', lead_source: 'Google PPC', est_value: null },
    { reason: 'routing_or_automation_failure', lead_source: 'Google PPC', est_value: 1200 },
  ]);
  assert.equal(s.real_leaks, 1);
  assert.equal(s.est_value_at_risk, 1200);
  assert.equal(s.by_reason.data_undecided.leads, 1);
  assert.deepEqual(s.top_sources, [{ source: 'Google PPC', leaks: 1 }]);
});

test('the Slack text labels $ an estimate and gives each bucket its own line', () => {
  const s = summarize([
    { reason: 'routing_or_automation_failure', lead_source: 'A', est_value: 500 },
    { reason: 'not_issued_call_center', lead_source: 'A', est_value: 300 },
    { reason: 'rep_hold_expired', lead_source: 'A', est_value: 200 },
    { reason: 'rep_hold', lead_source: 'A', est_value: null, detail: { hold_date_unknown: true } },
    { reason: 'already_progressed', lead_source: 'A', est_value: null },
    { reason: 'already_progressed_flag', lead_source: 'A', est_value: null },
    { reason: 'already_progressed_flag', lead_source: 'A', est_value: null },
    { reason: 'data_undecided', lead_source: 'A', est_value: null },
  ]);
  assert.equal(s.real_leaks, 3);
  const text = formatSlackSummary({ runDate: '2026-09-26', windowDays: 60, summary: s });
  assert.match(text, /Real leaks \(should be worked, never dialled\): \*3\*/);
  assert.match(text, /Revenue at risk \(estimate\): \*\$1,000\*/);
  assert.match(text, /Not issued to a rep \(call center, NIS\): 1/);
  assert.match(text, /Rep hold over, back in play \(NoRehash > 7 days\): 1/);
  assert.match(text, /On rep hold \(NoRehash, 7 days\): 1 \(1 with no hold date/);
  assert.match(text, /Booked\/sold by current code .*: 1/);
  assert.match(text, /only because LP's appointment\/won flag is on .*: 2/);
  assert.match(text, /"Data" leads awaiting a ruling: 1/);
  assert.match(text, /GET \/api\/lp\/lead-leak/);
  assert.ok(REASONS.every((r) => r in s.by_reason));
});

/* --- the pass, with stubbed reads -------------------------------------- */

const NOW = Date.parse('2026-09-26T12:00:00Z');

// Routes each SQL statement to a canned answer by what it reads.
function stubSQL({ five9Fails = false, leads = [], keys = [], phones = [], siblings = [] } = {}) {
  return async (sql) => {
    if (sql.includes('min(received_at)')) {
      if (five9Fails) throw new Error('statement timeout');
      return [{ first_at: '2026-07-28T20:28:17Z' }];
    }
    if (sql.includes('FROM five9_events_raw')) {
      // The day-slice shape: [key|phone, [call times]]. Every call lands an
      // hour before NOW — after every test lead was created.
      const t = [new Date(NOW - 3600 * 1000).toISOString()];
      return [{ keys: keys.map((k) => [k, t]), phones: phones.map((p) => [p, t]) }];
    }
    if (sql.includes('GROUP BY 1')) return [{ source: 'Google PPC', leads: 100, won: 10, avg_value: 12000 }];
    if (sql.includes(' IN (')) return siblings;
    if (sql.includes('FROM lp_leads')) return leads;
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
}

function stubDb() {
  const writes = [];
  return {
    writes,
    byTable: {},
    from(table) {
      return {
        upsert: async (batch) => {
          (this.byTable[table] ||= []).push(...batch);
          if (table === 'lead_leak_daily') writes.push(...batch);
          return { error: null, count: batch.length };
        },
      };
    },
  };
}

test('failed Five9 read → insufficient_evidence, not "0 leaks"; nothing stored or posted', async () => {
  const deps = {
    runSQL: stubSQL({ five9Fails: true, leads: [lead()] }),
    hlRunSQL: async () => [],
    checkDnc: async () => ({ on_dnc: [] }),
    getContactRecords: async () => ({ count: 1 }),
    supabase: stubDb(),
    postToSlack: async () => { throw new Error('must not post'); },
  };
  const m = await measureLeadLeak({ env: {}, nowMs: NOW, deps });
  assert.equal(m.verdict, 'insufficient_evidence');
  assert.equal(m.summary, null);
  assert.match(m.errors[0], /five9 history/);

  const r = await runLeadLeakMonitor({ env: { LEAD_LEAK_MONITOR_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.verdict, 'insufficient_evidence');
  assert.equal(r.readFailed, true, 'runJob files this `unknown`');
  assert.notEqual(r.ok, false, 'ok:false would file it `failed` — it could not tell');
  assert.equal(deps.supabase.writes.length, 0);
});

test('failed Five9 DNC read → insufficient_evidence (unknown DNC is never "clean")', async () => {
  const m = await measureLeadLeak({
    env: {}, nowMs: NOW,
    deps: {
      runSQL: stubSQL({ leads: [lead()] }),
      hlRunSQL: async () => [],
      checkDnc: async () => { throw new Error('Five9 auth breaker open'); },
      getContactRecords: async () => ({ count: 1 }),
    },
  });
  assert.equal(m.verdict, 'insufficient_evidence');
  assert.match(m.errors[0], /five9 dnc/);
});

test('end to end: called leads drop out, the rest are labelled, capped lookups go unverified', async () => {
  const leads = [
    lead({ lp_lead_id: '1', lp_prospect_id: '1', phone: '3525550001' }),                          // called by key
    lead({ lp_lead_id: '2', lp_prospect_id: '2', phone: '+1 352 555 0002' }),                     // called by phone
    lead({ lp_lead_id: '3', lp_prospect_id: '3', phone: '3525550003', disposition_code: 'Set' }), // progressed
    lead({ lp_lead_id: '4', lp_prospect_id: '4', phone: '3525550004', disposition_code: 'Data' }),
    lead({ lp_lead_id: '5', lp_prospect_id: '5', phone: '3525550005' }),                          // INQ5 ignored; lookup: present
    lead({ lp_lead_id: '6', lp_prospect_id: '6', phone: '3525550006' }),                          // lookup: absent
    lead({ lp_lead_id: '7', lp_prospect_id: '7', phone: '3525550007' }),                          // over the cap
    lead({ lp_lead_id: '8', lp_prospect_id: '8', phone: '3525550008' }),                          // duplicate
    lead({ lp_lead_id: '9', lp_prospect_id: '9', phone: '3525550009', disposition_code: 'NIS2' }), // called, but a retired code
  ];
  const lookedUp = [];
  const deps = {
    runSQL: stubSQL({
      leads,
      keys: ['LDS1', 'LDS99', 'LDS9', 'INQ5'],
      phones: ['(352) 555-0002'],
      siblings: [{ lp_lead_id: '99', created_at_lp: '2026-08-01T00:00:00Z', phone10: '3525550008' }],
    }),
    hlRunSQL: async () => [],
    checkDnc: async () => ({ on_dnc: [] }),
    getContactRecords: async ({ criteria }) => {
      lookedUp.push(criteria[0].value);
      return { count: criteria[0].value === '3525550006' ? 0 : 1 };
    },
    supabase: stubDb(),
    postToSlack: async () => { throw new Error('shadow must not post'); },
  };
  const m = await measureLeadLeak({ env: { LEAD_LEAK_FIVE9_LOOKUP_CAP: '2' }, nowMs: NOW, deps });
  assert.equal(m.universe, 9);
  assert.equal(m.called, 3);
  assert.equal(m.summary.retired_code_in_use, 1, 'counted over the whole window, called leads too');
  const byId = Object.fromEntries(m.rows.map((r) => [r.lp_lead_id, r.reason]));
  assert.deepEqual(byId, {
    3: 'already_progressed',
    4: 'data_undecided',
    5: 'routing_or_automation_failure',
    6: 'not_in_five9',
    7: 'unverified',
    8: 'duplicate',
  });
  assert.deepEqual(lookedUp, ['3525550005', '3525550006'], 'cap honoured');
  assert.equal(m.summary.real_leaks, 3);
  assert.equal(m.summary.est_value_at_risk, 3600);

  const r = await runLeadLeakMonitor({ env: { LEAD_LEAK_FIVE9_LOOKUP_CAP: '2' }, nowMs: NOW, deps });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'shadow');
  assert.equal(r.posted, false);
  assert.equal(deps.supabase.writes.length, 6);
});

test('live posts once; a failed post is a failed pass, not a quiet morning', async () => {
  const sent = [];
  const deps = {
    runSQL: stubSQL({ leads: [lead()] }),
    hlRunSQL: async () => [],
    checkDnc: async () => ({ on_dnc: [] }),
    getContactRecords: async () => ({ count: 1 }),
    supabase: stubDb(),
    postToSlack: async (text, channel) => { sent.push({ text, channel }); return { ok: false, error: 'channel_not_found' }; },
  };
  const r = await runLeadLeakMonitor({
    env: { LEAD_LEAK_MONITOR_MODE: 'live', LEAD_LEAK_SLACK_CHANNEL: 'C123' }, nowMs: NOW, deps,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'C123');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /channel_not_found/);
});

test('mode and config: default shadow, typo is shadow, off skips', async () => {
  assert.equal(leadLeakMode({}), 'shadow');
  assert.equal(leadLeakMode({ LEAD_LEAK_MONITOR_MODE: 'LIVE' }), 'live');
  assert.equal(leadLeakMode({ LEAD_LEAK_MONITOR_MODE: 'lvie' }), 'shadow');
  assert.equal(leadLeakConfig({}).windowDays, 60);
  assert.equal(leadLeakConfig({}).lookupCap, 300);
  assert.equal(leadLeakConfig({ LEAD_LEAK_WINDOW_DAYS: 'abc' }).windowDays, 60);
  const r = await runLeadLeakMonitor({ env: { LEAD_LEAK_MONITOR_MODE: 'off' }, deps: {} });
  assert.equal(r.skipped, true);
});
