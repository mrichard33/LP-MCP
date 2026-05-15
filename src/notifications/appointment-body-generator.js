/**
 * Appointment Notifications — Body Generator
 * src/notifications/appointment-body-generator.js
 *
 * Calls Claude (default claude-sonnet-4-5) with a tight system prompt
 * that enforces the GroupMe Reece Sales Board voice and the 5-block
 * structure defined in the build spec.
 *
 * Output is plain text (no markdown — GroupMe strips it) capped under
 * 1000 chars. The lead line uses `appointment_title` from the payload
 * verbatim, so the same endpoint serves Window Estimate, Roof Estimate,
 * In-Home Consult, etc.
 *
 * Failure modes:
 *   - Missing ANTHROPIC_API_KEY        → throws (caller marks notification failed)
 *   - Claude API error / timeout       → throws (caller marks notification failed)
 *   - Empty model response             → throws
 *
 * The endpoint orchestrator turns these throws into a 5xx and the
 * notification gate stays unflipped.
 */

import crypto from 'crypto';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL =
  process.env.APPT_NOTIFICATION_MODEL ||
  process.env.NURTURE_GENERATOR_MODEL ||
  'claude-sonnet-4-5';
const MAX_TOKENS = parseInt(process.env.APPT_NOTIFICATION_MAX_TOKENS || '600', 10);
const TIMEOUT_MS = parseInt(process.env.APPT_NOTIFICATION_TIMEOUT_MS || '8000', 10);
const TEMPERATURE = parseFloat(process.env.APPT_NOTIFICATION_TEMPERATURE || '0.4');
const HARD_CHAR_CAP = 990;

const SYSTEM_PROMPT = `You write ONE short GroupMe alert for the Reece Windows & Doors Sales Board when an appointment changes status. Reps read these between calls — every word has to earn its place.

VOICE
- Board-bot voice. Short, scannable, factual, neutral. No exclamation marks, no marketing fluff, no apologies.
- Plain text only. GroupMe strips markdown — no **bold**, no _italics_, no \`code\`, no links unless they're raw URLs.
- First person plural is fine for the action prompt ("we", "the team"). Never "I".

STRICT OUTPUT STRUCTURE (5 blocks, blank line between blocks, no headers, no labels except where shown)

Lead line — exact format depending on status:
  Cancelled:    ❌ {appointment_title} CANCELLED — {first_name} {last_name}
  Rescheduled:  🔄 {appointment_title} RESCHEDULED — {first_name} {last_name}

Block 1 — contact essentials, one line:
  {phone} · {city}
  (If city missing, drop the " · {city}". If phone missing, write "phone unknown".)

Block 2 — appointment timing:
  Cancelled:    Was: {start_date} {start_time}
  Rescheduled:  Was: {previous_start_date} {previous_start_time}
                Now: {start_date} {start_time}

Block 3 — source, on one line. Then a second line for close-rate intel if available, else "Source intel: not available":
  Source: {lp_source} → {lp_subsource}
  {N} closed of {M} ({pct}%, source intel)
  (If lp_source or lp_subsource is empty, write "Source: not on file" instead of the first line.)

Block 4 — recent activity, 1-2 bullets. Pull from the timeline / lead_summary in the context. Each bullet under 80 chars. Format:
  • {one-line summary of most recent meaningful event}
  • {second bullet only if a second event is genuinely relevant — e.g. last call disposition AND a note that contradicts it}
  (If no relevant activity, write a single bullet: "• No prior call/note history.")

Block 5 — assigned rep + next-action prompt, two lines:
  Rep: {assigned_user, or "unassigned"}
  Next: {one short directive for what the team should do — e.g. "rebook within 48h", "call to confirm new slot", "investigate cancel reason"}

HARD RULES
- Total length under 1000 chars including newlines. Aim for 400-700.
- Use the appointment_title VERBATIM from the input. If it says "Roof Estimate", the lead line says "Roof Estimate". Do NOT substitute, abbreviate, or replace.
- Never fabricate phone/city/source/rep. If a field is missing, follow the fallback rule above.
- Never reference internal architecture (no "workflow", no UUIDs, no "system_events", no "Layer 3").
- Never speculate about why the lead cancelled/rescheduled unless the timeline shows direct evidence.

OUTPUT
Return ONLY the message text. No preamble, no JSON wrapper, no quote fences. The first character is the lead-line emoji; the last character is the final character of the Next: line.`;

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

  // Decoded contact summary (live GHL) — pull the most actionable bits.
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

  lines.push('Write the message now, following the SYSTEM PROMPT exactly.');
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
 * Strip markdown defensively in case Claude slips a stray ** or _ —
 * the system prompt forbids it but defense-in-depth keeps the post
 * clean.
 */
function stripMarkdown(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
}

function enforceCharCap(text) {
  if (text.length <= HARD_CHAR_CAP) return text;
  return text.slice(0, HARD_CHAR_CAP - 1) + '…';
}

/**
 * Main export. Returns { text, model, request_id, latency_ms }.
 * Throws on Claude failure (caller turns that into a 5xx).
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

  const cleaned = enforceCharCap(stripMarkdown(raw));
  const elapsed = Date.now() - startedAt;
  console.log(
    `[ApptNotif] [${requestId}] generated status=${payload.status} title="${payload.appointment_title}" chars=${cleaned.length} model=${MODEL} (${elapsed}ms)`,
  );

  return {
    text: cleaned,
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
};
