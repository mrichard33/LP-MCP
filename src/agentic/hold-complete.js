/**
 * Hold-Complete — src/agentic/hold-complete.js
 *
 * Generic "return from hold" endpoint. The GHL Hold/Cooldown workflow
 * (inbound trigger 4ec11a08-acaa-4159-8576-6ab63cc3a788) parks a contact
 * for a dynamic number of hours (field MZkFWOFDzf8OKTy2O4od), then — once
 * the wait expires — POSTs here so the agentic system can re-enter the
 * contact into whatever workflow parked it.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Before this, an agentic suppression that needed to DEFER rather than
 * stop (e.g. S1.1 recent_reply: a live human conversation is in progress)
 * had no path back. The contact dead-waited the source workflow's
 * send-ready gate to its 24h timeout and fired a false "stuck" alert.
 * Now the source workflow hands the contact to the Hold pen with a
 * cooldown + a return target, the pen waits, and this endpoint re-fires
 * the return target so the rotation resumes exactly where it left off.
 *
 * MULTIPURPOSE CONTRACT
 * ─────────────────────
 *   POST /api/agentic/hold-complete
 *   Authorization: Bearer <MESSAGE_ENGINE_TOKEN>   (same token the nurture
 *                                                    generate route checks)
 *   body: {
 *     contact_id:        string  (required) — GHL contact id (match key).
 *     return_to:         string  (required) — the GHL inbound-webhook
 *                                  TRIGGER ID of the workflow to re-enter
 *                                  (S1.1 = VweqELA9NqpYiD2r8qPf). The pen is
 *                                  workflow-agnostic; the source workflow
 *                                  supplies its own trigger id, so no
 *                                  per-workflow code lives here.
 *     sequence_position?: string|number — passthrough. Most workflows
 *                                  (S1.1) re-read position from their own
 *                                  dedicated field on re-entry, so optional.
 *     workflow_code?:    string  — passthrough, logging only.
 *     hold_reason?:      string  — passthrough, logging only.
 *   }
 *
 * Always returns HTTP 200 (a GHL outbound webhook treats a non-200 as a
 * failure to retry; we never want a retry storm). Failures are reported in
 * the body as { ok:false, error }.
 *
 * Re-entry is a fire-and-forget POST to the GHL inbound webhook for
 * return_to. GHL inbound-webhook triggers are UNAUTHENTICATED, so no
 * Authorization header is sent on the re-fire (matches the live test that
 * returned 200 with no auth).
 *
 * v1.0 — 2026-06-04. Initial. Built alongside the S1.1 v2 suppression-hold
 *   loop (nurture-orchestrator HOLDABLE_INTERRUPTS dispatch +
 *   nurture-writeback writeSuppressionHold).
 */

const GHL_HOOK_BASE = 'https://services.leadconnectorhq.com/hooks';
const GHL_LOC_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

// A GHL inbound-webhook trigger id is a ~20-char url-safe token. This is a
// permissive shape check only — to reject obvious garbage (empty / spaces)
// so we never POST a malformed URL — NOT a strict length assertion.
function looksLikeTriggerId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(s.trim());
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

export function registerHoldCompleteRoutes(app) {
  app.post('/api/agentic/hold-complete', async (req, res) => {
    // Auth — mirror the nurture generate route exactly (200 + error body,
    // never a 4xx, so a GHL outbound webhook doesn't enter a retry loop).
    const token = process.env.MESSAGE_ENGINE_TOKEN;
    if (token) {
      const auth = req.headers.authorization || '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (provided !== token) {
        return res.status(200).json({ ok: false, error: 'unauthorized' });
      }
    }

    const body = req.body || {};
    const contactId = body.contact_id;
    const returnTo = typeof body.return_to === 'string' ? body.return_to.trim() : '';

    if (!contactId || typeof contactId !== 'string') {
      return res.status(200).json({ ok: false, error: 'contact_id required' });
    }
    if (!looksLikeTriggerId(returnTo)) {
      console.warn(`[HoldComplete] bad return_to for contact=${contactId}: "${body.return_to}"`);
      return res.status(200).json({ ok: false, error: 'return_to must be a GHL inbound-webhook trigger id' });
    }

    // Re-entry payload mirrors the shape a source workflow's inbound trigger
    // + Fire-Self step use: contact_id is the match key; the rest is context
    // the workflow either re-reads from its own fields (S1.1 reads its
    // dedicated sequence-position field) or just logs.
    const refirePayload = {
      contact_id: contactId,
      enrollment_reason: 'hold_complete',
      returned_from_hold: true,
    };
    if (body.sequence_position !== undefined && body.sequence_position !== null && body.sequence_position !== '') {
      refirePayload.sequence_position = body.sequence_position;
    }
    if (body.workflow_code) refirePayload.workflow_code = body.workflow_code;

    let result;
    try {
      result = await refireTrigger(returnTo, refirePayload);
    } catch (err) {
      console.error(`[HoldComplete] re-fire threw contact=${contactId} return_to=${returnTo}: ${err.message}`);
      return res.status(200).json({ ok: false, error: `refire_failed: ${err.message}` });
    }

    console.log(`[HoldComplete] contact=${contactId} re-fired return_to=${returnTo} ` +
      `wf=${body.workflow_code || '?'} pos=${body.sequence_position ?? '?'} reason="${body.hold_reason || ''}" ` +
      `-> ${result.status} ok=${result.ok}`);

    return res.status(200).json({
      ok: result.ok,
      contact_id: contactId,
      return_to: returnTo,
      refire_status: result.status,
    });
  });

  console.log('[REST API] Registered: POST /api/agentic/hold-complete (hold-complete v1.0)');
}
