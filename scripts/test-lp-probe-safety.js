// Tests for the lp_api_probe safety gate (src/tools/admin/lp-probe-safety.js).
// Pure — no network, no env, no node_modules. Run: node --test scripts/test-lp-probe-safety.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProbeSafe, truncateRows } from '../src/tools/admin/lp-probe-safety.js';

// ─── Allowed: every read endpoint the client already calls, plus the
//     SalesApi discovery surface this tool exists to reach. ────────
const ALLOWED = [
  '/api/Customers/GetLead',
  '/api/Leads/GetLeadData',
  '/api/Customers/GetJobStatusChanges',
  '/api/Customers/GetMilestones',
  '/api/Customers/GetLeadInfo',
  '/api/Customers/GetCustomers3',
  '/api/Leads/GetLeadsSourceSubPromoter',
  '/api/SalesApi/GetSalesApptDispProd',
  '/api/SalesApi/GetSalesJobDetail',
  '/api/SalesApi/GetSalesSchedule',
  '/api/SalesApi/ListSalesReps',
  // Regression: deny verbs must match whole CamelCase words, not substrings —
  // "GetLeadData" contains "adD" (≈ Add), "GetDisputes" contains "put",
  // "GetLeadAddress" starts a word with "Add".
  '/api/Leads/GetDisputes',
  '/api/Leads/GetLeadAddress',
];

for (const path of ALLOWED) {
  test(`allows ${path}`, () => {
    assert.doesNotThrow(() => assertProbeSafe(path));
  });
}

// ─── Rejected: every known write endpoint in lp-client.js. ────────
const KNOWN_WRITES = [
  '/api/Leads/AddLead',
  '/api/Leads/LeadAdd',
  '/api/Leads/SetAppointment',
  '/api/Customers/UpdateDNCStatus',
  '/api/SalesApi/AddNotes',
];

for (const path of KNOWN_WRITES) {
  test(`rejects write endpoint ${path}`, () => {
    assert.throws(() => assertProbeSafe(path), /Probe rejected/);
  });
}

// ─── Rejected: mutating verb embedded after the Get/List prefix. ──
const EMBEDDED_VERBS = [
  '/api/Leads/GetAndUpdateLead',
  '/api/Leads/GetLeadDelete',
  '/api/Customers/ListRemoveCandidates',
  '/api/SalesApi/GetMergeStatus',
  '/api/SalesApi/GetSetLead',
];

for (const path of EMBEDDED_VERBS) {
  test(`rejects embedded mutating verb ${path}`, () => {
    assert.throws(() => assertProbeSafe(path), /mutating verb/);
  });
}

// ─── Rejected: malformed / evasive path shapes. ───────────────────
const MALFORMED = [
  '/api/Leads/getLead',                 // lowercase get — allowlist is case-sensitive
  '/api/Leads/GetLead/',                // trailing slash
  '/api/Leads/GetLead?x=1',             // query string
  '/api/Leads/GetLead/extra',           // extra segment
  '/Leads/GetLead',                     // missing /api prefix
  'api/Leads/GetLead',                  // missing leading slash
  '/api/GetLead',                       // missing namespace
  '/api/Leads/Lead',                    // no Get/List prefix
  '/api/Le..ds/GetLead',                // traversal chars in namespace
  '/api/Leads/GetLead%2FAddLead',       // encoded slash
  '',
] ;

for (const path of MALFORMED) {
  test(`rejects malformed path ${JSON.stringify(path)}`, () => {
    assert.throws(() => assertProbeSafe(path), /Probe rejected/);
  });
}

// ─── truncateRows ─────────────────────────────────────────────────
test('truncateRows passes small arrays through untouched', () => {
  const rows = [{ a: 1 }, { a: 2 }];
  assert.deepEqual(truncateRows(rows, 25), rows);
});

test('truncateRows truncates large arrays with metadata', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ i }));
  const out = truncateRows(rows, 25);
  assert.equal(out.total_rows, 40);
  assert.equal(out.showing, 25);
  assert.equal(out.rows.length, 25);
  assert.deepEqual(out.rows[0], { i: 0 });
});

test('truncateRows leaves non-array responses untouched', () => {
  const obj = { data: [1, 2, 3], status: 'ok' };
  assert.deepEqual(truncateRows(obj, 1), obj);
});
