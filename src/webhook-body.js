/**
 * Shared GHL webhook body normalisation — src/webhook-body.js
 *
 * GHL's standard Webhook action does NOT post the step's declared keys at the
 * top level. The body carries GHL's own contact keys PLUS every custom field
 * keyed by its DISPLAY NAME, and nests the step's declared customData under
 * `customData`. Reading req.body flat therefore yields undefined for every
 * declared key that is not also a native GHL key — which reads downstream as
 * "the field is empty" rather than "I looked in the wrong place".
 *
 * Verified live: system_events ghl.entry_detected shape fingerprints show
 * customData holding exactly the keys the step declares, with those names
 * absent from the top-level body. Same lesson as canvassing-intake.js
 * (33 intake cards, 2026-07-24 → 2026-07-28) and canvassing-lead-handler.js
 * (every event-form submission 400ing, 2026-07-30).
 *
 * This module is the shared home for that normalisation. Three near-identical
 * in-module copies predate it — lp-appointment-sync.js flattenWebhookBody,
 * notifications/appointment-notifications.js extractRequestFields, and
 * nurture/nurture-orchestrator.js extractRequestFields — each with its own live
 * test coverage. They are deliberately left alone; new callers import from here.
 */

/**
 * GHL workflow payloads arrive in one of four shapes:
 *
 *   1. flat top-level:
 *        { contactId: '...', canvass_version: 'v2' }
 *
 *   2. customData object (current standard Webhook action):
 *        { contactId: '...', customData: { canvass_version: 'v2' } }
 *
 *   3. customData stringified JSON:
 *        { contactId: '...', customData: '{"canvass_version":"v2"}' }
 *
 *   4. customData array of {key, value} pairs (older step versions):
 *        { contactId: '...', customData: [{key:'canvass_version', value:'v2'}] }
 *
 * This helper merges customData into the top level so downstream code can do a
 * single property lookup regardless of shape.
 *
 * Returns a new object (does not mutate the input). Top-level keys take
 * precedence over customData keys with the same name — an explicit top-level
 * value is a deliberate override, and customData only fills the gaps.
 */
export function flattenWebhookBody(body) {
  if (!body || typeof body !== 'object') return {};
  const merged = { ...body };
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
        // not JSON — fall through, leave merged as-is
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

  // customData fills in only where the top level doesn't already have a value,
  // so explicit top-level keys win.
  if (cdFlat) {
    for (const [k, v] of Object.entries(cdFlat)) {
      if (!(k in merged) || merged[k] === undefined || merged[k] === null || merged[k] === '') {
        merged[k] = v;
      }
    }
  }
  return merged;
}

/**
 * Describe an inbound webhook's shape for the log — Content-Type, which keys
 * arrived where, and what form customData took. Mirrors the fingerprint in
 * entry-event-handler.js resolveEntryFields.
 *
 * Log this UNCONDITIONALLY, on every request. A diagnostic that only fires on
 * the failure path can never tell you what a successful sender looks like, and
 * the sender's real Content-Type is exactly the fact that is hardest to
 * recover after the fact.
 *
 * Never throws — a diagnostic must not be able to take down the route it
 * describes.
 */
export function webhookShapeFingerprint(req) {
  try {
    const body = (req && req.body && typeof req.body === 'object' && !Array.isArray(req.body))
      ? req.body : {};
    const cd = body.customData;

    let customData_shape;
    if (cd === undefined || cd === null) customData_shape = 'absent';
    else if (Array.isArray(cd)) customData_shape = `array[${cd.length}]`;
    else if (typeof cd === 'object') customData_shape = `object{${Object.keys(cd).length}}`;
    else if (typeof cd === 'string') customData_shape = `string[${cd.length}]`;
    else customData_shape = typeof cd;

    return {
      content_type: (req && req.headers && req.headers['content-type']) || null,
      body_keys: Object.keys(body),
      customData_shape,
      customData_keys: (cd && typeof cd === 'object' && !Array.isArray(cd)) ? Object.keys(cd) : [],
      query_keys: req && req.query ? Object.keys(req.query) : [],
    };
  } catch (err) {
    return { fingerprint_error: err.message };
  }
}
