/**
 * Workflow Handlers — src/actions/handlers/workflows.js
 *
 * GHL workflow enrollment and removal.
 *   add_to_workflow:     POST /contacts/{id}/workflow/{wfId}
 *   remove_from_workflow: DELETE /contacts/{id}/workflow/{wfId}
 *     Special case: action_payload.remove_all === true routes the contact
 *     through the "Remove All Marketing" workflow (07a657bd-...) which
 *     removes them from every active marketing sequence at once.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch } from '../helpers.js';
import { REMOVE_ALL_MARKETING_WF } from '../constants.js';

export async function executeAddToWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const wfId = payload.workflow_id;
  if (!contactId) throw new Error('Missing contactId');
  if (!wfId) throw new Error('Missing workflow_id in action payload');
  await ghlFetch('POST', `/contacts/${contactId}/workflow/${wfId}`, {});
  const wfName = payload.workflow_name || wfId;
  console.log(`[ActionExecutor] ✅ Contact ${contactId} added to workflow: ${wfName} (${wfId})`);
  return { action: 'added_to_workflow', contact_id: contactId, workflow_id: wfId, workflow_name: wfName };
}

export async function executeRemoveFromWorkflow(action) {
  const contactId = action.target_id;
  if (action.action_payload?.remove_all) {
    await ghlFetch('POST', `/contacts/${contactId}/workflow/${REMOVE_ALL_MARKETING_WF}`, {});
    return { action: 'added_to_remove_all_workflow', contact_id: contactId };
  }
  const wfId = action.action_payload?.workflow_id;
  if (!wfId) throw new Error('Missing workflow_id');
  await ghlFetch('DELETE', `/contacts/${contactId}/workflow/${wfId}`);
  return { action: 'removed', contact_id: contactId, workflow_id: wfId };
}
