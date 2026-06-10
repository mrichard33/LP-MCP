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
 * v1.7 (2026-06-05) — days_since_last_contact now measures TRUE human contact.
 *        Rewrote computeDaysSinceLastContact to read only two signals, both of
 *        which represent an actual person↔lead interaction and neither of which
 *        is reset by our own marketing automation:
 *          LP  : MAX(lp_notes.created_at_lp) — rep-authored notes / call
 *                dispositions. (Replaces lp_leads.last_contact_date /
 *                last_call_date, which on multi-lead contacts were read with a
 *                no-ORDER-BY .limit(1) and so could grab the wrong/null row.)
 *          GHL : the most recent INBOUND conversation message (the lead
 *                replying). (Replaces contact.lastActivity → dateUpdated, which
 *                was bumped by every tag/field write the agentic system itself
 *                made — including the re-engagement-eligible tag added moments
 *                earlier — so it collapsed the value to ~0 and pinned the S1.1
 *                tier to T1 regardless of real dormancy.)
 *        Inbound-only on the GHL side is deliberate: outbound is excluded
 *        because automation sends through the same Conversations API and would
 *        re-introduce the self-pollution this fix removes. Result is
 *        today − MAX(both); null when neither system has a human-contact date,
 *        which the S1.1 workflow treats as T3 (coldest). NOTE: phone calls that
 *        a rep makes but never logs as an LP note are not captured by this
 *        signal — fold lp_leads.last_call_date back in if that gap matters.
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
 *        computes days_since_last_contact and injects it into the webhook
 *        payload. Used by ENROLL_S1_1_V3_REENGAGEMENT so the S1.1 tier branch
 *        (T1/T2/T3) sees a real number, not a merge token. (Signal source
 *        corrected in v1.7.)
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
import { resolveWorkflowIdByCanonicalCode } from '../../tools/admin/hl-fallback.js';

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
 * Most recent INBOUND GHL conversation message timestamp (epoch ms) for the
 * contact, or NaN if none. Inbound = the lead replied → unambiguous human
 * contact that our automated outbound sends can never reset. Mirrors the
 * proven conversation-fetch pattern in decision-engine.js countThreadTurns
 * (Conversations API version 2021-04-15).
 */
async function getLastInboundMessageMs(contactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !contactId) return NaN;
  const locationId = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

  // Most recently updated conversation for the contact
  const convRes = await fetch(
    `https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${locationId}&limit=1`,
    {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!convRes.ok) {
    console.warn(`[ActionExecutor] getLastInboundMessageMs conversation search failed for ${contactId}: ${convRes.status}`);
    return NaN;
  }
  const convData = await convRes.json();
  const conv = convData?.conversations?.[0];
  if (!conv?.id) return NaN;

  const msgRes = await fetch(
    `https://services.leadconnectorhq.com/conversations/${conv.id}/messages`,
    {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!msgRes.ok) {
    console.warn(`[ActionExecutor] getLastInboundMessageMs messages fetch failed for conv ${conv.id}: ${msgRes.status}`);
    return NaN;
  }
  const msgData = await msgRes.json();
  const messages = msgData?.messages?.messages || [];

  let latest = NaN;
  for (const m of messages) {
    if (String(m.direction || '').toLowerCase() !== 'inbound') continue;
    const ms = m.dateAdded ? Date.parse(m.dateAdded) : NaN;
    if (Number.isFinite(ms) && (!Number.isFinite(latest) || ms > latest)) latest = ms;
  }
  return latest;
}

/**
 * Days since the contact was last in TRUE human contact, across both systems.
 * Both signals represent an actual person↔lead interaction and neither is
 * reset by our own marketing automation:
 *   LP  : MAX(lp_notes.created_at_lp) — rep-authored notes / call dispositions
 *   GHL : most recent INBOUND conversation message (the lead replying)
 * Returns today − MAX(both) as an integer day count, or null if neither system
 * has a human-contact date (the S1.1 workflow treats null as T3, the coldest
 * tier). Both reads are independent and fail-soft — a transient error on one
 * side simply drops that side from the MAX rather than failing enrollment.
 */
async function computeDaysSinceLastContact(contactId) {
  const dates = [];

  // ── LP side: latest rep-authored note (incl. logged call dispositions) ──
  try {
    const { data, error } = await supabase
      .from('lp_notes')
      .select('created_at_lp')
      .eq('ghl_contact_id', contactId)
      .not('created_at_lp', 'is', null)
      .order('created_at_lp', { ascending: false })
      .limit(1);
    if (!error && Array.isArray(data) && data[0]?.created_at_lp) {
      const ms = Date.parse(data[0].created_at_lp);
      if (Number.isFinite(ms)) dates.push(ms);
    }
  } catch (err) {
    console.warn(`[ActionExecutor] computeDaysSinceLastContact LP notes read failed for ${contactId}: ${err.message}`);
  }

  // ── GHL side: most recent inbound conversation message (lead replied) ──
  try {
    const inboundMs = await getLastInboundMessageMs(contactId);
    if (Number.isFinite(inboundMs)) dates.push(inboundMs);
  } catch (err) {
    console.warn(`[ActionExecutor] computeDaysSinceLastContact GHL conversation read failed for ${contactId}: ${err.message}`);
  }

  if (!dates.length) return null;                   // no human contact on record → workflow treats null as T3
  const mostRecent = Math.max(...dates);            // most recent human touch across LP notes + GHL inbound
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

/**
 * Resolve the target workflow_id for an action payload.
 *
 * Inert today: every live rule payload carries a literal workflow_id, so this
 * returns it untouched without any registry call. Only when workflow_id is
 * absent does it fall back to resolving canonical_code → workflow_id against
 * the HL workflow_registry (Workflow Registry rollout, Phase 2).
 *
 * Fail-soft: returns null so the caller's existing "Missing workflow_id" throw
 * path is preserved. Distinguishes the two null cases in logs — a registry
 * read error (HL down / not configured) vs. a canonical_code with no row.
 */
async function resolveWorkflowTarget(payload) {
  if (payload.workflow_id) return payload.workflow_id;
  const code = payload.canonical_code;
  if (!code) return null;
  let wfId = null;
  try {
    wfId = await resolveWorkflowIdByCanonicalCode(code);
  } catch (err) {
    console.warn(`[ActionExecutor] workflow_registry lookup failed for canonical_code "${code}": ${err.message} — falling back to missing-workflow_id`);
    return null;
  }
  if (!wfId) {
    console.warn(`[ActionExecutor] no workflow_registry row for canonical_code "${code}" — cannot resolve workflow_id`);
  }
  return wfId;
}

export async function executeAddToWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  let wfId = payload.workflow_id;
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
    // the most recent TRUE human contact (LP notes + GHL inbound) — see
    // computeDaysSinceLastContact (v1.7).
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
  if (!wfId) wfId = await resolveWorkflowTarget(payload); // canonical_code → registry fallback (inert while workflow_id present)
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
  let wfId = payload.workflow_id;
  const canonicalCode = payload.canonical_code || null;
  const canonicalName = payload.canonical_name || null;
  if (!wfId) wfId = await resolveWorkflowTarget(payload); // canonical_code → registry fallback (inert while workflow_id present)
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
