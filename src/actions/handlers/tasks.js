/**
 * Task Handler — src/actions/handlers/tasks.js
 *
 * create_task: GHL has no task API, so we use a GHL note + GroupMe
 * notification combo. The note preserves the task for historical record
 * on the contact; the GroupMe ping surfaces it to the team.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { addGHLNote } from '../../ghl.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { interpolatePayload, isLPLeadId } from '../helpers.js';
import { resolveContactInfo } from '../resolvers.js';

export async function executeCreateTask(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  const title = payload?.title || 'Agent task';
  const description = payload?.description || '';
  const noteText = description ? `[AGENT TASK] ${title}\n${description}` : `[AGENT TASK] ${title}`;
  if (!isLPLeadId(contactId)) {
    await addGHLNote(contactId, noteText);
  }
  const { name, phone } = await resolveContactInfo(contactId, context);
  const contactLabel = name ? `${name}${phone ? ` (${phone})` : ''}` : contactId;
  await sendGroupMeMessage(`🤖 AGENT TASK: ${title}\nContact: ${contactLabel}`);
  return { action: 'note_added', contact_id: contactId, title };
}
