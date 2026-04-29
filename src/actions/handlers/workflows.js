/**
 * Workflow Handlers — src/actions/handlers/workflows.js
 *
 * GHL workflow enrollment and removal.
 *   add_to_workflow:
 *     - Route A (default): POST /contacts/{id}/workflow/{wfId} via GHL API.
 *       Works with any workflow trigger type. Used for mid-funnel routing.
 *     - Route B (v1.1, NEW): POST to action_payload.webhook_url. Used when
 *       the destination workflow's trigger IS an Inbound Webhook and the
 *       Decision Engine enrolls by posting directly to that URL with
 *       optional payload context (available inside the workflow as
 *       {{inboundWebhookRequest.fieldName}}).
 *
 *   remove_from_workflow: DELETE /contacts/{id}/workflow/{wfId}
 *     Special case: action_payload.remove_all === true routes the contact
 *     through the "Remove All Marketing" workflow (07a657bd-...) which
 *     removes them from every active marketing sequence at once.
 *
 * Route selection (add_to_workflow):
 *   if action_payload.webhook_url present → Route B (POST to URL)
 *   else if action_payload.workflow_id present → Route A (GHL API)
 *   else throw
 *
 * v1.1 — Route B (inbound webhook URL) support in add_to_workflow.
 *        Falls back to Route A when webhook_url is not provided.
 *        action_payload.payload (object) is merged into the body posted
 *        to the webhook for context-aware downstream content.
 *
 * v1.0 — Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch } from '../helpers.js';
import { REMOVE_ALL_MARKETING_WF } from '../constants.js';

export async function executeAddToWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const wfId = payload.workflow_id;
  const webhookUrl = payload.webhook_url;
  const wfName = payload.workflow_name || wfId || webhookUrl || 'unknown';

  if (!contactId) throw new Error('Missing contactId');

  // ── Route B: POST to inbound webhook URL ──────────────────────
  // Used when the destination workflow's trigger is an Inbound Webhook.
  // Decision Engine encodes the URL in action_payload.webhook_url.
  // Optional context: action_payload.payload (object) is merged into the body.
  if (webhookUrl) {
    const webhookPayload = {
      contactId,
      ...(payload.payload || {}),
    };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(webhookPayload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Inbound webhook POST → ${res.status}: ${text.slice(0, 200)}`);
    }
    console.log(`[ActionExecutor] ✅ Route B: Contact ${contactId} POSTed to ${wfName}`);
    return {
      action: 'added_to_workflow_via_webhook',
      contact_id: contactId,
      webhook_url: webhookUrl,
      workflow_name: wfName,
      route: 'B',
    };
  }

  // ── Route A: GHL API enrollment (default) ─────────────────────
  if (!wfId) throw new Error('Missing workflow_id (or webhook_url) in action payload');
  await ghlFetch('POST', `/contacts/${contactId}/workflow/${wfId}`, {});
  console.log(`[ActionExecutor] ✅ Route A: Contact ${contactId} added to workflow: ${wfName} (${wfId})`);
  return {
    action: 'added_to_workflow',
    contact_id: contactId,
    workflow_id: wfId,
    workflow_name: wfName,
    route: 'A',
  };
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
