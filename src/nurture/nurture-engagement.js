/**
 * Nurture Engagement — src/nurture/nurture-engagement.js
 *
 * Receives email-event webhooks from GHL (typically workflow
 * `I.ENG-S4.5R Agentic Seinfeld Engagement Tracker` 59fd6298) and
 * writes them to agentic_messages. Drives every §14 learning loop
 * in the S4.5 v1 architecture spec.
 *
 * Endpoint:
 *   POST /api/agentic/messages/engagement
 *
 * Request body (flat, or wrapped under customData — same four shapes
 * the generate endpoint accepts):
 *   {
 *     "generation_id": "gen_xxx",        // required, joins to agentic_messages
 *     "event":         "sent" | "opened" | "clicked" | "replied" |
 *                      "unsubscribed" | "bounced" | "booking",
 *     "occurred_at":   "2026-05-11T22:00:00Z",  // optional, defaults now()
 *     "payload":       { ... }            // optional, passed through to system_events
 *   }
 *
 * Event resolution is forgiving — see resolveEvent() below. We accept:
 *   - Canonical names: sent, opened, clicked, replied, unsubscribed, bounced, booking
 *   - GHL trigger-name format: "Sent Email", "Opened Email", "Clicked Email Link",
 *     "Replied to Email", "Unsubscribed from Email", "Bounced Email",
 *     "Booked Appointment"
 *   - Mailgun raw values: delivered, opened, clicked, unsubscribed, complained, etc.
 *   - Fuzzy substring fallback for anything containing one of the
 *     keywords: sent/delivered, open, click, reply, unsub, bounce, book.
 *
 * Response (always 200 — GHL workflows can't handle non-200 cleanly):
 *   {
 *     ok:                true | false,
 *     generation_id,
 *     event,
 *     resolved_kind:     'sent' | 'opened' | 'clicked' | 'replied' |
 *                        'unsubscribed' | 'bounced' | 'booking' | null,
 *     resolved_column:   one of the agentic_messages timestamp columns | null,
 *     resolution_fuzzy:  boolean,
 *     state_transition:  'ghl_sent_confirmed' | 'ghl_send_failed' | null,
 *     emitted_event:     'nurture.reply_received' | 'nurture.unsubscribed' | null,
 *     occurred_at,
 *     applied,
 *     reason?
 *   }
 *
 * Semantics:
 *
 *   FIRST-TOUCH WINS on engagement timestamps. If `opened_at` is
 *   already set, a second "opened" event leaves the timestamp alone
 *   and reports applied=false, reason="opened_at_already_set". This
 *   matches standard email-tracking convention — the first open is
 *   the meaningful signal; subsequent pixel fires are noise.
 *
 *   STATE TRANSITIONS (added v2, 2026-05-12):
 *     - `sent` event → if current send_status ∈ {pending, generated_ready},
 *       transition to `ghl_sent_confirmed` AND stamp ghl_sent_at. Idempotent
 *       on subsequent sent events.
 *     - `bounced` event → transition to `ghl_send_failed` AND stamp
 *       ghl_sent_at (so the failure timestamp lands somewhere). Allowed
 *       to transition out of ghl_sent_confirmed (bounce after delivery is
 *       a real case). NOT allowed to transition out of ghl_send_failed
 *       (idempotent).
 *     - Other events do NOT touch send_status. Opened/clicked/replied/
 *       unsubscribed are post-send signals and the state machine is
 *       already past send confirmation by then.
 *
 *   SYSTEM EVENTS EMITTED (added v2, 2026-05-12):
 *     - `replied` event → emits `nurture.reply_received` so the Decision
 *       Engine can pause the active S4.5 cadence (cadence-pause rule TBD).
 *       Distinct from `ghl.reply_received` which fires on ANY inbound
 *       reply (SMS or email) via behavioral-emitter; `nurture.reply_received`
 *       fires only on replies attributable to an agentic generation.
 *     - `unsubscribed` event → emits `nurture.unsubscribed`. Decision
 *       Engine can route this to DNC handling.
 *     - Events are idempotent via idempotency_key keyed on generation_id.
 *
 *   BOOKING ATTRIBUTION is binary; once true, stays true. Re-firing
 *   reports applied=false, reason="booking_already_attributed".
 *
 *   UNKNOWN event names log and return applied=false with the reason.
 *
 *   GENERATION_ID NOT FOUND → applied=false, reason="generation_id_not_found".
 *     Treated as a soft miss (could be a stale GHL webhook for a contact
 *     whose audit row was deleted) — still returns 200.
 *
 * Auth: optional bearer via MESSAGE_ENGINE_TOKEN, same posture as the
 * generate endpoint.
 *
 * GHL workflow wiring (workflow 59fd6298 `I.ENG-S4.5R`):
 *   Branches POSTing to /api/agentic/messages/engagement, currently
 *   covering 5/6 events:
 *     - "Unsubscribed from email"   → unsubscribed
 *     - "Replied to email"          → replied
 *     - "Booked appointment"        → booking
 *     - "Clicked email link"        → clicked
 *     - "Opened email" (else)       → opened
 *   MISSING branches (need to be added in GHL UI):
 *     - "Email Sent" trigger        → event: "email_sent"
 *     - "Email Bounced" trigger     → event: "email_bounced"
 *   Without these, the `sent` and `bounced` paths exist in code but
 *   no producer fires them, so 0 rows reach `ghl_sent_confirmed` /
 *   `ghl_send_failed` via the natural pipeline. The docs/ folder has
 *   a build guide for adding them.
 *
 * v1 — 2026-05-11. Initial implementation: timestamp stamping only,
 *   no state transitions, no event emission, bounced shared
 *   unsubscribed_at column.
 *
 * v2 — 2026-05-12. STATE TRANSITIONS + SYSTEM EVENTS. Closes the
 *   downstream half of the MSG-002 send lifecycle:
 *     - Added `sent` event support (transitions to ghl_sent_confirmed)
 *     - Separated `bounced` from `unsubscribed` (transitions to
 *       ghl_send_failed instead of writing unsubscribed_at)
 *     - Emits nurture.reply_received / nurture.unsubscribed system_events
 *       for Decision Engine pickup
 *     - State transition guards (no downgrades out of terminal states)
 *   Resolves audit finding 2026-05-12 that 0 rows ever reached
 *   ghl_sent_confirmed despite 5 opened + 2 clicked engagement events.
 */

import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';

// Event resolution kinds. Each kind has a deterministic effect:
//   timestamp — stamp the named column with occurred_at (first-touch wins)
//   booking   — set booking_attributed=true + booking_attributed_at (once)
//   sent      — stamp ghl_sent_at + transition state to ghl_sent_confirmed
//   bounced   — stamp ghl_sent_at + transition state to ghl_send_failed
//
// `column` is null for booking (uses booking_attributed instead) and
// applies to the underlying timestamp slot for timestamp/sent/bounced.

// Direct event-name lookups → { kind, column }.
// Each row's `column` is the agentic_messages timestamp column written.
// `kind` drives state transitions and event emissions.
//
// Includes:
//   - canonical names (sent, opened, clicked, replied, unsubscribed, bounced)
//   - mailgun raw event values (open, click, complained, delivered, etc.)
//   - GHL trigger-name format produced by {{workflow.trigger_name}} after
//     normalizeEvent() runs ("Opened Email" → opened_email).
const EVENT_RESOLUTIONS = {
  // ── SENT / DELIVERED ─────────────────────────────────────────────
  // Transitions send_status to ghl_sent_confirmed.
  sent:            { kind: 'sent', column: 'ghl_sent_at' },
  email_sent:      { kind: 'sent', column: 'ghl_sent_at' },
  sent_email:      { kind: 'sent', column: 'ghl_sent_at' },
  delivered:       { kind: 'sent', column: 'ghl_sent_at' },
  email_delivered: { kind: 'sent', column: 'ghl_sent_at' },
  delivered_email: { kind: 'sent', column: 'ghl_sent_at' },

  // ── OPENED ───────────────────────────────────────────────────────
  opened:          { kind: 'timestamp', column: 'opened_at' },
  open:            { kind: 'timestamp', column: 'opened_at' },
  email_opened:    { kind: 'timestamp', column: 'opened_at' },
  opened_email:    { kind: 'timestamp', column: 'opened_at' },

  // ── CLICKED ──────────────────────────────────────────────────────
  clicked:               { kind: 'timestamp', column: 'clicked_at' },
  click:                 { kind: 'timestamp', column: 'clicked_at' },
  email_clicked:         { kind: 'timestamp', column: 'clicked_at' },
  link_clicked:          { kind: 'timestamp', column: 'clicked_at' },
  clicked_email_link:    { kind: 'timestamp', column: 'clicked_at' },
  email_link_clicked:    { kind: 'timestamp', column: 'clicked_at' },

  // ── REPLIED ──────────────────────────────────────────────────────
  // Emits nurture.reply_received for Decision Engine cadence pause.
  replied:           { kind: 'reply', column: 'replied_at' },
  reply:             { kind: 'reply', column: 'replied_at' },
  email_replied:     { kind: 'reply', column: 'replied_at' },
  email_replied_to:  { kind: 'reply', column: 'replied_at' },
  replied_to_email:  { kind: 'reply', column: 'replied_at' },
  customer_replied:  { kind: 'reply', column: 'replied_at' },
  customer_reply:    { kind: 'reply', column: 'replied_at' },

  // ── UNSUBSCRIBED ─────────────────────────────────────────────────
  // Emits nurture.unsubscribed for Decision Engine DNC handling.
  unsubscribed:               { kind: 'unsub', column: 'unsubscribed_at' },
  unsubscribe:                { kind: 'unsub', column: 'unsubscribed_at' },
  complained:                 { kind: 'unsub', column: 'unsubscribed_at' },
  unsubscribed_from_email:    { kind: 'unsub', column: 'unsubscribed_at' },
  email_unsubscribed:         { kind: 'unsub', column: 'unsubscribed_at' },

  // ── BOUNCED ──────────────────────────────────────────────────────
  // v2 split: bounced now transitions to ghl_send_failed instead of
  // sharing unsubscribed_at. ghl_sent_at carries the failure timestamp
  // (it's "when did this message's send-or-fail event land").
  bounced:        { kind: 'bounce', column: 'ghl_sent_at' },
  bounce:         { kind: 'bounce', column: 'ghl_sent_at' },
  bounced_email:  { kind: 'bounce', column: 'ghl_sent_at' },
  email_bounced:  { kind: 'bounce', column: 'ghl_sent_at' },
};

// Booking gets its own kind because its database side is a boolean +
// timestamp pair, not a single column.
const BOOKING_EVENTS = new Set([
  'booking', 'booked',
  'appointment_booked', 'appt_booked',
  'stage_appt_booked',
  // GHL trigger-name format variants
  'booked_appointment',
  'main_appointment_booked',
  'booked_main_appointment',
  'appointment',
]);

/**
 * Resolve an event string to a resolution descriptor:
 *   { kind, column, fuzzy, booking }
 *
 * - kind:    'timestamp' | 'sent' | 'bounce' | 'reply' | 'unsub' | 'booking' | null
 * - column:  the agentic_messages timestamp column to write (null for booking)
 * - fuzzy:   true if matched via substring fallback (logged for diagnostics)
 * - booking: true when kind === 'booking' (convenience flag, preserved
 *            from v1 callers)
 *
 * Resolution order:
 *   1. Exact lookup in EVENT_RESOLUTIONS (covers ~30 known strings)
 *   2. Exact membership in BOOKING_EVENTS
 *   3. Fuzzy substring fallback in priority order:
 *        book/appoint → booking (most semantically distinctive)
 *        unsub/complain → unsubscribed
 *        bounce → bounced
 *        sent/deliver → sent (must come BEFORE 'open' because some
 *                              GHL trigger names like "Sent Email" don't
 *                              contain 'open' but we want sent priority)
 *        open → opened
 *        click → clicked
 *        reply → replied
 */
function resolveEvent(event) {
  if (!event) return null;

  // Exact matches first.
  const exact = EVENT_RESOLUTIONS[event];
  if (exact) {
    return { kind: exact.kind, column: exact.column, fuzzy: false, booking: false };
  }
  if (BOOKING_EVENTS.has(event)) {
    return { kind: 'booking', column: null, fuzzy: false, booking: true };
  }

  // Fuzzy fallback.
  if (event.includes('book') || event.includes('appoint')) {
    return { kind: 'booking', column: null, fuzzy: true, booking: true };
  }
  if (event.includes('unsub') || event.includes('complain')) {
    return { kind: 'unsub', column: 'unsubscribed_at', fuzzy: true, booking: false };
  }
  if (event.includes('bounce')) {
    return { kind: 'bounce', column: 'ghl_sent_at', fuzzy: true, booking: false };
  }
  // 'sent' and 'deliver' before 'open' — some GHL trigger strings
  // contain both keywords, and sent/delivered should win.
  if (event.includes('sent') || event.includes('deliver')) {
    return { kind: 'sent', column: 'ghl_sent_at', fuzzy: true, booking: false };
  }
  if (event.includes('open')) {
    return { kind: 'timestamp', column: 'opened_at', fuzzy: true, booking: false };
  }
  if (event.includes('click')) {
    return { kind: 'timestamp', column: 'clicked_at', fuzzy: true, booking: false };
  }
  if (event.includes('reply') || event.includes('replied')) {
    return { kind: 'reply', column: 'replied_at', fuzzy: true, booking: false };
  }

  return null;
}

/**
 * Defensively unwrap body. Same shape catalog as the generate endpoint
 * (extractRequestFields in nurture-orchestrator.js): flat, customData
 * object, customData stringified JSON, customData array of {key,value}.
 */
function extractEngagementFields(body) {
  if (!body || typeof body !== 'object') return {};
  let merged = { ...body };
  const cd = body.customData;
  if (cd === undefined || cd === null) return merged;

  let cdFlat = null;
  if (typeof cd === 'object' && !Array.isArray(cd)) {
    cdFlat = cd;
  } else if (typeof cd === 'string') {
    const trimmed = cd.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cdFlat = parsed;
        }
      } catch { /* not JSON — fall through */ }
    }
  } else if (Array.isArray(cd)) {
    cdFlat = {};
    for (const pair of cd) {
      if (pair && typeof pair === 'object' && typeof pair.key === 'string') {
        cdFlat[pair.key] = pair.value;
      }
    }
  }
  if (cdFlat) merged = { ...merged, ...cdFlat };
  return merged;
}

function normalizeEvent(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseOccurredAt(raw) {
  if (!raw) return new Date().toISOString();
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Determine the state transition for a sent/bounced event based on the
 * current row's send_status. Returns the target status or null (no
 * transition).
 *
 * Rules:
 *   sent event:
 *     pending          → ghl_sent_confirmed  (shadow-mode approved row)
 *     generated_ready  → ghl_sent_confirmed  (standard path)
 *     ghl_sent_confirmed → null              (idempotent)
 *     ghl_send_failed  → null                (once failed, don't reverse)
 *     suppressed_*     → null                (sent event for a suppressed
 *                                              row is anomalous; ignore the
 *                                              transition but stamp ghl_sent_at)
 *     failed_generation → null               (same — anomalous)
 *     cancelled_state_change → null
 *
 *   bounce event:
 *     ghl_send_failed  → null                (idempotent)
 *     anything else    → ghl_send_failed     (bounce always wins)
 */
function decideStateTransition(currentStatus, kind) {
  if (kind === 'sent') {
    if (currentStatus === 'pending' || currentStatus === 'generated_ready') {
      return 'ghl_sent_confirmed';
    }
    return null;
  }
  if (kind === 'bounce') {
    if (currentStatus === 'ghl_send_failed') return null;
    return 'ghl_send_failed';
  }
  return null;
}

/**
 * Apply an engagement event to a single agentic_messages row.
 *
 * @returns {Promise<object>} Result object with:
 *   applied:              boolean
 *   reason:               string (when applied=false, why)
 *   row_id:               UUID
 *   contact_id:           GHL contact id
 *   workflow_code:        e.g. 'S4.5'
 *   state_transition:     new send_status if transitioned, else null
 *   prior_status:         send_status before this event
 *   emitted_event:        'nurture.reply_received' | 'nurture.unsubscribed' | null
 */
async function applyEngagement(generation_id, resolution, occurred_at, payload) {
  if (!supabase) {
    return { applied: false, reason: 'supabase_not_configured' };
  }

  const { data: row, error: fetchErr } = await supabase
    .from('agentic_messages')
    .select(
      'id, generation_id, ghl_contact_id, workflow_code, send_status, '
      + 'ghl_sent_at, opened_at, clicked_at, replied_at, unsubscribed_at, '
      + 'booking_attributed, booking_attributed_at'
    )
    .eq('generation_id', generation_id)
    .maybeSingle();

  if (fetchErr) {
    return { applied: false, reason: `fetch_error:${fetchErr.message.slice(0, 100)}` };
  }
  if (!row) {
    return { applied: false, reason: 'generation_id_not_found' };
  }

  const update = {};
  const priorStatus = row.send_status;
  let stateTransition = null;

  // ─── BOOKING ATTRIBUTION ──────────────────────────────────────────
  if (resolution.kind === 'booking') {
    if (row.booking_attributed === true) {
      return {
        applied: false,
        reason: 'booking_already_attributed',
        row_id: row.id,
        contact_id: row.ghl_contact_id,
        workflow_code: row.workflow_code,
        prior_status: priorStatus,
        state_transition: null,
        emitted_event: null,
      };
    }
    update.booking_attributed = true;
    update.booking_attributed_at = occurred_at;
  } else {
    // ─── TIMESTAMP / SENT / BOUNCE / REPLY / UNSUB ──────────────────
    // All write to a single timestamp column. First-touch wins on
    // engagement columns; ghl_sent_at can be re-stamped on bounce after
    // a prior sent event (last-write-wins for the failure case).
    const column = resolution.column;
    const isFailurePath = resolution.kind === 'bounce';

    if (row[column] && !isFailurePath) {
      // First-touch wins.
      return {
        applied: false,
        reason: `${column}_already_set`,
        row_id: row.id,
        contact_id: row.ghl_contact_id,
        workflow_code: row.workflow_code,
        prior_status: priorStatus,
        state_transition: null,
        emitted_event: null,
      };
    }
    update[column] = occurred_at;

    // State transition for sent/bounce events.
    stateTransition = decideStateTransition(priorStatus, resolution.kind);
    if (stateTransition) {
      update.send_status = stateTransition;
    }
  }

  update.updated_at = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from('agentic_messages')
    .update(update)
    .eq('generation_id', generation_id);

  if (updateErr) {
    return { applied: false, reason: `update_error:${updateErr.message.slice(0, 100)}` };
  }

  // ─── SYSTEM EVENT EMISSION (post-update) ──────────────────────────
  // Reply and unsubscribed events feed the Decision Engine. These are
  // distinct from `ghl.reply_received` (any inbound reply) — they fire
  // only when a reply is attributable to an agentic generation, which
  // is the signal the cadence-pause rule actually wants.
  let emittedEvent = null;
  if (resolution.kind === 'reply') {
    await emitEvent({
      event_type: 'nurture.reply_received',
      source: 'agentic_messages_engagement',
      entity_type: 'contact',
      entity_id: row.ghl_contact_id,
      ghl_contact_id: row.ghl_contact_id,
      payload: {
        generation_id,
        workflow_code: row.workflow_code,
        occurred_at,
        // Pass through any GHL-supplied payload for analyzer downstream
        // (e.g. message text, subject the contact replied to).
        ghl_payload: payload || null,
      },
      priority: 'high',
      // One reply event per generation; multiple replies collapse to
      // the first one for Decision Engine purposes. The cadence-pause
      // rule fires once.
      idempotency_key: `nurture_reply_${generation_id}`,
    });
    emittedEvent = 'nurture.reply_received';
  } else if (resolution.kind === 'unsub') {
    await emitEvent({
      event_type: 'nurture.unsubscribed',
      source: 'agentic_messages_engagement',
      entity_type: 'contact',
      entity_id: row.ghl_contact_id,
      ghl_contact_id: row.ghl_contact_id,
      payload: {
        generation_id,
        workflow_code: row.workflow_code,
        occurred_at,
      },
      priority: 'critical',
      idempotency_key: `nurture_unsub_${generation_id}`,
    });
    emittedEvent = 'nurture.unsubscribed';
  }

  return {
    applied: true,
    row_id: row.id,
    contact_id: row.ghl_contact_id,
    workflow_code: row.workflow_code,
    prior_status: priorStatus,
    state_transition: stateTransition,
    emitted_event: emittedEvent,
  };
}

export function registerEngagementRoutes(app) {
  app.post('/api/agentic/messages/engagement', async (req, res) => {
    // ─── Diagnostic — log inbound shape ─────────────────────────
    let cdShape = 'absent';
    try {
      const ct = req.headers['content-type'] || 'none';
      const raw = req.body || {};
      const rawKeyCount = Object.keys(raw).length;
      const cd = raw.customData;
      if (cd === undefined || cd === null) cdShape = 'absent';
      else if (Array.isArray(cd)) cdShape = `array[${cd.length}]`;
      else if (typeof cd === 'object') cdShape = `object{${Object.keys(cd).length}}`;
      else if (typeof cd === 'string') cdShape = `string[${cd.length}]`;
      else cdShape = typeof cd;
      console.log(`[NurtureEng] inbound ct="${ct}" rawKeys=${rawKeyCount} customData=${cdShape}`);
    } catch { /* diagnostic must never throw */ }

    try {
      const body = extractEngagementFields(req.body);

      // Optional bearer auth — matches the generate endpoint.
      const token = process.env.MESSAGE_ENGINE_TOKEN;
      if (token) {
        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (provided !== token) {
          return res.status(200).json({ ok: false, error: 'unauthorized' });
        }
      }

      const generation_id = body.generation_id;
      const event = normalizeEvent(body.event);
      const occurred_at = parseOccurredAt(body.occurred_at);
      const payload = (body.payload && typeof body.payload === 'object') ? body.payload : null;

      if (!generation_id || typeof generation_id !== 'string') {
        return res.status(200).json({ ok: false, error: 'generation_id required' });
      }
      if (!event) {
        return res.status(200).json({ ok: false, error: 'event required' });
      }

      // Resolve event → kind + column.
      const resolution = resolveEvent(event);
      if (!resolution) {
        console.log(`[NurtureEng] gen=${generation_id} event=${event} resolved=NONE applied=false reason=unknown_event`);
        return res.status(200).json({
          ok: true,
          generation_id,
          event,
          resolved_kind: null,
          resolved_column: null,
          resolution_fuzzy: false,
          state_transition: null,
          emitted_event: null,
          occurred_at,
          applied: false,
          reason: `unknown_event:${event}`,
          workflow_code: null,
        });
      }

      const result = await applyEngagement(generation_id, resolution, occurred_at, payload);

      // ─── Log line — make every relevant field visible at a glance ─
      const transitionLog = result.state_transition
        ? ` ${result.prior_status}→${result.state_transition}`
        : '';
      const emitLog = result.emitted_event ? ` emit=${result.emitted_event}` : '';
      const fuzzyLog = resolution.fuzzy ? ' (fuzzy)' : '';
      const resolvedLabel = resolution.kind === 'booking'
        ? `booking${fuzzyLog}`
        : `${resolution.kind}:${resolution.column}${fuzzyLog}`;
      console.log(`[NurtureEng] gen=${generation_id} event=${event} resolved=${resolvedLabel} applied=${result.applied}${transitionLog}${emitLog} reason=${result.reason || '-'} contact=${result.contact_id || '-'}`);

      res.status(200).json({
        ok: true,
        generation_id,
        event,
        resolved_kind: resolution.kind,
        resolved_column: resolution.kind === 'booking' ? 'booking_attributed' : resolution.column,
        resolution_fuzzy: resolution.fuzzy,
        state_transition: result.state_transition || null,
        prior_status: result.prior_status || null,
        emitted_event: result.emitted_event || null,
        occurred_at,
        applied: result.applied,
        reason: result.reason || null,
        workflow_code: result.workflow_code || null,
      });
    } catch (err) {
      console.error(`[NurtureEng] Unhandled: ${err.message}`);
      res.status(200).json({ ok: false, error: err.message });
    }
  });

  console.log('[REST API] Registered: POST /api/agentic/messages/engagement (nurture engagement v2)');
}

// Exported for tests / introspection.
export const _internal = {
  EVENT_RESOLUTIONS,
  BOOKING_EVENTS,
  resolveEvent,
  normalizeEvent,
  parseOccurredAt,
  decideStateTransition,
  extractEngagementFields,
};
