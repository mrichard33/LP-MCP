/**
 * LP job status transitions — src/services/job-status-change.js
 *
 * ONE question: did this job's status just CHANGE, and what event says so?
 *
 * WHY THIS EXISTS
 * ---------------
 * LP job STATUS changes reached nothing. Milestones have fired
 * `lp.milestone_completed` ~1,200×/week since v7.1 and the P2_MILESTONE_* rules
 * move opportunities on them, but a job going 'Awaiting Product' → 'Cancelled'
 * emitted no event at all — there was no `lp.job_status_changed` anywhere in the
 * repo and no such event_type in system_events. So a cancellation in LP never
 * reached GHL, and the opportunity stayed open forever.
 *
 * Measured 2026-09-18: 241 of a 249-job sample of DEAD LP jobs still sat open in
 * P2. scripts/reconcile-p2-stages.js repairs that backlog once; this closes the
 * ongoing gap so it does not refill.
 *
 * PURE AND DEPENDENCY-FREE, like the alert modules. The decision is unit-testable
 * without a database, and src/sync-children.js — which has no deps seam — owns
 * the read, the write and the emit.
 *
 * ─── EMIT ONLY ON AN ACTUAL CHANGE ──────────────────────────────────────────
 * The job-changes sweep re-delivers the same jobs every pass (131 of them, every
 * pass, before the v7.5 skip gate). Emitting per sync rather than per change
 * would file ~160 no-op events a day into the Decision Engine, and an engine that
 * re-evaluates a terminal rule on a status that did not move is one approval
 * queue away from doing the same write twice.
 *
 * ─── A JOB WE HAVE NEVER SEEN IS NOT A TRANSITION ───────────────────────────
 * `existing === null` means either a brand-new job or a read that failed, and the
 * two are indistinguishable from here (supabase-js resolves with { error } and
 * `data: null`). Both answer "no event": a new job has no prior status to have
 * moved from, and a failed read is the `active: null` case from CLAUDE.md's
 * alerting doctrine — could not tell, so touch nothing. Announcing a transition
 * from a status we failed to read would invent the `old_status` that the whole
 * event exists to carry.
 */

/** Trim to a comparable string. Anything non-string is "no status". */
const asStatus = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Did the job's status change? Pure — no I/O, no clock.
 *
 * @param {object|null} existing  the stored lp_jobs row, as read BEFORE the upsert
 * @param {object} incoming       the row about to be upserted
 * @returns {{old_status: string, new_status: string}|null}
 */
export function detectJobStatusChange(existing, incoming) {
  // No prior row: a new job, or a read that failed. Neither is a transition.
  if (!existing) return null;
  const oldStatus = asStatus(existing.job_status);
  const newStatus = asStatus(incoming?.job_status);
  // A payload that carries no status cannot assert that one changed. LP sends
  // partial job shapes (see src/lp-job-fields.js) and a blank must never be
  // reported as a move to nothing.
  if (newStatus === '') return null;
  // An unchanged status is the overwhelmingly common case — return first.
  if (oldStatus === newStatus) return null;
  return { old_status: oldStatus, new_status: newStatus };
}

/**
 * The emitEvent options for a detected transition. Pure.
 *
 * `event_subtype` is the NEW status, so a rule can gate on it with
 * `event_subtype_in` (src/decision-engine.js) without reading the payload — the
 * same shape lp.disposition_changed uses, and the reason the P2_JOB_TERMINAL_*
 * rules need no I/O-backed condition to decide.
 *
 * `old_status` is carried because the stories differ: 'Awaiting Product' →
 * 'Cancelled' is a job that died mid-production; 'New' → 'Cancelled' is one that
 * never started. A rule cannot tell them apart from the new status alone, and
 * neither can anyone reading the table later.
 *
 * The transition also goes into the first-class previous_state / new_state
 * columns, which exist for exactly this and cost nothing.
 *
 * ─── EMITTED EVEN WITH NO GHL CONTACT ───────────────────────────────────────
 * A status change is a true record whether or not the job's lead is linked yet.
 * The engine already handles the unlinked case correctly: a GHL-targeted action
 * on an event with no ghl_contact_id is recorded `skipped`, never executed
 * (src/decision-engine.js). Gating the EMITTER on the contact would instead lose
 * the record, and emitEvent's own emit-time binding may resolve the link from
 * lp_leads anyway — which is why lp_lead_id is always passed.
 *
 * @returns {object} options for emitEvent()
 */
export function buildJobStatusEvent({
  change, lpJobId, lpLeadId, ghlContactId = null, jobValue = null, branchCode = null, now = new Date(),
}) {
  const jobId = String(lpJobId);
  return {
    event_type: 'lp.job_status_changed',
    event_subtype: change.new_status,
    source: 'lp_sync',
    entity_type: 'job',
    entity_id: jobId,
    ghl_contact_id: ghlContactId || null,
    lp_lead_id: lpLeadId == null ? null : String(lpLeadId),
    payload: {
      lp_job_id: jobId,
      lp_lead_id: lpLeadId == null ? null : String(lpLeadId),
      ghl_contact_id: ghlContactId || null,
      old_status: change.old_status,
      new_status: change.new_status,
      job_value: jobValue,
      branch_code: branchCode,
    },
    previous_state: { job_status: change.old_status },
    new_state: { job_status: change.new_status },
    priority: 'normal',
    // Scoped to the transition AND the day. The upsert lands before the emit, so
    // a repeat within one pass is already impossible; this guards a same-day
    // retry after a partial failure without blocking a genuine re-transition
    // (Cancelled → reinstated → Cancelled again) on a later day.
    idempotency_key: `job_status_${jobId}_${change.old_status}_${change.new_status}_${now.toISOString().slice(0, 10)}`,
  };
}

/**
 * What emitEvent actually did. It returns { filtered: true } or null WITHOUT
 * throwing, so "it did not throw" is not "it was recorded" — that conflation is
 * how 27 appointment-parity escalations reached nobody for months. Mirrors
 * classifyEmit in src/jobs/appointment-parity-watchdog.js.
 *
 * @returns {'emitted'|'dropped_at_intake'|'emit_noop'}
 */
export function classifyJobStatusEmit(res) {
  if (res && res.filtered === true) return 'dropped_at_intake';
  if (res && res.id) return 'emitted';
  return 'emit_noop';
}
