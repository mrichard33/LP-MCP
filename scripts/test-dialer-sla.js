/**
 * test-dialer-sla.js — src/health/dialer-sla.js (System Health 1.1).
 *
 * The replay: 2026-10-13 in lead_call_speed_daily is 152 leads, 77 owed a
 * call, 70 called, 7 never called. Rebuilt as a fixture (ids and timings, no
 * customer data) and evaluated the next morning: the 7 must be flagged, and
 * only they are "never dialed". Plus: the Confirmation deadlines, the list
 * check's Five9 lookups (cap, errors → unknown), the 3-in-24 cap, never-again,
 * a failed read is unknown, and nothing before 08:00 ET.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  runDialerSlaCheck, resetDialerSlaState, listSatisfies, slaMinutesFor, outboundDialCampaigns,
} from '../src/health/dialer-sla.js';
import { resolveStatus } from '../src/health/record.js';
import { backstopConfig } from '../src/new-lead-dial-backstop.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('../src/health/registry.snapshot.json', import.meta.url)));
const REGISTRY = new Map(SNAPSHOT.checks.map((r) => [r.check_id, r]));
const status = (e) => resolveStatus(e, REGISTRY.get(e.check_id));

// LP stores Eastern wall clock tagged +00:00.
const lpTs = (etWall) => `${etWall}+00:00`;
const NEXT_MORNING = Date.parse('2026-10-14T13:00:00Z'); // 09:00 ET

/** 152 leads on 2026-10-13: 77 owed a call (70 called within 2 min, 7 never), 75 dead. */
function replayFixture() {
  const leads = [];
  const keys = new Map();
  for (let i = 0; i < 152; i += 1) {
    const id = String(582800 + i);
    const hour = 9 + (i % 10); // 09:00..18:00 ET arrivals
    const created = `2026-10-13T${String(hour).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`;
    const owed = i < 77;
    leads.push({
      lp_lead_id: id, first_name: `Lead${i}`, last_name: 'Test', phone: `352555${String(1000 + i).slice(-4)}`,
      lead_source: i % 2 ? 'Google PPC' : 'Internet', lead_source_detail: '',
      disposition_code: owed ? 'Data' : 'CXL', appointment_date: null, created_at_lp: lpTs(created),
    });
    if (owed && i >= 7) {
      // EDT: ET wall + 4h = UTC; called two minutes after arrival.
      const createdUtc = Date.parse(`${created}Z`) + 4 * 3_600_000;
      keys.set(`LDS${id}`, [createdUtc + 2 * 60_000]);
    }
  }
  return { leads, history: { keys, phones: new Map(), last: new Map() } };
}

function deps(over = {}) {
  const { leads, history } = replayFixture();
  return {
    registry: REGISTRY,
    supabase: null,
    runSQL: async (q) => {
      if (/FROM lp_leads\s+WHERE created_at_lp/.test(q)) return leads;
      if (/disposition_code IN \('Set', 'Verif'\)/.test(q)) return [];
      if (/target_id = 'Callback Request'/.test(q)) return [];
      if (/HAVING count\(\*\) > 3/.test(q)) return [];
      if (/WITH newest AS/.test(q)) return [];
      return [];
    },
    readHistory: async () => history,
    readRates: async () => new Map([['Google PPC', { perLead: 500 }], ['Internet', { perLead: 300 }]]),
    lookupContact: async () => 'absent',
    five9: {
      getCampaigns: async () => ({ campaigns: [{ name: 'DIAL ASAP', type: 'OUTBOUND', state: 'RUNNING' }, { name: 'Simpletext outbound', type: 'OUTBOUND', state: 'RUNNING' }] }),
      getContactRecords: async () => ({ count: 0 }),
      getStatistics: async () => ({ records: [] }),
      getListsInfo: async () => ({ lists: [] }),
      getOutboundCampaign: async () => ({ lists: [] }),
    },
    ...over,
  };
}

test('replay 2026-10-13: the 7 never-called leads are flagged, and only they read never dialed', async () => {
  resetDialerSlaState();
  const out = await runDialerSlaCheck({ env: {}, nowMs: NEXT_MORNING, deps: deps(), force: true, only: ['dialer.first_dial_sla'] });
  const first = out.health.find((h) => h.check_id === 'dialer.first_dial_sla');
  assert.equal(first.detail.leads_measured, 77);
  assert.equal(first.detail.never_dialed, 7);
  const flagged = first.detail.leads.filter((l) => !l.dialed).map((l) => l.lp_lead_id).sort();
  assert.deepEqual(flagged, ['582800', '582801', '582802', '582803', '582804', '582805', '582806']);
  assert.equal(status(first), 'fail', '7 leads past 30 min');
  assert.equal(first.detail.leads[0].name, 'Lead0 T.');
  assert.ok(first.detail.est_value_at_risk > 0);
});

test('the 7 are also off their expected list (Five9 has no record)', async () => {
  resetDialerSlaState();
  const out = await runDialerSlaCheck({ env: {}, nowMs: NEXT_MORNING, deps: deps(), force: true, only: ['dialer.list_membership_sla'] });
  const list = out.health.find((h) => h.check_id === 'dialer.list_membership_sla');
  assert.equal(list.detail.late, 7);
  assert.ok(list.detail.leads.every((l) => ['Direct Lead Entry', 'Callback Request'].includes(l.expected_list)));
  assert.equal(status(list), 'fail');
});

test('the list check: every lookup failing is unknown, never pass; the cap holds', async () => {
  resetDialerSlaState();
  const d = deps({ lookupContact: async () => 'error' });
  const out = await runDialerSlaCheck({ env: {}, nowMs: NEXT_MORNING, deps: d, force: true, only: ['dialer.list_membership_sla'] });
  assert.equal(out.health.find((h) => h.check_id === 'dialer.list_membership_sla').status, 'unknown');
  resetDialerSlaState();
  let lookups = 0;
  const snap = new Map(REGISTRY);
  snap.set('dialer.list_membership_sla', { ...REGISTRY.get('dialer.list_membership_sla'), config: { ...REGISTRY.get('dialer.list_membership_sla').config, lookup_cap: 3 } });
  await runDialerSlaCheck({ env: {}, nowMs: NEXT_MORNING, deps: deps({ registry: snap, lookupContact: async () => { lookups += 1; return { list: 'LP_ASAP' }; } }), force: true, only: ['dialer.list_membership_sla'] });
  assert.equal(lookups, 3);
});

test('a lead on any DIAL ASAP list satisfies a DIAL ASAP intent; either Conf list a Conf intent', () => {
  const cfg = backstopConfig({});
  assert.equal(listSatisfies({ intent: 'dial_asap', list: 'Direct Lead Entry' }, 'LP_ASAP', cfg), true);
  assert.equal(listSatisfies({ intent: 'dial_asap', list: 'Direct Lead Entry' }, 'After DIAL ASAP', cfg), true);
  assert.equal(listSatisfies({ intent: 'dial_asap', list: 'Direct Lead Entry' }, null, cfg), false);
  assert.equal(listSatisfies({ intent: 'conf_next_day', list: 'Conf - Next Day' }, 'Conf - 2nd Day', cfg), true);
  assert.equal(listSatisfies({ intent: 'callback', list: 'Callback Request' }, 'LP_ASAP', cfg), false);
  assert.equal(slaMinutesFor('dial_asap', { sla_min: { 'DIAL ASAP': 5 } }), 5);
  assert.equal(slaMinutesFor('conf_next_day', {}), null);
});

test('a failed read makes its checks unknown; the others still run', async () => {
  resetDialerSlaState();
  const out = await runDialerSlaCheck({
    env: {}, nowMs: NEXT_MORNING, force: true,
    deps: deps({ readHistory: async () => { throw new Error('five9 history timed out'); } }),
  });
  const by = new Map(out.health.map((h) => [h.check_id, h]));
  assert.equal(by.get('dialer.first_dial_sla').status, 'unknown');
  assert.match(by.get('dialer.first_dial_sla').summary, /timed out/);
  assert.equal(by.get('dialer.list_membership_sla').status, 'unknown');
  assert.notEqual(by.get('dialer.cap_3_in_24').status, 'unknown');
  assert.equal(by.get('dialer.unmapped_last').status, 'unknown', 'list-level dials are not in five9_events_raw');
});

test('cap 3 in 24: bands from config; texts are not dials', async () => {
  resetDialerSlaState();
  assert.deepEqual(outboundDialCampaigns({ campaigns: [{ name: 'DIAL ASAP', type: 'OUTBOUND' }, { name: 'Simpletext outbound', type: 'OUTBOUND' }, { name: 'Main Number', type: 'INBOUND' }] }), ['DIAL ASAP']);
  const out = await runDialerSlaCheck({
    env: {}, nowMs: NEXT_MORNING, force: true, only: ['dialer.cap_3_in_24'],
    deps: deps({ runSQL: async (q) => (/HAVING count\(\*\) > 3/.test(q) ? [{ phone: '3525550100', dials: 5, campaigns: ['DIAL ASAP'] }] : []) }),
  });
  assert.equal(status(out.health[0]), 'fail');
});

test('outside 08:00-20:00 ET the windowed checks are skipped, not passed', async () => {
  resetDialerSlaState();
  const out = await runDialerSlaCheck({ env: {}, nowMs: Date.parse('2026-10-14T03:00:00Z'), deps: deps(), force: true, only: ['dialer.first_dial_sla', 'dialer.list_stalled'] });
  for (const h of out.health) assert.equal(h.status, 'skipped', h.check_id);
});

test('mode off writes nothing', async () => {
  assert.equal((await runDialerSlaCheck({ env: { DIALER_SLA_MODE: 'off' }, deps: deps() })).skipped, true);
});
