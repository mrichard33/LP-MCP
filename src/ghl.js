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
