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

export async function getDispatchForClassification(payload, opts = {}) {
  if (!supabase) return { dispatch: null, reason: 'no_supabase' };
  const recommended = payload?.recommended_action;
  if (!recommended) return { dispatch: null, reason: 'no_recommended_action' };

  const { data, error } = await supabase
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

  return { dispatch: data, confidence, threshold };
}
