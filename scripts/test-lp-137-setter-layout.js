/**
 * scripts/test-lp-137-setter-layout.js
 *
 * The PRINTED "Sales Efficiency By Setter" page (LP report 137), as LP's viewer
 * exports it to .xls and LibreOffice/Excel saves it to CSV: the reader
 * (parseSalesEfficiencySetterLayout), its fingerprint, and the backfill
 * script's check. The fixture is built here, cell by cell, in the real file's
 * shape (measured on the Jan–Sep 2026 exports, 2026-10-08): the first setter
 * spilling into the header rows, LP's unnamed "no setter" bucket, and the
 * Total spread over many rows one cell each. Numbers are made up.
 *
 * Run: node --test scripts/test-lp-137-setter-layout.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSalesEfficiencySetterLayout, isSalesEfficiencySetterLayout, validateSalesEfficiency,
  SE_LAYOUT_COLUMNS,
} from '../src/jobs/lp-report-parse-sales-efficiency.js';
import { parseCsv } from '../src/jobs/lp-report-csv-common.js';
import { checkFile } from './lp-137-setter-layout-backfill.js';

const WIDTH = 47;
const row = (cells) => {
  const r = Array(WIDTH).fill('');
  for (const [c, v] of Object.entries(cells)) r[Number(c)] = v;
  return r;
};
const toCsv = (grid) => grid.map((r) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');

/** Real-shaped printed page; `edit(grid)` may change it before it is serialised. */
function page(edit = (g) => g) {
  const g = [
    row({ 4: 'Sales Efficiency By Setter' }),
    row({ 4: 'For Appointment Dates Between Sun 02/01/26 and Sat 02/28/26' }),
    row({ 0: 'By Setter', 1: 'Gross Iss', 2: 'Net Iss', 4: 'Market: ALL    Sort By: By STD    Group By: By Setter    Grade: ALL',
      8: 'Close', 15: 'Working', 22: 'Credit Decline', 28: 'Canceled', 33: 'Hold-HOA', 41: 'Net' }),
    row({ 46: 'NCP' }),
    // LP's unnamed "no setter" bucket, spilling into the header rows like the first setter always does.
    row({ 1: '2', 2: '1', 3: 'Demo', 46: 'NSLI' }),
    row({ 3: '1', 6: '%OTD', 9: '%STD', 11: '%Vol', 15: '%Cnt' }),
    row({ 6: '1', 10: '20000', 14: '0', 18: '0', 21: '0', 24: '0', 27: '0', 30: '0', 33: '0', 37: '0', 40: '1', 43: '18000', 46: '9000' }),
    row({ 2: '50%', 3: '100%', 6: '50%', 11: '20000' }),
    row({ 0: 'Deer - LF, Craig', 1: '10', 2: '8', 3: '6', 6: '2', 10: '45000.50', 14: '1', 18: '9000', 21: '0', 24: '0',
      27: '1', 30: '12000', 33: '0', 37: '0', 40: '1', 43: '30000', 46: '3000' }),
    row({ 2: '80%', 3: '75%', 6: '20%', 11: '22500' }),
    // The Total, one cell per row, a percent cell in the middle.
    row({ 1: '12', 2: '9', 46: '5333' }),
    row({ 3: '7' }),
    row({ 6: '3', 24: '0.0%' }),
    row({ 10: '65000.50', 11: '21667' }),
    row({ 14: '1' }), row({ 18: '9000' }), row({ 21: '0' }), row({ 24: '0' }),
    row({ 27: '1' }), row({ 30: '12000' }), row({ 33: '0' }), row({ 37: '0' }),
    row({ 40: '2' }), row({ 43: '48000' }),
    row({ 0: 'Total:', 2: '75%' }),
    row({ 0: '2/9/2026 9:05AM', 16: 'Page 1 of 1', 35: 'Mark Richard' }),
    row({ 0: 'C1.C1Report.Section' }),
  ];
  return toCsv(edit(g) ?? g);
}
const setCell = (g, r, c, v) => { g[r][c] = v; return g; };

test('the printed page is recognised by its title and column labels; a data export is not', () => {
  assert.equal(isSalesEfficiencySetterLayout(parseCsv(page())), true);
  const dataExport = '"Grouper","NumIssued","NumSale"\n"Deer - LF, Craig","138","22"\n';
  assert.equal(isSalesEfficiencySetterLayout(parseCsv(dataExport)), false);
  // A moved column label is a changed layout: refused, never mapped by guess.
  assert.equal(isSalesEfficiencySetterLayout(parseCsv(page((g) => { g[2][8] = ''; g[2][9] = 'Close'; return g; }))), false);
});

test('every setter is read by column, the spilled first block and the unnamed bucket included', () => {
  const p = parseSalesEfficiencySetterLayout(page());
  assert.equal(p.mode, 'full');
  assert.deepEqual(p.header, { periodStart: '2026-02-01', periodEnd: '2026-02-28', asOf: '2026-02-09', generatedAt: '2026-02-09T14:05:00.000Z' });
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0], {
    row_num: 1, setter_name_raw: '', num_issued: 2, num_net_issued: 1, num_sat: 1, num_sold: 1, gsa_cents: 2000000,
    num_working: 0, working_cents: 0, num_cd: 0, cd_cents: 0, num_cancelled: 0, cancelled_cents: 0,
    num_hold: 0, hold_cents: 0, num_net: 1, nsa_cents: 1800000,
  });
  assert.equal(p.rows[1].setter_name_raw, 'Deer - LF, Craig');
  assert.equal(p.rows[1].gsa_cents, 4500050);
  assert.equal(p.rows[1].num_sold, 2);
  assert.deepEqual(p.misaligned, []);
  assert.equal(p.totals.num_issued, 12);
  assert.equal(p.totals.num_sat, 7);
  assert.equal(validateSalesEfficiency(p, {}).ok, true);
});

test('the printed Total is the checksum: one count off refuses the file', () => {
  const p = parseSalesEfficiencySetterLayout(page((g) => setCell(g, 12, 6, '4')));
  const v = validateSalesEfficiency(p, {});
  assert.equal(v.ok, false);
  assert.deepEqual(v.violations[0].rule, 'total_row_mismatch');
  assert.equal(v.violations[0].detail.column, 'num_sold');
});

test('a value in an unknown column, or a field read twice, refuses the file', () => {
  const moved = parseSalesEfficiencySetterLayout(page((g) => setCell(g, 8, 7, '5')));
  assert.equal(validateSalesEfficiency(moved, {}).violations[0].rule, 'column_misaligned');
  const twice = parseSalesEfficiencySetterLayout(page((g) => setCell(g, 5, 10, '1')));
  assert.equal(twice.misaligned[0].reason, 'field_twice');
  assert.equal(validateSalesEfficiency(twice, {}).ok, false);
});

test('no printed Net total means counts only, and Net stays NULL, never 0', () => {
  const p = parseSalesEfficiencySetterLayout(page((g) => {
    for (const r of g) { if (/^\d/.test(r[40])) r[40] = ''; if (/^\d/.test(r[43])) r[43] = ''; }
    return g;
  }));
  assert.equal(p.mode, 'counts_only');
  assert.equal(p.rows[0].num_net, null);
  assert.equal(p.rows[1].nsa_cents, null);
  assert.equal('num_net' in p.totals, false);
  assert.equal(validateSalesEfficiency(p, {}).ok, true);
});

test('a page with no Total row is unparseable, not a guess', () => {
  const p = parseSalesEfficiencySetterLayout(page((g) => g.filter((r) => r[0] !== 'Total:')));
  assert.equal(p.mode, 'unparseable');
  assert.equal(p.error, 'total_row_not_found');
  assert.equal(validateSalesEfficiency(p, {}).ok, false);
});

test('the column map leaves the printed NSLI (46) and the average sale (11) out', () => {
  assert.equal(46 in SE_LAYOUT_COLUMNS, false);
  assert.equal(11 in SE_LAYOUT_COLUMNS, false);
});

test('backfill check: passes the page, refuses anything else', () => {
  const ok = checkFile(page());
  assert.equal(ok.ok, true);
  assert.equal(ok.parsed.rows.length, 2);
  assert.match(checkFile('"Grouper","NumIssued"\n"x","1"\n').reason, /not the printed/);
  assert.equal(checkFile(page((g) => setCell(g, 11, 3, '9'))).reason, 'total_row_mismatch');
});
