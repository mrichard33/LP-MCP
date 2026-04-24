/**
 * Notification Handler — src/actions/handlers/notifications.js
 *
 * send_notification: Rich GroupMe message to the sales channel. Uses
 * buildNotificationEnrichment + buildRichNotification to produce a card
 * with lead context, LP data, intent score, and inbound message preview.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { sendGroupMeMessage } from '../../groupme.js';
import { interpolatePayload } from '../helpers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';
import { buildNotificationEnrichment, buildRichNotification } from '../enrichment.js';

export async function executeSendNotification(action, context) {
  const contactId = action.target_id;
  const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(contactId, context);
  const prospectId = await resolveLPProspectId(contactId);
  const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId });

  const enrichedContext = {
    ...context,
    contact_name: name,
    contact_id: contactId,
    contact_phone: phone || '',
    lp_prospect_id: prospectId,
  };

  const payload = interpolatePayload(action.action_payload, enrichedContext);
  const baseMessage = payload?.message || 'Agent notification';

  const full = buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment });
  await sendGroupMeMessage(full);
  return { action: 'groupme_sent', message: full.slice(0, 200) };
}
