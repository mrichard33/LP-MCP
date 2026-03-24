import axios from 'axios';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Log GHL status at module load
console.log(`[GHL] API key: ${GHL_API_KEY ? 'set' : 'MISSING — GHL matching will be disabled'}`);
if (GHL_API_KEY && !GHL_LOCATION_ID) {
  console.warn('[GHL] WARNING: GHL_LOCATION_ID not set — contact search/tag calls will fail without a location');
}

// ─── GHL Availability Check ─────────────────────────────────────
// If GHL key is missing or fails auth, disable GHL for the rest of the sync
// to avoid 250K+ failed HTTP calls that would make the sync take forever.
let ghlDisabled = false;
let ghlFailCount = 0;
let loggedFirstMatch = false;
let loggedFirstFieldUpdate = false;
const GHL_FAIL_THRESHOLD = 5; // Disable after 5 consecutive failures

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
export async function searchGHLContact(params) {
  if (ghlDisabled || !ghlClient) return null;
  try {
    // v2 API: GET /contacts/ with query param
    const query = params.phone || params.email || '';
    const { data } = await ghlClient.get('/contacts/', {
      params: { query, locationId: process.env.GHL_LOCATION_ID },
    });
    ghlFailCount = 0; // Reset on success
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
      console.error(`[GHL] Disabled after ${GHL_FAIL_THRESHOLD} consecutive failures (HTTP ${status}: ${err.message}). GHL matching skipped for this sync cycle.`);
      if (status === 401) {
        console.error('[GHL] 401 = invalid/expired API key. If using GHL v2 OAuth, the v1 location key may no longer work. Check GHL_API_KEY env var.');
      }
    } else if (ghlFailCount === 1) {
      // Log first failure with full detail for debugging
      console.error(`[GHL] Contact search failed: HTTP ${status} — ${err.message}`);
      if (err.response?.data) {
        console.error('[GHL] Response body:', JSON.stringify(err.response.data).slice(0, 300));
      }
    }
    return null;
  }
}

// Match LP lead to GHL contact: phone (primary) → phone_alt → email (fallback)
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

// Apply tag via POST (additive) — NEVER use PUT which replaces all tags (v2 API)
export async function applyGHLTag(ghlContactId, tag) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return false;
  try {
    await ghlClient.post(`/contacts/${ghlContactId}/tags`, {
      tags: [tag],
      locationId: process.env.GHL_LOCATION_ID,
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
      console.error(`[GHL] Tag application disabled after ${GHL_FAIL_THRESHOLD} failures (last: HTTP ${status}).`);
    }
    return false;
  }
}

// ─── Update GHL Contact Custom Fields ────────────────────────────
//
// Uses PUT /contacts/{contactId} with ONLY customFields in the body.
// CRITICAL: Never include 'tags' in the PUT body — that would REPLACE
// all tags on the contact. We only pass customFields, which is additive.
//
// @param {string} ghlContactId - GHL contact ID
// @param {Array} customFields - Array of { id, field_value } objects
// @returns {boolean} true on success

export async function updateGHLContactFields(ghlContactId, customFields) {
  if (ghlDisabled || !ghlClient || !ghlContactId) return false;
  if (!customFields || customFields.length === 0) return false;

  try {
    await ghlClient.put(`/contacts/${ghlContactId}`, {
      customFields,
      locationId: process.env.GHL_LOCATION_ID,
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
      console.error(`[GHL] Field updates disabled after ${GHL_FAIL_THRESHOLD} failures (last: HTTP ${status}).`);
    }

    return false;
  }
}

// Re-enable GHL (called at start of each sync cycle)
export function resetGHLState() {
  ghlDisabled = false;
  ghlFailCount = 0;
  loggedFirstMatch = false;
  loggedFirstFieldUpdate = false;
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}
