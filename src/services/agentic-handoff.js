/**
 * Agentic Handoff Teardown — src/services/agentic-handoff.js
 *
 * `agentic-active` is the canonical ownership marker for a contact that the
 * agentic conversation flow owns. The only rule that removes it
 * (AGENTIC_HANDOFF_ENDED) fires solely on the `agentic.handoff_ended` event
 * (the GHL pause-bot tag-removal workflow). Terminal closeouts that happen
 * inside the decision engine (e.g. the Layer-3 `suppress` not-interested
 * closeout, GHL_APPT_CANCELLED_REBOOK_COLD) never emit that event, so they
 * leave `agentic-active` orphaned — the contact looks like the bot still owns
 * the conversation after it has been closed out.
 *
 * endAgenticHandoff tears the tag down DIRECTLY (silent). It deliberately does
 * NOT emit `agentic.handoff_ended`, because that path also pings GroupMe via the
 * pause-bot flow and would spam the sales board on every closeout.
 *
 * Scope note: this is tag-removal only. Cancelling the contact's pending
 * agent_actions is intentionally deferred — a blanket
 * `WHERE target_id=contactId AND status='pending'` races across the
 * concurrently-running executor batches (runPool) and could cancel a sibling
 * closeout's still-pending actions mid-flight. Tag removal is idempotent and
 * safe to run concurrently.
 */

import { removeGHLTags } from '../ghl.js';

const AGENTIC_ACTIVE_TAG = 'agentic-active';

export async function endAgenticHandoff(contactId) {
  if (!contactId) return { ended: false, reason: 'missing_contact' };
  try {
    await removeGHLTags(contactId, [AGENTIC_ACTIVE_TAG]);
    console.log(`[agentic-handoff] endAgenticHandoff: removed ${AGENTIC_ACTIVE_TAG} from ${contactId}`);
    return { ended: true, contact_id: contactId, removed_tag: AGENTIC_ACTIVE_TAG };
  } catch (err) {
    console.warn(`[agentic-handoff] endAgenticHandoff failed for ${contactId}: ${err.message}`);
    return { ended: false, contact_id: contactId, error: err.message };
  }
}
