/**
 * Rehash better-price framing (2026-10-21 handoff Part 2,
 * REHASH_BETTER_PRICE_FRAMING_ENABLED). Live threads of 2026-10-20, names removed:
 *   E  "We are going to get a couple more quotes" got "How do they compare, out of curiosity?"
 *   F  "I may be able to do something for you, it's just easier on a quick call." (no reason)
 *
 * Run: node --test scripts/test-rehash-better-price.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { betterPriceReason, betterPriceInvite, hasBetterPrice, isItemizedAsk, buildRehashNepqBlock, rehashNepqTurn, BETTER_PRICE_KINDS } from '../src/agentic/rehash-nepq.js';
import { rehashBetterPrice } from '../src/agentic/rehash-flags.js';
import { findOfferTalk, stripOfferTalk } from '../src/agentic/rehash.js';
import { postDemoRehash } from '../src/prompts/response-generator/playbooks.js';
import { runWithSimOverrides } from '../src/simulator/sim-overrides.js';
import { SCENARIO_EXPECTATIONS } from '../src/simulator/sim-scoring.js';

const NOW = Date.parse('2026-10-20T20:50:00Z');
const S = (iso, day, time, rel, dow) => ({ iso, day, time, dayOfWeek: dow, ...(rel ? { rel } : {}), tz: 'ET' });
const A = S('2026-10-21T13:30:00Z', 'Wed, Oct 21', '9:30 AM', 'tomorrow', 'Wednesday');
const B = S('2026-10-21T14:30:00Z', 'Wed, Oct 21', '10:30 AM', 'tomorrow', 'Wednesday');
const SLOTS = { calendarId: 'cal', rep: 'u1', repName: 'John', offer: [A, B], all: [A, B] };
const out = (text) => ({ direction: 'outbound', text });
const inn = (text) => ({ direction: 'inbound', text });
const Q = out('Did you get a chance to look over the proposal?');
const plan = (trigger, conversation = [Q], callSlots = SLOTS) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: [], tzLabel: 'ET', firstName: 'Pat',
  discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep: 'John', rehash: true, callSlots,
});
const off = (fn) => runWithSimOverrides({ rehashBetterPrice: 'off' }, fn);
const MONEY = /\$\s?\d|\d\s?%|\bdiscount|\bpromo|\brebate|\bfinanc|\bdeal\b/i;

test('flag: unset is on; "false" is off', () => {
  assert.equal(rehashBetterPrice({}), true);
  assert.equal(rehashBetterPrice({ REHASH_BETTER_PRICE_FRAMING_ENABLED: 'false' }), false);
});

test('copy: every line gives the better-price reason, names no amount, survives the offer-talk strip', () => {
  for (const kind of BETTER_PRICE_KINDS) {
    for (const line of [betterPriceReason(kind, 'John'), betterPriceInvite(kind, 'John'), betterPriceInvite(kind, null)]) {
      assert.ok(hasBetterPrice(line), line);
      assert.doesNotMatch(line, MONEY, line);
      assert.deepEqual(findOfferTalk(line), [], line);
      assert.doesNotMatch(line, /\b(?:he|she|his|her)\b/i, line);
    }
    assert.match(betterPriceInvite(kind, 'John'), /\?$/);
    assert.ok(!betterPriceReason(kind, 'John').includes('?'));
  }
  assert.match(betterPriceInvite('compare', 'John'), /^Smart to compare\. If I could beat what you're being quoted, would you be open to a quick call with John before you decide\?$/);
});

test('E: "a couple more quotes" → the better-price offer with the two times, never "how do they compare"', () => {
  const p = plan('We are going to get a couple more quotes');
  assert.equal(p.step, 'rehash_offer');
  assert.match(p.fixed_line, /^Smart to compare\. I may be able to beat what you're being quoted/);
  assert.match(p.fixed_line, /I have tomorrow at 9:30 AM ET or tomorrow at 10:30 AM ET/);
  assert.ok(p.reference_markers?.length);
  const noTimes = plan('We are going to get a couple more quotes', [Q], null);
  assert.equal(noTimes.step, 'rehash_bridge');
  assert.match(noTimes.fixed_line, /If I could beat what you're being quoted, would you be open to a quick call/);
  // Off: the ask-back as before.
  assert.equal(off(() => plan('We are going to get a couple more quotes')).fixed_line, 'How do they compare, out of curiosity?');
});

test('price, thinking it over → the reason first; a third time → a person; a spouse keeps its ask-back', () => {
  const p = plan('It is just too expensive for us right now');
  assert.equal(p.step, 'rehash_offer');
  assert.match(p.fixed_line, /^I hear you on the price\. I may be able to get that number down/);
  const t = plan('We need to think about it', [Q], null);
  assert.match(t.fixed_line, /better price, would you be open to a quick call/);
  const third = plan('The price is the problem, it is just too much', [Q, inn('It is just too expensive'), out('x'), inn('Honestly the price is still too high'), out('y')]);
  assert.equal(third.step, 'handoff');
  const sp = plan('I need to talk it over with my wife', [Q], null);
  assert.equal(sp.step, 'rehash_objection');
});

test('itemized estimate → walk through it on a call, with a better price', () => {
  const ask = "Can I get an itemized estimate emailed to me? I want to see what each window costs.";
  assert.ok(isItemizedAsk(ask));
  const p = plan(ask);
  assert.equal(p.step, 'rehash_offer');
  assert.match(p.fixed_line, /walk through each window and door line by line on a quick call, and look at getting you a better price/);
  assert.match(plan(ask, [Q], null).fixed_line, /better price at the same time\. Would a quick call to walk through each window and door line by line help\?$/);
});

test('F: a call ask gets times with the reason; not repeated when we just said it', () => {
  const p = plan('Can you call me?');
  assert.equal(p.step, 'rehash_offer');
  assert.ok(hasBetterPrice(p.fixed_line), p.fixed_line);
  const again = plan('Can you call me?', [Q, out('I may be able to get you a better price, and a quick call is the easiest way to look at it.')]);
  assert.ok(!hasBetterPrice(again.fixed_line), again.fixed_line);
  assert.ok(!hasBetterPrice(off(() => plan('Can you call me?')).fixed_line));
});

test('F: the bridge appended by the guard and the strip fallback carry the reason', () => {
  const p = plan('Mostly wondering about the sliding door in the back', [Q, inn('Yes'), out("What's holding you back, just so I understand?"), inn('Just the timing'), out('What would you need to see to feel good moving forward?')], null);
  assert.equal(p.step, 'post_demo');
  assert.equal(p.rehash_stage, 'bridge');
  assert.equal(enforceNepqPlan('That makes sense.', p).text, 'That makes sense. If I could get you a better price, would you be open to a quick call?');
  const s = stripOfferTalk('We can knock it down 10%.', { betterPrice: true });
  assert.ok(hasBetterPrice(s.text), s.text);
  assert.ok(!hasBetterPrice(stripOfferTalk('We can knock it down 10%.').text));
});

test('prompt: the rehash block and the playbook name the better price; off is the copy before', () => {
  const turn = rehashNepqTurn({ conversation: [Q], trigger: 'We got another quote that was lower', nowMs: NOW, repName: 'John' });
  assert.ok(hasBetterPrice(turn.example), turn.example);
  const block = buildRehashNepqBlock(turn, { repName: 'John' });
  assert.match(block, /THE REASON FOR THE CALL/);
  assert.doesNotMatch(block, /How do they compare/);
  const offBlock = off(() => buildRehashNepqBlock(off(() => rehashNepqTurn({ conversation: [Q], trigger: 'We got another quote that was lower', nowMs: NOW, repName: 'John' })), { repName: 'John' }));
  assert.match(offBlock, /How do they compare/);
  const pb = postDemoRehash('John', { betterPrice: true }).join('\n');
  assert.match(pb, /better price/);
  assert.doesNotMatch(pb, /I may be able to do something for you, it's just easier/);
  assert.deepEqual(postDemoRehash('John', { betterPrice: false }), postDemoRehash('John'));
});

test('scenario checks: other quotes and the call reason', () => {
  const T = (n, bot) => ({ turn: n, customer: 'x', bot: [bot], nepq: { post_demo: true, step: 'post_demo' } });
  const R = (scenario, transcript) => ({ channel: 'sms', scenario, family: 'rehash', rehash_better_price: 'on', transcript, would_do: [] });
  const bad = SCENARIO_EXPECTATIONS.rehash_other_quotes(R('rehash_other_quotes', [T(1, 'How do they compare, out of curiosity?')])).map(f => f.code);
  assert.ok(bad.includes('compare_asked_back') && bad.includes('no_better_price_offer'));
  const vague = SCENARIO_EXPECTATIONS.rehash_call_reason(R('rehash_call_reason', [T(1, "I may be able to do something for you, it's just easier on a quick call. Would that help?")])).map(f => f.code);
  assert.ok(vague.includes('call_invite_without_reason') && vague.includes('vague_call_reason'));
  const good = SCENARIO_EXPECTATIONS.rehash_call_reason(R('rehash_call_reason', [T(1, 'If I could get you a better price, would you be open to a quick call with John?')])).map(f => f.code);
  assert.deepEqual(good.filter(c => c === 'call_invite_without_reason' || c === 'vague_call_reason'), []);
});

// ── 2026-10-21 (Mark, ruling 4; Jim Anderson 8:55): never a comparison question ──
import { isComparisonQuestion } from '../src/agentic/rehash-nepq.js';
import { checkReply } from '../src/eval/reply-invariants.js';

test('Jim: price, other proposals, more quotes — no comparison question at any attempt', () => {
  const conv = [Q];
  for (const t of ['The price is more than we expected', 'We are comparing it to the other proposals that we have received', 'Still looking at the other quotes']) {
    const p = plan(t, [...conv]);
    const line = String(p.fixed_line || p.reference_line || '');
    assert.equal(line.split(/(?<=[.!?])\s+/).some(isComparisonQuestion), false, `${t} → ${line}`);
    conv.push(inn(t), out(line || 'ok'));
  }
});

test('the guard drops a model-written comparison question and puts the better-price invite in its place', () => {
  const p = plan('We are comparing it to the other proposals that we have received');
  const r = enforceNepqPlan('Makes sense. How do they stack up so far, price and everything else?', { ...p, step: 'post_demo', fixed_line: null, reference_line: null });
  assert.ok(r.changes.includes('rehash_comparison_dropped'), r.changes.join(','));
  assert.doesNotMatch(r.text, /stack\s+up/i);
  assert.ok(hasBetterPrice(r.text), r.text);
  // Off (the rollback): the guard leaves the copy before alone.
  const p2 = off(() => plan('We are comparing it to the other proposals that we have received'));
  const r2 = enforceNepqPlan('How do they compare, out of curiosity?', { ...p2, step: 'post_demo', fixed_line: null, reference_line: null });
  assert.equal(r2.changes.includes('rehash_comparison_dropped'), false);
});

test('checkReply fails rehash_comparison_question on the rehash path only', () => {
  const text = 'Thanks, Jim. How do they stack up so far, price and everything else?';
  assert.ok(checkReply(text, { rehash: true }).violations.some((v) => v.code === 'rehash_comparison_question'));
  assert.equal(checkReply(text, { rehash: false }).violations.some((v) => v.code === 'rehash_comparison_question'), false);
  assert.equal(isComparisonQuestion('Smart to compare.'), false, 'a statement is not a question');
});

test('scenario check: rehash_price_compare_any_attempt', () => {
  const check = SCENARIO_EXPECTATIONS.rehash_price_compare_any_attempt;
  const run = (bot) => check({ rehash_better_price: 'on', transcript: [{ turn: 1, bot: [bot] }] }).map((f) => f.code);
  assert.ok(run('How do they compare to ours?').includes('compare_asked_back'));
  assert.equal(run('If I could get you a better price, would you be open to a quick call with John?').includes('compare_asked_back'), false);
});
