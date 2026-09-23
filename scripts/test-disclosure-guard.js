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

// ══════════════════════════════════════════════════════════════════════════
// THE APPROVED SCRIPT MUST SURVIVE THE GUARD
//
// Added 2026-09-23 after the wording shipped in PR #1016 — "If you'd rather
// speak with a LIVE PERSON, I can get that set up" — turned out to trip the
// guard's own /live (rep|agent|person|human)/ pattern. The guard did exactly
// what it was built to do and replaced the entire body with
// DISCLOSURE_FALLBACK, so the owner-approved wording never reached a single
// customer, and every send fired a high-priority
// agentic.disclosure_guard_triggered event.
//
// 22 tests were green at the time. Every one of them tested the GUARD's
// patterns; none tested the SCRIPT against the guard. That gap is this block.
//
// The variants are IMPORTED, never re-typed — a copy in the test would drift
// from the shipped prompt and re-open the hole it exists to close.
// ══════════════════════════════════════════════════════════════════════════

const { APPROVED_DISCLOSURE_VARIANTS, SYSTEM_IDENTITY_AND_VOICE } =
  await import('../src/prompts/response-generator/system-core.js');

test('every approved disclosure variant passes the guard unblocked', () => {
  const entries = Object.entries(APPROVED_DISCLOSURE_VARIANTS);
  assert.ok(entries.length >= 1, 'expected at least one approved variant to be exported');

  for (const [name, body] of entries) {
    const result = guardDisclosure(body);
    assert.equal(
      result.blocked,
      false,
      `approved variant "${name}" is BLOCKED by the disclosure guard ` +
      `(pattern: ${result.pattern}). The customer would receive the fallback, ` +
      `not this wording. Reword the variant — do not weaken the guard.`,
    );
    assert.equal(result.body, body, `variant "${name}" must pass through byte-identical`);
  }
});

test('the PR #1016 wording that caused this test still fails the guard', () => {
  // The regression itself. If this ever stops being blocked, the guard has
  // been weakened and the 2026-07-03 incident is back in reach.
  const shipped1016 =
    "Yes — I'm a digital representative for Reece, here to help however I can. " +
    "If you'd rather speak with a live person, I can get that set up. What can I help you with?";
  const result = guardDisclosure(shipped1016);
  assert.equal(result.blocked, true, 'the "live person" wording must still be caught');
  assert.equal(result.body, DISCLOSURE_FALLBACK);
});

test('the approved variants are actually rendered into the system prompt', () => {
  // Exporting them is not enough — a variant that never reaches the prompt is
  // a constant the guard test happily validates while the model never sees it.
  for (const [name, body] of Object.entries(APPROVED_DISCLOSURE_VARIANTS)) {
    assert.ok(
      SYSTEM_IDENTITY_AND_VOICE.includes(body),
      `approved variant "${name}" is exported but not present in the system prompt`,
    );
  }
});

test('the disclosure fallback itself survives the guard', () => {
  // It is the replacement body. If it were ever caught, the guard would have
  // nothing safe to substitute.
  assert.equal(guardDisclosure(DISCLOSURE_FALLBACK).blocked, false);
});

test('the disclosure is an OPENING, not the whole reply', () => {
  // The approved script answers "are you a bot" and stops. If the model treated
  // it as the complete message, every disclosure turn would drop whatever the
  // lead actually asked — which is the same "deflecting an easy question"
  // failure the ANSWER FIRST rule exists to prevent.
  assert.match(
    SYSTEM_IDENTITY_AND_VOICE,
    /IN THE SAME MESSAGE, continue naturally with their original question/,
  );
});

test('no sendable text carries a bracketed stage direction', () => {
  // "[Continue naturally with their original question.]" is an instruction TO
  // the model. A variant containing a bracketed placeholder would be copied
  // into the SMS verbatim — the same class of bug as the "{{custom_values.rep_name}}"
  // merge tag that shipped raw to Kelly Callahan.
  for (const [name, body] of Object.entries(APPROVED_DISCLOSURE_VARIANTS)) {
    assert.doesNotMatch(body, /\[[^\]]+\]/, `variant "${name}" contains a bracketed placeholder`);
    assert.doesNotMatch(body, /\{\{/, `variant "${name}" contains a raw merge tag`);
  }
});

test('the approved script keeps the two lines that earn the trust', () => {
  // Regression on CONTENT, not just deliverability. Three rewrites in one day
  // each dropped one of these: the REASON the automation exists ("so nobody's
  // left waiting") and the answer to the real worry behind "is this a bot"
  // ("someone on the team sees every conversation" — am I shouting into a void).
  const script = APPROVED_DISCLOSURE_VARIANTS.standard;
  assert.match(script, /nobody's left waiting/);
  assert.match(script, /sees every conversation/);
  // And it must never re-acquire what broke the earlier scripts.
  assert.doesNotMatch(script, /\b(he|him|his|she|her|hers)\b/i, 'no gendered pronoun');
  assert.doesNotMatch(script, /\{\{/, 'no rep-name dependency');
});
