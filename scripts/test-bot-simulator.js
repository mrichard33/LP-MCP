/**
 * Bot simulator — scripts/test-bot-simulator.js
 *
 * 2026-10-02: the simulator runs scripted conversations through the real bots
 * with every outward effect recorded (src/simulator/bot-simulator.js). These
 * tests swap the model for a canned one and prove: the transcript carries
 * each turn and reply, a fixed NEPQ move needs no model call, the cancel →
 * reschedule flow records "would move the same appointment" instead of doing
 * it, and the SMS side always runs dry with the simulated thread.
 *
 * Run: node --test scripts/test-bot-simulator.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { simulateLiveChat, simulateSms, resolveScenario, formatTranscript, runSimulation, SCENARIOS } = await import('../src/simulator/bot-simulator.js');
const { parseSimRequest } = await import('../src/tools/simulator-tools.js');

const SLOTS = [{ iso: '2026-10-06T14:00:00Z', day: 'Tue, Oct 6', time: '10:00 AM', dayOfWeek: 'Tuesday' }, { iso: '2026-10-07T18:00:00Z', day: 'Wed, Oct 7', time: '2:00 PM', dayOfWeek: 'Wednesday' }];
function fakeProduction() {
  const calls = { llm: 0 };
  return {
    calls,
    deps: {
      prewarmEmbedding: () => null,
      buildKbPack: async () => null,
      classify: async () => ({ intent_class: 'UNCLEAR', confidence: 0, classification_method: 'test' }),
      callLLM: async () => { calls.llm++; return { text: JSON.stringify({ message: 'Drafty? How long has that been going on?', story_arc: 'none' }), model: 'fake' }; },
      checkServiceArea: async () => ({ checked: false }),
      lookupPlace: async () => ({ checked: false }),
      zoneForZip: async () => null,
      offerSlots: async () => ({ slots: SLOTS, tzLabel: 'ET' }),
      offerBookingSlots: async () => ({ slots: SLOTS, tzLabel: 'ET', calendarId: 'CAL' }),
      hardTimeoutMs: () => 3000,
      contextCapMs: () => 200,
      // A real write that must never be reached: the simulator overrides it.
      sendMessage: async () => { throw new Error('REAL SEND CALLED'); },
      insertAction: async () => { throw new Error('REAL INSERT CALLED'); },
    },
  };
}

test('live chat: every turn and reply, a fixed price move needs no model call', async () => {
  const { calls, deps } = fakeProduction();
  const r = await simulateLiveChat(resolveScenario({ scenario: 'price' }), { nepqMode: 'live', productionDeps: deps });
  assert.equal(r.transcript.length, 2);
  assert.match(r.transcript[0].bot[0], /^Happy to get you a quote/);
  assert.match(r.transcript[1].bot[0], /^Totally fair\. Every home is different/);
  assert.equal(calls.llm, 0);
});

test('live chat: cancel → reschedule moves nothing, it records "would move the same appointment"', async () => {
  const { deps } = fakeProduction();
  const r = await simulateLiveChat(resolveScenario({ scenario: 'cancel_reschedule' }), { nepqMode: 'live', productionDeps: deps });
  const bot = r.transcript.map(t => (t.bot || []).join(' ')).join('\n');
  assert.match(bot, /full name and phone number/);
  assert.match(bot, /different day work better/);
  assert.match(bot, /Which one works better for you\?/);
  assert.match(bot, /You're now set for Tue, Oct 6 at 10:00 AM/);
  assert.ok(r.would_do.some(w => w.kind === 'would_move_same_appointment_in_ghl' && w.new_start === '2026-10-06T14:00:00Z'));
  assert.ok(r.would_do.some(w => w.kind === 'would_post_dispatch_card' && w.card === 'rescheduled'));
});

test('live chat: a normal turn uses the model and the thread grows with each reply', async () => {
  const { calls, deps } = fakeProduction();
  const r = await simulateLiveChat(resolveScenario({ turns: ['Hi there', 'they are drafty'] }), { nepqMode: 'off', productionDeps: deps });
  assert.equal(calls.llm >= 2, true);
  assert.equal(r.transcript[1].bot.length, 1);
  assert.match(formatTranscript(r), /Customer: they are drafty\n  Bot: {6}/);
});

test('SMS: always dry-run, the simulated thread, the NEPQ override, one redraft on a guard note', async () => {
  const seen = [];
  let first = true;
  const generate = async (contactId, channel, msg, opts) => {
    seen.push({ contactId, channel, msg, opts });
    if (first) { first = false; const e = new Error('conversation_repetition: two questions'); e.regenerationNote = 'fix it'; throw e; }
    return { message: `Reply to: ${msg}`, nepq_plan: { move: 'probe' }, nepq_handoff: msg === 'No' ? { reason: 'two_nos' } : null };
  };
  const r = await simulateSms(resolveScenario({ scenario: 'not_interested' }), { nepqMode: 'live', generate });
  assert.ok(seen.every(s => s.opts.dryRun === true && s.opts.nepqModeOverride === 'live' && s.contactId.startsWith('sim-')));
  assert.equal(seen[1].opts.regenerationNote, 'fix it');
  assert.equal(r.transcript[0].redrafted, true);
  assert.equal(r.transcript[0].redraft_guard, 'conversation_repetition');
  assert.equal(r.transcript[0].attempts.length, 2);
  assert.match(formatTranscript(r), /redraft=conversation_repetition \(\d+(?:\.\d)?s \+ \d+(?:\.\d)?s\)/);
  const last = seen[seen.length - 1].opts.simulatedContext.conversation_recent;
  assert.deepEqual(last.map(m => m.direction), ['inbound', 'outbound', 'inbound'], 'the bot\'s own reply is in the next turn\'s thread');
  assert.ok(r.transcript[1].would_do.some(w => w.reason === 'two_nos'));
});

test('live-chat-only scenarios skip SMS; request parsing refuses bad input', async () => {
  const { deps } = fakeProduction();
  const out = await runSimulation({ scenario: 'spanish', channel: 'both', nepqMode: 'live' }, { productionDeps: async () => deps, generate: async () => { throw new Error('should not run'); } });
  assert.deepEqual(out.map(o => o.channel), ['livechat']);
  assert.throws(() => parseSimRequest({ scenario: 'nope' }), /scenario must be one of/);
  assert.throws(() => parseSimRequest({ messages_json: '"hi"' }), /JSON array/);
  assert.equal(parseSimRequest({ messages_json: '["hi"]' }).turns[0], 'hi');
  assert.ok(Object.keys(SCENARIOS).length >= 14);
});
