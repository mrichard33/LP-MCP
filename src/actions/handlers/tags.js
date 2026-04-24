/**
 * Tag Handlers — src/actions/handlers/tags.js
 *
 * GHL contact tag mutation. Additive POST, never PUT (GHL overwrites on PUT).
 * Batch remove supported to avoid 429s on large removals (v3.2).
 * Extracted from action-executor.js v4.2 refactor.
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
  const tags = payload.tags || (payload.tag ? [payload.tag] : []);
  if (!contactId || tags.length === 0) throw new Error('Missing contactId or tag/tags');
  await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags });
  if (tags.length === 1) {
    return { tag_removed: tags[0], contact_id: contactId };
  }
  console.log(`[ActionExecutor] ✅ Batch removed ${tags.length} tags from ${contactId}`);
  return { tags_removed: tags.length, tags, contact_id: contactId };
}
