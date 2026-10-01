/**
 * Post-demo F.0 leads (tag active-f.0, line 727-800-4578) talk to the rehash
 * rep, and the one goal is a phone call with that rep (Mark, 2026-10-01).
 * Pure helpers, the GHL custom-value read, the prompt, and the
 * #contact-rehash card.
 *
 * Run: node --test scripts/test-rehash-replies.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.NEPQ_LAYER_MODE ||= 'on';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const R = await import('../src/agentic/rehash.js');
const { getCustomValue, pickCustomValue, customValueKey, __resetCustomValuesCacheForTest } = await import('../src/services/ghl-custom-values.js');
const { buildResponsePrompt, resolveSmsSenderIdentity, validateResponse } = await import('../src/response-generator.js');
const { notifyRehashCall } = await import('../src/notifications/rehash-call.js');

// ── who is a rehash contact ─────────────────────────────────────────────────

test('isRehashContact: the active-f.0 tag, or a reply going out from 727-800-4578', () => {
  assert.equal(R.isRehashContact({ tags: ['lp-linked', 'active-f.0'] }), true);
  assert.equal(R.isRehashContact({ tags: ['Active-F.0 '] }), true);
  assert.equal(R.isRehashContact({ tags: [], fromNumber: '+1 (727) 800-4578' }), true);
  assert.equal(R.isRehashContact({ tags: ['active-e.3'], fromNumber: '+19542808890' }), false);
  assert.equal(R.isRehashContact({}), false);
  assert.equal(R.isRehashContact({ fromNumber: '8135550100', env: { AGENTIC_SMS_NUMBER_REHASH: '813-555-0100' } }), true, 'the number is env-tunable');
});

// ── the rep's name from GHL ────────────────────────────────────────────────

test('custom value: matched by fieldKey or name, cached for an hour, a failed read is not cached', async () => {
  __resetCustomValuesCacheForTest();
  const rows = [{ name: 'Rep Name', fieldKey: '{{ custom_values.rep_name }}', value: 'Mark' }, { name: 'Rehash Rep Name', fieldKey: '{{ custom_values.rehash_rep_name }}', value: ' Alex Rivera ' }];
  assert.equal(customValueKey('{{ custom_values.rehash_rep_name }}'), 'rehash_rep_name');
  assert.equal(pickCustomValue(rows, 'rehash_rep_name'), 'Alex Rivera');
  assert.equal(pickCustomValue([{ name: 'Rehash Rep Name', value: 'Alex' }], 'rehash_rep_name'), 'Alex', 'by name when there is no fieldKey');
  assert.equal(pickCustomValue([{ name: 'rehash_rep_name', value: '  ' }], 'rehash_rep_name'), null, 'blank is no name');

  let calls = 0;
  const ok = { ghlFetch: async (method, path) => { calls++; assert.match(path, /^\/locations\/loc1\/customValues$/); return { customValues: rows }; }, locationId: 'loc1' };
  assert.equal(await getCustomValue('rehash_rep_name', { deps: ok, nowMs: 1000 }), 'Alex Rivera');
  assert.equal(await getCustomValue('rehash_rep_name', { deps: ok, nowMs: 2000 }), 'Alex Rivera');
  assert.equal(calls, 1, 'second read is cached');
  assert.equal(await getCustomValue('rehash_rep_name', { deps: ok, nowMs: 1000 + 61 * 60 * 1000 }), 'Alex Rivera');
  assert.equal(calls, 2, 'refreshed after an hour');

  __resetCustomValuesCacheForTest();
  let failing = 0;
  const broken = { ghlFetch: async () => { failing++; throw new Error('GHL 503'); }, locationId: 'loc1' };
  assert.equal(await getCustomValue('rehash_rep_name', { deps: broken }), null);
  assert.equal(await getCustomValue('rehash_rep_name', { deps: broken }), null);
  assert.equal(failing, 2, '"could not tell" is asked again next time');
});

// ── identity ───────────────────────────────────────────────────────────────

test('identity: the rehash rep signs on a direct line; no name resolved → the team, never a guess', () => {
  const id = resolveSmsSenderIdentity('+17278004578', { rehash: { active: true, repName: 'Alex' } });
  assert.deepEqual(id, { persona: 'rehash', signature: 'Alex', shared: false, nameIfAsked: 'Alex', matched: true });
  const byTag = resolveSmsSenderIdentity('+19543710083', { rehash: { active: true, repName: 'Alex' } });
  assert.equal(byTag.persona, 'rehash');
  assert.equal(byTag.matched, false);
  const noName = resolveSmsSenderIdentity('+17278004578', { rehash: { active: true, repName: null } });
  assert.equal(noName.persona, 'team');
  assert.equal(noName.signature, 'Reece Team');
  assert.equal(resolveSmsSenderIdentity('+19542808890').persona, 'mark', 'everyone else is unchanged');
});

// ── the prompt ─────────────────────────────────────────────────────────────

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/response-prompt/23-sms-post-appointment-fast-track-suppressed.json', import.meta.url), 'utf8'));
const render = (opts = {}) => buildResponsePrompt(fx.context, 'sms', 'What would it take to get this done?', fx.kbPack, fx.classification, fx.fastTrack ?? false, fx.trafficTemp ?? 'warm', null, { ...fx.opts, fromNumber: '+17278004578', ...opts });

test('prompt: an F.0 lead is written by the rehash rep, with the call as the one goal', () => {
  const user = render({ rehash: { active: true, repName: 'Alex' } });
  assert.match(user, /You are writing as Alex/);
  assert.match(user, /POST-DEMO REHASH/);
  assert.match(user, /THE ONE GOAL: get them on a short PHONE CALL with Alex/);
  assert.match(user, /NEVER name a price, a discount, a percentage/);
  assert.match(user, /"rehash_call"/);
  assert.match(user, /goes out from Alex's direct line/);
  assert.doesNotMatch(user, /SHARED Reece team line/);
  // The post-appointment ban still stands; only a call with the rep is carved out.
  assert.match(user, /POST-APPOINTMENT CONDUCT — HARD BAN/);
  assert.match(user, /EXCEPTION TO THE POST-APPOINTMENT BAN ABOVE: offering a PHONE CALL with Alex/);
  assert.match(user, /no in-home visit, no re-measure/);
  assert.doesNotMatch(user, /their rep sending the estimate\/proposal/, 'the generic "rep is sending it" close is replaced');
});

test('prompt: no rep name resolved → team voice, still the call goal', () => {
  const user = render({ rehash: { active: true, repName: null } });
  assert.match(user, /THE ONE GOAL: get them on a short PHONE CALL with someone from our follow-up team/);
  assert.doesNotMatch(user, /You are writing as Alex/);
});

test('prompt: a contact not in F.0 is unchanged', () => {
  const user = render({ fromNumber: '+19543710083' });
  assert.doesNotMatch(user, /POST-DEMO REHASH/);
  assert.match(user, /their rep sending the estimate\/proposal/);
});

// ── the model's output ─────────────────────────────────────────────────────

test('rehash_call is read from the model output, and missing means null', () => {
  assert.deepEqual(validateResponse({ message: 'Sounds good.', rehash_call: { agreed: true, preferred_time: ' tomorrow  after 3 ' } }, 'sms').rehash_call, { agreed: true, preferred_time: 'tomorrow after 3' });
  assert.deepEqual(validateResponse({ message: 'Ok.', rehash_call: { agreed: 'yes' } }, 'sms').rehash_call, { agreed: false, preferred_time: null });
  assert.equal(validateResponse({ message: 'Ok.' }, 'sms').rehash_call, null);
});

test('offer guard: a price, a percentage, a discount or "a deal" never ships; the hint replaces it', () => {
  const a = R.stripOfferTalk('Totally fair. I can take $1,500 off if you sign this week. Would a quick call help?');
  assert.equal(a.text, 'Totally fair. Would a quick call help?');
  assert.equal(a.stripped.length, 1);
  const b = R.stripOfferTalk('We have a special discount running right now.');
  assert.equal(b.text, R.OFFER_HINT_LINE);
  for (const t of ['I can get you 10% off.', 'Let me see if I can get you a better deal.', 'There is a promo this month.', 'We can price match that.']) {
    assert.ok(R.findOfferTalk(t).length, t);
  }
  const clean = 'I may be able to do something for you on that. What is a good time for a quick call?';
  assert.deepEqual(R.stripOfferTalk(clean), { text: clean, stripped: [] });
});

// ── the #contact-rehash card ───────────────────────────────────────────────

const GEN = { rehash: { active: true, rep_name: 'Alex' }, rehash_call: { agreed: true, preferred_time: 'tomorrow after 3' } };
function deps({ seen = false, post = { ok: true, ts: '1.2' } } = {}) {
  const state = { posts: [], events: [], ops: [] };
  return {
    state,
    d: {
      postToSlack: async (text, channel) => { state.posts.push({ text, channel }); return post; },
      emitEvent: async (e) => { state.events.push(e); return { id: 1 }; },
      opsAlert: async (t) => { state.ops.push(t); },
      locationId: 'loc1',
      alreadyRequested: async () => seen,
    },
  };
}

test('card: posted to #contact-rehash with name, time, phone and contact link; recorded once', async () => {
  const { state, d } = deps();
  const out = await notifyRehashCall({ contactId: 'C1', generated: GEN, triggerMessage: 'Yes call me tomorrow after 3', contact: { firstName: 'Susan', phone: '+13525550100', market: 'Orlando' } }, d, { env: {} });
  assert.deepEqual(out, { posted: true, reason: 'posted' });
  assert.equal(state.posts[0].channel, 'C0C5YMHNYJH');
  const card = state.posts[0].text;
  assert.match(card, /REHASH CALL REQUEST/);
  assert.match(card, /Susan \(post-demo, F\.0\) said yes to a call with Alex\./);
  assert.match(card, /Best time: tomorrow after 3/);
  assert.match(card, /Phone: \+13525550100/);
  assert.match(card, /contacts\/detail\/C1/);
  assert.match(state.events[0].idempotency_key, /^f0_rehash_call_C1_\d{4}-\d{2}-\d{2}$/);
});

test('card: once per contact per day; an unreadable record still posts', async () => {
  const seen = deps({ seen: true });
  assert.equal((await notifyRehashCall({ contactId: 'C1', generated: GEN, contact: {} }, seen.d)).reason, 'already_posted_today');
  assert.equal(seen.state.posts.length, 0);
  const unknown = deps({ seen: null });
  assert.equal((await notifyRehashCall({ contactId: 'C1', generated: GEN, contact: {} }, unknown.d)).posted, true);
});

test('card: no card unless the lead agreed; a failed post tells #ops-alerts', async () => {
  const none = deps();
  assert.equal((await notifyRehashCall({ contactId: 'C1', generated: { ...GEN, rehash_call: { agreed: false } } }, none.d)).reason, 'no_call_agreed');
  assert.equal((await notifyRehashCall({ contactId: 'C1', generated: { rehash: null, rehash_call: { agreed: true } } }, none.d)).reason, 'not_rehash');
  const failing = deps({ post: { ok: false, error: 'not_in_channel' } });
  const out = await notifyRehashCall({ contactId: 'C1', generated: GEN, contact: { firstName: 'Susan' } }, failing.d);
  assert.equal(out.posted, false);
  assert.match(failing.state.ops[0], /REHASH CALL REQUEST NOT POSTED/);
  assert.match(failing.state.ops[0], /add the Reece Slack app to #contact-rehash/);
  assert.equal(failing.state.events.length, 0, 'not recorded, so the next yes tries again');
});
