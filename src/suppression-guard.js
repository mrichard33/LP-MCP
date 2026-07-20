/**
 * Suppression Guard — src/suppression-guard.js
 *
 * Single source of truth for "is this contact suppressed?".
 *
 * Consumed by any path that WRITES routing state (entry tags, enrollment
 * tags, agentic-active). The question it answers is deliberately narrow:
 *
 *     May we re-arm routing state for this contact?
 *
 * It is NOT a send-time gate. Send-time enforcement is Layer 3 universal
 * suppression (open issue #51) and belongs in the action executor. This
 * module exists so that when #51 lands, both layers read the same list.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * 2026-07-20 lead-routing audit. DNC-tagged contacts were receiving
 * automated marketing email in production. The DNC closeout itself was
 * working correctly — HARD_DISQUALIFIED_CLOSEOUT fired 45 actions
 * including remove_from_workflow {remove_all: true} and stripped
 * agentic-active and active-entry:* as designed.
 *
 * The failure was what happened NEXT. DNC suppression is a one-shot purge
 * with no standing gate, so any downstream path that re-asserts routing
 * state silently resurrects a suppressed contact. Two did, nine hours
 * apart, and neither checked DNC first.
 *
 * Every per-workflow exit, every closeout allowlist, and every
 * remove_all: true shares this flaw: they act once and cannot stop what
 * happens after. The fix is to make the WRITE paths ask first.
 *
 * ── Tag family ─────────────────────────────────────────────────────────
 * The consent/DNC family and stop-bot each independently mean "do not
 * re-arm". They are checked as a set rather than individually because
 * they arrive from different sources (LP disposition sync, GHL tag
 * webhook, SMS STOP handler, chatbot opt-out) and no single one is
 * guaranteed present.
 *
 * NOTE: pause-bot and suppress-automation are deliberately NOT in this
 * list. Per standing doctrine only stop-bot stops the bot; pause-bot and
 * suppress-automation are not blockers and must never be treated as such.
 *
 * v1.0 — 2026-07-20. Fix 0a.
 */

/**
 * Tags that mean "this contact must not have routing state re-armed".
 *
 * Extending this list is the supported way to add a suppression signal —
 * do not inline tag literals at call sites.
 */
export const SUPPRESSION_TAGS = Object.freeze([
  'dnc',
  'stage:dnc',
  'dnc-sms',
  'do-not-contact',
  'unsubscribed',
  'stop-bot',
]);

/**
 * True if any suppression tag is present.
 *
 * Case-insensitive and whitespace-tolerant: GHL tag writes have
 * historically arrived with inconsistent casing, and a guard that misses
 * "DNC" because it expected "dnc" is worse than no guard at all.
 *
 * @param {string[]} tags — contact tag array (any falsy value → false)
 * @returns {boolean}
 */
export function isSuppressed(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  const normalized = new Set(
    tags
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
  );
  return SUPPRESSION_TAGS.some((t) => normalized.has(t));
}

/**
 * The specific suppression tags present on a contact, for logging and
 * for the observability payload. Returns [] when not suppressed.
 *
 * Callers should log this rather than just the boolean — knowing WHICH
 * signal fired is what makes a suppressed-write event diagnosable.
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
export function matchedSuppressionTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  const normalized = new Set(
    tags
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
  );
  return SUPPRESSION_TAGS.filter((t) => normalized.has(t));
}
