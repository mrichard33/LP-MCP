import axios from 'axios';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Log GHL status at module load
console.log(`[GHL] API key: ${GHL_API_KEY ? 'set' : 'MISSING — GHL matching will be disabled'}`);
if (GHL_API_KEY && !GHL_LOCATION_ID) {
  console.warn('[GHL] WARNING: GHL_LOCATION_ID not set — contact search/tag calls will fail without a location');
}

// ─── GHL Availability Check ─────────────────────────────────────
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

// Search GHL contact by phone or email (v2 API)
// NOTE: locationId is ONLY needed here — for GET /contacts/ search queries.
// It must NOT be included in PUT/POST bodies to contact-specific endpoints.
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

// Match LP lead to GHL contact: phone → alt phone → email
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
// NOTE: Do NOT include locationId in body — GHL v2 rejects it with 422.
export async function applyGHLTag(ghlContactId, tag) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return false;
  try {
    await ghlClient.post(`/contacts/${ghlContactId}/tags`, {
      tags: [tag],
    });
    ghlFailCount = 0;
    return true;
  } catch (err) {
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

// ─── Update GHL Contact Custom Fields ────────────────────────────
// Uses PUT /contacts/{contactId} with ONLY customFields in the body.
// CRITICAL: Never include 'tags' — would REPLACE all tags.
// CRITICAL: Never include 'locationId' — GHL v2 API rejects with 422.
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

// ─── Add Note to GHL Contact ─────────────────────────────────────
// POST /contacts/{contactId}/notes with { body: "note text" }
// CRITICAL: Do NOT include locationId — GHL v2 rejects it.
//
// @param {string} ghlContactId - GHL contact ID
// @param {string} noteBody - The note text content
// @returns {Object|null} GHL note object on success, null on failure
export async function addGHLNote(ghlContactId, noteBody) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return null;
  if (!noteBody || noteBody.trim().length === 0) return null;

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

// Re-enable GHL (called at start of each sync cycle)
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
