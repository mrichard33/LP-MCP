/**
 * test-legacy-incidents.js — legacy alert_conditions → incidents
 * (src/health/alert-key-map.js, System Health 1.4).
 *
 * Replays the shape of the rows firing on 2026-10-15 (161 rows: 143 drift,
 * 13 appt_parity gaps, 1 CI archive, 4 single keys) and expects exactly TWO
 * incidents: one for the drift SET, one for the CI archive. Unmapped keys
 * stay untouched. Also: suppression only with both switches, a cleared set
 * verifies then resolves after 10 minutes, the legacy card still posts when
 * suppression is off (no change to what watchdogs post).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { mapAlertKey, legacyPostSuppressed, syncLegacyIncidents, LEGACY_CLEAR_MS } from '../src/health/alert-key-map.js';

const NOW = Date.parse('2026-10-15T15:00:00Z');
const REGISTRY = new Map([
  ['sync.appt_parity', { check_id: 'sync.appt_parity', system: 'ghl', label: 'LP / GHL appointment parity', severity: 'P2', mode: 'shadow', business_impact: 'Reps and bot act on the wrong time' }],
  ['ci.recording_archive', { check_id: 'ci.recording_archive', system: 'supabase', label: 'Call recording archive reachable', severity: 'P3', mode: 'shadow' }],
  ['dialer.campaign_running', { check_id: 'dialer.campaign_running', system: 'five9', label: 'Expected campaigns are RUNNING', severity: 'P1', mode: 'shadow' }],
]);

function firingRows() {
  const at = new Date(NOW - 3 * 86_400_000).toISOString();
  const row = (alert_key) => ({ alert_key, state: 'firing', incident_id: null, first_seen_at: at });
  return [
    ...Array.from({ length: 143 }, (_, i) => row(`drift:ghl_closed_lp_active:contact${i}`)),
    ...Array.from({ length: 13 }, (_, i) => row(`appt_parity:gap:ghl_only:contact${i}`)),
    row('ci:recording_archive_unreachable'),
    row('lead_intake_gap'), row('lp_ghl_link_leak'), row('appt_prospect_dupes'), row('lead_uncalled_fresh'),
  ];
}

test('mapAlertKey: the three prefixes, nothing else', () => {
  assert.equal(mapAlertKey('drift:ghl_closed_lp_active:abc').check_id, 'sync.appt_parity');
  assert.equal(mapAlertKey('drift:ghl_closed_lp_active:abc').fingerprint, 'sync.appt_parity:drift_ghl_closed_lp_active');
  assert.equal(mapAlertKey('ci:recording_archive_unreachable').check_id, 'ci.recording_archive');
  assert.equal(mapAlertKey('capacity_ranker:campaign_not_running:DIAL ASAP').fingerprint, 'dialer.campaign_running:DIAL ASAP');
  assert.equal(mapAlertKey('appt_parity:gap:x'), null);
  assert.equal(mapAlertKey('lead_uncalled_fresh'), null);
});

test('suppression needs both switches and a mapped key', () => {
  const on = { LEGACY_ALERT_SUPPRESS_MAPPED: 'true', INCIDENT_NOTIFIER_MODE: 'live' };
  assert.equal(legacyPostSuppressed('ci:recording_archive_unreachable', on), true);
  assert.equal(legacyPostSuppressed('ci:recording_archive_unreachable', { ...on, INCIDENT_NOTIFIER_MODE: 'shadow' }), false);
  assert.equal(legacyPostSuppressed('ci:recording_archive_unreachable', { INCIDENT_NOTIFIER_MODE: 'live' }), false);
  assert.equal(legacyPostSuppressed('lead_uncalled_fresh', on), false);
});

test('replay of the 161 rows firing on 2026-10-15 → exactly 2 incidents', async () => {
  const client = fakeSupabase({ alert_conditions: firingRows(), incidents: [], incident_events: [], claude_known_issues: [] });
  const out = await syncLegacyIncidents({ client, registry: REGISTRY, nowMs: NOW });
  assert.equal(client.tables.incidents.length, 2);
  const drift = client.tables.incidents.find((i) => i.check_id === 'sync.appt_parity');
  const ci = client.tables.incidents.find((i) => i.check_id === 'ci.recording_archive');
  assert.equal(drift.data.detail.members_total, 143);
  assert.equal(drift.data.source, 'legacy');
  assert.equal(drift.severity, 'P2');
  assert.equal(ci.severity, 'P3');
  assert.equal(out.linked, 144);
  const linked = client.tables.alert_conditions.filter((r) => r.incident_id !== null);
  assert.equal(linked.length, 144, 'drift + CI rows carry incident_id; the 17 unmapped rows do not');
  // A second pass changes nothing.
  await syncLegacyIncidents({ client, registry: REGISTRY, nowMs: NOW + 60_000 });
  assert.equal(client.tables.incidents.length, 2);
});

test('a set that clears verifies, then resolves after 10 minutes clear', async () => {
  const client = fakeSupabase({ alert_conditions: firingRows().slice(0, 3), incidents: [], incident_events: [], claude_known_issues: [] });
  await syncLegacyIncidents({ client, registry: REGISTRY, nowMs: NOW });
  for (const r of client.tables.alert_conditions) r.state = 'cleared';
  await syncLegacyIncidents({ client, registry: REGISTRY, nowMs: NOW + 60_000 });
  assert.equal(client.tables.incidents[0].status, 'verifying');
  await syncLegacyIncidents({ client, registry: REGISTRY, nowMs: NOW + 120_000 });
  assert.equal(client.tables.incidents[0].status, 'verifying', 'not yet: clear for 1 min only');
  await syncLegacyIncidents({ client, registry: REGISTRY, nowMs: NOW + 60_000 + LEGACY_CLEAR_MS });
  assert.equal(client.tables.incidents[0].status, 'resolved');
});

test('reportAlertCondition still posts a mapped legacy card when suppression is off', async () => {
  const { reportAlertCondition } = await import('../src/alert-state.js');
  const sends = [];
  const client = fakeSupabase({ alert_conditions: [], incidents: [], incident_events: [], health_checks: [], claude_known_issues: [] });
  const res = await reportAlertCondition({
    key: 'ci:recording_archive_unreachable', active: true, label: 'archive', text: 'archive down',
    send: async (t) => { sends.push(t); return { sent: true }; }, client, nowMs: NOW,
  });
  assert.equal(res.sent, true);
  assert.deepEqual(sends, ['archive down']);
});
