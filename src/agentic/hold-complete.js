/**
 * Hold-Complete / Hold-Error — src/agentic/hold-complete.js
 *
 * Intake for the universal "Agentic Dynamic Hold" GHL workflow (dfd3ffaa,
 * inbound trigger 4ec11a08-acaa-4159-8576-6ab63cc3a788, hold-hours field
 * MZkFWOFDzf8OKTy2O4od). The Dynamic Hold is the one "dumb clock": it parks a
 * contact for a dynamic number of hours, then POSTs here on expiry (or to
 * /api/agentic/hold-error if its Find-Contact step fails).
 *
 * ARCHITECTURE (2026-06-12)
 * ─────────────────────────
 * The hold pen carries no judgment — purpose travels in the payload (return_to,
 * hold_reason, workflow_code). On completion this endpoint emits an
 * `agentic.hold_completed` system_event and the Decision Engine decides what
 * happens next via rules keyed on event_subtype = return_to (the first consumer
 * is the S1.3 booking-push timeout → S2.2 path). This replaces the never-fully-
 * wired I.COOL cooling stack as the single timeout substrate.
 *
 * BACK-COMPAT RE-FIRE (S1.1 v2 suppression-hold loop)
 * ───────────────────────────────────────────────────
 * The original v1.0 behavior was a fire-and-forget re-POST to the source
 * workflow's GHL inbound-webhook trigger (S1.1 sends return_to = its real
 * trigger id and re-reads sequence_position on re-entry). That path is still
 * live, so we KEEP it — but only when the caller opts in:
 *   - body.refire === true                          → always re-fire
 *   - body.refire === false                         → never re-fire (event only)
 *   - otherwise: re-fire iff return_to is shaped like a real GHL trigger id
 *     (UUID / ~20-char token, NO underscores). Our logical return_to labels are
 *     snake_case (e.g. "booking_push_timeout_s13") → never re-fired, event only.
 * The event is ALWAYS emitted regardless of the re-fire decision.
 *
 * Auth: Bearer <MESSAGE_ENGINE_TOKEN> (same token the nurture generate route
 * checks). Always returns HTTP 200 (a GHL outbound webhook treats non-200 as a
 * failure to retry; we never want a retry storm). Failures are reported in the
 * body as { ok:false, error }.
 *
 * v2.0 — 2026-06-12. Event-emit model + hold-error route. Re-fire retained,
 *   gated, for the S1.1 loop. (v1.0 — 2026-06-04, re-fire only.)
 */

import { emitEvent } from '../event-emitter.js';
import { sendGroupMeMessage } from '../groupme.js';

const GHL_HOOK_BASE = 'https://services.leadconnectorhq.com/hooks';
const GHL_LOC_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

// A GHL inbound-webhook trigger id is a UUID or a ~20-char url-safe token.
// Crucially it has NO underscores — our logical return_to labels are snake_case
// (e.g. "booking_push_timeout_s13"), so the underscore is the discriminator
// between "re-fire this trigger" (S1.1 legacy) and "event-only" (new model).
function looksLikeTriggerId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9-]{8,40}$/.test(s.trim());
}

async function refireTrigger(triggerId, payload) {
  const url = `${GHL_HOOK_BASE}/${GHL_LOC_ID}/webhook-trigger/${triggerId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: text.slice(0, 200), url };
}

// Shared bearer check. Returns true if authorized (or no token configured, to
// match the nurture generate route's behavior). Responds with 200 + error body
// on mismatch so a GHL outbound webhook never enters a retry loop.
function checkBearer(req, res) {
  const token = process.env.MESSAGE_ENGINE_TOKEN;
  if (!token) return true;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (provided !== token) {
    res.status(200).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

export function registerHoldCompleteRoutes(app) {
  app.post('/api/agentic/hold-complete', async (req, res) => {
    if (!checkBearer(req, res)) return;

    const body = req.body || {};
    const contactId = body.contact_id;
    const returnTo = typeof body.return_to === 'string' ? body.return_to.trim() : '';

    if (!contactId || typeof contactId !== 'string') {
      return res.status(200).json({ ok: false, error: 'contact_id required' });
    }
    if (!returnTo) {
      console.warn(`[HoldComplete] missing return_to for contact=${contactId}`);
      return res.status(200).json({ ok: false, error: 'return_to required' });
    }

    const completedAt = body.completed_at || new Date().toISOString();
    const holdHours = body.hold_hours !== undefined && body.hold_hours !== null && body.hold_hours !== ''
      ? Number(body.hold_hours) : null;

    // ── Always emit for the Decision Engine ───────────────────────────
    // event_subtype = return_to so completion rules match on event_pattern
    // (no payload-equality verb needed). agentic.hold_completed is allowlisted
    // in services/event-intake-filter.js.
    await emitEvent({
      event_type: 'agentic.hold_completed',
      event_subtype: returnTo,
      source: 'ghl_dynamic_hold',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        contact_id: contactId,
        return_to: returnTo,
        hold_hours: holdHours,
        hold_reason: body.hold_reason || null,
        workflow_code: body.workflow_code || null,
        completed_at: completedAt,
      },
      priority: 'normal',
      idempotency_key: `hold_complete_${contactId}_${returnTo}_${completedAt}`,
    });

    // ── Back-compat re-fire (gated) ───────────────────────────────────
    const explicitRefire = body.refire === true;
    const explicitNoRefire = body.refire === false;
    const shouldRefire = !explicitNoRefire && (explicitRefire || looksLikeTriggerId(returnTo));

    let refire = null;
    if (shouldRefire) {
      const refirePayload = {
        contact_id: contactId,
        enrollment_reason: 'hold_complete',
        returned_from_hold: true,
      };
      if (body.sequence_position !== undefined && body.sequence_position !== null && body.sequence_position !== '') {
        refirePayload.sequence_position = body.sequence_position;
      }
      if (body.workflow_code) refirePayload.workflow_code = body.workflow_code;
      try {
        refire = await refireTrigger(returnTo, refirePayload);
      } catch (err) {
        console.error(`[HoldComplete] re-fire threw contact=${contactId} return_to=${returnTo}: ${err.message}`);
        refire = { ok: false, status: 0, error: err.message };
      }
    }

    console.log(`[HoldComplete] contact=${contactId} return_to=${returnTo} ` +
      `wf=${body.workflow_code || '?'} reason="${body.hold_reason || ''}" ` +
      `emitted=agentic.hold_completed refired=${shouldRefire ? (refire?.status ?? 'err') : 'no'}`);

    return res.status(200).json({
      ok: true,
      contact_id: contactId,
      return_to: returnTo,
      emitted: 'agentic.hold_completed',
      refired: shouldRefire,
      refire_status: refire?.status ?? null,
    });
  });

  // ── Hold-error: the Dynamic Hold's Find-Contact step failed ──────────
  // Same shape as cooling/error: emit an observability event (bypass the intake
  // filter — no rule consumer yet) and fire a Class 1 SYSTEM EVENT notification.
  app.post('/api/agentic/hold-error', async (req, res) => {
    if (!checkBearer(req, res)) return;

    const body = req.body || {};
    const contactId = body.contact_id;
    const returnTo = typeof body.return_to === 'string' ? body.return_to.trim() : '';
    const completedAt = body.completed_at || new Date().toISOString();
    const failureReason = body.hold_error || body.error || 'contact_not_found_in_ghl';

    if (!contactId || typeof contactId !== 'string') {
      return res.status(200).json({ ok: false, error: 'contact_id required' });
    }

    await emitEvent({
      event_type: 'agentic.hold_error',
      event_subtype: returnTo || 'unknown',
      source: 'ghl_dynamic_hold',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        contact_id: contactId,
        return_to: returnTo || null,
        hold_hours: body.hold_hours ?? null,
        hold_reason: body.hold_reason || null,
        workflow_code: body.workflow_code || null,
        failure_reason: failureReason,
        completed_at: completedAt,
      },
      priority: 'high',
      idempotency_key: `hold_error_${contactId}_${returnTo}_${completedAt}`,
      bypass_filter: true, // observability only — no rule consumes hold_error yet
    });

    // Class 1 (🤖 SYSTEM EVENT) notification per docs/notification-standard-v1.md
    try {
      await sendGroupMeMessage(
        `🤖 SYSTEM EVENT — HOLD ERROR\n` +
        `Dynamic Hold could not resume contact_id=${contactId} ` +
        `(return_to=${returnTo || '?'}, wf=${body.workflow_code || '?'}). ` +
        `Reason: ${failureReason}. The hold clock did not return the contact to the brain — ` +
        `the timeout routing for this contact will not fire.`
      );
    } catch (err) {
      console.warn(`[HoldError] GroupMe alert failed: ${err.message}`);
    }

    console.log(`[HoldError] contact=${contactId} return_to=${returnTo || '?'} reason=${failureReason} — emitted agentic.hold_error + Class 1 notify`);
    return res.status(200).json({ ok: true, contact_id: contactId, emitted: 'agentic.hold_error' });
  });

  console.log('[REST API] Registered: POST /api/agentic/hold-complete, POST /api/agentic/hold-error (hold v2.0)');
}
