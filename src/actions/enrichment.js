/**
 * Enrichment — src/actions/enrichment.js
 *
 * GroupMe approval/notification enrichment builders. Pulls decision context
 * from the event payload, lp_leads, and lead_intelligence so approval cards
 * are self-sufficient and reviewers can approve without opening GHL/LP.
 *
 * Extracted from action-executor.js v4.2 refactor. Includes the v4.2
 * message_preview fallback that unbreaks the 💬 inbound-message line on
 * approval cards triggered by ai.analysis_completed events.
 */

import supabase from '../supabase.js';
import { formatPhone, formatDateTime } from '../format-helpers.js';
import { isLPLeadId } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION ENRICHMENT BUILDER (v3.9 + v4.2 message_preview fallback)
// ═══════════════════════════════════════════════════════════════════

export async function buildNotificationEnrichment(contactId, context = {}, { lpLead = null, prospectId = null, ghlContactId = null } = {}) {
  const enrichment = {
    // v4.2 — accept message_preview as a fallback. It is the field on
    // ai.analysis_completed events, which is what AGENTIC_* rules fire on.
    messageText: context.message_text || context.messageText || context.body || context.message_preview || null,
    messageType: context.message_type || context.messageType || null,
    lpSource: null,
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
    if (!enrichment.lpSource) enrichment.lpSource = lpLead.lead_source_detail || lpLead.lead_source || null;
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
// RICH NOTIFICATION FORMATTER — used by send_notification action
// ═══════════════════════════════════════════════════════════════════

export function buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment = {} }) {
  const lines = [];
  lines.push(`🤖 ${baseMessage}`);
  const displayPhone = formatPhone(phone);
  const nameLine = `👤 ${name || 'Unknown'}${displayPhone ? ` ${displayPhone}` : ''}`;
  lines.push(nameLine);
  const idLabel = isLPLeadId(contactId) ? 'LP Lead ID' : 'Contact ID';
  const idParts = [`${idLabel}: ${contactId}`];
  if (prospectId && prospectId !== 'Not in LP') idParts.push(`Prospect: ${prospectId}`);
  lines.push(`   ${idParts.join(' | ')}`);
  if (enrichment.messageText) {
    const msg = String(enrichment.messageText).slice(0, 120);
    const suffix = enrichment.messageType ? ` [${enrichment.messageType}]` : '';
    lines.push(`💬 "${msg}"${suffix}`);
  }
  const lpParts = [];
  if (enrichment.lpSource) lpParts.push(`Src: ${enrichment.lpSource}`);
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
