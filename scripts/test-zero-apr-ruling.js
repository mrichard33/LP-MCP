/**
 * scripts/test-zero-apr-ruling.js — Mark's 0% APR ruling, held by the guards.
 *
 * THE RULING (Mark, 2026-09-25; reconfirmed 2026-10-10): the bot may say Reece
 * offers 0% APR financing. It may quote NO other rate, term, monthly payment
 * or financing figure.
 *
 * PR #1236 removed "0% APR" from the financing FAQ to match a prompt line
 * ("NEVER quote rates or terms") that had no exception, and MONEY_RX matched
 * both "0%" and "APR", so the plan enforcer deleted the FINANCING script's own
 * answer. Both sides now allow exactly the one phrase (isMoneyFigure in
 * src/agentic/nepq-planner.js), and checkReply's money_figure uses the same
 * predicate.
 *
 *   node --test scripts/test-zero-apr-ruling.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { checkReply } = await import('../src/eval/reply-invariants.js');
const { isMoneyFigure, dropUnsafeSentences } = await import('../src/agentic/nepq-planner.js');

const RULED = 'Yes, we offer 0% APR financing, and the rep walks you through exactly what fits during the visit.';
const FORBIDDEN = ['5.9% APR', '0% for 18 months', '$99 a month', '0% interest for 12 months'];

const moneyViolation = (reply) => checkReply(reply, { channel: 'sms' }).violations.find((v) => v.code === 'money_figure');

test('the FINANCING script passes checkReply with no money_figure violation', () => {
  assert.equal(moneyViolation(RULED), undefined);
  assert.equal(isMoneyFigure(RULED), false);
});

test('the restored LIB-X06 FAQ answer (sql/156) passes too, so the model can echo the KB PACK', () => {
  const FAQ = 'Yes, we offer 0% APR financing so you can protect your home now and pay over time. A specialist walks you through the terms at the visit so you can pick a monthly amount that fits.';
  assert.equal(moneyViolation(FAQ), undefined);
});

test('every other financing figure still fails money_figure', () => {
  for (const figure of FORBIDDEN) {
    const reply = `We can go over it at the visit. Financing starts at ${figure}.`;
    assert.ok(moneyViolation(reply), `not flagged: ${figure}`);
  }
});

test('"0% APR" with any other figure or term in the same sentence is still a figure', () => {
  for (const s of [
    'Yes, we offer 0% APR financing for 18 months.',
    'We offer 0% APR financing, about $99 a month.',
    'We offer 0% APR financing with no money down.',
    'We offer 0% APR for 12 months on approved credit.',
  ]) {
    assert.equal(isMoneyFigure(s), true, s);
  }
});

test('only the exact phrase is exempt: other rates and spellings stay figures', () => {
  for (const s of ['We offer 5.0% APR financing.', 'We offer 10% APR financing.', 'We offer 0% interest financing.', 'Our APR is low.']) {
    assert.equal(isMoneyFigure(s), true, s);
  }
  // Spacing variants of the one phrase are the same phrase.
  for (const s of ['We offer 0 % APR financing.', 'We offer 0%APR financing.', 'We offer 0% apr financing.']) {
    assert.equal(isMoneyFigure(s), false, s);
  }
  // A sentence with no money in it is not a figure, as before.
  assert.equal(isMoneyFigure('What got you looking into windows now?'), false);
});

test('the plan enforcer keeps the ruled sentence and still drops a forbidden one', () => {
  const kept = dropUnsafeSentences([RULED, 'What got you looking?']);
  assert.deepEqual(kept.sentences, [RULED, 'What got you looking?']);
  assert.ok(!kept.changes.includes('money_figures'));
  const dropped = dropUnsafeSentences(['Financing starts at $99 a month.', 'What got you looking?']);
  assert.deepEqual(dropped.sentences, ['What got you looking?']);
  assert.ok(dropped.changes.includes('money_figures'));
});
