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

  // gold — mirrors CHECK bf_gold_good_only.
  const gold = input.gold === true;
  if (gold && verdict !== 'good') {
    return { ok: false, field: 'gold', error: 'Only a Good message can be saved as a gold example.' };
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
      seen_before: input.seen_before === true,
      gold,
      is_calibration: input.is_calibration === true,
    },
  };
}

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
  LIMITS,
  validateFeedback,
  resolveReviewerRole,
  canSubmitFeedback,
  canStopBot,
  canUndo,
  alreadyStopped,
  STOP_BOT_TAG,
  reviewDeepLink,
  buildUnsafeAlert,
};
