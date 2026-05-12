/**
 * Nurture Engagement — src/nurture/nurture-engagement.js
 *
 * Receives email-event webhooks from GHL and writes them to
 * agentic_messages. Drives every §14 learning loop in the S4.5 v1
 * architecture spec.
 *
 * Endpoint:
 *   POST /api/agentic/messages/engagement
 *
 * Request body (flat, or wrapped under customData — same four shapes the
 * generate endpoint accepts):
 *   {
 *     "generation_id": "gen_xxx",        // required, joins to agentic_messages
 *     "event":         "opened" | "clicked" | "replied" |
 *                      "unsubscribed" | "bounced" | "booking",
 *     "occurred_at":   "2026-05-11T22:00:00Z",  // optional, defaults now()
 *     "payload":       { ... }            // optional, ignored for v1
 *   }
 *
 * Event resolution is forgiving — see resolveEvent() below. We accept:
 *   - Canonical names: opened, clicked, replied, unsubscribed, bounced, booking
 *   - GHL trigger-name format: "Opened Email", "Clicked Email Link",
 *     "Replied to Email", "Unsubscribed from Email", "Booked Appointment"
 *   - Mailgun raw values: opened, clicked, unsubscribed, complained, etc.
 *   - Fuzzy substring fallback: any string containing "open", "click",
 *     "reply", "unsub", "bounce", or "book" maps to the obvious column.
 *
 * Response (always 200 — GHL workflows can't handle non-200 cleanly):
 *   { ok: true, generation_id, event, resolved_column, occurred_at,
 *     applied, reason? }
 *
 * Semantics:
 *   - First-touch wins. If `opened_at` is already set, a second "opened"
 *     event leaves the timestamp alone and reports applied=false,
 *     reason="opened_at_already_set". This matches standard email
 *     tracking convention — the first open is the meaningful signal;
 *     subsequent pixel fires are noise.
 *   - booking_attributed is binary; once true, stays true. Re-firing
 *     reports applied=false, reason="booking_already_attributed".
 *   - Unknown event names log and return applied=false with the reason.
 *   - generation_id not found → applied=false, reason="generation_id_not_found".
 *     This is treated as a soft miss (could be a stale GHL webhook for
 *     a contact whose audit row was already deleted) — still returns 200.
 *
 * Auth: optional bearer via MESSAGE_ENGINE_TOKEN, same posture as the
 * generate endpoint.
 */

import supabase from '../supabase.js';

// Direct event-name lookups → the column we write.
// Includes:
//   - canonical names (opened, clicked, replied, unsubscribed, bounced)
//   - mailgun raw event values (open, click, complained, etc.)
//   - GHL trigger-name format produced by {{workflow.trigger_name}} after
//     our normalizeEvent() runs ("Opened Email" → opened_email)
const EVENT_TO_COLUMN = {
  // Canonical + mailgun raw
  opened:        'opened_at',
  open:          'opened_at',
  email_opened:  'opened_at',
  clicked:       'clicked_at',
  click:         'clicked_at',
  email_clicked: 'clicked_at',
  link_clicked:  'clicked_at',
  replied:       'replied_at',
  reply:         'replied_at',
  email_replied: 'replied_at',
  customer_replied: 'replied_at',
  customer_reply:   'replied_at',
  unsubscribed:   'unsubscribed_at',
  unsubscribe:    'unsubscribed_at',
  complained:     'unsubscribed_at',
  // Hard bounces share the unsubscribed_at slot for v1. Both mean
  // "no longer reachable" for retention purposes. Separate column
  // would be a v2 schema change.
  bounced:        'unsubscribed_at',
  bounce:         'unsubscribed_at',

  // GHL trigger-name format — what Mark configured in workflow
  // 59fd6298 ("I-S4.5R - Agentic Seinfeld Engagement Tracker") when
  // the webhook sends event = {{workflow.trigger_name}}.
  opened_email:                     'opened_at',
  clicked_email_link:               'clicked_at',
  email_link_clicked:               'clicked_at',
  replied_to_email:                 'replied_at',
  email_replied_to:                 'replied_at',
  unsubscribed_from_email:          'unsubscribed_at',
  email_unsubscribed:               'unsubscribed_at',
  bounced_email:                    'unsubscribed_at',
  email_bounced:                    'unsubscribed_at',
};

// Booking gets a separate column pair, set together.
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
 * Resolve an event string to either a column name (for engagement
 * timestamps) or the sentinel 'BOOKING' (for booking attribution).
 * Returns null if no match.
 *
 * Resolution order:
 *   1. Exact lookup in EVENT_TO_COLUMN (covers ~25 known strings)
 *   2. Exact membership in BOOKING_EVENTS
 *   3. Fuzzy substring fallback — keyword "book" wins over the others
 *      because "booked the appointment" contains both "book" AND
 *      potentially others by accident. Otherwise: open / click / reply /
 *      unsub / bounce in declared priority.
 *
 * Returns { column, fuzzy } shape so the caller can log how it resolved.
 */
function resolveEvent(event) {
  if (!event) return null;

  // Exact matches first.
  if (EVENT_TO_COLUMN[event]) {
    return { column: EVENT_TO_COLUMN[event], fuzzy: false, booking: false };
  }
  if (BOOKING_EVENTS.has(event)) {
    return { column: null, fuzzy: false, booking: true };
  }

  // Fuzzy fallback. Booking checked first because "book" is the most
  // semantically distinctive — "booked the appointment" contains it
  // unambiguously, and we want to attribute even if the trigger gets
  // renamed in GHL.
  if (event.includes('book') || event.includes('appoint')) {
    return { column: null, fuzzy: true, booking: true };
  }
  if (event.includes('unsub') || event.includes('complain')) {
    return { column: 'unsubscribed_at', fuzzy: true, booking: false };
  }
  if (event.includes('bounce')) {
    return { column: 'unsubscribed_at', fuzzy: true, booking: false };
  }
  if (event.includes('open')) {
    return { column: 'opened_at', fuzzy: true, booking: false };
  }
  if (event.includes('click')) {
    return { column: 'clicked_at', fuzzy: true, booking: false };
  }
  if (event.includes('reply') || event.includes('replied')) {
    return { column: 'replied_at', fuzzy: true, booking: false };
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

async function applyEngagement(generation_id, resolution, occurred_at) {
  if (!supabase) {
    return { applied: false, reason: 'supabase_not_configured' };
  }

  // Look up the audit row.
  const { data: row, error: fetchErr } = await supabase
    .from('agentic_messages')
    .select('id, generation_id, ghl_contact_id, workflow_code, opened_at, clicked_at, replied_at, unsubscribed_at, booking_attributed, booking_attributed_at')
    .eq('generation_id', generation_id)
    .maybeSingle();

  if (fetchErr) {
    return { applied: false, reason: `fetch_error:${fetchErr.message.slice(0, 100)}` };
  }
  if (!row) {
    return { applied: false, reason: 'generation_id_not_found' };
  }

  const update = {};

  if (resolution.booking) {
    if (row.booking_attributed === true) {
      return {
        applied: false,
        reason: 'booking_already_attributed',
        row_id: row.id,
        contact_id: row.ghl_contact_id,
        workflow_code: row.workflow_code,
      };
    }
    update.booking_attributed = true;
    update.booking_attributed_at = occurred_at;
  } else {
    const column = resolution.column;
    if (row[column]) {
      // First-touch wins.
      return {
        applied: false,
        reason: `${column}_already_set`,
        row_id: row.id,
        contact_id: row.ghl_contact_id,
        workflow_code: row.workflow_code,
      };
    }
    update[column] = occurred_at;
  }

  update.updated_at = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from('agentic_messages')
    .update(update)
    .eq('generation_id', generation_id);

  if (updateErr) {
    return { applied: false, reason: `update_error:${updateErr.message.slice(0, 100)}` };
  }

  return {
    applied: true,
    row_id: row.id,
    contact_id: row.ghl_contact_id,
    workflow_code: row.workflow_code,
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

      if (!generation_id || typeof generation_id !== 'string') {
        return res.status(200).json({ ok: false, error: 'generation_id required' });
      }
      if (!event) {
        return res.status(200).json({ ok: false, error: 'event required' });
      }

      // Resolve event → column or BOOKING sentinel.
      const resolution = resolveEvent(event);
      if (!resolution) {
        console.log(`[NurtureEng] gen=${generation_id} event=${event} resolved=NONE applied=false reason=unknown_event`);
        return res.status(200).json({
          ok: true,
          generation_id,
          event,
          resolved_column: null,
          occurred_at,
          applied: false,
          reason: `unknown_event:${event}`,
          workflow_code: null,
        });
      }

      const result = await applyEngagement(generation_id, resolution, occurred_at);

      const resolvedLabel = resolution.booking
        ? `BOOKING${resolution.fuzzy ? ' (fuzzy)' : ''}`
        : `${resolution.column}${resolution.fuzzy ? ' (fuzzy)' : ''}`;
      console.log(`[NurtureEng] gen=${generation_id} event=${event} resolved=${resolvedLabel} applied=${result.applied} reason=${result.reason || '-'} contact=${result.contact_id || '-'}`);

      res.status(200).json({
        ok: true,
        generation_id,
        event,
        resolved_column: resolution.booking ? 'booking_attributed' : resolution.column,
        resolution_fuzzy: resolution.fuzzy,
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

  console.log('[REST API] Registered: POST /api/agentic/messages/engagement (nurture engagement)');
}
