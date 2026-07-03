/**
 * test-disclosure-guard.js — AI-disclosure hard output guard
 * (2026-07-03 incident: "Real person here, Steve" / "you're talking to a
 * live rep" shipped in production in response to "This is AI?").
 *
 * The guard runs on EVERY outbound body regardless of the generation
 * prompt. Each block pattern must trigger a full-body replacement with the
 * disclosure fallback; clean bodies must pass untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { guardDisclosure, DISCLOSURE_FALLBACK } = await import('../src/agentic/reply-sender.js');

const BLOCKED_BODIES = [
  // the two real production violations
  'Real person here, Steve',
  "you're talking to a live rep",
  // each handoff block pattern
  'Yes, this is a real person on the line.',
  'You have a live agent with you today.',
  'Our live person will keep helping you here.',
  "I'm a human, I promise.",
  'I am definitely a human.',
  "I'm totally human!",
  "I'm not a bot, just here to help.",
  'This is not an AI.',
  'not a robot — just Steve from the office',
  "You're talking to a person, not a machine.",
  'you are talking to a human right now',
];

for (const body of BLOCKED_BODIES) {
  test(`blocks human-claim: "${body.slice(0, 40)}"`, () => {
    const g = guardDisclosure(body);
    assert.equal(g.blocked, true, `expected blocked for: ${body}`);
    assert.equal(g.body, DISCLOSURE_FALLBACK);
    assert.ok(g.pattern, 'matched pattern recorded');
  });
}

test('case-insensitive: "REAL PERSON HERE" is blocked', () => {
  const g = guardDisclosure('REAL PERSON HERE');
  assert.equal(g.blocked, true);
});

const CLEAN_BODIES = [
  'Good question — happy to help with your window quote.',
  'We can have a team member call you tomorrow morning.',
  "I'm an AI assistant helping the Reece Windows & Doors team respond quickly.",
  'Your appointment is confirmed for Tuesday at 2 PM.',
  'Our founder Randy has seen storms take out cheap windows.',
  'We live and work here in South Florida too.', // "live" without rep/agent/person/human
];

for (const body of CLEAN_BODIES) {
  test(`passes clean body: "${body.slice(0, 40)}"`, () => {
    const g = guardDisclosure(body);
    assert.equal(g.blocked, false, `false positive on: ${body}`);
    assert.equal(g.body, body);
  });
}

test('the disclosure fallback itself passes the guard (no self-block loop)', () => {
  const g = guardDisclosure(DISCLOSURE_FALLBACK);
  assert.equal(g.blocked, false);
});

test('null/empty bodies pass through without throwing', () => {
  assert.equal(guardDisclosure('').blocked, false);
  assert.equal(guardDisclosure(null).blocked, false);
  assert.equal(guardDisclosure(undefined).blocked, false);
});
