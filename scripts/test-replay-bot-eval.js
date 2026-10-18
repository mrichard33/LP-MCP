/**
 * The replay set's pure parts — scripts/test-replay-bot-eval.js
 *
 * Phase 0 (2026-10-18): scripts/replay-bot-eval.js reads live incidents from
 * the database, so it is not in the gate. Its move families, thread rebuild and
 * grading are pinned here on synthetic rows only (no customer text is
 * committed, the user 2026-10-05), along with the fixture's shape.
 *
 * Run: node --test scripts/test-replay-bot-eval.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { moveFamily, threadForCase, scoreCase, plannerArgsForCase, formatReport } = await import('./replay-bot-eval.js');

test('move families from a planner plan or a stored summary', () => {
  assert.equal(moveFamily({ step: 'post_demo_close', required_move: 'close' }), 'close');
  assert.equal(moveFamily({ step: 'post_demo', move: 'answer', no_question: true }), 'close');
  assert.equal(moveFamily({ step: 'post_demo', move: 'answer', post_demo: true }), 'rehash_track');
  assert.equal(moveFamily({ step: 'rehash_bridge' }), 'rehash_track');
  assert.equal(moveFamily({ step: 'offer_slots', move: 'offer_slots' }), 'booking');
  assert.equal(moveFamily({ step: 'confirm' }), 'booking');
  assert.equal(moveFamily({ step: 'discover', move: 'probe' }), 'discovery');
  assert.equal(moveFamily({ step: 'handoff', handoff: { reason: 'complaint' } }), 'handoff');
  assert.equal(moveFamily({ step: 'answer', move: 'answer' }), 'answer');
  assert.equal(moveFamily(null), 'none');
});

test('an SMS case reads its stored thread and drops its own inbound', () => {
  const row = { message_ref: '9', ghl_contact_id: 'c', channel: 'sms', generated_at: '2026-10-17T15:00:00Z', inbound_text: 'Not ready',
    input_snapshot: { thread: [
      { direction: 'outbound', body: 'Quick follow-up after your visit.', kind: 'message' },
      { direction: 'outbound', body: 'Opportunity created', kind: 'activity' },
      { direction: 'inbound', body: 'Not ready', kind: 'message' },
    ] } };
  assert.deepEqual(threadForCase(row).map(t => [t.direction, t.text]), [['outbound', 'Quick follow-up after your visit.']]);
});

test('a live-chat case rebuilds its thread from the contact\'s earlier chat rows', () => {
  const row = { message_ref: '3', ghl_contact_id: 'c', channel: 'live_chat', generated_at: '2026-10-15T13:36:00Z', inbound_text: 'the 24th', input_snapshot: {} };
  const prior = [
    { message_ref: '2', ghl_contact_id: 'c', channel: 'live_chat', generated_at: '2026-10-15T13:35:00Z', inbound_text: 'Saturdays', reply_text: 'I have Sat at 10 or the next Sat at 10. Which works better?' },
    { message_ref: '1', ghl_contact_id: 'c', channel: 'live_chat', generated_at: '2026-10-15T13:30:00Z', inbound_text: 'hi', reply_text: 'Hi! What got you looking?' },
    { message_ref: '0', ghl_contact_id: 'c', channel: 'sms', generated_at: '2026-10-15T13:31:00Z', inbound_text: 'sms', reply_text: 'not chat' },
    { message_ref: 'x', ghl_contact_id: 'other', channel: 'live_chat', generated_at: '2026-10-15T13:32:00Z', inbound_text: 'other', reply_text: 'other' },
    { message_ref: '4', ghl_contact_id: 'c', channel: 'live_chat', generated_at: '2026-10-15T13:40:00Z', inbound_text: 'later', reply_text: 'later' },
  ];
  assert.deepEqual(threadForCase(row, [row, ...prior]).map(t => t.text), ['hi', 'Hi! What got you looking?', 'Saturdays', 'I have Sat at 10 or the next Sat at 10. Which works better?']);
});

test('grading: the family, a question where none is allowed, a missing question only from a real reply', () => {
  assert.deepEqual(scoreCase({ move_family: 'close', question_allowed: false }, { move_family: 'close', asks: false }), { pass: true, failures: [] });
  assert.deepEqual(scoreCase({ move_family: 'close', question_allowed: false }, { move_family: 'rehash_track', asks: true }).failures, ['move_family rehash_track (expected close)', 'question_not_allowed']);
  assert.equal(scoreCase({ move_family: 'booking', question_allowed: true }, { move_family: 'booking', asks: false, asks_source: 'plan' }).pass, true);
  assert.deepEqual(scoreCase({ move_family: 'booking', question_allowed: true }, { move_family: 'booking', asks: false, asks_source: 'reply' }).failures, ['expected_a_question']);
});

test('planner input: a post-demo case is planned post-demo; live chat never carries the classifier callback', () => {
  const deps = { isPostDemoLead: ({ lp }) => lp?.disposition === 'OPPFDN', isRehashContact: ({ tags }) => tags.includes('rehash') };
  const row = { message_ref: '1', ghl_contact_id: 'c', channel: 'sms', generated_at: '2026-10-17T15:00:00Z', inbound_text: 'Not ready', input_snapshot: {} };
  const a = plannerArgsForCase({ channel: 'sms', lp_disposition: 'OPPFDN', contact_tags: [], intent_class: 'CALLBACK' }, row, [], deps);
  assert.equal(a.postDemo, true);
  assert.equal(a.callbackRequested, true);
  assert.equal(plannerArgsForCase({ channel: 'live_chat', contact_tags: [], intent_class: 'CALLBACK' }, { ...row, channel: 'live_chat' }, [], deps).callbackRequested, false);
  assert.equal(plannerArgsForCase({ channel: 'sms', lp_disposition: 'OPPFDN', contact_tags: [] }, row, [], { ...deps, postDemoMode: 'shadow' }).postDemo, false);
});

test('the report prints ids and codes only', () => {
  const out = formatReport([{ message_ref: '1', channel: 'sms', expected: { move_family: 'close', question_allowed: false }, observed: { move_family: 'close', step: 'post_demo_close', asks: false, asks_source: 'plan' }, pass: true, failures: [] }], { mode: 'planner-only' });
  assert.match(out, /^Replay planner-only: 1\/1 pass \(100%\)/);
});

test('the w42 fixture: 14 cases, ids and expectations only, no message text', () => {
  const f = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'replay', '2026-10-w42.json'), 'utf8'));
  assert.equal(f.cases.length, 14);
  const families = new Set(['close', 'rehash_track', 'booking', 'discovery', 'handoff', 'answer']);
  for (const c of f.cases) {
    assert.match(c.contact_id, /^[A-Za-z0-9]{20}$/);
    assert.match(c.message_ref, /^\d+$/);
    assert.ok(families.has(c.expected.move_family), c.message_ref);
    assert.equal(typeof c.expected.question_allowed, 'boolean', c.message_ref);
    for (const k of ['inbound_text', 'reply_text', 'thread', 'input_snapshot']) assert.ok(!(k in c), `${c.message_ref} carries ${k}`);
  }
  assert.doesNotMatch(JSON.stringify(f), /\b\d{3}\D?\d{3}\D?\d{4}\b|@[a-z0-9-]+\.[a-z]{2,}/i, 'no phone or email');
});
