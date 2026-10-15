/**
 * test-five9-call-journey.js — the Five9 "Call Journey" report → five9_call_journey
 * (the user's handoff, 2026-10-15). Uses the verbatim sample row from the live
 * report. Covers the Pacific timestamp (PDT and PST), null and "[None]",
 * headers by name (a missing one is a hard failure), transfer legs on one CALL
 * ID, customer_phone for outbound vs inbound, window planning, the idempotent
 * re-run, shadow writing nothing, and the alert when rows come back but none
 * are stored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveJourneyColumns, parseReportTimestamp, normalizeJourneyRow, parseJourneyReport,
  planJourneyWindows, toReportCriteriaString, cellText,
} from '../src/five9/call-journey.js';
import {
  runFive9CallJourneySync, runFive9CallJourneyBackfill, journeyAlertState, journeyMode,
} from '../src/jobs/five9-call-journey-sync.js';

const COLUMNS = ['TIMESTAMP', 'DNIS', 'LPRecKey', 'lead_id', 'CAMPAIGN', 'LIST NAME', 'SKILL', 'CALL TYPE', 'DISPOSITION', 'AGENT NAME', 'Number of attempts', 'ANI', 'CALL ID'];
// Verbatim from the live report, 2026-10-15.
const SAMPLE = ['Thu, 15 Oct 2026 09:10:20', '2022861482', 'INQ427994', '580663', 'Data - Warm Leads less than 30', 'Data - Warm - FTL less than 30', 'General Outbound', 'Outbound', 'Hung Up', 'Shari Walker - LF', '5', '3525770163', '300000010540092'];
const cols = resolveJourneyColumns(COLUMNS);

test('the sample row normalizes field by field', () => {
  const { row } = normalizeJourneyRow(SAMPLE, cols, COLUMNS);
  assert.equal(row.call_ts, '2026-10-15T16:10:20.000Z', '9:10:20 AM PDT: the webhook has this call at 16:10:20 UTC');
  assert.equal(row.call_id, '300000010540092');
  assert.equal(row.call_type, 'Outbound');
  assert.equal(row.campaign, 'Data - Warm Leads less than 30');
  assert.equal(row.list_name, 'Data - Warm - FTL less than 30');
  assert.equal(row.skill, 'General Outbound');
  assert.equal(row.disposition, 'Hung Up');
  assert.equal(row.agent_name, 'Shari Walker - LF');
  assert.equal(row.agent_name_clean, 'Shari Walker');
  assert.equal(row.team, 'lightfire');
  assert.equal(row.dnis, '2022861482');
  assert.equal(row.ani, '3525770163');
  assert.equal(row.customer_phone, '2022861482', 'outbound: the number we dialed');
  assert.equal(row.lp_rec_key, 'INQ427994');
  assert.equal(row.lp_lead_id, '580663');
  assert.equal(row.attempts, 5);
  assert.equal(row.leg_key, '300000010540092|2026-10-15T16:10:20.000Z|Outbound|2022861482');
  assert.equal(row.raw['CALL ID'], '300000010540092');
  assert.equal(row.raw['Number of attempts'], '5');
});

test('Pacific timestamps: October (PDT, UTC-7) and January (PST, UTC-8); garbage is null', () => {
  assert.equal(parseReportTimestamp('Thu, 15 Oct 2026 09:10:20').toISOString(), '2026-10-15T16:10:20.000Z');
  assert.equal(parseReportTimestamp('Mon, 12 Jan 2026 09:10:20').toISOString(), '2026-01-12T17:10:20.000Z');
  assert.equal(parseReportTimestamp('12 Jan 2026 23:59:59').toISOString(), '2026-01-13T07:59:59.000Z', 'weekday optional');
  assert.equal(parseReportTimestamp('2026-10-15 09:10:20'), null);
  assert.equal(parseReportTimestamp('31 Sep 2026 09:00:00'), null, 'no such day');
  assert.equal(parseReportTimestamp(null), null);
});

test('null and "[None]" cells are null; attempts is an int or null', () => {
  assert.equal(cellText(null), null);
  assert.equal(cellText('[None]'), null);
  assert.equal(cellText('  '), null);
  const cells = [...SAMPLE];
  cells[6] = '[None]'; // SKILL
  cells[9] = null;     // AGENT NAME
  cells[10] = null;    // Number of attempts
  const { row } = normalizeJourneyRow(cells, cols, COLUMNS);
  assert.equal(row.skill, null);
  assert.equal(row.agent_name, null);
  assert.equal(row.agent_name_clean, null);
  assert.equal(row.team, null);
  assert.equal(row.attempts, null);
});

test('columns resolve by name in any order; a missing header is a hard failure', () => {
  const shuffled = [...COLUMNS].reverse();
  const c = resolveJourneyColumns(shuffled);
  const { row } = normalizeJourneyRow([...SAMPLE].reverse(), c, shuffled);
  assert.equal(row.call_id, '300000010540092');
  assert.throws(() => resolveJourneyColumns(COLUMNS.filter((h) => h !== 'LIST NAME')), /missing column\(s\): LIST NAME/);
  assert.throws(() => parseJourneyReport({ columns: COLUMNS.slice(1), rows: [SAMPLE.slice(1)] }), /TIMESTAMP/);
});

test('a row with no usable timestamp is a counted reject, never a silent skip', () => {
  const bad = [...SAMPLE]; bad[0] = '10/15/2026 9:10 AM';
  const none = [...SAMPLE]; none[0] = null;
  const out = parseJourneyReport({ columns: COLUMNS, rows: [SAMPLE, bad, none] });
  assert.equal(out.returned, 3);
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rejects, { bad_timestamp: 1, no_timestamp: 1 });
});

test('transfer legs on one CALL ID are separate rows; inbound uses the ANI', () => {
  const leg2 = [...SAMPLE]; leg2[7] = '3rd party transfer'; leg2[1] = '8005551212';
  const inbound = [...SAMPLE]; inbound[7] = 'Inbound'; inbound[1] = '7275133151'; inbound[11] = '(352) 577-0163'; inbound[12] = '300000010540099';
  const out = parseJourneyReport({ columns: COLUMNS, rows: [SAMPLE, leg2, inbound, SAMPLE] });
  assert.equal(out.rows.length, 3, 'two legs of one call, one inbound call, a repeated row once');
  assert.equal(new Set(out.rows.map((r) => r.call_id)).size, 2);
  const inb = out.rows.find((r) => r.call_type === 'Inbound');
  assert.equal(inb.customer_phone, '3525770163', 'inbound: the caller');
  const preview = [...SAMPLE]; preview[7] = 'Preview';
  assert.equal(normalizeJourneyRow(preview, cols, COLUMNS).row.customer_phone, '2022861482');
});

test('windows: 10-minute overlap, 2-minute lag, cold start 30 minutes, chunks of 6 hours at most', () => {
  const now = Date.parse('2026-10-15T17:30:00Z');
  const [w] = planJourneyWindows({ lastEndMs: Date.parse('2026-10-15T17:13:00Z'), nowMs: now });
  assert.equal(new Date(w.startMs).toISOString(), '2026-10-15T17:03:00.000Z');
  assert.equal(new Date(w.endMs).toISOString(), '2026-10-15T17:28:00.000Z');
  const cold = planJourneyWindows({ lastEndMs: null, nowMs: now });
  assert.equal(cold.length, 1);
  assert.equal(cold[0].endMs - cold[0].startMs, 30 * 60_000);
  const catchUp = planJourneyWindows({ lastEndMs: now - 14 * 3600_000, nowMs: now });
  assert.equal(catchUp.length, 3, '14h10m behind → 6h + 6h + the rest');
  assert.ok(catchUp.every((x) => x.endMs - x.startMs <= 6 * 3600_000));
  assert.equal(toReportCriteriaString(new Date('2026-10-15T16:00:00Z')), '2026-10-15T09:00:00', 'the window runReport reads, in Pacific');
  assert.equal(toReportCriteriaString(new Date('2026-01-12T08:00:00Z')), '2026-01-12T00:00:00');
});

/** A fake Supabase with a run log and the upsert function keyed on leg_key. */
function fakeDb({ lastEnd = null } = {}) {
  const runs = [];
  const legs = new Map();
  return {
    runs, legs,
    from(table) {
      assert.equal(table, 'five9_call_journey_runs');
      const q = {
        _f: {},
        select() { return q; },
        eq(k, v) { q._f[k] = v; return q; },
        order() { return q; },
        limit() {
          const ok = runs.filter((r) => r.status === 'ok' && r.mode === q._f.mode).sort((a, b) => b.window_end.localeCompare(a.window_end));
          const seed = lastEnd && q._f.mode ? [{ window_end: lastEnd }] : [];
          return Promise.resolve({ data: ok.length ? ok.slice(0, 1) : seed, error: null });
        },
        insert(row) {
          const r = { id: runs.length + 1, ...row };
          runs.push(r);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: r.id }, error: null }) }) };
        },
        update(patch) { return { eq: (_k, id) => { Object.assign(runs.find((r) => r.id === id), patch); return Promise.resolve({ error: null }); } }; },
      };
      return q;
    },
    rpc(fn, { p_rows }) {
      assert.equal(fn, 'five9_call_journey_upsert');
      let inserted = 0; let updated = 0;
      for (const r of p_rows) {
        const prev = legs.get(r.leg_key);
        if (!prev) { legs.set(r.leg_key, r); inserted += 1; } else if (JSON.stringify(prev.raw) !== JSON.stringify(r.raw)) { legs.set(r.leg_key, r); updated += 1; }
      }
      return Promise.resolve({ data: { inserted, updated, unchanged: p_rows.length - inserted - updated }, error: null });
    },
  };
}

const NOW = Date.parse('2026-10-15T17:30:00Z');
const leg2 = [...SAMPLE]; leg2[7] = '3rd party transfer'; leg2[1] = '8005551212';
const report = (rows) => async () => ({ done: true, columns: COLUMNS, rows });

test('live: stores each leg once; re-running the same window stores nothing new', async () => {
  const db = fakeDb();
  const alerts = [];
  const deps = { supabase: db, runReportAndWait: report([SAMPLE, leg2]), reportAlertCondition: async (a) => alerts.push(a) };
  const first = await runFive9CallJourneySync({ env: { FIVE9_JOURNEY_SYNC_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(first.ok, true);
  assert.equal(first.inserted, 2);
  assert.equal(db.legs.size, 2);
  assert.equal(db.runs[0].status, 'ok');
  assert.equal(db.runs[0].rows_returned, 2);
  assert.equal(db.runs[0].rows_upserted, 2);
  assert.equal(alerts.at(-1).active, false, 'a clean pass clears');
  const again = await runFive9CallJourneySync({ env: { FIVE9_JOURNEY_SYNC_MODE: 'live' }, nowMs: NOW + 15 * 60_000, deps });
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 2, 'the overlap re-reads the same legs');
  assert.equal(db.legs.size, 2);
});

test('shadow: pulls, parses and logs the run, stores no row', async () => {
  const db = fakeDb();
  const out = await runFive9CallJourneySync({ env: {}, nowMs: NOW, deps: { supabase: db, runReportAndWait: report([SAMPLE]), reportAlertCondition: async () => {} } });
  assert.equal(journeyMode({}), 'shadow');
  assert.equal(out.mode, 'shadow');
  assert.equal(out.returned, 1);
  assert.equal(db.legs.size, 0);
  assert.equal(db.runs[0].mode, 'shadow');
  assert.equal(db.runs[0].status, 'ok');
  assert.equal(db.runs[0].rows_rejected, 0);
});

test('a report that does not finish logs a timeout and keeps the cursor', async () => {
  const db = fakeDb({ lastEnd: '2026-10-15T17:13:00Z' });
  const alerts = [];
  const out = await runFive9CallJourneySync({
    env: { FIVE9_JOURNEY_SYNC_MODE: 'live' }, nowMs: NOW,
    deps: { supabase: db, runReportAndWait: async () => ({ done: false, timed_out_after_ms: 180000 }), reportAlertCondition: async (a) => alerts.push(a) },
  });
  assert.equal(out.ok, false);
  assert.equal(db.runs[0].status, 'timeout');
  assert.equal(alerts[0].active, true);
  assert.equal(alerts[0].channel, 'ops');
});

test('alert: rows returned and none stored pages; a clean shadow pass clears; nothing pulled touches nothing', () => {
  assert.equal(journeyAlertState({ mode: 'live', results: [{ ok: true, returned: 150, inserted: 0, updated: 0, unchanged: 0, rejected: 0 }] }).active, true);
  assert.equal(journeyAlertState({ mode: 'shadow', results: [{ ok: true, returned: 150, rejected: 0 }] }).active, false);
  assert.equal(journeyAlertState({ mode: 'live', results: [{ ok: true, returned: 150, inserted: 3, rejected: 2, rejects: { bad_timestamp: 2 } }] }).active, true);
  assert.equal(journeyAlertState({ mode: 'live', results: [] }), null);
});

test('backfill runs only in live, in chunks of 6 hours or less, logged as backfill', async () => {
  const refused = await runFive9CallJourneyBackfill({ days: 1, env: {}, nowMs: NOW });
  assert.equal(refused.refused, true);
  const db = fakeDb();
  const out = await runFive9CallJourneyBackfill({ days: 1, env: { FIVE9_JOURNEY_SYNC_MODE: 'live' }, nowMs: NOW, deps: { supabase: db, runReportAndWait: report([SAMPLE]) } });
  assert.equal(out.ok, true);
  assert.equal(out.windows, 4, '24h minus the 2-minute lag → 3 full 6h chunks and a short one');
  assert.ok(db.runs.every((r) => r.mode === 'backfill' && r.status === 'ok'));
  assert.equal(db.legs.size, 1);
});
