/**
 * Lead-Selection Enrollment — src/agentic/lead-selection/enroll.js
 *
 * Gated enrollment of the top-N ranked candidates into S1.3 Stale Lead
 * Revival. Mirrors enrollment.js (enrollIfEligible): confidence floor +
 * cooldown + skip-if-action idempotency + shadow-vs-live. NEVER writes to GHL
 * directly — it enqueues an add_to_workflow agent_action the executor performs.
 *
 * Enrollment route — Route A (GHL API), not Route B:
 *   S1.3 (32fa691b-…) is a published inbound_webhook workflow but is NOT in
 *   ghl_workflow_webhooks (no stored webhook URL). The executor
 *   (workflows.js executeAddToWorkflow) selects Route A when no webhook_url is
 *   present: POST /contacts/{id}/workflow/{workflow_id} via the GHL API, which
 *   works for any trigger type. So the action carries workflow_id +
 *   canonical_code and deliberately NO webhook_url.
 *   NOTE: Route A firing an inbound_webhook workflow is unproven — the seed
 *   test (10–25 contacts, flag on) must confirm the contact VISIBLY enters
 *   S1.3 and receives message #1 before any scale. If it does not, switch to
 *   the workflow's real inbound webhook URL (Route B).
 *
 * Ships dark: S1_REENGAGEMENT_ENABLED defaults false → shadow (would-enroll,
 * writes nothing). When live, actions default to requires_approval=true for
 * the first runs (S1_REENGAGEMENT_REQUIRE_APPROVAL).
 *
 * v1.0 — 2026-06-15.
 */

import supabase from '../../supabase.js';
import { AUTO_EXECUTE_THRESHOLD } from '../lead-state/confidence.js';
import { getCurrentState, updateWorkflowHistory } from '../lead-state/persistence.js';

// ── Config (env-overridable) ────────────────────────────────────────
const ENROLLMENT_ENABLED = process.env.S1_REENGAGEMENT_ENABLED === 'true'; // default OFF → shadow
const REQUIRE_APPROVAL   = process.env.S1_REENGAGEMENT_REQUIRE_APPROVAL !== 'false'; // default TRUE
const MIN_CONFIDENCE     = Number(process.env.S1_REENGAGEMENT_MIN_CONFIDENCE || AUTO_EXECUTE_THRESHOLD);
const COOLDOWN_DAYS      = Number(process.env.S1_3_COOLDOWN_DAYS || 90);
const DEFAULT_ENROLL_LIMIT = Number(process.env.S1_REENGAGEMENT_ENROLL_LIMIT || 25);

// S1.3 identity (verified live: published, trigger inbound_webhook).
const S1_3_WORKFLOW_ID  = process.env.S1_3_WORKFLOW_ID || '32fa691b-2422-4727-83c9-1174801974e9';
const S1_3_CANONICAL    = 'S1.3 Stale Lead Revival';
const RULE_APPLIED      = 'S1_3_REENGAGEMENT_ENROLLMENT';

let running = false;

/** Cooldown remaining (ms) from workflow_history['S1.3'].cooldown_until, or 0. */
function cooldownRemainingMs(stateRow) {
  const until = stateRow?.workflow_history?.['S1.3']?.cooldown_until;
  if (!until) return 0;
  const t = new Date(until).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - Date.now());
}

/**
 * Enroll the top-N enrollable, not-yet-enrolled candidates into S1.3.
 * @returns per-run summary mirroring enroll-existing-eligible.js.
 */
export async function enrollTopN({ limit = DEFAULT_ENROLL_LIMIT, dryRun = false } = {}) {
  if (running) return { success: true, skipped: true, reason: 'already_running' };
  running = true;
  const startedAt = Date.now();

  try {
    // 1. Top-N candidates by rank (enrollable, not already stamped enrolled).
    const { data: cands, error } = await supabase
      .from('agentic_reengagement_candidates')
      .select('contact_id, rank, score, segment, temperature, target_offer_rung')
      .eq('enrollable', true)
      .eq('enrolled', false)
      .order('rank', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`candidate read failed: ${error.message}`);
    const candidates = cands || [];
    const ids = candidates.map(c => c.contact_id);

    // 2. skip-if-action idempotency (one IN query).
    const alreadyEnqueued = new Set();
    if (ids.length) {
      const { data: actions, error: aErr } = await supabase
        .from('agent_actions')
        .select('target_id')
        .eq('rule_applied', RULE_APPLIED)
        .in('target_id', ids);
      if (aErr) throw new Error(`skip-if-action scan failed: ${aErr.message}`);
      for (const a of actions || []) alreadyEnqueued.add(a.target_id);
    }

    const outcomes = {};
    let enrolled = 0, shadow = 0, skipped = 0, errors = 0;
    const detail = [];
    const errorSample = [];

    for (const c of candidates) {
      const contactId = c.contact_id;
      try {
        // Idempotency: already has an S1.3 enrollment action.
        if (alreadyEnqueued.has(contactId)) {
          outcomes['already_enqueued'] = (outcomes['already_enqueued'] || 0) + 1;
          skipped++;
          continue;
        }

        // Re-validate confidence + cooldown from the authoritative state row.
        const stateRow = await getCurrentState(contactId).catch(() => null);
        const confidence = stateRow?.classification_confidence;
        if (typeof confidence === 'number' && confidence < MIN_CONFIDENCE) {
          outcomes['below_confidence'] = (outcomes['below_confidence'] || 0) + 1;
          skipped++;
          continue;
        }
        const cd = cooldownRemainingMs(stateRow);
        if (cd > 0) {
          outcomes['in_cooldown'] = (outcomes['in_cooldown'] || 0) + 1;
          skipped++;
          continue;
        }

        // SHADOW — log + tally, write nothing.
        if (!ENROLLMENT_ENABLED || dryRun) {
          outcomes['shadow_would_enroll'] = (outcomes['shadow_would_enroll'] || 0) + 1;
          shadow++;
          detail.push({ contact_id: contactId, rank: c.rank, segment: c.segment, outcome: 'shadow_would_enroll' });
          continue;
        }

        // LIVE — enqueue Route A add_to_workflow.
        const { data: ins, error: insErr } = await supabase
          .from('agent_actions')
          .insert({
            action_type: 'add_to_workflow',
            target_system: 'ghl',
            target_entity: 'contact',
            target_id: String(contactId),
            action_payload: {
              workflow_id: S1_3_WORKFLOW_ID,   // Route A — no webhook_url ⇒ GHL API enrollment
              canonical_code: 'S1.3',
              canonical_name: S1_3_CANONICAL,
              payload: {
                contact_id: String(contactId),
                enrollment_source: 'lead_selection_engine',
                segment: c.segment,
                temperature: c.temperature,
                target_offer_rung: c.target_offer_rung,
                score: c.score,
              },
            },
            reasoning: `S1.3 re-engagement enrollment from lead-selection engine — rank ${c.rank}, ${c.segment} (Route A)`,
            rule_applied: RULE_APPLIED,
            status: 'pending',
            requires_approval: REQUIRE_APPROVAL,
            priority: 20,
          })
          .select('id')
          .single();
        if (insErr) {
          outcomes['enqueue_failed'] = (outcomes['enqueue_failed'] || 0) + 1;
          errors++;
          if (errorSample.length < 10) errorSample.push({ contact_id: contactId, error: insErr.message.slice(0, 200) });
          continue;
        }
        const actionId = ins?.id || null;

        // Stamp the candidate row + write cooldown (best-effort, non-fatal).
        await supabase
          .from('agentic_reengagement_candidates')
          .update({ enrolled: true, enrollment_action_id: actionId != null ? String(actionId) : null })
          .eq('contact_id', contactId);
        try {
          const cooldownUntil = new Date(Date.now() + COOLDOWN_DAYS * 86400000).toISOString();
          const prev = stateRow?.workflow_history?.['S1.3']?.enrollment_count || 0;
          await updateWorkflowHistory(contactId, {
            'S1.3': {
              last_enrolled_at: new Date().toISOString(),
              enrollment_count: prev + 1,
              cooldown_until: cooldownUntil,
              enrollment_action_id: actionId,
            },
          });
        } catch (whErr) {
          console.warn(`[LeadSelectionEnroll] workflow_history update failed for ${contactId}: ${whErr.message}`);
        }

        outcomes['enqueued'] = (outcomes['enqueued'] || 0) + 1;
        enrolled++;
        detail.push({ contact_id: contactId, rank: c.rank, segment: c.segment, outcome: 'enqueued', action_id: actionId });
      } catch (err) {
        errors++;
        if (errorSample.length < 10) errorSample.push({ contact_id: contactId, error: (err.message || 'unknown').slice(0, 200) });
      }
    }

    const elapsed_ms = Date.now() - startedAt;
    const summary = {
      success: true,
      mode: 'enroll',
      dry_run: dryRun,
      candidates: candidates.length,
      enrolled, shadow, skipped, errors,
      outcomes,
      detail,
      error_sample: errorSample,
      config: enrollConfig(),
      elapsed_ms,
    };
    console.log(
      `[LeadSelectionEnroll] done: ${enrolled} enrolled, ${shadow} shadow, ${skipped} skipped, ${errors} errors ` +
      `of ${candidates.length} (dry_run=${dryRun}, enabled=${ENROLLMENT_ENABLED}, ${elapsed_ms}ms)`
    );
    return summary;
  } finally {
    running = false;
  }
}

/** Exposed for diagnostics / report. */
export function enrollConfig() {
  return {
    enabled: ENROLLMENT_ENABLED,
    require_approval: REQUIRE_APPROVAL,
    min_confidence: MIN_CONFIDENCE,
    cooldown_days: COOLDOWN_DAYS,
    enroll_limit: DEFAULT_ENROLL_LIMIT,
    workflow_id: S1_3_WORKFLOW_ID,
    rule_applied: RULE_APPLIED,
    route: 'A',
  };
}
