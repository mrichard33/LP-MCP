/**
 * Rehash replies show as the bot, never as John (the user, 2026-10-21,
 * REHASH_VOICE_MODE=team). Default `rep` is the 2026-10-01 voice, unchanged.
 *
 * Run: node --test scripts/test-rehash-voice.js
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
import test from 'node:test';
import assert from 'node:assert/strict';

const { rehashVoiceMode } = await import('../src/agentic/rehash.js');
const { postDemoRehash } = await import('../src/prompts/response-generator/playbooks.js');
const { resolveSmsSenderIdentity } = await import('../src/response-generator.js');
const { enforceTeamVoice } = await import('../src/agentic/team-voice.js');
const { planNepqTurn } = await import('../src/agentic/nepq-planner.js');
const { runWithSimOverrides } = await import('../src/simulator/sim-overrides.js');

test('mode: default rep; team by env or a gate override', () => {
  assert.equal(rehashVoiceMode({}), 'rep');
  assert.equal(rehashVoiceMode({ REHASH_VOICE_MODE: 'team' }), 'team');
  assert.equal(runWithSimOverrides({ rehashVoiceMode: 'team' }, () => rehashVoiceMode({})), 'team');
});

test('prompt: rep mode is the copy before, byte for byte; team mode writes as the Reece Team and names John in the third person', () => {
  assert.deepEqual(postDemoRehash('John', { callTimes: true, betterPrice: true }), postDemoRehash('John', { callTimes: true, betterPrice: true, teamVoiceRep: null }));
  const team = postDemoRehash(null, { callTimes: true, betterPrice: true, teamVoiceRep: 'John' }).join('\n');
  assert.match(team, /Write as the Reece Team, never as John/);
  assert.match(team, /a quick call with John/);
  assert.doesNotMatch(team, /You are John/);
});

test('sign-off: team mode signs "Reece Team"; a "— John" the model writes is corrected', () => {
  assert.equal(resolveSmsSenderIdentity('+17278004578', { rehash: { active: true, repName: null } }).signature, 'Reece Team');
  assert.equal(resolveSmsSenderIdentity('+17278004578', { rehash: { active: true, repName: 'John' } }).signature, 'John');
  assert.match(enforceTeamVoice('Sounds good. — John', { forbidNames: ['John'] }).text, /— Reece Team$/);
  assert.match(enforceTeamVoice("I'm John, from the follow-up team. John can give you a quick call.", { forbidNames: ['John'] }).text, /^This is the Reece Team\. John can give you a quick call\.$/);
  assert.equal(enforceTeamVoice('Sounds good. — John').text, 'Sounds good. — John', 'rep mode: no forbidden names');
});

test('planner: with no rep to speak as, the booked call names John ("John will call you"), never "I\'ll call you"', () => {
  const NOW = Date.parse('2026-10-20T20:50:00Z');
  const A = { iso: '2026-10-21T13:30:00Z', day: 'Wed, Oct 21', time: '9:30 AM', dayOfWeek: 'Wednesday', rel: 'tomorrow', tz: 'ET' };
  const B = { iso: '2026-10-21T14:30:00Z', day: 'Wed, Oct 21', time: '10:30 AM', dayOfWeek: 'Wednesday', rel: 'tomorrow', tz: 'ET' };
  const p = planNepqTurn({
    channel: 'sms', trigger: '9:30', conversation: [{ direction: 'outbound', text: 'I have tomorrow at 9:30 AM ET or tomorrow at 10:30 AM ET. Which works better?' }],
    slots: [], tzLabel: 'ET', firstName: 'Pat', discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW,
    postDemo: true, rehashRep: null, rehash: true, callSlots: { calendarId: 'cal', rep: 'u1', repName: 'John', offer: [A, B], all: [A, B] },
  });
  assert.equal(p.step, 'rehash_confirm');
  assert.match(p.reference_line, /John will call you/);
  assert.doesNotMatch(p.reference_line, /\bI'll call you\b/);
});
