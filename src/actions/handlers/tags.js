/**
 * Tag Handlers — src/actions/handlers/tags.js
 *
 * GHL contact tag mutation. Additive POST, never PUT (GHL overwrites on PUT).
 * Batch remove supported to avoid 429s on large removals (v3.2).
 *
 * MVI v2.6 (2026-05-21) — Namespace immutability + source:* exclusivity.
 *   executeAddTag now enforces two complementary namespace policies:
 *
 *   IMMUTABLE namespaces (write-once-at-creation):
 *     entry:               (first-touch attribution; never overwritten)
 *
 *     When adding a tag in an immutable namespace, we GET the contact.
 *     If the contact already has ANY tag in that namespace, the add is
 *     a no-op — the existing attribution wins. Hygiene rules and
 *     re-entry paths can safely include an add_tag entry:{x} step
 *     without worrying about polluting first-touch attribution.
 *
 *   EXCLUSIVE namespaces (single-occupancy, latest-wins):
 *     p3:, loss-reason:, stage:, active-entry:, buyer:,
 *     objection-confirmed:, source:
 *
 *     When adding a tag in an exclusive namespace, we GET the contact,
 *     find any conflicting tags in that namespace, batch-DELETE them,
 *     then add. Latest write wins.
 *
 *   Failure modes (both checks):
 *     GET fails → log + skip the namespace logic, still add (don't
 *                 block on read errors). 15-min audit sweep catches
 *                 stragglers.
 *     DELETE fails → throws, action retries.
 *     POST fails → throws, action retries.
 *
 *   Architecture rationale: Namespace exclusivity used to be enforced
 *   per-rule via explicit remove_tag steps. That left every new rule
 *   (and every workflow, script, manual op) responsible for remembering
 *   to clean up conflicts. Multiple gaps accumulated over time
 *   (GHL_ATTR_ESTIMATE_CALCULATOR_ENTRY_BACKFILL on 2026-04-28 caused
 *   6 active-entry:* violations cleaned up 2026-05-21). Moving the
 *   policy into the executor makes it a system-level invariant that
 *   every add_tag caller inherits without remembering.
 *
 * MVI v2.5 (2026-05-04) — Namespace exclusivity at write-time.
 *   Original introduction of NAMESPACE_EXCLUSIVE_PREFIXES. See above
 *   for current contents.
 *
 * v4.3 — set_stage atomic stage tag swap (2026-04-28).
 *   New action type that fetches the contact's current tags, removes any
 *   conflicting stage:* tags in a single batch DELETE, then adds the new
 *   stage. Replaces the error-prone pattern of enumerating remove_tag
 *   actions per rule (e.g. GHL_APPT_STAGE_ADVANCE has 14 explicit removes).
 *
 *   Rules that adopt set_stage automatically pick up any future stage:*
 *   tag without rule edits. Closes the multi-stage tag pollution class
 *   discovered via state-consistency-audit (350 affected contacts).
 *
 * v4.3 — remove_tag prefix mode (2026-04-28).
 *   New `prefix` param fetches contact, filters tags by prefix, removes
 *   matched. Useful for any namespaced tag family (active-entry:*,
 *   lp-route:*, time-lapse:*) where the cardinality varies per contact.
 */

import { ghlFetch } from '../helpers.js';

// MVI v2.6 — namespaces that are write-once. The first tag added in
// the namespace wins permanently; any later add_tag in the same
// namespace is a no-op. Used for attribution that must not be
// overwritten by downstream ingestion paths.
const NAMESPACE_IMMUTABLE_PREFIXES = [
  'entry:',
];

// MVI v2.5/v2.6 — namespaces where only one tag per family should ever exist.
// Adding a tag from one of these auto-removes any other tag with the same
// prefix. Keep this list conservative — adding a namespace here is a
// behavior change for every rule that touches it.
const NAMESPACE_EXCLUSIVE_PREFIXES = [
  'p3:',
  'loss-reason:',
  'stage:',
  'active-entry:',
  'buyer:',
  'objection-confirmed:',
  'source:',          // MVI v2.6 — source:* mirrors active-entry:* (one current source per contact)
];

export async function executeAddTag(action) {
  const contactId = action.target_id;
  const tag = action.action_payload?.tag;
  if (!contactId || !tag) throw new Error('Missing contactId or tag');

  // MVI v2.6 — IMMUTABILITY CHECK FIRST.
  //
  // If the requested tag is in an immutable namespace and the contact
  // already has any tag in that namespace, skip the add entirely.
  // First-touch attribution wins; later writes are silently dropped.
  //
  // Best-effort: a GET failure logs but does NOT block the add
  // (consistent with exclusivity logic below). The 15-min audit sweep
  // catches anything that slipped through.
  const immutableNamespace = NAMESPACE_IMMUTABLE_PREFIXES.find((p) => tag.startsWith(p));
  if (immutableNamespace) {
    try {
      const contact = await ghlFetch('GET', `/contacts/${contactId}`);
      const currentTags = contact?.contact?.tags || contact?.tags || [];
      const existingInNamespace = currentTags.filter((t) => t.startsWith(immutableNamespace));
      if (existingInNamespace.length > 0) {
        console.log(
          `[ActionExecutor] immutable namespace: contact=${contactId} ns=${immutableNamespace} existing=[${existingInNamespace.join(',')}] — skipping add of ${tag}`
        );
        return {
          action: 'no_op',
          contact_id: contactId,
          tag_skipped: tag,
          namespace: immutableNamespace,
          immutable: true,
          existing_in_namespace: existingInNamespace,
          reason: 'immutable namespace already populated',
        };
      }
    } catch (err) {
      console.error(`[executeAddTag] immutability check failed for ${contactId} ns=${immutableNamespace}: ${err.message} — proceeding with add`);
    }
  }

  // MVI v2.5 — exclusivity. Best-effort: a GET failure logs
  // but does NOT block the add. Audit tool catches stragglers.
  const namespace = NAMESPACE_EXCLUSIVE_PREFIXES.find((p) => tag.startsWith(p));
  let removedConflicting = [];
  if (namespace) {
    try {
      const contact = await ghlFetch('GET', `/contacts/${contactId}`);
      const currentTags = contact?.contact?.tags || contact?.tags || [];
      removedConflicting = currentTags.filter((t) => t.startsWith(namespace) && t !== tag);
      if (removedConflicting.length > 0) {
        await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: removedConflicting });
        console.log(
          `[ActionExecutor] namespace exclusivity enforced: contact=${contactId} ns=${namespace} removed=[${removedConflicting.join(',')}] adding=${tag}`
        );
      }
    } catch (err) {
      console.error(`[executeAddTag] exclusivity check failed for ${contactId} ns=${namespace}: ${err.message} — proceeding with add`);
      removedConflicting = [];
    }
  }

  await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tag] });
  return {
    tag_applied: tag,
    contact_id: contactId,
    ...(namespace ? { namespace, removed_conflicting: removedConflicting } : {}),
  };
}

export async function executeRemoveTag(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  let tags = payload.tags || (payload.tag ? [payload.tag] : []);

  // v4.3 — prefix mode. Fetch contact, filter tags by prefix, merge with
  // any explicitly-listed tags. No-op if nothing matches.
  if (payload.prefix) {
    if (!contactId) throw new Error('Missing contactId');
    const contact = await ghlFetch('GET', `/contacts/${contactId}`);
    const currentTags = contact?.contact?.tags || contact?.tags || [];
    const matched = currentTags.filter(t => t.startsWith(payload.prefix));
    if (matched.length === 0 && tags.length === 0) {
      return {
        action: 'no_op',
        prefix: payload.prefix,
        contact_id: contactId,
        reason: 'no tags matched prefix',
      };
    }
    tags = [...new Set([...tags, ...matched])];
  }

  if (!contactId || tags.length === 0) throw new Error('Missing contactId or tag/tags/prefix');
  await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags });
  if (tags.length === 1) {
    return { tag_removed: tags[0], contact_id: contactId };
  }
  console.log(`[ActionExecutor] ✅ Batch removed ${tags.length} tags from ${contactId}${payload.prefix ? ` (prefix: ${payload.prefix})` : ''}`);
  return {
    tags_removed: tags.length,
    tags,
    contact_id: contactId,
    ...(payload.prefix ? { prefix: payload.prefix } : {}),
  };
}

/**
 * v4.3 — Atomic stage tag swap.
 *
 * Reads the contact's current tags, finds any stage:* tags that don't
 * match the target, removes them in a single batch DELETE, then adds the
 * new stage. Eliminates the need for rules to enumerate all 18+ possible
 * stage tags individually.
 *
 * Order: ADD first (idempotent — GHL coalesces duplicates), then DELETE.
 * Failure modes:
 *   - GET fails → throws, action retries via standard retry budget.
 *   - ADD fails → contact unchanged, action retries.
 *   - DELETE fails → contact has both new + old stages (multi-stage pollution),
 *     but action retries and DELETE eventually succeeds. Window is bounded
 *     by retry latency (seconds, not days), preferable to ADD-after-DELETE
 *     order which would leave the contact stage-less if ADD fails.
 *
 * Idempotency:
 *   - If contact already has new stage AND no conflicting stages, returns
 *     no_op without API calls (saves rate-limit budget on re-entries).
 *   - Tag write to GHL is idempotent on server side (POST same tag twice
 *     does not duplicate).
 */
export async function executeSetStage(action) {
  const contactId = action.target_id;
  const newStage = action.action_payload?.tag;
  if (!contactId || !newStage) throw new Error('Missing contactId or tag');
  if (!newStage.startsWith('stage:')) {
    throw new Error(`set_stage requires a stage:* tag, got "${newStage}"`);
  }

  // 1. Read current state
  const contact = await ghlFetch('GET', `/contacts/${contactId}`);
  const currentTags = contact?.contact?.tags || contact?.tags || [];
  const conflictingStages = currentTags.filter(t => t.startsWith('stage:') && t !== newStage);
  const alreadyHasNew = currentTags.includes(newStage);

  // Fast no-op path: nothing to do
  if (alreadyHasNew && conflictingStages.length === 0) {
    return {
      action: 'no_op',
      contact_id: contactId,
      stage: newStage,
      reason: 'contact already has only the requested stage',
    };
  }

  // 2. Add new stage first (preserves stage:* invariant if step 3 fails)
  if (!alreadyHasNew) {
    await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [newStage] });
  }

  // 3. Remove conflicting stages in a single batch DELETE
  if (conflictingStages.length > 0) {
    await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: conflictingStages });
  }

  console.log(`[ActionExecutor] ✅ set_stage(${contactId}) → ${newStage} (removed ${conflictingStages.length} conflicting: ${conflictingStages.join(', ') || 'none'})`);

  return {
    action: 'stage_set',
    contact_id: contactId,
    new_stage: newStage,
    new_stage_was_already_present: alreadyHasNew,
    removed_stages: conflictingStages,
    removed_count: conflictingStages.length,
  };
}
