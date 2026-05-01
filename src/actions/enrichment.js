/**
 * Enrichment — src/actions/enrichment.js
 *
 * GroupMe approval/notification enrichment builders. Pulls decision context
 * from the event payload, lp_leads, and lead_intelligence so approval cards
 * are self-sufficient and reviewers can approve without opening GHL/LP.
 *
 * Extracted from action-executor.js v4.2 refactor.
 *
 * v4.2 (2026-05-01) — ALWAYS-RENDER PROSPECT LINE.
 *   PROBLEM: buildRichNotification omitted the Prospect line entirely
 *   when prospectId was null/missing. Reviewers had no way to tell
 *   from the GroupMe message whether a contact was already in LP or
 *   not — absence-of-line could mean either "not in LP yet" or "we
 *   forgot to include it."
 *
 *   FIX (per Mark's directive): always render the Prospect line.
 *   When the ID is present and meaningful, render the digits. When
 *   absent or sentinel "Not in LP", render "NONE" so the absence is
 *   itself signal — a reviewer seeing "Prospect: NONE" knows
 *   immediately the lead hasn't been pushed to LP yet (and can take
 *   action accordingly).
 *
 *   Edge cases:
 *     prospectId = "427403"     → "Prospect: 427403"
 *     prospectId = null         → "Prospect: NONE"
 *     prospectId = undefined    → "Prospect: NONE"
 *     prospectId = "Not in LP"  → "Prospect: NONE"
 *     prospectId = ""           → "Prospect: NONE"
 *
 * v4.1 (2026-05-01) — Optional headerEmoji on buildRichNotification.
 *   Channel-specific notifications (send-message-handler v3.6) can pass
 *   '📱' for SMS or '📧' for email so the header emoji matches the channel
 *   rather than the generic 🤖. Defaults to '🤖' when not provided so all
 *   existing callers (executeSendNotification, executeCreateTask v2.0)
 *   render unchanged.
 *
 * v4.0 (2026-05-01) — LP SOURCE / SUB-SOURCE SPLIT.
 *   PROBLEM: enrichment.lpSource collapsed lead_source (parent — e.g.
 *   "Reece ChatBot") and lead_source_detail (sub — e.g. "Window Estimate
 *   Calculator") into a single field with the latter winning. Reviewers
 *   only saw the sub-source, not the parent — losing the channel-of-origin
 *   signal that matters for routing/attribution decisions.
 *
 *   FIX: Capture both as separate fields:
 *     lpSource        = lpLead.lead_source        (parent / channel)
 *     lpSourceDetail  = lpLead.lead_source_detail (sub / specific origin)
 *
 *   buildRichNotification renders both when present:
 *     📋 Src: Reece ChatBot > Window Estimate Calculator | Rep: ... | Disp: ...
 *
 *   Edge cases:
 *     Both present  → "Src: <parent> > <sub>"
 *     Parent only   → "Src: <parent>"
 *     Sub only      → "Src: <sub>"   (rare — defends against LP rows
 *                                     where the parent is null but sub is set)
 *     Neither       → 📋 line skipped entirely
 *
 *   Mark surfaced this requirement after seeing GroupMe notifications that
 *   were missing source breakdown — wanted parent + sub visible across
 *   ALL notification types so attribution context is always one glance away.
 *
 * v3.9 + v4.2 — message_preview fallback for ai.analysis_completed events.
 */

import supabase from '../supabase.js';
import { formatPhone, formatDateTime } from '../format-helpers.js';
import { isLPLeadId } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION ENRICHMENT BUILDER
// ═══════════════════════════════════════════════════════════════════

export async function buildNotificationEnrichment(contactId, context = {}, { lpLead = null, prospectId = null, ghlContactId = null } = {}) {
  const enrichment = {
    // v4.2 — accept message_preview as a fallback. It is the field on
    // ai.analysis_completed events, which is what AGENTIC_* rules fire on.
    messageText: context.message_text || context.messageText || context.body || context.message_preview || null,
    messageType: context.message_type || context.messageType || null,

    // v4.0 — parent source AND sub-source captured separately. The 📋
    // line in buildRichNotification renders them as "Src: <parent> > <sub>"
    // when both are present, or one of them when only one is set.
    lpSource: null,        // lead_source        — channel of origin (e.g. "Reece ChatBot", "Canvass")
    lpSourceDetail: null,  // lead_source_detail — specific subtype  (e.g. "Window Estimate Calculator")

    repName: null,
    disposition: null,
    prospectId: prospectId && prospectId !== 'Not in LP' ? prospectId : null,
    score: context.score || context.intent_score || null,
    tier: context.tier || context.intent_tier || null,
    barrier: context.barrier || context.psychological_barrier || null,
    briefing: context.briefing || context.rep_briefing || null,
    aiSummary: context.ai_summary || context.ai_reasoning || null,
    objection: context.objection_type || null,
    appointmentDate: context.start_time || context.appointment_date || null,
    calendarName: context.calendar_name || null,
  };

  if (lpLead) {
    // v4.0: split source into parent / sub. Previous behavior collapsed
    // lead_source_detail || lead_source into a single lpSource field;
    // both fields are now preserved.
    if (!enrichment.lpSource) enrichment.lpSource = lpLead.lead_source || null;
    if (!enrichment.lpSourceDetail) enrichment.lpSourceDetail = lpLead.lead_source_detail || null;
    if (!enrichment.repName) enrichment.repName = lpLead.rep_name || null;
    if (!enrichment.disposition) enrichment.disposition = lpLead.disposition_label || lpLead.disposition_code || null;
    if (!enrichment.appointmentDate) enrichment.appointmentDate = lpLead.appointment_date || null;
  }

  const intelKey = ghlContactId || (lpLead?.ghl_contact_id) || (isLPLeadId(contactId) ? null : contactId);
  if (intelKey) {
    try {
      const { data: intel } = await supabase.from('lead_intelligence')
        .select('intent_score, intent_tier, objection_type, psychological_barrier, rep_briefing, ai_reasoning')
        .eq('ghl_contact_id', intelKey)
        .maybeSingle();
      if (intel) {
        if (!enrichment.score) enrichment.score = intel.intent_score || null;
        if (!enrichment.tier) enrichment.tier = intel.intent_tier || null;
        if (!enrichment.barrier) enrichment.barrier = intel.psychological_barrier || null;
        if (!enrichment.briefing) enrichment.briefing = intel.rep_briefing || null;
        if (!enrichment.aiSummary) enrichment.aiSummary = intel.ai_reasoning || null;
        if (!enrichment.objection) enrichment.objection = intel.objection_type || null;
      }
    } catch {}
  }

  return enrichment;
}

// ═══════════════════════════════════════════════════════════════════
// RICH NOTIFICATION FORMATTER — used by send_notification, create_task,
// and (v3.6+) send_message handlers
// ═══════════════════════════════════════════════════════════════════

export function buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment = {}, headerEmoji = '🤖' }) {
  const lines = [];
  // v4.1: headerEmoji defaults to 🤖 for backward compat. Channel-specific
  // notifications (send-message-handler v3.6) pass 📱/📧.
  lines.push(`${headerEmoji} ${baseMessage}`);
  const displayPhone = formatPhone(phone);
  const nameLine = `👤 ${name || 'Unknown'}${displayPhone ? ` ${displayPhone}` : ''}`;
  lines.push(nameLine);
  const idLabel = isLPLeadId(contactId) ? 'LP Lead ID' : 'Contact ID';
  const idParts = [`${idLabel}: ${contactId}`];
  // v4.2 (2026-05-01): always render the Prospect line. Per Mark's directive,
  // absence-of-Prospect-ID is itself signal — a reviewer seeing "Prospect: NONE"
  // immediately knows the lead hasn't been pushed to LP yet (and can take
  // action). Previous behavior omitted the line entirely when prospectId
  // was null/empty/sentinel, which made it indistinguishable from a bug.
  const prospectClean = (prospectId && String(prospectId).trim() && prospectId !== 'Not in LP')
    ? String(prospectId)
    : 'NONE';
  idParts.push(`Prospect: ${prospectClean}`);
  lines.push(`   ${idParts.join(' | ')}`);
  if (enrichment.messageText) {
    const msg = String(enrichment.messageText).slice(0, 120);
    const suffix = enrichment.messageType ? ` [${enrichment.messageType}]` : '';
    lines.push(`💬 "${msg}"${suffix}`);
  }

  // v4.0: render LP source as "parent > sub" when both are present.
  // Falls back to whichever single field is set, or omits the line entirely.
  const lpParts = [];
  if (enrichment.lpSource && enrichment.lpSourceDetail) {
    lpParts.push(`Src: ${enrichment.lpSource} > ${enrichment.lpSourceDetail}`);
  } else if (enrichment.lpSource) {
    lpParts.push(`Src: ${enrichment.lpSource}`);
  } else if (enrichment.lpSourceDetail) {
    // Edge case: parent missing but sub is set. Use sub as the source.
    lpParts.push(`Src: ${enrichment.lpSourceDetail}`);
  }
  if (enrichment.repName) lpParts.push(`Rep: ${enrichment.repName}`);
  if (enrichment.disposition) lpParts.push(`Disp: ${enrichment.disposition}`);
  if (lpParts.length) lines.push(`📋 ${lpParts.join(' | ')}`);

  if (enrichment.score || enrichment.tier || enrichment.barrier) {
    const intentParts = [];
    if (enrichment.score) intentParts.push(`Score: ${enrichment.score}`);
    if (enrichment.tier) intentParts.push(`Tier: ${enrichment.tier}`);
    if (enrichment.barrier) intentParts.push(`Barrier: ${enrichment.barrier}`);
    lines.push(`📊 ${intentParts.join(' | ')}`);
  }
  if (enrichment.appointmentDate) {
    const prefix = enrichment.calendarName ? `${enrichment.calendarName}: ` : '';
    const displayDate = formatDateTime(enrichment.appointmentDate) || enrichment.appointmentDate;
    lines.push(`📅 ${prefix}${displayDate}`);
  }
  return lines.join('\n');
}
