/**
 * Guards for src/jobs/lp-report-parse-lead-disposition.js — the Lead
 * Disposition Detail CSV parser.
 *
 * Invariants under guard:
 *   • Duplicate lead ids are KEPT (row grain, 6,182 repeats in the real
 *     export) — row_num is the identity.
 *   • Market resolution: mapped brn → brn_map; blank or literal '0' brn →
 *     zip fallback (zip_lookup / zip_out_of_area / no_address); a REAL but
 *     unmapped branch code is returned for quarantine (fail closed) —
 *     never silently degraded to zip. RFED resolves once seeded.
 *   • UNASSIGNED / OUT_OF_AREA rows are retained, never dropped.
 *   • Money is cents; ApptDate's time component is dropped; control totals
 *     (gsa/net/sets) sum exactly.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLeadDispositionCsv, validateLeadDispositionCsv, resolveLeadMarkets,
  leadDispositionControlTotals,
} from '../src/jobs/lp-report-parse-lead-disposition.js';

const HEADER = 'Category,lastname,FirstName,id,Phone,Address1,city,state,Zip,CSZ,Email,entrydate,productid,lastresult,clq_id,cqd_id,dsp_id,src_id,sds_id,brn_id,PromoterName,SourceSubDescr,lr,dspdescr,NumDials,NumSuperseded,LastCallDescr,GSA,NetAmount,ApptDate,JobStatus,FullName,SDate,EDate,xsrc_id,xbrn_id,xSourceSubDescr,xPromoter,CurrentDateTime,UseColor,xGrade';

const row = (over = {}) => {
  const base = {
    Category: 'Killed', lastname: 'Doe', FirstName: 'Jane', id: '390157', Phone: '5555550100',
    Address1: '1 Main St', city: 'Orlando', state: 'FL', Zip: '32801', CSZ: '', Email: '',
    entrydate: '1/6/2026', productid: 'W', lastresult: 'NI', clq_id: '0', cqd_id: '0',
    dsp_id: '1', src_id: 'Internet', sds_id: '2', brn_id: 'ORL', PromoterName: '',
    SourceSubDescr: 'Modernize', lr: '', dspdescr: 'Data-Data Only - No Appt', NumDials: '3',
    NumSuperseded: '0', LastCallDescr: '', GSA: '0', NetAmount: '0', ApptDate: '',
    JobStatus: '', FullName: 'Mark Richard', SDate: '1/1/2026', EDate: '8/5/2026',
    xsrc_id: 'ALL', xbrn_id: 'ALL', xSourceSubDescr: 'ALL', xPromoter: 'ALL',
    CurrentDateTime: '8/5/2026 10:31', UseColor: 'TRUE', xGrade: '',
  };
  return HEADER.split(',').map((h) => ({ ...base, ...over })[h] ?? '').join(',');
};

const csv = (...rows) => [HEADER, ...rows].join('\n');

// mirror of the live maps: zip → branch code, branch code → market
const MAPS = {
  zipMap: new Map([['32801', 'ORL'], ['33701', 'STPET']]),
  branchMap: new Map([
    ['ORL', 'ORL_MKT'], ['LAKE', 'LAKE_MKT'], ['STPET', 'STPET_MKT'],
    ['FTLAU', 'FTLAU_MKT'], ['BOCA', 'FTLAU_MKT'], ['MIAMI', 'FTLAU_MKT'], ['RFED', 'FTLAU_MKT'],
    ['FTMYR', 'FTMYR_MKT'], ['SAR', 'SAR_MKT'], ['JAX', 'JAX_MKT'],
  ]),
};

test('parse: duplicate lead ids kept, row_num is the identity', () => {
  const { rows } = parseLeadDispositionCsv(csv(
    row({ id: '390157' }), row({ id: '390157', Category: 'Superseded' }), row({ id: '999' }),
  ));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.row_num), [1, 2, 3]);
  assert.equal(rows.filter((r) => r.lp_lead_id === '390157').length, 2);
});

test('parse: cents exact, appt time dropped, sets counted', () => {
  const { rows } = parseLeadDispositionCsv(csv(
    row({ GSA: '33000', NetAmount: '32500.50', ApptDate: '1/31/2026 14:00' }),
    row({ GSA: '', NetAmount: '' }),
  ));
  assert.equal(rows[0].gsa_cents, 3300000);
  assert.equal(rows[0].net_cents, 3250050);
  assert.equal(rows[0].appt_date, '2026-01-31');
  assert.equal(rows[1].gsa_cents, 0); // blank money is 0 for funnel sums
  const t = leadDispositionControlTotals(rows);
  assert.deepEqual(t, { gsa_cents: 3300000, net_cents: 3250050, sets_count: 1 });
});

test('resolve: mapped brn wins; RFED maps once seeded', () => {
  const { rows } = parseLeadDispositionCsv(csv(row({ brn_id: 'RFED', Zip: '99999' })));
  const unmapped = resolveLeadMarkets(rows, MAPS);
  assert.equal(unmapped.length, 0);
  assert.equal(rows[0].market, 'FTLAU_MKT');
  assert.equal(rows[0].market_method, 'brn_map');
});

test('resolve: blank and literal-0 brn fall back to zip; out-of-territory zip and no zip are retained visibly', () => {
  const { rows } = parseLeadDispositionCsv(csv(
    row({ brn_id: '', Zip: '33701' }),        // zip in territory → STPET_MKT
    row({ brn_id: '0', Zip: '32801' }),       // '0' is documented garbage → zip
    row({ brn_id: '', Zip: '90210' }),        // out of territory
    row({ brn_id: '', Zip: '' }),             // no zip at all
  ));
  const unmapped = resolveLeadMarkets(rows, MAPS);
  assert.equal(unmapped.length, 0);
  assert.deepEqual(rows.map((r) => [r.market, r.market_method]), [
    ['STPET_MKT', 'zip_lookup'],
    ['ORL_MKT', 'zip_lookup'],
    ['OUT_OF_AREA', 'zip_out_of_area'],
    ['UNASSIGNED', 'no_address'],
  ]);
});

test('resolve: a REAL unmapped branch code fails closed, never degrades to zip', () => {
  const { rows } = parseLeadDispositionCsv(csv(row({ brn_id: 'NEWBRANCH', Zip: '32801' })));
  const unmapped = resolveLeadMarkets(rows, MAPS);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].brn_id_raw, 'NEWBRANCH');
  assert.equal(rows[0].market_method, 'unmapped_branch');
});

test('validate: missing id and unparseable entrydate fail closed', () => {
  const noId = validateLeadDispositionCsv(parseLeadDispositionCsv(csv(row({ id: '' }))));
  assert.equal(noId.ok, false);
  assert.equal(noId.violations[0].rule, 'missing_lead_id');
  const badDate = validateLeadDispositionCsv(parseLeadDispositionCsv(csv(row({ entrydate: 'not-a-date' }))));
  assert.equal(badDate.ok, false);
  assert.ok(badDate.violations.some((v) => v.rule === 'bad_entry_date'));
});
