/**
 * Callback Resolver — src/knowledge/callback-resolver.js
 *
 * Implements the CALLBACK post-classification that sql/017 promised and
 * never shipped. When the intent classifier short-circuits on CALLBACK,
 * its handoff tag is the placeholder `hdl:callback-pending-classification`
 * — which NO GHL workflow listens on (verified live 2026-07-08: the only
 * hdl:* triggers in GHL are hdl:callback-sales → I.HDL-1 and
 * hdl:callback-service → I.HDL-2). This module resolves the placeholder
 * to a concrete tag using the lead-context envelope, or declares the
 * contact AMBIGUOUS so the caller (send-message-handler's short-circuit
 * path) can ask the HDL.3 customer-status probe directly.
 *
 * The probe is the ONLY thing that applies `pending:customer-status-check`
 * — the precondition tag the CUSTOMER_STATUS_AFFIRMATIVE / _NEGATIVE
 * gates (sql/018 + intent-classifier v1.2 guard) require before they may
 * fire. Before this module, nothing in the codebase applied that tag, so
 * both gates were inert.
 *
 * Resolution logic (mirrors sql/017's documented intent):
 *   1. Known CUSTOMER  → hdl:callback-service  (I.HDL-2 picks up)
 *      Uses isCustomerP2() from the lead-state signals — the same
 *      five-signal customer detection the suppression shapes trust
 *      (P2 pipeline / lp.closed_won / p2-stage:* / lp-milestone-completion
 *      / won opp + lp-demo-completed).
 *   2. Known LEAD      → hdl:callback-sales    (I.HDL-1 picks up)
 *      Any evidence the contact is in the sales motion: an opportunity,
 *      an LP record with real activity, or funnel tags.
 *   3. AMBIGUOUS       → { tag: null } — caller sends the probe and
 *      applies pending:customer-status-check. The lead's short yes/no
 *      answer then routes through the sql/018 gates.
 *
 * Fail-open: any error in context building resolves to hdl:callback-sales.
 * A misrouted sales callback still reaches a human who can transfer;
 * a dead placeholder tag reaches no one.
 */

import { buildLeadContext } from '../context-builder.js';
import { isCustomerP2 } from '../agentic/lead-state/signals/context-reader.js';

/**
 * The precondition tag for the sql/018 customer-status gates. Must match
 * CUSTOMER_STATUS_PRECONDITION_TAG in src/knowledge/intent-classifier.js
 * (kept as duplicate string constants to avoid an import cycle between
 * the classifier and this module).
 */
export const CUSTOMER_STATUS_PENDING_TAG = 'pending:customer-status-check';

/** The two intents that answer the probe. Mirrors intent-classifier v1.2. */
export const CUSTOMER_STATUS_GATE_INTENT_SET = new Set([
  'CUSTOMER_STATUS_AFFIRMATIVE',
  'CUSTOMER_STATUS_NEGATIVE',
]);

/** Concrete handoff tags with live GHL listeners (verified 2026-07-08). */
export const CALLBACK_TAG_SALES = 'hdl:callback-sales';     // → I.HDL-1
export const CALLBACK_TAG_SERVICE = 'hdl:callback-service'; // → I.HDL-2

// Funnel-presence tag prefixes: any one of these means the contact is a
// KNOWN LEAD already in the sales motion — no probe needed, route to the
// sales callback queue. Deliberately broad: a contact the agentic system
// is talking to almost always carries active-entry:* / stage:* at minimum.
const KNOWN_LEAD_TAG_PREFIXES = [
  'active-entry:',
  'entry:',
  'stage:',
  'buyer:',
  'bj:',
  'lp-',
  'objection-',
];

function hasKnownLeadTags(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => {
    if (typeof t !== 'string') return false;
    const lc = t.toLowerCase();
    return KNOWN_LEAD_TAG_PREFIXES.some(p => lc.startsWith(p));
  });
}

/** True when the LP envelope shows real lead activity on record. */
function hasLpActivity(lp) {
  if (!lp || typeof lp !== 'object') return false;
  const disposition = String(lp.disposition_code ?? lp.disposition ?? '').trim();
  return Boolean(
    disposition ||
    lp.appointment_set === true ||
    lp.demo_completed === true ||
    lp.last_call_date
  );
}

/**
 * Resolve a CALLBACK short-circuit to a concrete handoff tag.
 *
 * @param {string} contactId — GHL contact id
 * @returns {Promise<{tag: string|null, basis: string, ambiguous: boolean}>}
 *   tag       — concrete hdl:* tag, or null when the contact is ambiguous
 *               and the caller should send the customer-status probe
 *   basis     — audit string explaining the resolution
 *   ambiguous — true only on the probe branch
 *
 * Never throws. Context-build failures fail OPEN to hdl:callback-sales —
 * a human callback beats silence, and sales can transfer a customer.
 */
export async function resolveCallbackHandoff(contactId) {
  let ctx = null;
  try {
    ctx = await buildLeadContext(contactId, { skipCache: true });
  } catch (err) {
    console.warn(`[CallbackResolver] buildLeadContext failed for ${contactId}: ${err.message} — failing open to ${CALLBACK_TAG_SALES}`);
    return { tag: CALLBACK_TAG_SALES, basis: `context_build_failed: ${String(err.message).slice(0, 120)}`, ambiguous: false };
  }

  try {
    // 1. Known customer → service callback queue.
    if (isCustomerP2(ctx)) {
      return { tag: CALLBACK_TAG_SERVICE, basis: 'customer_p2', ambiguous: false };
    }

    // 2. Known lead → sales callback queue.
    if (ctx?.pipeline?.pipeline_id) {
      return { tag: CALLBACK_TAG_SALES, basis: `opportunity_present:${ctx.pipeline.pipeline_id}`, ambiguous: false };
    }
    if (hasLpActivity(ctx?.lp)) {
      return { tag: CALLBACK_TAG_SALES, basis: 'lp_activity_on_record', ambiguous: false };
    }
    if (hasKnownLeadTags(ctx?.lead?.current_tags)) {
      return { tag: CALLBACK_TAG_SALES, basis: 'funnel_tags_present', ambiguous: false };
    }

    // 3. Truly unknown texter → probe.
    return { tag: null, basis: 'no_customer_or_lead_signals', ambiguous: true };
  } catch (err) {
    console.warn(`[CallbackResolver] resolution threw for ${contactId}: ${err.message} — failing open to ${CALLBACK_TAG_SALES}`);
    return { tag: CALLBACK_TAG_SALES, basis: `resolver_error: ${String(err.message).slice(0, 120)}`, ambiguous: false };
  }
}

/**
 * The HDL.3 customer-status probe copy. Company voice ("we"), one
 * question, plain text, no emojis, no exclamation marks, and it invites
 * an answer short enough to pass the intent-classifier's
 * CUSTOMER_STATUS_GATE_MAX_WORDS guard (default 8 words).
 *
 * @param {string|null} firstName — lead's first name, or null
 * @returns {string} SMS body (under 320 chars)
 */
export function buildCustomerStatusProbe(firstName) {
  const greeting = firstName ? `Hey ${firstName}` : 'Hey there';
  return `${greeting} — happy to get you a call back. Quick question so we route you to the right team: are you a current Reece customer, or looking into new windows or doors? A quick "current customer" or "new" is all we need.`;
}
