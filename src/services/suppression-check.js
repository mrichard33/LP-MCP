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
 */

import supabase from '../supabase.js';

/**
 * The canonical list of tags that suppress agentic outbound to a contact.
 * Order does not matter — matching is set-based. Tag names are lowercased
 * (contact_tag_snapshot normalizes on write).
 */
export const SUPPRESS_TAGS = [
  // Operational pause flags
  'suppress-automation',
  'suppress-outbound',

  // Intake/Routing Layer (Phase 1)
  'quarantined',

  // Loss intelligence
  'cooling-active',

  // Consent / compliance
  'dnc',
  'dnc-related',
  'unsubscribed',

  // Contact-initiated bot pauses (respected universally — strong negative
  // signal regardless of which channel the agentic send is using)
  'stop-bot',
  'pause-bot',
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
