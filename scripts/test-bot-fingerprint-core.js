/**
 * Tests — Bot Review fingerprint pure core (Phase 0)
 * scripts/test-bot-fingerprint-core.js
 *
 * Uses the Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-bot-fingerprint-core.js
 *
 * Pure-function tests — no DB, no network. Guards the invariants Phase 0 rests
 * on: channel normalization (the live_chat / "Live Chat" / livechat defect),
 * the skip classifier that decides which send_message outcomes are reviewable,
 * and the row shaper's refusal to build a row that would break the
 * UNIQUE (message_type, message_ref) contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeChannel,
  clip,
  toInt,
  corePromptVersion,
  shapeThread,
  shapeAvailability,
  buildInputSnapshot,
  extractKbModes,
  extractKbSources,
  buildContextRow,
  classifySkipOutcome,
  skipReasonFor,
  getFingerprintMode,
  getJudgePersistMode,
  isMissingRelation,
} from '../src/bot-feedback/fingerprint-core.js';

// ─── normalizeChannel ───────────────────────────────────────────────

test('normalizeChannel collapses every live-chat spelling to live_chat', () => {
  for (const raw of ['livechat', 'live_chat', 'Live Chat', 'LIVE-CHAT', 'webchat', 'chat']) {
    assert.equal(normalizeChannel(raw), 'live_chat', `failed on ${raw}`);
  }
});

test('normalizeChannel handles sms and email variants', () => {
  assert.equal(normalizeChannel('SMS'), 'sms');
  assert.equal(normalizeChannel('text'), 'sms');
  assert.equal(normalizeChannel('Email'), 'email');
  assert.equal(normalizeChannel('mail'), 'email');
});

test('normalizeChannel returns null for absent or unknown channels', () => {
  assert.equal(normalizeChannel(null), null);
  assert.equal(normalizeChannel(undefined), null);
  assert.equal(normalizeChannel(''), null);
  assert.equal(normalizeChannel('carrier pigeon'), null);
});

// ─── small shapers ──────────────────────────────────────────────────

test('clip trims to length and maps blank to null', () => {
  assert.equal(clip('abcdef', 3), 'abc');
  assert.equal(clip('ab', 10), 'ab');
  assert.equal(clip('   ', 10), null);
  assert.equal(clip(null, 10), null);
});

test('toInt coerces numeric strings and rejects junk', () => {
  assert.equal(toInt('3'), 3);
  assert.equal(toInt(4.9), 4);
  assert.equal(toInt('abc'), null);
  assert.equal(toInt(null), null);
  assert.equal(toInt(''), null);
});

test('corePromptVersion appends a short git sha when Railway provides one', () => {
  assert.equal(corePromptVersion('v2.7.14', { RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567' }), 'v2.7.14+abcdef1');
  assert.equal(corePromptVersion('v2.7.14', {}), 'v2.7.14');
  assert.equal(corePromptVersion(null, {}), 'unknown');
});

// ─── thread + availability ──────────────────────────────────────────

test('shapeThread keeps the last 10 turns and reads either body or text', () => {
  const conv = Array.from({ length: 14 }, (_, i) => ({ direction: 'inbound', text: `m${i}` }));
  const shaped = shapeThread(conv);
  assert.equal(shaped.length, 10);
  assert.equal(shaped[0].body, 'm4');
  assert.equal(shaped[9].body, 'm13');
});

test('shapeThread normalizes each turn channel and tolerates a non-array', () => {
  const shaped = shapeThread([{ direction: 'outbound', body: 'hi', type: 'Live Chat' }]);
  assert.equal(shaped[0].channel, 'live_chat');
  assert.equal(shaped[0].direction, 'outbound');
  assert.deepEqual(shapeThread(null), []);
  assert.deepEqual(shapeThread('nope'), []);
});

test('shapeAvailability records only the slots a reply could have offered', () => {
  const shaped = shapeAvailability({
    calendar_name: 'In-Home',
    calendar_id: 'cal_1',
    slots_total_count: 40,
    slots: Array.from({ length: 20 }, (_, i) => ({ start: `slot${i}` })),
  });
  assert.equal(shaped.calendar_name, 'In-Home');
  assert.equal(shaped.slots_total_count, 40);
  assert.equal(shaped.slots.length, 12, 'slot list is capped');
  assert.equal(shaped.slots[0], 'slot0');
  assert.equal(shapeAvailability(null), null);
});

// ─── snapshot + kb extraction ───────────────────────────────────────

test('buildInputSnapshot carries every replay field and merges extras', () => {
  const snap = buildInputSnapshot({
    conversation: [{ direction: 'inbound', body: 'do you do french doors?' }],
    contactTags: ['agentic-active', 'entry:calculator'],
    buyerStage: '3',
    activeEntryTag: 'entry:calculator',
    lpDisposition: 'Set',
    intentClass: 'QUESTION',
    channel: 'livechat',
    nowEt: '9/11/2026, 1:45:00 PM',
    extra: { fast_track: true },
  });
  assert.equal(snap.thread.length, 1);
  assert.deepEqual(snap.contact_tags, ['agentic-active', 'entry:calculator']);
  assert.equal(snap.buyer_stage, 3, 'buyer_stage is coerced to the DDL integer type');
  assert.equal(snap.channel, 'live_chat');
  assert.equal(snap.now_et, '9/11/2026, 1:45:00 PM');
  assert.equal(snap.fast_track, true);
});

test('extractKbModes reads the per-tier modes buildKbPack puts on the pack', () => {
  const modes = extractKbModes({ vector_mode: 'live', exemplar_mode: 'shadow', call_moments_mode: 'off' });
  assert.equal(modes.vector, 'live');
  assert.equal(modes.exemplars, 'shadow');
  assert.equal(modes.call_moments, 'off');
  assert.equal(modes.guidance, null, 'Phase 2 tiers are absent until Phase 2');
  assert.equal(extractKbModes(null), null);
});

test('extractKbSources records ids only, bounded', () => {
  const sources = extractKbSources({
    faqs: Array.from({ length: 30 }, (_, i) => ({ id: i })),
    objection_script: { id: 'obj_7' },
    exemplars: [{ id: 'ex1' }],
    vector_context: [{ chunk_id: 'c1' }],
  });
  assert.equal(sources.faqs.length, 20, 'source ids are capped');
  assert.equal(sources.objection_script, 'obj_7');
  assert.deepEqual(sources.exemplars, ['ex1']);
  assert.deepEqual(sources.vector_chunks, ['c1']);
  assert.equal(extractKbSources(undefined), null);
});

// ─── buildContextRow ────────────────────────────────────────────────

test('buildContextRow refuses a row with no usable message_ref', () => {
  assert.equal(buildContextRow({ message_type: 'reply', message_ref: null }), null);
  assert.equal(buildContextRow({ message_type: 'reply', message_ref: '   ' }), null);
  assert.equal(buildContextRow({ message_type: 'bogus', message_ref: '1' }), null);
  assert.equal(buildContextRow({}), null);
});

test('buildContextRow defaults the four id arrays so the NOT NULL columns hold', () => {
  const row = buildContextRow(
    { message_type: 'reply', message_ref: '4711', channel: 'livechat' },
    { RAILWAY_GIT_COMMIT_SHA: 'deadbeefcafe' },
  );
  assert.deepEqual(row.guidance_version_ids, []);
  assert.deepEqual(row.example_ids, []);
  assert.deepEqual(row.shadow_guidance_version_ids, []);
  assert.deepEqual(row.shadow_example_ids, []);
  assert.equal(row.channel, 'live_chat');
  assert.equal(row.core_prompt_version, 'unknown+deadbee');
  assert.ok(row.generated_at, 'generated_at is always stamped');
});

// ─── classifySkipOutcome ────────────────────────────────────────────

test('classifySkipOutcome ignores action types that are not send_message', () => {
  assert.equal(classifySkipOutcome('add_tag', 'skipped', {}), null);
  assert.equal(classifySkipOutcome('book_appointment', 'completed', {}), null);
});

test('classifySkipOutcome treats a delivered body as a send, never a skip', () => {
  assert.equal(classifySkipOutcome('send_message', 'completed', { action: 'message_sent', sent_body: 'hi' }), null);
  // Even a result that also carries a gate-shaped label is a send if it delivered.
  assert.equal(classifySkipOutcome('send_message', 'skipped', { action: 'send_message_x', sent_body: 'hi' }), null);
});

test('classifySkipOutcome catches the gates that record as completed', () => {
  // executeSendMessage's early returns do NOT set skipped:true, so the executor
  // records them completed — but nothing reached the contact.
  assert.equal(classifySkipOutcome('send_message', 'completed', { action: 'send_message_suppressed' }), 'skip');
  assert.equal(classifySkipOutcome('send_message', 'completed', { action: 'send_message_stop_bot' }), 'skip');
  assert.equal(classifySkipOutcome('send_message', 'completed', { action: 'send_message_handed_off' }), 'skip');
  assert.equal(classifySkipOutcome('send_message', 'skipped', { action: 'send_message_superseded' }), 'skip');
});

test('classifySkipOutcome does not treat a deferral or a failure as a skip', () => {
  // A deferral is a late reply, not a withheld one — it comes back through
  // this same path when it sends, and would otherwise be double-counted.
  assert.equal(classifySkipOutcome('send_message', 'pending', { deferred: true, reason: 'lock_held' }), null);
  assert.equal(classifySkipOutcome('send_message', 'failed', { action: 'send_message_ai_generation_failed' }), null);
});

test('skipReasonFor prefers the specific reason over the generic label', () => {
  assert.equal(skipReasonFor({ reason: 'stop_bot', action: 'send_message_stop_bot' }, 'skipped'), 'stop_bot');
  assert.equal(skipReasonFor({ action: 'send_message_suppressed' }, 'skipped'), 'send_message_suppressed');
  assert.equal(skipReasonFor({}, 'skipped'), 'skipped');
  assert.equal(skipReasonFor({}, null), null);
});

// ─── flags + degradation ────────────────────────────────────────────

test('fingerprint and judge modes default on and accept only their own values', () => {
  assert.equal(getFingerprintMode({}), 'on', 'Phase 0 ships on');
  assert.equal(getFingerprintMode({ BOT_FINGERPRINT_MODE: 'off' }), 'off');
  assert.equal(getFingerprintMode({ BOT_FINGERPRINT_MODE: 'OFF' }), 'off');
  assert.equal(getFingerprintMode({ BOT_FINGERPRINT_MODE: 'banana' }), 'on', 'junk falls back to the default');
  assert.equal(getJudgePersistMode({}), 'on');
  assert.equal(getJudgePersistMode({ BOT_JUDGE_PERSIST: 'off' }), 'off');
});

test('isMissingRelation recognises an unapplied sql/103', () => {
  assert.equal(isMissingRelation({ code: '42P01' }), true);
  assert.equal(isMissingRelation({ message: 'relation "bot_message_context" does not exist' }), true);
  assert.equal(isMissingRelation({ message: 'Could not find the table in the schema cache' }), true);
  assert.equal(isMissingRelation({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isMissingRelation(null), false);
});
