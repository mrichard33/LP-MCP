/**
 * rep-note — src/agentic/rep-note.js
 *
 * 2026-09-23 (Mark's canon + NEPQ rulings). Three chat moves now end in
 * something the rep needs before they walk in, and until now the responder
 * had nowhere to put it:
 *
 *   - the competitor decider  "what will make the decision for you?"
 *   - THE REVEAL              "what's the main thing you want to go over?"
 *   - MISTRUST Turn 1         "what happened?"
 *
 * The prompt had said "silently note Trust: …" since the mistrust play was
 * written, and nothing read it. The model now returns a top-level `rep_note`
 * on the turn the lead answers one of them; send-message-handler queues it
 * as an ordinary add_note action (src/actions/handlers/notes.js), so the note
 * lands on the GHL contact the same way escalation summaries do.
 *
 * Pure and dependency-free so it unit-tests without supabase or GHL.
 */

// A note is the lead's answer in their own words, not an essay. The prompt
// asks for 200; this cap only stops a runaway field from reaching GHL.
export const REP_NOTE_MAX_CHARS = 300;

export const REP_NOTE_RULE = 'REP_NOTE_CAPTURE';

/**
 * The model's rep_note field → a clean string, or null when there is nothing
 * worth saving. Anything that is not a non-empty string is null — the field
 * is null on almost every turn, and a stray object must never become a note.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeRepNote(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/^(null|none|n\/a)$/i.test(text)) return null;
  return text.length > REP_NOTE_MAX_CHARS ? `${text.slice(0, REP_NOTE_MAX_CHARS - 1)}…` : text;
}

/**
 * The agent_actions row that writes the note. Returns null when there is no
 * note or no contact, so the caller can skip the insert without branching.
 *
 * @param {{ repNote: string|null, contactId: string|null, eventId?: string|null }} args
 * @returns {object|null}
 */
export function buildRepNoteAction({ repNote, contactId, eventId = null }) {
  const note = normalizeRepNote(repNote);
  if (!note || !contactId) return null;
  return {
    event_id: eventId || null,
    action_type: 'add_note',
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: { note: `Chatbot, lead said: ${note}` },
    reasoning: 'Lead answered a question the rep should see before the visit (decider / reveal / trust)',
    confidence: 1.0,
    rule_applied: REP_NOTE_RULE,
    status: 'pending',
    requires_approval: false,
  };
}
