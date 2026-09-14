/**
 * Nurture Sequence Resolver — src/nurture/nurture-sequence-resolver.js
 *
 * Defensive resolver for `sequence_position` on inbound nurture
 * generation requests.
 *
 * BACKGROUND
 * ──────────
 * The S4.5 v2 workflow exists in three enrollment shapes:
 *
 *   1. Native inbound webhook trigger — payload carries sequence_position
 *      (this is the rotation-continue path; Step "Fire Self for Next
 *      Cycle" POSTs to the workflow's own inbound URL with the field
 *      value pulled from {{contact.ai_msg_sequence_position}}).
 *
 *   2. HL MCP add_to_workflow API — no payload. The orchestrator gets
 *      only what GHL's "standard webhook" action flattens out of the
 *      contact tree (sequence_position is NOT in that flatten by
 *      default for legacy reasons).
 *
 *   3. GHL UI "Add to Workflow" button — also no payload.
 *
 * Paths 2 and 3 produce a request body with sequence_position empty
 * or missing. Previously the orchestrator defaulted to 1 in that case,
 * which silently re-sent WK1 to every contact who got re-enrolled by
 * any non-webhook path (the 2026-05-12 bug Mark surfaced — 6 generations
 * in a row all WK1 because his manual GHL UI enrollment couldn't carry
 * the payload).
 *
 * THE RESOLUTION ORDER
 * ────────────────────
 *   1. Payload value if present and a positive integer 1..12.
 *   2. GHL contact custom field `ai_msg_sequence_position`
 *      (apoe5TFnilPriJmIzvbo) if set to a positive integer.
 *   3. Default to 1 — first-cycle enrollment.
 *
 * Defense in depth: the GHL workflow ALSO has an init step at the top
 * that writes 1 to the field when it's empty (see "Check for AI Msg
 * Sequence Position" branch). That handles the workflow-side init.
 * This module handles the orchestrator-side fallback so a
 * direct POST to /api/agentic/nurture/generate with no sequence_position
 * — or a misconfigured workflow webhook that drops the value — still
 * lands on the correct cycle for any contact who already has a
 * non-empty sequence in GHL.
 *
 * The result includes a `source` field so the orchestrator log can
 * attribute which path resolved the value. This is useful for spotting
 * misconfigured callers in production.
 */

import { withGhlToken } from '../ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const SEQ_POS_FIELD_ID = 'apoe5TFnilPriJmIzvbo'; // ai_msg_sequence_position
const MAX_SEQ_POS = 12;
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Coerce raw value (could be string from form-encoded POST, number from
 * JSON, null, undefined, or empty string) to a positive integer 1..MAX.
 * Returns null when the input doesn't represent a valid cycle position.
 */
function coerceSeqPos(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1 || i > MAX_SEQ_POS) return null;
  return i;
}

/**
 * Fetch only the sequence_position custom field from a GHL contact.
 * Uses the same GET /contacts/:id endpoint context-builder uses, but
 * extracts only the one field we need — keeps the resolver standalone
 * and doesn't force a full buildLeadContext call when the orchestrator
 * hasn't reached that step yet.
 *
 * Returns the integer value or null on any error / missing / invalid.
 * Network errors are logged but never thrown — caller falls through to
 * the default.
 */
async function fetchSeqPosFromGHL(contactId) {
  if (!GHL_API_KEY || !contactId) return null;
  try {
    const res = await withGhlToken(() => fetch(`${GHL_API_BASE}/contacts/${contactId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    }));
    if (!res.ok) {
      console.warn(`[SeqResolver] GHL GET /contacts/${contactId} returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    const customFields = data?.contact?.customFields || data?.contact?.customField || [];
    if (!Array.isArray(customFields)) return null;
    const field = customFields.find(f => f && f.id === SEQ_POS_FIELD_ID);
    if (!field) return null;
    return coerceSeqPos(field.value);
  } catch (err) {
    console.warn(`[SeqResolver] GHL fetch failed for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve sequence_position via the chain described in the module header.
 *
 * @param {string} contactId      — GHL contact ID (required)
 * @param {*} payloadSeqPos       — value from the inbound payload (any type)
 * @returns {Promise<{position:number, source:'payload'|'contact_field'|'default'}>}
 */
export async function resolveSequencePosition(contactId, payloadSeqPos) {
  // 1. Payload — preferred when present and valid.
  const fromPayload = coerceSeqPos(payloadSeqPos);
  if (fromPayload !== null) {
    return { position: fromPayload, source: 'payload' };
  }

  // 2. GHL contact field — fallback when payload is empty/missing.
  const fromContact = await fetchSeqPosFromGHL(contactId);
  if (fromContact !== null) {
    return { position: fromContact, source: 'contact_field' };
  }

  // 3. Default — brand-new contact, first cycle.
  return { position: 1, source: 'default' };
}
