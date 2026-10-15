/**
 * test-incidents.js — the incident state machine (src/health/incidents.js).
 *
 * Every legal move in the handoff's table (System Health 1.2, 2026-10-15) is
 * exercised, and a sample of illegal ones must throw. Also: one open incident
 * per fingerprint (touch, never a second row, including after a lost race),
 * reopen counting and flapping, close-with-no-action suppression for 7 days,
 * and the known-issue link on open.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import {
  openOrTouchIncident, transition, checkTransition, TRANSITIONS, NON_TERMINAL, IllegalTransition, isSuppressed,
} from '../src/health/incidents.js';

const NOW = Date.parse('2026-10-15T15:00:00Z');
const PERSON = 'mark@reecewindows.com';

function db(extra = {}) {
  return fakeSupabase({
    incidents: [], incident_events: [],
    health_checks: [{ check_id: 'lead.uncalled_live', config: { warn_wait_min: 30 } }],
    claude_known_issues: [{ id: 41, rec_group_key: 'lead.uncalled_live', status: 'open' }],
    ...extra,
  });
}

async function open(client, over = {}) {
  const { incident } = await openOrTouchIncident({
    check_id: 'lead.uncalled_live', fingerprint: 'lead.uncalled_live', severity: 'P1', system: 'five9',
    title: 'Leads waiting with no Five9 call', summary: '3 leads waiting', nowMs: NOW, ...over,
  }, { client });
  return incident;
}

const kinds = (client, id) => client.tables.incident_events.filter((e) => e.incident_id === id).map((e) => e.kind);

test('open writes one incident and an opened event, linked to the open known issue', async () => {
  const client = db();
  const inc = await open(client);
  assert.equal(inc.status, 'open');
  assert.equal(inc.known_issue_id, 41);
  assert.deepEqual(kinds(client, inc.id), ['opened']);
});

test('a second open of the same fingerprint touches the first, never a second row', async () => {
  const client = db();
  const a = await open(client);
  const { incident: b, created } = await openOrTouchIncident({
    check_id: 'lead.uncalled_live', fingerprint: 'lead.uncalled_live', severity: 'P1', system: 'five9',
    title: 'x', summary: '5 leads waiting', detail: { leads: [1, 2] }, nowMs: NOW + 60_000,
  }, { client });
  assert.equal(created, false);
  assert.equal(b.id, a.id);
  assert.equal(client.tables.incidents.length, 1);
  assert.equal(b.summary, '5 leads waiting');
  assert.deepEqual(b.data.detail, { leads: [1, 2] });
});

test('a lost race (23505 on insert) is read as a touch', async () => {
  const real = db();
  let first = true;
  const racing = {
    from(table) {
      const chain = real.from(table);
      if (table !== 'incidents') return chain;
      const insert = chain.insert;
      chain.insert = (row) => {
        if (first) {
          first = false;
          // Another replica opened it a moment ago.
          real.tables.incidents.push({ ...row, id: 'winner', data: {} });
          return { select: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value' } }) };
        }
        return insert(row);
      };
      return chain;
    },
  };
  const out = await openOrTouchIncident({ check_id: 'lead.uncalled_live', fingerprint: 'fp.race', severity: 'P2', system: 'five9', title: 't', nowMs: NOW }, { client: racing });
  assert.equal(out.created, false);
  assert.equal(out.incident.id, 'winner');
  assert.equal(real.tables.incidents.length, 1);
});

test('every legal move in the table applies and writes its event', async () => {
  const paths = [
    [['acknowledged', PERSON], ['investigating', 'system'], ['fix_proposed', 'aios'], ['approved', PERSON], ['fixing', 'system'], ['verifying', 'system'], ['resolved', 'system']],
    [['investigating', 'aios'], ['fix_proposed', 'aios'], ['investigating', PERSON, { reason: 'wrong fix' }]],
    [['verifying', 'system'], ['investigating', 'system']],
    [['acknowledged', PERSON], ['verifying', 'system']],
    [['snoozed', PERSON, { reason: 'known', snooze_until: '2026-10-15T17:00:00Z' }], ['open', 'system']],
    [['closed_no_action', PERSON, { reason: 'expected maintenance' }]],
  ];
  for (const steps of paths) {
    const client = db();
    const inc = await open(client);
    for (const [to, actor, extra = {}] of steps) {
      const row = await transition(inc.id, to, { actor, nowMs: NOW, ...extra }, { client });
      assert.equal(row.status, to);
    }
    assert.equal(kinds(client, inc.id).length, steps.length + 1);
  }
});

test('the table covers snooze and close from every non-terminal state', () => {
  for (const s of NON_TERMINAL) {
    assert.ok(TRANSITIONS.some((t) => t.from === s && t.to === 'closed_no_action'), `${s} → closed`);
    if (s !== 'snoozed') assert.ok(TRANSITIONS.some((t) => t.from === s && t.to === 'snoozed'), `${s} → snoozed`);
  }
});

test('illegal moves throw: wrong path, wrong actor, missing reason, terminal', async () => {
  const client = db();
  const inc = await open(client);
  await assert.rejects(transition(inc.id, 'resolved', { actor: 'system' }, { client }), IllegalTransition);
  await assert.rejects(transition(inc.id, 'acknowledged', { actor: 'system' }, { client }), /not a move 'system' can make/);
  await assert.rejects(transition(inc.id, 'snoozed', { actor: PERSON, reason: 'x' }, { client }), /requires snooze_until/);
  await assert.rejects(transition(inc.id, 'closed_no_action', { actor: PERSON }, { client }), /requires reason/);
  await assert.rejects(transition(inc.id, 'investigating', { actor: PERSON }, { client }), IllegalTransition);
  await transition(inc.id, 'closed_no_action', { actor: PERSON, reason: 'noise' }, { client });
  await assert.rejects(transition(inc.id, 'open', { actor: 'system' }, { client }), /illegal move closed_no_action → open/);
  assert.equal(checkTransition('fixing', 'resolved', 'system').ok, false);
  assert.equal(checkTransition('approved', 'fixing', PERSON).ok, false);
});

test('reopen from verifying counts occurrences; three in 24h is flapping', async () => {
  const client = db();
  const inc = await open(client);
  for (let i = 0; i < 3; i += 1) {
    await transition(inc.id, 'verifying', { actor: 'system', nowMs: NOW + i * HOUR() }, { client });
    await transition(inc.id, 'investigating', { actor: 'system', nowMs: NOW + i * HOUR() + 1 }, { client });
  }
  const row = client.tables.incidents[0];
  assert.equal(row.occurrence_count, 4);
  assert.equal(row.data.flapping, true);
  assert.equal(kinds(client, inc.id).filter((k) => k === 'reopened').length, 3);
});
function HOUR() { return 3_600_000; }

test('close with no action suppresses the fingerprint for 7 days', async () => {
  const client = db();
  const inc = await open(client);
  await transition(inc.id, 'closed_no_action', { actor: PERSON, reason: 'expected', nowMs: NOW }, { client });
  const config = client.tables.health_checks[0].config;
  assert.equal(config.warn_wait_min, 30, 'thresholds kept');
  assert.equal(config.suppress[0].fingerprint, 'lead.uncalled_live');
  assert.equal(isSuppressed(config, 'lead.uncalled_live', NOW + 6 * 86_400_000), true);
  assert.equal(isSuppressed(config, 'lead.uncalled_live', NOW + 8 * 86_400_000), false);
  const again = await openOrTouchIncident({ check_id: 'lead.uncalled_live', fingerprint: 'lead.uncalled_live', severity: 'P1', system: 'five9', title: 't', nowMs: NOW + 3600_000, checkConfig: config }, { client });
  assert.equal(again.suppressed, true);
});

test('resolve stamps resolved and verified', async () => {
  const client = db();
  const inc = await open(client);
  await transition(inc.id, 'verifying', { actor: 'system', nowMs: NOW }, { client });
  const row = await transition(inc.id, 'resolved', { actor: 'system', verified_by: 'system', nowMs: NOW + 600_000 }, { client });
  assert.equal(row.resolved_by, 'system');
  assert.equal(row.verified_by, 'system');
  assert.ok(row.resolved_at);
});
