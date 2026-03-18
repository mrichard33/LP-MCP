import axios from 'axios';

const GHL_API_KEY = process.env.GHL_API_KEY;

// Log GHL status at module load
console.log(`[GHL] API key: ${GHL_API_KEY ? 'set' : 'MISSING — GHL matching will be disabled'}`);

// ─── GHL Availability Check ─────────────────────────────────────
// If GHL key is missing or fails auth, disable GHL for the rest of the sync
// to avoid 250K+ failed HTTP calls that would make the sync take forever.
let ghlDisabled = false;
let ghlFailCount = 0;
const GHL_FAIL_THRESHOLD = 5; // Disable after 5 consecutive failures

const ghlClient = GHL_API_KEY ? axios.create({
  baseURL: 'https://rest.gohighlevel.com/v1',
  headers: {
    'Authorization': `Bearer ${GHL_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
}) : null;

// Search GHL contact by phone or email
export async function searchGHLContact(params) {
  if (ghlDisabled || !ghlClient) return null;
  try {
    const { data } = await ghlClient.get('/contacts/search', { params });
    ghlFailCount = 0; // Reset on success
    return data?.contacts?.[0] || null;
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
    ghlFailCount++;
    if (ghlFailCount >= GHL_FAIL_THRESHOLD) {
      ghlDisabled = true;
      console.error(`[GHL] Tag application disabled after ${GHL_FAIL_THRESHOLD} failures.`);
    }
    return false;
  }
}

// Re-enable GHL (called at start of each sync cycle)
export function resetGHLState() {
  ghlDisabled = false;
  ghlFailCount = 0;
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}
