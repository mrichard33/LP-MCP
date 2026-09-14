/**
 * test-rule-fail-closed-alerts.js — 2026-09-12
 *
 * Covers src/rule-fail-closed-alerts.js, the watchdog that finally reads
 * rule.condition_failed_closed. The module is pure, so these run with no
 * supabase/groupme graph — same shape as test-agentic-silence-alerts.js.
 *
 * The two properties that matter, and why:
 *   - an unimplemented/malformed condition pages at ANY volume (the rule cannot
 *     fire at all; EMAIL_ENRICH_FROM_LP was dead for 1,970 evaluations)
 *   - 'contact has no LP record' never pages (the gate is working), because an
 *     alarm that fires on the healthy case gets muted — the stated lesson from
 *     the agentic-silence watchdog.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFailClosedDetail,
  summarizeFailClosed,
  shouldAlertFailClosed,
  formatFailClosedAlert,
} from '../src/rule-fail-closed-alerts.js';

const row = (rule_key, detail, ghl_contact_id = 'c1') => ({ rule_key, detail, ghl_contact_id });

// ── classification ──────────────────────────────────────────────────

test('classify: unimplemented / malformed conditions are authoring faults', () => {
  assert.equal(classifyFailClosedDetail('unknown condition operator'), 'authoring');
  assert.equal(
    classifyFailClosedDetail('malformed spec — expected {field, values: [...]}'),
    'authoring',
  );
});

test('classify: broken reads are infra', () => {
  assert.equal(classifyFailClosedDetail('contact tags unreadable'), 'infra');
  assert.equal(classifyFailClosedDetail('appointment lookup unavailable'), 'infra');
  assert.equal(classifyFailClosedDetail('lp_leads lookup failed: schema cache'), 'infra');
});

test('classify: "no LP record" is the gate working, not a fault', () => {
  assert.equal(
    classifyFailClosedDetail('contact has no LP record — disposition gate cannot pass'),
    'expected',
  );
});

test('classify: an untaught detail counts as infra, never as fine', () => {
  assert.equal(classifyFailClosedDetail('some detail nobody has triaged'), 'infra');
  assert.equal(classifyFailClosedDetail(null), 'infra');
});

// ── summarize ───────────────────────────────────────────────────────

test('summarize: counts per class, distinct contacts, ranked offenders', () => {
  const s = summarizeFailClosed([
    row('R_DEAD', 'unknown condition operator', 'c1'),
    row('R_DEAD', 'unknown condition operator', 'c2'),
    row('R_TAGS', 'contact tags unreadable', 'c1'),
    row('R_OK', 'contact has no LP record — disposition gate cannot pass', 'c3'),
  ], 6);

  assert.equal(s.authoring, 2);
  assert.equal(s.infra, 1);
  assert.equal(s.expected, 1);
  assert.equal(s.total, 4);
  assert.equal(s.contacts, 3);
  assert.equal(s.windowHours, 6);
  assert.equal(s.topOffenders[0].ruleKey, 'R_DEAD');
  assert.equal(s.topOffenders[0].count, 2);
  assert.ok(
    !s.topOffenders.some(o => o.ruleKey === 'R_OK'),
    'expected-class rows are context, never ranked as offenders',
  );
});

test('summarize: empty window is healthy, not unknown', () => {
  const s = summarizeFailClosed([], 6);
  assert.equal(s.total, 0);
  assert.equal(s.authoring, 0);
  assert.deepEqual(s.topOffenders, []);
});

// ── alert decision ──────────────────────────────────────────────────

test('one dead-rule suppression pages (volume is not the point)', () => {
  const s = summarizeFailClosed([row('R_DEAD', 'unknown condition operator')], 6);
  const d = shouldAlertFailClosed(s, { infraThreshold: 25 });
  assert.equal(d.alert, true);
  assert.equal(d.critical, true);
  assert.equal(d.verdict, 'alert');
  assert.match(d.reasons[0], /cannot fire as written/);
});

test('infra suppressions page only past the threshold', () => {
  const under = summarizeFailClosed(
    Array.from({ length: 25 }, (_, i) => row('R_TAGS', 'contact tags unreadable', `c${i}`)), 6,
  );
  assert.equal(shouldAlertFailClosed(under, { infraThreshold: 25 }).alert, false);
  assert.equal(shouldAlertFailClosed(under, { infraThreshold: 25 }).verdict, 'healthy');

  const over = summarizeFailClosed(
    Array.from({ length: 26 }, (_, i) => row('R_TAGS', 'contact tags unreadable', `c${i}`)), 6,
  );
  const d = shouldAlertFailClosed(over, { infraThreshold: 25 });
  assert.equal(d.alert, true);
  assert.equal(d.critical, false, 'a read outage is urgent but not a dead rule');
});

test('a flood of "no LP record" never pages (the muted-alarm lesson)', () => {
  const s = summarizeFailClosed(
    Array.from({ length: 500 }, (_, i) =>
      row('BEHAVIORAL_PRICE_OBJECTION', 'contact has no LP record — disposition gate cannot pass', `c${i}`)), 6,
  );
  const d = shouldAlertFailClosed(s, { infraThreshold: 25 });
  assert.equal(d.alert, false);
  assert.equal(d.verdict, 'healthy');
});

test('an unreadable window is insufficient_evidence — never pages, never clears', () => {
  const d = shouldAlertFailClosed(null, { infraThreshold: 25 });
  assert.equal(d.alert, false);
  assert.equal(d.verdict, 'insufficient_evidence');
  assert.notEqual(d.verdict, 'healthy', 'a failed read must not announce a recovery');
});

// ── message body ────────────────────────────────────────────────────

test('alert body names the offending rules and flags suppression gates', () => {
  const s = summarizeFailClosed([
    row('DNC_LIFT_ON_REENGAGEMENT_LP', 'contact tags unreadable', 'c1'),
    row('R_OK', 'contact has no LP record — disposition gate cannot pass', 'c2'),
  ], 6);
  const body = formatFailClosedAlert(s, ['1 gate skipped']);
  assert.match(body, /DNC_LIFT_ON_REENGAGEMENT_LP/, 'an operator must not need SQL to know which rule');
  assert.match(body, /contact tags unreadable ×1/);
  assert.match(body, /1 more excluded/, 'expected-class rows appear as context');
  assert.match(body, /skipped blind/);
});
