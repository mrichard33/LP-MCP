/**
 * Note Intelligence — src/agentic/lead-state/note-intelligence.js
 *
 * Point 2 of the lead-state intelligence build. Extracts relationship-stage
 * signal from INTERNAL LP rep notes + call results and writes it to the
 * lead_intelligence table — the same structured fields the classifier's
 * S4.5 shapes + suppression guard already read (objection_type,
 * engagement_quality, emotional_state, recommended_action, buying_signals).
 *
 * Why this is a SEPARATE path from message-analyzer.js (analyzeMessage)
 * ────────────────────────────────────────────────────────────────────
 * analyzeMessage() is built for CUSTOMER inbound messages. It emits
 * ai.analysis_completed, which ~40 behavioral/intent agent_rules consume
 * and can turn into a customer-facing send (AGENTIC_RESPOND_POST_CHATBOT,
 * the objection handlers, LAYER3 dispatch). A rep note is INTERNAL — the
 * customer never wrote it. Routing a note through analyzeMessage would let
 * an internal note ("told them no, won't alter the house") trigger an
 * outbound text to a dormant contact. That is the exact failure this path
 * avoids:
 *   - It NEVER emits ai.analysis_completed (no response rules fire).
 *   - It writes ONLY the intelligence fields the classifier reads.
 *   - Its prompt is purpose-built for note interpretation (no CTA-
 *     affirmative / reply-handling logic, which is meaningless for notes).
 *
 * Brunson framing
 * ───────────────
 * The rep note is the truest read of the prospect's RELATIONSHIP STAGE —
 * what the human selling to them actually heard. Surfacing that into the
 * signal the classifier reads means a follow-up-funnel (S4.5 Seinfeld)
 * entry decision reflects the real conversation, not just the LP
 * disposition code. A recorded "no" in a note becomes a decline signal
 * (suppress); a "wants to wait until spring" becomes a timing/long-horizon
 * signal — nurture the maybe, suppress the no — WITHOUT ever auto-messaging
 * a contact off an internal note.
 *
 * Output contract (what we write to lead_intelligence)
 * ────────────────────────────────────────────────────
 * A conservative subset of the analyzer schema, note-appropriate:
 *   objection_type        null | price | timing | spouse | trust | competitor | diy | not-interested
 *   objection_confidence  0..1
 *   emotional_state       fear|frustration|skepticism|hope|urgency|neutral|anger
 *   engagement_quality    meaningful | neutral | disengagement | dnc
 *   buying_signals        string[]  (e.g. "ready_to_schedule", "financing_interest")
 *   note_decline          boolean   — explicit recorded decline ("not interested",
 *                                      "going with someone else", "can't afford, not moving forward")
 *   note_signal_summary   short string (audit trail)
 * We DELIBERATELY do not write buyer_stage / recommended_action / story arc
 * from a note — those drive the live-conversation machinery. Notes inform
 * the SLOWER lead-state classification only.
 *
 * v0.1.0 — 2026-06-03. Point 2 initial.
 */

import { callLLMJson } from '../../llm-client.js';
import { upsertLeadIntelligence } from '../../context-builder.js';

// Reuse the decision_engine model tier (same as message_analyzer) without
// editing the 57KB analyzer or the client's FUNCTION_GROUPS map. An unmapped
// fn falls through per-fn → global provider/model cleanly; to pin it to the
// analyzer's exact model, set NOTE_INTELLIGENCE_MODEL_* envs, else it inherits
// LLM_* globals. We pass fn='message_analyzer' so it shares the analyzer's
// resolved model with zero new config.
const LLM_FN = 'message_analyzer';

const NOTE_SYSTEM_PROMPT = `You are the Antifragile Sales System note-intelligence engine for Reece Windows & Doors, a hurricane impact window/door company in South Florida.

You read INTERNAL LeadPerfection (LP) rep notes and call results for a single lead and infer the lead's CURRENT relationship stage. These notes are written by real sales reps and canvassers who interacted with the homeowner in person or by phone — they are ground truth about where the relationship actually stands.

IMPORTANT: These are INTERNAL notes, NOT messages the customer sent to us. Do not interpret them as something to reply to. Your only job is to classify what the notes reveal about the lead's stance.

RETURN ONLY a valid JSON object — no markdown, no backticks, no prose outside the JSON.

Required JSON structure:
{
  "objection_type": <null | "price" | "timing" | "spouse" | "trust" | "competitor" | "diy" | "not-interested">,
  "objection_confidence": <0.0-1.0>,
  "emotional_state": <"fear" | "frustration" | "skepticism" | "hope" | "urgency" | "neutral" | "anger">,
  "engagement_quality": <"meaningful" | "neutral" | "disengagement" | "dnc">,
  "buying_signals": [<string array of detected signals, e.g. "ready_to_schedule", "financing_interest", "referral_mention">],
  "note_decline": <boolean — TRUE only when the notes show the lead has EXPLICITLY declined / ended the buying conversation>,
  "note_signal_summary": "<one short sentence: what the notes reveal about the lead's current stance>"
}

DECLINE DETECTION (note_decline = true) — set TRUE when the notes show an explicit, settled "no":
  • "not interested", "no thank you", "we're fine as is", "decided not to move forward"
  • "going with another company", "already signed with someone"
  • "can't afford it / not doing it" stated as a final decision (not just a price question)
  • a structural / permanent refusal ("won't alter the house", "not replacing them")
Set note_decline = FALSE for soft / open states: "wants to think about it", "call back next spring",
"waiting on spouse", "price seems high" (a concern, not a refusal), "be back / follow up".
A decline is a settled exit from the buying conversation — NOT a stall, hesitation, or single objection.

OBJECTION MAPPING (read the notes for the REAL reason):
Price — "too expensive", "can't afford", "cheaper elsewhere"
Timing — "not now", "next year", "after the holidays", "busy season"
Spouse — explicitly needs partner to decide (NOT merely "one party home" — that's a 1Leg demo logistic)
Trust — "promised numbers but never sent", rep didn't follow through, "never heard of you"
Competitor — "getting other quotes", "going with another company"
DIY — "doing it myself", "handyman"
not-interested — explicit refusal with no specific objection (pairs with note_decline=true)

CRITICAL ACCURACY RULES:
1. A broken promise ("said they'd send numbers, never did") is TRUST, not spouse — even if a partner is mentioned.
2. "Only one party home" / 1Leg is a demo logistic, NOT automatically a spouse objection. Read for the real reason.
3. A price QUESTION or "seems high" is a price concern (objection_type=price, note_decline=false), NOT a decline. A flat "can't do it, not moving forward" IS a decline.
4. Set objection_confidence 0.9+ only when the notes explicitly state the objection; 0.5-0.7 for inferred.
5. engagement_quality="dnc" only for explicit do-not-contact / hostile refusal. A polite decline is "disengagement", not "dnc".
6. If the notes are purely logistical (appointment times, address confirmations, "HC" = homeowner confirmed) with no stance signal, return objection_type=null, engagement_quality="neutral", note_decline=false.

LP DISPOSITION CONTEXT (provided alongside notes):
FDNS / OPPFDN = Full Demo No Sale (demo ran, they said no — usually pairs with note_decline=true)
BO = Be Back / follow up (demo never ran — open, NOT a decline)
1Leg = one spouse present at demo (logistic, read notes for real reason)
Set = appointment scheduled · Cnf = confirmed · CXL = cancelled · NoHome = nobody home
Sale = closed · DNC = do not contact`;

/**
 * Build the note/call summary prompt input for one contact.
 * notes: [{ text, category, entered_by, date }]  (context.lp.notes shape)
 * calls: [{ result, type, agent, date }]          (context.lp.recent_calls shape)
 */
function buildNotePrompt({ lpDisposition, notes = [], calls = [] }) {
  const parts = [];
  parts.push(`LP Disposition: ${lpDisposition || 'none'}`);

  if (notes.length) {
    parts.push(`\nLP REP/SYSTEM NOTES (most recent first — ground truth):`);
    parts.push(notes.slice(0, 8).map(n => {
      const by = n.entered_by ? `[${n.entered_by}]` : '[System]';
      const dt = n.date ? ` (${n.date})` : '';
      return `  ${by}${dt} ${String(n.text || '').slice(0, 400)}`;
    }).join('\n'));
  }

  if (calls.length) {
    parts.push(`\nRECENT CALL RESULTS:`);
    parts.push(calls.slice(0, 5).map(c =>
      `  ${c.type || 'call'}: ${c.result || 'n/a'}${c.agent ? ` (${c.agent})` : ''}`
    ).join('\n'));
  }

  if (!notes.length && !calls.length) {
    parts.push(`\n(No notes or call results on record.)`);
  }

  return parts.join('\n');
}

function validateNoteAnalysis(a) {
  if (!a || typeof a !== 'object') return null;
  const OBJECTIONS = ['price', 'timing', 'spouse', 'trust', 'competitor', 'diy', 'not-interested'];
  const EMOTIONS = ['fear', 'frustration', 'skepticism', 'hope', 'urgency', 'neutral', 'anger'];
  const ENGAGE = ['meaningful', 'neutral', 'disengagement', 'dnc'];
  return {
    objection_type: OBJECTIONS.includes(a.objection_type) ? a.objection_type : null,
    objection_confidence: Math.max(0, Math.min(1, parseFloat(a.objection_confidence) || 0)),
    emotional_state: EMOTIONS.includes(a.emotional_state) ? a.emotional_state : 'neutral',
    engagement_quality: ENGAGE.includes(a.engagement_quality) ? a.engagement_quality : 'neutral',
    buying_signals: Array.isArray(a.buying_signals) ? a.buying_signals.slice(0, 5).map(String) : [],
    note_decline: a.note_decline === true,
    note_signal_summary: String(a.note_signal_summary || '').slice(0, 300),
  };
}

/**
 * Analyze a contact's notes/calls and write the derived signal to
 * lead_intelligence. Returns the validated analysis (or null on
 * empty-input / failure). NEVER emits ai.analysis_completed.
 *
 * @param {string} ghlContactId
 * @param {object} input  { lpDisposition, notes, calls }
 * @param {object} [existingIntel]  prior lead_intelligence row (to preserve counters)
 */
export async function analyzeNotesForContact(ghlContactId, input, existingIntel = null) {
  const { notes = [], calls = [] } = input || {};
  if (!notes.length && !calls.length) {
    return null; // nothing to read — caller skips
  }

  let analysis;
  try {
    const { data } = await callLLMJson({
      fn: LLM_FN,
      system: NOTE_SYSTEM_PROMPT,
      user: buildNotePrompt(input),
      maxTokens: 400,
    });
    analysis = validateNoteAnalysis(data);
  } catch (err) {
    console.warn(`[NoteIntelligence] LLM/parse failed for ${ghlContactId}: ${err.message}`);
    return null;
  }
  if (!analysis) return null;

  // Write ONLY the note-derived intelligence fields. We intentionally do NOT
  // write buyer_stage / recommended_action / recommended_story_arc (those
  // drive the live-conversation machinery and must come from a real customer
  // message, not an internal note). We DO refresh last_note_analysis_at so the
  // note-change handler's change-detection can tell a note was processed.
  try {
    await upsertLeadIntelligence(ghlContactId, {
      objection_type: analysis.objection_type,
      objection_confidence: analysis.objection_confidence,
      emotional_state: analysis.emotional_state,
      engagement_quality: analysis.engagement_quality,
      buying_signals: JSON.stringify(analysis.buying_signals),
      note_decline: analysis.note_decline,
      note_signal_summary: analysis.note_signal_summary,
      last_note_analysis_at: new Date().toISOString(),
      // bump the generic analysis stamp too so other consumers see freshness
      last_analysis_at: new Date().toISOString(),
      analysis_count: (existingIntel?.analysis_count || 0) + 1,
    });
  } catch (err) {
    console.warn(`[NoteIntelligence] upsert failed for ${ghlContactId}: ${err.message}`);
    return null;
  }

  console.log(
    `[NoteIntelligence] ${ghlContactId}: objection=${analysis.objection_type || 'none'} ` +
    `engagement=${analysis.engagement_quality} decline=${analysis.note_decline} ` +
    `— ${analysis.note_signal_summary}`
  );
  return analysis;
}

export { NOTE_SYSTEM_PROMPT, validateNoteAnalysis, buildNotePrompt };
