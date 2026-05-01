/**
 * Task Handler — src/actions/handlers/tasks.js
 *
 * create_task: GHL has no task API, so we use a GHL note + GroupMe
 * notification combo. The note preserves the task for historical record
 * on the contact; the GroupMe ping surfaces it to the team.
 *
 * v2.0 (2026-05-01) — RICH GROUPME NOTIFICATIONS.
 *
 * v1.0 (the version this replaces) shipped a 2-line GroupMe message:
 *   🤖 AGENT TASK: <title>
 *   Contact: <name> (<phone>)
 *
 * That format dropped the action_payload's `description` field on the
 * floor for GroupMe (description was only persisted to the GHL note).
 * Rich rules like BEHAVIORAL_APPT_CANCELLED and TRUST_BREAK_ACCURACY
 * already populate description with full context — none of it was
 * reaching the human reviewer's phone.
 *
 * v2.0 mirrors executeSendNotification's pattern: pulls
 * buildNotificationEnrichment + buildRichNotification so the GroupMe
 * message includes lead context, LP source/rep/disposition, intent
 * score/tier/barrier, inbound message preview, and appointment context.
 * The action_payload's `description` field is appended below the context
 * block so rule-specific instructions show inline. The `assigned_to`
 * field is also surfaced on its own line.
 *
 * The GHL note still gets the title + description verbatim (audit
 * trail purpose unchanged).
 *
 * Mark's complaint that surfaced this fix: he was getting "🤖 AGENT
 * TASK: LP Issue disposition — needs human review / Contact: <name>
 * (<phone>)" notifications repeatedly with no actionable context. The
 * underlying LP_DISP_ISSUE rule was also wrong (Issue is a routine LP
 * disposition, not a problem flag) — that rule is now disabled in
 * agent_rules. v2.0 is the systemic fix so the next noisy rule that
 * fires create_task at least produces a useful message.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { addGHLNote } from '../../ghl.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { interpolatePayload, isLPLeadId } from '../helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from '../enrichment.js';

export async function executeCreateTask(action, context) {
  const contactId = action.target_id;

  // ── Pull contact info, prospect, and enrichment in parallel ───────
  // Same shape as executeSendNotification so the formatted output is
  // visually consistent across both action types.
  const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(contactId, context);
  const prospectId = await resolveLPProspectId(contactId);
  const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId });

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

  await sendGroupMeMessage(full).catch(err => {
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
