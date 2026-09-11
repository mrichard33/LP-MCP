/**
 * Bot Review — feedback service — src/bot-feedback/feedback.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 1.
 *   The write surface for human review. Everything the dashboard does to a bot
 *   table comes through here (handoff §3): the page never writes bot_feedback
 *   itself, so permissions, the change log and the Unsafe alert cannot be
 *   bypassed by a client that forgets them.
 *
 * Every mutating call (handoff §5):
 *   · requires an `x-actor-email` header
 *   · RE-CHECKS permission server-side against dashboard_users + executives,
 *     via the service role. The dashboard's own gate is a courtesy; this is the
 *     gate. Never trust the caller's claim about their own role.
 *   · writes bot_change_log
 *   · returns { ok, data | error }
 *
 * Degrades on a missing relation (sql/103 / sql/104 not applied) with a clear
 * message rather than a 500 — the dashboard renders "needs migration".
 *
 * v1.1 — 2026-09-11. INCREMENT 2 (handoff §5).
 *   Adds retractFeedback, dismissReview, undoDismissal and listCompleted.
 *   Drops `seen_before` from the request shape (§6B).
 *
 *   FIX, found while building this: editFeedback has NEVER linked a superseding
 *   row. It inserted the new verdict and then ran
 *   `UPDATE bot_feedback SET supersedes_id = …`, which the append-only trigger
 *   from sql/103 refuses — only undone_at was ever mutable. Every edit since
 *   Phase 1 returned "Saved the new review but could not link it to the old
 *   one", leaving two live verdicts from the same reviewer on one message.
 *   supersedes_id is now set on the INSERT, where no trigger objects, and the
 *   guard stays as tight as it was.
 *
 * v1.2 — 2026-09-11.
 *   PROBLEM: v1.1 made editFeedback select bot_feedback.retracted_at, which
 *   only exists once sql/106 is applied — and sql/106 is applied BY HAND in the
 *   Supabase dashboard, so there is always a window where this code is live and
 *   the column is not. PostgREST reports an unknown column with the same "does
 *   not exist" wording as an unknown table, so isMissingRelation() caught it and
 *   every edit in that window returned a 503 telling Mark to apply sql/103 —
 *   a file that was already applied, while the real blocker went unnamed.
 *   Caught against production the moment LP-MCP#908 merged: the code deployed,
 *   the migration had not been run, and the queue check showed 0 of the 5
 *   sql/106 relations present.
 *   FIX: fall back to the pre-migration column set. Editing keeps working
 *   either side of the migration, and the v1.1 supersedes_id fix takes effect
 *   immediately instead of waiting on it.
 */

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';
import { isMissingRelation } from './fingerprint-core.js';
import {
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
  reviewDeepLink,
  buildUnsafeAlert,
  STOP_BOT_TAG,
} from './feedback-core.js';

/** Where the dashboard lives, for the deep link in an Unsafe alert (§8). */
const DASHBOARD_URL = process.env.BOT_REVIEW_DASHBOARD_URL || '';

/**
 * Resolve who is calling, from the service role, using ONLY the email in the
 * header. The caller does not get to say what role they have.
 *
 * Mirrors the dashboard's own model (lib/auth.ts): dashboard_users.role gives
 * operator | team, executives.is_admin gives admin powers.
 */
export async function resolveActor(email) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { ok: false, error: 'x-actor-email header is required.' };
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };

  const { data: user, error } = await supabase
    .from('dashboard_users')
    .select('email, role')
    .ilike('email', addr)
    .maybeSingle();

  if (error) return { ok: false, error: `Could not verify the actor: ${error.message}` };
  if (!user) return { ok: false, error: `${addr} is not on the dashboard allowlist.` };

  // executives.is_admin — the same flag the Command Center rules on. A missing
  // table (pre-migration) reads as "not an admin", never as an error.
  let isAdmin = false;
  try {
    const { data: exec } = await supabase
      .from('executives')
      .select('is_admin')
      .ilike('email', addr)
      .eq('active', true)
      .maybeSingle();
    isAdmin = exec?.is_admin === true;
  } catch { /* not an executive */ }

  return { ok: true, actor: { email: user.email, role: user.role, isAdmin } };
}

/**
 * Append to the audit log. Never throws — a failed log must not undo a write.
 *
 * Exported so the prompt editor (prompts.js) writes its promoted_live /
 * rolled_back entries through the SAME function rather than a second copy that
 * could drift on column names or on the swallow-errors rule.
 */
export async function logChange({ actor, action, targetTable, targetId, reason = null, before = null, after = null }) {
  try {
    const { error } = await supabase.from('bot_change_log').insert({
      actor, action, target_table: targetTable, target_id: String(targetId),
      reason, before, after,
    });
    if (error && !isMissingRelation(error)) {
      console.warn(`[BotFeedback] change log ${action} failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[BotFeedback] change log ${action} threw: ${err.message}`);
  }
}

/** The active reason list, for validating submitted codes against reality. */
async function knownReasonCodes() {
  try {
    const { data, error } = await supabase
      .from('bot_feedback_reasons').select('code, label').eq('active', true);
    if (error) return { codes: null, labels: new Map() };
    return {
      codes: (data ?? []).map((r) => r.code),
      labels: new Map((data ?? []).map((r) => [r.code, r.label])),
    };
  } catch {
    return { codes: null, labels: new Map() };
  }
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/feedback
// ═══════════════════════════════════════════════════════════════════
export async function submitFeedback(actorEmail, body, { supersedesId = null } = {}) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  if (!canSubmitFeedback(actor)) {
    return { ok: false, error: 'You do not have access to review bot messages.', status: 403 };
  }

  const { codes, labels } = await knownReasonCodes();
  const v = validateFeedback(body, codes);
  if (!v.ok) return { ok: false, error: v.error, field: v.field, status: 400 };
  const input = v.value;

  // Resolve the context row: the server owns context_id, ghl_contact_id and
  // ai_score_at_review, never the client. ai_score_at_review is a SNAPSHOT —
  // the judge can rescore later and the reviewer's verdict must stay paired
  // with the number they actually saw.
  const { data: ctxRow, error: ctxError } = await supabase
    .from('v_bot_review_queue')
    .select('context_id, ghl_contact_id, ai_score, channel, rule_applied, reply_text, skip_reason, office')
    .eq('message_type', input.message_type)
    .eq('message_ref', input.message_ref)
    .maybeSingle();

  if (ctxError && isMissingRelation(ctxError)) {
    return { ok: false, error: 'Bot Review is not migrated yet — apply sql/103 and sql/104.', status: 503 };
  }
  if (!ctxRow) {
    return { ok: false, error: 'That message is no longer in the review queue.', status: 404 };
  }

  // counts: an uncalibrated team reviewer is STORED but does not move the
  // rates (§5.2). Operators and admins always count.
  let counts = true;
  if (actor.role === 'team' && !actor.isAdmin) {
    const { data: agree } = await supabase
      .from('v_bot_reviewer_agreement')
      .select('calibrated')
      .ilike('reviewer_email', actor.email)
      .maybeSingle();
    // No row yet = no reviews yet = not calibrated.
    counts = agree?.calibrated === true;
  }

  const row = {
    ...input,
    context_id: ctxRow.context_id,
    ghl_contact_id: ctxRow.ghl_contact_id,
    reviewer_email: actor.email,
    reviewer_role: resolveReviewerRole(actor),
    counts,
    ai_score_at_review: ctxRow.ai_score ?? null,
    // v1.1: set HERE, on the insert. The old code updated it afterwards and the
    // append-only trigger rejected that every single time — see the file header.
    ...(supersedesId != null ? { supersedes_id: supersedesId } : {}),
  };

  const { data: inserted, error: insertError } = await supabase
    .from('bot_feedback').insert(row).select('id, created_at').single();

  if (insertError) {
    if (isMissingRelation(insertError)) {
      return { ok: false, error: 'Bot Review is not migrated yet — apply sql/103.', status: 503 };
    }
    console.error(`[BotFeedback] insert failed: ${insertError.message}`);
    return { ok: false, error: insertError.message, status: 500 };
  }

  await logChange({
    actor: actor.email, action: 'feedback_submitted',
    targetTable: 'bot_feedback', targetId: inserted.id,
    after: { verdict: input.verdict, reason_codes: input.reason_codes, counts },
  });

  // Unsafe → alert within 60s (§5.2). Detached: the reviewer's submit must not
  // wait on GroupMe, and a failed alert must not lose the verdict. The row is
  // already committed above, so the worst case is an alert that did not send —
  // which the change log will show by the absence of feedback_unsafe_alert.
  if (input.verdict === 'unsafe') {
    alertUnsafeDetached({ actor, input, ctxRow, feedbackId: inserted.id, labels });
  }

  return {
    ok: true,
    data: {
      id: inserted.id,
      created_at: inserted.created_at,
      counts,
      context_id: ctxRow.context_id,
      // The UI shows "your review is stored but doesn't count yet" from this.
      uncalibrated: counts === false,
    },
  };
}

function alertUnsafeDetached({ actor, input, ctxRow, feedbackId, labels }) {
  (async () => {
    const text = buildUnsafeAlert({
      office: ctxRow.office,
      channel: ctxRow.channel,
      ruleApplied: ctxRow.rule_applied,
      replyText: ctxRow.reply_text,
      skipReason: ctxRow.skip_reason,
      reasonLabels: input.reason_codes.map((c) => labels.get(c) || c),
      note: input.note,
      reviewerEmail: actor.email,
      link: reviewDeepLink(DASHBOARD_URL, ctxRow.context_id),
    });
    await sendGroupMeMessage(text);
    await logChange({
      actor: `system:unsafe_alert`, action: 'feedback_unsafe_alert',
      targetTable: 'bot_feedback', targetId: feedbackId,
      reason: input.note, after: { sent_at: new Date().toISOString() },
    });
  })().catch((err) => console.warn(`[BotFeedback] unsafe alert failed: ${err.message}`));
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/feedback/:id/undo
// ═══════════════════════════════════════════════════════════════════
//
// The 10-second window is enforced by the DB trigger (sql/103), not here. This
// only decides WHO may undo; the trigger decides WHEN. Both have to agree, and
// the trigger is the one that cannot be bypassed.
export async function undoFeedback(actorEmail, id) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  const { data: row, error } = await supabase
    .from('bot_feedback').select('id, reviewer_email, undone_at').eq('id', id).maybeSingle();
  if (error && isMissingRelation(error)) {
    return { ok: false, error: 'Bot Review is not migrated yet — apply sql/103.', status: 503 };
  }
  if (!row) return { ok: false, error: 'That review no longer exists.', status: 404 };
  if (!canUndo(actor, row)) {
    return { ok: false, error: 'You can only undo your own review.', status: 403 };
  }
  if (row.undone_at) return { ok: true, data: { id: row.id, already_undone: true } };

  const { error: updateError } = await supabase
    .from('bot_feedback').update({ undone_at: new Date().toISOString() }).eq('id', id);

  if (updateError) {
    // The trigger's own message is the honest one — it says the window closed.
    const closed = /undo window closed/i.test(updateError.message || '');
    return {
      ok: false,
      error: closed ? 'Too late to undo — that review is already saved.' : updateError.message,
      status: closed ? 409 : 500,
    };
  }

  await logChange({
    actor: actor.email, action: 'feedback_undone',
    targetTable: 'bot_feedback', targetId: id,
  });
  return { ok: true, data: { id, undone: true } };
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/feedback/:id/edit
// ═══════════════════════════════════════════════════════════════════
//
// An edit is a NEW row carrying supersedes_id. Nothing is ever updated in
// place, so the original verdict stays readable in history and
// v_bot_current_feedback hides it from the rates. This is why the undo window
// can be 10 seconds and still be safe: a late change is an edit, not an undo.
export async function editFeedback(actorEmail, id, body) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  /*
   * retracted_at only exists once sql/106 is applied, and PostgREST reports an
   * unknown COLUMN with the same "does not exist" wording as an unknown table.
   * Asking for it unconditionally would take editing down for the whole window
   * between this code deploying and Mark running the migration by hand — and
   * that window is real: sql/106 is applied in the dashboard, deliberately not
   * at boot. So: ask for it, and fall back to the pre-migration column set.
   *
   * Nothing can be retracted before sql/106 exists, so the guard below is
   * simply inert on the fallback path rather than wrong.
   */
  let prior = null;
  let error = null;
  ({ data: prior, error } = await supabase
    .from('bot_feedback')
    .select('id, message_type, message_ref, reviewer_email, undone_at, retracted_at')
    .eq('id', id).maybeSingle());

  if (error && isMissingRelation(error)) {
    ({ data: prior, error } = await supabase
      .from('bot_feedback')
      .select('id, message_type, message_ref, reviewer_email, undone_at')
      .eq('id', id).maybeSingle());
    // Still missing with the original column set → the TABLE is absent, which
    // is a different problem and names a different file.
    if (error && isMissingRelation(error)) {
      return { ok: false, error: 'Bot Review is not migrated yet — apply sql/103.', status: 503 };
    }
  }
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!prior) return { ok: false, error: 'That review no longer exists.', status: 404 };
  if (!canUndo(actor, prior)) {
    return { ok: false, error: 'You can only edit your own review.', status: 403 };
  }

  // A retracted review is gone; editing it would resurrect a verdict someone
  // deliberately removed. Re-reviewing the message is the way back.
  if (prior.retracted_at) {
    return { ok: false, error: 'That review was removed. Score the message again instead.', status: 409 };
  }

  // The edit always targets the SAME message as the row it supersedes — a
  // client cannot repoint a review at a different message. The link is written
  // by the INSERT itself (v1.1); there is no follow-up UPDATE to fail.
  const res = await submitFeedback(
    actorEmail,
    { ...body, message_type: prior.message_type, message_ref: prior.message_ref },
    { supersedesId: Number(id) },
  );
  if (!res.ok) return res;

  await logChange({
    actor: actor.email, action: 'feedback_edited',
    targetTable: 'bot_feedback', targetId: res.data.id,
    before: { superseded_id: id },
  });
  return { ok: true, data: { ...res.data, supersedes_id: id } };
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/lead/:contactId/stop-bot
// ═══════════════════════════════════════════════════════════════════
//
// Queues the EXISTING Action Executor add_tag handler (§1.4: GHL is read-only
// from our code except through Action Executor). We never call GHL here.
export async function stopBot(actorEmail, contactId, reason) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  if (!canStopBot(actor)) {
    return { ok: false, error: 'Stopping the bot is for operators and admins.', status: 403 };
  }
  const target = String(contactId || '').trim();
  if (!target) return { ok: false, error: 'contactId is required.', status: 400 };

  // Idempotent (§5.2). The tag snapshot is the cache the send path itself
  // falls back on, so it is the right thing to read.
  try {
    const { data: snap } = await supabase
      .from('contact_tag_snapshot').select('tags').eq('ghl_contact_id', target).maybeSingle();
    if (snap && alreadyStopped(snap.tags)) {
      return { ok: true, data: { already_stopped: true, action_id: null } };
    }
  } catch { /* no snapshot — queue the tag anyway; add_tag is itself idempotent in GHL */ }

  const { data: action, error: insertError } = await supabase
    .from('agent_actions')
    .insert({
      action_type: 'add_tag',
      target_system: 'ghl',
      target_entity: 'contact',
      target_id: target,
      action_payload: { tag: STOP_BOT_TAG },
      reasoning: `Bot Review: ${actor.email} stopped the bot for this lead${reason ? ` — ${reason}` : ''}`,
      confidence: 1.0,
      rule_applied: 'BOT_REVIEW_STOP_BOT',
      status: 'pending',
      requires_approval: false,
      sequence_order: 0,
    })
    .select('id').single();

  if (insertError) {
    console.error(`[BotFeedback] stop-bot queue failed for ${target}: ${insertError.message}`);
    return { ok: false, error: insertError.message, status: 500 };
  }

  await logChange({
    actor: actor.email, action: 'stop_bot',
    targetTable: 'agent_actions', targetId: action.id,
    reason: reason || null,
    after: { ghl_contact_id: target, tag: STOP_BOT_TAG },
  });

  return { ok: true, data: { action_id: action.id, already_stopped: false } };
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/bot-feedback/calibration/next
// ═══════════════════════════════════════════════════════════════════
//
// The next admin-reviewed message this reviewer has NOT done, with the admin's
// verdict withheld. Withholding it is the whole point: a calibration score is
// only meaningful if the reviewer could not see the answer.
export async function calibrationNext(actorEmail) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  const { data: adminRows, error } = await supabase
    .from('v_bot_current_feedback')
    .select('message_type, message_ref, created_at')
    .eq('reviewer_role', 'admin')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error && isMissingRelation(error)) {
    return { ok: false, error: 'Bot Review is not migrated yet — apply sql/104.', status: 503 };
  }
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!adminRows?.length) {
    return { ok: true, data: { next: null, reason: 'no_admin_reviews_yet' } };
  }

  const { data: mine } = await supabase
    .from('v_bot_current_feedback')
    .select('message_type, message_ref')
    .ilike('reviewer_email', actor.email);

  const done = new Set((mine ?? []).map((r) => `${r.message_type}::${r.message_ref}`));
  const next = adminRows.find((r) => !done.has(`${r.message_type}::${r.message_ref}`));
  if (!next) return { ok: true, data: { next: null, reason: 'all_done' } };

  const { data: progress } = await supabase
    .from('v_bot_reviewer_agreement')
    .select('calibration_done, agreement, calibrated, calibration_target, agreement_target')
    .ilike('reviewer_email', actor.email)
    .maybeSingle();

  return {
    ok: true,
    data: {
      // NOTE: the admin's verdict is deliberately NOT included.
      next: { message_type: next.message_type, message_ref: next.message_ref },
      progress: progress ?? {
        calibration_done: 0, agreement: null, calibrated: false,
        calibration_target: 30, agreement_target: 0.8,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// INCREMENT 2 — retraction, dismissals, the Completed list
// ═══════════════════════════════════════════════════════════════════

/**
 * sql/106 adds columns as well as tables, and PostgREST reports an unknown
 * COLUMN with the same "does not exist" wording as an unknown table — so
 * isMissingRelation() catches both. This only decides which file to name.
 */
const NEEDS_INC2 = 'Bot Review increment 2 is not migrated yet — apply sql/106_bot_review_inc2.sql.';

// ── POST /api/bot-feedback/feedback/:id/retract ────────────────────
//
// Retraction is the answer to "I got that one wrong and the undo window closed
// three days ago". It is NOT a delete: the row stays, v_bot_current_feedback
// stops returning it, and every rate built on that view drops it in the same
// breath. A reason is required by this function AND by the DB trigger — two
// gates, because a retraction nobody can explain is worse than the bad review.
export async function retractFeedback(actorEmail, id, body) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  const v = validateRetract(body || {});
  if (!v.ok) return { ok: false, error: v.error, field: v.field, status: 400 };

  const { data: row, error } = await supabase
    .from('bot_feedback')
    .select('id, message_type, message_ref, context_id, ghl_contact_id, reviewer_email, reviewer_role, ' +
            'verdict, reason_codes, better_text, note, gold, counts, is_calibration, ai_score_at_review, ' +
            'supersedes_id, created_at, undone_at, retracted_at, retracted_by, retract_reason')
    .eq('id', id)
    .maybeSingle();

  if (error && isMissingRelation(error)) return { ok: false, error: NEEDS_INC2, status: 503 };
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!row) return { ok: false, error: 'That review no longer exists.', status: 404 };

  if (!canRetract(actor, row)) {
    return { ok: false, error: 'You can only remove your own review.', status: 403 };
  }

  // Idempotent: a second click (or a retried request) is not an error. The
  // caller gets the same shape back and the UI can show the same confirmation.
  if (row.retracted_at) {
    return {
      ok: true,
      data: {
        id: row.id,
        already_retracted: true,
        retracted_at: row.retracted_at,
        retracted_by: row.retracted_by,
      },
    };
  }

  const retractedAt = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('bot_feedback')
    .update({ retracted_at: retractedAt, retracted_by: actor.email, retract_reason: v.value.reason })
    .eq('id', id);

  if (updateError) {
    if (isMissingRelation(updateError)) return { ok: false, error: NEEDS_INC2, status: 503 };
    // The trigger's own messages are the honest ones — surface them rather than
    // a generic 500 that hides which rule was hit.
    const guard = /retraction (cannot be changed|needs a reason)/i.test(updateError.message || '');
    return { ok: false, error: updateError.message, status: guard ? 409 : 500 };
  }

  // `before` carries the WHOLE prior row (handoff §5). A retraction that logged
  // only the id would tell a future reader that something was removed without
  // telling them what — which is the state this feature exists to prevent.
  await logChange({
    actor: actor.email,
    action: 'feedback_retracted',
    targetTable: 'bot_feedback',
    targetId: id,
    reason: v.value.reason,
    before: row,
    after: { retracted_at: retractedAt, retracted_by: actor.email },
  });

  return {
    ok: true,
    data: {
      id: Number(id),
      already_retracted: false,
      retracted_at: retractedAt,
      retracted_by: actor.email,
      context_id: row.context_id,
    },
  };
}

// ── POST /api/bot-feedback/dismiss ─────────────────────────────────
//
// "Nothing to review here" — a queue decision, never a verdict. It is stored
// for the whole team rather than per person: a message one reviewer has ruled
// needs no judgement should not reappear for the next one, or the queue never
// shrinks no matter how many people work it.
export async function dismissReview(actorEmail, body) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  if (!canDismiss(actor)) {
    return { ok: false, error: 'You do not have access to review bot messages.', status: 403 };
  }

  const v = validateDismissal(body || {});
  if (!v.ok) return { ok: false, error: v.error, field: v.field, status: 400 };
  const input = v.value;

  // An active dismissal already exists → return IT rather than erroring
  // (handoff §5). Two reviewers reaching the same conclusion a second apart is
  // agreement, not a conflict, and the unique index would otherwise 409 the
  // second one for doing the right thing.
  const existing = await findActiveDismissal(input);
  if (existing.error) return existing.error;
  if (existing.row) {
    return { ok: true, data: { ...existing.row, already_dismissed: true } };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('bot_review_dismissals')
    .insert({ ...input, dismissed_by: actor.email })
    .select('id, scope, context_id, ghl_contact_id, reason, dismissed_by, dismissed_at')
    .single();

  if (insertError) {
    if (isMissingRelation(insertError)) return { ok: false, error: NEEDS_INC2, status: 503 };
    // A race with another reviewer lands on the unique index. Re-read and hand
    // back their row: the outcome the caller wanted is now true either way.
    if (/duplicate key|unique constraint/i.test(insertError.message || '')) {
      const again = await findActiveDismissal(input);
      if (again.row) return { ok: true, data: { ...again.row, already_dismissed: true } };
    }
    console.error(`[BotFeedback] dismiss insert failed: ${insertError.message}`);
    return { ok: false, error: insertError.message, status: 500 };
  }

  await logChange({
    actor: actor.email,
    action: 'review_dismissed',
    targetTable: 'bot_review_dismissals',
    targetId: inserted.id,
    reason: input.reason,
    after: inserted,
  });

  return { ok: true, data: { ...inserted, already_dismissed: false } };
}

/** The live dismissal for this target, if there is one. */
async function findActiveDismissal(input) {
  let q = supabase
    .from('bot_review_dismissals')
    .select('id, scope, context_id, ghl_contact_id, reason, dismissed_by, dismissed_at')
    .eq('scope', input.scope)
    .is('undone_at', null);

  q = input.scope === 'message'
    ? q.eq('context_id', input.context_id)
    : q.eq('ghl_contact_id', input.ghl_contact_id);

  const { data, error } = await q.maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return { row: null, error: { ok: false, error: NEEDS_INC2, status: 503 } };
    return { row: null, error: { ok: false, error: error.message, status: 500 } };
  }
  return { row: data ?? null, error: null };
}

// ── POST /api/bot-feedback/dismiss/:id/undo ────────────────────────
//
// A wrong dismissal must never be a dead end — it hides a message from every
// reviewer, so it needs a way back that does not require the SQL editor.
export async function undoDismissal(actorEmail, id) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  if (!canUndoDismiss(actor)) {
    return { ok: false, error: 'Undoing a dismissal is for operators and admins.', status: 403 };
  }

  const { data: row, error } = await supabase
    .from('bot_review_dismissals')
    .select('id, scope, context_id, ghl_contact_id, reason, dismissed_by, dismissed_at, undone_at')
    .eq('id', id)
    .maybeSingle();

  if (error && isMissingRelation(error)) return { ok: false, error: NEEDS_INC2, status: 503 };
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!row) return { ok: false, error: 'That dismissal no longer exists.', status: 404 };
  if (row.undone_at) return { ok: true, data: { id: row.id, already_undone: true } };

  const undoneAt = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('bot_review_dismissals')
    .update({ undone_at: undoneAt, undone_by: actor.email })
    .eq('id', id);

  if (updateError) {
    console.error(`[BotFeedback] dismiss undo failed for ${id}: ${updateError.message}`);
    return { ok: false, error: updateError.message, status: 500 };
  }

  await logChange({
    actor: actor.email,
    action: 'review_dismiss_undone',
    targetTable: 'bot_review_dismissals',
    targetId: id,
    before: row,
    after: { undone_at: undoneAt, undone_by: actor.email },
  });

  return { ok: true, data: { id: Number(id), already_undone: false } };
}

// ── GET /api/bot-feedback/completed ────────────────────────────────
//
// Server-side pagination, 25 a page. The dashboard reads v_bot_reviews_completed
// directly for its own table; this endpoint exists so the same list is available
// to anything that is not the dashboard (a report, a check, Mark with curl)
// without handing out a Supabase key.
export const COMPLETED_PAGE_SIZE = 25;

export async function listCompleted(actorEmail, query = {}) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return { ok: false, error: who.error, status: 401 };
  const actor = who.actor;

  if (!canSubmitFeedback(actor)) {
    return { ok: false, error: 'You do not have access to review bot messages.', status: 403 };
  }

  // A team member may only see their own work; operators and admins may look at
  // anyone's. The DEFAULT for everyone is "me" — the tab is a record of what you
  // did, and a wall of someone else's reviews is not that.
  const wide = actor.role === 'operator' || actor.isAdmin === true;
  const askedFor = String(query.reviewer || '').trim();
  const reviewer = wide
    ? (askedFor && askedFor !== 'everyone' ? askedFor : (askedFor === 'everyone' ? null : actor.email))
    : actor.email;

  const page = Math.max(1, Number(query.page) || 1);
  const from = (page - 1) * COMPLETED_PAGE_SIZE;

  let q = supabase
    .from(query.retracted === true || query.retracted === 'true'
      ? 'v_bot_reviews_retracted'
      : 'v_bot_reviews_completed')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (reviewer) q = q.ilike('reviewer_email', reviewer);
  if (query.verdict && query.verdict !== 'all') q = q.eq('verdict', query.verdict);
  if (query.lane && query.lane !== 'all') q = q.eq('review_lane', query.lane);
  if (query.from) q = q.gte('created_at', query.from);
  if (query.to) q = q.lte('created_at', query.to);

  const { data, error, count } = await q.range(from, from + COMPLETED_PAGE_SIZE - 1);

  if (error) {
    if (isMissingRelation(error)) return { ok: false, error: NEEDS_INC2, status: 503 };
    return { ok: false, error: error.message, status: 500 };
  }

  return {
    ok: true,
    data: {
      rows: data ?? [],
      total: count ?? 0,
      page,
      page_size: COMPLETED_PAGE_SIZE,
      reviewer: reviewer ?? 'everyone',
    },
  };
}

export default {
  resolveActor, submitFeedback, undoFeedback, editFeedback, stopBot, calibrationNext,
  retractFeedback, dismissReview, undoDismissal, listCompleted,
};
