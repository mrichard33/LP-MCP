/**
 * Classify Bucket Handler — src/actions/handlers/classify-bucket.js
 *
 * Phase 1 #56 — Intake/Routing Layer bucket → workflow resolver.
 *
 * Reads the contact's most recent contact_risk_scores row and resolves
 * the bucket assignment (A/B/C from #54) into a concrete target
 * workflow_id for downstream enrollment. Emits a bucket.classified
 * event so rules can react.
 *
 * BUCKET → WORKFLOW MAPPING (LOCKED canonical IDs, 2026-05-13)
 * ────────────────────────────────────────────────────────────
 *   A (warm)       → S4.5 Agentic Seinfeld           f99fba97-6d2f-4fd6-966c-b5e5e36f8938
 *   B (cold_valid) → S1.2 Calculator Re-engagement   bf894396-1cd9-4095-8789-7ce12a4e412a
 *   C (dangerous)  → quarantine (tag only, no workflow target)
 *
 *   Naming note: contact_risk_scores has a CHECK constraint allowing only
 *   'warm' / 'cold_valid' / 'dangerous' / 'unknown'. Earlier drafts used
 *   'warm_dormant' / 'dangerous_dead' — aligned to the constraint 2026-05-13.
 *
 * THROTTLE KEYS
 * ─────────────
 *   A → 'resurrection:s4_5'
 *   B → 'resurrection:s1_2'
 *   C → 'resurrection:quarantine'
 *
 * RETURNS (execution_result)
 *   {
 *     bucket:                'A'|'B'|'C',
 *     classification:        'warm'|'cold_valid'|'dangerous',
 *     score:                 0-100,
 *     target_workflow_id:    string|null,  // null for Bucket C
 *     throttle_key:          string,
 *     action_recommendation: 'enroll'|'quarantine',
 *     score_age_hours:       number,
 *     contact_id, computed_at
 *   }
 */

import supabase from '../../supabase.js';

// LOCKED canonical workflow IDs (2026-05-13)
const DEFAULT_WORKFLOW_MAP = {
  A: 'f99fba97-6d2f-4fd6-966c-b5e5e36f8938', // S4.5 Agentic Seinfeld
  B: 'bf894396-1cd9-4095-8789-7ce12a4e412a', // S1.2 Calculator Re-engagement
  C: null,                                   // Bucket C: tag-only quarantine
};

const DEFAULT_THROTTLE_KEY = {
  A: 'resurrection:s4_5',
  B: 'resurrection:s1_2',
  C: 'resurrection:quarantine',
};

// Constraint-aligned values per contact_risk_scores_classification_check
const CLASSIFICATION_TO_BUCKET = {
  warm:       'A',
  cold_valid: 'B',
  dangerous:  'C',
  // 'unknown' is allowed by the constraint but isn't a bucket assignment;
  // throw rather than guess so caller knows the score is invalid.
};

async function emitClassifiedEvent({ contactId, bucket, score, classification, targetWorkflowId, throttleKey, phaseMarker }) {
  try {
    await supabase.from('system_events').insert({
      event_type: 'bucket.classified',
      event_subtype: bucket.toLowerCase(),
      source: 'agent_executor',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        bucket,
        classification,
        score,
        target_workflow_id: targetWorkflowId,
        throttle_key: throttleKey,
        phase_marker: phaseMarker || null,
      },
      priority: bucket === 'A' ? 'high' : 'normal',
      event_timestamp: new Date().toISOString(),
      processed: false,
    });
  } catch (err) {
    console.warn(`[classify-bucket] event emit failed: ${err.message}`);
  }
}

export async function executeClassifyBucket(action) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId');

  const params = action.action_payload || {};
  const requireFresh = params.require_fresh_score !== false;
  const emitEvent = params.emit_event !== false;
  const workflowMap = { ...DEFAULT_WORKFLOW_MAP, ...(params.workflow_map || {}) };
  const phaseMarker = params.phase_marker || null;

  const { data: scoreRow, error: readErr } = await supabase
    .from('contact_risk_scores')
    .select('score, classification, components, computed_at, expires_at')
    .eq('ghl_contact_id', contactId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (readErr) {
    throw new Error(`classify-bucket read failed for ${contactId}: ${readErr.message}`);
  }
  if (!scoreRow) {
    throw new Error(
      `classify-bucket: no contact_risk_scores row for ${contactId}. Run compute_risk_score first.`
    );
  }

  const now = Date.now();
  const computedMs = new Date(scoreRow.computed_at).getTime();
  const expiresMs = scoreRow.expires_at ? new Date(scoreRow.expires_at).getTime() : null;
  const expired = expiresMs != null && expiresMs < now;
  const scoreAgeHours = (now - computedMs) / 3600000;

  if (expired && requireFresh) {
    throw new Error(
      `classify-bucket: score for ${contactId} expired at ${scoreRow.expires_at}. Re-run compute_risk_score.`
    );
  }

  const classification = scoreRow.classification;
  const bucket = CLASSIFICATION_TO_BUCKET[classification];
  if (!bucket) {
    throw new Error(
      `classify-bucket: unmapped classification '${classification}' for ${contactId}. ` +
      `Expected one of: ${Object.keys(CLASSIFICATION_TO_BUCKET).join(', ')}`
    );
  }

  const targetWorkflowId = workflowMap[bucket];
  const throttleKey = DEFAULT_THROTTLE_KEY[bucket];
  const actionRecommendation = bucket === 'C' ? 'quarantine' : 'enroll';

  if (emitEvent) {
    await emitClassifiedEvent({
      contactId,
      bucket,
      score: scoreRow.score,
      classification,
      targetWorkflowId,
      throttleKey,
      phaseMarker,
    });
  }

  console.log(
    `[classify-bucket] ${contactId} → bucket ${bucket} (${classification}, score ${scoreRow.score}) ` +
    `→ workflow ${targetWorkflowId || '[quarantine]'} | throttle_key=${throttleKey}`
  );

  return {
    bucket,
    classification,
    score: scoreRow.score,
    target_workflow_id: targetWorkflowId,
    throttle_key: throttleKey,
    action_recommendation: actionRecommendation,
    score_age_hours: Number(scoreAgeHours.toFixed(2)),
    expired,
    computed_at: scoreRow.computed_at,
    contact_id: contactId,
    _context: {
      bucket_target_workflow_id: targetWorkflowId,
      bucket_throttle_key: throttleKey,
      bucket_classification: classification,
      bucket_letter: bucket,
    },
  };
}
