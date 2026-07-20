/**
 * DND Handler — src/actions/handlers/dnd.js
 *
 * Writes GHL contact-level Do-Not-Disturb settings. This is the GHL-side
 * twin of lp-dnc.js: that handler pushes suppression OUT to Lead
 * Perfection, this one applies it INSIDE GoHighLevel so the sending
 * channels actually close.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * LP_DISP_DNC has carried this note since 2026-04-14:
 *
 *     "DND not settable via action executor — flagged in GroupMe
 *      notification for manual action."
 *
 * and a later note on the same rule records that GroupMe was switched to
 * approval-only on 2026-04-15. So the single step that closes the email
 * channel was delegated to a manual prompt that stopped firing the day
 * after it was written, and nothing replaced it.
 *
 * The 2026-07-20 lead-routing audit found the consequence. Live contact
 * wOxHXU8Z13ZbX99KZrXR carried dnc, stage:dnc, p3:dnc, dnc-sms,
 * hard-disqualified, loss-reason:dnc, suppress-outbound and stop-bot —
 * and its dndSettings contained an SMS entry and NO Email object at all.
 * The email channel had never been suppressed. Across 30 days, 34
 * outbound marketing messages reached 10 DNC-tagged contacts; the sampled
 * bodies were email (type 3).
 *
 * The asymmetry is the whole bug: update_lp_dnc_status told LP to stop,
 * while GHL — the system actually doing the sending — was never told.
 *
 * ── Relationship to the other suppression layers ───────────────────────
 * This handler is channel-level enforcement at the platform. It is NOT a
 * substitute for:
 *   - Fix 0a (src/suppression-guard.js) which stops routing state being
 *     RE-ARMED on a suppressed contact, and
 *   - Layer 3 universal suppression (open issue #51) which fails closed
 *     at send time inside the executor.
 * All three are needed. DND closes the channel, 0a stops resurrection,
 * #51 is the standing gate. Any one alone leaves a hole.
 *
 * ── Action payload shape ───────────────────────────────────────────────
 *   {
 *     channels?: ["Email","SMS","Call","WhatsApp","GMB","FB"]  // default: all
 *     status?:   "active" | "inactive"   // default "active" (= DND ON)
 *     reason?:   "LP disposition DNC"    // free text, lands in the GHL note
 *   }
 *
 * GHL semantics are counter-intuitive and worth stating plainly:
 * dndSettings[channel].status === 'active' means the DND restriction is
 * ACTIVE, i.e. sending is BLOCKED. 'inactive' means sending is allowed.
 * Passing status:'inactive' is therefore how you LIFT suppression, and is
 * supported here only so an erroneous DNC can be reversed without a
 * manual console edit.
 *
 * v1.0 — 2026-07-20. Fix 6b.
 */

import { ghlFetch } from '../helpers.js';
import { addGHLNote, applyGHLTag } from '../../ghl.js';

/** Channels GHL exposes on dndSettings. Order is stable for logging. */
export const DND_CHANNELS = Object.freeze([
  'Email',
  'SMS',
  'Call',
  'WhatsApp',
  'GMB',
  'FB',
]);

/**
 * Case-insensitively normalise a caller-supplied channel name to GHL's
 * exact casing. Returns null for anything unrecognised — callers treat
 * that as a hard validation error rather than silently dropping a
 * channel, because a silently-dropped channel is exactly how the email
 * gap survived nine months.
 */
function normalizeChannel(name) {
  if (typeof name !== 'string') return null;
  const want = name.trim().toLowerCase();
  return DND_CHANNELS.find((c) => c.toLowerCase() === want) || null;
}

/**
 * True when every requested channel already sits at the desired status.
 * Used for the idempotency short-circuit.
 */
function alreadyAtStatus(existing, channels, status) {
  if (!existing || typeof existing !== 'object') return false;
  return channels.every((c) => existing?.[c]?.status === status);
}

export async function executeSetDND(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  if (!contactId) {
    throw new Error('set_dnd: target_id (GHL contact ID) is required');
  }

  // ─── Resolve status ────────────────────────────────────────────────
  const rawStatus = (payload.status || 'active').toString().trim().toLowerCase();
  if (rawStatus !== 'active' && rawStatus !== 'inactive') {
    throw new Error(`set_dnd: invalid status "${payload.status}" (must be "active" or "inactive")`);
  }
  const status = rawStatus;

  // ─── Resolve channels ──────────────────────────────────────────────
  // Default is ALL channels. A DNC that closes SMS but leaves email open
  // is the precise failure this handler exists to prevent, so the safe
  // default is total suppression and narrowing must be explicit.
  let channels;
  if (payload.channels === undefined || payload.channels === null) {
    channels = [...DND_CHANNELS];
  } else if (Array.isArray(payload.channels) && payload.channels.length > 0) {
    channels = payload.channels.map((c) => {
      const norm = normalizeChannel(c);
      if (!norm) {
        throw new Error(
          `set_dnd: unknown channel "${c}" (valid: ${DND_CHANNELS.join(', ')})`
        );
      }
      return norm;
    });
    channels = [...new Set(channels)];
  } else {
    throw new Error('set_dnd: action_payload.channels must be a non-empty array when provided');
  }

  const reason = (payload.reason || 'Agentic DNC suppression').toString().slice(0, 200);

  // ─── Fetch current state (for idempotency + audit trail) ───────────
  let ghlContact = null;
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    ghlContact = res?.contact || null;
  } catch (err) {
    throw new Error(`set_dnd: GHL contact fetch failed for ${contactId}: ${err.message}`);
  }
  if (!ghlContact) {
    throw new Error(`set_dnd: GHL contact ${contactId} not found`);
  }

  const before = ghlContact.dndSettings || {};

  // ─── Idempotency guard ─────────────────────────────────────────────
  if (alreadyAtStatus(before, channels, status)) {
    console.log(
      `[SetDND] Skip: ${contactId} already ${status} on [${channels.join(', ')}]`
    );
    return {
      action: 'already_set',
      contact_id: contactId,
      status,
      channels,
      dnd_settings_before: before,
    };
  }

  // ─── Build the patch ───────────────────────────────────────────────
  // Merge rather than replace: a contact may legitimately carry a
  // channel-specific DND from another source (e.g. an SMS STOP handled by
  // U.DND) and blowing that away would be a regression.
  const dndSettings = { ...before };
  for (const c of channels) {
    dndSettings[c] = {
      status,
      message: `${reason} (set_dnd v1.0 ${new Date().toISOString()})`,
      code: 'AGENTIC_DNC',
    };
  }

  // ─── Write ─────────────────────────────────────────────────────────
  // Fail LOUD. A silently-failed DND write is indistinguishable from the
  // nine-month manual-step gap this handler replaces, so no catch-and-
  // continue here: let the action go to failed and be retried/reaped.
  let updateRes;
  try {
    updateRes = await ghlFetch('PUT', `/contacts/${contactId}`, { dndSettings });
  } catch (err) {
    throw new Error(`set_dnd: GHL PUT /contacts/${contactId} failed: ${err.message}`);
  }

  const after = updateRes?.contact?.dndSettings || dndSettings;

  // ─── Audit trail (non-blocking) ────────────────────────────────────
  await applyGHLTag(contactId, 'lp-dnd:set').catch((err) => {
    console.warn(`[SetDND] tag writeback failed (non-blocking): ${err.message}`);
  });
  await addGHLNote(
    contactId,
    `[set_dnd v1.0] Contact-level DND ${status === 'active' ? 'APPLIED' : 'LIFTED'}\n` +
      `Channels: ${channels.join(', ')}\n` +
      `Reason: ${reason}\n` +
      `Note: status "active" = sending BLOCKED (GHL semantics).`
  ).catch(() => {});

  console.log(
    `[SetDND] ✅ ${contactId} → ${status} on [${channels.join(', ')}] (${reason})`
  );

  return {
    action: status === 'active' ? 'dnd_applied' : 'dnd_lifted',
    contact_id: contactId,
    status,
    channels,
    reason,
    dnd_settings_before: before,
    dnd_settings_after: after,
  };
}
