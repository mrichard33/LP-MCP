/**
 * Enroll-Existing-Eligible — src/agentic/lead-state/enroll-existing-eligible.js
 *
 * One-time MIGRATION pass. Closes the gap created by change-detected sweep
 * selection (sweep.js v0.2.0): contacts that were classified into an
 * ELIGIBLE_S45_STATE during pre-go-live CLASSIFY-ONLY passes (the dormant
 * backfills) were never run through the enrollment gate. The live sweep will
 * NOT re-select them — their lp_leads.synced_at hasn't advanced past their
 * last classification and they're inside the stale re-floor — so without a
 * one-time pass they sit eligible-but-never-enrolled forever.
 *
 * What it does:
 *   1. Reads agentic_lead_states for contacts currently in an eligible
 *      S45_* state (the canonical source of truth — does NOT re-classify).
 *   2. Skips any contact that already has an S45_STATE_ENROLLMENT action
 *      (belt-and-suspenders on top of the enrollment gate's own cooldown +
 *      active-objection checks — avoids duplicate enrollment).
 *   3. Runs enrollIfEligible() with the EXISTING state + confidence. The
 *      gate re-validates everything (eligible / confidence ≥ 0.75 / no open
 *      objection row / no cooldown / shadow-vs-live) before enqueuing.
 *
 * It does NOT re-derive states (no LLM/context cost) and does NOT touch the
 * change-detection logic — it's a targeted backfill of the enrollment side
 * effect for an already-correct state population.
 *
 * Idempotent: re-running enrolls nobody new once everyone eligible has an
 * action (skip-if-action) + cooldown both fire. Safe to run repeatedly.
 *
 * Route: POST /admin/lead-state/enroll-existing  { limit?, dry_run? }
 *   dry_run:true  → report what WOULD enroll without calling the gate's
 *                   live enqueue (still subject to S45_ENROLLMENT_ENABLED;
 *                   if that's off the gate itself returns shadow anyway).
 *
 * v0.1.0 — 2026-06-03. Migration helper for the v0.2.0 change-detection cutover.
 */

import supabase from '../../supabase.js';
import { enrollIfEligible, enrollmentConfig } from './enrollment.js';
import { ELIGIBLE_S45_STATES } from './states.js';

const DEFAULT_LIMIT = Number(process.env.ENROLL_EXISTING_LIMIT || 200);

let running = false;

/**
 * Select contacts currently in an eligible S45_* state that have NO prior
 * S45_STATE_ENROLLMENT action. Returns the rows needed to call the gate.
 */
async function selectEligibleUnenrolled(limit) {
  // 1. All contacts in an eligible state.
  const { data: states, error } = await supabase
    .from('agentic_lead_states')
    .select('contact_id, current_state, classification_confidence, classifier_version, state_reason')
    .in('current_state', ELIGIBLE_S45_STATES)
    .order('state_classified_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`eligible-state scan failed: ${error.message}`);
  if (!states || states.length === 0) return [];

  // 2. Which of them already have an enrollment action? One IN query.
  const ids = states.map(s => s.contact_id);
  const { data: actions, error: aErr } = await supabase
    .from('agent_actions')
    .select('target_id')
    .eq('rule_applied', 'S45_STATE_ENROLLMENT')
    .in('target_id', ids);
  if (aErr) throw new Error(`enrollment-action scan failed: ${aErr.message}`);
  const alreadyEnrolled = new Set((actions || []).map(a => a.target_id));

  return states.filter(s => !alreadyEnrolled.has(s.contact_id));
}

export async function runEnrollExistingEligible({ limit = DEFAULT_LIMIT, dryRun = false } = {}) {
  if (running) return { success: true, skipped: true, reason: 'already_running' };
  running = true;
  const startedAt = Date.now();

  try {
    const candidates = await selectEligibleUnenrolled(limit);

    const outcomes = {};
    let enrolled = 0, shadow = 0, skipped = 0, errors = 0;
    const detail = [];
    const errorSample = [];

    for (const c of candidates) {
      try {
        if (dryRun) {
          outcomes['dry_run_would_attempt'] = (outcomes['dry_run_would_attempt'] || 0) + 1;
          detail.push({ contact_id: c.contact_id, state: c.current_state, confidence: c.classification_confidence, outcome: 'dry_run_would_attempt' });
          continue;
        }
        const r = await enrollIfEligible({
          contactId: c.contact_id,
          state: c.current_state,
          confidence: c.classification_confidence,
          classifierVersion: c.classifier_version,
          stateReason: c.state_reason,
        });
        outcomes[r.reason] = (outcomes[r.reason] || 0) + 1;
        if (r.enrolled) enrolled++;
        else if (r.shadow) shadow++;
        else skipped++;
        detail.push({ contact_id: c.contact_id, state: c.current_state, confidence: c.classification_confidence, outcome: r.reason, enrolled: !!r.enrolled, action_id: r.enrollment_action_id || null });
      } catch (err) {
        errors++;
        if (errorSample.length < 10) errorSample.push({ contact_id: c.contact_id, error: (err.message || 'unknown').slice(0, 200) });
      }
    }

    const elapsed_ms = Date.now() - startedAt;
    const summary = {
      success: true,
      dry_run: dryRun,
      candidates: candidates.length,
      enrolled, shadow, skipped, errors,
      outcomes,
      detail,
      error_sample: errorSample,
      enrollment_config: enrollmentConfig(),
      elapsed_ms,
    };
    console.log(
      `[EnrollExisting] done: ${enrolled} enrolled, ${shadow} shadow, ${skipped} skipped, ${errors} errors ` +
      `of ${candidates.length} eligible-unenrolled (dry_run=${dryRun}, ${elapsed_ms}ms)`
    );
    return summary;
  } finally {
    running = false;
  }
}

export function registerEnrollExistingEligibleRoutes(app) {
  // POST /admin/lead-state/enroll-existing  { limit?, dry_run? }
  app.post('/admin/lead-state/enroll-existing', async (req, res) => {
    try {
      const limit = parseInt(req.body?.limit, 10) || DEFAULT_LIMIT;
      const dryRun = req.body?.dry_run === true;
      const result = await runEnrollExistingEligible({ limit, dryRun });
      res.json(result);
    } catch (err) {
      console.error('[EnrollExisting] route error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[EnrollExisting] Registered: POST /admin/lead-state/enroll-existing');
}
