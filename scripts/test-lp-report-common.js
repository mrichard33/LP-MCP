/**
 * Guards for src/jobs/lp-report-common.js.
 *
 * Invariants under guard:
 *   • Money is CENTS, integer, exact — commas, $, parens/minus negatives,
 *     and '$0' all round-trip; garbage returns null, never 0.
 *   • Dates are M/D/YYYY → ISO or null — never a shifted/guessed date.
 *   • resolveRowMarket returns null (→ quarantine) for empty AND unmapped
 *     branches; LP's space-padded codes ('ORL  ') resolve like clean ones.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMoneyCents, centsToDollars, parseDateMDY, sha256Hex, resolveRowMarket,
} from '../src/jobs/lp-report-common.js';

test('parseMoneyCents: report formats to exact cents', () => {
  assert.equal(parseMoneyCents('1,158,424.00'), 115842400);
  assert.equal(parseMoneyCents('$7,502,745.76'), 750274576);
  assert.equal(parseMoneyCents('135,317.08'), 13531708);
  assert.equal(parseMoneyCents('0'), 0);
  assert.equal(parseMoneyCents('$0.00'), 0);
  assert.equal(parseMoneyCents('21,750'), 2175000);
});

test('parseMoneyCents: negatives via minus and parens', () => {
  assert.equal(parseMoneyCents('-1,234.56'), -123456);
  assert.equal(parseMoneyCents('(1,234.56)'), -123456);
});

test('parseMoneyCents: garbage is null, never zero', () => {
  assert.equal(parseMoneyCents(''), null);
  assert.equal(parseMoneyCents('-'), null);
  assert.equal(parseMoneyCents('N/A'), null);
  assert.equal(parseMoneyCents(null), null);
  assert.equal(parseMoneyCents('12.345'), null); // 3 decimals = not report money
});

test('centsToDollars renders sign and pads cents', () => {
  assert.equal(centsToDollars(750274576), '7502745.76');
  assert.equal(centsToDollars(-105), '-1.05');
  assert.equal(centsToDollars(0), '0.00');
  assert.equal(centsToDollars(null), null);
});

test('parseDateMDY: valid and invalid', () => {
  assert.equal(parseDateMDY('7/1/2026'), '2026-07-01');
  assert.equal(parseDateMDY('12/31/2025'), '2025-12-31');
  assert.equal(parseDateMDY('13/1/2026'), null);
  assert.equal(parseDateMDY('7/32/2026'), null);
  assert.equal(parseDateMDY('2026-07-01'), null);
  assert.equal(parseDateMDY(''), null);
});

test('sha256Hex is stable and hex', () => {
  const h = sha256Hex(Buffer.from('lp-report'));
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, sha256Hex(Buffer.from('lp-report')));
});

test('resolveRowMarket: padded branch resolves, unmapped/empty quarantine (null)', () => {
  const branchMap = new Map([['ORL', 'ORL_MKT'], ['BOCA', 'FTLAU_MKT']]);
  assert.equal(resolveRowMarket('ORL  ', branchMap), 'ORL_MKT'); // LP pads with spaces
  assert.equal(resolveRowMarket('boca', branchMap), 'FTLAU_MKT');
  assert.equal(resolveRowMarket('TAMPA', branchMap), null); // unknown branch → quarantine
  assert.equal(resolveRowMarket('', branchMap), null);
  assert.equal(resolveRowMarket(null, branchMap), null);
});
