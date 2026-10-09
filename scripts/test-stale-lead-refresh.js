// Stale open-lead refresh (2026-10-07) — selection, batching, shadow writes
// nothing, live writes only through the row builder, and close_date never
// rides in the upsert row.
//
// Incident: LP lead 542473 read `Set` in lp_leads; LP had it `CXL` since
// 2026-05-26. See src/stale-lead-refresh.js for the root cause.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_REFRESH_DISPOSITIONS, refreshMode, refreshConfig, parseHourWindow, inHourWindow,
  isStaleOpenLead, selectStaleBatch, groupByProspect, sanitizeRow, runStaleLeadRefresh,
} from '../src/stale-lead-refresh.js';
import { buildRefreshRow } from '../src/jobs/stale-lead-refresh.js';
import { _internal as syncLeadsInternal } from '../src/sync-leads.js';
import { ACTIVE_LP_DISPOSITIONS } from '../src/services/drift-detector.js';
import { JOBS } from '../src/job-registry.js';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const cfg = (over = {}) => ({ ...refreshConfig({}), ...over });

function row(id, over = {}) {
  return {
    lp_lead_id: String(id),
    lp_prospect_id: `P${id}`,
    disposition_code: 'Set',
    appointment_date: iso(NOW - 30 * D),
    synced_at: iso(NOW - 32 * D), // read before the appointment
    appointment_set: true,
    demo_completed: false,
    closed_won: false,
    ghl_contact_id: 'abcdefghij0123456789',
    ghl_intent_bucket: 'internet',
    ghl_entry_tag: 'entry:internet',
    ...over,
  };
}

// ─── Config / mode ──────────────────────────────────────────────────

test('mode defaults to shadow; unknown falls back to shadow', () => {
  assert.equal(refreshMode({}), 'shadow');
  assert.equal(refreshMode({ LP_STALE_LEAD_REFRESH_MODE: 'LIVE' }), 'live');
  assert.equal(refreshMode({ LP_STALE_LEAD_REFRESH_MODE: 'off' }), 'off');
  assert.equal(refreshMode({ LP_STALE_LEAD_REFRESH_MODE: 'enforce' }), 'shadow');
});

test('config defaults and env overrides', () => {
  const c = refreshConfig({});
  assert.equal(c.batchSize, 100);
  assert.equal(c.graceHours, 24);
  assert.equal(c.recheckDays, 14);
  assert.deepEqual(c.hours, { start: 21, end: 6 });
  const o = refreshConfig({ LP_STALE_LEAD_REFRESH_BATCH: '25', LP_STALE_LEAD_REFRESH_HOURS_ET: '22-5' });
  assert.equal(o.batchSize, 25);
  assert.deepEqual(o.hours, { start: 22, end: 5 });
  assert.equal(refreshConfig({ LP_STALE_LEAD_REFRESH_BATCH: '0' }).batchSize, 100, 'a zero batch is not a config');
  assert.deepEqual(refreshConfig({ LP_STALE_LEAD_REFRESH_HOURS_ET: 'nights' }).hours, { start: 21, end: 6 });
});

test('the off-hours window wraps midnight', () => {
  const w = parseHourWindow('21-6');
  for (const h of [21, 23, 0, 3, 5]) assert.ok(inHourWindow(h, w), `${h} is inside`);
  for (const h of [6, 9, 12, 20]) assert.ok(!inHourWindow(h, w), `${h} is outside`);
  assert.ok(inHourWindow(10, parseHourWindow('9-17')));
  assert.equal(parseHourWindow('5-5'), null);
});

test('the job is registered, enabled by default, and off only on an explicit off', () => {
  const j = JOBS.find((x) => x.id === 'lp-stale-lead-refresh');
  assert.ok(j, 'registered in src/job-registry.js');
  assert.equal(j.isEnabled({}), true);
  assert.equal(j.isEnabled({ LP_STALE_LEAD_REFRESH_MODE: 'live' }), true);
  assert.equal(j.isEnabled({ LP_STALE_LEAD_REFRESH_MODE: 'off' }), false);
});

// ─── Selection ──────────────────────────────────────────────────────

test('the open set covers every LP-active code the drift detector reads, except Data', () => {
  for (const c of ACTIVE_LP_DISPOSITIONS) {
    if (c === 'Data') continue;
    assert.ok(STALE_REFRESH_DISPOSITIONS.includes(c), `${c} must be refreshed or drift keeps alerting on it`);
  }
  for (const c of ['Set', 'Cnf', 'Verif', 'Issue']) assert.ok(STALE_REFRESH_DISPOSITIONS.includes(c));
  assert.ok(!STALE_REFRESH_DISPOSITIONS.includes('Data'), 'raw leads have no appointment to have passed');
  for (const c of ['CXL', 'Sale', 'NIS', 'DNC']) assert.ok(!STALE_REFRESH_DISPOSITIONS.includes(c), `${c} is a result, not open`);
});

test('isStaleOpenLead: synced before the result could land → stale (the 542473 shape)', () => {
  const r = row(542473, {
    appointment_date: '2026-05-27T10:00:00+00:00',
    synced_at: '2026-05-25T13:07:51.248+00:00',
  });
  assert.equal(isStaleOpenLead(r, NOW, cfg()), true);
});

test('isStaleOpenLead: appointment still inside the grace → not yet', () => {
  assert.equal(isStaleOpenLead(row(1, { appointment_date: iso(NOW - 2 * H), synced_at: iso(NOW - 3 * D) }), NOW, cfg()), false);
  assert.equal(isStaleOpenLead(row(1, { appointment_date: iso(NOW + 2 * D) }), NOW, cfg()), false);
});

test('isStaleOpenLead: read after the result window and recently → fresh; not read for RECHECK_DAYS → stale', () => {
  const appt = NOW - 40 * D;
  assert.equal(isStaleOpenLead(row(1, { appointment_date: iso(appt), synced_at: iso(NOW - 3 * D) }), NOW, cfg()), false);
  assert.equal(isStaleOpenLead(row(1, { appointment_date: iso(appt), synced_at: iso(NOW - 15 * D) }), NOW, cfg()), true);
  assert.equal(isStaleOpenLead(row(1, { appointment_date: iso(appt), synced_at: iso(NOW - 15 * D) }), NOW, cfg({ recheckDays: 30 })), false);
});

test('isStaleOpenLead: results, no appointment, or unknown codes are never selected', () => {
  assert.equal(isStaleOpenLead(row(1, { disposition_code: 'CXL' }), NOW, cfg()), false);
  assert.equal(isStaleOpenLead(row(1, { disposition_code: 'Sale' }), NOW, cfg()), false);
  assert.equal(isStaleOpenLead(row(1, { disposition_code: 'Data' }), NOW, cfg()), false);
  assert.equal(isStaleOpenLead(row(1, { appointment_date: null }), NOW, cfg()), false);
  assert.equal(isStaleOpenLead(row(1, { synced_at: null }), NOW, cfg()), true, 'never stamped → read it');
  assert.equal(isStaleOpenLead(row(1, { disposition_code: ' Cnf ' }), NOW, cfg()), true, 'LP pads codes');
});

// ─── Batching ───────────────────────────────────────────────────────

// A fake candidate source: rows ordered (appointment_date, lp_lead_id), strictly
// after the cursor, like the PostgREST keyset query.
function candidateSource(rows) {
  const sorted = [...rows].sort((a, b) => (a.appointment_date < b.appointment_date ? -1
    : a.appointment_date > b.appointment_date ? 1 : (a.lp_lead_id < b.lp_lead_id ? -1 : 1)));
  const calls = [];
  return {
    calls,
    async fetchCandidates({ cursor, limit }) {
      calls.push({ cursor, limit });
      const after = cursor
        ? sorted.filter((r) => r.appointment_date > cursor.appointment_date
          || (r.appointment_date === cursor.appointment_date && r.lp_lead_id > cursor.lp_lead_id))
        : sorted;
      return after.slice(0, limit);
    },
  };
}

test('selectStaleBatch: oldest appointment first, fresh rows skipped, batch bounded', async () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const appt = NOW - (100 - i) * D;
    // every third row was read after its result window → fresh, skipped
    rows.push(row(1000 + i, { appointment_date: iso(appt), synced_at: iso(i % 3 === 0 ? NOW - D : appt - D) }));
  }
  const src = candidateSource(rows);
  const out = await selectStaleBatch({ cfg: cfg({ batchSize: 4 }), nowMs: NOW, pageSize: 3 }, src);
  assert.deepEqual(out.rows.map((r) => r.lp_lead_id), ['1001', '1002', '1004', '1005']);
  assert.equal(out.exhausted, false);
  assert.deepEqual(out.nextCursor, { appointment_date: rows[5].appointment_date, lp_lead_id: '1005' });

  // The next pass resumes after the cursor, then wraps at the end.
  const out2 = await selectStaleBatch({ cursor: out.nextCursor, cfg: cfg({ batchSize: 4 }), nowMs: NOW, pageSize: 3 }, src);
  assert.deepEqual(out2.rows.map((r) => r.lp_lead_id), ['1007', '1008']);
  assert.equal(out2.exhausted, true);
  assert.equal(out2.nextCursor, null, 'wrap to the oldest so shadow covers the whole set and a stuck row cannot block the head');
});

test('selectStaleBatch: the scan limit bounds a run with no stale rows', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(2000 + i, {
    appointment_date: iso(NOW - (60 - i) * D), synced_at: iso(NOW - D),
  }));
  const src = candidateSource(rows);
  const out = await selectStaleBatch({ cfg: cfg({ batchSize: 5, scanLimit: 20 }), nowMs: NOW, pageSize: 7 }, src);
  assert.equal(out.rows.length, 0);
  assert.equal(out.scanned, 20);
  assert.equal(out.exhausted, false, 'stopped at the scan limit, not the end');
  assert.ok(out.nextCursor);
});

test('groupByProspect keeps order and puts every lead of one customer behind one LP call', () => {
  const g = groupByProspect([row(1, { lp_prospect_id: 'A' }), row(2, { lp_prospect_id: 'B' }), row(3, { lp_prospect_id: 'A' }), row(4, { lp_prospect_id: null })]);
  assert.deepEqual([...g.keys()], ['A', 'B', '']);
  assert.deepEqual(g.get('A').map((r) => r.lp_lead_id), ['1', '3']);
});

// ─── The pass ───────────────────────────────────────────────────────

function lpLead(id, over = {}) {
  return {
    id: String(id),
    disposition: 'CXL',
    apptdate: '2026-09-07T12:00:00',
    apptset: 'true', sat: 'false', sold: 'false',
    lastchangedon: '2026-09-08T09:00:00',
    ...over,
  };
}

function harness({ rows, prospects, mode = 'shadow', batchSize = 100, circuitOpenAfter = Infinity, failProspect = null }) {
  const src = candidateSource(rows);
  const writes = { upserts: [], touches: [], lpCalls: [], sleeps: 0 };
  let calls = 0;
  const deps = {
    now: () => NOW,
    sleep: async () => { writes.sleeps++; },
    fetchCandidates: src.fetchCandidates,
    circuitOpen: () => calls >= circuitOpenAfter,
    async fetchProspect(pid) {
      calls++;
      writes.lpCalls.push(pid);
      if (pid === failProspect) throw new Error('LP 500');
      return prospects[pid] ?? null;
    },
    // Minimal builder: the disposition LP holds, everything else as stored.
    buildRow: (prospect, lead, existing) => ({
      lp_lead_id: existing.lp_lead_id,
      lp_prospect_id: existing.lp_prospect_id,
      disposition_code: lead.disposition,
      appointment_date: existing.appointment_date,
      close_date: '2026-01-01', // a builder that ever leaked it must be stripped
      synced_at: iso(NOW),
    }),
    async upsertRow(r) { writes.upserts.push(r); },
    async touchSynced(id, at) { writes.touches.push({ id, at }); },
  };
  return { deps, writes, cfg: cfg({ mode, batchSize, spacingMs: 10 }) };
}

test('shadow: reads LP, counts what would change, writes NOTHING', async () => {
  const rows = [row(10), row(11, { lp_prospect_id: 'P10' }), row(12)];
  const prospects = {
    P10: { cst_id: 'P10', leads: [lpLead(10), lpLead(11, { disposition: 'Set' })] },
    P12: { cst_id: 'P12', leads: [lpLead(12, { disposition: 'Sale' })] },
  };
  const h = harness({ rows, prospects });
  const out = await runStaleLeadRefresh({ cfg: h.cfg }, h.deps);
  assert.equal(out.mode, 'shadow');
  assert.equal(out.selected, 3);
  assert.equal(out.lp_calls, 2, 'one call per prospect, not per lead');
  assert.equal(out.would_change, 2);
  assert.equal(out.unchanged, 1);
  assert.deepEqual(out.by_transition, { 'Set→CXL': 1, 'Set→Sale': 1 });
  assert.equal(out.changed_fields.disposition_code, 2);
  assert.equal(out.samples.length, 2);
  assert.equal(out.written, 0);
  assert.equal(out.touched, 0);
  assert.equal(h.writes.upserts.length, 0, 'shadow never upserts');
  assert.equal(h.writes.touches.length, 0, 'shadow never stamps synced_at');
  assert.equal(h.writes.sleeps, 1, 'calls are spaced');
});

test('live: writes the changed rows, stamps synced_at on the unchanged, never close_date', async () => {
  const rows = [row(20), row(21)];
  const prospects = {
    P20: { leads: [lpLead(20)] },
    P21: { leads: [lpLead(21, { disposition: 'Set' })] },
  };
  const h = harness({ rows, prospects, mode: 'live' });
  const out = await runStaleLeadRefresh({ cfg: h.cfg }, h.deps);
  assert.equal(out.written, 1);
  assert.equal(out.touched, 1);
  assert.equal(h.writes.upserts.length, 1);
  assert.equal(h.writes.upserts[0].lp_lead_id, '20');
  assert.equal(h.writes.upserts[0].disposition_code, 'CXL');
  assert.ok(!('close_date' in h.writes.upserts[0]), 'close_date must never be in the upsert row');
  assert.deepEqual(h.writes.touches.map((t) => t.id), ['21']);
});

test('off: the pass does nothing and says so', async () => {
  const h = harness({ rows: [row(30)], prospects: {}, mode: 'off' });
  const out = await runStaleLeadRefresh({ cfg: h.cfg }, h.deps);
  assert.equal(out.skipped, true);
  assert.equal(h.writes.lpCalls.length, 0);
});

test('a lead LP no longer lists under its customer is counted, never written', async () => {
  const h = harness({ rows: [row(40)], prospects: { P40: { leads: [lpLead(999)] } }, mode: 'live' });
  const out = await runStaleLeadRefresh({ cfg: h.cfg }, h.deps);
  assert.equal(out.not_found, 1);
  assert.equal(h.writes.upserts.length + h.writes.touches.length, 0);
});

test('an LP failure on one prospect is counted and the pass goes on', async () => {
  const h = harness({ rows: [row(50), row(51)], prospects: { P51: { leads: [lpLead(51)] } }, mode: 'live', failProspect: 'P50' });
  const out = await runStaleLeadRefresh({ cfg: h.cfg }, h.deps);
  assert.equal(out.errors, 1);
  assert.equal(out.written, 1);
});

test('the shared LP circuit breaker stops the pass', async () => {
  const rows = [row(60), row(61), row(62)];
  const prospects = { P60: { leads: [lpLead(60)] }, P61: { leads: [lpLead(61)] }, P62: { leads: [lpLead(62)] } };
  const h = harness({ rows, prospects, mode: 'live', circuitOpenAfter: 1 });
  const out = await runStaleLeadRefresh({ cfg: h.cfg }, h.deps);
  assert.equal(out.aborted, 'lp_circuit_open');
  assert.equal(h.writes.lpCalls.length, 1);
  assert.equal(out.written, 1);
});

test('the batch size bounds the LP calls per pass', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(700 + i, { appointment_date: iso(NOW - (90 - i) * D), synced_at: iso(NOW - 95 * D) }));
  const prospects = Object.fromEntries(rows.map((r) => [r.lp_prospect_id, { leads: [lpLead(r.lp_lead_id)] }]));
  const h = harness({ rows, prospects, batchSize: 7 });
  const out = await runStaleLeadRefresh({ cfg: h.cfg }, h.deps);
  assert.equal(out.selected, 7);
  assert.equal(h.writes.lpCalls.length, 7);
  assert.equal(h.writes.lpCalls[0], 'P700', 'oldest appointment first');
  assert.ok(out.cursor_out, 'resumes next pass');
});

// ─── close_date, with the REAL row builder ─────────────────────────

test('sanitizeRow strips close_date and close_date_source', () => {
  const r = sanitizeRow({ lp_lead_id: '1', close_date: '2026-05-01', close_date_source: 'sale_announcement', disposition_code: 'Sale' });
  assert.deepEqual(r, { lp_lead_id: '1', disposition_code: 'Sale' });
});

test('buildRefreshRow (real buildLeadRow): no close_date, link kept, bucket/tag pinned', () => {
  const existing = row(542473, { lp_prospect_id: '433650', ghl_contact_id: 'abcdefghij0123456789' });
  const prospect = { cst_id: '433650', firstname: 'Bruce', lastname: 'Frank', phone1: '5616328000', leads: [] };
  const lead = lpLead(542473, {
    apptdate: '2026-05-27T10:00:00', apptset: 'true', lastchangedon: '2026-05-26T12:13:31.467',
    lognumber: 'ZZZZZZZZZZZZZZZZZZZZ', // a lognumber must NOT be adopted as a link by a cache refresh
    source: 'Internet', sourcesubdescr: 'Lead Gurus', brn_id: 'BOCA',
  });
  const out = buildRefreshRow(prospect, lead, existing, syncLeadsInternal.buildLeadRow);
  assert.ok(!('close_date' in out), 'close_date must never be in the upsert row');
  assert.ok(!('close_date_source' in out));
  assert.equal(out.disposition_code, 'CXL');
  assert.equal(out.lp_lead_id, '542473');
  assert.equal(out.ghl_contact_id, 'abcdefghij0123456789', 'stored link kept');
  assert.ok(!('ghl_link_source' in out), 'link classification left alone');
  assert.equal(out.ghl_intent_bucket, 'internet');
  assert.equal(out.ghl_entry_tag, 'entry:internet');
  assert.ok(out.synced_at, 'a write is a read stamp');
});

test('buildRefreshRow: an unlinked lead stays unlinked (no lognumber adoption, no null overwrite)', () => {
  const existing = row(5, { ghl_contact_id: null });
  const out = buildRefreshRow({ cst_id: 'P5' }, lpLead(5, { lognumber: 'ZZZZZZZZZZZZZZZZZZZZ' }), existing, syncLeadsInternal.buildLeadRow);
  assert.ok(!('ghl_contact_id' in out), 'a null id is dropped so the stored value survives');
  assert.ok(!('ghl_link_source' in out));
});
