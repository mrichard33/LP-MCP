// ─── Summarizer — src/ghl-note-pipeline/summarizer.js ────────────
//
// Turns a windowed GHL conversation + lead signals into ONE internal CRM
// note for a Reece Windows & Doors call-center rep. Facts only, plain text,
// appointment-first. Uses the shared LLM client (default claude-sonnet-4-6;
// override with GHL_NOTE_SUMMARIZER_MODEL_ANTHROPIC).
//
// Returns { note: string, important: boolean }.

import { callLLMJson } from '../llm-client.js';

const SYSTEM_PROMPT = `You write ONE internal CRM note for a call-center rep at Reece Windows & Doors, summarizing a customer's inbound conversation that happened in GoHighLevel. The rep books and confirms in-home estimate appointments and triages a lead in about five seconds.

FACTS ONLY. Never tell the rep what to do, never suggest a next step, never coach. Report what is true.

Return ONLY valid JSON: {"note": "<plain-text note>", "important": true|false}

The note is PLAIN TEXT in exactly this structure. OMIT any line you have no data for:
[AI BRIEF · {date} {time}]  {TEMP} · {appointment state}
WANTS: {product, count, property type}
DECISION-MAKERS: {e.g., single owner / both owners — only if known}
LANGUAGE: {only if a non-English preference is evident}
WHAT HAPPENED: {1-3 sentences, plain English, what the customer said or did THIS session}
SIGNALS: {condensed engagement footprint, e.g., "opened 4 emails, VSL 80%, ran calculator" — only if available}

Rules:
- Lead line {TEMP}: COLD / WARM / HOT / IMMINENT from the provided intent tier. {appointment state}: e.g. "appt NOT set", "appt confirmed 6/26 6pm", "appt cancelled".
- Mirror the team's shorthand when natural (e.g., "single owner — no 2nd leg needed").
- Tight and skimmable. No transcript. No emojis. No advice.
- "important": true only for a landmine the rep must not miss — opt-out/DNC, hostile/"never contact again", appointment cancellation, or a HOT/IMMINENT buyer. Otherwise false.`;

/**
 * Render the windowed messages as a compact, role-labelled transcript for the
 * model. `messages` are normalized { direction, body, sentAt } objects.
 */
function renderMessages(messages) {
  return messages
    .map((m) => {
      const role = m.direction === 'inbound' ? 'CUSTOMER' : 'REECE';
      const ts = m.sentAt ? m.sentAt.toISOString() : '?';
      const body = (m.body || '').replace(/\s+/g, ' ').trim();
      return `[${ts}] ${role}: ${body}`;
    })
    .join('\n');
}

/**
 * Build a human-readable appointment-state hint for the note's lead line.
 */
function describeApptState(apptState) {
  if (!apptState || !apptState.state) return 'appt NOT set';
  if (apptState.state === 'cancelled') return 'appt cancelled';
  if (apptState.state === 'booked') {
    return apptState.at ? `appt set ${apptState.at.toISOString()}` : 'appt set';
  }
  return 'appt NOT set';
}

/**
 * @param {Object} args
 * @param {Array}  args.messages  normalized windowed messages (asc by sentAt)
 * @param {Object} args.signals   { intent_tier, objection_type, emotional_state,
 *                                  note_signal_summary, engagement } — any may be null
 * @param {Object} args.apptState { state, at } from getApptStateFromLeadEvents
 * @param {string} args.nowText   current date/time string (America/New_York)
 * @returns {Promise<{ note: string, important: boolean }>}
 */
export async function summarizeConversation({ messages, signals, apptState, nowText }) {
  const userMessage = [
    `CURRENT DATE/TIME (America/New_York): ${nowText}`,
    `APPOINTMENT STATE: ${describeApptState(apptState)}`,
    '',
    'LEAD SIGNALS (JSON; fields may be null — omit lines you have no data for):',
    JSON.stringify(signals || {}, null, 2),
    '',
    'INBOUND CONVERSATION THIS SESSION (oldest first):',
    renderMessages(messages),
  ].join('\n');

  const callOnce = async () => {
    const { data } = await callLLMJson({
      fn: 'ghl_note_summarizer',
      system: SYSTEM_PROMPT,
      user: userMessage,
      maxTokens: 600,
    });
    return data;
  };

  let data;
  try {
    data = await callOnce();
  } catch (err) {
    // One retry on a parse/format failure, then surface the error to the row.
    console.warn(`[GHLNote] summarizer parse retry: ${err.message}`);
    data = await callOnce();
  }

  const note = typeof data?.note === 'string' ? data.note.trim() : '';
  if (!note) throw new Error('[GHLNote] summarizer returned empty note');
  return { note, important: data.important === true };
}

// ─── Origin stamping (2026-07-29) ────────────────────────────────
//
// The LP→GHL direction has always been explicit about provenance: a
// "📋 LP Note" header plus an "LP Lead: {id}" footer. The GHL→LP direction
// was not — "[AI BRIEF …]" tells an LP rep that an AI wrote the note, but
// not that it originated in GoHighLevel, and gives them no way back to the
// thread it summarizes.
//
// Applied deterministically here rather than by editing SYSTEM_PROMPT: the
// header is model-generated, and a prompt instruction is a request, not a
// guarantee. This rewrite is idempotent and leaves an already-stamped note
// alone, so it stays correct even if the prompt is changed later to emit the
// new form natively.
const AI_BRIEF_HEADER = /^\[(?:GHL · )?AI BRIEF · /;

/**
 * Rewrite the brief's header to carry the GHL origin and append a
 * back-reference footer. The existing timestamp format is preserved exactly —
 * only the "[AI BRIEF · " prefix is replaced.
 *
 * @param {string} note          rendered brief from summarizeConversation
 * @param {string} ghlContactId  contact the conversation belongs to
 * @returns {string}
 */
export function stampNoteOrigin(note, ghlContactId) {
  let out = String(note || '');

  // Header: "[AI BRIEF · …" → "[GHL · AI BRIEF · …". Already-stamped notes and
  // notes with an unexpected first line are both left as-is.
  if (AI_BRIEF_HEADER.test(out) && !out.startsWith('[GHL · AI BRIEF · ')) {
    out = out.replace(/^\[AI BRIEF · /, '[GHL · AI BRIEF · ');
  }

  // Footer: mirrors the "LP Lead: {id}" convention of the reverse direction.
  if (ghlContactId && !out.includes(`GHL Contact: ${ghlContactId}`)) {
    out = `${out}\n\nGHL Contact: ${ghlContactId}`;
  }

  return out;
}
