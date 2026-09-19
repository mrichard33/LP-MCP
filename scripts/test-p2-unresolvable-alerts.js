/**
 * Tests for src/p2-unresolvable-alerts.js
 *
 * The decisions here are the ones that can be SILENTLY wrong: an alarm that
 * fires on the healthy case gets muted, and a boolean that cannot say "I could
 * not tell" announces recoveries nobody earned. Both shapes are pinned below
 * with the live numbers that motivated them (measured 2026-09-19).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldAlertUnresolvableP2,
  formatUnresolvableP2Alert,
  formatUnresolvableP2Recovered,
} from '../src/p2-unresolvable-alerts.js';

/** The live shape on the day this shipped: a big backlog, a quiet window. */
const LIVE = {
  windowDays: 7,
  readOk: true,
  openTotal: 1107,
  unresolvable: 289,
  unresolvableValue: 6732863,
  recent: 0,
  recentValue: 0,
  previousUnresolvable: 289,
};

// ─── The central decision: the backlog is not the alarm ─────────────────────

test('the live 289-opportunity backlog alone is HEALTHY, not an alert', () => {
  // THE WHOLE DESIGN. 289 unresolvable opportunities worth $6.7M is a real
  // problem and it is NOT what this pages on: it would fire every single day
  // and be muted inside a week, which is how a 47-hour outage and a 71-day
  // blind spot both went unnoticed (CLAUDE.md). The backlog is recorded in
  // p2_link_health; the window is what speaks.
  const d = shouldAlertUnresolvableP2(LIVE);
  assert.equal(d.verdict, 'healthy');
  assert.equal(d.alert, false);
  assert.deepEqual(d.reasons, []);
});

test('one NEW unresolvable opportunity inside the window alerts', () => {
  const d = shouldAlertUnresolvableP2({ ...LIVE, unresolvable: 290, recent: 1, recentValue: 15298 });
  assert.equal(d.verdict, 'alert');
  assert.equal(d.alert, true);
  assert.match(d.reasons[0], /1 P2 opportunity created in the last 7d/);
});

test('the window threshold is a floor, not a tuning knob', () => {
  // Measured 0 over 7 days and 1 over 30. A threshold above zero would be
  // raising the bar until the alarm stops crying wolf, which is exactly the
  // move CLAUDE.md names as the cause of both blind spots. Pinned so nobody
  // "quiets" it later without changing this test and reading why.
  assert.equal(shouldAlertUnresolvableP2({ ...LIVE, recent: 1 }).alert, true);
});

test('plural vs singular in the reason line', () => {
  const one = shouldAlertUnresolvableP2({ ...LIVE, recent: 1 });
  const many = shouldAlertUnresolvableP2({ ...LIVE, recent: 4 });
  assert.match(one.reasons[0], /1 P2 opportunity created/);
  assert.match(many.reasons[0], /4 P2 opportunities created/);
});

// ─── Rule 2: the backlog may not GROW silently ──────────────────────────────

test('backlog growth beyond tolerance alerts even with an empty window', () => {
  // The case rule 1 CANNOT see: a regression that strands opportunities whose
  // date_added is months old (a contact merge, a relink that dropped, a bulk
  // import). Their window count stays 0 forever while the pile climbs.
  const d = shouldAlertUnresolvableP2({
    ...LIVE, recent: 0, unresolvable: 340, previousUnresolvable: 289,
  });
  assert.equal(d.verdict, 'alert');
  assert.equal(d.growth, 51);
  assert.match(d.reasons[0], /backlog grew by 51 \(289 → 340\)/);
});

test('small backlog movement is tolerated, not paged', () => {
  // Opportunities open and close for reasons that have nothing to do with
  // linking. A card for ±2 is noise, and noise is what gets an alarm muted.
  const d = shouldAlertUnresolvableP2({ ...LIVE, unresolvable: 291, previousUnresolvable: 289 });
  assert.equal(d.verdict, 'healthy');
  assert.equal(d.growth, 2);
});

test('a SHRINKING backlog is never an alert', () => {
  const d = shouldAlertUnresolvableP2({ ...LIVE, unresolvable: 210, previousUnresolvable: 289 });
  assert.equal(d.verdict, 'healthy');
  assert.equal(d.growth, -79);
});

test('both rules can fire at once and both are reported', () => {
  const d = shouldAlertUnresolvableP2({
    ...LIVE, recent: 3, unresolvable: 400, previousUnresolvable: 289,
  });
  assert.equal(d.reasons.length, 2);
  assert.match(d.reasons[0], /created in the last 7d/);
  assert.match(d.reasons[1], /backlog grew/);
});

test('thresholds are overridable per call', () => {
  const sample = { ...LIVE, recent: 3, unresolvable: 300, previousUnresolvable: 289 };
  const d = shouldAlertUnresolvableP2(sample, { windowThreshold: 5, growthThreshold: 50 });
  assert.equal(d.verdict, 'healthy');
});

// ─── The three-way verdict ──────────────────────────────────────────────────

test('a failed read is insufficient_evidence, never healthy', () => {
  // Clearing on "I could not tell" announces a recovery nobody earned.
  const d = shouldAlertUnresolvableP2({
    ...LIVE, readOk: false, unresolvable: null, recent: null,
  });
  assert.equal(d.verdict, 'insufficient_evidence');
  assert.equal(d.alert, false);
});

test('an uncountable cohort is insufficient_evidence even when readOk is true', () => {
  // readOk is the caller's own flag; the counts are the evidence. If the
  // numbers are not there, the verdict cannot be healthy whatever the flag says.
  assert.equal(
    shouldAlertUnresolvableP2({ ...LIVE, unresolvable: null }).verdict,
    'insufficient_evidence',
  );
  assert.equal(
    shouldAlertUnresolvableP2({ ...LIVE, recent: null }).verdict,
    'insufficient_evidence',
  );
});

test('a confirmed alert is reported even when some other read failed', () => {
  // Incompleteness blocks the ALL-CLEAR, never the alarm. A leak is a leak
  // whether or not something else failed to read.
  const d = shouldAlertUnresolvableP2({ ...LIVE, readOk: false, recent: 2 });
  assert.equal(d.verdict, 'alert');
});

test('a missing previous snapshot disables the growth rule, not the pass', () => {
  // The very first run has no predecessor. A monitor that reported
  // insufficient_evidence until it had one would never deliver its first
  // all-clear — and the first all-clear is what proves the wiring works.
  const d = shouldAlertUnresolvableP2({ ...LIVE, previousUnresolvable: null });
  assert.equal(d.verdict, 'healthy');
  assert.equal(d.growth, null);
});

test('zero is a real count, not a missing one', () => {
  // The falsy trap. `!0` is true, so a naive presence check reads a healthy
  // zero as an unreadable null and files insufficient_evidence forever.
  const d = shouldAlertUnresolvableP2({
    ...LIVE, unresolvable: 0, unresolvableValue: 0, recent: 0, previousUnresolvable: 0,
  });
  assert.equal(d.verdict, 'healthy');
});

// ─── The cards ──────────────────────────────────────────────────────────────

test('the alert card leads with the window and carries the backlog as context', () => {
  const sample = { ...LIVE, recent: 2, recentValue: 31000, unresolvable: 291 };
  const text = formatUnresolvableP2Alert(sample, shouldAlertUnresolvableP2(sample).reasons);
  assert.match(text, /last 7d : 2 opportunities {2}\$31,000/);
  assert.match(text, /backlog {2}: 291 of 1107 open {2}\$6,732,863/);
  // The reader needs the next action in the card, not in someone's memory.
  assert.match(text, /repair-lp-ghl-links\.js/);
});

test('the alert card renders an unreadable number as ? rather than NaN', () => {
  const text = formatUnresolvableP2Alert(
    { windowDays: 7, recent: 3, recentValue: null, unresolvable: null, openTotal: null },
    ['something'],
  );
  assert.match(text, /\$\?/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('the recovery card is short and states the steady backlog', () => {
  const text = formatUnresolvableP2Recovered(LIVE);
  assert.match(text, /^✅/);
  assert.match(text, /0 new in the last 7d/);
  assert.match(text, /backlog steady at 289/);
});
