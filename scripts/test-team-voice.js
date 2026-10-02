/**
 * test-team-voice.js — 2026-10-02 (Mark): the bots are "the Reece Team", never
 * a person, and Randy's father founded Reece in 1972 (not Randy).
 *
 * Run: node --test scripts/test-team-voice.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { enforceTeamVoice } = await import('../src/agentic/team-voice.js');

test('break test replies: "I\'m Mark" and "Randy founded" are corrected', () => {
  const chat = enforceTeamVoice("Randy is our founder. I'm Mark, handling chat here in the office. What can we help you with today?");
  assert.equal(chat.text, "Randy's father founded Reece. This is the Reece Team. What can we help you with today?");
  const sms = enforceTeamVoice("This is Mark, and this is a shared Reece team line. Randy founded the company back in 1972, but he's not taking chats directly here.");
  assert.match(sms.text, /^This is the Reece Team, and this is a shared Reece team line\./);
  assert.match(sms.text, /Randy's father founded the company back in 1972/);
  assert.deepEqual(sms.changes.sort(), ['founder', 'team_identity']);
});

test('sign-offs and "Mark here" become the team', () => {
  assert.equal(enforceTeamVoice('Thanks! — Mark').text, 'Thanks! — Reece Team');
  assert.equal(enforceTeamVoice('Mark here. Happy to help.').text, 'This is the Reece Team. Happy to help.');
  assert.equal(enforceTeamVoice('Reece was founded by Randy Reece in 1972.').text, "Reece was founded by Randy's father in 1972.");
});

test('a customer named Mark, and correct facts, are left alone', () => {
  for (const t of ["Sounds good, Mark. You're set for Tuesday.", "I'm happy to help with that.", "Randy's father founded Reece in 1972.", 'Family-owned since 1972, serving Florida since 2005.']) {
    assert.deepEqual(enforceTeamVoice(t), { text: t, changes: [] }, t);
  }
});

test('the rehash rep keeps their own name; the founder fact is still corrected', () => {
  const out = enforceTeamVoice('This is Dana from Reece. Randy founded it.', { allowName: 'Dana' });
  assert.equal(out.text, "This is Dana from Reece. Randy's father founded it.");
});
