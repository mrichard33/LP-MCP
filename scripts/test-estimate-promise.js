/**
 * test-estimate-promise — scripts/test-estimate-promise.js
 *
 * 2026-09-26. Locks the estimate-promise guard against the incident that
 * created it (action 512799) AND against the honest copy it must never block.
 *
 * The second half matters as much as the first. scripts/test-disclosure-guard.js
 * records why: PR #1016's approved wording tripped that guard and 22 green tests
 * said nothing, because none of them fed the guard the copy we actually ship. So
 * the scripted PRICE-SHOPPER answers are asserted to SURVIVE here — they contain
 * a pricing noun and "over the phone" in the same sentence, which is exactly the
 * shape the guard looks for, and they are the correct answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findEstimatePromise,
  findUnbackedEstimatePromise,
  estimatePromiseNote,
  rewriteEstimatePromise,
  calculatorFallbackAllowed,
} from '../src/agentic/estimate-promise.js';

// ── The incident, verbatim ────────────────────────────────────────────
const INCIDENT_BODY =
  'Mukhtar, the 15-minute call covers exactly that, we can get your estimate started '
  + 'without the 90-minute in-person visit. When works best for you?';

const INCIDENT_SENTENCE =
  'Mukhtar, the 15-minute call covers exactly that, we can get your estimate started '
  + 'without the 90-minute in-person visit.';

test('the incident body is caught, and the offending sentence is returned', () => {
  assert.equal(findEstimatePromise(INCIDENT_BODY), INCIDENT_SENTENCE);
});

// ── Bodies that MUST be caught ────────────────────────────────────────
const VIOLATIONS = [
  // The incident's own shape, and near neighbours of it.
  'We can get your estimate started without the 90-minute in-person visit.',
  'You can get your pricing without the in-home visit.',
  'We can price it out on the call.',
  "We'll get you a quote over the phone.",
  'Nobody needs to come to the house to get your numbers.',
  "You don't need anyone to come out to get a ballpark.",
  'Skip the 90-minute visit and we can still get you a price.',
  'Instead of the in-home assessment we can do the numbers on the phone.',
  'No need for a specialist to come by, we can quote it from the call.',
  // The layer3-dispatch soft-decline reframe's own framing, which teaches this.
  'Nobody needs to come to the house — the call puts your numbers on file.',
];

test('every promise of pricing without the visit is caught', () => {
  for (const body of VIOLATIONS) {
    const hit = findEstimatePromise(body);
    assert.ok(hit, `should have been caught: ${body}`);
  }
});

// ── Bodies that MUST pass untouched ───────────────────────────────────
const CLEAN = [
  // The dispatch script's own base line (layer3_action_dispatch id 16).
  'Happy to get a call set up. When works best?',
  "I can have someone ring you in the next few minutes - is this still the best number?",
  // A booking confirmation. The visit DOES produce pricing — saying so is true.
  'Saturday at 10 AM, about 90 minutes. The specialist measures every opening to '
    + 'Florida code and leaves exact pricing in writing, good for a full year.',
  'About an hour and a half. We check every opening against current Florida code, '
    + "then you get written pricing that's good for a full year.",
  // The scripted PRICE-SHOPPER answers (playbooks.js). These carry a pricing
  // noun AND a phone phrase, and are the correct answer — never block them.
  'No, not a real one. Anyone who gives you a phone number is guessing, and a guess '
    + "isn't something you can compare against a real quote.",
  'Then what we do instead: measure, then leave exact pricing in writing the same visit.',
  "I can't give you a real price over the phone.",
  'Pricing needs the in-home measurement.',
  'On the call we confirm what your home needs, and pricing comes from the measurement.',
  "You can send them over, and I'll put them on your file. We still measure ourselves "
    + 'before we quote, because we warranty the fit and we only warranty what we measured.',
  // An OFFER is a question — the legitimate path is being proposed, not promised.
  'Want me to have a specialist price it out at the visit?',
  'Could we get you on the phone for fifteen minutes to see if we can help?',
  // No pricing noun at all.
  'The call is just to see if we can help and get your details on file.',
  "We came by today and missed each other. Want to grab a new slot?",
  // NO-COST framing is approved copy (the BUDGET turn-2 script), not a price
  // claim. These tripped the without-visit branch on word adjacency alone
  // while this module was being written.
  "You don't need to worry about cost for the in-home visit.",
  'No need to worry about the cost of the visit.',
  'There is no cost for the in-home visit.',
  'The assessment is no cost and no obligation.',
];

test('honest copy and scripted answers pass untouched', () => {
  for (const body of CLEAN) {
    assert.equal(findEstimatePromise(body), null, `false positive on: ${body}`);
  }
});

// ── The approved dispatch-script boundary survives its own guard ──────
//
// The sentence added to layer3_action_dispatch id 16 tells the model what the
// call is NOT. It names a price, an estimate and the visit in one breath, so it
// is the single likeliest thing to trip this guard. If a future edit to that
// script makes it self-blocking, this test is what says so.
test('the approved boundary wording is not itself a violation', () => {
  const boundary =
    'The call is to see if we can help and get their details on file - it does not produce '
    + 'a price, a range, or an estimate, and it does not replace the in-home visit. '
    + 'If they ask for a price or an estimate on the call, say plainly that pricing needs '
    + 'the in-home measurement.';
  assert.equal(findEstimatePromise(boundary), null);
});

// ── Exemptions ───────────────────────────────────────────────────────
test('a lead with a real calculator estimate is exempt', () => {
  // banned.js already carves the CUSTOMER'S ACTUAL ESTIMATE block out of the
  // no-prices rule. For that lead a number genuinely exists with no visit, so
  // this guard must not contradict the authoritative block.
  assert.equal(
    findUnbackedEstimatePromise(INCIDENT_BODY, { hasAuthoritativeEstimate: true }),
    null,
  );
});

test('an authorized calculator offer is exempt', () => {
  assert.equal(
    findUnbackedEstimatePromise('You can get a range without the visit here: <link>', { calculatorOffered: true }),
    null,
  );
});

test('with neither exemption, the promise still stands out', () => {
  assert.equal(findUnbackedEstimatePromise(INCIDENT_BODY, {}), INCIDENT_SENTENCE);
  assert.equal(findUnbackedEstimatePromise(INCIDENT_BODY), INCIDENT_SENTENCE);
});

// ── Rewrite ──────────────────────────────────────────────────────────
test('the rewrite replaces only the offending sentence', () => {
  const out = rewriteEstimatePromise(INCIDENT_BODY, INCIDENT_SENTENCE);
  assert.ok(!/without the 90-minute/i.test(out), 'the false promise must be gone');
  assert.ok(/exact pricing comes from the in-home measurement/i.test(out), 'the truth must replace it');
  assert.ok(/When works best for you\?/.test(out), 'the rest of the reply must stand');
});

test('the rewritten body passes the guard it just failed', () => {
  const out = rewriteEstimatePromise(INCIDENT_BODY, INCIDENT_SENTENCE);
  assert.equal(findEstimatePromise(out), null, 'the rewrite must not re-trip the guard');
});

// ── Edges ────────────────────────────────────────────────────────────
test('empty and null bodies are clean, never a throw', () => {
  assert.equal(findEstimatePromise(''), null);
  assert.equal(findEstimatePromise(null), null);
  assert.equal(findEstimatePromise(undefined), null);
  assert.equal(findUnbackedEstimatePromise(null), null);
});

test('the regeneration note names the offending sentence and the truth', () => {
  const note = estimatePromiseNote(INCIDENT_SENTENCE);
  assert.ok(note.includes('without the 90-minute in-person visit'), 'quotes the draft');
  assert.ok(/in-home measurement/i.test(note), 'says where pricing comes from');
  assert.ok(/no price/i.test(note), 'says the call produces none');
});

// ── The calculator gate (Mark, 2026-09-26: "only after 2+ refusals") ──
//
// The gate decides whether the URL is put into the prompt at all, so these
// assertions are what stands between a last-resort link and a reflex one.

test('the calculator is withheld until two refusals', () => {
  const st = c => ({ state_code: 'APPOINTMENT_FRICTION.timing_delay', attempt_number: c });
  assert.equal(calculatorFallbackAllowed(st(0)), false, 'first ask — the phone is the goal');
  assert.equal(calculatorFallbackAllowed(st(1)), false, 'one refusal — reframe, do not concede');
  assert.equal(calculatorFallbackAllowed(st(2)), true, 'two refusals — now it is a last resort');
  assert.equal(calculatorFallbackAllowed(st(5)), true);
});

test('the calculator is offered only on states that are about wanting a number', () => {
  const at = code => calculatorFallbackAllowed({ state_code: code, attempt_number: 3 });
  // Eligible: they want to move forward but not by taking a call right now.
  assert.equal(at('APPOINTMENT_FRICTION.timing_delay'), true);
  assert.equal(at('APPOINTMENT_FRICTION.overwhelmed'), true);
  assert.equal(at('APPOINTMENT_FRICTION.price_anxiety_pre_demo'), true);
  assert.equal(at('DISENGAGEMENT.passive_cooling'), true);
  // Never: opting out, or dodging us. Another link is not the answer.
  assert.equal(at('DISENGAGEMENT.soft_opt_out'), false);
  assert.equal(at('DISENGAGEMENT.hard_loss'), false);
  assert.equal(at('DISENGAGEMENT.active_avoidance'), false);
  // Never: they already hold real numbers, so a range is a downgrade.
  assert.equal(at('POST_PROPOSAL_RESISTANCE.delay_request'), false);
  assert.equal(at('POST_PROPOSAL_RESISTANCE.financing_pressure'), false);
  // Never: not about pricing at all.
  assert.equal(at('APPOINTMENT_FRICTION.spouse_uncertainty'), false);
  assert.equal(at('APPOINTMENT_FRICTION.trust_hesitation'), false);
});

test('the gate fails CLOSED on anything missing or unknown', () => {
  assert.equal(calculatorFallbackAllowed(null), false);
  assert.equal(calculatorFallbackAllowed(undefined), false);
  assert.equal(calculatorFallbackAllowed({}), false);
  assert.equal(calculatorFallbackAllowed({ attempt_number: 9 }), false, 'no state code');
  assert.equal(
    calculatorFallbackAllowed({ state_code: 'APPOINTMENT_FRICTION.timing_delay', attempt_number: null }),
    false,
    'an unreadable counter is not a pass',
  );
  // A state added to the taxonomy later must default to NOT eligible.
  assert.equal(calculatorFallbackAllowed({ state_code: 'SOMETHING.new_state', attempt_number: 9 }), false);
});

// ── The rep task a corrected promise files ────────────────────────────
//
// The lead asked for a number and got the honest boundary instead. That is the
// moment a person should pick it up, so the flag has to reach a task.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const { buildEstimatePromiseTask } = await import('../src/send-message-handler.js');

test('a corrected estimate promise becomes a high-priority rep task', () => {
  const t = buildEstimatePromiseTask({
    contactId: 'dcKRwIyxn53eIOvrkJdA', eventId: 4242, promise: INCIDENT_SENTENCE,
  });
  assert.equal(t.action_type, 'create_task');
  assert.equal(t.target_id, 'dcKRwIyxn53eIOvrkJdA');
  assert.equal(t.event_id, 4242);
  assert.equal(t.rule_applied, 'ESTIMATE_PROMISE_CORRECTED');
  assert.equal(t.requires_approval, false, 'the lead is waiting — never hold this for approval');
  assert.equal(t.action_payload.priority, 'high');
  assert.ok(t.action_payload.description.includes('without the 90-minute in-person visit'),
    'the rep sees what the draft actually said');
  assert.ok(/in-home measurement/i.test(t.action_payload.description),
    'and what the honest answer is');
});

test('the task survives a missing event id', () => {
  assert.equal(buildEstimatePromiseTask({ contactId: 'abc', promise: 'x' }).event_id, null);
});
