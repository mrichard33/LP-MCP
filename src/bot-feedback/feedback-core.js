/**
 * Bot Review — feedback pure core — src/bot-feedback/feedback-core.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 1.
 *   PROBLEM: the review queue is the only place a human tells the system the
 *   bot was wrong. If a verdict can be saved without a reason, or an Unsafe
 *   without a note, the Phase 2 clustering job has nothing to cluster ON and
 *   the whole learning loop degrades into a thumbs-down counter.
 *   FIX: validation that mirrors the DB CHECKs exactly, so the API rejects with
 *   a sentence a reviewer can act on instead of letting Postgres raise a
 *   constraint error the UI cannot explain.
 *
 * v1.1 — 2026-09-11. INCREMENT 2 (handoff §5).
 *   PROBLEM 1: there was no way to remove a review after the 10-second undo
 *   window. A wrong verdict found a week later was permanent, and it kept
 *   counting in every rate.
 *   FIX 1: retraction — validateRetract / canRetract. A retraction stops the
 *   review counting and takes it out of the queue, but never deletes the row:
 *   the change log and the agreement history stay honest.
 *
 *   PROBLEM 2: a reviewer who opened a lead that needed no judgement had to
 *   score it anyway or leave it in the queue forever, where it reappeared for
 *   the next reviewer.
 *   FIX 2: dismissals — validateDismissal / canDismiss. Persistent for the whole
 *   team, undoable, and never a verdict.
 *
 *   PROBLEM 3: `seen_before` asked a reviewer to remember whether they had met
 *   this failure before. The nightly Phase 2 grouping counts recurrence itself,
 *   from more data and without the memory. The toggle was the machine's job
 *   handed to a person with worse information.
 *   FIX 3: the field is no longer read from the request. The COLUMN stays (the
 *   six rows written under Phase 1 keep their history) and every new row is
 *   written false.
 *
 * The DB is still the authority — these rules exist in sql/103 as CHECK
 * constraints and stay there. This file is the friendly half of the same rule,
 * not a replacement for it.
 *
 * Dependency-free + pure, following the repo's *-core.js convention.
 */

export const VERDICTS = Object.freeze(['good', 'needs_work', 'unsafe']);
export const MESSAGE_TYPES = Object.freeze(['reply', 'skip', 'nurture']);
export const REVIEWER_ROLES = Object.freeze(['operator', 'team', 'admin']);

/** Field caps. Long enough for a real rewrite, short enough to bound a row. */
export const LIMITS = Object.freeze({
  better_text: 4000,
  note: 2000,
  message_ref: 200,
  reason_code: 80,
  reason_codes: 11,      // the seeded list; more than this is a client bug
});

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Validate a feedback submission.
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string, field: string}}
 *
 * Errors are written for the person in the chair, not the log: they say which
 * control to fix. The dashboard renders `error` under the control named by
 * `field`, which is why field is part of the contract.
 */
export function validateFeedback(input = {}, knownReasonCodes = null) {
  const messageType = str(input.message_type).trim();
  if (!MESSAGE_TYPES.includes(messageType)) {
    return { ok: false, field: 'message_type', error: `message_type must be one of ${MESSAGE_TYPES.join(', ')}.` };
  }

  const messageRef = str(input.message_ref).trim();
  if (!messageRef) {
    return { ok: false, field: 'message_ref', error: 'message_ref is required.' };
  }
  if (messageRef.length > LIMITS.message_ref) {
    return { ok: false, field: 'message_ref', error: `message_ref is longer than ${LIMITS.message_ref} characters.` };
  }

  const verdict = str(input.verdict).trim();
  if (!VERDICTS.includes(verdict)) {
    return { ok: false, field: 'verdict', error: 'Pick Good, Needs work, or Unsafe.' };
  }

  // reason_codes — mirrors CHECK bf_reason_required.
  const rawReasons = Array.isArray(input.reason_codes) ? input.reason_codes : [];
  const reasonCodes = [];
  for (const r of rawReasons) {
    const code = str(r).trim();
    if (!code) continue;
    if (code.length > LIMITS.reason_code) {
      return { ok: false, field: 'reason_codes', error: 'A reason code is malformed.' };
    }
    // Order of selection is preserved (the design reports on it), so dedupe
    // without sorting.
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
  }
  if (reasonCodes.length > LIMITS.reason_codes) {
    return { ok: false, field: 'reason_codes', error: 'Too many reasons selected.' };
  }
  if (verdict !== 'good' && reasonCodes.length === 0) {
    return {
      ok: false,
      field: 'reason_codes',
      error: verdict === 'unsafe'
        ? 'Pick at least one reason so the alert says what went wrong.'
        : 'Pick at least one reason.',
    };
  }
  if (Array.isArray(knownReasonCodes) && knownReasonCodes.length > 0) {
    const unknown = reasonCodes.find((c) => !knownReasonCodes.includes(c));
    if (unknown) {
      return { ok: false, field: 'reason_codes', error: `"${unknown}" is not a reason on the list.` };
    }
  }

  // note — mirrors CHECK bf_unsafe_note.
  const note = str(input.note).trim();
  if (verdict === 'unsafe' && note === '') {
    return { ok: false, field: 'note', error: 'Tell us what could go wrong.' };
  }
  if (note.length > LIMITS.note) {
    return { ok: false, field: 'note', error: `Keep the note under ${LIMITS.note} characters.` };
  }

  const betterText = str(input.better_text).trim();
  if (betterText.length > LIMITS.better_text) {
    return { ok: false, field: 'better_text', error: `Keep the rewrite under ${LIMITS.better_text} characters.` };
  }

  // gold — mirrors CHECK bf_gold_good_only. The COLUMN is still `gold`; the
  // words a reviewer reads are "teaching example" everywhere (v1.1, handoff
  // §6B: "gold example" is jargon nobody outside this repo uses).
  const gold = input.gold === true;
  if (gold && verdict !== 'good') {
    return { ok: false, field: 'gold', error: 'Only a Good message can be used as a teaching example.' };
  }

  return {
    ok: true,
    value: {
      message_type: messageType,
      message_ref: messageRef,
      verdict,
      reason_codes: reasonCodes,
      better_text: betterText === '' ? null : betterText,
      note: note === '' ? null : note,
      // v1.1: NOT read from the request any more. Always false on a new row —
      // the column is kept only so the Phase 1 rows stay readable.
      seen_before: false,
      gold,
      is_calibration: input.is_calibration === true,
    },
  };
}

/** Retraction reason cap. Long enough to explain, short enough to bound a row. */
export const RETRACT_REASON_MAX = 500;
export const DISMISS_REASON_MAX = 500;
export const DISMISS_SCOPES = Object.freeze(['message', 'conversation']);

/**
 * Validate a retraction.
 *
 * The reason is REQUIRED, and the DB trigger requires it too. A retraction
 * without one is indistinguishable from a mistake six months later, and the
 * whole point of retracting rather than deleting is that someone can read back
 * why the review stopped counting.
 */
export function validateRetract(input = {}) {
  const reason = str(input.reason).trim();
  if (!reason) {
    return { ok: false, field: 'reason', error: 'Tell us why this review is being removed.' };
  }
  if (reason.length > RETRACT_REASON_MAX) {
    return { ok: false, field: 'reason', error: `Keep the reason under ${RETRACT_REASON_MAX} characters.` };
  }
  return { ok: true, value: { reason } };
}

/**
 * Who may retract: the review's own author, or any admin.
 *
 * Deliberately NARROWER than canUndo's shape even though it reads the same —
 * they are different powers and will drift apart (an operator may one day
 * retract a team member's review; they may never undo one). Keeping them as two
 * functions is what makes that change a one-line edit instead of a hunt.
 */
export function canRetract(ctx, row) {
  if (!row) return false;
  return ctx?.isAdmin === true || str(row.reviewer_email).toLowerCase() === str(ctx?.email).toLowerCase();
}

/** Dismissing is a queue decision, not a verdict: operators and admins. */
export function canDismiss(ctx) {
  return ctx?.role === 'operator' || ctx?.role === 'team' || ctx?.isAdmin === true;
}

/** Undoing a dismissal is a wider power than making one: operators and admins. */
export function canUndoDismiss(ctx) {
  return ctx?.role === 'operator' || ctx?.isAdmin === true;
}

/**
 * Validate a dismissal.
 *
 * Mirrors CHECK brd_scope_target: a message dismissal needs a context_id, a
 * conversation dismissal needs a contact. Sending both is a client bug, and the
 * extra one is dropped rather than stored — a row that claims to be both would
 * match two different unique indexes.
 */
export function validateDismissal(input = {}) {
  const scope = str(input.scope).trim();
  if (!DISMISS_SCOPES.includes(scope)) {
    return { ok: false, field: 'scope', error: `scope must be one of ${DISMISS_SCOPES.join(', ')}.` };
  }

  const reason = str(input.reason).trim();
  if (reason.length > DISMISS_REASON_MAX) {
    return { ok: false, field: 'reason', error: `Keep the reason under ${DISMISS_REASON_MAX} characters.` };
  }

  if (scope === 'message') {
    const contextId = Number(input.context_id);
    if (!Number.isInteger(contextId) || contextId <= 0) {
      return { ok: false, field: 'context_id', error: 'context_id is required to dismiss one message.' };
    }
    return {
      ok: true,
      value: { scope, context_id: contextId, ghl_contact_id: null, reason: reason || null },
    };
  }

  const contactId = str(input.ghl_contact_id).trim();
  if (!contactId) {
    return { ok: false, field: 'ghl_contact_id', error: 'ghl_contact_id is required to dismiss a conversation.' };
  }
  return {
    ok: true,
    value: { scope, context_id: null, ghl_contact_id: contactId, reason: reason || null },
  };
}

/** The three review lanes, in the order the UI shows them. */
export const REVIEW_LANES = Object.freeze(['must_review', 'spot_check', 'none']);

/**
 * The reviewer's role for a feedback row.
 *
 * 'admin' is a ROLE here, not a permission flag: the agreement view measures
 * everyone else against the admin's verdicts, so an operator who is also an
 * executive admin has to be recorded as 'admin' or they would be calibrating
 * against themselves.
 */
export function resolveReviewerRole({ role, isAdmin }) {
  if (isAdmin) return 'admin';
  if (role === 'operator') return 'operator';
  return 'team';
}

/**
 * Who may do what (handoff §7 + the plan's Part 6 table).
 *
 * `counts` is NOT a permission — an uncalibrated team member may review, their
 * verdict is simply stored with counts=false and excluded from the rates until
 * they calibrate. Blocking them would mean they could never calibrate.
 */
export function canSubmitFeedback(ctx) {
  return ctx?.role === 'operator' || ctx?.role === 'team' || ctx?.isAdmin === true;
}
export function canStopBot(ctx) {
  return ctx?.role === 'operator' || ctx?.isAdmin === true;
}
export function canUndo(ctx, row) {
  if (!row) return false;
  return ctx?.isAdmin === true || str(row.reviewer_email).toLowerCase() === str(ctx?.email).toLowerCase();
}

/** DNC / stop family — a lead already stopped must not be re-tagged. */
export const STOP_BOT_TAG = 'stop-bot';

/** Is the bot already stopped for this contact? Used for the idempotent reply. */
export function alreadyStopped(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => str(t).toLowerCase().trim() === STOP_BOT_TAG);
}

/**
 * The deep link an Unsafe alert carries, so Mark lands on the exact message
 * rather than the top of the queue (handoff §5.2).
 */
export function reviewDeepLink(baseUrl, contextId) {
  const base = str(baseUrl).trim().replace(/\/+$/, '');
  if (!base || contextId == null) return null;
  return `${base}/bot-review?tab=review&ctx=${encodeURIComponent(String(contextId))}`;
}

/**
 * The Unsafe alert body. Content is fixed by §5.2: lead city, channel, rule,
 * the message, reasons, note, deep link.
 *
 * Pure so the wording is unit-testable — an alert that omits the note is
 * useless to whoever reads it first, and that is exactly the kind of regression
 * a test should catch.
 */
export function buildUnsafeAlert({
  office = null,
  channel = null,
  ruleApplied = null,
  replyText = null,
  skipReason = null,
  reasonLabels = [],
  note = null,
  reviewerEmail = null,
  link = null,
}) {
  const lines = [
    '⚠️ UNSAFE BOT MESSAGE FLAGGED',
    `📍 ${office || 'Unknown office'} · ${channel || 'unknown channel'} · ${ruleApplied || 'no rule'}`,
    `👤 Flagged by ${reviewerEmail || 'unknown reviewer'}`,
  ];
  const body = str(replyText).trim();
  if (body) lines.push(`Message: "${body.length > 400 ? `${body.slice(0, 400)}…` : body}"`);
  else if (skipReason) lines.push(`Bot stayed silent · Reason: ${skipReason}`);
  if (reasonLabels.length) lines.push(`Reasons: ${reasonLabels.join(', ')}`);
  if (note) lines.push(`Note: ${note}`);
  if (link) lines.push(`→ ${link}`);
  return lines.join('\n');
}

export default {
  VERDICTS,
  MESSAGE_TYPES,
  REVIEWER_ROLES,
  REVIEW_LANES,
  LIMITS,
  RETRACT_REASON_MAX,
  DISMISS_REASON_MAX,
  DISMISS_SCOPES,
  validateFeedback,
  validateRetract,
  validateDismissal,
  resolveReviewerRole,
  canSubmitFeedback,
  canStopBot,
  canUndo,
  canRetract,
  canDismiss,
  canUndoDismiss,
  alreadyStopped,
  STOP_BOT_TAG,
  reviewDeepLink,
  buildUnsafeAlert,
};
