/**
 * Universal Suppression Check — src/services/suppression-check.js
 *
 * Phase 1 of the Intake/Routing Layer (Issue #51).
 *
 * Centralized tag-based suppression for outbound actions. Reads the contact's
 * current tag set from contact_tag_snapshot (kept current by GHL tag webhook
 * — see src/ghl-tag-handler.js) and matches against the hardcoded
 * SUPPRESS_TAGS list. On match, the caller skips the send and records the
 * skip reason in execution_result.
 *
 * Fail-open semantics — missing supabase, missing contact_id, missing
 * snapshot, or DB error → allow the send (better to over-send than block
 * all outbound during transient infra issues). The hard guarantee is for
 * the steady-state path where the snapshot exists and the query succeeds.
 * This matches the convention used by src/services/outbound-locks.js.
 *
 * Used by:
 *   - executeSendMessageWithLock in src/actions/index.js (before lock acquire)
 *   - future outbound action handlers when they ship
 *
 * NOT used by:
 *   - send_notification (GroupMe to team — internal, not outbound to contact)
 *   - add_to_workflow (queueing only — workflow's own send steps run under
 *     universal suppression at agentic-send time once they migrate)
 *
 * Phase principle: GHL workflows retain only timer + send. Agentic owns
 * routing, suppression, classification. Suppression must be enforced at
 * the agentic outbound gate so no rule can accidentally bypass it.
 *
 * ─── 2026-05-14 ALIGNMENT WITH send-message-handler.js v3.12 ────────
 *
 * Removed `pause-bot` and `suppress-automation` from SUPPRESS_TAGS.
 *
 * Those two tags were the original "agentic bot is in charge" gating
 * signals. As of send-message-handler.js v3.12 (2026-05-08), the canonical
 * signal is `agentic-active`, enforced UPSTREAM at the rule level (e.g.
 * AGENTIC_RESPOND_POST_CHATBOT.context_conditions.has_tag = agentic-active).
 * By the time a send_message action reaches this universal gate, the rule
 * has already verified agentic-active is set. Re-gating on the legacy tags
 * here was silently dropping valid sends — first observed on contact
 * ZREwiRF6uoWsysyrzuKJ (Mary Hayward) 2026-05-13 23:20:52, where
 * AUTOMATION_SUPPRESS_ON_BOOKING's 48hr post-booking pause stamped all
 * three legacy tags onto a contact who then replied to a W8.0 email; the
 * agentic responder was suppressed even though the rule's own conditions
 * had already passed.
 *
 * Compliance / safety tags remain (dnc family, unsubscribed, cooling-active,
 * quarantined, suppress-outbound, stop-bot). stop-bot stays because it is a
 * lead-initiated kill switch that the contact triggered explicitly — that
 * is a universal signal regardless of which subsystem is sending.
 *
 * Defense in depth: send-message-handler.js v3.12 also hard-blocks on
 * dnc / do-not-contact / dnc-sms / stage:dnc and on stop-bot at the local
 * handler. Compliance gates are preserved on both layers.
 */

import supabase from '../supabase.js';

/**
 * The canonical list of tags that suppress agentic outbound to a contact.
 * Order does not matter — matching is set-based. Tag names are lowercased
 * (contact_tag_snapshot normalizes on write).
 */
export const SUPPRESS_TAGS = [
  // Explicit one-shot suppressor (operational)
  'suppress-outbound',

  // Terminal structural disqualification (hard-DQ closeout chain,
  // 2026-06-10). Applied by rule DQ_MOBILE_NORMALIZE et al.; no
  // reactivation path exists for these contacts.
  'hard-disqualified',

  // Intake/Routing Layer (Phase 1)
  'quarantined',

  // Loss intelligence
  'cooling-active',

  // Consent / compliance
  'dnc',
  'dnc-related',
  'unsubscribed',

  // Contact-initiated kill switch — respected universally because it is a
  // direct lead-initiated signal regardless of which channel the agentic
  // send is using. `pause-bot` (booking-window pause) and `suppress-automation`
  // (legacy GHL workflow throttle) were REMOVED 2026-05-14 — `agentic-active`
  // is now the canonical "agentic in charge" signal, enforced upstream at
  // the rule level. See header comment.
  'stop-bot',
  // Cannot-afford / no-insurance leads pursuing external assistance (2026-06-17).
  // Set by CANNOT_AFFORD_PRE_DEMO_HOLD / MANUAL_PEGGY_CANNOT_AFFORD_FIX and by
  // executeIssueHold when workflow_code='CANNOT_AFFORD'. Sending urgency or pitch
  // messaging to a lead who genuinely cannot pay is actively harmful. This tag
  // suppresses ALL agentic outbound until the hold expires and the tag is removed.
  // The rule-level not_has_any_tag gate on AGENTIC_RESPOND_POST_CHATBOT is a
  // second-layer backstop; this is the universal floor.
  'cannot-afford:pursuing-assistance',
];

// Set for O(1) intersection check
const SUPPRESS_SET = new Set(SUPPRESS_TAGS);

// ─── 2026-07-07 ALWAYS-RESPOND POLICY (owner requirement) ───────────
// "The agentic bot is active and responding any time agentic-active is
// present; only stop-bot turns it off."
//
// While `agentic-active` is on the contact, a DIRECT REPLY may be blocked
// only by stop-bot and the legal/consent opt-out family below — carrier
// compliance that cannot be waived. The operational suppressors
// (suppress-outbound, hard-disqualified, quarantined, cooling-active,
// cannot-afford:pursuing-assistance) keep gating outbound campaigns,
// nurture, and re-enrollment via the default mode, but no longer silence
// an answer to a lead who just texted us. Incidents: 2026-07-06 21:41
// (cooling-active/suppress-outbound swallowed the aluminum-windows reply)
// and the same-day analyzer-guard silence.
//
// Callers opt in with checkSuppression(id, { mode: 'agentic_reply' }) —
// today that is ONLY the send_message flow (executeSendMessageWithLock).
// Every other caller (resurrection eligibility, future outbound handlers)
// keeps the full list.
const REPLY_BLOCKING_TAGS = [
  'stop-bot',
  // Consent / compliance — legally binding opt-outs
  'dnc',
  'dnc-related',
  'dnc-sms',
  'do-not-contact',
  'stage:dnc',
  'unsubscribed',
];
const REPLY_BLOCKING_SET = new Set(REPLY_BLOCKING_TAGS);

/**
 * Check whether outbound should be suppressed for this contact.
 *
 * @param {string} contact_id  GHL contact ID
 * @returns {Promise<{
 *   suppressed: boolean,
 *   reason: string,
 *   matched_tag?: string,
 *   all_matches?: string[],
 * }>}
 *
 * Result shapes:
 *   { suppressed: false, reason: 'no_supabase_open' }
 *   { suppressed: false, reason: 'no_contact_id_open' }
 *   { suppressed: false, reason: 'snapshot_read_error_open' }
 *   { suppressed: false, reason: 'no_snapshot_open' }
 *   { suppressed: false, reason: 'no_match' }
 *   { suppressed: true,  reason: 'suppression_tag_match',
 *     matched_tag: 'quarantined', all_matches: ['quarantined', 'dnc'] }
 */
export async function checkSuppression(contact_id, { mode = 'default' } = {}) {
  if (!supabase) return { suppressed: false, reason: 'no_supabase_open' };
  if (!contact_id) return { suppressed: false, reason: 'no_contact_id_open' };

  const { data, error } = await supabase
    .from('contact_tag_snapshot')
    .select('tags')
    .eq('ghl_contact_id', contact_id)
    .maybeSingle();

  if (error) {
    console.error(`[suppression-check] snapshot read error for ${contact_id}: ${error.message}`);
    return { suppressed: false, reason: 'snapshot_read_error_open' };
  }

  if (!data || !Array.isArray(data.tags) || data.tags.length === 0) {
    return { suppressed: false, reason: 'no_snapshot_open' };
  }

  // Always-respond policy (see REPLY_BLOCKING_TAGS above): for a direct
  // agentic reply on a contact the bot owns, only stop-bot + the consent
  // family block. Operational suppressors are reported, not enforced.
  if (mode === 'agentic_reply' && data.tags.includes('agentic-active')) {
    const blocking = data.tags.filter(t => REPLY_BLOCKING_SET.has(t));
    if (blocking.length > 0) {
      return {
        suppressed: true,
        reason: 'suppression_tag_match',
        matched_tag: blocking[0],
        all_matches: blocking,
      };
    }
    const bypassed = data.tags.filter(t => SUPPRESS_SET.has(t));
    if (bypassed.length > 0) {
      console.log(`[suppression-check] agentic_reply bypass for ${contact_id}: agentic-active present — operational tags [${bypassed.join(', ')}] do not block a direct reply`);
    }
    return {
      suppressed: false,
      reason: bypassed.length > 0 ? 'agentic_reply_bypass' : 'no_match',
      bypassed_tags: bypassed,
    };
  }

  const matches = data.tags.filter(t => SUPPRESS_SET.has(t));
  if (matches.length === 0) {
    return { suppressed: false, reason: 'no_match' };
  }

  return {
    suppressed: true,
    reason: 'suppression_tag_match',
    matched_tag: matches[0],
    all_matches: matches,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 2026-07-03 — MUTATION suppression (pipeline-integrity breach)
// ═══════════════════════════════════════════════════════════════════
//
// suppress-automation / stop-bot on a contact must block ALL mutating action
// types (move_opportunity, workflows, stages, custom fields, non-audit tags)
// — not only send_message. This is the tag check for that gate; the gate
// itself lives in the action executor (src/actions/index.js).
//
// Same snapshot read + fail-open contract as checkSuppression above.

const MUTATION_SUPPRESS_TAGS = ['suppress-automation', 'stop-bot'];
const MUTATION_SUPPRESS_SET = new Set(MUTATION_SUPPRESS_TAGS);

/**
 * Pure predicate over a tag array (unit-testable without a DB).
 */
export function matchMutationSuppression(tags) {
  if (!Array.isArray(tags)) return null;
  return tags.find(t => MUTATION_SUPPRESS_SET.has(String(t).toLowerCase())) || null;
}

// add_tag exception: suppression/audit tags must still land on a suppressed
// contact (they are how suppression is recorded in the first place).
const SUPPRESSION_AUDIT_TAG_RE =
  /^(dnc|dnc-|do-not-contact|stop-bot|suppress[-:]|hard-disqualified|quarantined|audit-|compliance-|loss-reason:)/i;

export function isSuppressionAuditTag(tag) {
  return SUPPRESSION_AUDIT_TAG_RE.test(String(tag || ''));
}

/**
 * Is this action exempt from the mutation-suppression gate? Pure predicate
 * over the action row. Two exemptions:
 *   (a) add_tag of a suppression/audit tag — that is how suppression itself is
 *       recorded on the contact.
 *   (b) 2026-07-11 — an authorized re-engagement lift (DNC_LIFT_ON_REENGAGEMENT)
 *       that explicitly sets action_payload.bypass_suppression:true. The lift
 *       must be able to REMOVE the suppression stack (stop-bot, lp-dnc, …) from
 *       a stop-bot contact; without an exemption the DNC blocks its own removal
 *       (the gate has no remove_tag audit-exemption, only an add_tag one) and a
 *       re-booked lead stays suppressed forever.
 * The flag is honored ONLY on rule-authored templates the operator controls;
 * every other mutation on a suppressed contact still blocks.
 */
export function isMutationGateExempt(action) {
  if (!action) return false;
  if (action.action_payload?.bypass_suppression === true) return true;
  if (action.action_type === 'add_tag' && isSuppressionAuditTag(action.action_payload?.tag)) return true;
  return false;
}

export async function checkMutationSuppression(contact_id) {
  if (!supabase) return { suppressed: false, reason: 'no_supabase_open' };
  if (!contact_id) return { suppressed: false, reason: 'no_contact_id_open' };

  const { data, error } = await supabase
    .from('contact_tag_snapshot')
    .select('tags')
    .eq('ghl_contact_id', contact_id)
    .maybeSingle();

  if (error) {
    console.error(`[suppression-check] mutation snapshot read error for ${contact_id}: ${error.message}`);
    return { suppressed: false, reason: 'snapshot_read_error_open' };
  }
  if (!data || !Array.isArray(data.tags) || data.tags.length === 0) {
    return { suppressed: false, reason: 'no_snapshot_open' };
  }

  const matched = matchMutationSuppression(data.tags);
  if (!matched) return { suppressed: false, reason: 'no_match' };
  return { suppressed: true, reason: 'mutation_suppression_tag', matched_tag: matched };
}

// Exported for unit tests + introspection
export const __testing = { SUPPRESS_SET, MUTATION_SUPPRESS_SET };
