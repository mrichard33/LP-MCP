/**
 * Task Handler — src/actions/handlers/tasks.js
 *
 * create_task: GHL has no task API, so we use a GHL note + GroupMe
 * notification combo. The note preserves the task for historical record
 * on the contact; the GroupMe ping surfaces it to the team.
 *
 * v2.2 (2026-06-11) — REQUIRED-FIELD ENRICHMENT (resolvers v3.11 /
 *   enrichment v5.0). Threads the GHL contact snapshot through prospect
 *   resolution (enabling the prospect-ID write-back) and enrichment, so
 *   AGENT TASK cards now carry Market, Src (LP Source > Subsource), loss
 *   reason, and full appointment date+time — the "📅 2:00 PM"
 *   date-missing bug is fixed at the enrichment layer. Interpolation
 *   context gains the same keys notifications.js v3 exposes
 *   ({{market}}, {{loss_reason}}, {{calc_summary}},
 *   {{appointment_datetime}}, ...).
 *
 * v2.1 (2026-05-14) — OPT IN TO v1.7 GROUPME DEBOUNCE.
 * v2.0 (2026-05-01) — RICH GROUPME NOTIFICATIONS.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { addGHLNote } from '../../ghl.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { interpolatePayload, isLPLeadId } from '../helpers.js';
import { formatDateTime } from '../../format-helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification, formatCalcSummary } from '../enrichment.js';

export async function executeCreateTask(action, context) {
  const contactId = action.target_id;

  // ── Pull contact info, prospect, and enrichment ────────────────────
  // Same shape as executeSendNotification so the formatted output is
  // visually consistent across both action types. v2.2: thread the GHL
  // contact snapshot through (zero extra API calls, enables prospect-ID
  // write-back + market/source/reason enrichment).
  const { name, phone, lpLead, ghlContactId, ghlContact } = await resolveContactInfo(contactId, context);
  const prospectId = await resolveLPProspectId(contactId, { ghlContact });
  const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId, ghlContact });

  // v2.2 — combined appointment date+time (never time-only) + calc summary
  const appointmentDisplay = (enrichment.appointmentDate || enrichment.appointmentTime)
    ? (formatDateTime(enrichment.appointmentDate || enrichment.appointmentTime,
        enrichment.appointmentDate ? enrichment.appointmentTime : null)
        || enrichment.appointmentDate || enrichment.appointmentTime)
    : null;
  const calcSummary = formatCalcSummary(enrichment);

  // ── Interpolate payload with full context ─────────────────────────
  // Rules use {{contact_name}} / {{startDate}} / {{startTime}} / etc.
  // in their description templates. Adding name/phone/contactId to the
  // context lets those merge tags resolve.
  const enrichedContext = {
    ...context,
    contact_name: name,
    contact_id: contactId,
    contact_phone: phone || '',
    lp_prospect_id: prospectId,
    // v2.2 — same interpolation keys as notifications.js v3
    loss_reason: enrichment.lossReason || 'not recorded',
    market: enrichment.market || 'Unknown',
    lp_source: enrichment.lpSource || '',
    lp_subsource: enrichment.lpSourceDetail || '',
    calc_windows: enrichment.calcWindows || '',
    calc_doors: enrichment.calcDoors || '',
    calc_estimate: enrichment.calcEstimate || '',
    calc_summary: calcSummary || '',
    appointment_datetime: appointmentDisplay || '',
  };
  const payload = interpolatePayload(action.action_payload, enrichedContext);
  const title = payload?.title || 'Agent task';
  const description = typeof payload?.description === 'string' ? payload.description : '';
  const assignedTo = typeof payload?.assigned_to === 'string' ? payload.assigned_to : null;

  // ── GHL note: audit trail (unchanged from v1.0) ───────────────────
  const noteText = description ? `[AGENT TASK] ${title}\n${description}` : `[AGENT TASK] ${title}`;
  if (!isLPLeadId(contactId)) {
    await addGHLNote(contactId, noteText).catch(err => {
      console.warn(`[ActionExecutor] create_task: GHL note add failed for ${contactId}: ${err.message}`);
    });
  }

  // ── Build rich GroupMe notification ───────────────────────────────
  // baseMessage becomes the 🤖 header line. Description and assignment
  // are appended below the standard rich-context block so reviewers
  // see rule-specific instructions inline without opening GHL.
  const baseMessage = `AGENT TASK: ${title}`;
  let full = buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment });
  if (description) {
    // Cap description at 600 chars to keep the GroupMe message readable;
    // the full description is preserved in the GHL note above.
    const trimmed = description.length > 600 ? description.slice(0, 600) + '…' : description;
    full += `\n📝 ${trimmed}`;
  }
  if (assignedTo) {
    full += `\n👉 Assigned: ${assignedTo}`;
  }

  // v2.1: opt in to groupme.js v1.7 debounce — passing contactId routes
  // through the in-memory consolidation buffer keyed by contact. Tasks
  // are the most common multi-fire case (one inbound → multiple agent
  // rules → multiple tasks for the same contact within ~600ms).
  await sendGroupMeMessage(full, { contactId, contactName: name }).catch(err => {
    console.warn(`[ActionExecutor] create_task: GroupMe send failed for ${contactId}: ${err.message}`);
  });

  console.log(`[ActionExecutor] ✅ create_task completed for ${contactId}: title="${title.slice(0, 60)}" desc=${description ? 'yes' : 'no'} assigned=${assignedTo || 'n/a'}`);

  return {
    action: 'task_created',
    contact_id: contactId,
    title,
    description: description ? description.slice(0, 200) : null,
    assigned_to: assignedTo,
  };
}
