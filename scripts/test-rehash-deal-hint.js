/**
 * A better deal, hinted on every rehash reply — scripts/test-rehash-deal-hint.js
 * (Mark, 2026-10-19, rulings 3 and 4; REHASH_DEAL_HINT_MODE once | every)
 * Run: node --test scripts/test-rehash-deal-hint.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import {
  REHASH_HINT_LINES, NO_HINT_STEPS, rehashHintFor, pickRehashHint, hasRehashHint, rehashDealHintMode,
  rehashIfICouldBridge, rehashNepqTurn, buildRehashNepqBlock, REHASH_BRIDGE_RX,
} from '../src/agentic/rehash-nepq.js';
import { findOfferTalk, stripOfferTalk } from '../src/agentic/rehash.js';
import { runWithSimOverrides } from '../src/simulator/sim-overrides.js';

const NOW = Date.parse('2026-10-15T18:20:00Z');
const out = (text) => ({ direction: 'outbound', text });
const inn = (text) => ({ direction: 'inbound', text });
const plan = (trigger, conversation, mode, extra = {}) => planNepqTurn({
  channel: 'sms', trigger, conversation: [...conversation, inn(trigger)], slots: [], tzLabel: 'ET', firstName: 'Monica',
  discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep: 'John', rehash: true,
  rehashHintMode: mode, ...extra,
});
const START = [out("Hi Monica, it's John. Did you get a chance to look over the proposal?")];
const NAMED = /\$\s?\d|\d\s?%|\bpercent\b|\bdiscount|\bpromo|\bcoupon|\brebate|\bfinanc|\bAPR\b|\bdeadline|\bexpires?\b|\bthis week only\b|\bspecial (?:price|offer|deal)\b/i;

test('no hint line names the deal; every one passes the offer-talk test', () => {
  assert.ok(REHASH_HINT_LINES.length >= 5);
  for (const l of REHASH_HINT_LINES) {
    assert.ok(!NAMED.test(l), l);
    assert.ok(!/[—–]/.test(l), `no em dash: ${l}`);
    assert.deepEqual(findOfferTalk(l, { hintUsed: false }), [], l);
    assert.ok(hasRehashHint(l), l);
  }
});

test('every: an eligible step carries one hint; once: none', () => {
  const every = plan('Yes I looked it over', START, 'every');
  assert.equal(every.hint_mode, 'every');
  assert.ok(REHASH_HINT_LINES.includes(every.hint_line), every.hint_line);
  const once = plan('Yes I looked it over', START, 'once');
  assert.equal(once.hint_line, undefined);
  assert.equal(once.hint_mode, undefined);
});

test('enforceNepqPlan puts the hint before the closing question when the draft has none', () => {
  const p = plan('Yes I looked it over', START, 'every');
  const e = enforceNepqPlan('Glad you had a look, Monica. What stood out to you?', p);
  assert.ok(e.changes.includes('rehash_hint_added'), e.changes.join(','));
  assert.ok(hasRehashHint(e.text), e.text);
  assert.ok(e.text.trim().endsWith('?'), e.text);
  // A draft that already hints is left alone.
  const kept = enforceNepqPlan(`Glad you had a look. ${p.hint_line} What stood out to you?`, p);
  assert.ok(!kept.changes.includes('rehash_hint_added'));
});

test('no hint on the eight exception steps, or a first no', () => {
  for (const step of ['post_demo_stop', 'post_demo_close', 'closer', 'post_demo_space', 'sign_off', 'competitor_signed', 'defer', 'rehash_confirm', 'door_open']) {
    assert.ok(NO_HINT_STEPS.has(step), step);
    assert.equal(rehashHintFor({ step, mode: 'every' }), null, step);
  }
  assert.equal(rehashHintFor({ step: 'post_demo', noQuestion: true, mode: 'every' }), null);
  // Live examples: a sign-off, a deferral, signed elsewhere, a first no, two no's.
  for (const [trigger, conv] of [
    ['Will do. Thanks!', START],
    ['Follow up in November please.', START],
    ['We went with another company, thanks', START],
    ['Not interested at this time', START],
    ['No thanks', [...START, inn('Not interested'), out("Understood, Monica. We're here whenever you're ready.")]],
  ]) {
    const p = plan(trigger, conv, 'every');
    assert.equal(p.hint_line ?? null, null, `${trigger} → ${p.step}`);
  }
});

test('no repeated hint opener over six turns', () => {
  const sent = [];
  for (let i = 0; i < 6; i++) {
    const line = pickRehashHint(sent, i);
    const opener = line.toLowerCase().split(' ').slice(0, 4).join(' ');
    assert.ok(!sent.some(t => t.toLowerCase().includes(opener)), `turn ${i}: ${line}`);
    sent.push(`Thanks. ${line} Would a quick call help?`);
  }
});

test('the "If I could …, would you …?" bridge reads as our call offer', () => {
  const b = rehashIfICouldBridge('John');
  assert.equal(b, 'If I could make this work better for you, would you be open to a quick call with John?');
  assert.ok(REHASH_BRIDGE_RX.test(b));
  // A yes to it schedules the call (rehash-nepq track) …
  const t = rehashNepqTurn({ conversation: [...START, inn('It was more than we planned'), out(b)], trigger: 'Yes', hintMode: 'every' });
  assert.equal(t.stage, 'schedule');
  // … and the planner, with real Rehash Call times, offers them.
  const S = (iso, day, time) => ({ iso, day, time, tz: 'ET' });
  const OPEN = [S('2026-10-16T14:00:00Z', 'Fri, Oct 16', '10:00 AM'), S('2026-10-16T18:00:00Z', 'Fri, Oct 16', '2:00 PM')];
  const p = plan('Yes', [...START, inn('It was more than we planned'), out(b)], 'every', { callSlots: { calendarId: 'c', rep: 'r', repName: 'John', offer: OPEN, all: OPEN } });
  assert.equal(p.step, 'rehash_offer', p.step);
});

test('the ladder bridge in every mode is "If I could …"', () => {
  const conv = [...START, inn('It is too expensive'), out('Too expensive compared to what you were quoted elsewhere, Monica?')];
  const p = plan('Compared to the other quote', conv, 'every', { callSlots: null });
  assert.equal(p.step, 'rehash_bridge', p.step);
  assert.match(p.fixed_line, /If I could make this work better for you, would you be open to a quick call/);
  const o = plan('Compared to the other quote', conv, 'once', { callSlots: null });
  assert.match(o.fixed_line, /best deal possible/);
});

test('once mode: the block and the strip are today\'s', () => {
  const t = rehashNepqTurn({ conversation: START, trigger: 'Yes' });
  assert.equal(t.hint, undefined);
  const block = buildRehashNepqBlock(t, { repName: 'John' });
  assert.match(block, /may be said at most ONCE per conversation/);
  assert.ok(!/A BETTER DEAL, HINTED/.test(block));
  // A second "best deal" is still stripped in once mode.
  const s = stripOfferTalk("I want to make sure you're getting the best deal possible. Would a call help?", { hintUsed: true });
  assert.equal(s.stripped.length, 1);
});

test('every mode: the block names this turn\'s hint and never caps "best deal"', () => {
  const t = rehashNepqTurn({ conversation: START, trigger: 'Yes I did', hintMode: 'every', repName: 'John' });
  const block = buildRehashNepqBlock(t, { repName: 'John' });
  assert.match(block, /A BETTER DEAL, HINTED/);
  assert.match(block, /THIS TURN'S HINT/);
  assert.ok(!/at most ONCE per conversation/.test(block));
});

test('the mode reads REHASH_DEAL_HINT_MODE, and a gate run can force it', async () => {
  assert.equal(rehashDealHintMode({}), 'once');
  assert.equal(rehashDealHintMode({ REHASH_DEAL_HINT_MODE: 'every' }), 'every');
  assert.equal(rehashDealHintMode({ REHASH_DEAL_HINT_MODE: 'bogus' }), 'once');
  await runWithSimOverrides({ rehashDealHintMode: 'every' }, async () => {
    assert.equal(rehashDealHintMode({}), 'every');
  });
});
