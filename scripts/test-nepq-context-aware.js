/**
 * test-nepq-context-aware.js — the guard on NEPQ layer v1.2 and the two
 * deterministic conversation guards in src/response-generator.js.
 *
 * Anchored to the 2026-09-11 Alfredo Fontan thread (GHL VKMKhd8JQ4wsp3zMn8Lt).
 * The message under test throughout is outbound yFkfGW3AOmm9M8Myk7W8, sent
 * 21:11:55Z:
 *
 *   "Fair point, Alfredo — close is close. To get the visit scheduled
 *    correctly, will it just be you home, or is there someone else who'd
 *    want to be there?"
 *
 * It contains both defects this file exists to prevent: it re-asks a question
 * he answered at 19:37:37Z, and it concedes his objection before pivoting off
 * it.
 *
 * Run: node --test scripts/test-nepq-context-aware.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEPQ_LAYER_MODE = 'on';
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { buildNepqBlock, objectionBlock, establishedBlock, NEPQ_LAYER_VERSION } =
  await import('../src/agentic/nepq-layer.js');
const { buildEstablishedFacts } = await import('../src/agentic/established-facts.js');
const { findRepeatedQuestions, findConcessionPivots } =
  await import('../src/response-generator.js');

// ── The real outbound ───────────────────────────────────────────────────
const THE_21_11_MESSAGE =
  "Fair point, Alfredo — close is close. To get the visit scheduled correctly, " +
  "will it just be you home, or is there someone else who'd want to be there?";

// ── His established facts at 21:11:55Z ──────────────────────────────────
// The CRM field GH1QGGOseMKmJAMqajiN was still EMPTY — it was not written
// until 21:25:22Z. Only the transcript knew.
const ALFREDO_ESTABLISHED = buildEstablishedFacts({
  conversation: [
    {
      direction: 'outbound', channel: 'sms', timestamp: '2026-09-11T19:35:10Z',
      text: 'Before we get someone out — will anyone else be part of the decision, or is it just you?',
    },
    { direction: 'inbound', channel: 'sms', timestamp: '2026-09-11T19:37:37Z', text: 'Just myself.' },
    {
      direction: 'outbound', channel: 'sms', timestamp: '2026-09-11T19:50:00Z',
      text: 'Have you had anyone out to look at them before? How did that go?',
    },
    {
      direction: 'inbound', channel: 'sms', timestamp: '2026-09-11T19:54:44Z',
      text: 'I have sat through several presentations already and the last company that came out '
        + 'gave me a number very close to what I expected. I almost signed with them that evening.',
    },
  ],
  lead: { name: 'Alfredo Fontan', decision_makers_present: null, trust_level_score: 3 },
  intelligence: { buyer_stage: 3 },
  timezone: 'America/New_York',
});

/** A lead context at a given stage / trust / booking state. */
function ctx({ stage = 3, trust = 3, booked = false, objection = null, phase = null } = {}) {
  return {
    lead: { name: 'Alfredo Fontan', trust_level_score: trust },
    intelligence: { buyer_stage: stage },
    lp: { appointment_set: booked, appointment_phase: phase },
    objection_state: objection ? { state_code: objection, parent_state: 'PRICE', attempt_number: 1 } : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Stage subtraction
// ═══════════════════════════════════════════════════════════════════

test('layer reports v1.3', () => {
  assert.equal(NEPQ_LAYER_VERSION, '1.3');
});

test('stage 3 with prior_quotes closed drops the "had anyone out before" example', () => {
  const block = buildNepqBlock(ctx({ stage: 3 }), ALFREDO_ESTABLISHED);

  assert.ok(ALFREDO_ESTABLISHED.closed_questions.includes('prior_quotes'),
    'fixture precondition: he told us about the other companies');
  assert.equal(/Have you had anyone out to look at them before\?/.test(block), false,
    'this is the question the layer offered a man who had just described several presentations');
  assert.equal(/How did that go\?/.test(block), false);
  assert.match(block, /PAST: ALREADY COVERED/);
});

test('stage 3 with prior_quotes OPEN still offers the past-half questions', () => {
  const block = buildNepqBlock(ctx({ stage: 3 }), { closed_questions: [], facts: [], objections_raised: [] });
  assert.match(block, /Have you had anyone out to look at them before\?/);
});

test('stage 4 drops the decision-maker qualifier once it is closed', () => {
  const block = buildNepqBlock(ctx({ stage: 4 }), ALFREDO_ESTABLISHED);
  assert.equal(/Would anyone else be looking at this with you/.test(block), false);
});

test('a stage emptied by subtraction says discovery is complete, not "ask something else"', () => {
  const allClosed = { closed_questions: ['timeline', 'decision_makers'], facts: [], objections_raised: [] };
  const block = buildNepqBlock(ctx({ stage: 4 }), allClosed);
  assert.match(block, /QUALIFYING IS DONE/);
  assert.equal(/Would anyone else be looking at this with you/.test(block), false);
});

test('untagged feeling questions are never subtracted', () => {
  const block = buildNepqBlock(ctx({ stage: 3 }), ALFREDO_ESTABLISHED);
  assert.match(block, /what would that change day to day/,
    'no closed fact can answer how they would feel about it being handled');
});

// ═══════════════════════════════════════════════════════════════════
// The objection block — the piece that did not exist
// ═══════════════════════════════════════════════════════════════════

test('objectionBlock renders only when an objection state is open', () => {
  assert.equal(objectionBlock(ctx({ objection: null }), ALFREDO_ESTABLISHED), '');
  assert.notEqual(objectionBlock(ctx({ objection: 'PRICE_TOO_HIGH' }), ALFREDO_ESTABLISHED), '');
});

test('objectionBlock bans the concession openers by name', () => {
  const block = objectionBlock(ctx({ objection: 'PRICE_TOO_HIGH' }), ALFREDO_ESTABLISHED);
  for (const opener of ['Fair point', "You're right", 'I understand that', 'That makes sense', 'Absolutely']) {
    assert.ok(block.includes(opener), `the block must name "${opener}" as banned`);
  }
  assert.match(block, /THE PLAY IS TO ASK BACK/);
  assert.match(block, /It is a defect\./);
});

test('objectionBlock carries the real worked example', () => {
  const block = objectionBlock(ctx({ objection: 'PRICE_TOO_HIGH' }), ALFREDO_ESTABLISHED);
  assert.match(block, /"close is close"/);
  assert.match(block, /how close does it need to be before you'd sign off/);
});

test('objectionBlock keeps the compliance caps', () => {
  const block = objectionBlock(ctx({ objection: 'PRICE_TOO_HIGH' }), ALFREDO_ESTABLISHED);
  assert.match(block, /Never invent a deadline/);
  assert.match(block, /Never promise or imply a price reduction/);
  assert.match(block, /Never name an insurance carrier/);
});

test('a twice-raised objection stops asking and offers a person', () => {
  const repeated = {
    closed_questions: [], facts: [],
    objections_raised: [{ type: 'price' }, { type: 'price' }],
  };
  const block = objectionBlock(ctx({ objection: 'PRICE_TOO_HIGH' }), repeated);
  assert.match(block, /RAISED TWICE/);
  assert.match(block, /STOP ASKING/);
  assert.match(block, /person on the phone/);
  assert.equal(/THE PLAY IS TO ASK BACK/.test(block), false, 'the ask-back play is wrong on a repeat');
});

// ═══════════════════════════════════════════════════════════════════
// Established block + tonality
// ═══════════════════════════════════════════════════════════════════

test('establishedBlock lists closed questions and is empty when nothing is closed', () => {
  assert.match(establishedBlock(ALFREDO_ESTABLISHED), /decision_makers/);
  assert.equal(establishedBlock({ closed_questions: [] }), '');
  assert.equal(establishedBlock(null), '');
});

test('TONALITY carries the binding closed-question line', () => {
  const block = buildNepqBlock(ctx({}), ALFREDO_ESTABLISHED);
  assert.match(block, /Never ask a question listed as closed in ESTABLISHED/);
});

// ═══════════════════════════════════════════════════════════════════
// Trust coupling
// ═══════════════════════════════════════════════════════════════════

test('trust below 3 runs repair, not discovery and not a booking push', () => {
  const block = buildNepqBlock(ctx({ stage: 3, trust: 2 }), { closed_questions: [], facts: [], objections_raised: [] });
  assert.match(block, /STAGE: REPAIR/);
  assert.equal(/Have you had anyone out to look at them before/.test(block), false);
  assert.match(block, /Do NOT push for the booking/);
});

test('unknown trust is not treated as low', () => {
  const block = buildNepqBlock(ctx({ stage: 3, trust: null }), { closed_questions: [], facts: [], objections_raised: [] });
  assert.equal(/STAGE: REPAIR/.test(block), false);
  assert.match(block, /STAGE: SOLUTION AWARENESS/);
});

// ═══════════════════════════════════════════════════════════════════
// The commitment gate still wins (Myron Thorner regression)
// ═══════════════════════════════════════════════════════════════════

test('a booked contact gets the commitment gate and none of the v1.2 blocks', () => {
  const block = buildNepqBlock(
    ctx({ stage: 3, trust: 2, booked: true, objection: 'PRICE_TOO_HIGH' }),
    ALFREDO_ESTABLISHED,
  );
  assert.match(block, /STAGE: COMMITMENT/);
  assert.match(block, /NEPQ DISCOVERY IS OFF/);
  assert.equal(/STAGE: REPAIR/.test(block), false, 'booking outranks the trust floor');
  assert.equal(/THE PLAY IS TO ASK BACK/.test(block), false, 'never tell a booked customer to push back');
  assert.equal(/ALREADY ANSWERED — these are closed/.test(block), false);
});

test('a booked contact in a live window still gets the live-window escalation', () => {
  const block = buildNepqBlock(ctx({ booked: true, phase: 'in_window' }), ALFREDO_ESTABLISHED);
  assert.match(block, /THE APPOINTMENT WINDOW IS LIVE OR PASSED/);
});

// ═══════════════════════════════════════════════════════════════════
// findRepeatedQuestions — the deterministic guard
// ═══════════════════════════════════════════════════════════════════

test('the real 21:11 body is flagged against his established facts', () => {
  const hits = findRepeatedQuestions(THE_21_11_MESSAGE, ALFREDO_ESTABLISHED);
  assert.deepEqual(hits, ['decision_makers']);
});

test('a message that REFERENCES the answer is not flagged', () => {
  const good = "Since it's just you, I can get a specialist out Thursday. Does the afternoon work?";
  assert.deepEqual(findRepeatedQuestions(good, ALFREDO_ESTABLISHED), []);
});

test('"you mentioned" phrasing is not flagged', () => {
  const good = "You mentioned it's just you on the decision — want me to lock Thursday in?";
  assert.deepEqual(findRepeatedQuestions(good, ALFREDO_ESTABLISHED), []);
});

test('a statement containing the nouns but no question is not flagged', () => {
  const good = "I have you down as the only decision-maker. I'll get that visit scheduled.";
  assert.deepEqual(findRepeatedQuestions(good, ALFREDO_ESTABLISHED), []);
});

test('nothing closed means nothing flagged', () => {
  assert.deepEqual(findRepeatedQuestions(THE_21_11_MESSAGE, { closed_questions: [], facts: [] }), []);
  assert.deepEqual(findRepeatedQuestions(THE_21_11_MESSAGE, null), []);
});

test('a re-ask of prior quotes is flagged too', () => {
  const bad = 'Quick one — have you had any other quotes on this yet?';
  assert.deepEqual(findRepeatedQuestions(bad, ALFREDO_ESTABLISHED), ['prior_quotes']);
});

test('one clause referencing the answer does not excuse another clause re-asking it', () => {
  const bad = "Since it's just you, that's easy. Will anyone else be home for the visit?";
  assert.deepEqual(findRepeatedQuestions(bad, ALFREDO_ESTABLISHED), ['decision_makers']);
});

// ═══════════════════════════════════════════════════════════════════
// findConcessionPivots
// ═══════════════════════════════════════════════════════════════════

test('the real 21:11 body is flagged as a concession pivot', () => {
  const hits = findConcessionPivots(THE_21_11_MESSAGE, ALFREDO_ESTABLISHED, { objectionOpen: true });
  assert.equal(hits.length, 1);
  assert.match(hits[0], /Fair point, Alfredo/);
});

test('a genuine apology with no pivot is not flagged', () => {
  const ok = "I'm sorry about the wait on that. I'm getting someone to call you now.";
  assert.deepEqual(findConcessionPivots(ok, ALFREDO_ESTABLISHED, { objectionOpen: true }), []);
});

test('an ask-back that stays on the objection is not flagged', () => {
  const good = "Close — how close does it need to be before you'd sign off on it?";
  assert.deepEqual(findConcessionPivots(good, ALFREDO_ESTABLISHED, { objectionOpen: true }), []);
});

// v1.3 (2026-09-23): a neutral disarm that stays on THEIR objection is the
// approved shape, and the guard used to regenerate it. Agreeing and then
// asking about something else is still the defect, whatever the opener.
test('a neutral disarm followed by a question about their objection is not flagged', () => {
  for (const good of [
    "Fair enough. What's the part you're still turning over?",
    "That's not a problem. How do you mean?",
  ]) {
    assert.deepEqual(findConcessionPivots(good, ALFREDO_ESTABLISHED, { objectionOpen: true }), [], good);
  }
});

test('a soft opener followed by a qualifying or booking question is still flagged', () => {
  for (const bad of [
    'I hear you. Is anyone else part of the decision?',
    'That makes sense. Would Tuesday at 2 PM work?',
    "Fair enough. What's the address of the home?",
  ]) {
    assert.equal(findConcessionPivots(bad, ALFREDO_ESTABLISHED, { objectionOpen: true }).length, 1, bad);
  }
});

test('a hard concession followed by any other question is still flagged', () => {
  const bad = "You're right. What would you need to see?";
  assert.equal(findConcessionPivots(bad, ALFREDO_ESTABLISHED, { objectionOpen: true }).length, 1);
});

test('no objection in play means nothing to concede', () => {
  assert.deepEqual(
    findConcessionPivots(THE_21_11_MESSAGE, { objections_raised: [] }, { objectionOpen: false }),
    [],
  );
});
