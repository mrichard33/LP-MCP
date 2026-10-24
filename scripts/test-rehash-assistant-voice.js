// REHASH_VOICE_MODE=assistant (the user, 2026-10-24): a post-demo lead talks to
// the rehash rep's virtual assistant. "Are you AI?" gets the assistant
// disclosure, never a denial; the bot is never the rep and never a person.
import test from 'node:test';
import assert from 'node:assert/strict';

const { rehashVoiceMode, REHASH_VOICE_MODES } = await import('../src/agentic/rehash.js');
const { resolveSmsSenderIdentity, decideSmsLength } = await import('../src/response-generator.js');
const P = await import('../src/prompts/response-generator/index.js');
const { enforceTeamVoice } = await import('../src/agentic/team-voice.js');
const { guardDisclosure } = await import('../src/agentic/reply-sender.js');

test('the switch takes assistant; anything unknown stays rep', () => {
  assert.ok(REHASH_VOICE_MODES.includes('assistant'));
  assert.equal(rehashVoiceMode({ REHASH_VOICE_MODE: 'assistant' }), 'assistant');
  assert.equal(rehashVoiceMode({ REHASH_VOICE_MODE: 'bogus' }), 'rep');
});

test('the assistant signs as the rep\'s assistant and says so when asked', () => {
  const id = resolveSmsSenderIdentity('7278004578', { rehash: { active: true, repName: null, voice: 'assistant', callRepName: 'John' } });
  assert.equal(id.persona, 'rehash_assistant');
  assert.equal(id.signature, "John's assistant");
  assert.equal(id.nameIfAsked, "John's virtual assistant");
  assert.equal(id.shared, false);
  // team voice is unchanged
  const team = resolveSmsSenderIdentity('7278004578', { rehash: { active: true, repName: null, voice: 'team', callRepName: 'John' } });
  assert.equal(team.signature, 'Reece Team');
});

test('the assistant disclosure never denies being a bot, and is exempt from the length cap', () => {
  const d = P.assistantDisclosure('John');
  assert.match(d, /^Fair question\. I'm John's virtual assistant, an AI, not a person\./);
  assert.doesNotMatch(d, /\b(?:he|him|his|she|her)\b/i, 'no pronoun for the rep');
  assert.equal(guardDisclosure(d).blocked, false);
  assert.ok(P.isAssistantDisclosure(d));
  assert.equal(decideSmsLength(`${d} ${'x'.repeat(200)}`).action, 'exempt');
});

test('the bot is never the rep: "I\'m John" and "— John" are rewritten, "John\'s assistant" stays', () => {
  assert.match(enforceTeamVoice("Hi Mark, I'm John. Happy to help.", { forbidNames: ['John'] }).text, /this is the Reece Team/i);
  assert.match(enforceTeamVoice('Talk soon — John', { forbidNames: ['John'] }).text, /Reece Team$/);
  const keep = "Hi Mark, this is John's assistant. John can give you a quick call. — John's assistant";
  assert.equal(enforceTeamVoice(keep, { forbidNames: ['John'] }).text, keep);
});

test('the playbook: the assistant voice names the rep, offers come from the rep; team copy is unchanged', () => {
  const a = P.postDemoRehash(null, { assistantRep: 'John', betterPrice: true }).join('\n');
  assert.match(a, /You are John's virtual assistant/);
  assert.match(a, /NEVER GUESS/);
  assert.match(a, /Never a pronoun for John/);
  assert.match(a, /If John could get you a better price/);
  assert.doesNotMatch(a, /"If I could get you a better price/);
  const t1 = P.postDemoRehash(null, { teamVoiceRep: 'John', betterPrice: true }).join('\n');
  const t2 = P.postDemoRehash(null, { teamVoiceRep: 'John', betterPrice: true, assistantRep: null }).join('\n');
  assert.equal(t1, t2);
  assert.match(t1, /If I could get you a better price/);
});

test('the assistant line identity says who is writing', () => {
  const lines = P.assistantLineIdentity('John').join('\n');
  assert.match(lines, /John's virtual assistant/);
  assert.match(lines, /never John and never a person/);
});

test('the assistant never offers a price itself: "If I could" moves to the rep, other "I" lines stay', async () => {
  const { assistantOfferLine, assistantPlan } = await import('../src/services/assistant-voice.js');
  assert.equal(assistantOfferLine('If I could get you a better price, would you be open to a quick call with John?', 'John').text,
    'If John could get you a better price, would you be open to a quick call?');
  assert.equal(assistantOfferLine("Good question. I don't know, so I'll leave John a note.", 'John').changed, false);
  assert.equal(assistantOfferLine('I hear you.\nI may be able to help.\n— John\'s assistant', 'John').text, "I hear you.\nJohn may be able to help.\n— John's assistant");
  assert.equal(assistantPlan({ fixed_line: 'If I could beat that, would a quick call with John help?', step: 'x' }, 'John').fixed_line,
    'If John could beat that, would a quick call help?');
});
