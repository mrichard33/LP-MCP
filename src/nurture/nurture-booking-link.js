/**
 * Nurture Booking Link Builder — src/nurture/nurture-booking-link.js
 *
 * Composes the booking URL the agentic system emits in CTAs. As of
 * v2.0 (2026-05-12), prefers a GHL trigger link merge tag when the
 * prompt has one mapped, and falls back to a direct UTM-laden URL
 * when no trigger link is configured.
 *
 * TWO MODES OF OPERATION
 * ──────────────────────
 *
 * MODE 1 — TRIGGER LINK (preferred when prompt.trigger_link_field_key is set)
 *   Emit `{{trigger_link.<fieldKey>}}` as the URL. GHL substitutes the
 *   merge tag at send time with the short link; on click GHL substitutes
 *   {{contact.*}} merge tags inside the redirectTo and redirects. UTMs
 *   live inside the trigger link's redirectTo (configured via the GHL
 *   admin API). Per-week analytics work via the redirectTo's
 *   utm_content baked in at link-creation time.
 *
 *   This gives the operations team:
 *     - per-link visibility in GHL contact activity timelines
 *     - per-week segmentation in landing-page analytics
 *     - centralized URL updates (change the redirect once via the API,
 *       affects all future sends without redeploying)
 *
 * MODE 2 — DIRECT URL (fallback when no trigger link is mapped)
 *   Builds a per-message URL with dynamic UTMs from prompt + request
 *   context. This is the historical behavior, preserved as a guardrail
 *   so a missing trigger-link mapping never breaks a send. Falls back
 *   silently — the email still goes out with a working URL, just
 *   without the named trigger-link binding.
 *
 *   Triggered by:
 *     - prompt row has no trigger_link_field_key
 *     - prompt row has no cta_type that references a URL (reply_prompt,
 *       reflection_close, self_id_cue) — still emits a URL so prompts
 *       that decide to include one don't 404
 *
 * MERGE TAGS IN THE URL
 * ─────────────────────
 * In direct-URL mode the URL contains literal {{contact.*}} substrings
 * for contact fields that exist on the lead. These resolve at GHL send
 * time, not in our renderTemplate pass (which only walks context paths,
 * not contact.* keys). The orchestrator's renderTemplate substitutes
 * {{nurture_state.booking_url}} with the entire URL string — the
 * {{contact.*}} braces are part of the substituted value and pass
 * through to GHL unmolested.
 *
 * In trigger-link mode the URL IS a {{trigger_link.<key>}} merge tag.
 * GHL substitutes that at send time too, identical pass-through
 * semantics.
 */

const BOOKING_BASE_URL = 'https://landing.reecewindows.com/window-estimate';

/**
 * Contact fields included in the direct-URL fallback when the lead has
 * a non-empty value for them. Order preserved for log readability.
 */
const CONTACT_FIELD_MAP = [
  { leadKey: 'first_name', urlKey: 'first_name', mergeTag: '{{contact.first_name}}' },
  { leadKey: 'last_name',  urlKey: 'last_name',  mergeTag: '{{contact.last_name}}'  },
  { leadKey: 'phone',      urlKey: 'phone',      mergeTag: '{{contact.phone}}'      },
  { leadKey: 'email',      urlKey: 'email',      mergeTag: '{{contact.email}}'      },
];

function hasValue(v) {
  if (v === null || v === undefined) return false;
  return String(v).trim().length > 0;
}

/**
 * Compute UTM parameters for a direct-URL fallback.
 * Only used when no trigger link is mapped on the prompt.
 */
export function buildBookingUtms(prompt, request) {
  const seq = Number(request?.sequence_position) || 1;
  const channel = request?.channel === 'sms' ? 'sms' : 'email';
  const workflowCode = String(request?.workflow_code || '').toLowerCase().replace(/\./g, '-');

  let campaign;
  if (workflowCode === 's4-5' || workflowCode === 's4-5-seinfeld') {
    campaign = 's4-5-seinfeld';
  } else if (workflowCode) {
    campaign = workflowCode;
  } else {
    campaign = 'book-estimate-link';
  }

  const formula = String(prompt?.formula || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const arc = String(prompt?.story_arc || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stage = prompt?.buyer_stage_target;

  const contentParts = [`wk${seq}`];
  if (formula) contentParts.push(formula);
  if (arc) contentParts.push(arc);
  if (stage !== null && stage !== undefined) contentParts.push(`stage${stage}`);
  const content = contentParts.join('-');

  return {
    source: 'ghl',
    medium: channel,
    campaign,
    content,
  };
}

/**
 * Direct-URL fallback builder. Used when no trigger link is mapped.
 * Preserves GHL merge tags for runtime contact-field substitution and
 * omits any contact fields the lead doesn't have on file.
 */
export function buildBookingUrl(utm, lead = {}) {
  const parts = [];

  for (const { leadKey, urlKey, mergeTag } of CONTACT_FIELD_MAP) {
    if (hasValue(lead?.[leadKey])) {
      parts.push(`${urlKey}=${mergeTag}`);
    }
  }

  parts.push(`utm_source=${encodeURIComponent(utm.source)}`);
  parts.push(`utm_medium=${encodeURIComponent(utm.medium)}`);
  parts.push(`utm_campaign=${encodeURIComponent(utm.campaign)}`);
  parts.push(`utm_content=${encodeURIComponent(utm.content)}`);

  return `${BOOKING_BASE_URL}?${parts.join('&')}`;
}

/**
 * Public composition helper. Build the full nurture_state block to be
 * injected into the context envelope before generation.
 *
 * v2.0 (2026-05-12) — trigger-link-aware. Prefers trigger link merge
 * tag when prompt.trigger_link_field_key is set. Falls back to direct
 * URL otherwise. Always returns a non-null booking_url string so the
 * prompt template's {{nurture_state.booking_url}} reference never
 * resolves to empty.
 *
 * The orchestrator should set:
 *   context.nurture_state = buildNurtureState(prompt, request, context);
 *
 * After injection, the user_prompt_template can reference any of:
 *   {{nurture_state.booking_url}}      — full URL string (trigger link
 *                                         merge tag OR direct URL)
 *   {{nurture_state.url_mode}}         — 'trigger_link' | 'direct'
 *   {{nurture_state.utm_campaign}}     — only meaningful in direct mode
 *   {{nurture_state.utm_content}}      — only meaningful in direct mode
 *   {{nurture_state.utm_source}}       — only meaningful in direct mode
 *   {{nurture_state.utm_medium}}       — only meaningful in direct mode
 *
 * @param {object} prompt
 * @param {object} request
 * @param {object} context
 * @returns {{booking_url:string, url_mode:string, utm_campaign:string, utm_content:string, utm_source:string, utm_medium:string}}
 */
export function buildNurtureState(prompt, request, context = {}) {
  const utm = buildBookingUtms(prompt, request);
  const lead = context?.lead || {};

  // Mode 1: trigger link is mapped → use merge tag, skip direct URL build.
  // The fieldKey identifies the link in the GHL location-scoped namespace.
  const fieldKey = prompt?.trigger_link_field_key;
  if (fieldKey && typeof fieldKey === 'string' && fieldKey.trim().length > 0) {
    return {
      booking_url: `{{trigger_link.${fieldKey.trim()}}}`,
      url_mode: 'trigger_link',
      utm_campaign: utm.campaign,
      utm_content: utm.content,
      utm_source: utm.source,
      utm_medium: utm.medium,
    };
  }

  // Mode 2: direct-URL fallback. Composes per-message URL with dynamic
  // UTMs and conditional contact fields. Identical to v1.x behavior.
  return {
    booking_url: buildBookingUrl(utm, lead),
    url_mode: 'direct',
    utm_campaign: utm.campaign,
    utm_content: utm.content,
    utm_source: utm.source,
    utm_medium: utm.medium,
  };
}
