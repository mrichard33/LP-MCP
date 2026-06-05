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
 * v1.6 (2026-06-05) — Route B contact-key fix. The webhook body now sends the
 *        contact identifier as contact_id (snake_case) — the field every Reece
 *        GHL inbound-webhook trigger actually reads via its "Find Contact by
 *        Contact ID" step ({{inboundWebhookRequest.contact_id}}). Previously the
 *        body only carried contactId (camelCase), so Find Contact resolved an
 *        empty value, took the "Contact Not Found" branch, and the contact
 *        silently failed to enroll while the webhook still returned HTTP 200.
 *        This is why S1.1 (dc850226-d693-4911-b255-ade8280a0815) and its
 *        upstream feeder S1.0 (750f1b7f-e688-47fa-ba52-d0ca6d7032ab) recorded
 *        zero real enrollments since go-live despite "completed" actions.
 *        contactId is retained as a back-compat alias for any workflow still
 *        referencing the camelCase field. Spread order changed so payload.payload
 *        can never override the authoritative target id from action.target_id.
 *
 * v1.5 (2026-06-05) — Opt-in cross-system recency enrichment. When
 *        action_payload.compute_days_since_last_contact === true, Route B
 *        computes days_since_last_contact as today − MAX(GHL lastActivity,
 *        LP lp_leads.last_contact_date/last_call_date) and injects it into
 *        the webhook payload. Used by ENROLL_S1_1_V3_REENGAGEMENT so the
 *        S1.1 tier branch (T1/T2/T3) sees a real number, not a merge token.
 *
 * v1.4 (2026-05-23) — Post-success action chaining. When action_payload
 *        contains _post_success_action, enqueue that follow-up action
 *        ONLY AFTER the GHL enrollment (Route A) or inbound webhook POST
 *        (Route B) returns successfully. Replaces the prior pattern where
 *        callers enqueued the follow-up notification at the same time as
 *        the enrollment (Rochelle Giron incident — reps got "routed to"
 *        notifications for contacts that never actually entered the
 *        destination workflow because the executor silently failed on a
 *        placeholder workflow_id string).
 *
 *        Best-effort: failure to enqueue the post-success action is
 *        logged but does not fail the parent action — the enrollment
 *        already succeeded, dropping the notification is preferable to
 *        rolling back a real GHL state change.
 *
 *        _post_success_action shape:
 *          {
 *            action_type:       string,           // e.g. 'send_notification'
 *            target_system:     string,           // 'lp'|'ghl'
 *            target_entity:     string,           // 'contact' usually
 *            action_payload:    object,           // forwarded as-is
 *            reasoning:         string,
 *            rule_applied:      string,
 *            priority?:         number,           // default 30
 *            requires_approval?:boolean,          // default false
 *          }
 *        target_id defaults to the parent action's target_id.
 *
 * v1.3 — Phase 2 of Workflow Registry rollout. Logs and result objects now
 *        include canonical_code/canonical_name when present in
 *        action_payload (set by agent_rules post-Phase 2.1). Legacy
 *        workflow_id and workflow_name still respected for backward
 *        compatibility — registry annotations are additive.
 *
 * v1.2 — Form-encoded as default body format for Route B (matches GHL
 *        inbound webhook standard at Reece). Optional 'json' override.
 *
 * v1.1 — Route B (inbound webhook URL) support in add_to_workflow.
 *
 * v1.0 — Extracted from action-executor.js v4.2 refactor.
 */

import supabase from '../../supabase.js';
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

/**
 * Compute days since the contact was last touched, across BOTH systems.
 * LP and HL are separate stores, so read each independently and take the
 * most recent touch (smaller day-count wins).
 *   GHL : contact.lastActivity (epoch ms) — falls back to dateUpdated (ISO)
 *   LP  : lp_leads.last_contact_date / last_call_date (most recent)
 * Returns an integer day count, or null if neither system has a date
 * (the S1.1 workflow treats a missing value as T3).
 */
async function computeDaysSinceLastContact(contactId) {
  const dates = [];

  // GHL side — last activity on the contact record
  try {
    const resp = await ghlFetch('GET', `/contacts/${contactId}`);
    const c = (resp && resp.contact) ? resp.contact : (resp || {});
    const ghlMs = Number(c.lastActivity) || (c.dateUpdated ? Date.parse(c.dateUpdated) : NaN);
    if (Number.isFinite(ghlMs)) dates.push(ghlMs);
  } catch (err) {
    console.warn(`[ActionExecutor] computeDaysSinceLastContact GHL read failed for ${contactId}: ${err.message}`);
  }

  // LP side — most recent of last_contact_date / last_call_date on lp_leads
  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('last_contact_date, last_call_date')
      .eq('ghl_contact_id', contactId)
      .limit(1);
    if (!error && Array.isArray(data) && data[0]) {
      for (const d of [data[0].last_contact_date, data[0].last_call_date]) {
        const ms = d ? Date.parse(d) : NaN;
        if (Number.isFinite(ms)) dates.push(ms);
      }
    }
  } catch (err) {
    console.warn(`[ActionExecutor] computeDaysSinceLastContact LP read failed for ${contactId}: ${err.message}`);
  }

  if (!dates.length) return null;
  const mostRecent = Math.max(...dates);            // most recent touch across both systems
  const days = Math.floor((Date.now() - mostRecent) / 86400000);
  return days < 0 ? 0 : days;
}

/**
 * Build a human-readable workflow label for logs and result objects.
 * Prefers canonical_code (the registry-stable identifier) over the
 * legacy workflow_name. Falls back gracefully when neither is present.
 *
 * Phase 2 of the Workflow Registry rollout: agent_rules action_template
 * payloads now annotate canonical_code alongside workflow_id, so the
 * Action Executor speaks canonical codes wherever possible.
 */
function buildLogLabel(payload, fallback) {
  const code = payload.canonical_code;
  const cname = payload.canonical_name;
  const legacy = payload.workflow_name;
  if (code && cname) return `${cname}`;
  if (code) return `${code}`;
  if (legacy) return legacy;
  return fallback || 'unknown';
}

/**
 * v1.4 — Post-success action chaining.
 *
 * Enqueues a follow-up agent_action AFTER the parent enrollment succeeded.
 * Used by the objection-state handler to fire routing-success notifications
 * only when the underlying workflow enrollment actually completed.
 *
 * Best-effort: any failure is logged but never raised — the parent
 * enrollment is already committed, so we'd rather drop a notification
 * than roll back a real workflow change.
 */
async function enqueuePostSuccessAction(parentAction, spec) {
  if (!spec || typeof spec !== 'object') return;
  if (!spec.action_type) {
    console.warn(`[ActionExecutor] _post_success_action missing action_type for parent ${parentAction.id} — skipping`);
    return;
  }
  try {
    const { error } = await supabase.from('agent_actions').insert({
      action_type: spec.action_type,
      target_system: spec.target_system || 'lp',
      target_entity: spec.target_entity || 'contact',
      target_id: spec.target_id || parentAction.target_id,
      action_payload: spec.action_payload || {},
      reasoning: spec.reasoning || `Post-success chained action from parent ${parentAction.id}`,
      rule_applied: spec.rule_applied || 'POST_SUCCESS_CHAIN',
      status: 'pending',
      requires_approval: spec.requires_approval === true,
      priority: typeof spec.priority === 'number' ? spec.priority : 30,
    });
    if (error) {
      console.warn(`[ActionExecutor] enqueue _post_success_action failed for parent ${parentAction.id}: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[ActionExecutor] enqueue _post_success_action threw for parent ${parentAction.id}: ${err.message}`);
  }
}

export async function executeAddToWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const wfId = payload.workflow_id;
  const webhookUrl = payload.webhook_url;
  const canonicalCode = payload.canonical_code || null;
  const canonicalName = payload.canonical_name || null;
  const wfLabel = buildLogLabel(payload, wfId || webhookUrl);
  const format = (payload.format || 'form').toLowerCase();
  const postSuccessAction = payload._post_success_action || null;

  if (!contactId) throw new Error('Missing contactId');

  // ── Route B: POST to inbound webhook URL ──────────────────────
  // Default body format: application/x-www-form-urlencoded (GHL standard).
  // The Decision Engine encodes the URL in action_payload.webhook_url and
  // the merge fields in action_payload.payload (flat key/value object).
  if (webhookUrl) {
    // Reece GHL inbound-webhook standard: destination workflows resolve the
    // contact via a "Find Contact by Contact ID" step that reads
    // {{inboundWebhookRequest.contact_id}} (snake_case). Send contact_id as the
    // authoritative key. Keep contactId as a back-compat alias for any workflow
    // still referencing the camelCase field. Spread payload.payload FIRST so a
    // stale contact_id carried in the rule payload can never override the real
    // target id resolved from action.target_id.
    const webhookPayload = {
      ...(payload.payload || {}),
      contact_id: contactId,
      contactId,
    };

    // Cross-system recency enrichment (opt-in). The S1.1 re-engagement
    // workflow tiers on days_since_last_contact; that number must reflect
    // the most recent touch across BOTH LP and GHL.
    if (payload.compute_days_since_last_contact === true) {
      const dslc = await computeDaysSinceLastContact(contactId);
      if (dslc !== null) webhookPayload.days_since_last_contact = dslc;
      console.log(`[ActionExecutor] days_since_last_contact for ${contactId} = ${dslc === null ? 'unknown (workflow defaults to T3)' : dslc}`);
    }

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
    console.log(`[ActionExecutor] ✅ Route B (${format}): Contact ${contactId} POSTed to ${wfLabel}`);

    // v1.4 — fire chained post-success action only after webhook POST succeeded
    if (postSuccessAction) {
      await enqueuePostSuccessAction(action, postSuccessAction);
    }

    return {
      action: 'added_to_workflow_via_webhook',
      contact_id: contactId,
      webhook_url: webhookUrl,
      workflow_name: payload.workflow_name || null,
      canonical_code: canonicalCode,
      canonical_name: canonicalName,
      route: 'B',
      format,
      post_success_action_queued: !!postSuccessAction,
    };
  }

  // ── Route A: GHL API enrollment (default) ─────────────────────
  if (!wfId) throw new Error('Missing workflow_id (or webhook_url) in action payload');
  await ghlFetch('POST', `/contacts/${contactId}/workflow/${wfId}`, {});
  console.log(`[ActionExecutor] ✅ Route A: Contact ${contactId} added to workflow: ${wfLabel} (${wfId})`);

  // v1.4 — fire chained post-success action only after GHL API confirmed enrollment
  if (postSuccessAction) {
    await enqueuePostSuccessAction(action, postSuccessAction);
  }

  return {
    action: 'added_to_workflow',
    contact_id: contactId,
    workflow_id: wfId,
    workflow_name: payload.workflow_name || null,
    canonical_code: canonicalCode,
    canonical_name: canonicalName,
    route: 'A',
    post_success_action_queued: !!postSuccessAction,
  };
}

export async function executeRemoveFromWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  if (payload.remove_all) {
    await ghlFetch('POST', `/contacts/${contactId}/workflow/${REMOVE_ALL_MARKETING_WF}`, {});
    return { action: 'added_to_remove_all_workflow', contact_id: contactId };
  }
  const wfId = payload.workflow_id;
  const canonicalCode = payload.canonical_code || null;
  const canonicalName = payload.canonical_name || null;
  const wfLabel = buildLogLabel(payload, wfId);
  if (!wfId) throw new Error('Missing workflow_id');
  await ghlFetch('DELETE', `/contacts/${contactId}/workflow/${wfId}`);
  console.log(`[ActionExecutor] ✅ Removed contact ${contactId} from workflow: ${wfLabel} (${wfId})`);
  return {
    action: 'removed',
    contact_id: contactId,
    workflow_id: wfId,
    workflow_name: payload.workflow_name || null,
    canonical_code: canonicalCode,
    canonical_name: canonicalName,
  };
}
