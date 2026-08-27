/**
 * Appointment-event dedup — src/services/appt-event-dedup.js
 *
 * Replaces the fixed 30-minute wall-clock bucket that handleAppointment used to
 * build its idempotency key (behavioral-emitter.js v2.2). That bucket only
 * deduped webhooks that happened to land in the same :00/:30 calendar window, so
 * any identical pair straddling a boundary produced two keys and BOTH inserted
 * (verified prod: qPavwX5n7HRP3eH0lp19 cancelled 17:28→17:30; SN2btsZ7PgRr8clexoLl
 * booked 16:51→17:01).
 *
 * Design — dedupe on the SLOT and the LAST EVENT TYPE, never on a status-bearing
 * key. book → cancel → rebook-the-same-slot is common and lands well inside the
 * window (canary YHSGdUigcsLWrToPpFAc: booked 17:27:43 → cancelled 17:29:14 →
 * rebooked 17:31:17, 3.6 min). A status-bearing key would make the rebook
 * byte-identical to the first booking and swallow it — losing the stage advance,
 * suppression, reminder enrollment and LP sync while a LIVE appointment exists,
 * a worse failure than the duplication. So the lookup key carries no status; we
 * fetch the most recent event for the slot and dedupe only when its normalized
 * event_type equals the incoming one. Duplicate cancels/books collapse; a rebook
 * after a cancel (different last event_type) emits; cancel → book → cancel emits.
 *
 * appointment_id (null on 100% of appointment events today; Mark is fixing the
 * GHL side in parallel) makes an event PERMANENTLY idempotent — a given
 * appointment is booked once and cancelled once — so no time window is applied
 * when it is present. If reschedule semantics ever reuse an appointment id, THIS
 * is the line to revisit.
 *
 * FAIL-OPEN everywhere: no supabase, or any query error/timeout → deduped:false
 * (emit). A duplicate event is recoverable; a lost booking is not. The `client`
 * option injects a supabase client for unit tests; production passes none.
 */

import defaultSupabase from '../supabase.js';

// Sliding window for the slot lookup. Ignored when appointment_id is present
// (permanent idempotency). Default 60 min.
const DEFAULT_WINDOW_MINUTES = Math.max(
  1,
  parseInt(process.env.APPT_DEDUP_WINDOW_MINUTES || '60', 10),
);

// Per-call ceiling on the dedup lookup, mirroring event-emitter's withTimeout
// (the Supabase JS client has no abort; a hung select would otherwise stall the
// webhook ack). On timeout the caller's catch fails open → emit.
const DEDUP_TIMEOUT_MS = parseInt(process.env.EMIT_EVENT_TIMEOUT_MS || '6000', 10);

function withTimeout(promise, label, ms = DEDUP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Namespace for the appointment-id key family. Shared verbatim with the
 * lp_mcp producer in actions/handlers/appointments.js — see
 * buildApptEventIdempotencyKey. The literal reads "booked" for historical
 * reasons (it is the key that producer has written since 2026-08-13); the
 * real status lives in its own segment, so cancels never collide with books.
 */
const APPT_ID_KEY_PREFIX = 'ghl_appt_booked';

/**
 * Stable logical key for an appointment slot — NO status segment.
 * Prefers the real appointment id; until GHL sends it, falls back to the
 * appointment's identity: calendar + date + start time.
 *
 * 2026-08-27: the appointment-id branch is namespaced under
 * APPT_ID_KEY_PREFIX so the two producers of ghl.appointment_booked write the
 * SAME stored key and collide on the unique index (see
 * buildApptEventIdempotencyKey). checkApptEventDedup's LIKE lookup below is
 * still prefixed with this slot key, so its own sequence-aware dedup is
 * unchanged. The contact id leaves this branch — a GHL appointment id is
 * globally unique, and the lookup is still scoped by .eq('entity_id', ...).
 * The no-appointment-id fallback is untouched.
 */
export function buildApptSlotKey({ contactId, calendarId, appointmentId, startDate, startTime }) {
  if (appointmentId) return `${APPT_ID_KEY_PREFIX}:${appointmentId}`;
  return `ghl_appt_${contactId}_slot:${calendarId || 'nocal'}:${startDate || 'nodate'}:${startTime || 'notime'}`;
}

/**
 * The STORED idempotency key for an appointment event, shared by both
 * producers of ghl.appointment_booked so one appointment yields one event.
 *
 * Verified 2026-08-27: system_events 3173274 (source lp_mcp, key
 * `ghl_appt_booked:08ZumfzoGu2Opn8VHIlp`) and 3173275 (source ghl_webhook, key
 * `ghl_appt_q5GehRye7DNkN6jlmjl3_id:08ZumfzoGu2Opn8VHIlp_booked_1787793611613`)
 * describe the SAME appointment at the same start time. Different keys → both
 * inserted → rule 112 GHL_APPT_LP_SYNC fired twice → agent_actions 367235 and
 * 367236 both wrote to LP and both carded. All four lp_mcp events in the
 * trailing fortnight were duplicates of a ghl_webhook twin.
 *
 * The three segments are exactly the fact "this appointment, in this state, at
 * this time":
 *   - appointmentId — the appointment's identity.
 *   - status — the booked/cancelled fact as carried on the event PAYLOAD, which
 *     both producers already set identically (lp_mcp hardcodes 'booked' and
 *     puts GHL's own appointmentStatus in a separate ghl_status field; the
 *     webhook producer's value tracks its event type). NEVER pass ghl_status
 *     here: on the reference pair above it read "new" on one side and would
 *     have made the two keys differ forever.
 *   - startDate + startTime — so a genuine RESCHEDULE emits a new event rather
 *     than being swallowed. Do not key on appointment id alone. Both producers
 *     were verified to render these identically ("2026-08-28", "6:00 PM") on
 *     every duplicate pair on record.
 *
 * Returns null when there is no appointment id — the caller keeps its own
 * existing fallback key, which is deliberately collision-free because the
 * slot-lookup path in checkApptEventDedup does that dedup instead.
 */
export function buildApptEventIdempotencyKey({ appointmentId, status, startDate, startTime }) {
  if (!appointmentId) return null;
  const start = [startDate, startTime].filter(Boolean).join(' ');
  return `${APPT_ID_KEY_PREFIX}:${appointmentId}:${status || 'booked'}:${start}`;
}

/**
 * Decide whether this appointment event is a duplicate of the most recent event
 * for the same slot.
 *
 * @returns {Promise<{ deduped: boolean, slotKey: string, idempotencyKey: string,
 *   matchedAgeMs: (number|null), reason: string }>}
 *   deduped:true only when a same-slot row exists (inside the window unless
 *   appointmentId is present) whose event_type equals `eventType`. All error
 *   paths fail OPEN (deduped:false).
 */
export async function checkApptEventDedup(
  { contactId, calendarId, appointmentId, startDate, startTime, status, eventType },
  { client, windowMinutes = DEFAULT_WINDOW_MINUTES } = {},
) {
  const supabase = client ?? defaultSupabase;
  const slotKey = buildApptSlotKey({ contactId, calendarId, appointmentId, startDate, startTime });
  // status stays in the STORED key for forensics; it is NOT part of the lookup
  // prefix (LIKE `${slotKey}_%` matches both shapes below — `_` is a
  // single-character wildcard, so the `:` separator matches it).
  //
  // With an appointment id the stored key is the SHARED, deterministic one so
  // the other producer of this event collides with us on the unique index
  // rather than inserting a twin. Without one there is nothing stable to agree
  // on, so Date.now() keeps emitEvent's unique-key insert from colliding and
  // the slot lookup above is what dedups.
  const idempotencyKey = buildApptEventIdempotencyKey({ appointmentId, status, startDate, startTime })
    || `${slotKey}_${status}_${Date.now()}`;
  const open = (reason) => ({ deduped: false, slotKey, idempotencyKey, matchedAgeMs: null, reason });

  if (!supabase) return open('no_supabase_open');
  if (!contactId) return open('no_contact_open');

  const useWindow = !appointmentId; // appointmentId present → permanent idempotency

  try {
    // Most recent event for this slot, ANY status. entity_id is the contactId
    // emitEvent stores (String-coerced) and is indexed — it bounds the LIKE so
    // there is no cross-contact overmatch. The LIKE underscores are not escaped:
    // this matches the existing .like('rule_applied','LP_DISP_%') convention
    // (decision-engine.js), and with the entity_id filter plus the structural
    // literals (calendar/date/time) in slotKey a cross-slot false match is
    // impossible.
    let query = supabase
      .from('system_events')
      .select('id, created_at, event_type')
      .eq('entity_id', String(contactId))
      .like('idempotency_key', `${slotKey}_%`)
      .order('created_at', { ascending: false })
      .limit(1);
    if (useWindow) {
      const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
      query = query.gte('created_at', windowStart);
    }

    const { data, error } = await withTimeout(query, 'checkApptEventDedup.lookup');
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.event_type === eventType) {
      const matchedAgeMs = row.created_at ? Date.now() - new Date(row.created_at).getTime() : null;
      return { deduped: true, slotKey, idempotencyKey, matchedAgeMs, reason: 'same_slot_same_event_type' };
    }
    return open(row ? 'last_event_differs' : 'no_prior_event');
  } catch (err) {
    console.warn(`[apptEventDedup] lookup failed for ${contactId} slot=${slotKey} (fail-open, emitting): ${err.message}`);
    return open('error_open');
  }
}

export default { buildApptSlotKey, buildApptEventIdempotencyKey, checkApptEventDedup };
