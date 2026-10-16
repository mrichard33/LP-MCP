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

import { checkRequestSecret, rejectionBody } from '../security/request-auth.js';
import { emitEvent } from '../event-emitter.js';
import { sendGroupMeMessage } from '../groupme.js';
import supabase from '../supabase.js';
import { recoverHoldTarget, completionEventType, holdRecoveryMode } from './hold-target.js';

// 2026-10-16: the issued holds a blank-return_to callback is matched against
// (see src/agentic/hold-target.js). Newest first; a few is plenty, since only
// one hold per contact is open at a time (HOLD_SERIALIZATION_ENABLED).
export async function readRecentHolds(contactId, { db = supabase } = {}) {
  const { data, error } = await db
    .from('agent_actions')
    .select('id, created_at, executed_at, action_payload, execution_result')
    .eq('action_type', 'issue_hold')
    .eq('target_id', contactId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  return data || [];
}

// NOTE (2026-09-14): /hooks/ is GHL's INBOUND webhook-trigger surface, not the
// rate-limited v2 API (services.leadconnectorhq.com/contacts, /conversations,
// ...). It does not spend the API budget the token bucket exists to protect, so
// refireTrigger below is deliberately NOT wrapped in withGhlToken. Everything
// that does hit the v2 API is — see src/ghl-rate-limiter.js.
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
  // rate-limiter-exempt: GHL /hooks webhook-trigger surface, not the rate-limited v2 API.
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
  // Staged, constant-time (2026-10-06, src/security/request-auth.js): open
  // when MESSAGE_ENGINE_TOKEN is unset only under AUTH_ENFORCE_MODE=log
  // (enforce → 503). A wrong token keeps this route's own answer below.
  const d = checkRequestSecret(req, { route: req.path || 'hold-complete', secret: process.env.MESSAGE_ENGINE_TOKEN, bearer: true });
  if (d.allow) return true;
  if (d.status === 503) res.status(503).json(rejectionBody(d));
  else res.status(200).json({ ok: false, error: 'unauthorized' });
  return false;
}

export function registerHoldCompleteRoutes(app, deps = {}) {
  const readHolds = deps.readRecentHolds || readRecentHolds;
  const emit = deps.emitEvent || emitEvent;
  const env = deps.env || process.env;

  app.post('/api/agentic/hold-complete', async (req, res) => {
    if (!checkBearer(req, res)) return;

    const body = req.body || {};
    const contactId = body.contact_id;

    if (!contactId || typeof contactId !== 'string') {
      return res.status(200).json({ ok: false, error: 'contact_id required' });
    }

    // 2026-10-16: GHL sends return_to BLANK when the callback runs long after
    // the inbound webhook that started the hold, so every callback since
    // 2026-06-12 was refused here and no hold ever completed. A blank one is
    // recovered from our own issue_hold row (hold-target.js); a read that
    // fails recovers nothing and the callback is refused as before.
    const nowMs = Date.now();
    let holds = [];
    // 2026-10-16: GHL's Webhook action nests its Custom Data rows under
    // body.customData; read them like top-level keys for everything but the
    // return_to source (recoverHoldTarget labels that one 'custom_data').
    const cd = body.customData && typeof body.customData === 'object' ? body.customData : {};
    const pick = (k) => (body[k] !== undefined && body[k] !== null && body[k] !== '') ? body[k] : cd[k];
    const hasBodyTarget = Boolean(String(body.return_to ?? '').trim() || String(cd.return_to ?? '').trim()
      || String(body.hold_return_target ?? '').trim() || String(body['Hold Return Target'] ?? '').trim());
    if (!hasBodyTarget) {
      try {
        holds = await readHolds(contactId);
      } catch (err) {
        console.warn(`[HoldComplete] issued-hold read failed for contact=${contactId}: ${err.message}`);
      }
    }
    const recovered = recoverHoldTarget({ body, holds, nowMs });
    const returnTo = recovered.returnTo;
    const mode = holdRecoveryMode(env);
    const eventType = completionEventType({ source: recovered.source, mode });

    if (!returnTo) {
      console.warn(`[HoldComplete] missing return_to for contact=${contactId} (no issued hold due now)`);
      return res.status(200).json({ ok: false, error: 'return_to required' });
    }
    if (recovered.source !== 'body') {
      console.log(`[HoldComplete] return_to recovered from ${recovered.source} contact=${contactId} ` +
        `return_to=${returnTo} mode=${mode}` + (recovered.hold ? ` hold_action=${recovered.hold.action_id} due=${recovered.hold.due_at}` : ''));
    }
    if (!eventType) {
      return res.status(200).json({ ok: false, error: 'return_to required', recovered_from: recovered.source, mode });
    }

    const completedAt = new Date(nowMs).toISOString();
    const hoursIn = pick('hold_hours');
    const rawHours = hoursIn !== undefined && hoursIn !== null && hoursIn !== '' ? Number(hoursIn) : null;
    const holdHours = Number.isFinite(rawHours) ? rawHours : (recovered.hold?.hold_hours ?? null);
    const shadow = eventType !== 'agentic.hold_completed';

    // ── Emit for the Decision Engine ──────────────────────────────────
    // event_subtype = return_to so completion rules match on event_pattern
    // (no payload-equality verb needed). agentic.hold_completed is allowlisted
    // in services/event-intake-filter.js. The shadow event has no consumer, so
    // it bypasses the filter like hold_error.
    await emit({
      event_type: eventType,
      event_subtype: returnTo,
      source: 'ghl_dynamic_hold',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        contact_id: contactId,
        return_to: returnTo,
        hold_hours: holdHours,
        hold_reason: pick('hold_reason') || recovered.hold?.hold_reason || null,
        workflow_code: pick('workflow_code') || recovered.hold?.workflow_code || null,
        completed_at: completedAt,
        return_to_source: recovered.source,
        hold_action_id: recovered.hold?.action_id ?? null,
        hold_due_at: recovered.hold?.due_at ?? null,
      },
      priority: 'normal',
      idempotency_key: `${shadow ? 'hold_complete_shadow' : 'hold_complete'}_${contactId}_${returnTo}_${completedAt}`,
      ...(shadow ? { bypass_filter: true } : {}),
    });

    // ── Back-compat re-fire (gated) ───────────────────────────────────
    // Never in shadow: a shadow completion must change nothing.
    const explicitRefire = pick('refire') === true;
    const explicitNoRefire = pick('refire') === false;
    const shouldRefire = !shadow && !explicitNoRefire && (explicitRefire || looksLikeTriggerId(returnTo));

    let refire = null;
    if (shouldRefire) {
      const refirePayload = {
        contact_id: contactId,
        enrollment_reason: 'hold_complete',
        returned_from_hold: true,
      };
      const seq = pick('sequence_position');
      if (seq !== undefined && seq !== null && seq !== '') refirePayload.sequence_position = seq;
      if (pick('workflow_code')) refirePayload.workflow_code = pick('workflow_code');
      try {
        refire = await refireTrigger(returnTo, refirePayload);
      } catch (err) {
        console.error(`[HoldComplete] re-fire threw contact=${contactId} return_to=${returnTo}: ${err.message}`);
        refire = { ok: false, status: 0, error: err.message };
      }
    }

    console.log(`[HoldComplete] contact=${contactId} return_to=${returnTo} ` +
      `wf=${pick('workflow_code') || '?'} reason="${pick('hold_reason') || ''}" source=${recovered.source} ` +
      `emitted=${eventType} refired=${shouldRefire ? (refire?.status ?? 'err') : 'no'}`);

    return res.status(200).json({
      ok: true,
      contact_id: contactId,
      return_to: returnTo,
      return_to_source: recovered.source,
      emitted: eventType,
      refired: shouldRefire,
      refire_status: refire?.status ?? null,
    });
  });

  // ── Hold-error: the Dynamic Hold's Find-Contact step failed ──────────
  // Same shape as cooling/error: emit an observability event (bypass the intake
  // filter — no rule consumer yet) and fire a Class 1 SYSTEM EVENT notification.
  app.post('/api/agentic/hold-error', async (req, res) => {
    if (!checkBearer(req, res)) return;

    // 2026-10-16: GHL's Webhook action nests Custom Data under body.customData.
    const raw = req.body || {};
    const body = { ...(raw.customData && typeof raw.customData === 'object' ? raw.customData : {}), ...raw };
    for (const k of Object.keys(raw.customData || {})) {
      if (body[k] === undefined || body[k] === null || body[k] === '') body[k] = raw.customData[k];
    }
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
