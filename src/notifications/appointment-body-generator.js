/**
 * Appointment Notifications — Email + SMS Body Generator
 * src/notifications/appointment-body-generator.js
 *
 * Single Claude call returning structured JSON
 * { email_body, sms_body }. Both bodies are then independently
 * scrubbed of markdown and hard-capped (email ≤1500, SMS ≤300) so
 * the GHL internal_notification email/SMS steps can use them
 * verbatim regardless of how the model behaves.
 *
 * Delivery happens via GHL's existing internal_notification email +
 * SMS steps after the workflow's wait-for-condition picks up
 * team_notification_ready = "Yes". This module never posts to
 * GroupMe, Slack, or any external channel.
 *
 * Failure modes:
 *   - Missing provider credential → throws (from the shared LLM client)
 *   - LLM API error / timeout     → throws
 *   - Empty model response        → throws
 *   - Non-JSON / malformed JSON   → throws (defensive extractJson)
 *   - Missing email_body or sms_body in parsed JSON → throws
 *
 * The endpoint orchestrator turns these throws into a 5xx; the
 * notification gate stays unflipped, and the GHL workflow's 30-min
 * timeout fires the fallback notification path.
 */

import crypto from 'crypto';
import { callLLM } from '../llm-client.js';

// Provider + model resolved at call time by the shared client from the
// `appt_notification` fn key (customer_facing group). Legacy
// APPT_NOTIFICATION_MODEL is still honored by the client for Anthropic
// back-compat. Timeout is centralized in the client (LLM_TIMEOUT_MS).
const MAX_TOKENS = parseInt(process.env.APPT_NOTIFICATION_MAX_TOKENS || '700', 10);
const TEMPERATURE = parseFloat(process.env.APPT_NOTIFICATION_TEMPERATURE || '0.4');

const EMAIL_CHAR_CAP = parseInt(process.env.APPT_NOTIFICATION_EMAIL_CAP || '1500', 10);
const SMS_CHAR_CAP = parseInt(process.env.APPT_NOTIFICATION_SMS_CAP || '300', 10);

const SYSTEM_PROMPT = `You write internal dispatch alerts for the Reece Windows & Doors call-center and dispatch team (Dispatch / Edwin / Trudy / Jazmine) when an appointment is cancelled or rescheduled. Your job is to make the rep's next phone call efficient and informed. You do not promote, market, route through automation, or describe internal systems.

OUTPUT
Return ONLY valid JSON with exactly two string keys:
  { "email_body": "...", "sms_body": "..." }
No preamble, no markdown fences, no commentary. First character {, last character }.

AUDIENCE AND VOICE
You are writing for dispatchers and phone reps. Operational and direct.
- Plain English. No marketing language, no internal architecture words, no system jargon. Banned vocabulary: "S5.2", "TOFU", "BOFU", "compression psychology", "Antifragile", "indoctrination", "stage:re-engagement", "stage:reactivation", "routing decision", "agent task", "nurture flow", "dormant buyer", "BOFU re-entry", "earned compression", "agentic system". If you find yourself reaching for any of these, rewrite in plain rep-speak.
- No exclamation marks, no apologies, no sales pep talk.
- Past tense for the cancellation/reschedule event; second person ("call them", "confirm with them") for the action.
- Never fabricate. When a field is empty or "(unknown)", omit its segment cleanly. No empty parens, no "undefined", no dangling punctuation.
- When the data does not support a confident statement about WHY they cancelled, write "No stated reason on file." rather than inventing one.

EMAIL BODY — target 500–950 chars, hard cap 1500
═══════════════════════════════════════════════
Use this exact section layout, in this order. Newlines separate blocks; blank line between blocks.

[Header line]
  Cancelled:    ❌ APPOINTMENT CANCELLED — {first_name} {last_name}
  Rescheduled:  🔄 APPOINTMENT RESCHEDULED — {first_name} {last_name}

[Contact block — 2 lines]
  📞 {phone}   ✉️ {email}
  📍 {city}, {postal}
  Drop any segment whose value is empty. If phone is empty, drop the entire phone segment including the icon. Same for email, city, postal. If the city/postal line becomes empty, drop the whole line.

[ID block — 1 line]
  🆔 Prospect {prospect_id}   GHL ID {contact_id}
  When prospect_id is "(unknown)" or empty, write "🆔 GHL ID {contact_id}" only.

[Timing block]
  Cancelled:
    📅 Was: {formatted_was} ({appointment_title})
  Rescheduled:
    📅 Was: {formatted_was}
    📅 Now: {formatted_now}
       ({appointment_title})

[Source + rep block — 2 lines]
  🧭 Source: {effective_source} → {effective_subsource}
  👤 Rep on file: {assigned_user OR "Unassigned"}
  When effective_subsource is empty, write "🧭 Source: {effective_source}".
  When both source values are empty, omit the source line entirely.

[Blank line, then:]
WHY CANCELLED:    (cancelled status)
WHY MOVED:        (rescheduled status)
Then 1–3 sentences in plain English. Pull the strongest signal from the labeled "CANCELLATION REASON CANDIDATES" block in the user prompt — prefer in this order: (1) chat_transcript_tail if it contains a direct reason quote, (2) ai_short_summary, (3) most_recent_note, (4) most_recent_call_outcome, (5) concern/objection tags translated into plain English (e.g. "concern-expressed:timing" → "timing was a known concern"). Mention prior_cancellations or prior_reschedules counts when ≥ 2 — call them out as a pattern. If nothing supports a reason: "No stated reason on file."

[Blank line, then:]
LEAD CONTEXT:
2–4 plain-English bullets covering:
  - whether they've ever had an in-home estimate (use demo_completed)
  - how active they've been (use timeline density / call_count — "Active over the past N days" or "First contact this week")
  - source attribution in plain language ("came in through online estimate calculator", "from outbound canvass", etc.)
  - relevant pain or intent signals translated to plain English (skip if irrelevant or unintelligible)
Omit any bullet whose underlying data is absent. Never use raw tag names in the bullets.

[Blank line, then:]
WHAT TO DO:
One short paragraph (2–3 sentences) with concrete, actionable direction. Tailor to the situation using these heuristics (pick ONE — do not list multiple options):

  Cancellation patterns:
    - Stated budget concern (transcript/notes mention money/can't afford):
        "Call within 24 hours. If they confirm budget is the blocker, offer to add them to a 90-day follow-up list and ask permission to send financing-option information. Do not push for a same-day rebook."
    - Stated timing concern (timing tags or notes):
        "Soft follow-up call within 5–7 days. Ask whether anything on their end has changed before offering a new slot."
    - Multiple cancellations (prior_cancellations >= 2):
        "Pattern of cancellations on file. Make one attempt to understand what's getting in the way. If unsuccessful, hand off to long-term follow-up — do not aggressively rebook."
    - Demo already completed (demo_completed = true):
        "High-priority callback. They've already had an estimate — find out what changed since the visit and try to rebook within the week."
    - No reason on file, no demo, first cancellation:
        "Call within 24 hours to find out why they cancelled and offer to rebook."
    - No-show pattern from tags:
        "Pattern of no-shows. Only confirm a new slot if they reach out first."

  Reschedule patterns:
    - First reschedule, no concern signals:
        "Confirm the new slot with a call 24 hours before. No further action needed unless they reach out."
    - Multiple reschedules (prior_reschedules >= 2):
        "Two or more reschedules on file. Confirm the new slot AND verify all decision-makers will be present — watch this for cancellation risk."
    - Reschedule after demo completed:
        "Customer is engaged — already had an estimate. Confirm the new slot and ask if they have any new questions before the visit."
    - Default:
        "Confirm new slot 24 hours before the appointment."

Pick the single best-matching heuristic. Adapt the wording to the specific situation if the data strongly suggests a sharper instruction, but stay within the same operational register.

═══════════════════════════════════════════════════════════
SMS BODY — target ≤270 chars, hard cap 300
═══════════════════════════════════════════════════════════
Four short lines max. Drop fields gracefully when missing.

Cancelled template:
  ❌ APPT CANCELLED — {first} {last} ({phone})
  Prospect {prospect_id} | GHL ID {contact_id} | {appt_title} {formatted_was}
  Reason: {≤80-char plain-English summary of why}
  Action: {≤90-char compressed version of the WHAT TO DO heuristic}

Rescheduled template:
  🔄 APPT RESCHEDULED — {first} {last} ({phone})
  Prospect {prospect_id} | GHL ID {contact_id} | {appt_title}
  {formatted_was} → {formatted_now}
  Action: {≤90-char compressed action}

Rules:
- When phone empty, drop "({phone})".
- When prospect_id is "(unknown)", drop "Prospect {prospect_id} | " but ALWAYS keep "GHL ID {contact_id}".
- GHL ID is mandatory on every SMS so reps can paste it into a contact lookup.
- If total exceeds 300, trim the Reason line to a few words (still meaningful: "Budget" / "Timing" / "Pattern of cancellations"), then trim Action if still over.

═══════════════════════════════════════════════════════════
JSON OUTPUT FORMAT
═══════════════════════════════════════════════════════════
{
  "email_body": "❌ APPOINTMENT CANCELLED — Mark Richard\\n\\n📞 (954) 508-1512   ✉️ mfollen@icloud.com\\n📍 Delray Beach, 33484\\n🆔 Prospect 427375   GHL ID y4dvOxtWW12xGrBavCUt\\n\\n📅 Was: 05-16-2026 at 6:00 PM (Window Estimate)\\n🧭 Source: Estimate Calculator → Estimate Calculator\\n👤 Rep on file: Mark Richard\\n\\nWHY CANCELLED:\\nThe customer cited budget concerns ('don't have the money for windows right now') combined with a timing objection already on file. This is their second cancellation in the past week — the prior appointment was rescheduled before being cancelled outright.\\n\\nLEAD CONTEXT:\\n- Never had an in-home estimate completed\\n- Active over the past 4 days (chatbot, two appointments booked then cancelled)\\n- Came in through the online estimate calculator\\n\\nWHAT TO DO:\\nCall within 24 hours to confirm the budget concern. If they're genuinely priced out today, offer to add them to a 90-day follow-up list and ask permission to send financing-option information. Do not push for a same-day rebook.",
  "sms_body": "❌ APPT CANCELLED — Mark Richard (954) 508-1512\\nProspect 427375 | GHL ID y4dvOxtWW12xGrBavCUt | Window Estimate 05-16-2026 at 6:00 PM\\nReason: Budget + timing (2nd cancellation in a week)\\nAction: Call w/in 24h. Don't push rebook. Offer 90-day FU + financing."
}

Return ONLY the JSON object.`;

// ───────────────────────────────────────────────────────────────────
// DATE/TIME FORMATTER
// ───────────────────────────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseApptDate(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { y, mo, d };
    return null;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { y, mo, d };
    return null;
  }
  return null;
}

function parseApptTime(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const period = m[3].toUpperCase();
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return { h, min };
  }
  m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, min };
  }
  return null;
}

/**
 * Format a date+time pair from GHL merge tags into the canonical
 * "MM-DD-YYYY at h:MM AM/PM" shape. Never throws, never fabricates.
 */
export function formatApptDateTime(date, time) {
  const d = parseApptDate(date);
  const t = parseApptTime(time);
  const dateStr = d ? `${pad2(d.mo)}-${pad2(d.d)}-${d.y}` : '';
  let timeStr = '';
  if (t) {
    let h12 = t.h % 12;
    if (h12 === 0) h12 = 12;
    const period = t.h < 12 ? 'AM' : 'PM';
    timeStr = `${h12}:${pad2(t.min)} ${period}`;
  }
  if (dateStr && timeStr) return `${dateStr} at ${timeStr}`;
  if (dateStr) return dateStr;
  if (timeStr) return timeStr;
  return '';
}

// ───────────────────────────────────────────────────────────────────
// CUSTOM-FIELD LOOKUP HELPERS
// ───────────────────────────────────────────────────────────────────

function cfValue(group, fieldName) {
  if (!Array.isArray(group)) return null;
  const match = group.find(f => f && f.name === fieldName);
  if (!match) return null;
  const v = match.value;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function tailString(input, max) {
  if (!input) return '';
  const s = String(input);
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

/**
 * Build the user-message context for Claude. Bundles the payload +
 * hybrid context into a structured "labeled facts" block geared to
 * dispatch voice: who, when, why, lead context, what to do.
 */
function buildUserPrompt({ payload, context }) {
  const lines = [];

  // ─── Header / status ────────────────────────────────────────────
  lines.push(`STATUS: ${payload.status}`);
  lines.push(`APPOINTMENT_TITLE: ${payload.appointment_title || ''}`);
  lines.push('');

  // ─── Contact ────────────────────────────────────────────────────
  const lead = context?.lead_summary?.lead || {};
  const prospectId =
    String(context?.resolved_prospect_id ?? '').trim() || '(unknown)';

  lines.push('CONTACT:');
  lines.push(`  name:        ${payload.contact_first_name || ''} ${payload.contact_last_name || ''}`.trimEnd());
  lines.push(`  phone:       ${payload.contact_phone || ''}`);
  lines.push(`  email:       ${payload.contact_email || ''}`);
  lines.push(`  city:        ${payload.city || ''}`);
  lines.push(`  postal:      ${payload.postal_code || ''}`);
  lines.push(`  contact_id:  ${payload.contact_id || ''}`);
  lines.push(`  prospect_id: ${prospectId}`);
  lines.push('');

  // ─── Timing (formatted) ─────────────────────────────────────────
  const formattedWas =
    payload.status === 'rescheduled'
      ? formatApptDateTime(payload.previous_start_date, payload.previous_start_time)
      : formatApptDateTime(payload.start_date, payload.start_time);
  lines.push('TIMING (formatted, use verbatim — do not re-format):');
  lines.push(`  was: ${formattedWas}`);
  if (payload.status === 'rescheduled') {
    const formattedNow = formatApptDateTime(payload.start_date, payload.start_time);
    lines.push(`  new: ${formattedNow}`);
  }
  lines.push('');

  // ─── Source ─────────────────────────────────────────────────────
  const effSource = context?.effective_source ? String(context.effective_source).trim() : '';
  const effSub = context?.effective_subsource ? String(context.effective_subsource).trim() : '';
  lines.push('SOURCE:');
  lines.push(`  effective_source:    ${effSource || '(empty)'}`);
  lines.push(`  effective_subsource: ${effSub || '(empty)'}`);
  if (context?.source_analytics) {
    const a = context.source_analytics;
    const pct = a.close_rate_pct ?? 'n/a';
    lines.push(`  analytics: ${a.closed_won} closed of ${a.total_leads} (${pct}% close rate, matched_on=${a.matched_on})`);
  } else {
    lines.push('  analytics: (unavailable)');
  }
  lines.push('');

  // ─── Rep on file ────────────────────────────────────────────────
  lines.push(`REP ON FILE: ${payload.assigned_user || '(unassigned)'}`);
  lines.push('');

  // ─── Lead history signals ───────────────────────────────────────
  const tags = Array.isArray(context?.decoded_contact?.profile?.tags)
    ? context.decoded_contact.profile.tags
    : [];
  const cfAi = context?.decoded_contact?.custom_fields?.ai;
  const cfChatbot = context?.decoded_contact?.custom_fields?.chatbot;
  const timeline = Array.isArray(context?.timeline) ? context.timeline : [];

  const demoFromTag = tags.some(t => String(t || '').toLowerCase() === 'lp-demo-completed');
  const demoFromLead = Boolean(lead.demo_completed);
  const demoCompleted = demoFromTag || demoFromLead;

  const appointmentsBooked = Number.isFinite(Number(lead.appointment_set))
    ? Number(lead.appointment_set)
    : timeline.filter(e => /appointment_booked|appointment_set|appointment_created/.test(String(e.type || ''))).length;

  const priorCancellationsTimeline = timeline.filter(e =>
    /appointment_cancelled/.test(String(e.type || '')),
  ).length;
  const priorCancelTag = tags.some(t => String(t || '').toLowerCase().includes('appt-cancelled')) ? 1 : 0;
  const priorCancellations = Math.max(priorCancellationsTimeline, priorCancelTag);

  const priorReschedules = timeline.filter(e =>
    /appointment_rescheduled/.test(String(e.type || '')),
  ).length;

  const intentSignals = tags.filter(t => String(t || '').toLowerCase().startsWith('intent-'));
  const concernSignals = tags.filter(t => {
    const s = String(t || '').toLowerCase();
    return s.startsWith('concern-expressed:') || s.startsWith('objection-');
  });

  const painPoint = cfValue(cfAi, 'Pain Point');

  lines.push('LEAD HISTORY SIGNALS (use these to write "WHY" and "WHAT TO DO" — do not echo verbatim):');
  lines.push(`  demo_completed: ${demoCompleted ? 'true' : 'false'}`);
  lines.push(`  appointments_booked: ${appointmentsBooked}`);
  lines.push(`  prior_cancellations: ${priorCancellations}`);
  lines.push(`  prior_reschedules:   ${priorReschedules}`);
  lines.push(`  call_count:          ${lead.call_count ?? 0}`);
  lines.push(`  most_recent_disposition: ${lead.disposition_label || '(none)'}`);
  lines.push(`  intent_signals:  ${intentSignals.join(', ') || '(none)'}`);
  lines.push(`  concern_signals: ${concernSignals.join(', ') || '(none)'}`);
  lines.push(`  pain_point:      ${painPoint || ''}`);
  lines.push('');

  // ─── Cancellation reason candidates ─────────────────────────────
  const aiShortSummary = cfValue(cfAi, 'AI Short Summary');
  const lastSentiment = cfValue(cfAi, 'Last Sentiment');

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

  lines.push('CANCELLATION REASON CANDIDATES (use to write "WHY" — pick the strongest):');
  lines.push(`  ai_short_summary: ${aiShortSummary || ''}`);
  lines.push(`  last_sentiment:   ${lastSentiment || ''}`);
  lines.push(`  most_recent_note: ${mostRecentNote}`);
  lines.push(`  most_recent_call_outcome: ${mostRecentCallOutcome}`);
  lines.push(`  chat_transcript_tail: ${chatTranscriptTail}`);
  lines.push('');

  // ─── Timeline ───────────────────────────────────────────────────
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

  // ─── Data gaps ──────────────────────────────────────────────────
  const gaps = Array.isArray(context?.data_gaps) ? context.data_gaps : [];
  lines.push(`DATA GAPS: ${gaps.length ? gaps.join('; ') : 'none'}`);
  lines.push('');

  lines.push('Write the email and SMS bodies per the SYSTEM PROMPT.');
  return lines.join('\n');
}

async function callClaude({ system, user, maxTokens, temperature }) {
  // json:true → OpenAI response_format=json_object (the prompt mandates a JSON
  // object); ignored for Anthropic. Returns the resolved model for logging.
  const { text, model } = await callLLM({
    fn: 'appt_notification',
    system,
    user,
    maxTokens,
    temperature,
    json: true,
  });

  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('llm_empty_text');
  return { text: trimmed, model };
}

/**
 * Defensive JSON extractor. Same pattern as
 * src/nurture/nurture-generator.js — tolerates stray markdown fences
 * or preamble despite the system prompt forbidding them.
 */
export function extractJson(rawText) {
  const trimmed = String(rawText).trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }
  const fenceStripped = trimmed
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  let candidate = fenceStripped;
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error(`non_json_response:${trimmed.slice(0, 200)}`);
    }
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`malformed_json:${candidate.slice(0, 200)}`);
  }
}

/**
 * Strip markdown defensively in case the model slips a stray ** or _.
 * The system prompt forbids markdown, but defense-in-depth keeps the
 * email/SMS clean either way.
 */
export function stripMarkdown(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, '')  // fenced blocks first — must run before single-backtick
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

/**
 * Hard-cap a body at `max` chars. Truncates with a trailing ellipsis.
 * This is the LAST line of defense — the model is asked to stay under
 * the cap, but if it overshoots we still ship a valid payload.
 */
export function enforceCharCap(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Main export. Returns { email_body, sms_body, model, request_id, latency_ms }.
 * Throws on Claude failure or missing-keys-in-JSON (caller turns the
 * throw into a 5xx).
 */
export async function generateAppointmentBody({ payload, context }) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const startedAt = Date.now();

  const user = buildUserPrompt({ payload, context });
  // A missing provider credential now throws from inside the client (the
  // caller turns the throw into a 5xx, same as before).
  const { text: raw, model } = await callClaude({
    system: SYSTEM_PROMPT,
    user,
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
  if (typeof parsed.sms_body !== 'string' || parsed.sms_body.length === 0) {
    throw new Error('sms_body_missing_or_empty');
  }

  const email_body = enforceCharCap(stripMarkdown(parsed.email_body), EMAIL_CHAR_CAP);
  const sms_body = enforceCharCap(stripMarkdown(parsed.sms_body), SMS_CHAR_CAP);

  const elapsed = Date.now() - startedAt;
  console.log(
    `[ApptNotif] [${requestId}] generated status=${payload.status} title="${payload.appointment_title}" ` +
      `email_chars=${email_body.length} sms_chars=${sms_body.length} model=${model} (${elapsed}ms)`,
  );

  return {
    email_body,
    sms_body,
    model,
    request_id: requestId,
    latency_ms: elapsed,
  };
}

export const _internal = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  formatApptDateTime,
  stripMarkdown,
  enforceCharCap,
  extractJson,
  EMAIL_CHAR_CAP,
  SMS_CHAR_CAP,
};
