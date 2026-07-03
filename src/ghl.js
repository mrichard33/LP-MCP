import axios from 'axios';
import { acquireToken, report429 } from './ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

console.log(`[GHL] API key: ${GHL_API_KEY ? 'set' : 'MISSING — GHL matching will be disabled'}`);
if (GHL_API_KEY && !GHL_LOCATION_ID) {
  console.warn('[GHL] WARNING: GHL_LOCATION_ID not set — contact search/tag calls will fail without a location');
}

let ghlDisabled = false;
let ghlFailCount = 0;
let loggedFirstMatch = false;
let loggedFirstFieldUpdate = false;
let loggedFirstNote = false;
const GHL_FAIL_THRESHOLD = 5;

const ghlClient = GHL_API_KEY ? axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    'Authorization': `Bearer ${GHL_API_KEY}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json',
  },
  timeout: 10000,
}) : null;

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITER INTEGRATION
// Axios interceptors ensure ALL GHL calls go through the token bucket.
// ═══════════════════════════════════════════════════════════════════

if (ghlClient) {
  // Request interceptor: acquire a token before each request
  ghlClient.interceptors.request.use(async (config) => {
    await acquireToken();
    return config;
  });

  // Response interceptor: report 429 to drain bucket + pause
  ghlClient.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 429) {
        report429();
      }
      return Promise.reject(error);
    }
  );
}

function isContactNotFound(err) {
  if (err.response?.status !== 400) return false;
  const body = JSON.stringify(err.response?.data || '').toLowerCase();
  return body.includes('not found');
}

export async function searchGHLContact(params) {
  if (ghlDisabled || !ghlClient) return null;
  try {
    const query = params.phone || params.email || '';
    const { data } = await ghlClient.get('/contacts/', {
      params: { query, locationId: process.env.GHL_LOCATION_ID },
    });
    ghlFailCount = 0;
    const match = data?.contacts?.[0] || null;
    if (match && !loggedFirstMatch) {
      loggedFirstMatch = true;
      console.log(`[GHL] First search hit: query="${query}" → contactId=${match.id}`);
    }
    return match;
  } catch (err) {
    ghlFailCount++;
    const status = err.response?.status || 'no response';
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Disabled after ${GHL_FAIL_THRESHOLD} consecutive failures (HTTP ${status}: ${err.message}).`);
    } else if (ghlFailCount === 1) {
      console.error(`[GHL] Contact search failed: HTTP ${status} — ${err.message}`);
      if (err.response?.data) {
        console.error('[GHL] Response body:', JSON.stringify(err.response.data).slice(0, 300));
      }
    }
    return null;
  }
}

export async function matchToGHL(lpLead) {
  if (ghlDisabled || !ghlClient) return null;
  if (lpLead.phone) {
    const contact = await searchGHLContact({ phone: normalizePhone(lpLead.phone) });
    if (contact) return contact.id;
  }
  if (lpLead.phone_alt) {
    const contact = await searchGHLContact({ phone: normalizePhone(lpLead.phone_alt) });
    if (contact) return contact.id;
  }
  if (lpLead.email) {
    const contact = await searchGHLContact({ email: lpLead.email.toLowerCase() });
    if (contact) return contact.id;
  }
  return null;
}

// Apply tag via POST (additive) — NEVER use PUT which replaces all tags
export async function applyGHLTag(ghlContactId, tag) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return false;
  // 2026-07-03 — tag hygiene backstop (all callers): a tag ending in ':' is
  // an empty namespace value (failed template interpolation). Refuse it.
  if (typeof tag === 'string' && tag.trim().endsWith(':')) {
    console.warn(`[GHL] tag.construction_rejected: "${tag}" for ${ghlContactId} — empty namespace value, not applied`);
    return false;
  }
  try {
    await ghlClient.post(`/contacts/${ghlContactId}/tags`, {
      tags: [tag],
    });
    ghlFailCount = 0;
    return true;
  } catch (err) {
    if (isContactNotFound(err)) {
      console.warn(`[GHL] Tag apply: contact ${ghlContactId} not found (deleted?) — skipping`);
      return false;
    }
    ghlFailCount++;
    const status = err.response?.status || 'no response';
    if (ghlFailCount === 1) {
      console.error(`[GHL] Tag apply failed: HTTP ${status} — ${err.message}`);
      if (err.response?.data) {
        console.error('[GHL] Tag response body:', JSON.stringify(err.response.data).slice(0, 300));
      }
    }
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Tag application disabled after ${GHL_FAIL_THRESHOLD} failures.`);
    }
    return false;
  }
}

// Remove tags via DELETE — for active-entry:* swap
export async function removeGHLTags(ghlContactId, tags) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return false;
  if (!tags || tags.length === 0) return true;
  try {
    await ghlClient.delete(`/contacts/${ghlContactId}/tags`, {
      data: { tags },
    });
    ghlFailCount = 0;
    return true;
  } catch (err) {
    if (isContactNotFound(err)) {
      console.warn(`[GHL] Tag remove: contact ${ghlContactId} not found — skipping`);
      return false;
    }
    ghlFailCount++;
    const status = err.response?.status || 'no response';
    if (ghlFailCount === 1) {
      console.error(`[GHL] Tag remove failed: HTTP ${status} — ${err.message}`);
    }
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Tag removal disabled after ${GHL_FAIL_THRESHOLD} failures.`);
    }
    return false;
  }
}

export async function updateGHLContactFields(ghlContactId, customFields) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return false;
  if (!customFields || customFields.length === 0) return false;

  try {
    await ghlClient.put(`/contacts/${ghlContactId}`, {
      customFields,
    });
    ghlFailCount = 0;

    if (!loggedFirstFieldUpdate) {
      loggedFirstFieldUpdate = true;
      console.log(`[GHL] First field update: contactId=${ghlContactId}, ${customFields.length} fields pushed`);
    }
    return true;
  } catch (err) {
    if (isContactNotFound(err)) {
      console.warn(`[GHL] Field update: contact ${ghlContactId} not found (deleted?) — returning 'not_found'`);
      return 'not_found';
    }

    ghlFailCount++;
    const status = err.response?.status || 'no response';
    if (ghlFailCount === 1) {
      console.error(`[GHL] Field update failed: HTTP ${status} — ${err.message}`);
      if (err.response?.data) {
        console.error('[GHL] Field update response:', JSON.stringify(err.response.data).slice(0, 500));
      }
    }
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Field updates disabled after ${GHL_FAIL_THRESHOLD} failures.`);
    }
    return false;
  }
}

/**
 * Update a GHL contact's core email field.
 * Uses PUT /contacts/{id} with just the email field.
 * NOTE: Do NOT include tags array in PUT body — it replaces all tags.
 */
export async function updateGHLContactEmail(ghlContactId, email) {
  if (ghlDisabled || !ghlClient || !ghlContactId || !email) return false;

  try {
    await ghlClient.put(`/contacts/${ghlContactId}`, { email });
    ghlFailCount = 0;
    console.log(`[GHL] Email updated for ${ghlContactId}: ${email}`);
    return true;
  } catch (err) {
    if (isContactNotFound(err)) {
      console.warn(`[GHL] Email update: contact ${ghlContactId} not found — skipping`);
      return 'not_found';
    }
    ghlFailCount++;
    const status = err.response?.status || 'no response';
    console.error(`[GHL] Email update failed for ${ghlContactId}: HTTP ${status} — ${err.message}`);
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Email updates disabled after ${GHL_FAIL_THRESHOLD} failures.`);
    }
    return false;
  }
}

/**
 * Fetch a GHL contact by ID (lightweight GET for pre-update checks).
 * Returns the contact object or null on error/not-found.
 */
export async function getGHLContact(ghlContactId) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return null;

  try {
    const { data } = await ghlClient.get(`/contacts/${ghlContactId}`);
    ghlFailCount = 0;
    return data?.contact || data || null;
  } catch (err) {
    if (isContactNotFound(err)) return null;
    ghlFailCount++;
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Contact fetches disabled after ${GHL_FAIL_THRESHOLD} failures.`);
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// NOTE DE-DUPLICATION (idempotency)
// ───────────────────────────────────────────────────────────────────
// Incident 2026-05-28 (contact rrtfnVLWXB2GnYt7xu6b): a single contact
// received 5 byte-identical "[LP SYNC] Appointment set" notes over
// ~54 minutes. Root cause was upstream — a GHL APPT-handler workflow
// fired POST /webhook/ghl/set-lp-appointment five times, and the sync's
// own duplicate guard (in lp-appointment-sync.js) only read the
// appointment_set / appointment_date columns from the Supabase lp_leads
// CACHE. That cache is only refreshed by the 15-minute sync sweep, so
// inside that window every re-fire saw a stale (un-set) row, passed the
// guard, and blindly wrote another note (and re-sent GroupMe + re-called
// LP SetAppointment).
//
// Fixing only that one guard would still leave every OTHER note writer
// exposed to the same double-fire pattern. So we make note creation
// itself idempotent here, at the single chokepoint every note write
// passes through: before POSTing, read the contact's recent notes and
// skip the write if an identical body already exists inside a recency
// window. This is caller-agnostic — any double-fired note write is now
// suppressed at the source no matter which workflow/handler triggered it.
//
// Window is deliberately generous (default 6h). Byte-identical SYSTEM
// notes are never something we intend to write twice, so a long window
// cannot suppress anything we'd actually want kept. A caller that
// genuinely needs to allow an identical repeat can opt out with
// addGHLNote(id, body, { dedupe: false }).
//
// FAIL-OPEN: if the pre-read fails for any reason, we proceed with the
// write. This guard exists to prevent spam, and must never cause a
// legitimate note to be lost because a read hiccupped.
// ═══════════════════════════════════════════════════════════════════
const NOTE_DEDUP_WINDOW_MIN = Number(process.env.GHL_NOTE_DEDUP_WINDOW_MIN || 360);

function normalizeNoteBody(body) {
  // Trim + collapse internal whitespace so trivial formatting noise
  // (e.g. a stray double space) can't defeat an otherwise-identical match.
  return String(body || '').trim().replace(/\s+/g, ' ');
}

/**
 * Look for an existing note on this contact whose body is identical to
 * `noteBody` and was added within NOTE_DEDUP_WINDOW_MIN minutes.
 * Returns the matching note id (or the string 'match' if the id is
 * absent), or null when there is no recent duplicate.
 *
 * Fail-open: any read error returns null (caller will then write).
 */
async function findRecentDuplicateNote(ghlContactId, noteBody) {
  try {
    const { data } = await ghlClient.get(`/contacts/${ghlContactId}/notes`);
    const notes = data?.notes || (Array.isArray(data) ? data : []);
    if (!Array.isArray(notes) || notes.length === 0) return null;

    const target = normalizeNoteBody(noteBody);
    const cutoff = Date.now() - NOTE_DEDUP_WINDOW_MIN * 60 * 1000;

    for (const n of notes) {
      if (!n) continue;
      if (normalizeNoteBody(n.body) !== target) continue;
      // Enforce the recency window when a timestamp is readable; if the
      // API omits one, a body match alone is enough to treat as a dup
      // (suppressing is safer than spamming for identical system notes).
      const ts = n.dateAdded || n.createdAt || n.dateUpdated;
      if (ts) {
        const t = new Date(ts).getTime();
        if (!Number.isNaN(t) && t < cutoff) continue;
      }
      return n.id || 'match';
    }
    return null;
  } catch (err) {
    console.warn(`[GHL] Note dedup pre-check failed for ${ghlContactId} (writing anyway): ${err.message}`);
    return null;
  }
}

/**
 * Add a note to a GHL contact.
 *
 * Idempotent by default: if an identical note body already exists on the
 * contact within the dedup window, the write is skipped and a marker
 * object ({ skipped: true, ... }) is returned instead of creating a
 * duplicate. Pass { dedupe: false } to force the write.
 *
 * @param {string} ghlContactId
 * @param {string} noteBody
 * @param {{ dedupe?: boolean }} [options]
 */
export async function addGHLNote(ghlContactId, noteBody, options = {}) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return null;
  if (!noteBody || noteBody.trim().length === 0) return null;

  const dedupe = options.dedupe !== false; // default ON

  if (dedupe) {
    const dupId = await findRecentDuplicateNote(ghlContactId, noteBody);
    if (dupId) {
      console.log(`[GHL] Skipped duplicate note for ${ghlContactId} — matches existing note ${dupId} within ${NOTE_DEDUP_WINDOW_MIN}m`);
      return { skipped: true, reason: 'duplicate_note', matched_note_id: dupId };
    }
  }

  try {
    const { data } = await ghlClient.post(`/contacts/${ghlContactId}/notes`, {
      body: noteBody.trim(),
    });
    ghlFailCount = 0;

    if (!loggedFirstNote) {
      loggedFirstNote = true;
      console.log(`[GHL] First note added: contactId=${ghlContactId}, ${noteBody.trim().length} chars`);
    }

    return data || { success: true };
  } catch (err) {
    if (isContactNotFound(err)) {
      console.warn(`[GHL] Note add: contact ${ghlContactId} not found (deleted?) — skipping`);
      return null;
    }
    ghlFailCount++;
    const status = err.response?.status || 'no response';
    if (ghlFailCount === 1) {
      console.error(`[GHL] Note add failed: HTTP ${status} — ${err.message}`);
      if (err.response?.data) {
        console.error('[GHL] Note response:', JSON.stringify(err.response.data).slice(0, 300));
      }
    }
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Notes disabled after ${GHL_FAIL_THRESHOLD} failures.`);
    }
    return null;
  }
}

export function resetGHLState() {
  ghlDisabled = false;
  ghlFailCount = 0;
  loggedFirstMatch = false;
  loggedFirstFieldUpdate = false;
  loggedFirstNote = false;
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}
