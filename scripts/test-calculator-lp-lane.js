import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcDedupeKey, isCalculatorLead, pickNewestCalculatorLead, calculatorLeadGuardMode,
  CALC_SRS_ID, CALC_PRO_ID, decideExistingLeadAction,
} from '../src/services/lp-existing-lead-guard.js';

test('dedupe key is last 10 digits of the phone', () => {
  assert.equal(calcDedupeKey('+1 (786) 423-8205'), 'calc:7864238205');
  assert.equal(calcDedupeKey('7864238205'), 'calc:7864238205');
  assert.equal(calcDedupeKey('123'), null);
  assert.equal(calcDedupeKey(''), null);
});

test('calculator lead detection by sub-source text or srs_id', () => {
  assert.equal(isCalculatorLead({ sourcesubdescr: 'Website Estimate Calculator' }), true);
  assert.equal(isCalculatorLead({ srs_id: 842 }), true);
  assert.equal(isCalculatorLead({ sourcesubdescr: 'Lead Gurus' }), false);
  assert.equal(isCalculatorLead({ sourcesubdescr: 'Clever' }), false);
});

test('regression: Nancy/Annie — only other-source leads → no calculator lead → create', () => {
  const leads = [
    { id: '427051', sourcesubdescr: 'Lead Gurus', dateentered: '2025-07-05T10:00:00' },
    { id: '199632', sourcesubdescr: 'Clever', dateentered: '2022-11-30T10:00:00' },
  ];
  assert.equal(pickNewestCalculatorLead(leads), null);
});

test('regression: Victor — recent calculator lead is found and reused', () => {
  const leads = [
    { id: '581052', sourcesubdescr: 'Website Estimate Calculator', dateentered: '2026-10-05T01:20:38' },
    { id: '500000', sourcesubdescr: 'Modernize', dateentered: '2026-10-06T09:00:00' },
  ];
  const calc = pickNewestCalculatorLead(leads);
  assert.equal(calc.ldsId, '581052');
  const verdict = decideExistingLeadAction({ createdAtLp: calc.createdAtLp, now: new Date('2026-10-05T12:00:00Z'), windowDays: 15 });
  assert.equal(verdict, 'reuse');
});

test('calculator lead older than 15 days → create', () => {
  const calc = pickNewestCalculatorLead([{ id: '1', sourcesubdescr: 'Website Estimate Calculator', dateentered: '2026-08-01T10:00:00' }]);
  assert.equal(decideExistingLeadAction({ createdAtLp: calc.createdAtLp, now: new Date('2026-10-08T12:00:00Z'), windowDays: 15 }), 'create');
});

test('newer other-source lead does not hide an older recent calculator lead', () => {
  const calc = pickNewestCalculatorLead([
    { id: '10', sourcesubdescr: 'Website Estimate Calculator', dateentered: '2026-10-01T10:00:00' },
    { id: '11', sourcesubdescr: 'MyHomePros', dateentered: '2026-10-06T10:00:00' },
  ]);
  assert.equal(calc.ldsId, '10');
});

test('constants and default mode', () => {
  assert.equal(CALC_SRS_ID, '842');
  assert.equal(CALC_PRO_ID, '5862');
  delete process.env.LP_CALC_LEAD_GUARD_MODE;
  assert.equal(calculatorLeadGuardMode(), 'live');
  process.env.LP_CALC_LEAD_GUARD_MODE = 'shadow';
  assert.equal(calculatorLeadGuardMode(), 'shadow');
  delete process.env.LP_CALC_LEAD_GUARD_MODE;
});
