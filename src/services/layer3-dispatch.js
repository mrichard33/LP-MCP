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
