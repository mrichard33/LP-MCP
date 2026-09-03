/**
 * test-fast-track-evidence-gate.js — fast-track needs evidence in the message
 * (2026-09-03, S4.5 test-contact incident: lGQ0WjsMU2zmoq9MsVJH, event 3361024).
 *
 * The contact replied "This is great." plus an email signature to an S4.5
 * Randy email. The analyzer returned fast_track_eligible=true,
 * recommended_action=fast_track_booking, buyer_stage=4 and
 * escalation_category=identity_ambiguous (the signature name differed from
 * the record) while its own reasoning said "not a CTA affirmative — escalate
 * to a rep." Downstream the router resolved the in-home Window Estimate and
 * the generator wrote "You mentioned wanting a quote" with two slot offers.
 *
 * applyFastTrackEvidenceGate() is the deterministic post-LLM guard, exported
 * at module scope (same reason MOVED_REGEX / CANNOT_AFFORD_REGEX are) so the
 * boundary is pinned here without standing up the LLM.
 *
 * Pure functions only — no network, no mocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// supabase.js + llm-client.js read these at import time; set harmless defaults.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.ANTHROPIC_API_KEY ||= 'test';

const { applyFastTrackEvidenceGate } = await import('../src/message-analyzer.js');

// Shaped like validateAnalysis() output. Every case starts from a fresh copy.
function makeAnalysis(overrides = {}) {
  return {
    buyer_stage: 2,
    buyer_stage_confidence: 0.5,
    objection_type: null,
    objection_confidence: 0,
    buying_signals: [],
    emotional_state: 'neutral',
    engagement_quality: 'meaningful',
    fast_track_eligible: false,
    recommended_story_arc: null,
    recommended_action: 'continue_current',
    dq_detected: null,
    requested_fulfillment: 'unspecified',
    escalation_category: null,
    guide_type: null,
    follow_up_bucket: null,
    call_purpose: null,
    reasoning: '',
    ...overrides,
  };
}

function contextWithLastOutbound(text) {
  return {
    lead: { ghl_contact_id: 'lGQ0WjsMU2zmoq9MsVJH', current_tags: ['active-entry:chatbot', 'active-s4.5'] },
    lp: {},
    conversation_recent: [
      { direction: 'inbound', text: 'Earlier reply from the lead.' },
      { direction: 'outbound', text },
    ],
  };
}

// The S4.5 Randy email body the incident contact was replying to. It ends in
// a statement, not a question, and carries no CTA marker.
const S45_OUTBOUND =
  'Mark, most homeowners in Coral Springs never see what their insurer sees. ' +
  'Your roof, your openings, your zone — it is all in one report. ' +
  "See your home's risk report https://example.com/risk-report — no call, no pressure, just your picture.";

const INCIDENT_TEXT = 'This is great.\n\nThank you,\nMark Follen\n(954) 508-1512\nmfollen@icloud.com';

// ── 1. The incident ──────────────────────────────────────────────────

test('incident: "This is great." + signature is gated out of fast-track and identity_ambiguous is cleared', () => {
  const analysis = makeAnalysis({
    fast_track_eligible: true,
    recommended_action: 'fast_track_booking',
    buyer_stage: 4,
    escalation_category: 'identity_ambiguous',
  });
  const out = applyFastTrackEvidenceGate(analysis, INCIDENT_TEXT, contextWithLastOutbound(S45_OUTBOUND), 'lGQ0WjsMU2zmoq9MsVJH');
  assert.equal(out.fast_track_eligible, false);
  assert.equal(out.recommended_action, 'continue_current');
  assert.equal(out.buyer_stage, 3);
  assert.equal(out.escalation_category, null);
});

// ── 2. A real CTA-affirmative is preserved ───────────────────────────

test('"Sure" to an outbound that asked "Want me to send the link?" keeps fast-track intact', () => {
  const analysis = makeAnalysis({
    fast_track_eligible: true,
    recommended_action: 'fast_track_booking',
    buyer_stage: 4,
  });
  const before = structuredClone(analysis);
  const out = applyFastTrackEvidenceGate(
    analysis, 'Sure',
    contextWithLastOutbound('Here is the short version of how the estimate works. Want me to send the link?'),
    'ctx-affirmative',
  );
  assert.deepEqual(out, before);
});

// ── 3. Explicit intent is preserved ──────────────────────────────────

test('"How soon can you come out?" is explicit booking intent even with no outbound CTA', () => {
  const analysis = makeAnalysis({
    fast_track_eligible: true,
    recommended_action: 'fast_track_booking',
    buyer_stage: 4,
  });
  const before = structuredClone(analysis);
  const out = applyFastTrackEvidenceGate(
    analysis, 'How soon can you come out?',
    contextWithLastOutbound(S45_OUTBOUND),
    'ctx-explicit',
  );
  assert.deepEqual(out, before);
});

// ── 4. "Yes" to a non-question is not an affirmative ─────────────────

test('"Yes" answering a statement with no question and no CTA marker is gated to continue_current', () => {
  const analysis = makeAnalysis({
    fast_track_eligible: true,
    recommended_action: 'fast_track_booking',
    buyer_stage: 4,
  });
  const out = applyFastTrackEvidenceGate(
    analysis, 'Yes',
    contextWithLastOutbound('Thanks for taking a look. We will be in the neighborhood all month.'),
    'ctx-yes-no-question',
  );
  assert.equal(out.fast_track_eligible, false);
  assert.equal(out.recommended_action, 'continue_current');
  assert.equal(out.buyer_stage, 3);
});

// ── 5. Escalation wins over a booking push ───────────────────────────

test('wrong-person language keeps identity_ambiguous and turns fast_track_booking into escalate_to_rep', () => {
  const analysis = makeAnalysis({
    fast_track_eligible: true,
    recommended_action: 'fast_track_booking',
    buyer_stage: 4,
    escalation_category: 'identity_ambiguous',
  });
  const out = applyFastTrackEvidenceGate(
    analysis,
    "How much? My husband passed away last year and it's his name on the file",
    contextWithLastOutbound(S45_OUTBOUND),
    'ctx-deceased',
  );
  assert.equal(out.escalation_category, 'identity_ambiguous');
  assert.equal(out.recommended_action, 'escalate_to_rep');
  assert.equal(out.fast_track_eligible, false);
});

// ── 6. A non-fast-track analysis is untouched ────────────────────────

test('"Thanks" with continue_current / fast_track false / stage 2 comes back identical', () => {
  const analysis = makeAnalysis({
    recommended_action: 'continue_current',
    fast_track_eligible: false,
    buyer_stage: 2,
  });
  const before = structuredClone(analysis);
  const out = applyFastTrackEvidenceGate(analysis, 'Thanks', contextWithLastOutbound(S45_OUTBOUND), 'ctx-thanks');
  assert.deepEqual(out, before);
});

// ── 7. Signature-only identity_ambiguous is cleared ──────────────────

test('a signature name alone clears identity_ambiguous and leaves the action unchanged', () => {
  const analysis = makeAnalysis({
    recommended_action: 'continue_current',
    escalation_category: 'identity_ambiguous',
  });
  const out = applyFastTrackEvidenceGate(analysis, 'Looks good.\nJane Doe', contextWithLastOutbound(S45_OUTBOUND), 'ctx-signature');
  assert.equal(out.escalation_category, null);
  assert.equal(out.recommended_action, 'continue_current');
});
