/**
 * Nurture Booking Link Builder — src/nurture/nurture-booking-link.js
 *
 * Composes the booking URL the agentic system emits in CTAs, with
 * dynamic UTM parameters derived from the prompt + request context.
 *
 * WHY DYNAMIC UTMs INSTEAD OF A GHL TRIGGER LINK
 * ──────────────────────────────────────────────
 * GHL trigger links (the `{{trigger_link.<id>}}` merge tag) have a
 * single redirectTo string baked in at link creation time. Their
 * UTM parameters are STATIC across every send. That meant earlier
 * generations all reported the same utm_campaign / utm_content,
 * losing the per-cycle attribution needed to learn which messages
 * drive bookings.
 *
 * This module replaces the trigger-link approach: the orchestrator
 * builds a per-message URL with dynamic UTMs based on
 *   - workflow_code     → utm_campaign program
 *   - sequence_position → cycle-level identifier
 *   - story_arc/formula → utm_content variant identifier
 *   - channel           → utm_medium
 * and injects the rendered URL into the context envelope as
 *   context.nurture_state.booking_url
 *
 * The user_prompt_template references {{nurture_state.booking_url}}
 * so each generation receives the right URL pre-rendered. GHL still
 * tracks clicks (auto-rewrites every URL in email through its proxy)
 * so the engagement pipeline (I.ENG webhook → /api/agentic/messages/engagement)
 * still fires — just without the named trigger-link binding.
 *
 * MERGE TAGS IN THE URL
 * ─────────────────────
 * The URL contains literal {{contact.*}} substrings for contact
 * fields that exist on the lead. These resolve at GHL send time, not
 * in our renderTemplate pass (which only walks context paths, not
 * contact.* keys). The orchestrator's renderTemplate substitutes
 * {{nurture_state.booking_url}} with the entire URL string — the
 * {{contact.*}} braces are part of the substituted value and pass
 * through to GHL unmolested.
 *
 * CONDITIONAL CONTACT FIELDS (v1.1 — 2026-05-12)
 * ──────────────────────────────────────────────
 * Contact field merge tags (first_name, last_name, phone, email) are
 * only included when the corresponding field exists on the lead in
 * context.lead.*. Absent fields are omitted from the URL entirely
 * rather than rendering as `&last_name=`. Rationale: a contact with
 * only a phone number shouldn't surface empty params downstream, and
 * the landing page can pre-fill only the fields we actually have.
 *
 * Detection is "non-empty after trimming" — null, undefined, '', and
 * whitespace-only all count as absent. If you want a field to ALWAYS
 * appear regardless of value, add it to ALWAYS_INCLUDE below.
 *
 * EXTENSION POINT
 * ───────────────
 * To add new CTAs (e.g. a calculator funnel link), add a new builder
 * function and a corresponding context key. Don't lump every CTA into
 * the same context key — buyer_stage rules in the prompts depend on
 * routing different stages to different CTAs.
 */

const BOOKING_BASE_URL = 'https://landing.reecewindows.com/window-estimate';

/**
 * Contact fields we will include in the URL as GHL merge tags when
 * the field has a non-empty value on the lead. Order is preserved
 * in the output URL so generated URLs are consistent across calls
 * for the same contact (helps with caching, log readability, and
 * any downstream UTM analytics that match on URL substrings).
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
 * Compute UTM parameters for a single generation.
 *
 * Defaults are intentional:
 *   utm_source  = 'ghl'         — the platform sending the message
 *   utm_medium  = 'email'|'sms' — derived from request.channel
 *   utm_campaign = workflow-aware program identifier
 *                  ("s4-5-seinfeld" for S4.5, generic otherwise)
 *   utm_content = per-message variant ID (cycle + story arc + formula)
 *
 * @param {object} prompt   — prompt row from agentic_messaging_prompts
 * @param {object} request  — generation request {workflow_code, sequence_position, channel, ...}
 * @returns {{source:string, medium:string, campaign:string, content:string}}
 */
export function buildBookingUtms(prompt, request) {
  const seq = Number(request?.sequence_position) || 1;
  const channel = request?.channel === 'sms' ? 'sms' : 'email';
  const workflowCode = String(request?.workflow_code || '').toLowerCase().replace(/\./g, '-');

  // Campaign = workflow program. For S4.5 we want "s4-5-seinfeld" since
  // it's the human-readable program identifier marketing uses; for any
  // other workflow we fall back to the slugified workflow_code.
  let campaign;
  if (workflowCode === 's4-5' || workflowCode === 's4-5-seinfeld') {
    campaign = 's4-5-seinfeld';
  } else if (workflowCode) {
    campaign = workflowCode;
  } else {
    campaign = 'book-estimate-link';
  }

  // Content = specific variant. Builds from prompt metadata so analytics
  // can split conversion by story arc, formula, and cycle position.
  // Example: "wk3-episode-sa2" or "wk1-epiphany-sa3-stage1"
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
 * Build the booking URL from UTM params + lead, preserving GHL merge
 * tags for runtime contact-field substitution and omitting any
 * contact fields the lead doesn't have on file.
 *
 * Output shape (example, lead has first_name + phone + email but no last_name):
 *   https://landing.reecewindows.com/window-estimate?
 *     first_name={{contact.first_name}}&
 *     phone={{contact.phone}}&
 *     email={{contact.email}}&
 *     utm_source=ghl&
 *     utm_medium=email&
 *     utm_campaign=<campaign>&
 *     utm_content=<content>
 *
 * NOTE: we do NOT URL-encode {{contact.*}} braces. URLSearchParams
 * would percent-encode them, and GHL would resolve them as literal
 * text rather than merge tags. Plain concatenation is correct here.
 *
 * @param {{source,medium,campaign,content}} utm
 * @param {object} lead  — context.lead object; first_name/last_name/phone/email
 *                         are checked for non-empty values
 * @returns {string} fully-composed URL with merge tags intact
 */
export function buildBookingUrl(utm, lead = {}) {
  const parts = [];

  // Contact fields first — only include each one if the lead has a
  // non-empty value for it. Missing fields are omitted entirely.
  for (const { leadKey, urlKey, mergeTag } of CONTACT_FIELD_MAP) {
    if (hasValue(lead?.[leadKey])) {
      parts.push(`${urlKey}=${mergeTag}`);
    }
  }

  // UTM params — always present, regardless of contact field state.
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
 * The orchestrator should set:
 *   context.nurture_state = buildNurtureState(prompt, request, context);
 *
 * After injection, the user_prompt_template can reference any of:
 *   {{nurture_state.booking_url}}
 *   {{nurture_state.utm_campaign}}
 *   {{nurture_state.utm_content}}
 *   {{nurture_state.utm_source}}
 *   {{nurture_state.utm_medium}}
 *
 * @param {object} prompt
 * @param {object} request
 * @param {object} context  — the lead context envelope, used to read
 *                            lead.first_name / last_name / phone / email
 *                            so absent fields can be omitted from the URL.
 *                            Optional for backwards compatibility — when
 *                            omitted, NO contact merge tags are included.
 * @returns {{booking_url:string, utm_campaign:string, utm_content:string, utm_source:string, utm_medium:string}}
 */
export function buildNurtureState(prompt, request, context = {}) {
  const utm = buildBookingUtms(prompt, request);
  const lead = context?.lead || {};
  return {
    booking_url: buildBookingUrl(utm, lead),
    utm_campaign: utm.campaign,
    utm_content: utm.content,
    utm_source: utm.source,
    utm_medium: utm.medium,
  };
}
