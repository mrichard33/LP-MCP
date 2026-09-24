/**
 * scripts/test-identity-health.js
 *
 * Offline coverage for get_identity_health (src/identity-health.js). The
 * database is stubbed through the deps.runSQL seam; the fixture numbers are
 * the live ones measured on 2026-09-23/24, so a regression in the shaping
 * shows up as a wrong number an operator would recognise.
 *
 * Run: node --test scripts/test-identity-health.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getIdentityHealth,
  buildIdentityHealth,
  pct,
  LEAD_WINDOWS_SQL,
  PEOPLE_SQL,
  FIVE9_KEY_SQL,
  UNMATCHED_SQL,
} from '../src/identity-health.js';

// run_sql hands bigint back as strings — the fixture does too.
const FIXTURE = {
  [LEAD_WINDOWS_SQL]: [{
    leads_30d: '4210', linked_30d: '4202',
    leads_31_90: '8110', linked_31_90: '8050',
    leads_91_365: '30100', linked_91_365: '21000',
    sets_90d: '2400', sets_linked_90d: '2390',
    won_90d: '610', won_linked_90d: '605',
    missing_source_90d: '12',
  }],
  [PEOPLE_SQL]: [{ people: '20120', lp_rows: '30511', link_mismatches: '263' }],
  [FIVE9_KEY_SQL]: [{ events_30d: '52000', keyed_30d: '47000' }],
  [UNMATCHED_SQL]: [
    { campaign: 'Main Number', callers: '666', appt_set: '1' },
    { campaign: 'Google PPC Windows', callers: '257', appt_set: '2' },
    { campaign: 'St Pete Sticky', callers: '84', appt_set: '0' },
  ],
};

const stubSQL = async (sql) => {
  if (!(sql in FIXTURE)) throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  return FIXTURE[sql];
};

const EXPECTED_KEYS = [
  'lp_to_ghl_link_pct',
  'outcomes_linked_90d',
  'people_vs_rows',
  'link_mismatches',
  'five9_events_with_lp_key_pct_30d',
  'unmatched_callers_30d_by_campaign',
  'appt_set_without_lp_record_30d',
  'leads_missing_source_90d',
];

/** Every percentage the report carries, with a path for the failure message. */
function percentages(r) {
  return [
    ['lp_to_ghl_link_pct.last_30d', r.lp_to_ghl_link_pct.last_30d],
    ['lp_to_ghl_link_pct.d31_90', r.lp_to_ghl_link_pct.d31_90],
    ['lp_to_ghl_link_pct.d91_365', r.lp_to_ghl_link_pct.d91_365],
    ['people_vs_rows.overcount_pct', r.people_vs_rows.overcount_pct],
    ['five9_events_with_lp_key_pct_30d', r.five9_events_with_lp_key_pct_30d],
  ];
}

test('the tool returns every key in the contract', async () => {
  const r = await getIdentityHealth({ runSQL: stubSQL });
  assert.deepEqual(Object.keys(r).sort(), [...EXPECTED_KEYS].sort());
  assert.deepEqual(Object.keys(r.lp_to_ghl_link_pct).sort(), ['d31_90', 'd91_365', 'last_30d']);
  assert.deepEqual(Object.keys(r.outcomes_linked_90d).sort(), ['closed_won', 'sets']);
  assert.deepEqual(Object.keys(r.people_vs_rows).sort(), ['lp_rows', 'overcount_pct', 'people']);
  for (const row of r.unmatched_callers_30d_by_campaign) {
    assert.deepEqual(Object.keys(row).sort(), ['callers', 'campaign']);
  }
});

test('every percentage is a number between 0 and 100', async () => {
  const r = await getIdentityHealth({ runSQL: stubSQL });
  for (const [path, v] of percentages(r)) {
    assert.equal(typeof v, 'number', `${path} should be a number, got ${v}`);
    assert.ok(v >= 0 && v <= 100, `${path} out of range: ${v}`);
  }
});

test('people <= lp_rows', async () => {
  const r = await getIdentityHealth({ runSQL: stubSQL });
  assert.ok(r.people_vs_rows.people <= r.people_vs_rows.lp_rows);
});

test('the live numbers come through unchanged', async () => {
  const r = await getIdentityHealth({ runSQL: stubSQL });
  assert.equal(r.people_vs_rows.people, 20120);
  assert.equal(r.people_vs_rows.lp_rows, 30511);
  // (30,511 − 20,120) / 30,511 — a third of linked rows repeat a person.
  assert.equal(r.people_vs_rows.overcount_pct, 34.1);
  assert.equal(r.link_mismatches, 263);
  assert.deepEqual(r.unmatched_callers_30d_by_campaign[1], { campaign: 'Google PPC Windows', callers: 257 });
  assert.equal(r.appt_set_without_lp_record_30d, 3);
  assert.deepEqual(r.outcomes_linked_90d.sets, [2390, 2400]);
  assert.deepEqual(r.outcomes_linked_90d.closed_won, [605, 610]);
  assert.equal(r.leads_missing_source_90d, 12);
});

test('an empty window is null, not 0% — "nothing to measure" is not "nothing linked"', () => {
  assert.equal(pct(0, 0), null);
  assert.equal(pct(5, 0), null);
  assert.equal(pct(0, 10), 0);
  assert.equal(pct(10, 10), 100);
  assert.equal(pct(11, 10), 100, 'clamped');
});

test('a failed read throws instead of reporting zeros', async () => {
  const failing = async (sql) => {
    if (sql === PEOPLE_SQL) throw new Error('relation "v_lead_people" does not exist');
    return stubSQL(sql);
  };
  await assert.rejects(() => getIdentityHealth({ runSQL: failing }), /v_lead_people/);
});

test('a read that returns no row set throws', () => {
  assert.throws(
    () => buildIdentityHealth({ leads: null, people: [], five9: [], unmatched: [] }),
    /lead windows/,
  );
});

test('the queries window on created_at_lp and read links from ghl_contact_id', () => {
  assert.match(LEAD_WINDOWS_SQL, /created_at_lp/);
  assert.doesNotMatch(LEAD_WINDOWS_SQL, /\bcreated_at\b(?!_lp)/);
  assert.match(LEAD_WINDOWS_SQL, /count\(ghl_contact_id\)/);
  assert.doesNotMatch(LEAD_WINDOWS_SQL, /\bid\b/);
});
