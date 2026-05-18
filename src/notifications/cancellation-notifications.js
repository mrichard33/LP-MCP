/**
 * Agentic Contract Cancellation Notifications — endpoint + orchestrator
 * src/notifications/cancellation-notifications.js
 *
 * Receives a POST from the GHL "Post-Demo Cancellation Routing"
 * workflow (id 1da073c9-c8f8-46a1-932b-248547c91060). The workflow
 * fires this webhook AFTER assigning the contact to the cancellation
 * handler (Shaina), then sits in a wait-for-condition step until
 * team_notification_ready flips to "Yes". This handler:
 *
 *   1. Validates auth (Bearer MESSAGE_ENGINE_TOKEN) and the payload.
 *   2. Pulls LIVE per-contact intelligence in parallel via
 *      loadCancellationContext (4s cap; partial failures surface as
 *      data_gaps).
 *   3. Generates the email body via Claude — EMAIL ONLY for this
 *      flow, no SMS, no GroupMe, no external channel.
 *   4. Writes back to GHL in strict order:
 *        Call 1: team_notification_body + team_notification_id +
 *                team_notification_sms (cleared to empty string —
 *                see "stale SMS protection" note below)
 *        Call 2: team_notification_ready = "Yes"
 *      The ready flip is the atomic gate. If Call 1 fails, Call 2
 *      is never attempted — the gate stays unflipped and the GHL
 *      workflow's 30-min timeout fires the fallback (hardcoded HTML
 *      email) branch.
 *   5. Schedules a fire-and-forget tag poke ~2s after writeback.
 *      GHL Wait-for-Condition steps don't reliably re-evaluate when
 *      watched fields change via API PUT; tag-change events DO fire
 *      re-evaluation. The poke (add + remove `notif-ready-poke`)
 *      forces the wait step to re-check and advance. This mirrors
 *      the appointment-notification pattern exactly.
 *   6. Logs to lp_agentic_notifications with status =
 *      'contract_cancellation_requested' as the discriminator.
 *   7. 200 on success, non-200 on failure. NEVER flip the gate on a
 *      non-200 response.
 *
 * STALE SMS PROTECTION:
 * The team_notification_sms field is shared with the appointment
 * notification flow. If a previous appointment notification timed out
 * and didn't reach its "Clear Team Notifications" step, the SMS field
 * could carry stale content. The cancellation workflow doesn't read
 * the SMS field (it has no SMS step), but writing empty string to it
 * in Call 1 is cheap insurance against future workflow edits that
 * might start using the field.
 *
 * Feature flag: ENABLE_CONTRACT_CANCELLATION_NOTIFICATIONS. Defaults
 * to true. Set to 'false' to make the endpoint return 503 so the GHL
 * workflow's 30-min timeout fires the fallback branch — useful when
 * disabling the agentic body while keeping the workflow in place.
 */

import crypto from 'crypto';
import supabase from '../supabase.js';
import { loadCancellationContext } from './cancellation-intelligence.js';
import { generateCancellationBody } from './cancellation-body-generator.js';

// ───────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────

/**
 * Whitelist for the `event_type` payload field. Today only one event
 * type fires this endpoint, but the workflow sends event_type as an
 * explicit field so we validate against a whitelist (parallel to the
 * appointment endpoint's status whitelist). Adding new event types
 * later is a one-line change here.
 */
export const ENABLED_EVENT_TYPES = ['contract_cancellation_requested'];

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_TIMEOUT_MS = parseInt(
  process.env.CANCELLATION_NOTIFICATION_GHL_TIMEOUT_MS || '10000',
  10,
);

// Tag used to force GHL workflow re-evaluation after the writeback.
// Add + remove fires two tag-change events; the wait-for-condition
// step picks up the events and re-checks the ready field. SAME tag
// the appointment endpoint uses on purpose — both flows want the
// same wait-step nudge, and reusing one tag keeps the contact's
// active-tag count minimal.
const READY_POKE_TAG = 'notif-ready-poke';

// Delay before firing the poke. Long enough for the webhook response
// (200) to land and the contact to advance into the wait step before
// the tag-change event arrives. 2s is conservative.
const READY_POKE_DELAY_MS = parseInt(
  process.env.CANCELLATION_NOTIFICATION_POKE_DELAY_MS || '2000',
  10,
);

// ───────────────────────────────────────────────────────────────────
// REQUEST PARSING
// ───────────────────────────────────────────────────────────────────

/**
 * GHL custom webhooks can deliver the payload as a flat top-level
 * body, nested under customData, or as an array of {key,value} pairs.
 * Mirrors the parsing in appointment-notifications.js and
 * nurture-orchestrator.js so the three flows behave identically.
 */
export function extractRequestFields(body) {
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
      } catch {
        // not JSON — fall through
      }
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

/**
 * Validate the payload. Required fields are intentionally minimal —
 * only `contact_id` is required. The webhook usually sends much more
 * (name, phone, email, etc.) but those are all looked up live from
 * the GHL contact anyway, so the workflow doesn't need to send a
 * complete payload for the endpoint to succeed.
 *
 * Returns { valid, errors, normalized }.
 */
export function validateRequest(body, eventTypes = ENABLED_EVENT_TYPES) {
  const errors = [];

  const contactId = String(body.contact_id || '').trim();
  if (!contactId) errors.push("'contact_id' is required");

  // event_type is optional; default to the only currently-enabled
  // value when not supplied. When supplied, it must be in the
  // whitelist — anything else means the GHL workflow is firing the
  // wrong endpoint and we reject so the bug surfaces.
  const eventType =
    String(body.event_type || '').trim().toLowerCase() ||
    'contract_cancellation_requested';
  if (!eventTypes.includes(eventType)) {
    errors.push(
      `'event_type' must be one of [${eventTypes.join(', ')}], got '${eventType}'`,
    );
  }

  const normalized = {
    contact_id: contactId,
    event_type: eventType,
    contact_name: String(body.contact_name || '').trim(),
    contact_first_name: String(body.contact_first_name || '').trim(),
    contact_last_name: String(body.contact_last_name || '').trim(),
    contact_phone: String(body.contact_phone || '').trim(),
    contact_email: String(body.contact_email || '').trim(),
    address: String(body.address || '').trim(),
    city: String(body.city || '').trim(),
    state: String(body.state || '').trim(),
    postal_code: String(body.postal_code || '').trim(),
    lp_prospect_id: String(body.lp_prospect_id || '').trim(),
    lp_lead_id: String(body.lp_lead_id || '').trim(),
    gross_sale_amount: String(body.gross_sale_amount || '').trim(),
    assigned_user: String(body.assigned_user || '').trim(),
    ai_summary: String(body.ai_summary || '').trim(),
    emotional_arc: String(body.emotional_arc || '').trim(),
    trust_level: String(body.trust_level || '').trim(),
    decision_timeline: String(body.decision_timeline || '').trim(),
    buyer_stage_tag: String(body.buyer_stage_tag || '').trim(),
    lp_source: String(body.lp_source || '').trim(),
    lp_subsource: String(body.lp_subsource || '').trim(),
  };

  return { valid: errors.length === 0, errors, normalized };
}

// ───────────────────────────────────────────────────────────────────
// GHL WRITEBACK
// ───────────────────────────────────────────────────────────────────

function resolveGhlFieldIds() {
  return {
    body: process.env.GHL_FIELD_TEAM_NOTIFICATION_BODY || '',
    sms: process.env.GHL_FIELD_TEAM_NOTIFICATION_SMS || '',
    id: process.env.GHL_FIELD_TEAM_NOTIFICATION_ID || '',
    ready: process.env.GHL_FIELD_TEAM_NOTIFICATION_READY || '',
  };
}

async function ghlPutContact(contactId, customFields, { fetchImpl = fetch } = {}) {
  const apiKey = process.env.GHL_API_KEY || '';
  if (!apiKey) throw new Error('GHL_API_KEY_not_configured');
  const res = await fetchImpl(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ customFields }),
    signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ghl_${res.status}:${errText.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * Tag poke — adds then removes a no-op tag to fire two contact-change
 * events. GHL Wait-for-Condition steps don't always pick up custom
 * field updates from API PUTs, but they DO pick up tag changes.
 * Fire-and-forget; failures are logged but never bubble up.
 *
 * The add fires the event that triggers wait re-evaluation; the
 * remove keeps the contact's tag set clean so we don't accumulate
 * `notif-ready-poke` tags forever.
 */
async function ghlPokeTag(contactId, tag, { fetchImpl = fetch } = {}) {
  const apiKey = process.env.GHL_API_KEY || '';
  if (!apiKey) {
    console.warn('[CancellationNotif] tag poke skipped: GHL_API_KEY not configured');
    return;
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
  try {
    const addRes = await fetchImpl(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: [tag] }),
      signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
    });
    if (!addRes.ok) {
      const errText = await addRes.text().catch(() => '');
      console.warn(
        `[CancellationNotif] tag poke add failed contact=${contactId} status=${addRes.status} ${errText.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`[CancellationNotif] tag poke add threw contact=${contactId}: ${err.message}`);
    return;
  }
  try {
    const rmRes = await fetchImpl(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ tags: [tag] }),
      signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
    });
    if (!rmRes.ok) {
      const errText = await rmRes.text().catch(() => '');
      console.warn(
        `[CancellationNotif] tag poke remove failed contact=${contactId} status=${rmRes.status} ${errText.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`[CancellationNotif] tag poke remove threw contact=${contactId}: ${err.message}`);
  }
}

/**
 * Strict-order GHL writeback. The ready flip is in a SEPARATE second
 * PUT — non-negotiable because the GHL workflow's wait-for-condition
 * step reads ready and immediately advances when it sees "Yes". The
 * body + id MUST land first.
 *
 * Step layout:
 *   1) PUT body + id + (sms cleared to empty)  (one call, three fields)
 *   2) PUT ready=Yes                            (separate, single field)
 *   3) Fire-and-forget tag poke (~2s later) to force GHL wait re-eval
 *
 * If Call 1 throws, this function re-throws and Call 2 is never
 * attempted. The tag poke is scheduled AFTER both PUTs succeed; a
 * poke failure never affects the writeback contract.
 */
export async function writeBackToGhl({
  contactId,
  emailBody,
  notificationId,
  fieldIds = resolveGhlFieldIds(),
  fetchImpl = fetch,
  hooks = {},
}) {
  if (!fieldIds.body || !fieldIds.id || !fieldIds.ready) {
    throw new Error(
      `ghl_field_ids_not_configured: body=${!!fieldIds.body} id=${!!fieldIds.id} ready=${!!fieldIds.ready}`,
    );
  }

  // ─── Call 1: body + id + (sms cleared) ────────────────────────
  // SMS field is cleared defensively — see "STALE SMS PROTECTION"
  // note at the top of the file. If the sms field id isn't
  // configured, we just write body + id and move on.
  const call1Fields = [
    { id: fieldIds.body, field_value: String(emailBody) },
    { id: fieldIds.id, field_value: String(notificationId) },
  ];
  if (fieldIds.sms) {
    call1Fields.push({ id: fieldIds.sms, field_value: '' });
  }
  await ghlPutContact(contactId, call1Fields, { fetchImpl });
  if (hooks.onBodyAndIdWritten) await hooks.onBodyAndIdWritten();

  // ─── Call 2: ready=Yes (the atomic gate) ──────────────────────
  await ghlPutContact(
    contactId,
    [{ id: fieldIds.ready, field_value: 'Yes' }],
    { fetchImpl },
  );
  if (hooks.onReadyFlipped) await hooks.onReadyFlipped();

  // ─── Step 3: fire-and-forget tag poke ─────────────────────────
  if (hooks.skipPoke !== true) {
    setTimeout(() => {
      ghlPokeTag(contactId, READY_POKE_TAG, { fetchImpl }).catch((err) => {
        console.warn(
          `[CancellationNotif] tag poke scheduling error contact=${contactId}: ${err.message}`,
        );
      });
    }, READY_POKE_DELAY_MS);
    if (hooks.onPokeScheduled) await hooks.onPokeScheduled();
  }
}

// ───────────────────────────────────────────────────────────────────
// AUDIT LOG
// ───────────────────────────────────────────────────────────────────

/**
 * Reuse the existing lp_agentic_notifications audit table. Status =
 * 'contract_cancellation_requested' acts as the discriminator from
 * appointment notifications. calendar_id, appointment_title,
 * lp_source, lp_subsource, sms_body are NULL for cancellation rows.
 */
async function logAudit(row) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('lp_agentic_notifications').insert(row);
    if (error) {
      console.warn(`[CancellationNotif] audit insert failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[CancellationNotif] audit insert threw: ${err.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ───────────────────────────────────────────────────────────────────

/**
 * Orchestrate one cancellation notification end-to-end. Returns:
 *   { ok: true,  notification_id, email_body, ... }   on success
 *   { ok: false, http_status, error, notification_id } on failure
 *
 * The caller (Express handler) maps these to HTTP responses. We
 * never flip the GHL gate on a failure path — the spec's contract.
 */
export async function runContractCancellationNotification(input, deps = {}) {
  const {
    fetchImpl = fetch,
    loadContext = loadCancellationContext,
    generateBody = generateCancellationBody,
    writeGhl = writeBackToGhl,
    audit = logAudit,
    fieldIds,
  } = deps;

  const notificationId = crypto.randomUUID();
  const startedAt = Date.now();

  const baseAuditRow = () => ({
    notification_id: notificationId,
    contact_id: input.contact_id,
    status: input.event_type, // 'contract_cancellation_requested'
    calendar_id: null,
    appointment_title: null,
    lp_source: input.lp_source || null,
    lp_subsource: input.lp_subsource || null,
  });

  // ─── Step 1: hybrid intelligence load ──────────────────────────
  let context;
  try {
    context = await loadContext({
      contact_id: input.contact_id,
      contact_phone: input.contact_phone,
      payload_prospect_id: input.lp_prospect_id,
    });
  } catch (err) {
    await audit({
      ...baseAuditRow(),
      email_body: null,
      sms_body: null,
      ghl_writeback_at: null,
      model_used: null,
      data_gaps: null,
      error: `context_load_failed:${err.message}`,
    });
    return {
      ok: false,
      http_status: 502,
      error: `context_load_failed:${err.message}`,
      notification_id: notificationId,
    };
  }

  // ─── Step 2: generate { email_body } via Claude ────────────────
  let generated;
  try {
    generated = await generateBody({ payload: input, context });
  } catch (err) {
    await audit({
      ...baseAuditRow(),
      email_body: null,
      sms_body: null,
      ghl_writeback_at: null,
      model_used: null,
      data_gaps: context.data_gaps || null,
      error: `body_generation_failed:${err.message}`,
    });
    return {
      ok: false,
      http_status: 502,
      error: `body_generation_failed:${err.message}`,
      notification_id: notificationId,
    };
  }

  // ─── Step 3: GHL writeback in strict order ─────────────────────
  try {
    await writeGhl({
      contactId: input.contact_id,
      emailBody: generated.email_body,
      notificationId,
      fieldIds,
      fetchImpl,
    });
  } catch (err) {
    await audit({
      ...baseAuditRow(),
      email_body: generated.email_body,
      sms_body: null,
      ghl_writeback_at: null,
      model_used: generated.model,
      data_gaps: context.data_gaps || null,
      error: `ghl_writeback_failed:${err.message}`,
    });
    return {
      ok: false,
      http_status: 502,
      error: `ghl_writeback_failed:${err.message}`,
      notification_id: notificationId,
    };
  }
  const ghlWritebackAt = new Date().toISOString();

  // ─── Step 4: success audit ─────────────────────────────────────
  await audit({
    ...baseAuditRow(),
    email_body: generated.email_body,
    sms_body: null,
    ghl_writeback_at: ghlWritebackAt,
    model_used: generated.model,
    data_gaps: context.data_gaps || null,
    error: null,
  });

  const elapsed = Date.now() - startedAt;
  console.log(
    `[CancellationNotif] ok notification=${notificationId} contact=${input.contact_id} ` +
      `event=${input.event_type} email_chars=${generated.email_body.length} ` +
      `gaps=${(context.data_gaps || []).length} (${elapsed}ms)`,
  );

  return {
    ok: true,
    http_status: 200,
    notification_id: notificationId,
    email_body: generated.email_body,
    model: generated.model,
    ghl_writeback_success: true,
    data_gaps: context.data_gaps || [],
    latency_ms: elapsed,
  };
}

// ───────────────────────────────────────────────────────────────────
// ROUTE REGISTRATION
// ───────────────────────────────────────────────────────────────────

function isFeatureEnabled() {
  // Defaults to TRUE — set the env var to 'false' explicitly to
  // disable. Different default than the appointment notification
  // endpoint (which defaults to false) because cancellation is a
  // brand-new endpoint with no fallback risk: if it returns 503 the
  // GHL workflow still fires its hardcoded fallback email after
  // 30 min, so a default-on stance just means Mark doesn't have to
  // touch Railway env vars to get the agentic body working.
  const flag = process.env.ENABLE_CONTRACT_CANCELLATION_NOTIFICATIONS;
  if (flag === undefined || flag === null) return true;
  return String(flag).toLowerCase() !== 'false';
}

function checkBearerAuth(req) {
  const token = process.env.MESSAGE_ENGINE_TOKEN;
  if (!token) return { ok: true };
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (provided !== token) return { ok: false };
  return { ok: true };
}

export function registerContractCancellationNotificationRoutes(app) {
  // ─── POST /api/agentic/notifications/contract-cancellation ────
  app.post('/api/agentic/notifications/contract-cancellation', async (req, res) => {
    // Diagnostic — log inbound shape (mirrors appointment + nurture).
    try {
      const ct = req.headers['content-type'] || 'none';
      const raw = req.body || {};
      const rawKeys = Object.keys(raw).length;
      const cd = raw.customData;
      let cdShape = 'absent';
      if (cd === undefined || cd === null) cdShape = 'absent';
      else if (Array.isArray(cd)) cdShape = `array[${cd.length}]`;
      else if (typeof cd === 'object') cdShape = `object{${Object.keys(cd).length}}`;
      else if (typeof cd === 'string') cdShape = `string[${cd.length}]`;
      else cdShape = typeof cd;
      console.log(
        `[CancellationNotif] inbound ct="${ct}" rawKeys=${rawKeys} customData=${cdShape}`,
      );
    } catch {
      // diagnostic must never throw
    }

    if (!isFeatureEnabled()) {
      return res.status(503).json({
        ok: false,
        error: 'feature_disabled',
        detail:
          'ENABLE_CONTRACT_CANCELLATION_NOTIFICATIONS=false; GHL workflow timeout will fire the fallback branch.',
      });
    }

    const authCheck = checkBearerAuth(req);
    if (!authCheck.ok) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const merged = extractRequestFields(req.body || {});
    const { valid, errors, normalized } = validateRequest(merged);
    if (!valid) {
      return res.status(422).json({
        ok: false,
        error: 'validation_failed',
        detail: errors,
      });
    }

    try {
      const result = await runContractCancellationNotification(normalized);
      if (!result.ok) {
        return res.status(result.http_status || 502).json({
          ok: false,
          error: result.error,
          notification_id: result.notification_id,
        });
      }

      return res.status(200).json({
        ok: true,
        notification_id: result.notification_id,
        event_type: normalized.event_type,
        ghl_writeback_success: true,
        data_gaps: result.data_gaps,
        latency_ms: result.latency_ms,
      });
    } catch (err) {
      console.error(`[CancellationNotif] unhandled: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
  });

  console.log(
    '[REST API] Registered: POST /api/agentic/notifications/contract-cancellation (agentic post-demo cancellation alert — email only)',
  );
}

// Exported for tests and for potential future reuse from other modules.
export const _internal = {
  resolveGhlFieldIds,
  ghlPutContact,
  ghlPokeTag,
  isFeatureEnabled,
  checkBearerAuth,
  logAudit,
  READY_POKE_TAG,
  READY_POKE_DELAY_MS,
};
