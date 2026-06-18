/**
 * scripts/test-intent-classifier-bypass.js
 *
 * Unit coverage for the #75 fix: shouldBypassAffirmativeGate() must yield the
 * CALLBACK / CUSTOMER_STATUS_NEGATIVE gates for appointment-confirmed and
 * objection-handling contacts, while leaving first-touch unknowns and the
 * separate CUSTOMER_STATUS_AFFIRMATIVE path unchanged.
 *
 * Pure-function test — no Supabase, no LLM. Run: node scripts/test-intent-classifier-bypass.js
 */

import { shouldBypassAffirmativeGate } from '../src/knowledge/intent-classifier.js';

const h = (intent_class) => ({ intent_class });

const cases = [
  // ── Surface B (CALLBACK / CUSTOMER_STATUS_NEGATIVE): new appointment-confirmed tags ──
  { name: 'NEGATIVE + stage:booking-main bypasses (Mark Test repro)', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: ['stage:booking-main', 'agentic-active'], expect: true },
  { name: 'NEGATIVE + lp-appt-set bypasses', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: ['lp-appt-set'], expect: true },
  { name: 'NEGATIVE + lp-lead-confirmed bypasses', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: ['lp-lead-confirmed', 'agentic-active'], expect: true },
  { name: 'NEGATIVE + lp-lead-issued bypasses', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: ['lp-lead-issued'], expect: true },
  { name: 'CALLBACK + stage:post-appointment bypasses', handler: h('CALLBACK'), tags: ['stage:post-appointment'], expect: true },
  // ── Surface B: objection-confirmed-* prefix ──
  { name: 'NEGATIVE + objection-confirmed-competitor bypasses', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: ['objection-confirmed-competitor'], expect: true },
  // ── Surface B: existing active-booking tags still work ──
  { name: 'NEGATIVE + booking:active bypasses (existing)', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: ['booking:active'], expect: true },

  // ── First-touch unknowns: gate must still fire (no bypass) ──
  { name: 'NEGATIVE + no tags does NOT bypass', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: [], expect: false },
  { name: 'NEGATIVE + only agentic-active does NOT bypass', handler: h('CUSTOMER_STATUS_NEGATIVE'), tags: ['agentic-active'], expect: false },

  // ── Compliance gates not in the bypass set: never bypass ──
  { name: 'STOP + stage:booking-main does NOT bypass', handler: h('STOP'), tags: ['stage:booking-main'], expect: false },
  { name: 'WRONG_NUMBER + lp-appt-set does NOT bypass', handler: h('WRONG_NUMBER'), tags: ['lp-appt-set'], expect: false },

  // ── CUSTOMER_STATUS_AFFIRMATIVE: SEPARATE path (BYPASS_TAGS_EXACT/PREFIX), NOT BOOKING_ACTIVE_TAGS ──
  // INTENDED, NOT A BUG: stage:booking-main is only in BOOKING_ACTIVE_TAGS (which gates the
  // CALLBACK / CUSTOMER_STATUS_NEGATIVE Surface B path). It is deliberately NOT the same as
  // booking:active, so it must NOT trigger the affirmative bypass. The false below is correct.
  { name: 'AFFIRMATIVE + stage:booking-main does NOT bypass (separate tag set — intended)', handler: h('CUSTOMER_STATUS_AFFIRMATIVE'), tags: ['stage:booking-main'], expect: false },
  // Contrast: the affirmative path still works on ITS OWN tag set (booking:active is in BYPASS_TAGS_EXACT).
  { name: 'AFFIRMATIVE + booking:active bypasses (own tag set)', handler: h('CUSTOMER_STATUS_AFFIRMATIVE'), tags: ['booking:active'], expect: true },
  { name: 'AFFIRMATIVE + lp-demo-completed bypasses (own tag set)', handler: h('CUSTOMER_STATUS_AFFIRMATIVE'), tags: ['lp-demo-completed'], expect: true },
];

let failed = 0;
for (const c of cases) {
  const got = shouldBypassAffirmativeGate(c.handler, c.tags);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
