/**
 * Approval Path — src/actions/approval-path.js
 *
 * The GroupMe approval pipeline — isolated so future tuning of pre-gen,
 * trigger-message resolution, or head-of-line behavior stays a small,
 * focused edit. Extracted from action-executor.js v4.2 refactor.
 *
 * v4.10 (2026-05-04) — sequence_order race fix for booking companions.
 *   PROBLEM: Under v4.6 (companion insertion), book_appointment and
 *   reschedule_appointment were always inserted with
 *     sequence_order: parentSeq - 1
 *   so they ran BEFORE send_message in Phase 2 of the executor. When
 *   book_appointment fired first, the GHL calendar write attached the
 *   appointment to the calendar owner (a different GHL user than the
 *   contact's assigned_to). The agentic-send GHL workflow that
 *   send_message hits resolves its outbound "From" against the contact's
 *   live state, so by the time the SMS fired ~1.5s later, the From hopped
 *   from the assigned-user's number to the calendar-owner's number
 *   mid-thread.
 *
 *   Symptom (contact 7jl9cVfry8OyQF6oI2V5, 2026-05-04 18:45 UTC):
 *     - Earlier SMS in the same conversation went out from 9542808890
 *       (assigned user, no booking yet)
 *     - Auto-book on "Wednesday works" inserted book_appointment with
 *       seq=-1; Phase 2 ran book first (18:45:18), then send_message
 *       (18:45:20)
 *     - The confirmation SMS landed from 9543710083 — a different
 *       GHL number with userId 3K6HtoPyBLWeQrrnSnCD (the MV calendar's
 *       owner)
 *     - On the lead's phone, the booking confirmation appeared in a
 *       brand-new SMS thread instead of the existing 8890 thread,
 *       making the conversation look like the bot stopped replying
 *
 *   FIX: Differentiate sequence_order by companion type at insert time.
 *     - book_appointment      → parentSeq + 2  (run AFTER send_message
 *                                                + add_tag, so the SMS
 *                                                fires on pre-booking
 *                                                contact state)
 *     - reschedule_appointment → parentSeq + 2 (same — the new booking
 *                                                also re-points calendar
 *                                                owner)
 *     - cancel_appointment    → parentSeq - 1  (UNCHANGED — keep before
 *                                                send_message so the
 *                                                verbal "I've taken X
 *                                                off the calendar" is
 *                                                truthful by the time
 *                                                it lands)
 *
 *   Trade-off for book/reschedule: the verbal "I have you down for
 *   Wednesday May 6 at 10 AM" lands ~500ms BEFORE the GHL calendar
 *   write completes. This is below human perception and the lead does
 *   not see a calendar-side discrepancy. The thread-continuity win is
 *   worth the trivial truthfulness window.
 *
 *   No other behavior change. Pairs with response-generator v2.7.9
 *   which updates the PATH B / reschedule PATH B verbal templates.
 *
 * v4.9 (2026-04-30) — COMPANION_AUTO_EXECUTE expanded for cancel/reschedule.
 *   Pairs with response-generator v2.7.8's cancellation flow, which can
 *   now emit two new companion types:
 *     - cancel_appointment      (lead pushed back on reschedule offer)
 *     - reschedule_appointment  (lead picked a new time; combined op:
 *                                cancels old + books new in one handler call)
 *
 *   Both join book_appointment in the auto-execute allowlist. Same trust
 *   argument applies: the AI emits these only when validateResponse has
 *   confirmed the appointment_id (cancel) or both old_appointment_id +
 *   new_start_time (reschedule), AND the AI's prompt requires explicit
 *   conversation evidence (turn-2 pushback for cancel, turn-3 hard
 *   confirm of a proposed reschedule slot for reschedule). Past-date
 *   guards still apply for reschedule.
 *
 *   Why auto-execute the cancel matters: with the auto-reply env var on,
 *   the verbal-confirm SMS ("I've taken Tuesday May 5 off the calendar")
 *   fires immediately. If the cancel itself were approval-gated, the
 *   lead would be told the appointment is cancelled while it's still
 *   active on the calendar — a lie. Auto-executing the cancel makes the
 *   SMS truthful by the time it lands.
 *
 *   Same applies to reschedule: the verbal "moved you to Saturday at 2 PM"
 *   only matches reality if both the cancel and the new booking have
 *   succeeded by the time the SMS goes out. Phase 2 picks up auto-
 *   execute companions on the SAME heartbeat as the SMS, so latency is
 *   minimal (typically <500ms gap). The reschedule handler enforces
 *   cancel-before-book ordering server-side.
 *
 *   No other behavior change in this version. The four auto-reply gates
 *   from v4.8 still apply unchanged for the verbal-confirm SMS itself.
 *
 * v4.8 (2026-04-30) — AGENTIC AUTO-REPLY (env-gated, tag-verified).
 *   Mark's ask: turn on full auto-reply for the agentic responder. When
 *   AGENTIC_AUTOREPLY_ENABLED=true AND the contact still carries the
 *   required tag (default 'pause-bot') AND the action came from an
 *   allowlisted rule (default AGENTIC_RESPOND_POST_CHATBOT), the batch's
 *   send_message + add_tag actions auto-execute via Phase 2 instead of
 *   waiting for a human approval card.
 *
 *   Four gates — ALL AND-ed; failing any one falls back to the v4.6/v4.7
 *   approval-card path:
 *     G1. env var AGENTIC_AUTOREPLY_ENABLED === 'true' (master kill switch)
 *     G2. action.rule_applied is in AGENTIC_AUTOREPLY_RULES allowlist
 *     G3. pre-generation succeeded (no short-circuit, no error)
 *     G4. contact has AGENTIC_AUTOREPLY_REQUIRED_TAG (default 'pause-bot'),
 *         verified LIVE from the GHL contact GET endpoint at execution
 *         time — NOT from cache. Tags can change between rule fire and
 *         approval-path execution, and we want the safety belt on the
 *         actual current state.
 *
 *   What flips: every action in the batch with status='pending_approval'
 *   and requires_approval=true gets flipped to status='pending',
 *   requires_approval=false. Phase 2 of the executor on the SAME
 *   heartbeat picks them up. The book_appointment companion (already
 *   auto-executing per v4.7) is unaffected — it stays on its own path.
 *
 *   What does NOT flip:
 *   - v4.5 inline-handoff batches (short-circuit) — they bypass auto-
 *     reply entirely; the handoff is the action.
 *   - Batches where pre-gen errored — they still get an approval card so
 *     the human can see the error and intervene.
 *   - Batches where ANY of G1-G4 fails — same fallback to the card.
 *
 *   Visibility: instead of an approval card, GroupMe gets a
 *   "🚀 AGENTIC AUTO-REPLY (no approval needed)" info notice with the
 *   sent message, reasoning, intent class, any companion booking, and
 *   any tags applied. Mark can audit what fired but cannot edit/reject
 *   (the message is already out). The action audit trail captures the
 *   full payload for retrospection and v2.7.4 in-context learning.
 *
 *   Trade-off: with auto-reply on, the "Edit X" / approve-reject cycle
 *   is unavailable for batches that pass the gates. The system trusts
 *   the AI's output for the allowlisted rule + tag combination. Tighten
 *   or loosen by editing AGENTIC_AUTOREPLY_RULES or flipping the env
 *   var off at any time without redeploy (Railway picks up env changes
 *   on the next heartbeat).
 *
 *   Tuning knobs (env vars):
 *     AGENTIC_AUTOREPLY_ENABLED       — 'true' | 'false' (default: false)
 *     AGENTIC_AUTOREPLY_RULES         — comma-separated rule keys
 *                                       (default: AGENTIC_RESPOND_POST_CHATBOT)
 *     AGENTIC_AUTOREPLY_REQUIRED_TAG  — single tag string
 *                                       (default: pause-bot)
 *
 * v4.7 (2026-04-30) — AUTO-EXECUTE book_appointment companion actions.
 *   Mark's ask: when the AI emits companion_action: book_appointment, the
 *   booking should fire IMMEDIATELY without waiting for GroupMe approval.
 *   The verbal-confirmation send_message in the same batch still goes
 *   through approval (still want a human eye on outbound copy until the
 *   responder is widely trusted), but the actual GHL Calendar write
 *   doesn't waste an approval cycle.
 *
 *   Why this is safe to auto-execute:
 *   1. response-generator.js v2.7.6 only emits a companion_action when
 *      the lead has hard-confirmed a SPECIFIC time previously offered by
 *      the bot — not on a vague "yes" or "ok"
 *   2. validateResponse already drops companions with past dates, missing
 *      fields, malformed start_time, or unknown calendar_name (v1.8 fix)
 *   3. The booking action's idempotency is handled by GHL — duplicate
 *      bookings on the same calendar/contact/start_time are rejected
 *   4. If the booking does fail (rate limit, slot conflict), the failure
 *      surfaces on the action row and Mark sees it in the action audit.
 *      The verbal-confirm SMS is still gated on his approval, so he can
 *      reject the SMS if he sees a failed book_appointment in the card.
 *
 *   Implementation: a single COMPANION_AUTO_EXECUTE allowlist controls
 *   which companion types skip approval. v4.9 expands this to include
 *   cancel_appointment and reschedule_appointment.
 *
 *   Card behavior: the auto-executing companion is NOT pushed into the
 *   batch's `actions` array (the card aggregator only displays
 *   approval-gated rows), but the companion details are still surfaced
 *   via enrichment.companionAction so the card can render an "AUTO-BOOK
 *   QUEUED" line. groupme.js can read that field and display it however
 *   it wants. (If groupme.js ignores it, no harm — the booking still
 *   fires; the card just doesn't mention it.)
 *
 *   Phase 2 of the executor picks the auto-execute companion up on the
 *   very next cycle — the same heartbeat that processed Phase 1
 *   (approval queue) above. Typical lag: <500ms.
 *
 * v4.6 (2026-04-29) — COMPANION_ACTION INSERTION (auto-book on hard confirm).
 *   Pairs with response-generator.js v2.7.6 which can now emit a top-level
 *   companion_action field. When the pre-generation result includes
 *   companion_action, this approval-path inserts a sibling agent_action
 *   into the same batch_id BEFORE sending the GroupMe approval card. The
 *   card therefore shows BOTH the verbal confirmation send_message AND
 *   the auto-book — Mark approves once, both fire together. (NOTE:
 *   superseded by v4.7+ for action types in COMPANION_AUTO_EXECUTE.)
 *
 *   The approval card aggregator already iterates the full batch's
 *   actions, so adding this row before sendApprovalRequest is enough —
 *   no card-format changes needed in groupme.js.
 *
 *   If the companion_action insert fails (DB error), we log a warning
 *   and continue with the original verbal-confirm-only flow. Better to
 *   have a verbal confirmation without an auto-book than to block the
 *   whole batch.
 *
 * v4.5 (2026-04-28) — APPLY HANDOFF INLINE ON SHORT-CIRCUIT.
 *   PROBLEM: Under v4.4 the pre-gen short-circuit branch left the action
 *   queued and shipped an approval card that had NO message preview line
 *   (because makeShortCircuitResult sets message:null). Mark would see a
 *   blank approval card asking for review of a non-decision.
 *
 *   FIX: When pre-gen returns short_circuit:true, apply the handoff
 *   IMMEDIATELY at queue time:
 *     1. POST the handoff tag (and suppress-automation if disqualifier)
 *        to the GHL contact
 *     2. Mark every action in the batch as completed with a structured
 *        execution_result describing the handoff
 *     3. Send a 🛑 AGENTIC SHORT-CIRCUIT notice to GroupMe (informational,
 *        not an approval card)
 *     4. Skip sendApprovalRequest entirely for this batch
 *
 *   Surfaced 2026-04-28 by Mark with contact 15Z6TaUK4WHBK1R4H64S asking
 *   "Can someone call me now?" — gate fired CALLBACK, blank approval
 *   card landed in GroupMe.
 *
 * v4.4 (2026-04-28) — Two safety fixes for AGENTIC_* approvals:
 *   1. NULL-SAFE PREVIEW LOG (the `generated.message.slice(0,80)` log
 *      crashed when message:null due to a short-circuit).
 *   2. SHORT-CIRCUIT PASS-THROUGH (don't overwrite payload with null;
 *      let runtime regenerate). Superseded by v4.5 inline handoff above.
 *
 * v4.3 (2026-04-24) — Pre-generation searches the whole batch for the
 * send_message action instead of checking only actions[0].
 *
 * v4.2 — Pre-filter active tracking records to prevent head-of-line block.
 *
 * Paired with sql/008_approval_queue_ttl.sql (48h auto-expiry).
 */

import supabase from '../supabase.js';
import { sendApprovalRequest, sendGroupMeMessage } from '../groupme.js';
import { resolveContactInfo, resolveLPProspectId, getEventContext } from './resolvers.js';
import { buildNotificationEnrichment } from './enrichment.js';
import { acquireToken, report429 } from '../ghl-rate-limiter.js';
import { bumpContactCache } from '../context-builder.js';
// 2026-07-08 — CALLBACK resolution parity with send-message-handler's
// handleShortCircuit (PR #499). The pre-generation short-circuit path here
// is TERMINAL (batch marked completed, never re-enters executeSendMessage),
// so without this the dead placeholder tag hdl:callback-pending-
// classification would still be applied for requires_approval rules.
// callback-resolver.js is import-safe from this module (no circular dep).
import {
  resolveCallbackHandoff,
  CUSTOMER_STATUS_PENDING_TAG,
  CUSTOMER_STATUS_GATE_INTENT_SET,
  CALLBACK_TAG_SALES,
} from '../knowledge/callback-resolver.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';

// ═══════════════════════════════════════════════════════════════════
// v4.8: AGENTIC AUTO-REPLY GATING (env-gated, tag-verified)
// ═══════════════════════════════════════════════════════════════════
//
// Master kill switch. Set to 'true' (string, case-insensitive) to enable
// auto-reply for batches that pass all four gates. Default 'false' so
// upgrades to this code do NOT change observable behavior unless the
// operator explicitly opts in.
const AGENTIC_AUTOREPLY_ENABLED = String(
  process.env.AGENTIC_AUTOREPLY_ENABLED || 'false'
).toLowerCase() === 'true';

// Allowlist of rule keys whose batches are eligible for auto-reply.
// Comma-separated. Default: just AGENTIC_RESPOND_POST_CHATBOT (the rule
// that fires on ai.analysis_completed for pause-bot-tagged contacts).
// Add more rule keys here as the system matures and other agentic rules
// earn full-trust status.
const AGENTIC_AUTOREPLY_RULES = (
  process.env.AGENTIC_AUTOREPLY_RULES || 'AGENTIC_RESPOND_POST_CHATBOT'
).split(',').map(s => s.trim()).filter(Boolean);

// The contact tag that MUST be present at execution time for auto-reply
// to fire. Default 'pause-bot' — the tag that signals "the chatbot has
// stepped aside; the agentic responder is in charge". If a human or
// another workflow has removed this tag between rule fire and approval-
// path execution, auto-reply gracefully falls back to the approval card.
const AGENTIC_AUTOREPLY_REQUIRED_TAG = (
  process.env.AGENTIC_AUTOREPLY_REQUIRED_TAG || 'pause-bot'
).trim();

// Log effective config at startup so it shows in Railway logs after each
// deploy. Helps confirm the env vars are actually applied.
console.log(`[ApprovalPath] v4.10 auto-reply config: ` +
  `enabled=${AGENTIC_AUTOREPLY_ENABLED}, ` +
  `rules=[${AGENTIC_AUTOREPLY_RULES.join(',')}], ` +
  `required_tag="${AGENTIC_AUTOREPLY_REQUIRED_TAG}"`);

// ═══════════════════════════════════════════════════════════════════
// v4.9: COMPANION AUTO-EXECUTE ALLOWLIST
// ═══════════════════════════════════════════════════════════════════
//
// Companion action types that SKIP approval and auto-execute via Phase 2
// of the executor. These fire immediately when the AI emits them so the
// verbal-confirm SMS in the same batch lands on a state that matches
// what we just told the lead.
//
//   book_appointment        — v4.7. AI emits only on hard-confirmation
//                              of a previously-proposed time. Past-date
//                              + missing-field guards in validateResponse.
//   cancel_appointment      — v4.9. AI emits only on turn-2 pushback
//                              after offering reschedule. Requires
//                              appointment_id from EXISTING APPOINTMENTS
//                              context block (validateResponse drops
//                              companions with no appointment_id).
//   reschedule_appointment  — v4.9. AI emits only on hard-confirmation
//                              of a proposed reschedule slot. Requires
//                              old_appointment_id + new_start_time;
//                              past-date guard on new_start_time.
//                              Handler enforces cancel-before-book ordering.
//   update_appointment_status — 2026-06-03 (book-then-capture). AI emits
//                              only to upgrade an EXISTING in-home
//                              appointment 'new'→'confirmed' after the lead
//                              answers the decision-maker question. Requires
//                              appointment_id from EXISTING APPOINTMENTS
//                              (validateResponse drops it otherwise), and the
//                              handler applies the same DM backstop as
//                              book_appointment (never 'confirmed' without
//                              Yes/Solo Owner). Must auto-execute so the
//                              upgrade lands in seconds (same heartbeat as
//                              the "you're confirmed" SMS), not on the sweep.
//
// Trust argument is the same across all four: the AI emits the companion
// only under verifiable, narrow conditions, AND validateResponse screens
// for shape errors. If any guard trips, the companion is dropped before
// it reaches this code, so anything that arrives here is safe to fire.
//
// Add a type only when the same trust argument applies.
const COMPANION_AUTO_EXECUTE = new Set([
  'book_appointment',
  'cancel_appointment',
  'reschedule_appointment',
  'update_appointment_status',
]);

// ═══════════════════════════════════════════════════════════════════
// v4.5: INLINE HANDOFF HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * POST tags to a contact using the additive endpoint. Mirrors the helper
 * in send-message-handler.js so we don't need a circular import. Returns
 * true on success, false on failure (logged).
 */
async function applyContactTagsInline(contactId, tagList) {
  if (!contactId || !Array.isArray(tagList) || tagList.length === 0) return false;
  if (!GHL_API_KEY) return false;
  const filtered = tagList.filter(t => typeof t === 'string' && t.length > 0);
  if (filtered.length === 0) return false;

  try {
    await acquireToken();
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ tags: filtered }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      report429();
      console.warn(`[ApprovalPath] applyContactTagsInline 429 for ${contactId}`);
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[ApprovalPath] applyContactTagsInline ${res.status}: ${text.slice(0, 150)}`);
      return false;
    }
    bumpContactCache(contactId);
    return true;
  } catch (err) {
    console.warn(`[ApprovalPath] applyContactTagsInline threw: ${err.message}`);
    return false;
  }
}

/**
 * 2026-07-08 — Remove tags from a contact. DELETE mirror of
 * applyContactTagsInline (same rationale: no circular import on
 * send-message-handler's removeContactTags). Returns true on success,
 * false on any failure (never throws).
 */
async function removeContactTagsInline(contactId, tagList) {
  if (!contactId || !Array.isArray(tagList) || tagList.length === 0) return false;
  if (!GHL_API_KEY) return false;
  const filtered = tagList.filter(t => typeof t === 'string' && t.length > 0);
  if (filtered.length === 0) return false;

  try {
    await acquireToken();
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ tags: filtered }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      report429();
      console.warn(`[ApprovalPath] removeContactTagsInline 429 for ${contactId}`);
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[ApprovalPath] removeContactTagsInline ${res.status}: ${text.slice(0, 150)}`);
      return false;
    }
    bumpContactCache(contactId);
    return true;
  } catch (err) {
    console.warn(`[ApprovalPath] removeContactTagsInline threw: ${err.message}`);
    return false;
  }
}

/**
 * v4.8 — Live tag fetch for the auto-reply gate. We deliberately do NOT
 * trust any cached tag snapshot for this decision: tags change between
 * rule fire and approval-path execution (e.g. a human pulls 'pause-bot'
 * to take the conversation back), and the safety belt MUST reflect
 * current state.
 *
 * Returns:
 *   - Array of tag strings on success (possibly empty)
 *   - null on any error (caller treats as "ineligible" → falls back to
 *     the approval card)
 */
async function fetchContactTagsLive(contactId) {
  if (!contactId || !GHL_API_KEY) return null;
  try {
    await acquireToken();
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) {
      report429();
      console.warn(`[ApprovalPath] fetchContactTagsLive 429 for ${contactId}`);
      return null;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[ApprovalPath] fetchContactTagsLive ${res.status} for ${contactId}: ${text.slice(0, 150)}`);
      return null;
    }
    const data = await res.json();
    // GHL v2 response shape: { contact: { tags: [...] } }. Some endpoints
    // return tags at the root. Accept either, default to empty array if
    // the field is missing entirely.
    const tags = data?.contact?.tags ?? data?.tags;
    if (!Array.isArray(tags)) {
      console.warn(`[ApprovalPath] fetchContactTagsLive ${contactId}: tags not array (got: ${typeof tags})`);
      return [];
    }
    return tags;
  } catch (err) {
    console.warn(`[ApprovalPath] fetchContactTagsLive threw for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * v4.8 — Evaluate the four gates for auto-reply on a single batch.
 * Called AFTER pre-generation succeeds (so G3 implicit). G4 fires the
 * live GHL contact GET only when G1+G2 pass — no wasted API calls when
 * the env var is off.
 *
 * Returns { eligible: boolean, reason: string, tags: string[] | null }.
 * `reason` is logged verbatim so each batch's gate decision is auditable.
 */
async function evaluateAutoReplyEligibility(sendAction) {
  // G1: master kill switch
  if (!AGENTIC_AUTOREPLY_ENABLED) {
    return { eligible: false, reason: 'env_disabled', tags: null };
  }
  // G2: rule allowlist
  const ruleApplied = sendAction.rule_applied || null;
  if (!ruleApplied || !AGENTIC_AUTOREPLY_RULES.includes(ruleApplied)) {
    return {
      eligible: false,
      reason: `rule_not_in_allowlist:${ruleApplied || 'none'}`,
      tags: null,
    };
  }
  // G4: live tag verification (G3 is implicit — we only get here if pre-gen
  // succeeded; the caller handles the short-circuit and error branches).
  const tags = await fetchContactTagsLive(sendAction.target_id);
  if (tags === null) {
    return {
      eligible: false,
      reason: 'tag_fetch_failed_falling_back_to_approval',
      tags: null,
    };
  }
  if (!tags.includes(AGENTIC_AUTOREPLY_REQUIRED_TAG)) {
    return {
      eligible: false,
      reason: `missing_required_tag:${AGENTIC_AUTOREPLY_REQUIRED_TAG}`,
      tags,
    };
  }
  return { eligible: true, reason: 'all_gates_passed', tags };
}

/**
 * v4.8 — Auto-reply application. Flips every action in the batch with
 * status='pending_approval' AND requires_approval=true to status='pending'
 * so Phase 2 of the executor picks them up on this same heartbeat. The
 * companion book_appointment / cancel_appointment / reschedule_appointment
 * (already auto-executing per v4.7/v4.9) are untouched. Sends an
 * informational GroupMe notice and skips the approval card.
 *
 * Returns:
 *   - flippable.length on success (positive int)
 *   - 0 if there were no flippable actions (caller should fall through)
 *   - -1 on DB update failure (caller MUST fall through to approval card
 *     so the human still has eyes on it)
 */
async function applyAutoReplyInline({
  batchActions,
  sendAction,
  generated,
  contactName,
  contactPhone,
  triggerMessage,
  tags,
}) {
  const flippable = batchActions.filter(
    a => a.status === 'pending_approval' && a.requires_approval === true
  );
  if (flippable.length === 0) {
    console.warn(`[ApprovalPath] AUTO-REPLY: no flippable actions in batch ${sendAction.batch_id || `s_${sendAction.id}`} — falling through`);
    return 0;
  }

  const ids = flippable.map(a => a.id);
  const updatedAt = new Date().toISOString();
  const { error } = await supabase
    .from('agent_actions')
    .update({
      status: 'pending',
      requires_approval: false,
      approved_by: 'auto_reply_v4_8',
      updated_at: updatedAt,
    })
    .in('id', ids);

  if (error) {
    console.error(`[ApprovalPath] AUTO-REPLY db update failed for batch ${sendAction.batch_id}: ${error.message} — falling through to approval card`);
    return -1;
  }

  // ── Build informational GroupMe notice ───────────────────────────
  // Distinct format from approval card so Mark immediately recognizes
  // there is no decision required. Header explicitly says "no approval
  // needed". No "Reply: Yes/No" footer.
  const preview = (triggerMessage || '').slice(0, 120);
  const sentMessage = (sendAction.action_payload?.message || generated.message || '').slice(0, 400);
  const reasoning = (generated.reasoning || '').slice(0, 200);
  const displayName = contactName ? `${contactName}${contactPhone ? ` (${contactPhone})` : ''}` : sendAction.target_id;
  const intent = generated.intent_class || 'unknown';
  const arc = generated.story_arc && generated.story_arc !== 'none' ? generated.story_arc : null;

  // v4.9: companion line — handle book_appointment, cancel_appointment,
  // and reschedule_appointment formats so all three surface in the notice.
  let companionLine = '';
  const ca = generated.companion_action;
  if (ca?.action_type === 'book_appointment' && ca.action_payload) {
    const cap = ca.action_payload;
    companionLine = `📅 Auto-booked: ${cap.calendar_name || '?'} — ${cap.start_time || '?'} (status: ${cap.status || '?'})\n`;
  } else if (ca?.action_type === 'cancel_appointment' && ca.action_payload) {
    const cap = ca.action_payload;
    companionLine = `🗓 Auto-cancelled: appointment ${cap.appointment_id || '?'}` +
      (cap.reason ? ` (reason: ${String(cap.reason).slice(0, 80)})` : '') + `\n`;
  } else if (ca?.action_type === 'reschedule_appointment' && ca.action_payload) {
    const cap = ca.action_payload;
    companionLine = `🔄 Auto-rescheduled: ${cap.old_appointment_id || '?'} → ${cap.new_calendar_name || '?'} ${cap.new_start_time || '?'} (status: ${cap.status || '?'})\n`;
  }

  // Tag actions in the auto-fired batch (e.g. pause-workflow).
  const tagActions = flippable.filter(a => a.action_type === 'add_tag');
  const tagsAdded = tagActions.map(a => a.action_payload?.tag).filter(Boolean);
  const tagsLine = tagsAdded.length > 0 ? `🏷  +${tagsAdded.join(', +')}\n` : '';

  await sendGroupMeMessage(
    `🚀 AGENTIC AUTO-REPLY (no approval needed)\n` +
    `👤 ${displayName}\n` +
    `Intent: ${intent}${arc ? ` | Arc: ${arc}` : ''} | Rule: ${sendAction.rule_applied || 'n/a'}\n` +
    `💬 "${preview}"\n` +
    `📱 "${sentMessage}"\n` +
    (reasoning ? `🤖 ${reasoning}\n` : '') +
    companionLine +
    tagsLine +
    `→ Auto-fired (${flippable.length} action${flippable.length === 1 ? '' : 's'}) at ${updatedAt}. Batch ${sendAction.batch_id || `s_${sendAction.id}`}.`
  , { contactId: sendAction.target_id, contactName }).catch(err => {
    console.warn(`[ApprovalPath] GroupMe (auto-reply notice) failed: ${err.message}`);
  });

  console.log(`[ApprovalPath] 🚀 AUTO-REPLY: contact=${sendAction.target_id} ` +
    `rule=${sendAction.rule_applied} intent=${intent} ` +
    `flipped=${flippable.length} tags=${tags?.length || 0} ` +
    `companion=${ca?.action_type || 'none'}`);

  return flippable.length;
}

/**
 * v4.5 — Inline handoff. Replaces the approval-card-then-runtime path
 * for short-circuited send_message actions. Applies the handoff tag(s)
 * directly, marks every action in the batch as 'completed' with an
 * execution_result that mirrors send-message-handler.handleShortCircuit's
 * shape, and sends an informational notice to GroupMe.
 *
 * Returns the count of actions completed for stats.
 */
async function applyHandoffInline({
  contactId,
  batchActions,
  generated,
  contactName,
  contactPhone,
  triggerMessage,
}) {
  let handoffTag = generated.handoff_tag || null;
  const isDQ = !!generated.is_disqualifier;

  // ── CALLBACK resolution (2026-07-08 — parity with handleShortCircuit) ──
  // The classifier hands CALLBACK off with the dead placeholder tag
  // hdl:callback-pending-classification (no GHL workflow listens on it).
  // Resolve to a live queue: known customer → hdl:callback-service, known
  // lead → hdl:callback-sales. Ambiguous ALSO goes to sales here — this
  // cold path has no SMS sender for the HDL.3 customer-status probe, and a
  // human callback beats silence (sales can transfer a customer). That
  // matches the hot path's own fallback whenever the probe can't be sent.
  let callbackBasis = null;
  if (generated.intent_class === 'CALLBACK') {
    const resolution = await resolveCallbackHandoff(contactId);
    handoffTag = resolution.tag || CALLBACK_TAG_SALES;
    callbackBasis = resolution.tag ? resolution.basis : 'ambiguous_approval_path_default_sales';
    console.log(`[ApprovalPath] CALLBACK resolved for ${contactId}: ${handoffTag} (${callbackBasis})`);
  }

  const tagsToApply = [];
  if (handoffTag) tagsToApply.push(handoffTag);
  if (isDQ) tagsToApply.push('suppress-automation');

  let tagApplied = false;
  if (tagsToApply.length > 0) {
    tagApplied = await applyContactTagsInline(contactId, tagsToApply);
  }

  // ── Customer-status probe answered → clear the pending tag ────────
  // Same contract as handleShortCircuit: once a CUSTOMER_STATUS_* gate
  // answer routes to a concrete queue, pending:customer-status-check must
  // come off so a short "yes"/"no" weeks later can never re-trip the gates.
  // Removal is unconditional (deleting an absent tag is a harmless no-op)
  // because this path has no contact-tag snapshot to consult.
  let pendingCleared = false;
  if (CUSTOMER_STATUS_GATE_INTENT_SET.has(generated.intent_class)) {
    pendingCleared = await removeContactTagsInline(contactId, [CUSTOMER_STATUS_PENDING_TAG]);
    console.log(`[ApprovalPath] customer-status gate answered by ${contactId} → ${handoffTag}; pending tag ${pendingCleared ? 'cleared' : 'clear no-op/failed'}`);
  }

  const completedAt = new Date().toISOString();
  const sharedResult = {
    action: 'send_message_handed_off_inline',
    reason: 'compliance_gate_handoff',
    contact_id: contactId,
    handoff_tag: handoffTag,
    handler_code: generated.handler_code || null,
    intent_class: generated.intent_class || null,
    bucket_type: generated.bucket_type || null,
    is_disqualifier: isDQ,
    tags_applied: tagApplied ? tagsToApply : [],
    classification_method: generated.classification_method || null,
    classifier_confidence: generated.classifier_confidence ?? null,
    callback_basis: callbackBasis,
    pending_cleared: pendingCleared,
    applied_at: 'queue_time_v4_5',
  };

  const actionIds = batchActions.map(a => a.id);
  await supabase
    .from('agent_actions')
    .update({
      status: 'completed',
      executed_at: completedAt,
      approved_by: 'auto_handoff_pregeneration',
      execution_result: sharedResult,
      updated_at: completedAt,
    })
    .in('id', actionIds);

  const dqLabel = isDQ ? ' [DISQUALIFIER]' : '';
  const tagSummary = tagsToApply.join(', ') || 'none';
  const preview = (triggerMessage || '').slice(0, 120);
  const displayName = contactName ? `${contactName}${contactPhone ? ` (${contactPhone})` : ''}` : contactId;

  await sendGroupMeMessage(
    `🛑 AGENTIC SHORT-CIRCUIT${dqLabel} (queue-time)\n` +
    `👤 ${displayName}\n` +
    `Intent: ${generated.intent_class || 'unknown'}` +
    (generated.handler_code ? ` (${generated.handler_code})` : '') + `\n` +
    `Tags applied: ${tagSummary}${tagApplied ? '' : ' [TAG WRITE FAILED]'}\n` +
    `Method: ${generated.classification_method || 'unknown'} (${(generated.classifier_confidence ?? 0).toFixed(2)})\n` +
    (callbackBasis ? `Callback basis: ${callbackBasis}\n` : '') +
    `Inbound: "${preview}"\n` +
    `→ GHL workflow on tag now owns the response. No approval card sent (nothing for human to review — handoff is mechanical).`
  , { contactId, contactName }).catch(err => {
    console.warn(`[ApprovalPath] GroupMe (inline short-circuit) failed: ${err.message}`);
  });

  console.log(`[ApprovalPath] 🛑 INLINE HANDOFF: ${contactId} → ${tagSummary} ` +
    `(intent: ${generated.intent_class}, ${batchActions.length} actions completed, no approval card)`);

  return actionIds.length;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN — APPROVAL QUEUE PROCESSOR
// ═══════════════════════════════════════════════════════════════════

/**
 * Process the pending_approval queue. Returns the number of approval
 * requests sent this cycle for stats reporting (does not include
 * inline-handoff or auto-reply batches that bypassed the approval card).
 */
export async function processApprovalQueue() {
  const { data: trackedRows } = await supabase
    .from('groupme_approval_requests')
    .select('batch_id')
    .eq('status', 'pending');
  const trackedBatchIds = new Set((trackedRows || []).map(r => r.batch_id).filter(Boolean));

  const { data: rawApprovalActions } = await supabase.from('agent_actions')
    .select('*')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true })
    .limit(100);

  const approvalActions = (rawApprovalActions || [])
    .filter(a => !trackedBatchIds.has(a.batch_id || `s_${a.id}`))
    .slice(0, 20);

  if (!approvalActions?.length) return 0;

  const approvalBatches = new Map();
  for (const a of approvalActions) {
    const k = a.batch_id || `s_${a.id}`;
    if (!approvalBatches.has(k)) approvalBatches.set(k, []);
    approvalBatches.get(k).push(a);
  }

  let cardsSent = 0;
  let inlineHandoffs = 0;
  let autoReplies = 0;

  for (const [batchId, actions] of approvalBatches) {
    const { data: existing } = await supabase
      .from('groupme_approval_requests')
      .select('id')
      .eq('batch_id', batchId)
      .eq('status', 'pending')
      .maybeSingle();
    if (existing) continue;

    const firstAction = actions[0];
    const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(firstAction.target_id);
    const prospectId = await resolveLPProspectId(firstAction.target_id);
    const ctx = await getEventContext(firstAction);
    const enrichment = await buildNotificationEnrichment(firstAction.target_id, ctx, { lpLead, prospectId, ghlContactId });

    const sendAction = actions.find(
      a => a.action_type === 'send_message' && a.action_payload?.requires_ai_generation
    );

    let inlineHandoffApplied = false;
    let autoReplyApplied = false;

    if (sendAction) {
      try {
        const { generateResponse } = await import('../response-generator.js');
        const triggerMessage = ctx.message_text || ctx.messageText || ctx.body || ctx.message_preview || 'No trigger message';
        const channel = sendAction.action_payload?.channel || 'sms';

        console.log(`[ActionExecutor] Pre-generating AI response for approval ${batchId} (send_message action ${sendAction.id})`);
        // 2026-07-06 — prompt_hint plumb (Bot 2/3/4 consolidation): a rule or
        // dispatch row may carry an approved script in params.prompt_hint;
        // the generator treats it as the reply's backbone (SCRIPT DIRECTIVE).
        const generated = await generateResponse(sendAction.target_id, channel, triggerMessage, {
          promptHint: sendAction.action_payload?.prompt_hint || null,
          // 2026-07-06 — request-first routing (see send-message-handler).
          requestedFulfillment: ctx.requested_fulfillment || null,
        });

        if (generated.short_circuit) {
          console.log(`[ActionExecutor] Pre-gen short-circuit (intent: ${generated.intent_class}, ` +
                      `handler: ${generated.handler_code || 'n/a'}, ` +
                      `tag: ${generated.handoff_tag || 'none'}). ` +
                      `Applying handoff INLINE — skipping approval card.`);

          const completedCount = await applyHandoffInline({
            contactId: sendAction.target_id,
            batchActions: actions,
            generated,
            contactName: name,
            contactPhone: phone,
            triggerMessage,
          });
          inlineHandoffs += completedCount > 0 ? 1 : 0;
          inlineHandoffApplied = true;
        } else {
          const updatedPayload = {
            ...sendAction.action_payload,
            message: generated.message,
            subject: generated.subject,
            story_arc: generated.story_arc,
            ai_reasoning: generated.reasoning,
            requires_ai_generation: false,
            pre_generated: true,
            generated_at: new Date().toISOString(),
          };

          await supabase.from('agent_actions')
            .update({ action_payload: updatedPayload, updated_at: new Date().toISOString() })
            .eq('id', sendAction.id);

          sendAction.action_payload = updatedPayload;

          enrichment.generatedMessage = generated.message;
          enrichment.storyArc = generated.story_arc;
          enrichment.aiReasoning = generated.reasoning;

          const preview = typeof generated.message === 'string'
            ? generated.message.slice(0, 80)
            : '(no message)';
          console.log(`[ActionExecutor] Pre-generated: "${preview}..." (arc: ${generated.story_arc || 'n/a'})`);

          // ── v4.6/v4.7/v4.9: COMPANION_ACTION INSERTION ────────────
          // Insert sibling action for any companion the AI emitted. Auto-
          // execute types (book/cancel/reschedule) skip approval; other
          // types stay approval-gated as in v4.6.
          if (generated.companion_action && generated.companion_action.action_type) {
            const companion = generated.companion_action;
            const parentSeq = typeof sendAction.sequence_order === 'number' ? sendAction.sequence_order : 0;
            const isAutoExecuting = COMPANION_AUTO_EXECUTE.has(companion.action_type);

            // v4.10: sequence_order race fix.
            //   book_appointment / reschedule_appointment must run AFTER
            //   send_message — both write to GHL calendars and that write
            //   re-points the contact's effective send-from user to the
            //   calendar owner. If they run first, the agentic-send
            //   workflow picks up the new owner and the SMS fires from
            //   a different number, breaking the lead's SMS thread.
            //   cancel_appointment stays BEFORE send_message so the
            //   verbal "I've taken X off the calendar" is truthful by
            //   the time it lands.
            const seqAfterSend = (
              companion.action_type === 'book_appointment' ||
              companion.action_type === 'reschedule_appointment'
            );
            const companionSeqOrder = seqAfterSend ? parentSeq + 2 : parentSeq - 1;

            try {
              const { data: companionRow, error: companionErr } = await supabase
                .from('agent_actions')
                .insert({
                  event_id: sendAction.event_id,
                  action_type: companion.action_type,
                  target_system: 'ghl',
                  target_entity: 'contact',
                  target_id: sendAction.target_id,
                  action_payload: companion.action_payload,
                  reasoning: companion.reasoning
                    ? `Companion to send_message ${sendAction.id}: ${companion.reasoning}`
                    : `Companion to send_message ${sendAction.id} (${sendAction.rule_applied || 'manual'})`,
                  confidence: 1.0,
                  rule_applied: sendAction.rule_applied,
                  status: isAutoExecuting ? 'pending' : 'pending_approval',
                  requires_approval: !isAutoExecuting,
                  batch_id: sendAction.batch_id,
                  sequence_order: companionSeqOrder,
                })
                .select()
                .single();

              if (companionErr) {
                console.warn(`[ActionExecutor] Companion insert failed for batch ${batchId}: ${companionErr.message} — proceeding without companion`);
              } else if (companionRow) {
                if (!isAutoExecuting) {
                  actions.push(companionRow);
                  actions.sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0));
                }

                // v4.9: log shape varies by action type. Log key payload
                // fields for whichever companion this is so the audit
                // line reads cleanly for cancel/reschedule too.
                const cap = companion.action_payload || {};
                const payloadSummary = companion.action_type === 'book_appointment'
                  ? `calendar="${cap.calendar_name || 'n/a'}", start="${cap.start_time || 'n/a'}"`
                  : companion.action_type === 'cancel_appointment'
                    ? `appointment_id="${cap.appointment_id || 'n/a'}"`
                    : companion.action_type === 'reschedule_appointment'
                      ? `old="${cap.old_appointment_id || 'n/a'}", new_calendar="${cap.new_calendar_name || 'n/a'}", new_start="${cap.new_start_time || 'n/a'}"`
                      : companion.action_type === 'update_appointment_status'
                        ? `appointment_id="${cap.appointment_id || 'n/a'}", status="${cap.status || 'n/a'}"`
                        : '(unknown payload shape)';

                console.log(`[ActionExecutor] ✅ Companion ${companion.action_type} inserted: id=${companionRow.id}, batch=${batchId}, seq=${companionRow.sequence_order}, ` +
                  `mode=${isAutoExecuting ? 'AUTO-EXECUTE' : 'approval-gated'}, ${payloadSummary}`);

                enrichment.companionAction = {
                  type: companion.action_type,
                  calendar_name: cap.calendar_name || cap.new_calendar_name || null,
                  start_time: cap.start_time || cap.new_start_time || null,
                  duration_minutes: cap.duration_minutes || null,
                  appointment_id: cap.appointment_id || null,
                  old_appointment_id: cap.old_appointment_id || null,
                  reasoning: companion.reasoning || null,
                  auto_executing: isAutoExecuting,
                };

                // Fast-path: fire auto-execute companions (book/cancel/reschedule)
                // inline instead of waiting for the next ~60s executor sweep —
                // mirrors the send_message fast-path in decision-engine.js. A
                // single hung handler stalling the sweep previously left bookings
                // pending for minutes. Same handler (and the §A1 status
                // normalization), just immediate. No double-execute: the sweep
                // claims by status and executeActionById no-ops on
                // terminal/executing states. Dynamic import avoids the circular
                // dependency (index.js imports approval-path.js). Fire-and-forget.
                if (isAutoExecuting && companionRow?.id) {
                  import('./index.js')
                    .then(({ executeActionById }) => executeActionById(companionRow.id))
                    .catch(err => console.warn(`[ApprovalPath] inline book/cancel/reschedule fast-path failed for action ${companionRow.id}: ${err.message}`));
                }
              }
            } catch (insertErr) {
              console.warn(`[ActionExecutor] Companion insert threw for batch ${batchId}: ${insertErr.message} — proceeding without companion`);
            }
          }

          // ── v4.8: AGENTIC AUTO-REPLY GATE ─────────────────────────
          const eligibility = await evaluateAutoReplyEligibility(sendAction);
          if (eligibility.eligible) {
            const flipped = await applyAutoReplyInline({
              batchActions: actions,
              sendAction,
              generated,
              contactName: name,
              contactPhone: phone,
              triggerMessage,
              tags: eligibility.tags,
            });
            if (flipped > 0) {
              autoReplies++;
              autoReplyApplied = true;
            } else if (flipped === -1) {
              console.warn(`[ApprovalPath] AUTO-REPLY DB update failed for batch ${batchId} — falling through to approval card`);
            }
          } else if (AGENTIC_AUTOREPLY_ENABLED) {
            console.log(`[ApprovalPath] AUTO-REPLY gate skip (batch ${batchId}): ${eligibility.reason}`);
          }
        }
      } catch (err) {
        console.error(`[ActionExecutor] Pre-approval generation failed for ${batchId}: ${err.message}`);
        enrichment.generatedMessage = null;
        enrichment.aiGenerationError = err.message;
      }
    }

    if (inlineHandoffApplied || autoReplyApplied) continue;

    await sendApprovalRequest(actions, name, phone, enrichment).catch(err => {
      console.error(`[ActionExecutor] Approval request failed for batch ${batchId}:`, err.message);
    });
    cardsSent++;
  }

  if (inlineHandoffs > 0 || autoReplies > 0) {
    console.log(`[ApprovalPath] Cycle: ${cardsSent} cards sent, ${inlineHandoffs} inline handoffs, ${autoReplies} auto-replies (no card)`);
  }

  return cardsSent;
}
