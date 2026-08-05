/**
 * Guards for src/jobs/lp-report-csv-common.js — shared CSV structure
 * helpers for the LP CSV export parsers.
 *
 * Invariants under guard:
 *   • parseCsv handles RFC-4180 edges: quoted fields, embedded commas,
 *     "" escapes, CRLF, trailing newline (identical behavior to the copy
 *     that lived in scorecard-rtp-source.js).
 *   • csvToObjects fails CLOSED on missing required columns and drops only
 *     fully-empty rows.
 *   • parseCsvDate accepts M/D/YYYY and M/D/YYYY HH:MM (appt slots print a
 *     time), garbage → null.
 *   • parseCount: garbage returns null, never 0.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, csvToObjects, parseCsvDate, parseCount } from '../src/jobs/lp-report-csv-common.js';

test('parseCsv: quoted fields, embedded commas, "" escapes, CRLF', () => {
  const text = 'a,b,c\r\n"one, two",plain,"say ""hi"""\r\nx,,z\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['one, two', 'plain', 'say "hi"'],
    ['x', '', 'z'],
  ]);
});

test('parseCsv: newline inside quotes stays in the field', () => {
  const rows = parseCsv('h1,h2\n"line1\nline2",v\n');
  assert.deepEqual(rows, [['h1', 'h2'], ['line1\nline2', 'v']]);
});

test('csvToObjects: header-keyed rows, empty rows dropped, short rows padded', () => {
  const { header, rows } = csvToObjects('a,b\n1,2\n,,\n3\n', ['a', 'b']);
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows, [{ a: '1', b: '2' }, { a: '3', b: '' }]);
});

test('csvToObjects: missing required column fails closed', () => {
  assert.throws(() => csvToObjects('a,b\n1,2\n', ['a', 'nope']), /missing required columns \(nope\)/);
  assert.throws(() => csvToObjects('', ['a']), /empty CSV/);
});

test('parseCsvDate: date and datetime forms', () => {
  assert.equal(parseCsvDate('1/6/2026'), '2026-01-06');
  assert.equal(parseCsvDate('12/31/2026'), '2026-12-31');
  assert.equal(parseCsvDate('1/31/2026 14:00'), '2026-01-31');
  assert.equal(parseCsvDate('8/5/2026 10:31'), '2026-08-05');
  assert.equal(parseCsvDate(''), null);
  assert.equal(parseCsvDate('13/1/2026'), null);
  assert.equal(parseCsvDate('05/16/26'), null); // 2-digit years are the PDF path's business
  assert.equal(parseCsvDate('garbage'), null);
});

test('parseCount: integers with commas; garbage null, never 0', () => {
  assert.equal(parseCount('12,257'), 12257);
  assert.equal(parseCount('0'), 0);
  assert.equal(parseCount('-3'), -3);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('1.5'), null);
  assert.equal(parseCount('n/a'), null);
});
