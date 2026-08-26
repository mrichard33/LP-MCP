/**
 * Agentic Appointment Notifications — endpoint + orchestrator
 * src/notifications/appointment-notifications.js
 *
 * Calendar-agnostic endpoint that any GHL appointment workflow can
 * fire the same Layer-3 webhook config at. Delivery to the
 * Dispatch / Edwin / Trudy / Jazmine distribution list happens via
 * GHL's already-wired internal_notification (email + SMS) steps that
 * read {{contact.team_notification_body}} and
 * {{contact.team_notification_sms}} once the gate flips. THIS module
 * never posts to GroupMe, Slack, or any external channel.
 *
 * Flow per request:
 *   1. Validate against ENABLED_NOTIFICATION_STATUSES (whitelist —
 *      adding statuses later is a one-line change).
 *   2. Pull LIVE per-contact intelligence + Supabase aggregates in
 *      parallel via loadAppointmentContext (4s cap, partial failures
 *      surface as data_gaps).
 *   3. Generate { email_body, sms_body } via Claude.
 *   4. Write back to GHL in strict order:
 *        Call 1: team_notification_body + team_notification_sms +
 *                team_notification_id (one PATCH, three fields)
 *        Call 2: team_notification_ready = "Yes" (separate, FINAL)
 *      The ready flip is the atomic gate. If Call 1 fails, Call 2
 *      is never attempted — the gate stays unflipped and the GHL
 *      workflow's 30-min timeout fires the fallback.
 *   5. Schedule a fire-and-forget tag poke (add + remove a no-op tag)
 *      ~2s after writeback. GHL Wait-for-Condition steps don't
 *      reliably re-evaluate when watched fields change via API PUT;
 *      tag-change events DO fire workflow re-evaluation. The poke
 *      forces the wait step to re-check, see ready="Yes", and advance.
 *      Tag used: `notif-ready-poke`. No agent rule or workflow trigger
 *      should key on this tag.
 *   6. Log to lp_agentic_notifications on every path.
 *   7. 200 on success, non-200 on failure. NEVER flip the gate on
 *      a non-200 response.
 *
 * Feature flag: ENABLE_ENHANCED_APPT_NOTIFICATIONS=false → endpoint
 * returns 503 so the GHL workflow's 30-min timeout fires the
 * fallback branch.
 *
 * Companion endpoint: POST /api/agentic/notifications/engagement
 * accepts { notification_id, event } where event ∈ { email_sent,
 * sms_sent, team_acknowledged }. Stubbed for future tracking.
 */

import crypto from 'crypto';
import supabase from '../supabase.js';
import { loadAppointmentContext } from './appointment-intelligence.js';
import { generateAppointmentBody } from './appointment-body-generator.js';

// ───────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────

/**
 * Single source of truth for which appointment statuses fire the
 * notification. Adding Booked/Confirmed/etc. later is a one-line
 * change here — validation reads from this constant.
 */
export const ENABLED_NOTIFICATION_STATUSES = ['cancelled', 'rescheduled'];

const REQUIRED_FIELDS = [
  'contact_id',
  'contact_name',
  'contact_first_name',
  'contact_last_name',
  'contact_phone',
  'status',
  'calendar_id',
  'appointment_title',
  'start_time',
  'start_date',
  'lp_source',
  'lp_subsource',
];

// rescheduled requires the previous slot too
const RESCHEDULED_EXTRA_REQUIRED = ['previous_start_time', 'previous_start_date'];

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_TIMEOUT_MS = parseInt(
  process.env.APPT_NOTIFICATION_GHL_TIMEOUT_MS || '10000',
  10,
);

// Tag used to force GHL workflow re-evaluation after the writeback.
// Add + remove fires two tag-change events; the wait-for-condition
// step picks up the events and re-checks the ready field.
const READY_POKE_TAG = 'notif-ready-poke';

// Delay before firing the poke. Long enough for the GHL webhook
// response (200) to land and the contact to advance into the wait
// step before the tag-change event arrives. 2s is conservative —
// the webhook RTT itself is typically <500ms once we return.
const READY_POKE_DELAY_MS = parseInt(
  process.env.APPT_NOTIFICATION_POKE_DELAY_MS || '2000',
  10,
);

// ───────────────────────────────────────────────────────────────────
// REQUEST PARSING
// ───────────────────────────────────────────────────────────────────

/**
 * GHL custom webhooks can deliver the payload as a flat top-level
 * body, nested under customData, or as an array of {key,value} pairs.
 * Mirrors the parsing in nurture-orchestrator.js.
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
 * Validate the request body against an injected whitelist + required
 * fields. The whitelist defaults to ENABLED_NOTIFICATION_STATUSES;
 * tests can pass a different one to prove the constant is the single
 * source of truth.
 *
 * Returns { valid: boolean, errors: string[], normalized: {...} }.
 * Empty-string fields count as "present but blank" for lp_source /
 * lp_subsource (per contract). For everything else, empty-string =
 * MISSING.
 */
export function validateRequest(body, statuses = ENABLED_NOTIFICATION_STATUSES) {
  const errors = [];

  const status = String(body.status || '').trim().toLowerCase();
  if (!status) {
    errors.push("'status' is required");
  } else if (!statuses.includes(status)) {
    errors.push(
      `'status' must be one of [${statuses.join(', ')}], got '${status}'`,
    );
  }

  // ALLOW_EMPTY fields are OPTIONAL, not "required but may be blank". GHL omits
  // a customData key entirely when its merge tag resolves to empty — it does NOT
  // send `lp_source=`. The old predicate still demanded `raw !== undefined` for
  // these, so a contact with no LP source produced
  //   422 ["'lp_source' is required", "'lp_subsource' is required"]
  // and the notification never generated. Proven live 2026-08-17: omitting the
  // two keys 422s, sending them as empty strings passes.
  //
  // contact_last_name joined the set 2026-08-26. First-name-only contacts are
  // routine (canvass entries, inbound calls captured with a single name), and
  // GHL drops the key when {{contact.last_name}} resolves empty — so every one
  // of them 422'd with "'contact_last_name' is required" and never generated a
  // cancellation or reschedule alert. Six occurrences in the seven days to
  // 2026-08-26 (contacts uQErm6ihUpuFSSonANeG, HxztTDVGTDTecGf1uUKj,
  // Tuz8VEPi7naclkuZTltx, C5DqkOUqoRvHT86dia4H, ObhO7Oa5E18X7bP1EhuK). The
  // field is not load-bearing: contact_name already carries the full name, and
  // both body generators read contact_last_name defensively
  // (appointment-body-generator.js:280, cancellation-body-generator.js:261),
  // rendering the name without it.
  //
  // Every other field keeps the old strict behaviour — undefined, null, and
  // whitespace-only all still fail.
  const ALLOW_EMPTY = new Set(['lp_source', 'lp_subsource', 'contact_last_name']);
  for (const key of REQUIRED_FIELDS) {
    if (key === 'status') continue;
    if (ALLOW_EMPTY.has(key)) continue;
    const raw = body[key];
    const present = raw !== undefined && raw !== null && String(raw).trim() !== '';
    if (!present) errors.push(`'${key}' is required`);
  }

  if (status === 'rescheduled') {
    for (const key of RESCHEDULED_EXTRA_REQUIRED) {
      const raw = body[key];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        errors.push(`'${key}' is required when status='rescheduled'`);
      }
    }
  }

  const normalized = {
    contact_id: String(body.contact_id || '').trim(),
    contact_name: String(body.contact_name || '').trim(),
    contact_first_name: String(body.contact_first_name || '').trim(),
    contact_last_name: String(body.contact_last_name || '').trim(),
    contact_phone: String(body.contact_phone || '').trim(),
    contact_email: String(body.contact_email || '').trim(),
    status,
    calendar_id: String(body.calendar_id || '').trim(),
    appointment_title: String(body.appointment_title || '').trim(),
    start_time: String(body.start_time || '').trim(),
    start_date: String(body.start_date || '').trim(),
    previous_start_time: String(body.previous_start_time || '').trim(),
    previous_start_date: String(body.previous_start_date || '').trim(),
    lp_source: String(body.lp_source || '').trim(),
    lp_subsource: String(body.lp_subsource || '').trim(),
    assigned_user: String(body.assigned_user || '').trim(),
    city: String(body.city || '').trim(),
    postal_code: String(body.postal_code || '').trim(),
    lifecycle_stage: String(body.lifecycle_stage || '').trim(),
    trust_state: String(body.trust_state || '').trim(),
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
 * Add and remove are sequential to ensure the contact's final state
 * has the tag REMOVED (no lingering noise). Each call is wrapped in
 * its own try/catch so a remove failure doesn't leave the tag in
 * place silently — it logs.
 */
async function ghlPokeTag(contactId, tag, { fetchImpl = fetch } = {}) {
  const apiKey = process.env.GHL_API_KEY || '';
  if (!apiKey) {
    console.warn('[ApptNotif] tag poke skipped: GHL_API_KEY not configured');
    return;
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
  // Add the tag — this is the event that triggers wait re-evaluation.
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
        `[ApptNotif] tag poke add failed contact=${contactId} status=${addRes.status} ${errText.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`[ApptNotif] tag poke add threw contact=${contactId}: ${err.message}`);
    return; // don't try remove if add never happened
  }
  // Remove the tag — keeps the contact state clean.
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
        `[ApptNotif] tag poke remove failed contact=${contactId} status=${rmRes.status} ${errText.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`[ApptNotif] tag poke remove threw contact=${contactId}: ${err.message}`);
  }
}

/**
 * Strict-order GHL writeback. The ready flip is in a SEPARATE second
 * PUT — non-negotiable per the build spec, because the GHL workflow's
 * wait-for-condition step reads ready and immediately advances when
 * it sees "Yes". body + sms + id MUST land first.
 *
 * Step layout:
 *   1) PUT body + sms + id  (one call, three fields)
 *   2) PUT ready=Yes        (separate call, single field — the gate)
 *   3) Schedule fire-and-forget tag poke (~2s later) to force GHL
 *      workflow re-evaluation. See ghlPokeTag for rationale.
 *
 * If Call 1 throws, this function re-throws and Call 2 is never
 * attempted. Tests assert this by asserting the recorded mock-fetch
 * call count and field shape. The tag poke is scheduled AFTER both
 * PUTs succeed; a poke failure never affects the writeback contract.
 */
export async function writeBackToGhl({
  contactId,
  emailBody,
  smsBody,
  notificationId,
  fieldIds = resolveGhlFieldIds(),
  fetchImpl = fetch,
  hooks = {},
}) {
  if (!fieldIds.body || !fieldIds.sms || !fieldIds.id || !fieldIds.ready) {
    throw new Error(
      `ghl_field_ids_not_configured: body=${!!fieldIds.body} sms=${!!fieldIds.sms} id=${!!fieldIds.id} ready=${!!fieldIds.ready}`,
    );
  }

  // ─── Call 1: body + sms + id (must succeed before ready) ───────
  await ghlPutContact(
    contactId,
    [
      { id: fieldIds.body, field_value: String(emailBody) },
      { id: fieldIds.sms, field_value: String(smsBody) },
      { id: fieldIds.id, field_value: String(notificationId) },
    ],
    { fetchImpl },
  );
  if (hooks.onBodiesAndIdWritten) await hooks.onBodiesAndIdWritten();

  // ─── Call 2: ready=Yes (the atomic gate) ───────────────────────
  await ghlPutContact(
    contactId,
    [{ id: fieldIds.ready, field_value: 'Yes' }],
    { fetchImpl },
  );
  if (hooks.onReadyFlipped) await hooks.onReadyFlipped();

  // ─── Step 3: fire-and-forget tag poke to force wait re-evaluation
  // Delayed so the GHL webhook response lands first and the contact
  // is sitting in the wait-for-condition step when the tag event
  // arrives. Wrapped in setTimeout (not awaited) — the writeback
  // contract is already satisfied. Errors are logged inside ghlPokeTag.
  if (hooks.skipPoke !== true) {
    setTimeout(() => {
      ghlPokeTag(contactId, READY_POKE_TAG, { fetchImpl }).catch((err) => {
        console.warn(`[ApptNotif] tag poke scheduling error contact=${contactId}: ${err.message}`);
      });
    }, READY_POKE_DELAY_MS);
    if (hooks.onPokeScheduled) await hooks.onPokeScheduled();
  }
}

// ───────────────────────────────────────────────────────────────────
// AUDIT LOG
// ───────────────────────────────────────────────────────────────────

async function logAudit(row) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('lp_agentic_notifications').insert(row);
    if (error) {
      console.warn(`[ApptNotif] audit insert failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[ApptNotif] audit insert threw: ${err.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ───────────────────────────────────────────────────────────────────

/**
 * Orchestrate one notification end-to-end. Returns:
 *   { ok: true, notification_id, email_body, sms_body, ...details }   on success
 *   { ok: false, http_status, error, notification_id }                on failure
 *
 * The caller (Express handler) maps these to HTTP responses. We
 * never flip the GHL gate on a failure path — the spec's contract.
 */
export async function runAppointmentNotification(input, deps = {}) {
  const {
    fetchImpl = fetch,
    loadContext = loadAppointmentContext,
    generateBody = generateAppointmentBody,
    writeGhl = writeBackToGhl,
    audit = logAudit,
    fieldIds,
  } = deps;

  const notificationId = crypto.randomUUID();
  const startedAt = Date.now();

  const baseAuditRow = () => ({
    notification_id: notificationId,
    contact_id: input.contact_id,
    status: input.status,
    calendar_id: input.calendar_id,
    appointment_title: input.appointment_title,
    lp_source: input.lp_source,
    lp_subsource: input.lp_subsource,
  });

  // ─── Step 1: hybrid intelligence load ──────────────────────────
  let context;
  try {
    context = await loadContext({
      contact_id: input.contact_id,
      contact_phone: input.contact_phone,
      lp_source: input.lp_source,
      lp_subsource: input.lp_subsource,
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

  // ─── Step 2: generate { email_body, sms_body } via Claude ──────
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
      smsBody: generated.sms_body,
      notificationId,
      fieldIds,
      fetchImpl,
    });
  } catch (err) {
    await audit({
      ...baseAuditRow(),
      email_body: generated.email_body,
      sms_body: generated.sms_body,
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
    sms_body: generated.sms_body,
    ghl_writeback_at: ghlWritebackAt,
    model_used: generated.model,
    data_gaps: context.data_gaps || null,
    error: null,
  });

  const elapsed = Date.now() - startedAt;
  console.log(
    `[ApptNotif] ok notification=${notificationId} contact=${input.contact_id} ` +
      `status=${input.status} calendar=${input.calendar_id} title="${input.appointment_title}" ` +
      `email_chars=${generated.email_body.length} sms_chars=${generated.sms_body.length} ` +
      `gaps=${(context.data_gaps || []).length} (${elapsed}ms)`,
  );

  return {
    ok: true,
    http_status: 200,
    notification_id: notificationId,
    email_body: generated.email_body,
    sms_body: generated.sms_body,
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
  return process.env.ENABLE_ENHANCED_APPT_NOTIFICATIONS === 'true';
}

/**
 * Bearer check. On failure returns a NON-SECRET fingerprint of what arrived so
 * the audit row can distinguish the two real-world causes without ever
 * recording the token:
 *
 *   provided_len: 0   → header present but empty after "Bearer ". This is what
 *                       an unresolved GHL merge tag produces — the workflow
 *                       sends `Bearer {{custom_values.message_engine_token}}`
 *                       and GHL renders an empty string when the custom-value
 *                       KEY does not exist. The value can look correct in the
 *                       GHL UI and still fail this way.
 *   provided_len: n>0 → a real token arrived and did not match. Genuine
 *                       rotation drift between Railway and GHL.
 *   header_present:false → GHL never sent the header at all.
 *
 * Lengths and booleans only. Never the token, never a prefix of it.
 */
function checkBearerAuth(req) {
  const token = process.env.MESSAGE_ENGINE_TOKEN;
  if (!token) return { ok: true };
  const auth = req.headers.authorization || '';
  const headerPresent = auth.length > 0;
  const scheme = auth.startsWith('Bearer ') ? 'bearer' : (headerPresent ? 'other' : 'none');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (provided !== token) {
    return {
      ok: false,
      fingerprint: {
        header_present: headerPresent,
        scheme,
        provided_len: provided == null ? null : provided.length,
        expected_len: token.length,
        provided_trimmed_len: provided == null ? null : provided.trim().length,
      },
    };
  }
  return { ok: true };
}

export function registerAppointmentNotificationRoutes(app) {
  // ─── POST /api/agentic/notifications/appointment ──────────────
  app.post('/api/agentic/notifications/appointment', async (req, res) => {
    // Diagnostic — log inbound shape (mirrors the nurture endpoint).
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
        `[ApptNotif] inbound ct="${ct}" rawKeys=${rawKeys} customData=${cdShape}`,
      );
    } catch {
      // diagnostic must never throw
    }

    if (!isFeatureEnabled()) {
      return res.status(503).json({
        ok: false,
        error: 'feature_disabled',
        detail:
          'ENABLE_ENHANCED_APPT_NOTIFICATIONS is not true; GHL workflow timeout will fire the fallback branch.',
      });
    }

    // Parse BEFORE the auth gate so a rejected request can still record which
    // contact it was for. Parsing is pure — no I/O, no side effects.
    const merged = extractRequestFields(req.body || {});

    const authCheck = checkBearerAuth(req);
    if (!authCheck.ok) {
      const fp = authCheck.fingerprint || {};
      console.warn(
        `[ApptNotif] AUTH FAILED contact=${merged.contact_id || '(none)'} ` +
        `header_present=${fp.header_present} scheme=${fp.scheme} ` +
        `provided_len=${fp.provided_len} expected_len=${fp.expected_len}` +
        (fp.provided_len === 0 ? ' — EMPTY BEARER: the GHL custom value did not resolve' : ''),
      );
      await logAudit({
        notification_id: crypto.randomUUID(),
        contact_id: String(merged.contact_id || '(unauthenticated)'),
        status: String(merged.status || '(unknown)'),
        calendar_id: merged.calendar_id || null,
        appointment_title: merged.appointment_title || null,
        lp_source: merged.lp_source || null,
        lp_subsource: merged.lp_subsource || null,
        email_body: null,
        sms_body: null,
        ghl_writeback_at: null,
        model_used: null,
        data_gaps: fp,
        error: 'auth_failed:bearer_mismatch',
      });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { valid, errors, normalized } = validateRequest(merged);
    if (!valid) {
      console.warn(
        `[ApptNotif] VALIDATION FAILED contact=${merged.contact_id || '(none)'}: ${errors.join('; ')}`,
      );
      await logAudit({
        notification_id: crypto.randomUUID(),
        contact_id: String(merged.contact_id || '(missing)'),
        status: String(merged.status || '(unknown)'),
        calendar_id: merged.calendar_id || null,
        appointment_title: merged.appointment_title || null,
        lp_source: merged.lp_source || null,
        lp_subsource: merged.lp_subsource || null,
        email_body: null,
        sms_body: null,
        ghl_writeback_at: null,
        model_used: null,
        data_gaps: { validation_errors: errors },
        error: `validation_failed:${errors.join('; ')}`.slice(0, 2000),
      });
      return res.status(422).json({ ok: false, error: 'validation_failed', detail: errors });
    }

    try {
      const result = await runAppointmentNotification(normalized);
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
        calendar_id: normalized.calendar_id,
        appointment_title: normalized.appointment_title,
        ghl_writeback_success: true,
        data_gaps: result.data_gaps,
        latency_ms: result.latency_ms,
      });
    } catch (err) {
      console.error(`[ApptNotif] unhandled: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'internal', detail: err.message });
    }
  });

  // ─── POST /api/agentic/notifications/engagement ────────────────
  // Companion endpoint stub. Future use: GHL workflow posts back as
  // the email or SMS internal_notification fires, and a separate
  // mechanism reports team acknowledgement. v1 records the event
  // shape but applies no state transitions.
  app.post('/api/agentic/notifications/engagement', async (req, res) => {
    const authCheck = checkBearerAuth(req);
    if (!authCheck.ok) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const body = extractRequestFields(req.body || {});
    const notification_id = String(body.notification_id || '').trim();
    const event = String(body.event || '').trim().toLowerCase();

    if (!notification_id) {
      return res.status(422).json({ ok: false, error: "'notification_id' is required" });
    }
    const ALLOWED_EVENTS = ['email_sent', 'sms_sent', 'team_acknowledged'];
    if (!ALLOWED_EVENTS.includes(event)) {
      return res.status(422).json({
        ok: false,
        error: `'event' must be one of [${ALLOWED_EVENTS.join(', ')}]`,
      });
    }

    console.log(
      `[ApptNotif] engagement notification=${notification_id} event=${event} (stub — no state transition in v1)`,
    );

    return res.status(200).json({
      ok: true,
      notification_id,
      event,
      applied: false,
      reason: 'stub_v1_no_state_transition',
    });
  });

  console.log(
    '[REST API] Registered: POST /api/agentic/notifications/appointment (agentic appointment notifications v2 — email+SMS via GHL)',
  );
  console.log(
    '[REST API] Registered: POST /api/agentic/notifications/engagement (appointment notification engagement stub v1)',
  );
}

// Exported for tests.
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
