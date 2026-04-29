/**
 * Workflow Handlers — src/actions/handlers/workflows.js
 *
 * GHL workflow enrollment and removal.
 *   add_to_workflow:
 *     - Route A (default fallback): POST /contacts/{id}/workflow/{wfId} via
 *       GHL API. Works with any workflow trigger type. Used for mid-funnel
 *       routing where the destination workflow doesn't have an Inbound
 *       Webhook trigger.
 *     - Route B: POST to action_payload.webhook_url. Used when the
 *       destination workflow's trigger IS an Inbound Webhook and the
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
 * Route B body encoding (action_payload.format):
 *   'form' (default) → application/x-www-form-urlencoded. The standard
 *      for GHL inbound webhooks at Reece. Flat key/value fields. Nested
 *      objects/arrays are JSON-stringified into a single field as a
 *      last-resort escape hatch — prefer flat schemas.
 *   'json' → application/json. Use only when the destination explicitly
 *      requires JSON (non-GHL targets, future integrations).
 *
 * v1.2 — Form-encoded as default body format for Route B (matches GHL
 *        inbound webhook standard at Reece). Optional 'json' override.
 *
 * v1.1 — Route B (inbound webhook URL) support in add_to_workflow.
 *
 * v1.0 — Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch } from '../helpers.js';
import { REMOVE_ALL_MARKETING_WF } from '../constants.js';

/**
 * Encode a flat-ish object as application/x-www-form-urlencoded.
 * Null/undefined values are dropped. Nested objects/arrays are
 * JSON-stringified into a single field (escape hatch — flat schemas
 * are preferred).
 */
function buildFormBody(payload) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      params.append(key, JSON.stringify(value));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

export async function executeAddToWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const wfId = payload.workflow_id;
  const webhookUrl = payload.webhook_url;
  const wfName = payload.workflow_name || wfId || webhookUrl || 'unknown';
  const format = (payload.format || 'form').toLowerCase();

  if (!contactId) throw new Error('Missing contactId');

  // ── Route B: POST to inbound webhook URL ──────────────────────
  // Default body format: application/x-www-form-urlencoded (GHL standard).
  // The Decision Engine encodes the URL in action_payload.webhook_url and
  // the merge fields in action_payload.payload (flat key/value object).
  if (webhookUrl) {
    const webhookPayload = {
      contactId,
      ...(payload.payload || {}),
    };

    let body, contentType;
    if (format === 'json') {
      body = JSON.stringify(webhookPayload);
      contentType = 'application/json';
    } else {
      body = buildFormBody(webhookPayload);
      contentType = 'application/x-www-form-urlencoded';
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Accept': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Inbound webhook POST → ${res.status}: ${text.slice(0, 200)}`);
    }
    console.log(`[ActionExecutor] ✅ Route B (${format}): Contact ${contactId} POSTed to ${wfName}`);
    return {
      action: 'added_to_workflow_via_webhook',
      contact_id: contactId,
      webhook_url: webhookUrl,
      workflow_name: wfName,
      route: 'B',
      format,
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
