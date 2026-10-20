/**
 * The 08:00 ops digest names only what needs a person (handoff v3.4 Fix 7,
 * 2026-10-16). Fixes are one "Auto-fixed: N (no action)" section.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const digest = await import('../src/jobs/ops-morning-digest.js');
const { fakeSupabase } = await import('./lib/fake-supabase.js');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();

function run(tables = {}, { f0 = {}, env = {} } = {}) {
  const sent = [];
  const db = fakeSupabase({ agent_actions: [], alert_conditions: [], audit_posted_items: [], system_events: [], lp_leads: [], lp_sync_failure_notices: [], ...tables });
  const deps = {
    __noDefaults: true, nowMs: NOW, today: '2026-10-16', supabase: db, env,
    hlRunSQL: async () => [],
    sendAlertMessage: async (text) => { sent.push(text); return { sent: true }; },
    runJob: async (id, fn) => ({ status: 'ok', value: id === 'f0-integrity-audit' ? f0 : await fn() }),
    runF0Audit: async () => f0, runLeadLeak: async () => ({}), runLinkLeak: async () => ({}), runP2Unresolvable: async () => ({}),
  };
  return digest.runOpsMorningDigest({ post: true, deps }).then(() => sent[0]);
}

test('Auto-fixed counts every fallback fix in one section', async () => {
  const t = await run({
    system_events: [
      { event_type: 'appointment.parity_auto_fixed', event_subtype: 'ghl_created', created_at: iso(NOW - HOUR) },
      { event_type: 'appointment.parity_auto_fixed', event_subtype: 'same_slot_restored', created_at: iso(NOW - HOUR) },
      { event_type: 'appointment.parity_auto_fixed', event_subtype: 'drift_reschedule', created_at: iso(NOW - HOUR) },
    ],
    agent_actions: [{ action_type: 'disqualified_cleanup', status: 'completed', target_id: 'avila', executed_at: iso(NOW - HOUR) }],
  }, { f0: { items: [{ contact_id: 'collier', reason: 'f0_autoenrolled', name: 'B C', wrong: 'x', todo: 'auto-enrolled (no action)' }] } });
  assert.match(t, /Auto-fixed: 5 \(no action\)/);
  assert.match(t, /1 LP appointment created in GHL/);
  assert.match(t, /1 cancelled appointment restored/);
  assert.match(t, /1 GHL estimate corrected to LP's date\/time/);
  assert.match(t, /1 ND \/ No Demo lead cleaned up/);
  assert.match(t, /1 demoed lead enrolled in F\.0/);
  assert.doesNotMatch(t, /F\.0 \/ S5\.2 integrity/, 'an auto-enrolled lead is not listed as a problem');
});

test('LP date/time looks wrong: one line per lead, never "add it to GHL"', async () => {
  const t = await run({ lp_sync_failure_notices: [{ notice_key: 'lp-looks-wrong:583740:2026-11-03', contact_id: 'stuckey', appt_date: '2026-11-03', appt_time: '02:00', created_at: iso(NOW - HOUR) }],
    lp_leads: [{ lp_lead_id: '583740', lp_prospect_id: '462947' }] });
  assert.match(t, /LP date\/time looks wrong: 1/);
  assert.match(t, /LP Prospect 462947 · 2026-11-03 02:00 · confirmation team fixes it in LP/);
  assert.doesNotMatch(t, /583740/, 'never the lead id (2026-10-16)');
  assert.doesNotMatch(t, /add it to the GHL calendar/);
});

test('duplicate LP leads: named once a day', async () => {
  const tables = { lp_leads: [
    { ghl_contact_id: 'badley', lp_lead_id: '583460', lp_prospect_id: '470001', disposition_code: 'CXL', appointment_set: true, appointment_date: '2026-10-17T10:00:00+00:00', lp_branch_id: 'SAR', lp_deleted_at: null },
    { ghl_contact_id: 'badley', lp_lead_id: '583453', lp_prospect_id: '470001', disposition_code: 'Cnf', appointment_set: true, appointment_date: '2026-10-17T10:00:00+00:00', lp_branch_id: 'FTMYR', lp_deleted_at: null },
  ] };
  const t = await run(tables);
  assert.match(t, /Duplicate LP leads to clean up: 1/);
  assert.match(t, /LP Prospect 470001 · SAR\/CXL\/2026-10-17 10:00 vs FTMYR\/Cnf\/2026-10-17 10:00 · clean up in LP/);
  assert.doesNotMatch(t, /58346|58345/);
});

test('disqualified Five9 removals waiting on approval are counted — only while auto-remove is off', async () => {
  const pending = { agent_actions: [{ action_type: 'five9_delete_record_from_list', rule_applied: 'LP_DISP_DISQUALIFIED', status: 'pending_approval' }] };
  // Automatic by default since 2026-10-19; false is the rollback to approval cards.
  assert.match(await run(pending, { env: { DISQUALIFIED_FIVE9_AUTO_REMOVE: 'false' } }), /waiting on approval: 1/);
  assert.doesNotMatch(await run(pending, { env: {} }), /waiting on approval/);
  assert.doesNotMatch(await run(pending, { env: { DISQUALIFIED_FIVE9_AUTO_REMOVE: 'true' } }), /waiting on approval/);
});

test('a FAILED ND / No Demo Five9 removal is named, whatever the mode, once (2026-10-20)', async () => {
  const failed = { agent_actions: [{ id: 613328, action_type: 'five9_delete_record_from_list', rule_applied: 'LP_DISP_DISQUALIFIED', status: 'failed',
    target_id: 'gordon', error_message: 'Five9 deleteRecordFromList fault: List "Data - Hot" doesn\'t exist.', created_at: iso(NOW - HOUR) }] };
  const t = await run(failed);
  assert.match(t, /Five9 removals for ND \/ No Demo leads/);
  assert.match(t, /Five9 removal FAILED for 1 ND \/ No Demo lead, still on a dialing list/);
  assert.match(t, /List "Data - Hot" doesn't exist/);
  // Older than a week: not named.
  const old = { agent_actions: [{ ...failed.agent_actions[0], created_at: iso(NOW - 8 * 24 * HOUR) }] };
  assert.doesNotMatch(await run(old), /Five9 removal FAILED/);
});

test('a clean day is still "All clear."', async () => {
  assert.match(await run(), /All clear\./);
});

test('autoFixedLines is pure and empty for nothing fixed', () => {
  assert.deepEqual(digest.autoFixedLines({}), []);
  assert.deepEqual(digest.autoFixedLines({ p2: 13 }), ['P2 backstop added 13 sales — auto-fixed']);
});
