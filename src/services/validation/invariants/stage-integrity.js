/**
 * Stage Integrity Invariants — src/services/validation/invariants/stage-integrity.js
 *
 * Category: STAGE_INTEGRITY
 * Framework: Lead Routing Doctrine — Stage Architecture Invariant.
 *
 * Core principle: A contact has exactly ONE stage tag, exactly ONE active
 * entry source, and exactly ONE active instance of any given workflow at
 * all times. These tag invariants are how we know the contact's state is
 * coherent — without them, routing decisions fork non-deterministically.
 *
 * Doctrine reference: docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md §
 * "Category 2 — STAGE_INTEGRITY".
 *
 * Note: the add_tag handler at src/actions/handlers/tags.js already
 * enforces namespace exclusivity at write-time for stage:, active-entry:,
 * buyer:, p3:, loss-reason:, and objection-confirmed:. These invariants
 * are a SECOND layer that catches violations the handler can't see:
 *   - Batch ordering errors (one action adds, sibling adds a conflict
 *     before the handler's exclusivity check fires)
 *   - Direct enrollments in active-{prefix}* state that bypass handler swap
 *   - Cross-action invariant breakage (n8n PUT-style mass tag wipes
 *     reaching the executor as add_tag chains)
 *
 * Each check returns { passed, reason?, context_snapshot? }.
 * Fail-open on infra errors.
 */

import supabase from '../../../supabase.js';

// ─── Shared helpers ────────────────────────────────────────────────────

async function loadContactTags(contactId) {
  if (!supabase || !contactId) return null;
  try {
    const { data, error } = await supabase
      .from('contact_tag_snapshot')
      .select('tags')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (error || !data || !Array.isArray(data.tags)) return null;
    return new Set(data.tags.map((t) => String(t).toLowerCase()));
  } catch (e) {
    console.error(`[avg:stage-integrity] tag snapshot load error: ${e.message}`);
    return null;
  }
}

function tagsWithPrefix(tagSet, prefix) {
  if (!tagSet) return [];
  return [...tagSet].filter((t) => t.startsWith(prefix.toLowerCase()));
}

/**
 * Generate the set of "active workflow" tag candidates for a given canonical
 * code. Both the current functional-prefix convention AND the legacy W-prefix
 * convention are checked because the 2026-05 rename was ID-stable but the
 * workflows' internal "add tag" steps were updated piecemeal — production
 * snapshot still shows legacy active-w5.2 (10 contacts) alongside new
 * active-s5.2 (4 contacts) for the same workflow.
 *
 * For canonical_code "S5.2" this returns:
 *   - active-s5.2          ← NEW convention (post-rename, post-update)
 *   - active-w-s5.2        ← legacy with dash + prefix kept
 *   - active-ws5.2         ← legacy with prefix kept, no dash
 *   - active-w5.2          ← legacy with prefix letter stripped (MOST COMMON
 *                            in production for S-family workflows)
 *
 * For canonical_code "E.4" this returns:
 *   - active-e.4           ← NEW convention
 *   - active-w-e.4         ← legacy variants
 *   - active-we.4
 *   - active-w.4           ← legacy with prefix letter stripped
 *
 * Deduplication is handled by the caller via Set membership check against
 * the contact's tag snapshot. Extra candidates that aren't on the contact
 * are harmless.
 */
function activeWorkflowTagCandidates(canonicalCode) {
  const codeLower = String(canonicalCode || '').toLowerCase();
  if (!codeLower) return [];

  // Strip the leading prefix letter (s, e, o, f, l, a, b, c, i, u, etc.)
  // to derive the legacy W-form. Handles both "s5.2" → "5.2" and "e.4" → ".4".
  const withoutPrefix = codeLower.replace(/^[a-z]/, '');

  // Use a Set to dedupe naturally — for canonical codes where the prefix
  // letter and W happen to coincide (none currently), or where the strip
  // yields the same result, we don't double-up the array.
  const candidates = new Set([
    `active-${codeLower}`,         // NEW: active-s5.2, active-e.4, active-o.0
    `active-w-${codeLower}`,       // legacy w-dash-prefix: active-w-s5.2
    `active-w${codeLower}`,        // legacy w-noprefix: active-ws5.2
    `active-w${withoutPrefix}`,    // legacy w-stripped: active-w5.2, active-w.4
  ]);

  return [...candidates];
}

// ═══════════════════════════════════════════════════════════════════════
// SI-1 — one_active_stage_tag (WARN in v2)
// ═══════════════════════════════════════════════════════════════════════
//
// Action that would add a stage:* tag — verify either (a) the batch
// removes existing stage:* tags first, or (b) the contact has no other
// stage:* tag currently.
//
// Why: Multiple stage:* tags create non-deterministic routing because
// downstream rules can match on either. Doctrine: exactly ONE stage tag
// at all times.
//
// Note: set_stage handler does atomic swap. This invariant exists for
// add_tag actions that bypass set_stage (legacy rules, manual queues).
//
// Shipping as WARN in v2 because set_stage covers most cases and we want
// to observe surface area before blocking.

export async function checkOneActiveStageTag(action, ctx = {}) {
  // Only applies to add_tag where tag starts with stage:
  if (action.action_type !== 'add_tag') return { passed: true, reason: 'not_applicable' };

  const newTag = String(action.action_payload?.tag || '').toLowerCase();
  if (!newTag.startsWith('stage:')) return { passed: true, reason: 'not_a_stage_tag' };

  const contactId = action.target_id;
  if (!contactId) return { passed: true, reason: 'no_contact_id_open' };

  const tags = await loadContactTags(contactId);
  if (tags === null) return { passed: true, reason: 'infra_error_open' };

  const existingStages = tagsWithPrefix(tags, 'stage:').filter((t) => t !== newTag);
  if (existingStages.length === 0) {
    return { passed: true, reason: 'no_existing_stage_tag' };
  }

  // Check if the batch context includes removals of those conflicting stages.
  // batchPriorTagsRemoved is populated by validation-gate.js from completed
  // remove_tag actions earlier in the same batch.
  const batchRemoved = ctx.batchPriorTagsRemoved || new Set();
  const stillConflicting = existingStages.filter((t) => !batchRemoved.has(t));

  if (stillConflicting.length === 0) {
    return { passed: true, reason: 'batch_removed_conflicts' };
  }

  return {
    passed: false,
    reason:
      `Adding ${newTag} would create multi-stage state. Contact currently has ` +
      `[${stillConflicting.join(', ')}] and the batch does not remove them first. ` +
      `Doctrine: a contact has exactly one stage:* tag at all times. Use set_stage ` +
      `for atomic swap, or queue remove_tag actions with sequence_order before this add_tag.`,
    context_snapshot: {
      adding: newTag,
      existing_stages: existingStages,
      batch_removed_in_session: [...batchRemoved],
      still_conflicting: stillConflicting,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SI-2 — entry_source_atomic_swap (BLOCK)
// ═══════════════════════════════════════════════════════════════════════
//
// Action that would add active-entry:* tag — verify the batch first
// removes any existing active-entry:* tags. The contact must never have
// more than one active-entry:* at a time.
//
// Why: Julius Yarush post-mortem. n8n PUT wiped his entry tags wholesale.
// All routing decisions check active-entry:*. Multiple active entries =
// contact reachable by multiple source workflows = duplicate sends.
//
// Note: add_tag's namespace exclusivity handles single-action case. SI-2
// catches the batch-ordering case (two adds in same batch, second
// add's GET sees first's add not yet committed).

export async function checkEntrySourceAtomicSwap(action, ctx = {}) {
  if (action.action_type !== 'add_tag') return { passed: true, reason: 'not_applicable' };

  const newTag = String(action.action_payload?.tag || '').toLowerCase();
  if (!newTag.startsWith('active-entry:')) return { passed: true, reason: 'not_an_active_entry_tag' };

  const contactId = action.target_id;
  if (!contactId) return { passed: true, reason: 'no_contact_id_open' };

  const tags = await loadContactTags(contactId);
  if (tags === null) return { passed: true, reason: 'infra_error_open' };

  const existingEntries = tagsWithPrefix(tags, 'active-entry:').filter((t) => t !== newTag);
  if (existingEntries.length === 0) {
    return { passed: true, reason: 'no_existing_active_entry' };
  }

  // Batch-aware: the add_tag handler will namespace-clear, but if a sibling
  // action in this batch is ALSO trying to add a different active-entry:*,
  // we have a race condition. Detect by inspecting batchPriorTagsAdded.
  const batchAdded = ctx.batchPriorTagsAdded || new Set();
  const siblingActiveEntries = [...batchAdded].filter(
    (t) => t.startsWith('active-entry:') && t !== newTag
  );

  // If batch already added a different active-entry:* upstream, this is a
  // contradiction within the same batch.
  if (siblingActiveEntries.length > 0) {
    return {
      passed: false,
      reason:
        `Batch contradiction: a sibling action in this batch already added ` +
        `[${siblingActiveEntries.join(', ')}] and now this action wants to add ${newTag}. ` +
        `Only one active-entry:* may exist at a time per Lead Routing Doctrine. ` +
        `Fix the rule that queued both adds.`,
      context_snapshot: {
        adding: newTag,
        existing_in_contact: existingEntries,
        sibling_adds_in_batch: siblingActiveEntries,
        batch_id: action.batch_id,
      },
    };
  }

  // If the contact has multiple existing active-entry:* tags AND none
  // are being removed in this batch, the contact is already broken — flag
  // it but pass (the add_tag handler will resolve via namespace exclusivity).
  if (existingEntries.length > 1) {
    return {
      passed: true,
      reason: 'multiple_existing_entries_handler_will_resolve',
      context_snapshot: { existing_entries: existingEntries },
    };
  }

  // Single existing active-entry:*, single add → handler exclusivity will
  // do the swap. Pass.
  return {
    passed: true,
    reason: 'handler_will_swap',
    context_snapshot: { existing: existingEntries, adding: newTag },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SI-3 — no_duplicate_workflow_enrollment (BLOCK)
// ═══════════════════════════════════════════════════════════════════════
//
// Action add_to_workflow for canonical code X — verify the contact does
// NOT already have an active-workflow tag indicating they are mid-flight
// in that workflow (unless the batch removes it first).
//
// Why: Karen Reliford post-mortem. Enrolled in S2.5 twice within a 10.5h
// window because the agentic re-enrollment didn't drop her active-* tag.
// Workflow's own "check if started" gate silently let her through twice.
//
// TAG CONVENTION (2026-05-19 corrected): The current naming convention
// after the W→functional-prefix rename uses the canonical code directly:
//
//   S5.2 Appointment Rescue  →  active-s5.2
//   E.4 Canvassing Bridge    →  active-e.4
//   O.0 Objection Handler    →  active-o.0
//   F.0 Post-Appt Follow-Up  →  active-f.0
//
// Legacy W-prefix tags still exist in production on contacts enrolled
// before the workflows' internal "add tag" steps were updated. Production
// snapshot (queried 2026-05-19) shows active-w5.2 on 10 contacts alongside
// active-s5.2 on 4 contacts — same workflow, two tag generations live
// simultaneously. SI-3 must check BOTH conventions or it silently allows
// duplicate enrollment for the majority of mid-flight S-family contacts.
//
// activeWorkflowTagCandidates() enumerates all four variants.

export async function checkNoDuplicateWorkflowEnrollment(action, ctx = {}) {
  if (action.action_type !== 'add_to_workflow') {
    return { passed: true, reason: 'not_applicable' };
  }

  const canonicalCode = action.action_payload?.canonical_code;
  if (!canonicalCode) {
    // Cannot validate without a canonical code. Legacy workflow_id-only
    // enrollments pass — they predate the registry.
    return { passed: true, reason: 'no_canonical_code_open' };
  }

  const contactId = action.target_id;
  if (!contactId) return { passed: true, reason: 'no_contact_id_open' };

  const tags = await loadContactTags(contactId);
  if (tags === null) return { passed: true, reason: 'infra_error_open' };

  const candidates = activeWorkflowTagCandidates(canonicalCode);
  const found = candidates.filter((c) => tags.has(c));
  if (found.length === 0) {
    return { passed: true, reason: 'not_currently_active' };
  }

  // Check if the batch removes the conflicting active-* tag first.
  const batchRemoved = ctx.batchPriorTagsRemoved || new Set();
  const stillActive = found.filter((t) => !batchRemoved.has(t));
  if (stillActive.length === 0) {
    return { passed: true, reason: 'batch_removed_active_tag' };
  }

  return {
    passed: false,
    reason:
      `Contact already has active-workflow tag(s) [${stillActive.join(', ')}] indicating ` +
      `they are currently enrolled in ${canonicalCode}. Re-enrolling without first ` +
      `removing the active-* tag duplicates messaging (Karen Reliford incident). ` +
      `Queue remove_tag for the active-* before this add_to_workflow, or use ` +
      `remove_from_workflow as a sibling action with lower sequence_order. Note: ` +
      `both new (active-${canonicalCode.toLowerCase()}) and legacy ` +
      `(active-w${canonicalCode.toLowerCase().replace(/^[a-z]/, '')}) tag forms are ` +
      `checked because workflows are mid-migration from W-prefix to functional prefix.`,
    context_snapshot: {
      canonical_code: canonicalCode,
      checked_candidates: candidates,
      currently_active_tags: stillActive,
      batch_removed_in_session: [...batchRemoved].filter((t) => t.startsWith('active-')),
    },
  };
}

// Exported for unit tests
export const __testing = {
  loadContactTags,
  tagsWithPrefix,
  activeWorkflowTagCandidates,
};
