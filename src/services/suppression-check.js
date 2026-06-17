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
export async function checkSuppression(contact_id) {
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

// Exported for unit tests + introspection
export const __testing = { SUPPRESS_SET };
