/**
 * Tag Handlers — src/actions/handlers/tags.js
 *
 * GHL contact tag mutation. Additive POST, never PUT (GHL overwrites on PUT).
 * Batch remove supported to avoid 429s on large removals (v3.2).
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

export async function executeAddTag(action) {
  const contactId = action.target_id;
  const tag = action.action_payload?.tag;
  if (!contactId || !tag) throw new Error('Missing contactId or tag');
  await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tag] });
  return { tag_applied: tag, contact_id: contactId };
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
