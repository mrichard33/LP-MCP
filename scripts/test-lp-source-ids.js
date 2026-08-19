/**
 * Tests — LP attribution ID registry (src/lp-source-ids.js)
 * scripts/test-lp-source-ids.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-lp-source-ids.js
 *
 * Pure-function tests — no DB, no LP, no network.
 *
 * ═════════════════════════════════════════════════════════════════════
 * WHY THIS GUARD EXISTS, AND WHY IT WAS REWRITTEN 2026-08-18.
 *
 * srs_id (LP SubSource — WHERE the lead came from) and pro_id (LP Promoter
 * — WHO is credited) are trivially transposable and have now been
 * transposed in production TWICE, in OPPOSITE directions.
 *
 * The first version of this file asserted LP_SRS.CHATBOT === '5574' and
 * LP_PRO.CHATBOT === '830'. That is backwards, and because the test
 * asserted it, the test ENFORCED the bug: it passed green for weeks while
 * every chatbot lead reached LP with 5574 in the SubSource slot (resolving
 * to no source and no sourcesubdescr) and 830 in the promoter slot
 * (resolving to a real canvasser, "Godlewski, Paul", who never worked one).
 *
 * The canonical pairing is the Notion "UTM Parameters" database
 * (30a68239-dd72-8081-9867-f10333ef320e):
 *
 *   Chatbot Leads                        srs 830   pro 5574
 *   Estimate Calculator - Landing Page   srs 842   pro 5862
 *   Estimate Calculator - Direct Mail    srs 837   pro 5396
 *   Canvassing Leads                     srs 344   pro (dynamic per canvasser)
 *   Reece Charity Event                  srs 847   pro (none)
 *
 * Independently confirmed against live lp_leads: 830 → "Reece ChatBot",
 * 842 → "Website Estimate Calculator", 344 → "Canvass".
 *
 * THE STRUCTURAL RULE the guard now enforces, which is what a narrow
 * equality check could never catch:
 *   LP SubSource IDs are 3-digit  — 344, 533-545, 830, 837, 842, 847
 *   LP Promoter  IDs are 4-digit  — 5396, 5574, 5686, 5862
 * A 4-digit value in the srs_id slot beside a 3-digit pro_id is a
 * transposition regardless of which channel it came from.
 *
 * IF YOU ARE EDITING THIS FILE because an assertion below fails: check the
 * Notion table before you change the expected value. A test that asserts a
 * wrong constant is worse than no test — it converts a bug into a
 * requirement. That is exactly what happened here.
 * ═════════════════════════════════════════════════════════════════════
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LP_SRS,
  LP_PRO,
  LP_EMP,
  SRS_TO_PRO,
  resolvePromoterForSource,
  assertNotTransposed,
} from '../src/lp-source-ids.js';

test('registry matches the Notion "UTM Parameters" table', () => {
  assert.equal(LP_SRS.CHATBOT, '830', 'SubSource "Reece ChatBot"');
  assert.equal(LP_PRO.CHATBOT, '5574', 'Chatbot channel pseudo-promoter');

  assert.equal(LP_SRS.CALCULATOR_LANDING, '842', 'SubSource "Website Estimate Calculator"');
  assert.equal(LP_PRO.CALCULATOR_LANDING, '5862');

  assert.equal(LP_SRS.CALCULATOR_DIRECTMAIL, '837');
  assert.equal(LP_PRO.CALCULATOR_DIRECTMAIL, '5396');

  assert.equal(LP_SRS.CANVASSING, '344', 'SubSource "Canvass"');
  assert.equal(LP_SRS.CHARITY_EVENT, '847');

  assert.equal(LP_EMP.GHL_INTEGRATION, '5686', '"Integration, GoHighLevel"');
});

test('SubSource IDs are 3-digit and Promoter IDs are 4-digit', () => {
  // This is the invariant that makes the guard work. If a new channel ever
  // breaks it, the guard needs rethinking BEFORE the constant is added.
  for (const [k, v] of Object.entries(LP_SRS)) {
    assert.match(v, /^\d{3}$/, `LP_SRS.${k} should be a 3-digit SubSource ID`);
  }
  for (const [k, v] of Object.entries(LP_PRO)) {
    assert.match(v, /^\d{4}$/, `LP_PRO.${k} should be a 4-digit Promoter ID`);
  }
});

test('canvassing and events carry NO static promoter', () => {
  // Canvassing's promoter is a real, varying human passed per lead — which is
  // why the Notion row's utm_campaign is {{contact.promotor}} rather than a
  // constant. Adding a static one here would credit one person for the whole
  // field team.
  assert.equal(LP_PRO.CANVASSING, undefined);
  assert.equal(LP_PRO.CHARITY_EVENT, undefined);
  assert.equal(SRS_TO_PRO[LP_SRS.CANVASSING], undefined);
  assert.equal(SRS_TO_PRO[LP_SRS.CHARITY_EVENT], undefined);
});

test('resolvePromoterForSource fills the registry pair for digital channels', () => {
  assert.equal(resolvePromoterForSource(LP_SRS.CHATBOT, ''), '5574');
  assert.equal(resolvePromoterForSource(LP_SRS.CALCULATOR_LANDING, ''), '5862');
  assert.equal(resolvePromoterForSource(LP_SRS.CALCULATOR_DIRECTMAIL, ''), '5396');
});

test('an explicitly supplied promoter always wins', () => {
  // Canvassing and events pass the real human per lead. The registry must
  // never override that.
  assert.equal(resolvePromoterForSource(LP_SRS.CANVASSING, '4821'), '4821');
  assert.equal(resolvePromoterForSource(LP_SRS.CHATBOT, '4821'), '4821',
    'even on a digital channel, an explicit value is not second-guessed');
});

test('an unknown source with no promoter yields empty, so the caller omits it', () => {
  assert.equal(resolvePromoterForSource('999', ''), '');
  assert.equal(resolvePromoterForSource(LP_SRS.CANVASSING, ''), '');
  assert.equal(resolvePromoterForSource('', ''), '');
});

test('the correct orientation passes', () => {
  assert.doesNotThrow(() => assertNotTransposed('830', '5574'));
  assert.doesNotThrow(() => assertNotTransposed(LP_SRS.CHATBOT, LP_PRO.CHATBOT));
  assert.doesNotThrow(() => assertNotTransposed(LP_SRS.CALCULATOR_LANDING, LP_PRO.CALCULATOR_LANDING));
  assert.doesNotThrow(() => assertNotTransposed(LP_SRS.CALCULATOR_DIRECTMAIL, LP_PRO.CALCULATOR_DIRECTMAIL));
});

test('the transposed orientation throws, and says so', () => {
  assert.throws(
    () => assertNotTransposed('5574', '830'),
    /transposed/,
    'the error must name the failure mode — it lands in agent_actions.error_message',
  );
});

test('the guard catches EVERY channel transposed, not just chatbot', () => {
  // The old narrow guard hardcoded one pair and therefore caught neither the
  // original bug nor its over-correction. These are the pairs that would have
  // slipped through.
  assert.throws(() => assertNotTransposed('5862', '842'), /transposed/, 'calculator-landing');
  assert.throws(() => assertNotTransposed('5396', '837'), /transposed/, 'calculator-directmail');
  assert.throws(() => assertNotTransposed('5686', '344'), /transposed/, 'setter id in the srs slot');
});

test('the guard is type-agnostic — numbers transpose just as well as strings', () => {
  // Payload values arrive as JSON and can be numeric; String() coercion in the
  // guard is what makes this hold.
  assert.throws(() => assertNotTransposed(5574, 830), /transposed/);
  assert.doesNotThrow(() => assertNotTransposed(830, 5574));
});

test('incomplete or non-numeric pairs are not judged', () => {
  // pro_id is optional, and a missing half tells us nothing. Throwing here
  // would turn a misattribution guard into an outage on legitimate traffic.
  assert.doesNotThrow(() => assertNotTransposed('830', ''));
  assert.doesNotThrow(() => assertNotTransposed('', '5574'));
  assert.doesNotThrow(() => assertNotTransposed('', ''));
  assert.doesNotThrow(() => assertNotTransposed(null, undefined));
  assert.doesNotThrow(() => assertNotTransposed('{{contact.srs}}', '5574'),
    'unresolved merge tokens are not digits — the fallback stage handles those');
});

test('same-width pairs are not judged', () => {
  // Two 3-digit or two 4-digit values may be wrong, but not in a way this
  // guard can prove. Staying narrow here is what keeps it safe to run inline.
  assert.doesNotThrow(() => assertNotTransposed('830', '842'));
  assert.doesNotThrow(() => assertNotTransposed('5574', '5862'));
});
