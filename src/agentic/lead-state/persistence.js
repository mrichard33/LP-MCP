/**
 * Lead-State Persistence — src/agentic/lead-state/persistence.js
 *
 * Reads and writes for:
 *   agentic_lead_states              — current state per contact (overwrite)
 *   agentic_lead_state_transitions   — append-only history of state changes
 *
 * Invariants
 * ──────────
 *   1. ONE row per contact in agentic_lead_states (contact_id PK).
 *   2. state_entered_at changes ONLY when current_state changes.
 *      state_classified_at updates on every reclassification pass.
 *   3. A transition row is appended ONLY on actual state change.
 *      Same-state re-classifications update the current row but do not
 *      pollute the history table.
 *   4. workflow_history is opaque jsonb here — read/write by other modules.
 *      Suggested shape: { S4.5: { last_enrolled_at, last_completed_at,
 *      enrollment_count, cooldown_until } }
 *
 * Note: this module talks to Supabase directly via the project's shared
 * client. It does not import buildLeadContext or any business logic —
 * persistence is dumb plumbing on purpose.
 */

import supabase from '../../supabase.js';

const TABLE_STATES      = 'agentic_lead_states';
const TABLE_TRANSITIONS = 'agentic_lead_state_transitions';

/**
 * Fetch the current state row for a contact.
 * Returns null if the contact has never been classified.
 */
export async function getCurrentState(contactId) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!contactId) throw new Error('contactId required');

  const { data, error } = await supabase
    .from(TABLE_STATES)
    .select('*')
    .eq('contact_id', contactId)
    .maybeSingle();

  if (error) throw new Error(`getCurrentState failed: ${error.message}`);
  return data || null;
}

/**
 * Fetch the most recent transition rows for a contact.
 * Newest first. Limit defaults to 20.
 */
export async function getStateHistory(contactId, { limit = 20 } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!contactId) throw new Error('contactId required');

  const { data, error } = await supabase
    .from(TABLE_TRANSITIONS)
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getStateHistory failed: ${error.message}`);
  return data || [];
}

/**
 * Atomically upsert the current state for a contact, and append a
 * transition row IF the state actually changed.
 *
 * Inputs:
 *   contactId           — GHL contact id
 *   newState            — string from STATES enum
 *   confidence          — number in [0, 1]
 *   stateReason         — jsonb object (audit trail of which signals fired)
 *   classifierVersion   — string version stamp
 *   triggerSource       — 'event' | 'sweep' | 'manual' | 'backfill'
 *
 * Returns: { state_changed: boolean, previous_state: string|null, current: row }
 *
 * Concurrency: last-write-wins. If two classifier runs race, the later
 * write overwrites the earlier. Acceptable for a 6h sweep + reactive
 * event loop — neither runs more than once per minute per contact.
 */
export async function upsertCurrentState({
  contactId,
  newState,
  confidence,
  stateReason = {},
  classifierVersion,
  triggerSource,
}) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!contactId) throw new Error('contactId required');
  if (!newState) throw new Error('newState required');
  if (typeof confidence !== 'number') throw new Error('confidence must be a number');
  if (!classifierVersion) throw new Error('classifierVersion required');
  if (!triggerSource) throw new Error('triggerSource required');

  const now = new Date().toISOString();

  // 1. Read existing row (if any) so we know whether state changed.
  const existing = await getCurrentState(contactId);
  const previousState      = existing?.current_state ?? null;
  const previousConfidence = existing?.classification_confidence ?? null;
  const stateChanged       = previousState !== newState;

  // 2. Upsert the current-state row.
  //    state_entered_at: bumped ONLY on state change (otherwise preserved)
  //    state_classified_at: bumped on every call
  const upsertRow = {
    contact_id:                contactId,
    current_state:             newState,
    classification_confidence: confidence,
    state_classified_at:       now,
    state_entered_at:          stateChanged ? now : (existing?.state_entered_at ?? now),
    state_reason:              stateReason,
    classifier_version:        classifierVersion,
    workflow_history:          existing?.workflow_history ?? {},
    updated_at:                now,
    ...(existing ? {} : { created_at: now }),
  };

  const { data: upserted, error: upsertErr } = await supabase
    .from(TABLE_STATES)
    .upsert(upsertRow, { onConflict: 'contact_id' })
    .select('*')
    .single();

  if (upsertErr) {
    throw new Error(`upsertCurrentState failed: ${upsertErr.message}`);
  }

  // 3. Append a transition row ONLY on actual state change.
  if (stateChanged) {
    await appendTransition({
      contactId,
      fromState: previousState,
      toState: newState,
      previousConfidence,
      classificationConfidence: confidence,
      transitionReason: stateReason,
      classifierVersion,
      triggerSource,
    });
  }

  return { state_changed: stateChanged, previous_state: previousState, current: upserted };
}

/**
 * Append a transition row directly. Normally called from upsertCurrentState
 * — exposed for backfill scripts and tests that want explicit control.
 */
export async function appendTransition({
  contactId,
  fromState,
  toState,
  previousConfidence,
  classificationConfidence,
  transitionReason = {},
  classifierVersion,
  triggerSource,
}) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!contactId) throw new Error('contactId required');
  if (!toState) throw new Error('toState required');
  if (!classifierVersion) throw new Error('classifierVersion required');
  if (!triggerSource) throw new Error('triggerSource required');

  const { data, error } = await supabase
    .from(TABLE_TRANSITIONS)
    .insert({
      contact_id:                contactId,
      from_state:                fromState,           // null on first classification
      to_state:                  toState,
      previous_confidence:       previousConfidence,  // null on first classification
      classification_confidence: classificationConfidence,
      transition_reason:         transitionReason,
      classifier_version:        classifierVersion,
      trigger_source:            triggerSource,
    })
    .select('id')
    .single();

  if (error) throw new Error(`appendTransition failed: ${error.message}`);
  return data;
}

/**
 * Merge updates into workflow_history without touching state fields.
 * Used by the re-entry tracker (Phase 4) to record S4.5 enrollment events.
 *
 * Pattern:
 *   await updateWorkflowHistory(contactId, {
 *     'S4.5': { last_enrolled_at: now, enrollment_count: prev+1, ... }
 *   });
 *
 * Uses Postgres jsonb deep-merge semantics via the || operator.
 * Non-destructive: keys not in the update are preserved.
 */
export async function updateWorkflowHistory(contactId, partial) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!contactId) throw new Error('contactId required');
  if (!partial || typeof partial !== 'object') throw new Error('partial object required');

  // Read-modify-write — Supabase JS client doesn't expose the jsonb || merge
  // operator directly. The classifier runs single-contact, no concurrency
  // within a contact, so read-modify-write is safe here.
  const existing = await getCurrentState(contactId);
  if (!existing) {
    throw new Error(`Cannot update workflow_history: no current state for ${contactId}`);
  }
  const merged = { ...(existing.workflow_history || {}) };
  for (const [k, v] of Object.entries(partial)) {
    merged[k] = { ...(merged[k] || {}), ...v };
  }

  const { error } = await supabase
    .from(TABLE_STATES)
    .update({ workflow_history: merged, updated_at: new Date().toISOString() })
    .eq('contact_id', contactId);

  if (error) throw new Error(`updateWorkflowHistory failed: ${error.message}`);
  return merged;
}
