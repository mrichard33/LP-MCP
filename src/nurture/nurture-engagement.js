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
 * Response (always 200 — GHL workflows can't handle non-200 cleanly):
 *   { ok: true, generation_id, event, occurred_at, applied, reason? }
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

// Map common event aliases → the column we write.
const EVENT_TO_COLUMN = {
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
  unsubscribed:   'unsubscribed_at',
  unsubscribe:    'unsubscribed_at',
  // Hard bounces are not unsubscribes, but for v1 we record them in the
  // same slot so we can see "no longer reachable" without adding a new
  // column. Revisit if we need to separate them later.
  bounced:        'unsubscribed_at',
  bounce:         'unsubscribed_at',
};

// Booking gets a separate column pair, set together.
const BOOKING_EVENTS = new Set([
  'booking', 'booked',
  'appointment_booked', 'appt_booked',
  'stage_appt_booked',
]);

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

async function applyEngagement(generation_id, event, occurred_at) {
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

  if (BOOKING_EVENTS.has(event)) {
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
    const column = EVENT_TO_COLUMN[event];
    if (!column) {
      return { applied: false, reason: `unknown_event:${event}` };
    }
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

      const result = await applyEngagement(generation_id, event, occurred_at);

      console.log(`[NurtureEng] gen=${generation_id} event=${event} applied=${result.applied} reason=${result.reason || '-'} contact=${result.contact_id || '-'}`);

      res.status(200).json({
        ok: true,
        generation_id,
        event,
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
