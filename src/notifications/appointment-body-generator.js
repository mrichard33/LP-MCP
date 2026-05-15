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
 *   - Missing ANTHROPIC_API_KEY   → throws
 *   - Claude API error / timeout  → throws
 *   - Empty model response        → throws
 *   - Non-JSON / malformed JSON   → throws (defensive extractJson)
 *   - Missing email_body or sms_body in parsed JSON → throws
 *
 * The endpoint orchestrator turns these throws into a 5xx; the
 * notification gate stays unflipped, and the GHL workflow's 30-min
 * timeout fires the fallback notification path.
 */

import crypto from 'crypto';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL =
  process.env.APPT_NOTIFICATION_MODEL ||
  process.env.NURTURE_GENERATOR_MODEL ||
  'claude-sonnet-4-5';
const MAX_TOKENS = parseInt(process.env.APPT_NOTIFICATION_MAX_TOKENS || '700', 10);
const TIMEOUT_MS = parseInt(process.env.APPT_NOTIFICATION_TIMEOUT_MS || '8000', 10);
const TEMPERATURE = parseFloat(process.env.APPT_NOTIFICATION_TEMPERATURE || '0.4');

const EMAIL_CHAR_CAP = parseInt(process.env.APPT_NOTIFICATION_EMAIL_CAP || '1500', 10);
const SMS_CHAR_CAP = parseInt(process.env.APPT_NOTIFICATION_SMS_CAP || '300', 10);

const SYSTEM_PROMPT = `You generate TWO bodies for one internal sales-ops alert when an appointment changes status. Both go to the Reece Windows & Doors dispatch distribution list (Dispatch, Edwin, Trudy, Jazmine) via GHL's native internal_notification steps — an EMAIL and an SMS. You write both at once.

OUTPUT
Return ONLY valid JSON with exactly two string keys:
  { "email_body": "...", "sms_body": "..." }
No preamble, no markdown fences, no commentary. First character is {, last character is }.

VOICE
Factual operations alert. Past-tense neutral. Reps and dispatch read these to act on, not to feel.
- No marketing language, no apologies, no exclamation marks.
- No markdown — GHL email renders plain text with newlines; SMS strips formatting.
- First person plural is fine ("we", "the team") in the rep-action line.

UNIVERSAL RULES
- Use \`appointment_title\` from the input VERBATIM in both bodies. If the input says "Roof Estimate", write "Roof Estimate". NEVER substitute, abbreviate, or hardcode "Window Estimate" or any other calendar name.
- Header line per status:
    Cancelled:    ❌ {appointment_title} CANCELLED — {first_name} {last_name}
    Rescheduled:  🔄 {appointment_title} RESCHEDULED — {first_name} {last_name}
- Never fabricate. If a field is missing from the input/context, omit it gracefully — no empty parens, no dangling punctuation, no "undefined".
- Never reference internal architecture (no "workflow", no UUIDs, no "system_events", no "Layer 3").
- Never speculate about WHY the lead cancelled or rescheduled unless the provided timeline shows direct evidence.

═══════════════════════════════════════════════════════════
EMAIL BODY — target 600-1200 chars, hard cap 1500
═══════════════════════════════════════════════════════════
5 blocks separated by blank lines. No labels except where shown.

1) Header line (per status, see UNIVERSAL RULES)

2) Contact essentials — three lines, drop any line whose value is missing:
   Phone: {phone}
   Email: {email}
   City:  {city}

3) Appointment timing:
   Cancelled:
     Was: {start_date} at {start_time}
   Rescheduled:
     Was: {previous_start_date} at {previous_start_time}
     Now: {start_date} at {start_time}

4) Source line + close-rate intel (one line each):
   Source: {lp_source} → {lp_subsource}
   Source intel: {N} closed of {M} ({pct}% close rate, last 90d)
   (If lp_source or lp_subsource missing, write "Source: not on file" and "Source intel: not available".)

5) Recent activity — 1-2 short bullets from the provided timeline. Each bullet ≤ 100 chars.
   • Most recent meaningful event (call disposition, last note, demo, etc.)
   • Optional second bullet only if a second event is genuinely relevant.
   (If no relevant prior activity, write "• No prior call or note history.")

6) Lifecycle / trust state, when provided:
   Lifecycle: {lifecycle_stage} · Trust: {trust_state}
   (Omit the entire line if neither value is provided.)

7) Closer — two lines:
   Rep: {assigned_user, or "unassigned"}
   Next: {one concise dispatch directive — e.g. "rebook within 48h", "call to confirm new slot", "review cancel reason"}

═══════════════════════════════════════════════════════════
SMS BODY — target ≤220 chars, hard cap 300
═══════════════════════════════════════════════════════════
One or at most two lines. No headers, no blank lines. Drop fields gracefully when missing.

Template shapes (adapt the wording, do not copy literally if a field is missing):

  Cancelled:
    ❌ APPT CANCELLED: {first} {last} ({phone}) — {appt_title} {start_date} {start_time}. Src: {lp_source}/{lp_subsource}. Stage: {lifecycle_stage}. Reach out to reschedule.

  Rescheduled:
    🔄 APPT RESCHEDULED: {first} {last} ({phone}) — {appt_title} moved {previous_start_date} {previous_start_time} → {start_date} {start_time}. Src: {lp_source}/{lp_subsource}.

Rules:
- When phone is missing, drop "(phone)" entirely — no empty parens.
- When lp_source or lp_subsource is missing, drop the "Src:" segment entirely.
- When lifecycle_stage is missing, drop "Stage: …".
- Result MUST be ≤ 300 chars. Tighten the dispatch sentence first; never truncate the contact name.

═══════════════════════════════════════════════════════════
JSON OUTPUT FORMAT
═══════════════════════════════════════════════════════════
{
  "email_body": "❌ Window Estimate CANCELLED — Jane Doe\\n\\nPhone: (555) 111-2222\\nCity: Boca Raton\\n\\nWas: 2026-05-20 at 10:00 AM\\n\\nSource: facebook_ad → windows_florida_jan\\nSource intel: 18 closed of 100 (18% close rate, last 90d)\\n\\n• Last call 2026-05-14: Connected, customer confirmed interest.\\n\\nLifecycle: warm · Trust: building\\n\\nRep: Alex Rep\\nNext: rebook within 48h",
  "sms_body": "❌ APPT CANCELLED: Jane Doe (555-111-2222) — Window Estimate 2026-05-20 10:00 AM. Src: facebook_ad/windows_florida_jan. Stage: warm. Reach out to reschedule."
}

Return ONLY the JSON object.`;

/**
 * Build the user-message context for Claude. Bundles the payload +
 * hybrid context into a structured block — Claude reads better off
 * "labeled facts" than "stuffed paragraphs."
 */
function buildUserPrompt({ payload, context }) {
  const lines = [];

  lines.push(`STATUS: ${payload.status}`);
  lines.push(`APPOINTMENT_TITLE (use verbatim): ${payload.appointment_title}`);
  lines.push(`CALENDAR_ID: ${payload.calendar_id}`);
  lines.push('');

  lines.push('CONTACT (from payload):');
  lines.push(`  first_name: ${payload.contact_first_name || ''}`);
  lines.push(`  last_name:  ${payload.contact_last_name || ''}`);
  lines.push(`  phone:      ${payload.contact_phone || ''}`);
  lines.push(`  email:      ${payload.contact_email || ''}`);
  lines.push(`  city:       ${payload.city || ''}`);
  lines.push(`  postal:     ${payload.postal_code || ''}`);
  lines.push(`  assigned:   ${payload.assigned_user || ''}`);
  lines.push(`  lifecycle:  ${payload.lifecycle_stage || ''}`);
  lines.push(`  trust:      ${payload.trust_state || ''}`);
  lines.push('');

  lines.push('APPOINTMENT TIMING:');
  lines.push(`  start_date:          ${payload.start_date || ''}`);
  lines.push(`  start_time:          ${payload.start_time || ''}`);
  if (payload.status === 'rescheduled') {
    lines.push(`  previous_start_date: ${payload.previous_start_date || ''}`);
    lines.push(`  previous_start_time: ${payload.previous_start_time || ''}`);
  }
  lines.push('');

  lines.push('SOURCE:');
  lines.push(`  lp_source:    ${payload.lp_source || '(empty)'}`);
  lines.push(`  lp_subsource: ${payload.lp_subsource || '(empty)'}`);
  if (context.source_analytics) {
    const a = context.source_analytics;
    lines.push(
      `  source_analytics: matched_on=${a.matched_on} total_leads=${a.total_leads} closed_won=${a.closed_won} close_rate_pct=${a.close_rate_pct ?? 'n/a'} total_revenue=${a.total_revenue}`,
    );
  } else {
    lines.push('  source_analytics: NOT AVAILABLE');
  }
  lines.push('');

  // Decoded contact summary (live GHL).
  if (context.decoded_contact) {
    const p = context.decoded_contact.profile || {};
    lines.push('LIVE GHL CONTACT:');
    lines.push(`  ghl_phone:  ${p.phone || ''}`);
    lines.push(`  ghl_city:   ${p.city || ''}`);
    lines.push(`  ghl_tags:   ${(p.tags || []).slice(0, 6).join(', ')}`);
    if (p.assigned_to) lines.push(`  assigned_to_id: ${p.assigned_to}`);
    lines.push('');
  }

  // Lead summary (LP record + recent activity).
  if (context.lead_summary && context.lead_summary.lead) {
    const l = context.lead_summary.lead;
    lines.push('LP LEAD:');
    lines.push(
      `  lp_lead_id=${l.lp_lead_id} disposition=${l.disposition_label || l.disposition_code || '(none)'} rep=${l.rep_name || '(none)'} job_value=${l.job_value || '?'} closed_won=${!!l.closed_won}`,
    );
    const recent = context.lead_summary.recent || {};
    if (recent.calls?.length) {
      const c = recent.calls[0];
      lines.push(
        `  most_recent_call: ${c.call_date} outcome="${c.outcome || c.call_type || ''}" rep=${c.rep_name || ''}`,
      );
    }
    if (recent.notes?.length) {
      const n = recent.notes[0];
      const body = String(n.note_body || n.body || '').trim().slice(0, 140);
      lines.push(`  most_recent_note: ${n.created_at_lp} "${body}"`);
    }
    lines.push('');
  }

  // Timeline (top events across LP + system events).
  if (context.timeline && context.timeline.length) {
    lines.push('TIMELINE (most recent first, top 6 shown):');
    for (const ev of context.timeline.slice(0, 6)) {
      lines.push(`  - ${ev.ts} [${ev.type}] ${ev.summary}`);
    }
    lines.push('');
  }

  if (context.data_gaps && context.data_gaps.length) {
    lines.push(`DATA GAPS (sources that failed or were skipped): ${context.data_gaps.join('; ')}`);
    lines.push('');
  }

  lines.push('Write both bodies now, following the SYSTEM PROMPT exactly. Return ONLY the JSON object.');
  return lines.join('\n');
}

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
  if (typeof parsed.sms_body !== 'string' || parsed.sms_body.length === 0) {
    throw new Error('sms_body_missing_or_empty');
  }

  const email_body = enforceCharCap(stripMarkdown(parsed.email_body), EMAIL_CHAR_CAP);
  const sms_body = enforceCharCap(stripMarkdown(parsed.sms_body), SMS_CHAR_CAP);

  const elapsed = Date.now() - startedAt;
  console.log(
    `[ApptNotif] [${requestId}] generated status=${payload.status} title="${payload.appointment_title}" ` +
      `email_chars=${email_body.length} sms_chars=${sms_body.length} model=${MODEL} (${elapsed}ms)`,
  );

  return {
    email_body,
    sms_body,
    model: MODEL,
    request_id: requestId,
    latency_ms: elapsed,
  };
}

export const _internal = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  stripMarkdown,
  enforceCharCap,
  extractJson,
  EMAIL_CHAR_CAP,
  SMS_CHAR_CAP,
};
