/**
 * Unit coverage for buildNepqBlock() — src/agentic/nepq-layer.js.
 *
 * The commitment gate is the load-bearing part: a booked homeowner is a
 * customer, not a prospect, and running discovery at them reads as the
 * company having forgotten who they are. That is what happened to Myron
 * Thorner (q5GehRye7DNkN6jlmjl3) on 2026-08-28 — Stage 5, booked, and the
 * bot ran generic reassurance at him through his own appointment window.
 *
 * Run: node --test scripts/test-nepq-layer.js
 */
import test from 'node:test';
import assert from 'node:assert';
import { buildNepqBlock, NEPQ_LAYER_VERSION } from '../src/agentic/nepq-layer.js';

const DISCOVERY_OFF = /NEPQ DISCOVERY IS OFF/;
const LIVE_WINDOW = /THE APPOINTMENT WINDOW IS LIVE OR PASSED/;

// ── The commitment gate ──────────────────────────────────────────────

test('THE GATE: a booked contact turns discovery OFF regardless of stage', () => {
  for (const stage of [null, 1, 2, 3, 4, 5]) {
    const b = buildNepqBlock({ lp: { appointment_set: true }, intelligence: { buyer_stage: stage } });
    assert.match(b, DISCOVERY_OFF, `discovery not gated off at buyer_stage ${stage}`);
    assert.ok(!/STAGE: CONNECTION|SITUATION → PROBLEM|SOLUTION AWARENESS|CONSEQUENCE → QUALIFYING/.test(b),
      `a discovery stage block leaked through the gate at buyer_stage ${stage}`);
  }
});

test('a live or passed window adds the get-a-human-on-the-phone instruction', () => {
  for (const phase of ['in_window', 'past']) {
    const b = buildNepqBlock({ lp: { appointment_set: true, appointment_phase: phase } });
    assert.match(b, DISCOVERY_OFF);
    assert.match(b, LIVE_WINDOW, `live-window instruction missing for phase ${phase}`);
  }
});

test('a still-upcoming appointment gates discovery but does not claim the window is live', () => {
  for (const phase of ['scheduled', 'imminent', null]) {
    const b = buildNepqBlock({ lp: { appointment_set: true, appointment_phase: phase } });
    assert.match(b, DISCOVERY_OFF);
    assert.ok(!LIVE_WINDOW.test(b), `window falsely reported live for phase ${phase}`);
  }
});

// ── Stage routing for unbooked contacts ──────────────────────────────

test('unbooked contacts route to their stage block and never see the gate', () => {
  const cases = [
    [null, /STAGE: CONNECTION/],
    [1, /STAGE: CONNECTION/],
    [2, /SITUATION → PROBLEM AWARENESS/],
    [3, /STAGE: SOLUTION AWARENESS/],
    [4, /CONSEQUENCE → QUALIFYING → TRANSITION/],
  ];
  for (const [stage, expected] of cases) {
    const b = buildNepqBlock({ lp: { appointment_set: false }, intelligence: { buyer_stage: stage } });
    assert.match(b, expected, `wrong stage block for buyer_stage ${stage}`);
    assert.ok(!DISCOVERY_OFF.test(b), `commitment gate fired for unbooked buyer_stage ${stage}`);
  }
});

test('an empty context degrades to CONNECTION rather than throwing', () => {
  assert.match(buildNepqBlock({}), /STAGE: CONNECTION/);
  assert.match(buildNepqBlock(undefined), /STAGE: CONNECTION/);
});

test('appointment_set must be exactly true — a truthy string does not gate', () => {
  // The gate reads lp.appointment_set === true. context-builder always emits a
  // real boolean; this pins that contract so a stringified feed cannot silently
  // open discovery on a booked customer without failing here first.
  assert.ok(!DISCOVERY_OFF.test(buildNepqBlock({ lp: { appointment_set: 'true' } })),
    'gate semantics changed — if appointment_set may now be a string, widen the check in stageBlock');
});

// ── Always-on discipline ─────────────────────────────────────────────

test('tonality, probe patterns, and consequence caps ride every block', () => {
  for (const ctx of [{}, { lp: { appointment_set: true } }, { intelligence: { buyer_stage: 4 } }]) {
    const b = buildNepqBlock(ctx);
    assert.match(b, /ONE question per message/);
    assert.match(b, /WHEN THEY ARE VAGUE/);
    assert.match(b, /CONSEQUENCE QUESTIONS — STRICT CAPS/);
    assert.match(b, /Maximum ONE consequence question per conversation/);
    assert.match(b, /POST-BOOKING DISCLOSURE/);
  }
});

test('the regulated-trade bans are stated verbatim, not paraphrased away', () => {
  const b = buildNepqBlock({});
  for (const ban of [
    /NEVER about physical danger/,
    /NEVER name an insurance carrier/,
    /NEVER predict a claim outcome/,
    /NEVER promise or imply a price reduction/,
    /NEVER invent a deadline/,
  ]) {
    assert.match(b, ban);
  }
});

// ── Kill switch ──────────────────────────────────────────────────────

test('NEPQ_LAYER_MODE=off returns an empty string', () => {
  const prior = process.env.NEPQ_LAYER_MODE;
  try {
    process.env.NEPQ_LAYER_MODE = 'off';
    assert.equal(buildNepqBlock({ lp: { appointment_set: true } }), '');
  } finally {
    if (prior === undefined) delete process.env.NEPQ_LAYER_MODE;
    else process.env.NEPQ_LAYER_MODE = prior;
  }
});

test('any other NEPQ_LAYER_MODE value leaves the layer ON', () => {
  const prior = process.env.NEPQ_LAYER_MODE;
  try {
    for (const v of ['', 'on', 'true', 'OFF']) {
      process.env.NEPQ_LAYER_MODE = v;
      assert.notEqual(buildNepqBlock({}), '', `layer disabled by NEPQ_LAYER_MODE=${v}`);
    }
  } finally {
    if (prior === undefined) delete process.env.NEPQ_LAYER_MODE;
    else process.env.NEPQ_LAYER_MODE = prior;
  }
});

test('version constant is exported', () => {
  assert.equal(typeof NEPQ_LAYER_VERSION, 'string');
});
