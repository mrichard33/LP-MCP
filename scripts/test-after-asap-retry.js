/**
 * scripts/test-after-asap-retry.js — the After DIAL ASAP retry backstop
 * (2026-10-14). Cases are the real ones from the 10-14 uncalled card: one
 * DIAL ASAP voicemail, then nothing, on phones with several Five9 records.
 *
 * Run: node --test scripts/test-after-asap-retry.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickCandidates, recordForCall, decide, buildRetryRecord, retryMode, retryConfig, AFTER_LIST,
} from '../src/after-asap-retry.js';
import { runAfterAsapRetry } from '../src/jobs/after-asap-retry.js';
import { buildAddRecordToListXml } from '../src/five9/admin-writes.js';

const NOW = Date.parse('2026-10-14T13:30:00Z');
const cfg = retryConfig({});
const ev = (dnis, campaign, d, t, k = 'INQ1', ani = '3527223302') => ({ dnis, ani, campaign, d, lp_rec_key: k, t });

const FIELDS = ['number1', 'first_name', 'last_name', 'zip', 'CustID', 'lead_id', 'LPRecKey', 'LPRecType',
  'f9_last_list', 'f9_last_campaign', 'Number of attempts', 'Contact create time and date'];
const five9 = (...recs) => ({
  count: 1,
  records: [{ fields: FIELDS, records: recs.map((r) => ({ values: { data: FIELDS.map((f) => r[f] ?? '') } })) }],
});
// Lita H.: four records for one phone; the new one never reached After DIAL ASAP.
const LITA = five9(
  { number1: '3522233643', first_name: 'Lita', CustID: '370057', lead_id: '460034', LPRecKey: 'INQ314115', LPRecType: 'cst' },
  { number1: '3522233643', first_name: 'Lita', CustID: '370057', lead_id: '487234', LPRecKey: 'INQ339383', LPRecType: 'cst' },
  { number1: '3522233643', first_name: 'Lita', last_name: 'Higginbotham', zip: '32778', CustID: '370057', lead_id: '583147',
    LPRecKey: 'INQ430381', LPRecType: 'cst', f9_last_list: 'LP_ASAP', f9_last_campaign: 'DIAL ASAP', 'Number of attempts': '00001' },
);

test('pickCandidates: a lone no-contact DIAL ASAP call is owed a follow-up; a retried one is not', () => {
  const events = [
    ev('3522233643', 'DIAL ASAP', 'Answering Machine', '2026-10-13T12:03:55Z', 'INQ430381'),
    ev('8135059785', 'DIAL ASAP', 'Answering Machine', '2026-10-13T12:06:25Z', 'INQ430379'),
    ev('8135059785', 'After DIAL ASAP', 'No Answer', '2026-10-13T14:06:55Z', 'INQ430379'),
    ev('4077443784', 'Simpletext outbound', 'Answering Machine', '2026-10-12T23:28:33Z', 'INQ430298'),
    ev('5555550100', 'DIAL ASAP', 'Appointment Set', '2026-10-13T12:00:00Z'),
  ];
  const c = pickCandidates(events, { nowMs: NOW, cfg });
  assert.deepEqual(c.map((x) => x.phone).sort(), ['3522233643', '4077443784']);
});

test('pickCandidates: a later call on any campaign (inbound included) means it was followed up', () => {
  const events = [
    ev('6467077514', 'DIAL ASAP', 'Answering Machine', '2026-10-13T12:43:35Z'),
    // Molly called back in on the main number (she is the ANI).
    { dnis: '8555768943', ani: '6467077514', campaign: 'Main Number', d: 'NA', lp_rec_key: null, t: '2026-10-14T13:21:22Z' },
  ];
  assert.equal(pickCandidates(events, { nowMs: NOW, cfg }).length, 0);
});

test('pickCandidates: inside the grace (the connector may still be adding it) waits', () => {
  const c = pickCandidates([ev('3522233643', 'DIAL ASAP', 'NA', new Date(NOW - 5 * 60000).toISOString())], { nowMs: NOW, cfg });
  assert.equal(c.length, 0);
});

test('recordForCall finds the record for THIS call, not the oldest', () => {
  const r = recordForCall(LITA, 'INQ430381');
  assert.equal(r.total, 3);
  assert.equal(r.row.lead_id, '583147');
});

test('decide: connector missed a multi-record phone → push', () => {
  const cand = { phone: '3522233643', lpRecKey: 'INQ430381', calls24h: 1 };
  const d = decide({ cand, rec: recordForCall(LITA, 'INQ430381'), lpDispo: 'Data', onDnc: false });
  assert.deepEqual(d, { action: 'push', reason: 'connector_missed_multi_record' });
});

test('decide: never past the 3-in-24 cap, DNC, booked or closed-out leads', () => {
  const rec = recordForCall(LITA, 'INQ430381');
  const base = { phone: '3522233643', lpRecKey: 'INQ430381', calls24h: 1 };
  assert.equal(decide({ cand: { ...base, calls24h: 3 }, rec, lpDispo: 'Data', onDnc: false }).reason, 'at_3_in_24_cap');
  assert.equal(decide({ cand: base, rec, lpDispo: 'Data', onDnc: true }).reason, 'dnc');
  assert.equal(decide({ cand: base, rec, lpDispo: 'Set', onDnc: false }).reason, 'booked');
  assert.equal(decide({ cand: base, rec, lpDispo: 'ND', onDnc: false }).reason, 'lp_ND');
});

test('decide: a record already on After DIAL ASAP is left to Five9', () => {
  const rec = { row: { f9_last_list: AFTER_LIST, CustID: '1' }, total: 1 };
  assert.equal(decide({ cand: { phone: '1', lpRecKey: 'INQ1', calls24h: 1 }, rec, lpDispo: 'Data', onDnc: false }).reason, 'connector_ok');
});

test('buildRetryRecord copies identity fields, never Five9-owned ones', () => {
  const r = buildRetryRecord(recordForCall(LITA, 'INQ430381').row);
  assert.deepEqual(r.fieldNames, ['number1', 'first_name', 'last_name', 'zip', 'CustID', 'lead_id', 'LPRecKey', 'LPRecType']);
  assert.ok(!r.fieldNames.includes('Number of attempts'));
});

test('the add keys on number1 AND LPRecKey, so Five9 matches the new record', () => {
  const xml = buildAddRecordToListXml(AFTER_LIST, ['number1', 'CustID', 'LPRecKey'], ['3522233643', '370057', 'INQ430381'], 'NONE', ['number1', 'LPRecKey']);
  assert.match(xml, /<fieldName>number1<\/fieldName><key>true<\/key>/);
  assert.match(xml, /<fieldName>LPRecKey<\/fieldName><key>true<\/key>/);
  assert.match(xml, /<fieldName>CustID<\/fieldName><key>false<\/key>/);
  // Default unchanged for every other caller.
  assert.match(buildAddRecordToListXml('X', ['number1', 'CustID'], ['1', '2']), /<fieldName>CustID<\/fieldName><key>false<\/key>/);
  assert.throws(() => buildAddRecordToListXml('X', ['number1'], ['1'], null, ['LPRecKey']));
});

test('mode defaults to shadow; a typo is shadow, never live', () => {
  assert.equal(retryMode({}), 'shadow');
  assert.equal(retryMode({ AFTER_ASAP_RETRY_MODE: 'lvie' }), 'shadow');
  assert.equal(retryMode({ AFTER_ASAP_RETRY_MODE: 'off' }), 'off');
});

/* --- the job, stubbed ------------------------------------------------------ */

function stubs({ events, dispo = 'Data', dnc = [], failLp = false } = {}) {
  const inserted = [];
  const marks = new Set();
  const supabase = {
    from: (t) => ({
      upsert: (row) => ({ select: async () => {
        if (marks.has(row.dedup_key)) return { data: [], error: null };
        marks.add(row.dedup_key); return { data: [row], error: null };
      } }),
      insert: (row) => ({ select: () => ({ single: async () => { inserted.push({ t, row }); return { data: { id: inserted.length }, error: null }; } }) }),
      delete: () => ({ in: async () => ({}) }),
    }),
  };
  return {
    inserted,
    deps: {
      runSQL: async (sql) => {
        if (sql.includes('five9_events_raw')) return events;
        if (sql.includes('lp_leads')) { if (failLp) throw new Error('lp down'); return [{ phone10: '3522233643', disposition_code: dispo }]; }
        throw new Error('unexpected sql');
      },
      supabase,
      checkDnc: async () => ({ on_dnc: dnc }),
      getContactRecords: async (arg) => {
        // The real function throws on a bare array (buildLookupCriteriaXml).
        if (!Array.isArray(arg?.criteria) || !arg.criteria.length) throw new Error('lookup_criteria requires at least one { field, value } criterion');
        return LITA;
      },
    },
  };
}
const LITA_EVENTS = [ev('3522233643', 'DIAL ASAP', 'Answering Machine', '2026-10-13T12:03:55Z', 'INQ430381')];

test('job, shadow: decides would_push and writes nothing', async () => {
  const s = stubs({ events: LITA_EVENTS });
  const r = await runAfterAsapRetry({ env: {}, nowMs: NOW, deps: s.deps });
  assert.equal(r.counts.would_push, 1);
  assert.equal(s.inserted.length, 0);
});

test('job, live: one action keyed number1+LPRecKey, and only once', async () => {
  const s = stubs({ events: LITA_EVENTS });
  const env = { AFTER_ASAP_RETRY_MODE: 'live' };
  await runAfterAsapRetry({ env, nowMs: NOW, deps: s.deps });
  const again = await runAfterAsapRetry({ env, nowMs: NOW + 900000, deps: s.deps });
  assert.equal(s.inserted.length, 1);
  assert.equal(again.counts.already_pushed, 1);
  const p = s.inserted[0].row.action_payload;
  assert.equal(p.list_name, AFTER_LIST);
  assert.deepEqual(p.key_fields, ['number1', 'LPRecKey']);
  assert.equal(p.records[0][p.field_names.indexOf('lead_id')], '583147');
});

test('job: a failed LP read pushes nothing (never dial blind)', async () => {
  const s = stubs({ events: LITA_EVENTS, failLp: true });
  const r = await runAfterAsapRetry({ env: { AFTER_ASAP_RETRY_MODE: 'live' }, nowMs: NOW, deps: s.deps });
  assert.equal(r.ok, false);
  assert.equal(s.inserted.length, 0);
});
