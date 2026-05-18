/**
 * Contract Cancellation Notifications — Email Body Generator
 * src/notifications/cancellation-body-generator.js
 *
 * Single Claude call returning structured JSON { email_body }. The
 * body is scrubbed of stray markdown and hard-capped (≤2000 chars)
 * so the GHL internal_notification email step can render it verbatim
 * as the value of the {{contact.team_notification_body}} merge tag.
 *
 * This handler is EMAIL-ONLY by design. The companion appointment
 * notifications endpoint generates both email AND SMS because that's
 * a higher-volume operational alert (Dispatch / Edwin / Trudy /
 * Jazmine distribution). Contract cancellation is a lower-volume,
 * higher-stakes event handled by a single assigned user (Shaina) +
 * CC'd manager (Edwin) — no SMS blast.
 *
 * Failure modes:
 *   - Missing ANTHROPIC_API_KEY        → throws
 *   - Claude API error / timeout       → throws
 *   - Empty model response             → throws
 *   - Non-JSON / malformed JSON        → throws
 *   - Missing email_body in JSON       → throws
 *
 * The endpoint orchestrator turns these throws into a 5xx; the
 * notification gate stays unflipped, and the GHL workflow's 30-min
 * timeout fires the fallback (hardcoded HTML) notification path.
 *
 * HTML output: the body uses inline markup only (<br>, <strong>) so
 * it can be safely interpolated inside a <p> wrapper in the GHL
 * email step without producing invalid HTML.
 */

import crypto from 'crypto';
import {
  extractJson,
  stripMarkdown,
  enforceCharCap,
} from './appointment-body-generator.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL =
  process.env.CANCELLATION_NOTIFICATION_MODEL ||
  process.env.APPT_NOTIFICATION_MODEL ||
  process.env.NURTURE_GENERATOR_MODEL ||
  'claude-sonnet-4-5';
const MAX_TOKENS = parseInt(
  process.env.CANCELLATION_NOTIFICATION_MAX_TOKENS || '900',
  10,
);
const TIMEOUT_MS = parseInt(
  process.env.CANCELLATION_NOTIFICATION_TIMEOUT_MS || '10000',
  10,
);
const TEMPERATURE = parseFloat(
  process.env.CANCELLATION_NOTIFICATION_TEMPERATURE || '0.3',
);

const EMAIL_CHAR_CAP = parseInt(
  process.env.CANCELLATION_NOTIFICATION_EMAIL_CAP || '2000',
  10,
);

// ───────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You write internal contract-cancellation alerts for the Reece Windows & Doors customer-service team. A post-demo customer who already signed a contract has requested cancellation. Your job is to give the assigned rep everything they need to handle the outreach efficiently and professionally — without forcing them to dig through the CRM first.

OUTPUT
Return ONLY valid JSON with exactly one string key:
  { "email_body": "..." }
No preamble, no markdown fences, no commentary. First character {, last character }.

AUDIENCE AND VOICE
- You are writing for the assigned rep and a CC'd manager. Operational and direct.
- Plain English. No marketing language, no internal system jargon. Banned vocabulary: "Antifragile", "agentic", "Layer 3", "TOFU/BOFU/SOFU", "S5.x", "stage:cancellation-review", "bj:stage-5-committed", "compression psychology", "indoctrination", "nurture flow", "Decision Engine", "Action Executor". If you find yourself reaching for any of these, rewrite in plain rep-speak.
- Past tense for what happened; second person for the suggested action ("call them", "confirm with them").
- Never fabricate. When a field is empty or "(unknown)", omit its line cleanly — no empty parens, no "undefined", no dangling punctuation.
- No exclamation marks beyond the header emoji. No sales pep talk.
- Quote operational facts from the customer's own words when available. Do not soften or sanitize what they actually said.

EMAIL BODY — target 900–1500 chars, hard cap 2000
═══════════════════════════════════════════════
Use HTML-safe inline markup only. Allowed tags: <br>, <strong>. Use <br> for single line break, <br><br> for paragraph break. Do NOT use <p>, <div>, <h1>, <ul>, <li>, or any block-level tag — the body is interpolated inside a <p> wrapper in the GHL email step and block-level tags would break the markup.

Use this section layout in this order, with <br><br> between blocks:

[Header line]
🚨 CONTRACT CANCELLATION — {first_name} {last_name}

[Contact block]
<strong>CONTACT</strong><br>
📞 {phone}   ✉️ {email}<br>
📍 {address}, {city}, {state} {postal_code}
  - Drop any line whose value is empty. If phone or email is missing, drop just that segment (including the icon). If the address line is empty, omit the whole line.

[ID block]
<strong>IDS</strong><br>
🆔 LP Prospect {prospect_id}   GHL ID {contact_id}
  - When prospect_id is "(unknown)" or empty, write only "🆔 GHL ID {contact_id}".

[Sale block]
<strong>SALE</strong><br>
💰 Sale Amount: \${gross_sale_amount}<br>
📅 Last Appointment: {last_appointment_date} ({appointment_status})
  - Omit either line if its underlying value is empty. If both are empty, omit the entire SALE block including the header.

[Request block]
<strong>WHAT THEY'RE REQUESTING</strong><br>
Quote the AI Short Summary verbatim if it's available and substantive (>50 chars and operationally specific). The summary is already rep-ready — do NOT paraphrase, summarize, rephrase, or "improve" it. Reproduce it as-is.
If the AI Short Summary is empty, generic ("customer wants to cancel"), or missing, write 2–3 sentences inferring the situation from the most_recent_note, most_recent_call_outcome, or chat_transcript_tail.
If nothing useful is available anywhere, write exactly: "Customer has indicated they want to cancel their contract. No details captured in the system — confirm specifics on the callback."

[Emotional context block — only when signals exist]
<strong>EMOTIONAL CONTEXT</strong><br>
• {bullet}<br>
• {bullet}
  - 1–3 short bullets pulled from: Emotional Arc (translate to plain English), Trust Level Score (1–2 = guarded, 3 = neutral, 4–5 = engaged/cooperative), Decision Timeline ("ASAP" = wants immediate resolution), Booking Urgency, Pain Point.
  - Omit any bullet whose underlying data is absent.
  - If NO emotional signals exist at all, omit the entire block including the header.
  - Each bullet should be one short clause — no full paragraphs. No raw tag names.

[Action block]
<strong>SUGGESTED NEXT ACTION</strong><br>
One short paragraph (2–4 sentences) with concrete, actionable direction. Pick the ONE heuristic that best fits the data — do not list multiple options:

  - Customer already cooperating + spoke to management (visible in summary):
      "Customer is already cooperating and has spoken to a manager. Call within 2 hours to confirm receipt of their cancellation request and walk through any remaining paperwork. Process the cancellation cleanly — do not attempt to save the deal unless they bring up specific concerns."

  - Customer is cooperative + this is first contact (no prior conversation visible):
      "Call within 24 hours. Find out the reason for cancellation. If the reason is recoverable (spouse objection, financing concern, project timing), make ONE respectful save attempt before processing the cancellation. If they confirm, walk them through the paperwork cleanly."

  - Agitated arc / low trust score (1–2) / demanding immediate cancellation:
      "Customer is escalated. Call within 2 hours, keep tone factual and brief, do NOT attempt to save the deal. Process the cancellation, send paperwork immediately, escalate to manager if there's any pushback. Document the call thoroughly."

  - Recent signing date referenced in the AI summary (signed within the last few days):
      "Customer signed recently — this may be within the Florida 3-business-day rescission window. Verify the signing date before discussing terms. If within rescission, the customer has unconditional legal right to cancel; process accordingly and do not attempt to retain the deal."

  - Multiple cancellations or no-shows on file (visible in lead history):
      "Pattern of cancellations/no-shows on file. Make one attempt to confirm by phone. If unreachable or unresponsive, process the cancellation administratively. Do not chase."

  - No clear signals:
      "Call within 24 hours to find out the reason for cancellation, then walk through the cancellation paperwork. Document the call."

Adapt the wording to the specific customer situation. If multiple heuristics seem relevant, pick the most urgent one. Stay in operational register — no marketing language.

═══════════════════════════════════════════════════════════
JSON OUTPUT FORMAT — EXAMPLE
═══════════════════════════════════════════════════════════
{
  "email_body": "🚨 CONTRACT CANCELLATION — Donna Check<br><br><strong>CONTACT</strong><br>📞 (407) 256-2518   ✉️ donna@donnacheck.com<br>📍 9061 Saint Andrews Way, Mount Dora, FL 32757<br><br><strong>IDS</strong><br>🆔 LP Prospect 429381   GHL ID yOdjFC2CumlfTON7CS5D<br><br><strong>SALE</strong><br>💰 Sale Amount: $16,880<br>📅 Last Appointment: 2026-05-15 (Booked - Estimate)<br><br><strong>WHAT THEY'RE REQUESTING</strong><br>Donna Check (decision-maker) spoke with manager Helen at 12:07 PM and canceled the window order placed Friday evening, May 15, 2026. She requested expedited email confirmation of the cancellation for her home at 9061 Saint Andrews Way, Mount Dora, FL 32757. She will scan and sign the cancellation form from the packet and email it back. She plans to meet with a manager Thursday evening at 6:00.<br><br><strong>EMOTIONAL CONTEXT</strong><br>• Calm and cooperative — emotional arc moved from neutral to grateful by end of call<br>• Trust score 4 — engaged and willing to follow proper paperwork channels<br>• Wants confirmation handled today (ASAP timeline)<br><br><strong>SUGGESTED NEXT ACTION</strong><br>Customer already spoke to manager Helen and is cooperating. Call within 2 hours to confirm receipt of her cancellation request and to confirm she has the cancellation form from the packet. Walk her through emailing the signed form back, and confirm her Thursday 6:00 PM manager meeting. Note: signed Friday May 15 — this is within Florida's 3-business-day rescission window, so this is a straightforward processing call."
}

Return ONLY the JSON object.`;

// ───────────────────────────────────────────────────────────────────
// LOCAL HELPERS
// ───────────────────────────────────────────────────────────────────

/**
 * Look up a custom field by name inside a decoded-contact category
 * array. Returns the trimmed string value, or null if missing/empty.
 * Local copy because appointment-body-generator's cfValue is not
 * exported.
 */
function cfValue(group, fieldName) {
  if (!Array.isArray(group)) return null;
  const match = group.find(f => f && f.name === fieldName);
  if (!match) return null;
  const v = match.value;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Return the last `max` chars of a string, or the whole string if
 * already shorter. Used to trim the chat-transcript tail so we don't
 * blow the prompt budget.
 */
function tailString(input, max) {
  if (!input) return '';
  const s = String(input);
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

/**
 * Compose the user-message context for Claude. Bundles the webhook
 * payload + hybrid context into a labeled facts block geared to
 * customer-service voice: who, what they said, emotional signals,
 * lead history, suggested action.
 */
function buildUserPrompt({ payload, context }) {
  const lines = [];

  // ─── Event header ──────────────────────────────────────────────
  lines.push('EVENT: contract cancellation requested');
  lines.push('');

  // ─── Contact ───────────────────────────────────────────────────
  const profile = context?.decoded_contact?.profile || {};
  const prospectId =
    String(context?.resolved_prospect_id ?? '').trim() || '(unknown)';

  // Prefer the payload values when present (they're what the workflow
  // sent), fall back to decoded-contact profile when payload is empty.
  const first = String(payload.contact_first_name || profile.first_name || '').trim();
  const last = String(payload.contact_last_name || profile.last_name || '').trim();
  const phone = String(payload.contact_phone || profile.phone || '').trim();
  const email = String(payload.contact_email || profile.email || '').trim();
  const address = String(payload.address || profile.address || '').trim();
  const city = String(payload.city || profile.city || '').trim();
  const state = String(payload.state || profile.state || '').trim();
  const postal = String(payload.postal_code || profile.postal_code || '').trim();

  lines.push('CONTACT:');
  lines.push(`  name:        ${first} ${last}`.trimEnd());
  lines.push(`  phone:       ${phone}`);
  lines.push(`  email:       ${email}`);
  lines.push(`  address:     ${address}`);
  lines.push(`  city:        ${city}`);
  lines.push(`  state:       ${state}`);
  lines.push(`  postal:      ${postal}`);
  lines.push(`  contact_id:  ${payload.contact_id || ''}`);
  lines.push(`  prospect_id: ${prospectId}`);
  lines.push('');

  // ─── Sale info ─────────────────────────────────────────────────
  // Pull last-appointment metadata from decoded-contact custom fields
  // when the payload doesn't supply it. The workflow currently sends
  // gross_sale_amount only; the appointment block fields come from
  // the contact's custom-field profile.
  const cfAppointment = context?.decoded_contact?.custom_fields?.appointment;
  const lastAppointmentDate =
    cfValue(cfAppointment, 'Lead/Appointment Date') || '';
  const appointmentStatus =
    cfValue(cfAppointment, 'Appointment Status') || '';

  const grossSaleRaw = String(payload.gross_sale_amount || '').trim();
  lines.push('SALE INFO:');
  lines.push(`  gross_sale_amount:  ${grossSaleRaw}`);
  lines.push(`  last_appointment:   ${lastAppointmentDate}`);
  lines.push(`  appointment_status: ${appointmentStatus}`);
  lines.push(`  assigned_user:      ${payload.assigned_user || ''}`);
  lines.push('');

  // ─── Request context — what they asked for ─────────────────────
  // Primary source: AI Short Summary (`memory_summary` merge tag in
  // the workflow). Fall back to recent notes / call outcomes /
  // chat-transcript tail when the summary is missing or generic.
  const cfAi = context?.decoded_contact?.custom_fields?.ai;
  const cfChatbot = context?.decoded_contact?.custom_fields?.chatbot;

  const aiShortSummary =
    String(payload.ai_summary || '').trim() ||
    cfValue(cfAi, 'AI Short Summary') ||
    '';
  const lastSentiment = cfValue(cfAi, 'Last Sentiment') || '';

  const recentNotes = context?.lead_summary?.recent?.notes;
  const mostRecentNote =
    Array.isArray(recentNotes) && recentNotes.length
      ? String(recentNotes[0].note_body || recentNotes[0].body || '').trim().slice(0, 400)
      : '';

  const recentCalls = context?.lead_summary?.recent?.calls;
  const mostRecentCallOutcome =
    Array.isArray(recentCalls) && recentCalls.length
      ? String(recentCalls[0].outcome || recentCalls[0].call_type || '').trim()
      : '';

  const chatTranscript = cfValue(cfChatbot, 'Chat Transcript');
  const chatTranscriptTail = chatTranscript ? tailString(chatTranscript, 600) : '';

  lines.push('REQUEST CONTEXT (quote ai_short_summary verbatim when substantive — do not paraphrase):');
  lines.push(`  ai_short_summary:         ${aiShortSummary}`);
  lines.push(`  last_sentiment:           ${lastSentiment}`);
  lines.push(`  most_recent_note:         ${mostRecentNote}`);
  lines.push(`  most_recent_call_outcome: ${mostRecentCallOutcome}`);
  lines.push(`  chat_transcript_tail:     ${chatTranscriptTail}`);
  lines.push('');

  // ─── Emotional signals ─────────────────────────────────────────
  // Pull from payload first (workflow sends emotional_arc, trust_level,
  // decision_timeline), then fill in from the decoded contact for
  // anything the payload didn't include (booking_urgency, pain_point).
  const emotionalArc =
    String(payload.emotional_arc || '').trim() ||
    cfValue(cfAi, 'Emotional Arc') ||
    '';
  const trustLevel =
    String(payload.trust_level || '').trim() ||
    cfValue(cfAi, 'Trust Level Score') ||
    '';
  const decisionTimeline =
    String(payload.decision_timeline || '').trim() ||
    cfValue(cfAi, 'Decision Timeline') ||
    '';
  const bookingUrgency = cfValue(cfAi, 'Booking Urgency') || '';
  const painPoint = cfValue(cfAi, 'Pain Point') || '';

  lines.push('EMOTIONAL SIGNALS:');
  lines.push(`  emotional_arc:     ${emotionalArc}`);
  lines.push(`  trust_level_score: ${trustLevel}`);
  lines.push(`  decision_timeline: ${decisionTimeline}`);
  lines.push(`  booking_urgency:   ${bookingUrgency}`);
  lines.push(`  pain_point:        ${painPoint}`);
  lines.push('');

  // ─── Lead history ──────────────────────────────────────────────
  const lead = context?.lead_summary?.lead || {};
  const tags = Array.isArray(profile.tags) ? profile.tags : [];
  const demoFromTag = tags.some(t => String(t || '').toLowerCase() === 'lp-demo-completed');
  const demoFromLead = Boolean(lead.demo_completed);
  const demoCompleted = demoFromTag || demoFromLead;
  const appointmentsBooked = Number.isFinite(Number(lead.appointment_set))
    ? Number(lead.appointment_set)
    : '';

  // Surface only the tags that are likely useful for cancellation
  // routing — avoid dumping all 20+ tags into the prompt.
  const cancellationRelevantTags = tags.filter(t => {
    const s = String(t || '').toLowerCase();
    return (
      s.startsWith('cancellation:') ||
      s.startsWith('hold:') ||
      s.startsWith('hdl:') ||
      s.startsWith('deal-') ||
      s.startsWith('bj:') ||
      s.includes('appt-cancelled') ||
      s.includes('no-show') ||
      s === 'needs-rep-review' ||
      s === 'intent-imminent' ||
      s === 'intent-spike'
    );
  });

  lines.push('LEAD HISTORY:');
  lines.push(`  demo_completed:           ${demoCompleted ? 'true' : 'false'}`);
  lines.push(`  appointments_booked:      ${appointmentsBooked}`);
  lines.push(`  call_count:               ${lead.call_count ?? 0}`);
  lines.push(`  most_recent_disposition:  ${lead.disposition_label || ''}`);
  lines.push(`  cancellation_signal_tags: ${cancellationRelevantTags.join(', ') || '(none)'}`);
  lines.push('');

  // ─── Timeline (last 6 events) ──────────────────────────────────
  const timeline = Array.isArray(context?.timeline) ? context.timeline : [];
  if (timeline.length) {
    lines.push('TIMELINE (most recent 6 events):');
    for (const ev of timeline.slice(0, 6)) {
      lines.push(`  - ${ev.ts} [${ev.type}] ${ev.summary}`);
    }
    lines.push('');
  } else {
    lines.push('TIMELINE: (no events on file)');
    lines.push('');
  }

  // ─── Data gaps ─────────────────────────────────────────────────
  const gaps = Array.isArray(context?.data_gaps) ? context.data_gaps : [];
  lines.push(`DATA GAPS: ${gaps.length ? gaps.join('; ') : 'none'}`);
  lines.push('');

  lines.push('Write the email body per the SYSTEM PROMPT.');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────
// CLAUDE CALL
// ───────────────────────────────────────────────────────────────────

async function callClaude({ system, user, model, maxTokens, temperature }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`anthropic_${res.status}:${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) throw new Error('anthropic_empty_text');
  return text;
}

// ───────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ───────────────────────────────────────────────────────────────────

/**
 * Generate the email body for a contract-cancellation alert.
 *
 * Returns: { email_body, model, request_id, latency_ms }
 * Throws on Claude failure or missing-keys-in-JSON. The caller
 * (cancellation-notifications.js orchestrator) turns the throw into
 * a 5xx so the GHL workflow's 30-min timeout fires the fallback.
 */
export async function generateCancellationBody({ payload, context }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY_not_configured');
  }

  const requestId = crypto.randomBytes(4).toString('hex');
  const startedAt = Date.now();

  const user = buildUserPrompt({ payload, context });
  const raw = await callClaude({
    system: SYSTEM_PROMPT,
    user,
    model: MODEL,
    maxTokens: MAX_TOKENS,
    temperature: TEMPERATURE,
  });

  const parsed = extractJson(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('json_not_an_object');
  }
  if (typeof parsed.email_body !== 'string' || parsed.email_body.length === 0) {
    throw new Error('email_body_missing_or_empty');
  }

  // Belt-and-suspenders: strip stray markdown the model may have
  // slipped in despite the prompt forbidding it, then hard-cap the
  // body length so the GHL field write never overflows.
  const email_body = enforceCharCap(
    stripMarkdown(parsed.email_body),
    EMAIL_CHAR_CAP,
  );

  const elapsed = Date.now() - startedAt;
  console.log(
    `[CancellationNotif] [${requestId}] generated contact=${payload.contact_id} ` +
      `email_chars=${email_body.length} model=${MODEL} (${elapsed}ms)`,
  );

  return {
    email_body,
    model: MODEL,
    request_id: requestId,
    latency_ms: elapsed,
  };
}

export const _internal = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  cfValue,
  tailString,
  EMAIL_CHAR_CAP,
  MAX_TOKENS,
  TIMEOUT_MS,
  TEMPERATURE,
  MODEL,
};
