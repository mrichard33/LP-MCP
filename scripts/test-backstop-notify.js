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
 * Cases 1-11 (exception gate, severity, notifyBackstopRun) belong to the
 * PRIOR handoff and are absent because that work is not in this repo.
 * Cases 16, 17 and 22 need buildBackstopCard for the same reason and are
 * marked todo below rather than deleted — un-skip them when the notify
 * module lands. Numbering follows the addendum so the two sets interleave.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeSources } from '../src/services/backstop-notify.js';
import { cleanInsight, generateBackstopInsight, INSIGHT_CHAR_CAP, _internal } from '../src/services/backstop-insight.js';
import { resolveLLM, FUNCTION_GROUPS } from '../src/llm-client.js';

const lead = (over = {}) => ({
  action: 'created',
  name: 'Test Lead',
  lp_lead_id: '1001',
  contact_id: 'c-1',
  lead_source: 'Internet',
  lead_source_detail: 'Modernize',
  ...over,
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

// ─── Pending on the prior handoff (buildBackstopCard) ────────────────

test('(16) card always carries a real source on a multi-source run', { todo: 'needs buildBackstopCard from feat/backstop-exception-notifications' }, () => {});
test('(17) every • detail line carries an " — " separated source segment', { todo: 'needs buildBackstopCard from feat/backstop-exception-notifications' }, () => {});
test('(22) insight overrides the deterministic narrative when present', { todo: 'needs buildBackstopCard from feat/backstop-exception-notifications' }, () => {});
