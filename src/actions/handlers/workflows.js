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
 * v2.0 (2026-06-16) — Idempotency guard on add_to_workflow. Before enrolling,
 *        skip when the contact already carries active-<canonical_code> for the
 *        destination workflow (S4.1 → active-s4.1). Root cause of the 2026-06-16
 *        reaped "failures" (Kessler / Wakefield / Stanton): STAGE_4/5_ROUTE fired
 *        add_to_workflow for contacts already in the target workflow; the Route-B
 *        webhook POST changes nothing, never confirms, stalls past the 10-min
 *        executor TTL, and is reaped 3/3. These rules are single add_to_workflow
 *        routes with NO tag actions, so there was never anything to "stage-swap" —
 *        the real fix is idempotency here. Now resolves to
 *        {action:'skipped_already_enrolled'} instead. Fail-soft: only fires when
 *        canonical_code is present; any contact-read error proceeds with the
 *        enrollment so a transient GHL hiccup can never block a legitimate route.
 *
 * v1.9 (2026-06-10) — Resolver reads HL workflow_registry directly (re-apply of
 *        the chosen design lost in the #379 merge). Branch 2 no longer queries the
 *        LP-side workflow_canonical_map mirror; it calls
 *        resolveWorkflowIdByCanonicalCode() on the hl-fallback client, which reads
 *        HL's workflow_registry directly (canonical_code → workflow_id). The mirror
 *        table — and any refresh job that fed it — is retired from the read path;
 *        no LP-side copy to keep current means no drift. INERT and FAIL-SOFT are
 *        unchanged: explicit workflow_id still wins (resolver never runs), and HL
 *        down / not configured / no row → null → the existing "Missing workflow_id"
 *        throw. resolvedVia for branch 2 is now 'hl_registry' (logs/result only;
 *        nothing branches on the value beyond log annotation).
 *
 * v1.8 (2026-06-10) — Registry-lookup resolver (inert, fail-soft). New helper
 *        resolveWorkflowTarget(payload) resolves the GHL workflow UUID a
 *        workflow action targets: explicit action_payload.workflow_id wins
 *        verbatim (every live agent_rule carries one, so this is INERT — zero
 *        behavior change today); only when workflow_id is ABSENT and a
 *        canonical_code is present does it look up the current published UUID
 *        from the LP-side workflow_canonical_map mirror. Retires the RC3
 *        stale-UUID bug class: a workflow version bump updates one mirror row
 *        instead of every rule that hardcoded the old UUID. Wired into both
 *        executeAddToWorkflow (Route A) and executeRemoveFromWorkflow; Route B
 *        (inbound webhook_url) is unchanged. CROSS-SUPABASE: workflow_registry
 *        lives in the HL Supabase; the hl-fallback client (shipped with the
 *        bidirectional failover work) reaches it, so the resolver reads the LP-side
 *        workflow_canonical_map mirror, kept current by a dedicated scheduled
 *        refresh (shipped separately). [Superseded by v1.9 — the resolver now reads
 *        workflow_registry directly via that client; no mirror.] FAIL-SOFT: any
 *        mirror read error (table absent pre-DDL, transient DB error, no row)
 *        returns null and the caller's existing "Missing workflow_id" throw is
 *        preserved — a resolver fault can never block an enrollment that carries
 *        an explicit workflow_id. NOTE: do NOT migrate any rule onto
 *        canonical_code-only until the refresh job is live and the mirror is
 *        provably current; a populated-once-then-drifting map is just another
 *        stale pointer.
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
// 2026-07-23 suppression hardening Phase 4 — atomic snapshot write-through
// (generalizes the 2026-06-17 Peggy Webb inline write below).
import { applyTagsToSnapshot } from '../../services/tag-snapshot.js';
import { REMOVE_ALL_MARKETING_WF } from '../constants.js';
import { resolveWorkflowIdByCanonicalCode } from '../../tools/admin/hl-fallback.js';

// ── Universal Dynamic Hold (2026-06-12) ────────────────────────────────
// One GHL "dumb clock" workflow (dfd3ffaa) parks a contact for hold_hours and
// POSTs /api/agentic/hold-complete on expiry; the brain decides what happens
// next via agentic.hold_completed rules. issue_hold is the action that starts
// the clock. The trigger id is the workflow's inbound-webhook trigger (verify
// against the live workflow before enabling); overridable via env.
const GHL_HOOK_BASE = 'https://services.leadconnectorhq.com/hooks';
const HOLD_TRIGGER_ID = process.env.AGENTIC_HOLD_TRIGGER_ID || '4ec11a08-acaa-4159-8576-6ab63cc3a788';
// Brain-side serialization: default ON — one active hold per contact. Set
// 'false' only if GHL-side serialization is proven sufficient (concurrency test).
const HOLD_SERIALIZATION_ENABLED = process.env.HOLD_SERIALIZATION_ENABLED !== 'false';
const DEFAULT_HOLD_HOURS = 72;
// Slack past hold_hours after which an un-completed hold is treated as dead and
// serialization releases — otherwise a lost completion (workflow unpublished,
// contact deleted/merged, GHL hiccup) would lock the contact out of holds forever.
const HOLD_TTL_SLACK_HOURS = 24;

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
export async function getLastInboundMessageMs(contactId) {
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
 * Whether the contact has EVER sent us an inbound message on any channel.
 *
 * Return contract is deliberately three-valued and differs from
 * getLastInboundMessageMs above, which collapses "no inbound ever" and "lookup
 * failed" into NaN. The has_prior_inbound gate suppresses outbound on false, so
 * conflating those two would silence a working rescue path during a GHL blip.
 *
 * @returns {Promise<boolean|null>} true = has inbound, false = verified none,
 *   null = UNREADABLE (caller decides the failure direction).
 */
export async function hasPriorInboundMessage(contactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY || !contactId) return null;
  const locationId = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

  try {
    const convRes = await fetch(
      `https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${locationId}&limit=20`,
      {
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!convRes.ok) {
      console.warn(`[HasPriorInbound] conversation search failed for ${contactId}: ${convRes.status}`);
      return null;
    }
    const convData = await convRes.json();
    const convs = convData?.conversations || [];
    // No conversation record at all = verified never engaged, not an error.
    if (convs.length === 0) return false;

    for (const conv of convs) {
      if (!conv?.id) continue;
      const msgRes = await fetch(
        `https://services.leadconnectorhq.com/conversations/${conv.id}/messages`,
        {
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!msgRes.ok) {
        console.warn(`[HasPriorInbound] messages fetch failed for conv ${conv.id}: ${msgRes.status}`);
        return null; // partial read is unreadable, not "none"
      }
      const msgData = await msgRes.json();
      const messages = msgData?.messages?.messages || [];
      if (messages.some(m => String(m.direction || '').toLowerCase() === 'inbound')) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn(`[HasPriorInbound] threw for ${contactId}: ${err.message}`);
    return null;
  }
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
 * v2.0 — Idempotency helpers.
 *
 * deriveActiveTag: maps a destination workflow's canonical_code to the
 * "active-<code>" enrollment tag the routing layer stamps when a contact is
 * in that workflow (e.g. "S4.1" → "active-s4.1"). Returns null when no
 * canonical_code is available, which disables the guard (fail-open).
 *
 * isAlreadyEnrolled: live GHL read of the contact's tags; true iff the
 * derived active tag is present. Live (not cache) is deliberate — a stale
 * cache miss would let a duplicate enrollment through, which is the exact
 * failure we're closing. Fail-open on any read error so a transient GHL
 * outage can never block a legitimate first-time enrollment.
 */
function deriveActiveTag(canonicalCode) {
  if (!canonicalCode || typeof canonicalCode !== 'string') return null;
  const code = canonicalCode.trim().toLowerCase();
  return code ? `active-${code}` : null;
}

async function isAlreadyEnrolled(contactId, activeTag) {
  if (!activeTag) return false;
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    const tags = res?.contact?.tags || [];
    return tags.includes(activeTag);
  } catch (err) {
    console.warn(`[ActionExecutor] idempotency tag-read failed for ${contactId} (fail-open, will enroll): ${err.message}`);
    return false;
  }
}

/**
 * v1.8 — Registry-lookup resolver (inert, fail-soft).
 *
 * Resolves the GHL workflow UUID a workflow action should target:
 *   1. action_payload.workflow_id present → use it verbatim. EVERY live
 *      agent_rule carries one today, so this branch always wins and the
 *      resolver is INERT (the registry is never even queried). No behavior change.
 *   2. workflow_id ABSENT but action_payload.canonical_code present → look up
 *      the current workflow_id straight from HL's workflow_registry
 *      (canonical_code → workflow_id). Retires the RC3 stale-UUID bug class:
 *      a workflow version bump is reflected by the next read, with nothing for
 *      a rule to hardcode.
 *   3. Neither present → null (caller throws "Missing workflow_id", unchanged).
 *
 * CROSS-SUPABASE: the canonical workflow_registry lives in the HL Supabase.
 * Branch 2 reads it directly through the hl-fallback client
 * (resolveWorkflowIdByCanonicalCode), which has shipped the HL Supabase client
 * since the bidirectional failover work — so there is no LP-side mirror and no
 * refresh job in the read path.
 *
 * FAIL-SOFT: any failure resolving the code (HL down / not configured, transient
 * RPC error, no matching row) returns null rather than throwing — a resolver
 * fault can never block an enrollment that carries an explicit workflow_id.
 *
 * @returns {Promise<{workflowId: string|null, resolvedVia: 'payload'|'hl_registry'|null}>}
 */
async function resolveWorkflowTarget(payload) {
  // Branch 1 — explicit UUID wins (back-compat; every live rule hits this).
  if (payload && payload.workflow_id) {
    return { workflowId: payload.workflow_id, resolvedVia: 'payload' };
  }

  // Branch 2 — canonical_code → current workflow UUID via direct HL registry read.
  const code = payload && payload.canonical_code;
  if (code) {
    try {
      const id = await resolveWorkflowIdByCanonicalCode(code);
      if (id) {
        console.log(`[ActionExecutor] resolver: ${code} → ${id} (hl_registry)`);
        return { workflowId: id, resolvedVia: 'hl_registry' };
      }
      // not-found already warned inside the lookup — fall through to throw
    } catch (err) {
      console.warn(`[ActionExecutor] resolver registry read failed for ${code}: ${err.message} — falling through to throw`);
    }
  }

  // Branch 3 — nothing to resolve.
  return { workflowId: null, resolvedVia: null };
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

  // ── v2.0 Idempotency guard ────────────────────────────────────
  // Skip the enrollment entirely when the contact is already in the
  // destination workflow (active-<canonical_code> present). This prevents the
  // duplicate Route-B webhook POSTs that change nothing, never confirm, and get
  // reaped after the >10min executor TTL (Kessler / Wakefield / Stanton
  // 2026-06-16). Only engages when canonical_code is present; isAlreadyEnrolled
  // fails open on any read error so a transient GHL hiccup can't block a route.
  const activeTag = deriveActiveTag(canonicalCode);
  if (activeTag && await isAlreadyEnrolled(contactId, activeTag)) {
    console.log(`[ActionExecutor] ⏭️ add_to_workflow skipped — ${contactId} already has ${activeTag} (${wfLabel})`);
    return {
      action: 'skipped_already_enrolled',
      contact_id: contactId,
      canonical_code: canonicalCode,
      canonical_name: canonicalName,
      active_tag: activeTag,
      workflow_name: payload.workflow_name || null,
      route: 'skip',
    };
  }

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
  // v1.8 — resolve the target UUID. Explicit workflow_id wins (every live rule
  // hits this); a canonical_code-only payload falls back to the registry mirror
  // (inert until rules are migrated). Fail-soft: an unresolved target preserves
  // the original "Missing workflow_id" throw.
  const { workflowId: resolvedWfId, resolvedVia } = await resolveWorkflowTarget(payload);
  if (!resolvedWfId) throw new Error('Missing workflow_id (or webhook_url) in action payload');
  await ghlFetch('POST', `/contacts/${contactId}/workflow/${resolvedWfId}`, {});
  console.log(`[ActionExecutor] ✅ Route A: Contact ${contactId} added to workflow: ${wfLabel} (${resolvedWfId}${resolvedVia === 'hl_registry' ? ', via hl_registry' : ''})`);

  // v1.4 — fire chained post-success action only after GHL API confirmed enrollment
  if (postSuccessAction) {
    await enqueuePostSuccessAction(action, postSuccessAction);
  }

  return {
    action: 'added_to_workflow',
    contact_id: contactId,
    workflow_id: resolvedWfId,
    workflow_name: payload.workflow_name || null,
    canonical_code: canonicalCode,
    canonical_name: canonicalName,
    route: 'A',
    resolved_via: resolvedVia,
    post_success_action_queued: !!postSuccessAction,
  };
}

/**
 * Returns true if the contact already has an OPEN Dynamic Hold — a prior
 * issue_hold action whose hold has neither completed nor aged past its TTL.
 *
 * "Open" = the latest non-skipped issue_hold for the contact (excluding the
 * action currently executing) with:
 *   - no agentic.hold_completed system_event for the contact AFTER it was issued, AND
 *   - issued less than (hold_hours + HOLD_TTL_SLACK_HOURS) ago.
 * An overdue completion means the GHL clock is dead, so the hold is released and
 * a fresh one is allowed. Fail-open on query error (don't block a legitimate hold).
 */
async function hasActiveHold(contactId, currentActionId) {
  try {
    const { data: last } = await supabase
      .from('agent_actions')
      .select('id, action_payload, executed_at, created_at')
      .eq('action_type', 'issue_hold')
      .eq('target_id', contactId)
      .in('status', ['pending', 'executing', 'completed'])
      .neq('id', currentActionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!last) return false;

    const issuedMs = Date.parse(last.executed_at || last.created_at);
    if (!Number.isFinite(issuedMs)) return false;

    const holdHours = Number(last.action_payload?.hold_hours) || DEFAULT_HOLD_HOURS;
    const ttlMs = (holdHours + HOLD_TTL_SLACK_HOURS) * 3_600_000;
    if (Date.now() - issuedMs > ttlMs) {
      console.log(`[IssueHold] prior hold (action ${last.id}) past TTL — releasing serialization for ${contactId}`);
      return false; // dead clock → allow a fresh hold
    }

    const { data: completion } = await supabase
      .from('system_events')
      .select('id')
      .eq('event_type', 'agentic.hold_completed')
      .eq('ghl_contact_id', contactId)
      .gt('event_timestamp', new Date(issuedMs).toISOString())
      .limit(1)
      .maybeSingle();
    if (completion) return false; // already completed → not active

    return true; // open hold within TTL, no completion → active
  } catch (err) {
    console.warn(`[IssueHold] hasActiveHold query failed for ${contactId} (fail-open): ${err.message}`);
    return false;
  }
}

/**
 * issue_hold — start the universal Dynamic Hold clock for a contact.
 *
 * POSTs to the Dynamic Hold inbound-webhook trigger with a JSON payload carrying
 * the hold's purpose; on expiry GHL POSTs /api/agentic/hold-complete and the
 * brain routes via agentic.hold_completed rules.
 *
 * action.action_payload (from the rule's `params`):
 *   hold_hours    — number  (default 72)
 *   return_to     — string  (logical label the completion rule matches on)
 *   hold_reason   — string  (passthrough, logging)
 *   workflow_code — string  (passthrough, logging)
 *
 * Brain-side serialization (HOLD_SERIALIZATION_ENABLED, default ON): if the
 * contact already has an open hold, reject-and-log the duplicate instead of
 * stacking a second clock. This closes the double-fire path (e.g. Lane 3 firing
 * twice on two quick inbound replies → two 72h holds → two timeout evaluations).
 */
export async function executeIssueHold(action) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('issue_hold: missing contactId');

  const p = action.action_payload || {};
  const holdHours = Number(p.hold_hours) || DEFAULT_HOLD_HOURS;
  const returnTo = p.return_to || null;
  const holdReason = p.hold_reason || null;
  const workflowCode = p.workflow_code || null;

  // Serialization gate
  if (HOLD_SERIALIZATION_ENABLED && await hasActiveHold(contactId, action.id)) {
    console.warn(`[IssueHold] serialized: contact ${contactId} already holding — duplicate rejected (return_to=${returnTo}, wf=${workflowCode})`);
    return {
      action: 'issue_hold_skipped_serialized',
      contact_id: contactId,
      return_to: returnTo,
      reason: 'active_hold_exists',
    };
  }

  const url = `${GHL_HOOK_BASE}/${process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca'}/webhook-trigger/${HOLD_TRIGGER_ID}`;
  const body = JSON.stringify({
    contact_id: contactId,
    hold_hours: holdHours,
    return_to: returnTo,
    hold_reason: holdReason,
    workflow_code: workflowCode,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`issue_hold POST → ${res.status}: ${text.slice(0, 200)}`);
  }
  console.log(`[IssueHold] ✅ contact ${contactId} held ${holdHours}h return_to=${returnTo} wf=${workflowCode || '?'} reason="${holdReason || ''}"`);

  // Synchronous snapshot write for cannot-afford holds (2026-06-17).
  // executeIssueHold only POSTs to the GHL webhook trigger — the
  // cannot-afford:pursuing-assistance tag reaches contact_tag_snapshot only
  // after GHL fires a tag webhook back (async, seconds to minutes). In that
  // window, checkSuppression can't see the tag and AGENTIC_RESPOND_POST_CHATBOT
  // fires anyway (confirmed on Peggy Webb 3OsLduUgSPHI4kgs1DRE 2026-06-17).
  // Writing the tag directly here makes suppression instantaneous.
  // Fail-soft: a snapshot write error does not fail the hold — the GHL webhook
  // round-trip will eventually write the tag anyway, and the AGENTIC rule-level
  // not_has_any_tag gate is a second-layer backstop.
  // Phase 4 (2026-07-23): the inline read-then-upsert (itself racy) became the
  // atomic shared write-through; fail-soft behavior unchanged.
  if (workflowCode === 'CANNOT_AFFORD') {
    await applyTagsToSnapshot(contactId, { add: ['cannot-afford:pursuing-assistance'] });
  }

  return {
    action: 'hold_issued',
    contact_id: contactId,
    hold_hours: holdHours,
    return_to: returnTo,
    hold_reason: holdReason,
    workflow_code: workflowCode,
  };
}

export async function executeRemoveFromWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  if (payload.remove_all) {
    await ghlFetch('POST', `/contacts/${contactId}/workflow/${REMOVE_ALL_MARKETING_WF}`, {});
    return { action: 'added_to_remove_all_workflow', contact_id: contactId };
  }
  // v1.8 — resolve via the same path as enrollment so add/remove stay symmetric.
  const { workflowId: wfId, resolvedVia } = await resolveWorkflowTarget(payload);
  const canonicalCode = payload.canonical_code || null;
  const canonicalName = payload.canonical_name || null;
  const wfLabel = buildLogLabel(payload, wfId);
  if (!wfId) throw new Error('Missing workflow_id');
  await ghlFetch('DELETE', `/contacts/${contactId}/workflow/${wfId}`);
  console.log(`[ActionExecutor] ✅ Removed contact ${contactId} from workflow: ${wfLabel} (${wfId}${resolvedVia === 'hl_registry' ? ', via hl_registry' : ''})`);
  return {
    action: 'removed',
    contact_id: contactId,
    workflow_id: wfId,
    workflow_name: payload.workflow_name || null,
    canonical_code: canonicalCode,
    canonical_name: canonicalName,
    resolved_via: resolvedVia,
  };
}
