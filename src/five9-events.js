/**
 * Five9 Connector Webhook Ingestion — src/five9-events.js
 *
 * Phase 1: authenticated raw capture + fast ack + normalizer.
 *
 * POST /webhook/five9-event
 *
 * The Five9 Connector "LP-MCP Event Push" (trigger: On Call Disposition,
 * execution: Silently/Form Submission) POSTs call events here. This module:
 *   1. Authenticates via the x-five9-webhook-secret header OR a body/query
 *      secret field (constant-time comparison against FIVE9_WEBHOOK_SECRET).
 *   2. Captures the FULL raw body into five9_events_raw (payload jsonb is
 *      the source of truth) and returns 200 { ok, id } IMMEDIATELY.
 *      Five9 retries on failure codes / slow acks, so we ack fast
 *      (target <500ms) and normalize afterward.
 *   3. Normalizes asynchronously (setImmediate, fire-and-forget): maps the
 *      event_type to a system event and emits via the existing emitEvent
 *      mechanism. Unknown types are marked processed with a benign
 *      processing_error — expected during rollout while we learn Five9's
 *      real schema.
 *
 * Live payload shape (verified 2026-07-03, five9_events_raw rows 330+):
 *   ANI            = Reece caller ID on outbound (855/local presence)
 *   DNIS           = CUSTOMER number on outbound  → correlate DNIS first
 *   call_id        = Five9 call id
 *   disposition_id = numeric (negative = system, 3e14-range = custom)
 *   disposition_name, campaign_name, full_name
 *   LPRecKey       = LP inquiry key (e.g. INQ402809) — captured, not yet joinable
 *   start_timestamp / end_timestamp = YYYYMMDDHHMMSSmmm (UTC)
 *
 * Mirrors POST /webhook/lp-lead-refresh (fast-ack + setImmediate) from
 * src/rest-api.js. NO agent rules consume these events yet — this is the
 * ingestion layer only. Substrate: sql/migrations/2026-07-02_five9_events_raw.sql
 * + 2026-07-03 enrichment columns (dashboard DDL).
 */

import crypto from 'crypto';
import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';

// Dedup window: a Five9 retry that re-delivers the same call_id + event_type
// within this window (after an earlier delivery already processed) is treated
// as a duplicate and skipped. Best-effort — the jsonb payload is still stored.
const DEDUP_WINDOW_SEC = parseInt(process.env.FIVE9_DEDUP_WINDOW_SEC || '60', 10);

const SECRET_HEADER = 'x-five9-webhook-secret';

// Field names under which the shared secret may arrive in the request BODY
// or QUERY string (case-insensitive). Five9 "Connectors" send configured
// parameters as URL/form fields — NOT as HTTP headers — so we accept the
// secret from a body/query param too (mirrors lp-lead-refresh's ?key=).
// These keys are always stripped from the stored payload so the secret is
// never persisted.
const SECRET_FIELD_KEYS = new Set([
  'x-five9-webhook-secret',
  'five9_webhook_secret',
  'webhook_secret',
  'secret',
]);

// Case-insensitive top-level lookup of the secret in a body/query object.
function findSecretField(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD_KEYS.has(k.toLowerCase()) && v != null && v !== '') {
      return typeof v === 'object' ? null : String(v);
    }
  }
  return null;
}

// Return a shallow clone of the payload with any secret field(s) removed,
// so the raw jsonb column never stores the shared secret.
function stripSecretFields(obj) {
  try {
    const clone = { ...(obj || {}) };
    for (const k of Object.keys(clone)) {
      if (SECRET_FIELD_KEYS.has(k.toLowerCase())) clone[k] = '[redacted]';
    }
    return clone;
  } catch {
    return obj;
  }
}

// ─── Auth ────────────────────────────────────────────────────────────
// Constant-time compare of SHA-256 digests so buffers are always equal
// length (timingSafeEqual throws on length mismatch) and the raw secret
// length never leaks. Fail closed when no secret is configured.
function secretMatches(provided) {
  const expected = process.env.FIVE9_WEBHOOK_SECRET || '';
  if (!expected) return false;          // fail closed — never accept when unset
  if (!provided) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Best-effort field extraction ────────────────────────────────────
// Try common key paths case-insensitively across the top level and one
// level of nesting. Never throws — the jsonb payload column is the source
// of truth.
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const wanted = keys.map(k => k.toLowerCase());
  // Top level first.
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.includes(k.toLowerCase()) && v != null && v !== '') {
      return typeof v === 'object' ? null : String(v).trim();
    }
  }
  // One level of nesting (e.g. { event: { type: ... } }).
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (wanted.includes(k2.toLowerCase()) && v2 != null && v2 !== '') {
          return typeof v2 === 'object' ? null : String(v2).trim();
        }
      }
    }
  }
  return null;
}

// Five9 Connector variables that failed to substitute arrive as literal
// "@Call.xxx@" strings. Treat those as absent so they never pollute
// extracted fields (e.g. ani = "@Call.ANI@") or contact correlation.
function unsubstituted(v) {
  return typeof v === 'string' && /^@.+@$/.test(v.trim());
}

// Parse Five9's compact timestamp format YYYYMMDDHHMMSSmmm (UTC, verified
// against received_at on live rows) → ISO string, or null.
export function parseFive9Ts(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(String(s || '').trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export function extractFields(payload) {
  try {
    const fields = {
      event_type:       pick(payload, ['eventType', 'event_type', 'type']),
      call_id:          pick(payload, ['callId', 'call_id', 'interactionId', 'interaction_id']),
      ani:              pick(payload, ['ANI', 'ani', 'callerNumber', 'from']),
      dnis:             pick(payload, ['DNIS', 'dnis', 'dialedNumber', 'to']),
      disposition:      pick(payload, ['disposition_id', 'dispositionId', 'disposition']),
      disposition_name: pick(payload, ['disposition_name', 'dispositionName']),
      campaign:         pick(payload, ['campaign_name', 'campaignName', 'campaign']),
      lp_rec_key:       pick(payload, ['LPRecKey', 'lp_rec_key', 'lpreckey']),
      lp_rec_type:      pick(payload, ['LPRecType', 'lp_rec_type', 'lprectype']),
      full_name:        pick(payload, ['full_name', 'fullName']),
      start_raw:        pick(payload, ['start_timestamp', 'startTimestamp']),
      end_raw:          pick(payload, ['end_timestamp', 'endTimestamp']),
    };
    for (const k of Object.keys(fields)) {
      if (unsubstituted(fields[k])) fields[k] = null;
    }
    fields.call_start_at = parseFive9Ts(fields.start_raw);
    fields.call_end_at = parseFive9Ts(fields.end_raw);
    fields.duration_sec = (fields.call_start_at && fields.call_end_at)
      ? Math.max(0, Math.round((Date.parse(fields.call_end_at) - Date.parse(fields.call_start_at)) / 1000))
      : null;
    return fields;
  } catch {
    return {
      event_type: null, call_id: null, ani: null, dnis: null, disposition: null,
      disposition_name: null, campaign: null, lp_rec_key: null, lp_rec_type: null,
      full_name: null, call_start_at: null, call_end_at: null, duration_sec: null,
    };
  }
}

// Redact the shared-secret header before persisting request headers.
function redactHeaders(headers) {
  try {
    const clone = { ...(headers || {}) };
    if (SECRET_HEADER in clone) clone[SECRET_HEADER] = '[redacted]';
    return clone;
  } catch {
    return null;
  }
}

// ─── Route handler ───────────────────────────────────────────────────
export async function five9WebhookHandler(req, res) {
  // 1. AUTH — accept the secret from the x-five9-webhook-secret HEADER, or
  //    from a body/query field (Five9 Connectors send params as URL/form
  //    fields, not headers). Missing/mismatch → 401 empty body, one warn
  //    line, no payload dump.
  const providedSecret =
    req.headers?.[SECRET_HEADER] ||
    findSecretField(req.body) ||
    findSecretField(req.query);
  if (!secretMatches(providedSecret)) {
    console.warn('[Five9] rejected: bad/missing webhook secret');
    return res.status(401).end();
  }

  // 2. KILL SWITCH — silence the feed without breaking Five9's retry logic
  //    (return 200, insert nothing).
  if (String(process.env.FIVE9_WEBHOOK_ENABLED ?? 'true') === 'false') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Merge query + body (body wins) so we capture the payload whether the
  // Five9 Connector sends params in the URL query string (its per-param "URL"
  // checkbox) or in the form body. Mirrors lp-lead-refresh's src merge.
  const merged = { ...(req.query || {}), ...((req.body && typeof req.body === 'object') ? req.body : {}) };
  // Never persist the secret: strip it from the stored payload (it may have
  // arrived as a query/body field on this connector).
  const payload = stripSecretFields(merged);
  const fields = extractFields(payload);

  const enrichedRow = {
    event_type:       fields.event_type,
    call_id:          fields.call_id,
    ani:              fields.ani,
    dnis:             fields.dnis,
    disposition:      fields.disposition,
    disposition_name: fields.disposition_name,
    campaign:         fields.campaign,
    lp_rec_key:       fields.lp_rec_key,
    lp_rec_type:      fields.lp_rec_type,
    full_name:        fields.full_name,
    call_start_at:    fields.call_start_at,
    call_end_at:      fields.call_end_at,
    duration_sec:     fields.duration_sec,
    payload,
    headers: redactHeaders(req.headers),
  };

  // Legacy column set — used as a fallback if the 2026-07-03 enrichment DDL
  // has not been applied yet, so a schema lag never drops deliveries.
  const legacyRow = {
    event_type:  fields.event_type,
    call_id:     fields.call_id,
    ani:         fields.ani,
    dnis:        fields.dnis,
    disposition: fields.disposition,
    payload,
    headers: redactHeaders(req.headers),
  };

  const SELECT_COLS = 'id, received_at, event_type, call_id, ani, dnis, disposition';

  // 3. FAST ACK — insert raw row, then respond 200 immediately.
  let row;
  try {
    let { data, error } = await supabase
      .from('five9_events_raw')
      .insert(enrichedRow)
      .select(SELECT_COLS)
      .single();

    // Schema-lag fallback: unknown-column error → retry with legacy columns.
    if (error && /column/i.test(error.message || '')) {
      console.warn('[Five9] enrichment columns missing — falling back to legacy insert. Run the 2026-07-03 DDL.');
      ({ data, error } = await supabase
        .from('five9_events_raw')
        .insert(legacyRow)
        .select(SELECT_COLS)
        .single());
    }

    if (error) throw error;
    row = data;
  } catch (err) {
    // Nothing captured — let Five9 retry via a failure code.
    console.error('[Five9] raw insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'insert_failed' });
  }

  res.status(200).json({ ok: true, id: row.id });

  // Carry enrichment into normalization regardless of which insert path ran.
  const normRow = { ...row, ...{
    disposition_name: fields.disposition_name,
    campaign:         fields.campaign,
    lp_rec_key:       fields.lp_rec_key,
    duration_sec:     fields.duration_sec,
    call_start_at:    fields.call_start_at,
    call_end_at:      fields.call_end_at,
  } };

  // 4. NORMALIZE after the response (fire-and-forget).
  setImmediate(() => {
    normalizeFive9Row(normRow).catch(err =>
      console.error(`[Five9] normalize error raw_id=${row.id}:`, err.message),
    );
  });
}

// ─── Event-type mapping (Phase 1) ────────────────────────────────────
// Best-effort, case-insensitive. Returns a system event_type or null
// (null → unmapped, safe-default path).
//
// CONNECTOR_CALL_EVENT / connector*: the Five9 Connector's default stamp.
// Its trigger is On Call Disposition, so a connector delivery IS a
// disposition-set event. The connector is now configured to send
// eventType=disposition explicitly, but keep the connector mapping as a
// guard against config regression. Verified against live payloads
// (five9_events_raw, 2026-07-03).
export function mapEventType(rawType) {
  const t = String(rawType || '').toLowerCase();
  if (!t) return null;
  if (t.includes('disposition')) return 'five9.disposition_set';
  if (t.includes('connector')) return 'five9.disposition_set';
  // Ended before created so "call ended"/"interaction ended" isn't caught
  // by a broad created/call match.
  if (t.includes('end') || t.includes('complete') || t.includes('disconnect')) return 'five9.call_ended';
  if (t.includes('creat') || t.includes('start') || t.includes('offer') || t.includes('ring')) return 'five9.call_created';
  return null;
}

// ─── Contact correlation ─────────────────────────────────────────────
// On OUTBOUND calls Five9's ANI is Reece's own caller ID (855 fallback or
// local-presence DID) and DNIS is the customer's number — verified against
// live payloads + lp_leads phone matches 2026-07-03. On inbound, ANI is the
// customer. So: correlate DNIS first, fall back to ANI. Last-10-digit match
// against lp_leads (phone or phone_alt), most recent first. Never throws.
function last10(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

async function matchPhone(number) {
  const digits = last10(number);
  if (digits.length < 10) return null;
  try {
    const { data } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id')
      .or(`phone.ilike.%${digits}%,phone_alt.ilike.%${digits}%`)
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      lp_lead_id: data.lp_lead_id || null,
      lp_prospect_id: data.lp_prospect_id || null,
      ghl_contact_id: data.ghl_contact_id || null,
    };
  } catch (err) {
    console.error('[Five9] contact correlation failed:', err.message);
    return null;
  }
}

async function correlateContact(dnis, ani) {
  return (await matchPhone(dnis)) || (await matchPhone(ani)) || null;
}

// ─── Normalizer (async, per raw row) ─────────────────────────────────
export async function normalizeFive9Row(row) {
  const rawId = row.id;
  const rawType = row.event_type;

  // 5. DEDUP GUARD — a Five9 retry can re-deliver the same call_id +
  //    event_type. If an earlier delivery already processed within the
  //    dedup window, mark this one a duplicate and skip emission.
  if (row.call_id && rawType) {
    try {
      const since = new Date(Date.now() - DEDUP_WINDOW_SEC * 1000).toISOString();
      const { data: dupe } = await supabase
        .from('five9_events_raw')
        .select('id')
        .eq('call_id', row.call_id)
        .eq('event_type', rawType)
        .eq('processed', true)
        .neq('id', rawId)
        .gte('received_at', since)
        .limit(1)
        .maybeSingle();
      if (dupe) {
        await markProcessed(rawId, { processing_error: 'duplicate_delivery' });
        return;
      }
    } catch (err) {
      // Non-fatal — fall through and emit. A duplicate event is safer than
      // a dropped one, and emitEvent's idempotency_key collapses most dupes.
      console.error(`[Five9] dedup check failed raw_id=${rawId}:`, err.message);
    }
  }

  // 2b. MAP — unknown types take the safe-default path (no emit).
  const mappedType = mapEventType(rawType);
  if (!mappedType) {
    await markProcessed(rawId, { processing_error: `unmapped_event_type:${rawType || 'null'}` });
    return;
  }

  // 3b. CONTACT CORRELATION — DNIS first (outbound customer), ANI fallback.
  const contactMatch = await correlateContact(row.dnis, row.ani);

  // 4b. EMIT via the existing mechanism. bypass_filter:true so the event
  //     lands in system_events with a real id even though no consumer rule
  //     exists yet (Phase 1). Inert until a rule ships — nothing fires
  //     without a matching agent_rule.
  const emitted = await emitEvent({
    event_type: mappedType,
    event_subtype: row.disposition_name || row.disposition || null,
    source: 'five9-ess',
    entity_type: contactMatch?.lp_lead_id ? 'lead' : 'system',
    entity_id: contactMatch?.lp_lead_id || row.call_id || String(rawId),
    ghl_contact_id: contactMatch?.ghl_contact_id || null,
    lp_lead_id: contactMatch?.lp_lead_id || null,
    lp_prospect_id: contactMatch?.lp_prospect_id || null,
    priority: 'normal',
    idempotency_key: `five9_${row.call_id || rawId}_${mappedType}`,
    bypass_filter: true,
    payload: {
      source: 'five9-ess',
      raw_id: rawId,
      event_type: rawType,
      call_id: row.call_id || null,
      ani: row.ani || null,
      dnis: row.dnis || null,
      disposition: row.disposition || null,
      disposition_name: row.disposition_name || null,
      campaign: row.campaign || null,
      lp_rec_key: row.lp_rec_key || null,
      duration_sec: row.duration_sec ?? null,
      call_start_at: row.call_start_at || null,
      call_end_at: row.call_end_at || null,
      contact_match: contactMatch,
      received_at: row.received_at,
    },
  });

  // 5b. PERSIST OUTCOME. emitEvent returns the inserted row on success,
  //     null on skip/error, or { filtered:true } if the intake filter
  //     dropped it (shouldn't happen with bypass_filter, but guard anyway).
  if (emitted && emitted.id) {
    await markProcessed(rawId, { emitted_event_id: emitted.id });
  } else {
    // Leave processed=false so a future sweep can reprocess (sweep not
    // built this phase). Record why.
    const reason = emitted && emitted.filtered ? 'filtered_no_consumer' : 'emit_failed';
    await supabase
      .from('five9_events_raw')
      .update({ processing_error: reason })
      .eq('id', rawId)
      .then(({ error }) => { if (error) console.error('[Five9] outcome update failed:', error.message); });
  }
}

// Mark a raw row processed (processed=true, processed_at=now, + extras).
async function markProcessed(rawId, extra = {}) {
  const { error } = await supabase
    .from('five9_events_raw')
    .update({ processed: true, processed_at: new Date().toISOString(), ...extra })
    .eq('id', rawId);
  if (error) console.error(`[Five9] markProcessed failed raw_id=${rawId}:`, error.message);
}
