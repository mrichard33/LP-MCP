// Revin turns in the bot's history (src/revin/thread.js, src/revin/thread-read.js, 2026-10-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { mergeRevinTurns, revinThreadEnabled, toRevinTurn, simRevinFixture, REVIN_THREAD_LABEL } from '../src/revin/thread.js';
import { readRevinTurns } from '../src/revin/thread-read.js';
import { runWithSimOverrides } from '../src/simulator/sim-overrides.js';

const NOW = Date.parse('2026-10-19T18:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const CONTACT = 'abcdefghijKLMNOPqrst';

const conversation = [
  { direction: 'inbound', channel: 'sms', text: 'Hi, need windows', type: 'text', timestamp: iso(10 * 60_000) },
  { direction: 'outbound', channel: 'sms', text: 'Happy to help. How many?', type: 'text', timestamp: iso(9 * 60_000) },
];

test('flag off: the history is the SAME array and the database is never read', async () => {
  assert.equal(revinThreadEnabled({}), false);
  assert.equal(revinThreadEnabled({ BOT_INCLUDE_REVIN_THREAD: 'false' }), false);
  assert.equal(revinThreadEnabled({ BOT_INCLUDE_REVIN_THREAD: 'true' }), true);
  const supabase = fakeSupabase({ contact_thread_v: [{ ghl_contact_id: CONTACT, source: 'revin', direction: 'outbound', body: 'x', sent_at: iso(60_000) }] });
  const turns = await readRevinTurns(CONTACT, { env: {}, deps: { supabase }, nowMs: NOW });
  assert.deepEqual(turns, []);
  assert.equal(supabase.calls.length, 0);
  assert.equal(mergeRevinTurns(conversation, turns), conversation);
  assert.equal(mergeRevinTurns(conversation, undefined), conversation);
});

test('flag on: last 14 days of Revin texts, cleaned, labelled, screened once, call events left out', async () => {
  const supabase = fakeSupabase({
    contact_thread_v: [
      { ghl_contact_id: CONTACT, source: 'revin', direction: 'outbound', channel: 'sms', body: 'Still interested?\u{E0041}\u{E0042}', sent_at: iso(2 * 86_400_000) },
      { ghl_contact_id: CONTACT, source: 'revin', direction: 'inbound', channel: 'sms', body: 'maybe', sent_at: iso(2 * 86_400_000 - 60_000) },
      { ghl_contact_id: CONTACT, source: 'revin', direction: 'outbound', channel: 'call_event', body: 'call placed', sent_at: iso(86_400_000) },
      { ghl_contact_id: CONTACT, source: 'revin', direction: 'outbound', channel: 'sms', body: 'too old', sent_at: iso(20 * 86_400_000) },
      { ghl_contact_id: CONTACT, source: 'chatbot', direction: 'outbound', channel: 'sms', body: 'ours', sent_at: iso(60_000) },
      { ghl_contact_id: 'otherContact00000000', source: 'revin', direction: 'outbound', channel: 'sms', body: 'someone else', sent_at: iso(60_000) },
    ],
  });
  const guarded = [];
  const turns = await readRevinTurns(CONTACT, { env: { BOT_INCLUDE_REVIN_THREAD: 'true' }, deps: { supabase, guardInBackground: (a) => guarded.push(a) }, nowMs: NOW });
  assert.deepEqual(turns.map((t) => t.text), ['Still interested?', 'maybe'], 'oldest first, tag characters stripped');
  assert.ok(turns.every((t) => t.channel === REVIN_THREAD_LABEL && t.source === 'revin'));
  assert.equal(guarded.length, 1);
  assert.equal(guarded[0].surface, 'revin_thread');
  assert.equal(guarded[0].sourceRef, CONTACT);
  assert.ok(guarded[0].removedCount >= 1);
});

test('a failed read is [] (the reply goes on without Revin)', async () => {
  const supabase = { from: () => { throw new Error('db down'); } };
  assert.deepEqual(await readRevinTurns(CONTACT, { env: { BOT_INCLUDE_REVIN_THREAD: 'true' }, deps: { supabase }, nowMs: NOW }), []);
});

test('merge: by time, a text already in the history is not repeated, newest `cap` kept', () => {
  const revin = [
    toRevinTurn({ direction: 'outbound', body: 'Revin intro', sent_at: iso(86_400_000) }),
    toRevinTurn({ direction: 'outbound', body: 'Happy to help. How many?', sent_at: iso(9 * 60_000) }),
  ];
  const merged = mergeRevinTurns(conversation, revin);
  assert.deepEqual(merged.map((t) => t.text), ['Revin intro', 'Hi, need windows', 'Happy to help. How many?']);
  assert.equal(merged[0].channel, REVIN_THREAD_LABEL);
  assert.equal(mergeRevinTurns(conversation, revin, { cap: 2 }).length, 2);
  assert.equal(toRevinTurn({ direction: 'event', body: 'x', sent_at: iso(0) }), null);
  assert.equal(toRevinTurn({ direction: 'inbound', body: '  ', sent_at: iso(0) }), null);
});

test('the simulator override wins over the env, and the fixture is three Revin turns two days back', async () => {
  assert.equal(await runWithSimOverrides({ includeRevinThread: true }, async () => revinThreadEnabled({})), true);
  assert.equal(await runWithSimOverrides({ includeRevinThread: false }, async () => revinThreadEnabled({ BOT_INCLUDE_REVIN_THREAD: 'true' })), false);
  assert.equal(revinThreadEnabled({}), false, 'outside a run the override is gone');
  const fx = simRevinFixture(NOW, 'Dana');
  assert.equal(fx.length, 3);
  assert.match(fx[0].text, /^Hi Dana,/);
  assert.ok(fx.every((t) => Date.parse(t.timestamp) < NOW - 86_400_000));
});
