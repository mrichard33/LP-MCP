/**
 * scripts/test-carrier-risk.js
 *
 * Drives src/agentic/carrier-risk.js against the message that caused it:
 * GHL message ghmZnX5TZjeFeagYwaaR, 2026-09-22, rejected by the carrier with
 * "Error 30007 - Message blocked due to carrier policies."
 *
 * Pure module — no supabase, no GHL, no network, no env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  carrierRisks,
  hasCarrierRisk,
  carrierRiskNote,
  CARRIER_SAFETY_RULE,
} from '../src/agentic/carrier-risk.js';

// The exact body the carrier rejected.
const BLOCKED = "Saving on electricity is a real bonus with impact windows too, the Low-E glass cuts heat transfer so your AC can run less. And no, we can't take Bitcoin directly, but our team has other financing options they can go over with you.";

test('the real blocked message is flagged', () => {
  assert.equal(hasCarrierRisk(BLOCKED), true);
  assert.deepEqual(carrierRisks(BLOCKED), ['cryptocurrency']);
});

test('a decline that does not name the term is clean', () => {
  const safe = "We can't take that one, but our team can walk you through the payment options we do offer.";
  assert.equal(hasCarrierRisk(safe), false);
});

test('crypto is caught in its common forms', () => {
  for (const s of ['Can we do bitcoin?', 'We accept BTC', 'paid in Ethereum', 'no crypto', 'cryptocurrency is out']) {
    assert.equal(hasCarrierRisk(s), true, `missed: ${s}`);
  }
});

test('cash apps are caught', () => {
  assert.deepEqual(carrierRisks('Can I Venmo you?'), ['a peer-to-peer cash app']);
  assert.deepEqual(carrierRisks('we take Cash App'), ['a peer-to-peer cash app']);
  assert.deepEqual(carrierRisks('send it by Zelle'), ['a peer-to-peer cash app']);
});

// ── the trade this module exists to avoid making ───────────────────

test("Reece's own core vocabulary is NEVER flagged", () => {
  // Every one of these is real Reece copy. Flagging any of them to chase a
  // carrier filter would cost live conversations, which is worse than the
  // blocked message this module prevents.
  const realCopy = [
    '0% APR financing available on approved credit.',
    'Most families find the energy and insurance savings offset the monthly payment.',
    'My Safe Florida Home offers matching grants for impact upgrades.',
    'You may qualify for a federal tax credit — our QMID is E1P4.',
    'Many Florida homeowners save thousands on insurance premiums.',
    'Our team has other payment options they can go over with you.',
    'There is no cost and no obligation for the in-home visit.',
  ];
  for (const s of realCopy) {
    assert.equal(hasCarrierRisk(s), false, `false positive on real Reece copy: ${s}`);
  }
});

test('plain "financing" is not debt-relief wording', () => {
  assert.equal(hasCarrierRisk('We offer financing.'), false);
  assert.equal(hasCarrierRisk('Ask about our financing options.'), false);
  // ...but the genuinely filtered phrases still are
  assert.equal(hasCarrierRisk('debt consolidation available'), true);
  assert.equal(hasCarrierRisk('no payday loan needed'), true);
});

test('prize wording is caught', () => {
  assert.equal(hasCarrierRisk("You've won a free window!"), true);
  assert.equal(hasCarrierRisk('Claim your prize today'), true);
});

// ── the regeneration note ──────────────────────────────────────────

test('the note names the category and never the word itself', () => {
  const note = carrierRiskNote(['cryptocurrency']);
  assert.match(note, /cryptocurrency/);
  // Handing the literal token back is how a retry reproduces it.
  assert.doesNotMatch(note, /bitcoin/i);
  assert.match(note, /BLOCKED/);
  assert.match(note, /can't take that one/);
});

test('the note handles several categories at once', () => {
  const note = carrierRiskNote(['cryptocurrency', 'a peer-to-peer cash app']);
  assert.match(note, /cryptocurrency and a peer-to-peer cash app/);
});

test('the standing prompt rule protects real vocabulary explicitly', () => {
  const rule = CARRIER_SAFETY_RULE.join('\n');
  assert.match(rule, /financing/);
  assert.match(rule, /0% APR/);
  assert.match(rule, /receives NOTHING/);
});

// ── safety ─────────────────────────────────────────────────────────

test('empty and non-string input is safe', () => {
  for (const v of ['', null, undefined, 42, {}, []]) {
    assert.deepEqual(carrierRisks(v), []);
    assert.equal(hasCarrierRisk(v), false);
  }
});

test('matching is whole-word, not substring', () => {
  // "btc" inside a longer token must not trip; a lead's street or a product
  // code should never silently cost them a reply.
  assert.equal(hasCarrierRisk('Model ABTCX-12 window'), false);
  assert.equal(hasCarrierRisk('cryptography'), false);
});
