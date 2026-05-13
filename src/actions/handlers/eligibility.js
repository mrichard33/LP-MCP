/**
 * Eligibility Check Handler — src/actions/handlers/eligibility.js
 *
 * Phase 1 #52 — Intake/Routing Layer eligibility gate.
 *
 * Validates whether a contact is eligible for resurrection enrollment
 * (Day 15 backfill, agentic re-engagement, S1.2 / S4.5 routing, etc.).
 *
 * RULES (hard gate — fail any → ineligible):
 *   1. Phone must be present and look valid (10+ digits)
 *   2. Email must be present and contain @
 *   3. Tag exclusions:
 *      - any SUPPRESS_TAG from suppression-check.js
 *      - lp-sale (already converted)
 *      - lp-installed (in active install)
 *      - lp-related-dnc (related DNC)
 *      - intake-ineligible (sticky from prior failure)
 *
 * On INELIGIBLE → action completes with reason + tags applied for audit.
 * On ELIGIBLE → action completes with passed:true; downstream actions in
 * the same batch proceed normally.
 *
 * USED BY
 * ───────
 * Intake/Routing Layer rules (Phase 1+):
 *   - INTAKE_GATE_RESURRECTION_ELIGIBILITY (Bucket B/C eligibility)
 *   - Custom enrollment flows that need a hard pre-flight check
 *
 * Action payload:
 *   {
 *     mode?: 'resurrection' | 'general',  // default 'resurrection'
 *     extra_exclude_tags?: string[],       // additional contact tags that block eligibility
 *     require_phone?: boolean,             // default true
 *     require_email?: boolean,             // default true
 *   }
 *
 * Returns (in execution_result):
 *   {
 *     eligible: true | false,
 *     checks: { phone, email, suppression, exclusion_tags, snapshot },
 *     failed_checks: string[],
 *     matched_exclude_tags?: string[],
 *     matched_suppress_tag?: string,
 *     contact_id, mode
 *   }
 *
 * Tags applied:
 *   - On INELIGIBLE: adds `intake-ineligible` (sticky audit trail)
 *   - On ELIGIBLE: adds `intake-eligible:{mode}` (timestamped via GHL native)
 *
 * Events emitted (via supabase insert; allow-listed in event-intake-filter):
 *   - intake.eligibility_passed (entity_type='contact', high priority)
 *   - intake.eligibility_failed (entity_type='contact', normal priority)
 *
 * Note: emitted events use bypass_filter:true because the filter
 * allowlist doesn't include intake.* yet — when the consuming rules
 * ship, the allowlist should be updated and the bypass can stay
 * (defense-in-depth).
 */

import { ghlFetch } from '../helpers.js';
import { checkSuppression } from '../../services/suppression-check.js';
import supabase from '../../supabase.js';

// Tags that disqualify a contact from resurrection regardless of phone/email.
// These are non-suppression-based exclusions specific to the eligibility gate.
const RESURRECTION_EXCLUDE_TAGS = [
  'lp-sale',                // converted — don't re-enroll
  'lp-installed',           // mid-install — already in P2 lifecycle
  'lp-related-dnc',         // related DNC (different from primary DNC, which suppression-check catches)
  'intake-ineligible',      // sticky from prior failure — don't re-test for at least the cooldown
  'do-not-contact',         // belt-and-suspenders alongside dnc
];

function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10;
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.includes('@')) return false;
  if (trimmed === 'fake@gmail.com') return false;  // common LP placeholder
  if (trimmed.endsWith('@noemail.com')) return false;
  if (trimmed.endsWith('@invalid.com')) return false;
  return true;
}

/**
 * Emit a system event for eligibility outcome. Uses bypass_filter:true
 * so the filter doesn't drop the event before its consuming rule ships.
 */
async function emitEligibilityEvent({ contactId, passed, reason, payload }) {
  try {
    const eventType = passed ? 'intake.eligibility_passed' : 'intake.eligibility_failed';
    // Direct insert (bypasses event-emitter so we don't need to thread
    // bypass_filter through). Intake.* events are internal-emitted and
    // safe to bypass the allowlist gate.
    await supabase.from('system_events').insert({
      event_type: eventType,
      event_subtype: reason || null,
      source: 'agent_executor',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: payload || {},
      priority: passed ? 'high' : 'normal',
      event_timestamp: new Date().toISOString(),
      processed: false,
    });
  } catch (err) {
    console.warn(`[executeCheckEligibility] event emit failed: ${err.message}`);
  }
}

/**
 * Apply the audit tag for the outcome. Best-effort — failure doesn't
 * change the eligibility decision.
 */
async function applyOutcomeTag(contactId, tag) {
  try {
    await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tag] });
  } catch (err) {
    console.warn(`[executeCheckEligibility] outcome tag ${tag} on ${contactId} failed: ${err.message}`);
  }
}

export async function executeCheckEligibility(action) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId');

  const params = action.action_payload || {};
  const mode = params.mode || 'resurrection';
  const requirePhone = params.require_phone !== false;       // default true
  const requireEmail = params.require_email !== false;       // default true
  const extraExcludeTags = Array.isArray(params.extra_exclude_tags) ? params.extra_exclude_tags : [];

  const checks = {
    phone: null,
    email: null,
    suppression: null,
    exclusion_tags: null,
    snapshot: null,
  };
  const failedChecks = [];

  // ── 1. Fetch contact ───────────────────────────────────────────
  let contact;
  try {
    const resp = await ghlFetch('GET', `/contacts/${contactId}`);
    contact = resp?.contact || resp || null;
  } catch (err) {
    throw new Error(`Eligibility fetch failed for ${contactId}: ${err.message}`);
  }
  if (!contact) {
    throw new Error(`Contact ${contactId} not found in GHL`);
  }

  // ── 2. Phone check ─────────────────────────────────────────────
  if (requirePhone) {
    checks.phone = isValidPhone(contact.phone) ? 'pass' : 'fail';
    if (checks.phone === 'fail') failedChecks.push('phone_invalid_or_missing');
  } else {
    checks.phone = 'skipped';
  }

  // ── 3. Email check ─────────────────────────────────────────────
  if (requireEmail) {
    checks.email = isValidEmail(contact.email) ? 'pass' : 'fail';
    if (checks.email === 'fail') failedChecks.push('email_invalid_or_missing');
  } else {
    checks.email = 'skipped';
  }

  // ── 4. Suppression check (uses contact_tag_snapshot via service) ─
  let matchedSuppressTag = null;
  const suppression = await checkSuppression(contactId);
  if (suppression.suppressed) {
    checks.suppression = 'fail';
    matchedSuppressTag = suppression.matched_tag;
    failedChecks.push(`suppressed:${suppression.matched_tag}`);
  } else {
    checks.suppression = 'pass';
    checks.snapshot = suppression.reason; // 'no_match' / 'no_snapshot_open' / etc — useful for telemetry
  }

  // ── 5. Exclusion tag check (live GHL tags, not snapshot) ───────
  // Snapshot has 5-day backfill gap on legacy contacts; for the
  // eligibility hard gate we read live tags to avoid false-eligibles
  // for un-snapshotted lp-sale / lp-installed cases.
  const liveTags = Array.isArray(contact.tags) ? contact.tags : [];
  const excludeList =
    mode === 'resurrection'
      ? [...RESURRECTION_EXCLUDE_TAGS, ...extraExcludeTags]
      : [...extraExcludeTags];
  const matchedExcludeTags = liveTags.filter(t => excludeList.includes(t));
  if (matchedExcludeTags.length > 0) {
    checks.exclusion_tags = 'fail';
    failedChecks.push(`exclusion_tag:${matchedExcludeTags[0]}`);
  } else {
    checks.exclusion_tags = 'pass';
  }

  // ── 6. Final decision ──────────────────────────────────────────
  const eligible = failedChecks.length === 0;

  // ── 7. Apply outcome tag (best-effort audit trail) ─────────────
  if (eligible) {
    await applyOutcomeTag(contactId, `intake-eligible:${mode}`);
  } else {
    await applyOutcomeTag(contactId, 'intake-ineligible');
  }

  // ── 8. Emit observability event ────────────────────────────────
  const eventPayload = {
    mode,
    eligible,
    failed_checks: failedChecks,
    matched_exclude_tags: matchedExcludeTags,
    matched_suppress_tag: matchedSuppressTag,
  };
  await emitEligibilityEvent({
    contactId,
    passed: eligible,
    reason: failedChecks[0] || 'passed',
    payload: eventPayload,
  });

  console.log(
    `[executeCheckEligibility] ${contactId} mode=${mode} eligible=${eligible}${failedChecks.length ? ` failed=[${failedChecks.join(',')}]` : ''}`
  );

  return {
    eligible,
    mode,
    checks,
    failed_checks: failedChecks,
    matched_exclude_tags: matchedExcludeTags,
    matched_suppress_tag: matchedSuppressTag,
    contact_id: contactId,
  };
}
