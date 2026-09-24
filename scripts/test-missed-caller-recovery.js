/**
 * scripts/test-missed-caller-recovery.js
 *
 * Offline coverage for src/jobs/missed-caller-recovery.js. Every network and
 * database edge goes through deps: runSQL, supabase (an in-memory log that
 * honours the unique key), checkDnc, findOtherLists, emitEvent, queuePush.
 *
 * What these guard, in order of cost if broken:
 *   - shadow never pushes (the default must never dial anyone),
 *   - a second pass never pushes the same call twice,
 *   - DNC is honoured and fails CLOSED,
 *   - an "Appointment Set" caller is alerted, never dialled,
 *   - the disposition filter and the 72-hour boundary,
 *   - no path to LP's lead writers exists at all.
 *
 * Run: node --test scripts/test-missed-caller-recovery.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  runMissedCallerRecovery,
  classifyDisposition,
  isWithinLookback,
  recoveryMode,
  recoveryCampaigns,
  buildCandidatesSql,
  buildMissedCallerRecord,
  ELIGIBLE_DISPOSITIONS,
  DEFAULT_CAMPAIGNS,
  LOG_TABLE,
} from '../src/jobs/missed-caller-recovery.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

const row = (over = {}) => ({
  caller: '9415550101',
  campaign: 'Google PPC Windows',
  last_call_at: hoursAgo(2),
  last_disposition: 'Hung Up',
  calls: 1,
  recently_queued: false,
  ...over,
});

/** A minimal supabase stand-in: the log table with its unique key, and agent_actions. */
function fakeDb() {
  const log = [];
  const actions = [];
  let nextId = 1;
  const keyOf = (r) => `${r.caller_phone}|${r.campaign}|${r.last_call_at}`;
  const db = {
    log,
    actions,
    from(table) {
      if (table === LOG_TABLE) {
        return {
          upsert(rec, opts) {
            assert.equal(opts.onConflict, 'caller_phone,campaign,last_call_at');
            assert.equal(opts.ignoreDuplicates, true);
            const dup = log.some((r) => keyOf(r) === keyOf(rec));
            let inserted = null;
            if (!dup) { inserted = { id: nextId++, ...rec }; log.push(inserted); }
            return { select: async () => ({ data: inserted ? [{ id: inserted.id }] : [], error: null }) };
          },
          update(patch) {
            return { eq: async (_c, id) => { Object.assign(log.find((r) => r.id === id) || {}, patch); return { error: null }; } };
          },
          delete() {
            return { eq: async (_c, id) => { const i = log.findIndex((r) => r.id === id); if (i >= 0) log.splice(i, 1); return { error: null }; } };
          },
        };
      }
      if (table === 'agent_actions') {
        return {
          insert(rec) {
            const r = { id: 1000 + actions.length, ...rec };
            actions.push(r);
            return { select: () => ({ single: async () => ({ data: { id: r.id }, error: null }) }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return db;
}

/**
 * Harness. `rows` is what the view returns; the stub also drops rows already
 * logged, as the real NOT EXISTS does, so a second pass behaves like prod.
 */
function harness({ rows = [row()], dnc = [], dncThrows = false, otherLists = null } = {}) {
  const db = fakeDb();
  const calls = { dnc: [], pushes: [], events: [], otherLists: 0, sql: [] };
  const deps = {
    supabase: db,
    runSQL: async (sql) => {
      calls.sql.push(sql);
      const logged = new Set(db.log.map((r) => `${r.caller_phone}|${r.campaign}|${r.last_call_at}`));
      return rows.filter((r) => !logged.has(`${r.caller}|${r.campaign}|${r.last_call_at}`));
    },
    checkDnc: async (numbers) => {
      calls.dnc.push(numbers);
      if (dncThrows) throw new Error('Five9 SOAP 503');
      return { checked: numbers.length, on_dnc: numbers.filter((n) => dnc.includes(n)), not_on_dnc: [] };
    },
    findOtherLists: async () => {
      calls.otherLists += 1;
      return otherLists || { suppress: false, lists: [], failed_open: false, error: null };
    },
    emitEvent: async (e) => { calls.events.push(e); return { id: 1 }; },
    queuePush: async (r) => { calls.pushes.push(r); return { actionId: 555, listName: 'Callback Request', callNowMode: 'ANY' }; },
  };
  const run = (mode = 'shadow', extraEnv = {}) => runMissedCallerRecovery({
    env: { MISSED_CALLER_RECOVERY_MODE: mode, ...extraEnv },
    nowMs: NOW,
    deps,
  });
  return { db, calls, run };
}

// ─── disposition filter ────────────────────────────────────────────────────

test('each eligible disposition is eligible', () => {
  for (const d of ['Hung Up', 'Caller Disconnected', 'Sent To Voicemail', 'NA', 'Abandon', 'No Disposition']) {
    assert.equal(classifyDisposition(d), 'eligible', d);
  }
  assert.equal(ELIGIBLE_DISPOSITIONS.length, 6);
});

test('a conversation is not a missed call: Not Interested, Service Call, Cant Do Project are skipped', async () => {
  for (const d of ['Not Interested', 'Service Call', 'Cant Do Project', '', null]) {
    assert.equal(classifyDisposition(d), 'ineligible', String(d));
  }
  const rows = ['Not Interested', 'Service Call', 'Cant Do Project'].map((d, i) =>
    row({ caller: `941555020${i}`, last_disposition: d }));
  const h = harness({ rows });
  const res = await h.run('live');
  assert.equal(res.skipped_ineligible, 3);
  assert.equal(h.calls.pushes.length, 0);
  assert.deepEqual(h.db.log.map((r) => r.action), ['skipped_ineligible', 'skipped_ineligible', 'skipped_ineligible']);
});

test('Appointment Set with no LP record is alerted and never dialled', async () => {
  const h = harness({ rows: [row({ last_disposition: 'Appointment Set' })] });
  const res = await h.run('live');
  assert.equal(res.alert_appt_no_lp, 1);
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.calls.dnc.length, 0, 'not even a DNC check — it is not a dial candidate');
  assert.equal(h.calls.events.length, 1);
  assert.equal(h.calls.events[0].event_type, 'identity.appt_without_lp_record');
  assert.equal(h.db.log[0].action, 'alert_appt_no_lp');
});

// ─── the 72-hour boundary (UTC on both sides) ──────────────────────────────

test('72-hour boundary: inside, exactly on, and just outside the cutoff', () => {
  // NOW = 2026-09-24T15:00:00Z, so the cutoff is 2026-09-21T15:00:00Z.
  assert.equal(isWithinLookback('2026-09-21T15:00:01Z', NOW), true, 'one second inside');
  assert.equal(isWithinLookback('2026-09-21T15:00:00Z', NOW), true, 'exactly on the cutoff is inside');
  assert.equal(isWithinLookback('2026-09-21T14:59:59Z', NOW), false, 'one second outside');
  // Same instants written with an offset, as Postgres returns them.
  assert.equal(isWithinLookback('2026-09-21T11:00:01-04:00', NOW), true);
  assert.equal(isWithinLookback('2026-09-21T10:59:59-04:00', NOW), false);
  assert.equal(isWithinLookback('not a date', NOW), false);
});

test('a row just outside 72h is dropped even if the query let it through', async () => {
  const h = harness({ rows: [
    row({ caller: '9415550301', last_call_at: '2026-09-21T15:00:01Z' }),
    row({ caller: '9415550302', last_call_at: '2026-09-21T14:59:59Z' }),
  ] });
  const res = await h.run('shadow');
  assert.equal(res.candidates, 1);
  assert.deepEqual(h.db.log.map((r) => r.caller_phone), ['9415550301']);
});

test('the candidate query carries the window, the allow-list and the dedupe', () => {
  const sql = buildCandidatesSql(DEFAULT_CAMPAIGNS);
  assert.match(sql, /last_call_at >= now\(\) - interval '72 hours'/);
  assert.match(sql, /'Google PPC Windows'/);
  assert.doesNotMatch(sql, /'Main Number'/);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /r\.last_call_at = v\.last_call_at/);
});

// ─── dedupe ────────────────────────────────────────────────────────────────

test('running twice does not push twice', async () => {
  const h = harness();
  const first = await h.run('live');
  const second = await h.run('live');
  assert.equal(first.pushed, 1);
  assert.equal(second.pushed, 0);
  assert.equal(h.calls.pushes.length, 1);
  assert.equal(h.db.log.length, 1);
});

test('the unique key holds even when the read races a concurrent pass', async () => {
  // Simulate two containers: the read does NOT filter logged rows.
  const h = harness();
  h.calls.sql.length = 0;
  const rows = [row()];
  const racingDeps = { runSQL: async () => rows };
  const run = () => runMissedCallerRecovery({
    env: { MISSED_CALLER_RECOVERY_MODE: 'live' },
    nowMs: NOW,
    deps: { ...harnessDeps(h), ...racingDeps },
  });
  await run();
  const second = await run();
  assert.equal(h.calls.pushes.length, 1);
  assert.equal(second.already_logged, 1);
});

function harnessDeps(h) {
  return {
    supabase: h.db,
    checkDnc: async (n) => ({ on_dnc: [], not_on_dnc: n }),
    findOtherLists: async () => ({ suppress: false, lists: [] }),
    emitEvent: async () => null,
    queuePush: async (r) => { h.calls.pushes.push(r); return { actionId: 1, listName: 'Callback Request', callNowMode: 'ANY' }; },
  };
}

test('one caller under two campaigns is queued once', async () => {
  const h = harness({ rows: [row(), row({ campaign: 'St Pete Sticky' })] });
  const res = await h.run('live');
  assert.equal(res.pushed, 1);
  assert.equal(h.calls.pushes.length, 1);
  assert.match(h.db.log[1].detail, /already queued/);
});

test('a caller already queued in the last 72h is not queued again', async () => {
  const h = harness({ rows: [row({ recently_queued: true })] });
  const res = await h.run('live');
  assert.equal(res.pushed, 0);
  assert.equal(res.skipped_ineligible, 1);
});

test('a failed push releases its claim so the next pass retries', async () => {
  const h = harness();
  let fail = true;
  const deps = { ...harnessDeps(h), runSQL: async () => (h.db.log.length ? [] : [row()]),
    queuePush: async (r) => { if (fail) throw new Error('insert refused'); h.calls.pushes.push(r); return { actionId: 2, listName: 'Callback Request', callNowMode: 'ANY' }; } };
  const run = () => runMissedCallerRecovery({ env: { MISSED_CALLER_RECOVERY_MODE: 'live' }, nowMs: NOW, deps });
  const first = await run();
  assert.equal(first.ok, false);
  assert.equal(first.pushed, 0);
  assert.equal(h.db.log.length, 0, 'claim released');
  fail = false;
  const second = await run();
  assert.equal(second.pushed, 1);
  assert.equal(h.calls.pushes.length, 1);
});

// ─── modes ─────────────────────────────────────────────────────────────────

test('off mode does nothing at all', async () => {
  const h = harness();
  const res = await h.run('off');
  assert.equal(res.skipped, true);
  assert.equal(h.calls.sql.length, 0);
  assert.equal(h.calls.dnc.length, 0);
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.db.log.length, 0);
});

test('shadow mode never calls the push, and logs would_push', async () => {
  const h = harness({ rows: [row(), row({ caller: '9415550102', last_disposition: 'Sent To Voicemail' })] });
  const res = await h.run('shadow');
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.db.actions.length, 0, 'no agent_actions row either');
  assert.equal(res.would_push, 2);
  assert.equal(res.pushed, 0);
  assert.deepEqual(h.db.log.map((r) => [r.mode, r.action]), [['shadow', 'would_push'], ['shadow', 'would_push']]);
});

test('mode parsing: default shadow, unknown values never mean live', () => {
  assert.equal(recoveryMode({}), 'shadow');
  assert.equal(recoveryMode({ MISSED_CALLER_RECOVERY_MODE: '' }), 'shadow');
  assert.equal(recoveryMode({ MISSED_CALLER_RECOVERY_MODE: 'LIVE' }), 'live');
  assert.equal(recoveryMode({ MISSED_CALLER_RECOVERY_MODE: ' off ' }), 'off');
  assert.equal(recoveryMode({ MISSED_CALLER_RECOVERY_MODE: 'liev' }), 'shadow');
  assert.equal(recoveryMode({ MISSED_CALLER_RECOVERY_MODE: 'true' }), 'shadow');
});

test('campaign allow-list: default excludes Main Number; env overrides', () => {
  assert.equal(recoveryCampaigns({}).length, 9);
  assert.ok(!recoveryCampaigns({}).includes('Main Number'));
  assert.deepEqual(recoveryCampaigns({ MISSED_CALLER_RECOVERY_CAMPAIGNS: 'A, B ,,C' }), ['A', 'B', 'C']);
});

test('a campaign outside the allow-list is ignored', async () => {
  const h = harness({ rows: [row({ campaign: 'Main Number' })] });
  const res = await h.run('live');
  assert.equal(res.candidates, 0);
  assert.equal(h.db.log.length, 0);
});

// ─── DNC and cross-list ────────────────────────────────────────────────────

test('a DNC number is logged skipped_dnc and not pushed', async () => {
  const h = harness({ dnc: ['9415550101'] });
  const res = await h.run('live');
  assert.equal(res.skipped_dnc, 1);
  assert.equal(h.calls.pushes.length, 0);
});

test('an unreadable DNC list fails closed: no push, no log, retried next pass', async () => {
  const h = harness({ dncThrows: true });
  const res = await h.run('live');
  assert.equal(res.ok, false);
  assert.equal(res.dnc_unknown, 1);
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.db.log.length, 0);
});

test('someone already live in another Five9 list is not pushed again', async () => {
  const h = harness({ otherLists: { suppress: true, lists: ['LP_ASAP'], failed_open: false, error: null } });
  const res = await h.run('live');
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(res.skipped_ineligible, 1);
  assert.match(h.db.log[0].detail, /LP_ASAP/);
});

// ─── the record and the standing rule ──────────────────────────────────────

test('the Five9 record is number1 only, ten digits', () => {
  assert.deepEqual(buildMissedCallerRecord('+1 (941) 555-0101').values, ['9415550101']);
  assert.deepEqual(buildMissedCallerRecord('9415550101').fieldNames, ['number1']);
  assert.throws(() => buildMissedCallerRecord('555'));
});

test('the job has no path to LP lead creation and never names LP_ASAP as a target', () => {
  const src = readFileSync(new URL('../src/jobs/missed-caller-recovery.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /lp-client|addLead|leadAdd|LeadAdd|addlead|force_lp_lead_creation/i);
  assert.doesNotMatch(code, /list-dispatch/);
  assert.doesNotMatch(code, /LP_ASAP/);
  assert.doesNotMatch(code, /sendGroupMeMessage|send_message|sendSms/i, 'no customer-facing text');
});
