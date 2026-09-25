/**
 * Layer 3 Dispatch — src/services/layer3-dispatch.js
 *
 * Single source of truth for what each Layer 3 recommended_action triggers.
 * Reads layer3_action_dispatch and applies a confidence gate.
 *
 * Confidence: takes the max of any *_confidence numeric fields on the event
 * payload (objection_confidence, buyer_stage_confidence, intent_confidence,
 * etc.). If none are present, defaults to 1.0 — analyzers that don't emit
 * confidence are trusted as-is. Gate compares against row.min_confidence.
 *
 * 2026-06-03 — post-book guard: fast_track_booking keeps firing booking-push
 * sends alongside the responder, which stampedes past discovery once a slot
 * is already locked. When the contact already has an active in-home
 * appointment, the fast_track_booking dispatch is suppressed (the responder's
 * book-then-capture flow owns the post-book conversation). Fail-open: a
 * lookup error or unknown contact never blocks the dispatch.
 */

import supabase from '../supabase.js';
import { fetchUpcomingAppointments } from '../knowledge/contact-appointments.js';
import { isInHomeCalendarId } from '../knowledge/booking-calendar-router.js';
import { interpolatePayload } from '../actions/helpers.js';
import { inferChannelFromEvent } from '../channel-inference.js';
import { deliveryTagsFromSubActions } from '../agentic/guide-delivery.js';

// ═══════════════════════════════════════════════════════════════════
// 2026-09-02 — follow-up promise vs soft decline (Jacqueline Branham,
// gpPQYhCsqdGy10wU14Rp).
//
// The follow_up_scheduled dispatch row is built for a lead who ASKED for a
// time ("call me next month"): confirm warmly, no ask, hold until then. The
// analyzer also routes soft declines here — "I'm not going to bother for now"
// — with engagement_quality=disengagement and the vague-deferral bucket
// (seasonal = 2160h). On a lead whose appointment was disrupted in the last
// 7 days that is the wrong play twice over: the bot capitulates instead of
// reframing once, and a booked-yesterday lead is frozen for a quarter.
//
// Antifragile objection rule: acknowledge, reframe ONCE, re-ask at the
// current trust level. Timing after a no-show is a step-DOWN ask (15-minute
// phone Protection Profile Review), never a re-pitch of the in-home visit,
// and never a park. The dispatch row itself is untouched; this guard returns
// a copy with the reply prompt swapped and the bucket forced to 1week via
// payload_overrides (consumed by executeLayer3Dispatch).
//
// Explicit timing requests (tomorrow / few-days / 1week / 2weeks) are never
// touched — the customer named a time, honor it. Pure predicate; unit-tested.
// ═══════════════════════════════════════════════════════════════════
const SOFT_DECLINE_BUCKETS = new Set(['seasonal', '1month', '2months', 'after-holidays']);
const RECENT_DISRUPTION_WINDOW_MINUTES = 7 * 24 * 60;
export const SOFT_DECLINE_BUCKET = '1week';
export const SOFT_DECLINE_REFRAME_HINT =
  'SOFT DECLINE after a missed or cancelled appointment in the last 7 days. This is a timing objection, not a rejection. ' +
  'Acknowledge it in their own words, reframe ONCE, then make one low-friction ask. Do NOT re-pitch the in-home visit, do NOT offer times, do NOT apologize twice. ' +
  'The reframe: nobody needs to come to the house — a 15-minute Protection Profile Review by phone puts their numbers on file for whenever they are ready, and it costs nothing. ' +
  'One question, one question mark, under 300 characters, rep or company voice, no exclamation points. Read the last few turns so the reply answers what they actually said. ' +
  'If they also raised price, spouse, or trust, name it in one clause before the ask. ' +
  'Never push past this turn: if the next reply is still no, confirm the check-back and stop.';

/**
 * True when a follow_up_scheduled classification is really a soft decline on
 * a lead whose appointment was disrupted within the last 7 days. Reads only
 * the ai.analysis_completed payload. Fail-CLOSED toward the existing behavior:
 * any missing field means "not a soft decline" and the row runs as written.
 */
export function isSoftDeclineAfterAppointmentDisruption(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const bucket = typeof payload.follow_up_bucket === 'string' ? payload.follow_up_bucket.toLowerCase() : null;
  const engagement = typeof payload.engagement_quality === 'string' ? payload.engagement_quality.toLowerCase() : null;
  const softDecline = engagement === 'disengagement' || (bucket !== null && SOFT_DECLINE_BUCKETS.has(bucket));
  if (!softDecline) return false;
  if (String(payload.appointment_phase || '').toLowerCase() !== 'past') return false;
  const delta = Number(payload.appointment_minutes_delta);
  if (!Number.isFinite(delta)) return false;
  return delta <= 0 && delta >= -RECENT_DISRUPTION_WINDOW_MINUTES;
}

/**
 * Returns a copy of the dispatch row with the send_message prompt replaced by
 * the reframe hint. Every other sub-action (follow-up tag, hold) is kept; the
 * bucket override happens through payload_overrides at interpolation time.
 */
export function applySoftDeclineReframe(row) {
  const actions = Array.isArray(row?.actions) ? row.actions : [];
  return {
    ...row,
    notes: `soft-decline reframe (2026-09-02 guard) — ${row?.notes || ''}`,
    actions: actions.map((a) => (
      a?.action_type === 'send_message'
        ? { ...a, params: { ...(a.params || {}), prompt_hint: SOFT_DECLINE_REFRAME_HINT } }
        : a
    )),
  };
}

// 2026-06-16 — suppress disambiguation. `recommended_action: "suppress"` is
// overloaded: the analyzer returns it for BOTH "the customer declined" and
// "hold outreach, the lead is booked/satisfied". The suppress dispatch row runs
// a hard not-interested closeout (P3 move, mark-p1-lost, suppress-outbound,
// long-term-nurture). isGenuineDecline gates that destructive path behind an
// affirmative decline signal so a benign ack (e.g. "Thank you." after a
// confirmed booking) is never closed as lost. Conservative by design — false
// positives here are exactly what caused the Jacqueline Virtue misfire.
const DECLINE_OBJECTION_TYPES = new Set(['not-interested', 'not_interested', 'opt-out', 'opt_out', 'dnc']);
const DECLINE_ENGAGEMENT_QUALITIES = new Set(['dnc', 'disengagement']);
// Standalone refusal phrases only. "not interested in the 10am slot" must NOT
// match — the negative lookahead drops "not interested in ...". objection_type /
// engagement_quality are the primary signals; text is a conservative fallback.
const DECLINE_TEXT_PATTERNS = [
  /^\s*stop\b/i,
  /\bunsubscribe\b/i,
  /\bdo not contact\b/i,
  /\bremove me\b/i,
  /\bleave me alone\b/i,
  /\bnot interested\b(?!\s+in\b)/i,
];

/**
 * True ONLY when the payload carries an affirmative decline signal. Pure (no
 * DB/GHL) so it is unit-testable. Reads the ai.analysis_completed payload
 * fields (objection_type, engagement_quality, message_text).
 */
export function isGenuineDecline(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const objection = typeof payload.objection_type === 'string' ? payload.objection_type.toLowerCase() : null;
  if (objection && DECLINE_OBJECTION_TYPES.has(objection)) return true;
  const engagement = typeof payload.engagement_quality === 'string' ? payload.engagement_quality.toLowerCase() : null;
  if (engagement && DECLINE_ENGAGEMENT_QUALITIES.has(engagement)) return true;
  const text = typeof payload.message_text === 'string' ? payload.message_text : '';
  if (text && DECLINE_TEXT_PATTERNS.some((re) => re.test(text))) return true;
  return false;
}

/**
 * True when the contact has an active in-home appointment. Returns false on
 * any error or empty result (fail-open — never block a dispatch on a transient
 * lookup failure). fetchUpcomingAppointments already excludes cancelled/no-show.
 */
export async function hasActiveInHomeAppointment(contactId) {
  if (!contactId) return false;
  try {
    const upcoming = await fetchUpcomingAppointments(contactId);
    if (!Array.isArray(upcoming) || upcoming.length === 0) return false;
    return upcoming.some((a) => isInHomeCalendarId(a.calendar_id));
  } catch (err) {
    console.warn(`[layer3-dispatch] in-home appointment guard lookup threw for ${contactId}: ${err.message}`);
    return false;
  }
}

// opts.supabase is a test seam; production always uses the shared client.
export async function getDispatchForClassification(payload, opts = {}) {
  const db = opts.supabase || supabase;
  if (!db) return { dispatch: null, reason: 'no_supabase' };
  const recommended = payload?.recommended_action;
  if (!recommended) return { dispatch: null, reason: 'no_recommended_action' };

  const { data, error } = await db
    .from('layer3_action_dispatch')
    .select('*')
    .eq('recommended_action', recommended)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error(`[layer3-dispatch] fetch error for ${recommended}: ${error.message}`);
    return { dispatch: null, reason: 'fetch_error', error: error.message };
  }
  if (!data) return { dispatch: null, reason: 'no_active_dispatch_row', recommended_action: recommended };

  // 2026-06-03 — post-book guard. Once an in-home appointment exists, the
  // responder's book-then-capture flow (book + status upgrade) owns the
  // conversation; the fast_track_booking push would stampede past discovery
  // and re-pitch a slot that's already locked. Suppress it. Other
  // classifications are unaffected.
  if (recommended === 'fast_track_booking') {
    const contactId = opts.contactId || null;
    if (await hasActiveInHomeAppointment(contactId)) {
      console.log(`[layer3-dispatch] fast_track_booking suppressed: contact ${contactId} already has an active in-home appointment`);
      return { dispatch: null, reason: 'in_home_appointment_exists', recommended_action: recommended };
    }
  }

  // 2026-06-16 — suppress disambiguation guard (Jacqueline Virtue misfire).
  // The suppress dispatch row is a hard not-interested closeout. Only proceed
  // when there's a genuine decline signal AND the contact has no active in-home
  // appointment; otherwise treat as a benign HOLD (no destructive closeout).
  // The appointment hard-block defers a real "cancel + not interested" from a
  // booked contact to the explicit cancel/decline rules, not the over-broad
  // suppress dispatch. Fail-open: hasActiveInHomeAppointment never throws.
  if (recommended === 'suppress') {
    const declineSignal = isGenuineDecline(payload);
    const hadActiveAppointment = await hasActiveInHomeAppointment(opts.contactId || null);
    if (!declineSignal || hadActiveAppointment) {
      console.log(`[layer3-dispatch] suppress reclassified as benign hold: contact=${opts.contactId} decline_signal=${declineSignal} had_active_appointment=${hadActiveAppointment}`);
      return {
        dispatch: null,
        reason: 'benign_hold_not_a_decline',
        recommended_action: recommended,
        decline_signal: declineSignal,
        had_active_appointment: hadActiveAppointment,
      };
    }
  }

  const confidences = Object.entries(payload || {})
    .filter(([k, v]) => k.endsWith('_confidence') && typeof v !== 'object' && Number.isFinite(Number(v)))
    .map(([, v]) => Number(v));
  const confidence = confidences.length ? Math.max(...confidences) : 1.0;

  const threshold = Number(data.min_confidence);
  if (confidence < threshold) {
    return {
      dispatch: null,
      reason: 'below_confidence_threshold',
      confidence, threshold, recommended_action: recommended,
    };
  }

  // 2026-09-02 — soft-decline reframe (see module header). Applied AFTER the
  // confidence gate so a low-confidence analysis still stands down as today.
  if (recommended === 'follow_up_scheduled' && isSoftDeclineAfterAppointmentDisruption(payload)) {
    console.log(
      `[layer3-dispatch] follow_up_scheduled reclassified as soft decline for ${opts.contactId}: ` +
      `bucket=${payload.follow_up_bucket || 'unset'} engagement=${payload.engagement_quality || 'unset'} ` +
      `appt_delta_min=${payload.appointment_minutes_delta} → reframe + ${SOFT_DECLINE_BUCKET}`
    );
    return {
      dispatch: applySoftDeclineReframe(data),
      confidence, threshold,
      soft_decline_reframe: true,
      payload_overrides: { follow_up_bucket: SOFT_DECLINE_BUCKET },
    };
  }

  return { dispatch: data, confidence, threshold };
}

// ═══════════════════════════════════════════════════════════════════
// 2026-09-25 — the fan-out plan, pure.
//
// Lifted out of actions/index.executeLayer3Dispatch so the rows a dispatch
// queues are testable without a database, and so the send_message can be told
// what its siblings deliver BEFORE any of them is inserted. The guide_send row
// delivers through a sibling add_tag (send-{{guide_type}}-guide), not a
// companion, so the send-promise guard in response-generator could not see it
// and would have rewritten "I'm sending that hurricane guide now" as a broken
// promise. delivery_tags on the send_message payload is how it knows.
// ═══════════════════════════════════════════════════════════════════

/**
 * @returns {Array<object>} agent_actions insert rows, in sequence order. Rows
 *   the fan-out cannot target (GHL action with no contact) are omitted.
 */
export function planLayer3SubActions({ event, dispatch, result = {}, targetId = null }) {
  const subActions = Array.isArray(dispatch?.actions) ? dispatch.actions : [];
  const batchId = `layer3_${event.id}_${dispatch.recommended_action}_${Date.now()}`;
  // 2026-09-02 — a dispatch guard may override interpolation inputs (the
  // soft-decline guard forces follow_up_bucket to '1week'). Spread so the
  // fetched event row is never mutated.
  const interpContext = { ...(event.payload || {}), ...(result.payload_overrides || {}) };
  const rows = [];

  for (let i = 0; i < subActions.length; i++) {
    const tmpl = subActions[i] || {};
    if (!tmpl.action_type) continue;

    const targetSystem = tmpl.target_system || 'ghl';
    const targetEntity = tmpl.target_entity || 'contact';
    const subTargetId = tmpl.target_id || targetId;

    if (targetSystem === 'ghl' && !subTargetId) {
      console.log(`[ActionExecutor] layer3_dispatch: skipping ${tmpl.action_type} — no GHL contact id`);
      continue;
    }

    // 2026-07-06 (Bot 2/3/4 consolidation) — interpolate dispatch params
    // against the triggering event payload so rows can carry dynamic tokens
    // like "follow-up:{{follow_up_bucket}}" or "send-{{guide_type}}-guide"
    // (analyzer-emitted fields). interpolate() only matches single-word
    // {{token}} / {{token|filter}} — GHL merge tags ({{contact.first_name}},
    // {{trigger_link.xyz}}) contain dots and pass through UNTOUCHED. An
    // absent token blanks to '' — executeAddTag's trailing-':' hygiene guard
    // rejects the malformed tag rather than writing it.
    let actionPayload = interpolatePayload(tmpl.params || tmpl.payload || {}, interpContext);

    // 2026-08-13 — stamp the REAL channel from the triggering event, mirroring
    // what decision-engine.createActionsFromRule already does for rule
    // templates. Six layer3_action_dispatch rows hardcoded "channel": "sms", so
    // every email inbound owned by Layer 3 was answered (and WRITTEN) for SMS
    // (Andrea, 2026-08-12). Spread rather than mutate: interpolatePayload
    // returns the ORIGINAL params object when the event payload is empty.
    if (tmpl.action_type === 'send_message') {
      const eventChannel = inferChannelFromEvent(event);
      if (eventChannel && actionPayload.channel !== eventChannel) {
        console.log(
          `[ActionExecutor] layer3 channel override (${dispatch.recommended_action}): ` +
          `${tmpl.params?.channel || 'unset'} → ${eventChannel} (event ${event.id})`
        );
        actionPayload = { ...actionPayload, channel: eventChannel };
      }
    }

    const row = {
      event_id: event.id,
      action_type: tmpl.action_type,
      target_system: targetSystem,
      target_entity: targetEntity,
      target_id: String(subTargetId || ''),
      action_payload: actionPayload,
      reasoning: `LAYER3_DISPATCH(${dispatch.recommended_action}): ${dispatch.notes || 'data-driven dispatch'}`,
      confidence: result.confidence ?? 1.0,
      rule_applied: 'LAYER3_DISPATCH',
      status: 'pending',
      requires_approval: false,
      batch_id: batchId,
      sequence_order: i,
    };
    if (tmpl.priority !== undefined && tmpl.priority !== null) row.priority = tmpl.priority;
    rows.push(row);
  }

  // 2026-09-25 — tell the reply what this batch delivers (see block header).
  const deliveryTags = deliveryTagsFromSubActions(rows);
  if (deliveryTags.length) {
    for (const row of rows) {
      if (row.action_type !== 'send_message') continue;
      row.action_payload = { ...row.action_payload, delivery_tags: deliveryTags };
    }
  }
  return rows;
}
