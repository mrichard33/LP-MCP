/**
 * Backstop notification card — scripts/test-backstop-notify.js
 *
 * Covers:
 *   src/services/backstop-notify.js  — summarizeSources (addendum §B1)
 *   src/services/backstop-insight.js — cleanInsight, buildUserPrompt,
 *                                      generateBackstopInsight kill-switch
 *   src/llm-client.js                — backstop_insight fn registration (§C1)
 *
 * NO LIVE MODEL CALLS. generateBackstopInsight is exercised only through
 * LP_BACKSTOP_INSIGHT=off; the prompt itself is asserted against
 * _internal.buildUserPrompt.
 *
 * Cases 1-11 cover the exception gate and severity computation; 16, 17 and
 * 22 cover buildBackstopCard. Numbering follows the addendum.
 *
 * buildBackstopCard is synchronous and takes `insight` as a parameter, so
 * every card assertion here runs without a model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeSources,
  classifyRun,
  shouldNotify,
  buildBackstopCard,
  notifyBackstopRun,
  notifyBackstopFailure,
  __resetCooldowns,
  MAX_DETAIL_LEADS,
} from '../src/services/backstop-notify.js';
import { cleanInsight, generateBackstopInsight, INSIGHT_CHAR_CAP, _internal } from '../src/services/backstop-insight.js';
import { resolveLLM, FUNCTION_GROUPS } from '../src/llm-client.js';
import { __setAlertStateClientForTests } from '../src/alert-state.js';
import { mockAlertConditions } from './fixtures/alert-conditions-mock.js';

// No live model calls anywhere in this file.
process.env.LP_BACKSTOP_INSIGHT = 'off';

/**
 * Binds the alert layer to an in-memory alert_conditions table and captures
 * what would have gone to GroupMe. Pass an existing `rows` Map to model a
 * REDEPLOY: fresh process state, same durable table.
 *
 * The send is injected rather than stubbed on the module — ES module bindings
 * are read-only, so notifyBackstopRun/Failure take a `send` for exactly this.
 */
function backstopHarness({ rows = new Map() } = {}) {
  const sent = [];
  __setAlertStateClientForTests(mockAlertConditions(rows));
  __resetCooldowns();
  return {
    sent,
    rows,
    send: async (text) => { sent.push(text); return { sent: true }; },
    restore() {
      __setAlertStateClientForTests(null);
      __resetCooldowns();
    },
  };
}

const lead = (over = {}) => ({
  action: 'created',
  name: 'Test Lead',
  lp_lead_id: '1001',
  contact_id: 'c-1',
  lead_source: 'Internet',
  lead_source_detail: 'Modernize',
  ...over,
});

/** Run a body with env vars forced, restoring them afterwards. */
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ─── §A classifyRun ──────────────────────────────────────────────────

test('(1) clean run with no deferrals → healthy', () => {
  const out = classifyRun({ counts: { created: 1, error: 0 }, scan: { deferredCapped: 0 } });
  assert.equal(out.severity, 'healthy');
  assert.equal(out.reason, 'clean_run');
});

// 2026-08-23 (#292/#291): errors still outrank backlog, but only once they
// clear the AGGREGATE bar (>=3 errors AND >20% of processed). A run failing 2
// of 5 leads used to be 'failing'; during the #222 drain that shape fires every
// 15 minutes forever. Below the bar the run is silent and the leads live in
// lp_sync_errors instead — see persistSweepErrors().
test('(2) errors outrank backlog when they clear the aggregate bar', () => {
  const out = classifyRun({ counts: { created: 3, error: 4 }, scan: { deferredCapped: 40, processed: 10 } });
  assert.equal(out.severity, 'failing', 'errored leads are the more actionable fact');
  assert.equal(out.reason, 'lead_error_rate');
  assert.equal(out.errorRate, 0.4);
});

test('(2b) errors under the aggregate bar are silent, not failing', () => {
  // 2 of 5 = 40% rate, but only 2 errors — under the 3-error floor.
  const fewErrors = classifyRun({ counts: { created: 3, error: 2 }, scan: { processed: 5 } });
  assert.equal(fewErrors.severity, 'healthy');
  assert.equal(fewErrors.reason, 'errors_below_threshold');
  assert.equal(fewErrors.errorCount, 2, 'still counted, just not alerted');

  // 4 errors clears the floor but 4/100 = 4% is under the 20% rate bar. This is
  // the drain shape: a few unavoidable transient GHL failures in a large run.
  const lowRate = classifyRun({ counts: { created: 96, error: 4 }, scan: { processed: 100 } });
  assert.equal(lowRate.severity, 'healthy');
  assert.equal(lowRate.reason, 'errors_below_threshold');

  // Backlog still wins over sub-threshold errors — it is the louder fact then.
  const withBacklog = classifyRun({ counts: { error: 2 }, scan: { deferredCapped: 40, processed: 5 } });
  assert.equal(withBacklog.severity, 'degraded');
});

test('(2c) a run that processed nothing but errored is 100%, not 0%', () => {
  const out = classifyRun({ counts: { error: 3 }, scan: { processed: 0 } });
  assert.equal(out.errorRate, 1);
  assert.equal(out.severity, 'failing');
});

test('(3) zero errors with deferrals at/over the threshold → degraded', () => {
  assert.equal(classifyRun({ counts: { error: 0 }, scan: { deferredCapped: 1 } }).severity, 'degraded');
  assert.equal(classifyRun({ counts: { error: 0 }, scan: { deferredCapped: 99 } }).severity, 'degraded');
  // Threshold is configurable — 3 deferred is healthy when the bar is 5.
  withEnv({ LP_BACKSTOP_DEFER_ALERT_THRESHOLD: '5' }, () => {
    assert.equal(classifyRun({ counts: { error: 0 }, scan: { deferredCapped: 3 } }).severity, 'healthy');
    assert.equal(classifyRun({ counts: { error: 0 }, scan: { deferredCapped: 5 } }).severity, 'degraded');
  });
});

test('(4) no arguments at all → healthy, never throws', () => {
  assert.equal(classifyRun().severity, 'healthy');
  assert.equal(classifyRun({}).severity, 'healthy');
});

// ─── §A shouldNotify ─────────────────────────────────────────────────

test('(5) healthy is silent under the default (exception) mode', () => {
  __resetCooldowns();
  const out = shouldNotify({ severity: 'healthy', sweepMode: 'appointment' });
  assert.equal(out.send, false);
  assert.equal(out.reason, 'clean_run');
});

test('(6) LP_BACKSTOP_NOTIFY_MODE=all sends even a healthy run', () => {
  __resetCooldowns();
  withEnv({ LP_BACKSTOP_NOTIFY_MODE: 'all' }, () => {
    const out = shouldNotify({ severity: 'healthy', sweepMode: 'appointment' });
    assert.equal(out.send, true);
    assert.equal(out.reason, 'notify_all');
  });
});

test('(7) LP_BACKSTOP_NOTIFY_MODE=off silences every severity', () => {
  __resetCooldowns();
  withEnv({ LP_BACKSTOP_NOTIFY_MODE: 'off' }, () => {
    for (const severity of ['healthy', 'degraded', 'failing']) {
      const out = shouldNotify({ severity, sweepMode: 'appointment' });
      assert.equal(out.send, false, `${severity} must be silent when notifications are off`);
      assert.equal(out.reason, 'notify_off');
    }
  });
});

// 2026-09-05 (follow-on to PR #845). shouldNotify used to MUTATE a cooldown Map
// as a side effect of being asked a question, and the tests below asserted that
// side effect. That was the bug: a cooldown lapsing while the backlog was still
// there re-announced it, and every redeploy wiped the Map and re-announced
// everything at once. Debouncing now lives in alert_conditions, keyed on the
// condition rather than on elapsed time, so these assert the two halves
// separately — a pure policy gate, and a durable edge trigger.

test('(8) shouldNotify is PURE — it answers the same way however often it is asked', () => {
  const first = shouldNotify({ severity: 'degraded', sweepMode: 'appointment' });
  assert.equal(first.send, true);
  assert.equal(first.reason, 'backlog_pressure');
  assert.equal(first.kind, 'backlog', 'names the condition row the caller reports against');

  // Ten more asks must not change the answer. The old gate said "no" from the
  // second call onward, which is why callers could never ask twice.
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(shouldNotify({ severity: 'degraded', sweepMode: 'appointment' }), first);
  }
  assert.equal(shouldNotify({ severity: 'failing', sweepMode: 'appointment' }).kind, 'errors');
  assert.equal(shouldNotify({ severity: 'healthy', sweepMode: 'appointment' }).kind, null);
});

test('(9) N consecutive failing runs produce ONE card', async () => {
  const h = backstopHarness();
  const run = () => notifyBackstopRun({
    sweepMode: 'appointment', counts: { error: 9 }, scan: { processed: 10 }, send: h.send,
  });

  const first = await run();
  assert.equal(first.sent, true, 'the first failing run must alert');
  assert.equal(first.severity, 'failing');

  // The #222 drain: a sweep every 15 minutes, each with the same failure shape.
  for (let i = 0; i < 9; i++) {
    const next = await run();
    assert.equal(next.sent, false, `failing run ${i + 2} is the same ongoing condition`);
  }
  assert.equal(h.sent.length, 1, 'one continuous failure is one card');

  // A different sweep mode is a different condition and alerts on its own.
  const intake = await notifyBackstopRun({
    sweepMode: 'intake', counts: { error: 9 }, scan: { processed: 10 }, send: h.send,
  });
  assert.equal(intake.sent, true);
  assert.equal(h.sent.length, 2);
  h.restore();
});

test('(9b) time passing does NOT re-announce, but a recovery-then-relapse does', async () => {
  const h = backstopHarness();
  const failing = () => notifyBackstopRun({
    sweepMode: 'intake', counts: { error: 9 }, scan: { processed: 10 }, send: h.send,
  });

  assert.equal((await failing()).sent, true);
  // Six hours of the same failure — far past the old 60-minute error cooldown,
  // which is exactly when the old code re-announced. It must stay silent.
  for (let i = 0; i < 24; i++) assert.equal((await failing()).sent, false);
  assert.equal(h.sent.length, 1);

  // A clean run is the resolving edge; the next failure is a NEW incident.
  const healthy = await notifyBackstopRun({
    sweepMode: 'intake', counts: {}, scan: { processed: 10 }, send: h.send,
  });
  assert.equal(healthy.sent, false, 'a clean run is silent');
  assert.equal((await failing()).sent, true, 'a relapse after a recovery is a new incident');
  assert.equal(h.sent.length, 2);
  h.restore();
});

test('(9c) error and backlog are independent conditions', async () => {
  const h = backstopHarness();
  assert.equal((await notifyBackstopRun({
    sweepMode: 'appointment', counts: { error: 9 }, scan: { processed: 10 }, send: h.send,
  })).sent, true);
  // A failing alert must not consume the backlog budget for the same mode.
  const backlog = await notifyBackstopRun({
    sweepMode: 'appointment', counts: {}, scan: { processed: 10, deferredCapped: 5 }, send: h.send,
  });
  assert.equal(backlog.sent, true);
  assert.equal(backlog.severity, 'degraded');
  h.restore();
});

test('(10) a chronic backlog is one card, and a redeploy does not re-announce it', async () => {
  const rows = new Map();
  const h = backstopHarness({ rows });
  const degraded = (send) => notifyBackstopRun({
    sweepMode: 'intake', counts: {}, scan: { processed: 10, deferredCapped: 5 }, send,
  });

  assert.equal((await degraded(h.send)).sent, true);
  for (let i = 0; i < 20; i++) assert.equal((await degraded(h.send)).sent, false);
  assert.equal(h.sent.length, 1);
  h.restore();

  // A redeploy: fresh process state, same table. The condition is still open,
  // so it must stay silent rather than announcing itself all over again.
  const after = backstopHarness({ rows });
  assert.equal((await degraded(after.send)).sent, false, 'a restart must not re-announce a live condition');
  assert.equal(after.sent.length, 0);
  after.restore();
});

test('(10b) LP_BACKSTOP_NOTIFY_MODE=off INHIBITS — it must not clear open conditions', async () => {
  const h = backstopHarness();
  const failing = (send) => notifyBackstopRun({
    sweepMode: 'intake', counts: { error: 9 }, scan: { processed: 10 }, send,
  });
  assert.equal((await failing(h.send)).sent, true);

  // Turning notifications off is not a statement that the sweep got healthy.
  // Treating it as one would resolve every open condition here and re-announce
  // all of them the moment somebody turned notifications back on.
  //
  // withEnv is synchronous — it would restore the variable at the first await —
  // so this sets and restores around the awaits itself.
  const prev = process.env.LP_BACKSTOP_NOTIFY_MODE;
  process.env.LP_BACKSTOP_NOTIFY_MODE = 'off';
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await failing(h.send)).sent, false, 'off means silent');
    }
  } finally {
    if (prev === undefined) delete process.env.LP_BACKSTOP_NOTIFY_MODE;
    else process.env.LP_BACKSTOP_NOTIFY_MODE = prev;
  }
  assert.equal(h.rows.get('backstop:intake:errors').state, 'firing',
    'an inhibited sweep must not resolve a live condition');

  assert.equal((await failing(h.send)).sent, false, 'still the same incident once alerts come back');
  assert.equal(h.sent.length, 1);
  h.restore();
});

test('(11) a sweep that never completes alerts once per outage, whatever the error text', async () => {
  const h = backstopHarness();
  assert.equal((await notifyBackstopFailure({ sweepMode: 'intake', error: new Error('ETIMEDOUT'), send: h.send })).sent, true);
  // A crash loop reporting a DIFFERENT message each cycle is still ONE outage.
  // Keying on the text is what made one dead campaign read as three problems.
  assert.equal((await notifyBackstopFailure({ sweepMode: 'intake', error: new Error('ECONNRESET'), send: h.send })).sent, false);
  assert.equal((await notifyBackstopFailure({ sweepMode: 'intake', error: new Error('502 Bad Gateway'), send: h.send })).sent, false);
  assert.equal(h.sent.length, 1);

  // A sweep that runs to completion is the only evidence the loop has ended.
  await notifyBackstopRun({ sweepMode: 'intake', counts: {}, scan: { processed: 10 }, send: h.send });
  assert.equal((await notifyBackstopFailure({ sweepMode: 'intake', error: new Error('ETIMEDOUT'), send: h.send })).sent, true);
  assert.equal(h.sent.length, 2);
  h.restore();
});

// ─── §B1 summarizeSources ────────────────────────────────────────────

test('(12) single distinct source → parent + detail passed through', () => {
  const out = summarizeSources([
    lead({ lp_lead_id: '1' }),
    lead({ lp_lead_id: '2', action: 'linked' }),
    lead({ lp_lead_id: '3' }),
  ]);
  assert.deepEqual(out, { lpSource: 'Internet', lpSourceDetail: 'Modernize' });
});

test('(13) mixed sources → joined summary with counts, no detail', () => {
  const out = summarizeSources([
    lead({ lp_lead_id: '1' }),
    lead({ lp_lead_id: '2' }),
    lead({ lp_lead_id: '3', lead_source: 'Iheart', lead_source_detail: 'Simpletext' }),
  ]);
  assert.equal(out.lpSourceDetail, undefined, 'mixed runs must not pass a subsource');
  assert.match(out.lpSource, /Internet > Modernize \(2\)/);
  assert.match(out.lpSource, /Iheart > Simpletext \(1\)/);
  // Most frequent first.
  assert.ok(
    out.lpSource.indexOf('Internet > Modernize') < out.lpSource.indexOf('Iheart > Simpletext'),
    'sources must be ranked by count descending',
  );
});

test('(13b) more than three distinct sources → top 3 plus "+N more"', () => {
  const out = summarizeSources([
    lead({ lead_source: 'A', lead_source_detail: null }),
    lead({ lead_source: 'A', lead_source_detail: null }),
    lead({ lead_source: 'B', lead_source_detail: null }),
    lead({ lead_source: 'C', lead_source_detail: null }),
    lead({ lead_source: 'D', lead_source_detail: null }),
    lead({ lead_source: 'E', lead_source_detail: null }),
  ]);
  assert.match(out.lpSource, /A \(2\)/);
  assert.match(out.lpSource, /\+2 more$/, 'tail beyond the top 3 must be counted, not dropped');
});

test('(14) null sources → "Unknown", never undefined or empty', () => {
  const out = summarizeSources([
    lead({ lead_source: null, lead_source_detail: null }),
    lead({ lead_source: '', lead_source_detail: '   ' }),
  ]);
  assert.equal(out.lpSource, 'Unknown');
  assert.notEqual(out.lpSource, undefined);
  assert.notEqual(out.lpSource, '');
  assert.equal(out.lpSourceDetail, undefined);
});

test('(15) no touched leads → both fields undefined (card renders Unknown)', () => {
  assert.deepEqual(summarizeSources([]), { lpSource: undefined, lpSourceDetail: undefined });
  // Untouched outcomes are not "touched" — no-phone rows must not set source.
  assert.deepEqual(
    summarizeSources([{ action: undefined, outcome: 'skipped_no_phone', lead_source: 'Internet' }]),
    { lpSource: undefined, lpSourceDetail: undefined },
  );
  assert.deepEqual(summarizeSources(), { lpSource: undefined, lpSourceDetail: undefined });
});

test('(15b) errors are a fallback only — never override touched leads', () => {
  const errs = [{ lp_lead_id: '9', error: 'boom', lead_source: 'Iheart', lead_source_detail: 'Simpletext' }];

  // Nothing touched → fall back to the errored leads' sources.
  assert.deepEqual(
    summarizeSources([], errs),
    { lpSource: 'Iheart', lpSourceDetail: 'Simpletext' },
  );

  // Something touched → errors are ignored entirely.
  assert.deepEqual(
    summarizeSources([lead({ lp_lead_id: '1' })], errs),
    { lpSource: 'Internet', lpSourceDetail: 'Modernize' },
  );

  // Single-argument calls keep the pre-existing contract exactly.
  assert.deepEqual(summarizeSources([]), { lpSource: undefined, lpSourceDetail: undefined });
  assert.deepEqual(summarizeSources([], []), { lpSource: undefined, lpSourceDetail: undefined });
});

// ─── §C cleanInsight ─────────────────────────────────────────────────

test('(18) strips surrounding quotes, leading bullets and markdown bold', () => {
  assert.equal(cleanInsight('"Modernize dominates this run."'), 'Modernize dominates this run.');
  assert.equal(cleanInsight('- Modernize dominates this run.'), 'Modernize dominates this run.');
  assert.equal(cleanInsight('**Modernize** dominates this run.'), 'Modernize dominates this run.');
  assert.equal(cleanInsight('• **Modernize** dominates.'), 'Modernize dominates.');
  assert.equal(cleanInsight('```\nfenced\n```Modernize dominates.'), 'Modernize dominates.');
});

test('(19) truncates past INSIGHT_CHAR_CAP with a trailing ellipsis', () => {
  const long = 'Lead flow observation for this run. '.repeat(30);
  const out = cleanInsight(long);
  assert.ok(out.length <= INSIGHT_CHAR_CAP, `expected <= ${INSIGHT_CHAR_CAP}, got ${out.length}`);
  assert.ok(out.endsWith('…'), 'truncated text must end with an ellipsis');
  // Short text is left exactly alone.
  assert.equal(cleanInsight('Short read.'), 'Short read.');
});

test('(20) empty and whitespace-only input → null', () => {
  assert.equal(cleanInsight(''), null);
  assert.equal(cleanInsight('   '), null);
  assert.equal(cleanInsight(null), null);
  assert.equal(cleanInsight(undefined), null);
});

test('(21) routes through sanitizeNarrative — forbidden language cannot survive', () => {
  const out = cleanInsight('This run hit a buggy fallthrough on three leads.');
  assert.ok(!/buggy/i.test(out), `"buggy" survived: ${out}`);
  assert.ok(!/fallthrough/i.test(out), `"fallthrough" survived: ${out}`);
  assert.match(out, /unhandled branch/);
});

// ─── §C buildUserPrompt ──────────────────────────────────────────────

test('(23) buildUserPrompt carries every touched lead source and every error', () => {
  const prompt = _internal.buildUserPrompt({
    sweepMode: 'intake',
    severity: 'degraded',
    counts: { created: 2, linked: 1, error: 2, skipped_no_phone: 1, skipped_dnc: 0 },
    scan: { eligible: 9, deferredCapped: 4 },
    maxPerRun: 25,
    results: [
      lead({ lead_source: 'Internet', lead_source_detail: 'Modernize' }),
      lead({ lead_source: 'Iheart', lead_source_detail: 'Simpletext', action: 'linked' }),
      lead({ lead_source: null, lead_source_detail: null, suppressed: true }),
      { action: undefined, outcome: 'skipped_no_phone', lead_source: 'Excluded' },
    ],
    errors: [
      { lp_lead_id: '5001', error: 'GHL 429 rate limited' },
      { lp_lead_id: '5002', error: 'no_contact_id_after_create' },
    ],
  });

  assert.match(prompt, /SWEEP_MODE: intake/);
  assert.match(prompt, /SEVERITY: degraded/);
  assert.match(prompt, /Internet > Modernize \| created/);
  assert.match(prompt, /Iheart > Simpletext \| linked/);
  assert.match(prompt, /Unknown \| created \| suppressed/);
  assert.ok(!prompt.includes('Excluded'), 'untouched leads must not reach the prompt');
  assert.match(prompt, /lead 5001: GHL 429 rate limited/);
  assert.match(prompt, /lead 5002: no_contact_id_after_create/);
  assert.match(prompt, /deferred_by_cap: 4 \(cap 25\)/);
});

test('(24) buildUserPrompt renders the empty cases without throwing', () => {
  const prompt = _internal.buildUserPrompt({ sweepMode: 'appointment', severity: 'healthy', maxPerRun: 50 });
  assert.match(prompt, /LEADS TOUCHED[^]*\(none\)/);
  assert.match(prompt, /ERRORS:\n {2}\(none\)/);
  assert.match(prompt, /created: 0/);
});

// ─── §C generateBackstopInsight kill-switch + §C1 registration ───────

test('(25) LP_BACKSTOP_INSIGHT=off short-circuits to null, no model call', async () => {
  const prev = process.env.LP_BACKSTOP_INSIGHT;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('generateBackstopInsight must not call out when disabled'); };
  try {
    process.env.LP_BACKSTOP_INSIGHT = 'off';
    assert.equal(await generateBackstopInsight({ sweepMode: 'intake', severity: 'healthy' }), null);
    process.env.LP_BACKSTOP_INSIGHT = 'OFF';
    assert.equal(await generateBackstopInsight({ sweepMode: 'intake', severity: 'healthy' }), null);
  } finally {
    globalThis.fetch = prevFetch;
    if (prev === undefined) delete process.env.LP_BACKSTOP_INSIGHT; else process.env.LP_BACKSTOP_INSIGHT = prev;
  }
});

test('(26) generateBackstopInsight never throws — a failing provider yields null', async () => {
  const prev = process.env.LP_BACKSTOP_INSIGHT;
  const prevKeyA = process.env.ANTHROPIC_API_KEY;
  const prevFetch = globalThis.fetch;
  try {
    process.env.LP_BACKSTOP_INSIGHT = 'on';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = async () => { throw new Error('socket hang up'); };
    assert.equal(await generateBackstopInsight({ sweepMode: 'intake', severity: 'degraded', results: [] }), null);
  } finally {
    globalThis.fetch = prevFetch;
    if (prev === undefined) delete process.env.LP_BACKSTOP_INSIGHT; else process.env.LP_BACKSTOP_INSIGHT = prev;
    if (prevKeyA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKeyA;
  }
});

test('(27) backstop_insight is registered in the decision_engine group', () => {
  assert.equal(FUNCTION_GROUPS.backstop_insight, 'decision_engine');
  const r = resolveLLM('backstop_insight');
  assert.equal(r.group, 'decision_engine');
  assert.equal(r.env_prefix, 'BACKSTOP_INSIGHT');
  assert.ok(r.model, 'must resolve to a concrete model with no env set');
});

// ─── §B buildBackstopCard ────────────────────────────────────────────

const scanOf = (n, over = {}) => ({ targets: Array.from({ length: n }, (_, i) => ({ lead: { lp_lead_id: `t${i}` } })), ...over });

test('(16) card always carries a real source on a multi-source run', () => {
  const card = buildBackstopCard({
    sweepMode: 'appointment',
    severity: 'failing',
    scan: scanOf(3, { deferredCapped: 0, eligible: 3 }),
    counts: { created: 2, linked: 1, error: 1 },
    results: [
      lead({ lp_lead_id: '1' }),
      lead({ lp_lead_id: '2' }),
      lead({ lp_lead_id: '3', action: 'linked', lead_source: 'Iheart', lead_source_detail: 'Simpletext' }),
    ],
    errors: [],
    maxPerRun: 50,
  });
  assert.match(card, /📋 Src: /);
  assert.ok(!/📋 Src: Unknown/.test(card), `multi-source run must not render Unknown:\n${card}`);
  assert.match(card, /Internet > Modernize \(2\)/);
  // Multi-lead runs never claim a single contact.
  assert.match(card, /Contact ID: —/);
  assert.match(card, /3 lead\(s\) swept/);
});

test('(16b) single touched lead → the card carries that lead\'s real contact id', () => {
  const card = buildBackstopCard({
    sweepMode: 'appointment',
    severity: 'failing',
    scan: scanOf(2),
    counts: { created: 1, error: 1 },
    results: [lead({ lp_lead_id: '77', contact_id: 'ghl-abc123', name: 'Jane Doe', lp_prospect_id: 'P-9' })],
    errors: [{ lp_lead_id: '78', error: 'GHL 500', lead_source: 'Internet', lead_source_detail: 'Modernize' }],
    maxPerRun: 50,
  });
  assert.match(card, /Contact ID: ghl-abc123/);
  assert.ok(!/Contact ID: —/.test(card), `solo run must not fall back to the em dash:\n${card}`);
  assert.match(card, /Jane Doe/);
  assert.match(card, /Prospect: P-9/);
});

test('(17) every • detail line carries an " — " separated source segment', () => {
  const card = buildBackstopCard({
    sweepMode: 'intake',
    severity: 'degraded',
    scan: scanOf(3, { deferredCapped: 12, eligible: 15 }),
    counts: { created: 2, linked: 1 },
    results: [
      lead({ lp_lead_id: '1', contact_id: 'c1' }),
      lead({ lp_lead_id: '2', contact_id: 'c2', action: 'linked', lead_source: 'Iheart', lead_source_detail: 'Simpletext' }),
      lead({ lp_lead_id: '3', contact_id: 'c3', lead_source: null, lead_source_detail: null }),
    ],
    errors: [],
    maxPerRun: 25,
  });
  const bullets = card.split('\n').filter((l) => l.startsWith('•'));
  assert.equal(bullets.length, 3);
  for (const b of bullets) {
    const seg = b.replace(/^• /, '').split(' — ');
    assert.ok(seg.length >= 3, `detail line lacks a source segment: ${b}`);
    assert.ok(seg[1].trim().length > 0, `empty source segment: ${b}`);
  }
  assert.match(card, /• .* — Internet > Modernize — lead 1 → contact c1 \(created\)/);
  assert.match(card, /• .* — Iheart > Simpletext — lead 2 → contact c2 \(linked\)/);
  // An unresolvable source still renders — absence is signal, never a blank.
  assert.match(card, /• .* — Unknown — lead 3/);
});

test('(17b) errored leads render a ⚠ line carrying source and the error text', () => {
  const card = buildBackstopCard({
    sweepMode: 'appointment',
    severity: 'failing',
    scan: scanOf(2),
    counts: { created: 1, error: 1 },
    results: [lead({ lp_lead_id: '1', contact_id: 'c1' })],
    errors: [{ lp_lead_id: '5001', error: 'GHL 429 rate limited', lead_source: 'Internet', lead_source_detail: 'Modernize' }],
    maxPerRun: 50,
  });
  assert.match(card, /⚠ lead 5001 — Internet > Modernize — GHL 429 rate limited/);
});

test('(17c) all-errors run still names its sources — the card that matters most', () => {
  // Errored leads never enter `results`, so without the errors fallback this
  // renders "Src: Unknown" on exactly the run where source is the finding.
  const card = buildBackstopCard({
    sweepMode: 'appointment',
    severity: 'failing',
    scan: scanOf(3),
    counts: { created: 0, linked: 0, error: 3 },
    results: [],
    errors: [
      { lp_lead_id: '1', error: 'GHL 500', lead_source: 'Internet', lead_source_detail: 'Modernize' },
      { lp_lead_id: '2', error: 'GHL 500', lead_source: 'Internet', lead_source_detail: 'Modernize' },
      { lp_lead_id: '3', error: 'timeout', lead_source: 'Internet', lead_source_detail: 'Modernize' },
    ],
    maxPerRun: 50,
  });
  assert.ok(!/📋 Src: Unknown/.test(card), `all-errors run lost its source:\n${card}`);
  assert.match(card, /📋 Src: Internet > Modernize/);
  const warns = card.split('\n').filter((l) => l.startsWith('⚠'));
  assert.equal(warns.length, 3);
  for (const w of warns) assert.match(w, / — Internet > Modernize — /, `⚠ line lacks source: ${w}`);
});

test('(17d) detail lines truncate at MAX_DETAIL_LEADS with an "…and N more" line', () => {
  const many = Array.from({ length: MAX_DETAIL_LEADS + 3 }, (_, i) => lead({ lp_lead_id: String(i), contact_id: `c${i}` }));
  const manyErrors = Array.from({ length: MAX_DETAIL_LEADS + 2 }, (_, i) => ({
    lp_lead_id: `e${i}`, error: 'boom', lead_source: 'Internet', lead_source_detail: 'Modernize',
  }));
  const card = buildBackstopCard({
    sweepMode: 'appointment',
    severity: 'failing',
    scan: scanOf(many.length + manyErrors.length),
    counts: { created: many.length, error: manyErrors.length },
    results: many,
    errors: manyErrors,
    maxPerRun: 50,
  });
  assert.equal(card.split('\n').filter((l) => l.startsWith('• ') && !l.includes('…and')).length, MAX_DETAIL_LEADS);
  assert.match(card, /• …and 3 more/);
  assert.equal(card.split('\n').filter((l) => l.startsWith('⚠ lead')).length, MAX_DETAIL_LEADS);
  assert.match(card, /⚠ …and 2 more errored/);
});

test('(22) insight overrides the deterministic narrative; nextStep never varies', () => {
  const args = {
    sweepMode: 'appointment',
    severity: 'degraded',
    scan: scanOf(2, { deferredCapped: 30, eligible: 32 }),
    counts: { created: 2 },
    results: [lead({ lp_lead_id: '1', contact_id: 'c1' }), lead({ lp_lead_id: '2', contact_id: 'c2' })],
    errors: [],
    maxPerRun: 10,
    intervalMin: 15,
  };
  const insight = 'Eligible leads are arriving faster than the per-run limit clears them.';
  const withInsight = buildBackstopCard({ ...args, insight });
  const withoutInsight = buildBackstopCard({ ...args, insight: null });

  assert.ok(withInsight.includes(insight), 'model text must become the narrative');
  assert.ok(!withInsight.includes('The per-run cap left 30 eligible'), 'template narrative must be replaced, not appended');
  assert.match(withoutInsight, /The per-run cap left 30 eligible lead\(s\) unprocessed/);
  // Drain-time math is derived from the interval, not hardcoded.
  assert.match(withoutInsight, /roughly 45 min to drain/);

  // nextStep is standing doctrine — identical in both cards, and it must
  // actually RENDER: the classifier only emits "🎯 Next" for the
  // 'intelligence' class, so these 'system' cards append it themselves.
  const nextStepOf = (card) => card.split('\n').find((l) => l.startsWith('🎯 Next:'));
  assert.ok(nextStepOf(withInsight), 'nextStep line missing from the insight card');
  assert.match(nextStepOf(withInsight), /raise the cap only after confirming/);
  assert.equal(nextStepOf(withInsight), nextStepOf(withoutInsight));
});

test('(22b) a healthy card is composable and explains why it was sent', () => {
  const card = buildBackstopCard({
    sweepMode: 'intake',
    severity: 'healthy',
    scan: scanOf(1),
    counts: { created: 1 },
    results: [lead({ lp_lead_id: '1', contact_id: 'c1' })],
    errors: [],
    maxPerRun: 25,
  });
  assert.match(card, /LP INTAKE BACKSTOP — RUN/);
  assert.match(card, /LP_BACKSTOP_NOTIFY_MODE=all/);
  assert.match(card, /📋 Src: Internet > Modernize/);
});
