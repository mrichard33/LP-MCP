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
 *     channels?: ["Email","SMS","Call","WhatsApp","GMB","FB","RCS"]  // default: all
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
 * There is a THIRD status GHL sets on its own: 'permanent' (e.g. an SMS
 * STOP keyword → { status: 'permanent', message: 'STOP_KEYWORD' }). It is
 * carrier-level, STRONGER than 'active', and the API refuses any attempt
 * to change it: PUTting a different value for that channel fails the WHOLE
 * request with 400 {"statusCode":401,"message":"Not authorized to update
 * permanent dnd setting for <channel>"}. Echoing the stored value back
 * unchanged is accepted (observed live: a failing PUT that echoed an
 * untouched RCS 'permanent' entry drew a complaint only about the SMS
 * entry it tried to change).
 *
 * That is why the 2026-07-23 DNC backfill stalled on 56 contacts: the v1.0
 * all-channels-in-one-PUT write was rejected because of the SMS 'permanent'
 * lock, so Email DND was never set — on exactly the contacts who opted out
 * most explicitly (texted STOP). Structural Gary-bug, second edition.
 *
 * v1.1 — 2026-07-23. Per-channel semantics:
 *   - 'permanent' channels are never written. On apply they count as
 *     SUCCESS (already suppressed harder than we can suppress); on lift
 *     they are reported as locked (only the carrier/contact can undo).
 *   - The PUT echoes every existing entry verbatim and modifies only the
 *     channels that actually need changing (real idempotence, fewer
 *     tokens burned against the rate limiter).
 *   - If the combined PUT is still rejected 4xx, degrade to per-channel
 *     PUTs so one un-settable channel cannot block the rest. Email
 *     landing is the whole point of this action.
 *   - Partial success is 'completed' with per-channel outcomes in the
 *     result. Only a total failure (nothing written, nothing already at
 *     the desired state) throws.
 *   - 429s abort the attempt immediately with a clean retryable error —
 *     never grind toward the executor's 60s timeout with a possibly-live
 *     PUT in flight (zombie writes).
 *   - RCS added to the channel list (GHL returns it in dndSettings).
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
  'RCS',
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

  // ─── Classify each requested channel ───────────────────────────────
  // permanent   → carrier-level lock; never written. Apply: success (it is
  //               a stronger suppression than we set). Lift: locked.
  // already_set → existing status equals the desired status; no write.
  // to_write    → everything else.
  const permanentLocked = [];
  const alreadySet = [];
  const toWrite = [];
  for (const c of channels) {
    const existing = before?.[c]?.status;
    if (existing === 'permanent') permanentLocked.push(c);
    else if (existing === status) alreadySet.push(c);
    else toWrite.push(c);
  }

  const channelOutcomes = {};
  for (const c of permanentLocked) {
    channelOutcomes[c] = status === 'active' ? 'permanent_already_stronger' : 'permanent_locked_cannot_lift';
  }
  for (const c of alreadySet) channelOutcomes[c] = 'already_at_status';

  // ─── Idempotency short-circuit — nothing needs writing ─────────────
  if (toWrite.length === 0) {
    console.log(
      `[SetDND] Skip: ${contactId} nothing to write on [${channels.join(', ')}] (${JSON.stringify(channelOutcomes)})`
    );
    return {
      action: 'already_set',
      contact_id: contactId,
      status,
      channels,
      channel_outcomes: channelOutcomes,
      dnd_settings_before: before,
    };
  }

  const newEntry = () => ({
    status,
    message: `${reason} (set_dnd v1.1 ${new Date().toISOString()})`,
    code: 'AGENTIC_DNC',
  });

  // 429s must abort the attempt immediately with a retryable error — a
  // handler that grinds toward the executor's 60s timeout may leave a live
  // PUT in flight (zombie write). ghlFetch throws "… → 429: …" fast.
  const is429 = (err) => /→ 429/.test(err?.message || '');
  const is4xx = (err) => /→ 4\d\d/.test(err?.message || '');

  // ─── Write, combined first ─────────────────────────────────────────
  // Echo every existing entry verbatim (GHL PUT replaces dndSettings
  // wholesale — dropping an entry could lose a suppression) and modify
  // ONLY the channels that need changing. Echoed 'permanent' entries are
  // accepted; changing one 401s the whole request — that rejection is
  // what stranded the 2026-07-23 backfill.
  const written = [];
  const failedChannels = {};
  let workingSettings = { ...before };

  const combined = { ...workingSettings };
  for (const c of toWrite) combined[c] = newEntry();

  let combinedErr = null;
  try {
    const res = await ghlFetch('PUT', `/contacts/${contactId}`, { dndSettings: combined });
    workingSettings = res?.contact?.dndSettings || combined;
    written.push(...toWrite);
  } catch (err) {
    if (is429(err)) {
      throw new Error(`set_dnd: rate-limited by GHL (429) on combined PUT for ${contactId} — requeue: ${err.message}`);
    }
    if (!is4xx(err)) {
      // 5xx / network / timeout — retryable as a whole, nothing landed.
      throw new Error(`set_dnd: GHL PUT /contacts/${contactId} failed: ${err.message}`);
    }
    combinedErr = err;
  }

  // ─── Degrade to per-channel PUTs on 4xx ────────────────────────────
  // One un-settable channel must not block the rest: Email landing is the
  // whole point of this action.
  if (combinedErr) {
    console.warn(
      `[SetDND] Combined PUT rejected for ${contactId} (${combinedErr.message.slice(0, 160)}) — degrading to per-channel writes`
    );
    for (const c of toWrite) {
      const single = { ...workingSettings, [c]: newEntry() };
      try {
        const res = await ghlFetch('PUT', `/contacts/${contactId}`, { dndSettings: single });
        workingSettings = res?.contact?.dndSettings || single;
        written.push(c);
      } catch (err) {
        if (is429(err)) {
          // Record what landed so far, then bail retryable — the
          // idempotency classification skips the landed channels on retry.
          for (const w of written) channelOutcomes[w] = 'written';
          throw new Error(
            `set_dnd: rate-limited by GHL (429) mid per-channel writes for ${contactId} ` +
            `(landed: [${written.join(', ')}]) — requeue: ${err.message}`
          );
        }
        failedChannels[c] = (err?.message || String(err)).slice(0, 200);
      }
    }
  }

  for (const w of written) channelOutcomes[w] = 'written';
  for (const [c, msg] of Object.entries(failedChannels)) channelOutcomes[c] = `failed: ${msg}`;

  // ─── Partial success is success ────────────────────────────────────
  // Only a total failure is an error: nothing written, nothing already at
  // the desired state, and (on apply) nothing carrier-permanent — which on
  // apply counts as suppressed-harder-than-we-can-suppress. A fully-locked
  // contact never reaches here on either direction: toWrite would be empty
  // and the idempotency short-circuit returns 'already_set' instead, so
  // the action does not retry forever against carrier state.
  const totalFailure =
    written.length === 0 &&
    alreadySet.length === 0 &&
    !(status === 'active' && permanentLocked.length > 0);
  if (totalFailure) {
    throw new Error(
      `set_dnd: no channel written for ${contactId} — per-channel failures: ${JSON.stringify(failedChannels)}`
    );
  }

  const after = workingSettings;

  // ─── Audit trail (non-blocking) ────────────────────────────────────
  await applyGHLTag(contactId, 'lp-dnd:set').catch((err) => {
    console.warn(`[SetDND] tag writeback failed (non-blocking): ${err.message}`);
  });
  await addGHLNote(
    contactId,
    `[set_dnd v1.1] Contact-level DND ${status === 'active' ? 'APPLIED' : 'LIFTED'}\n` +
      `Written: ${written.join(', ') || '(none)'}\n` +
      (permanentLocked.length ? `Carrier-permanent (untouched): ${permanentLocked.join(', ')}\n` : '') +
      (alreadySet.length ? `Already at ${status}: ${alreadySet.join(', ')}\n` : '') +
      (Object.keys(failedChannels).length ? `Failed: ${Object.keys(failedChannels).join(', ')}\n` : '') +
      `Reason: ${reason}\n` +
      `Note: status "active" = sending BLOCKED (GHL semantics).`
  ).catch(() => {});

  console.log(
    `[SetDND] ✅ ${contactId} → ${status} written=[${written.join(', ')}] ` +
      `permanent=[${permanentLocked.join(', ')}] already=[${alreadySet.join(', ')}] ` +
      `failed=[${Object.keys(failedChannels).join(', ')}] (${reason})`
  );

  return {
    action: status === 'active' ? 'dnd_applied' : 'dnd_lifted',
    contact_id: contactId,
    status,
    channels,
    channel_outcomes: channelOutcomes,
    written,
    permanent_locked: permanentLocked,
    already_at_status: alreadySet,
    failed_channels: failedChannels,
    reason,
    dnd_settings_before: before,
    dnd_settings_after: after,
  };
}
