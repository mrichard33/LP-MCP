/**
 * Nurture Booking Link Builder — src/nurture/nurture-booking-link.js
 *
 * Composes the booking URL the agentic system emits in CTAs. As of
 * v2.2 (2026-05-12), normalizes the trigger_link_field_key into either
 * form (bare id or full {{trigger_link.id}} merge tag) and emits
 * exactly one well-formed merge tag.
 *
 * TWO MODES OF OPERATION
 * ──────────────────────
 *
 * MODE 1 — TRIGGER LINK (preferred when prompt.trigger_link_field_key is set)
 *   Emit `{{trigger_link.<id>}}` as the URL. GHL substitutes the merge
 *   tag at send time with the short link; on click GHL substitutes
 *   {{contact.*}} merge tags inside the redirectTo and redirects. UTMs
 *   live inside the trigger link's redirectTo (configured via the GHL
 *   admin API). Per-week analytics work via the redirectTo's
 *   utm_content baked in at link-creation time.
 *
 *   Why we accept BOTH forms in trigger_link_field_key:
 *     - GHL's POST /links/ response returns `fieldKey` as the FULL
 *       wrapped merge tag (e.g. "{{trigger_link.xph2s9MW7c6oJQk78zwc}}").
 *     - Earlier hand-mapped rows may store just the bare id.
 *     - Re-wrapping a wrapped value produces double-curlied garbage.
 *   The normalizeFieldKey() helper handles both cleanly.
 *
 *   This gives the operations team:
 *     - per-link visibility in GHL contact activity timelines
 *     - per-week segmentation in landing-page analytics
 *     - centralized URL updates (change the redirect once via the API,
 *       affects all future sends without redeploying)
 *
 * MODE 2 — DIRECT URL (fallback when no trigger link is mapped)
 *   Builds a per-message URL with dynamic UTMs from prompt + request
 *   context. Base URL is the Protection Profile Review calendar (Tier-1
 *   offer), not the Window Estimate page (S4.5 v1.1, 2026-09-03).
 *   This is the historical behavior, preserved as a guardrail
 *   so a missing trigger-link mapping never breaks a send. Falls back
 *   silently — the email still goes out with a working URL, just
 *   without the named trigger-link binding.
 *
 * CTA TYPE + HAS_PS PROPAGATION (v2.1)
 * ─────────────────────────────────────
 * The CTA TYPE PLAYBOOK in the prompt's system_prompt branches on
 * cta_type. The model needs to know which type this generation uses,
 * so nurture_state surfaces it via {{nurture_state.cta_type}} and
 * {{nurture_state.has_ps}}. Defaults: cta_type='soft_booking_offer',
 * has_ps=false — applied when the prompt row doesn't specify (e.g.
 * old non-S4.5 prompts).
 */

// Tier-1 offer (Protection Profile Review, 15-min call). S4.5 v1.1:
// every nurture CTA lands here, never on the in-home estimate page.
const BOOKING_BASE_URL = 'https://link.reecewindows.com/widget/booking/DQYMaJ22N6zL4SXjHukw';

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
 * Normalize a trigger_link_field_key into a fully-formed merge tag.
 *
 * Inputs we accept (case-insensitive on the prefix, lenient on whitespace):
 *   "{{trigger_link.xph2s9MW7c6oJQk78zwc}}"  → use as-is
 *   "{{ trigger_link.xph2s9MW7c6oJQk78zwc }}" → re-emit canonical form
 *   "xph2s9MW7c6oJQk78zwc"                    → wrap as {{trigger_link.xph2s9MW7c6oJQk78zwc}}
 *
 * Returns null if the input isn't a non-empty string.
 */
function normalizeTriggerLinkMergeTag(fieldKey) {
  if (!fieldKey || typeof fieldKey !== 'string') return null;
  const trimmed = fieldKey.trim();
  if (trimmed.length === 0) return null;

  // Already a merge tag — normalize whitespace and return canonical form.
  const wrappedMatch = trimmed.match(/^\{\{\s*trigger_link\.([^}\s]+)\s*\}\}$/i);
  if (wrappedMatch) {
    return `{{trigger_link.${wrappedMatch[1]}}}`;
  }

  // Bare id — wrap it.
  return `{{trigger_link.${trimmed}}}`;
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
 * v2.2 (2026-05-12) — normalize trigger_link_field_key (accepts both
 *   bare id and wrapped merge tag). Fixes double-wrap when GHL's
 *   POST /links/ response stores `fieldKey` as the full merge tag.
 *
 * The orchestrator should set:
 *   context.nurture_state = buildNurtureState(prompt, request, context);
 *
 * After injection, the user_prompt_template can reference any of:
 *   {{nurture_state.booking_url}}      — full URL string (trigger link
 *                                         merge tag OR direct URL)
 *   {{nurture_state.url_mode}}         — 'trigger_link' | 'direct'
 *   {{nurture_state.cta_type}}         — see CTA TYPE PLAYBOOK in system prompt
 *   {{nurture_state.has_ps}}           — 'true' | 'false' (string for template safety)
 *   {{nurture_state.utm_campaign}}     — only meaningful in direct mode
 *   {{nurture_state.utm_content}}      — only meaningful in direct mode
 *   {{nurture_state.utm_source}}       — only meaningful in direct mode
 *   {{nurture_state.utm_medium}}       — only meaningful in direct mode
 *
 * @param {object} prompt
 * @param {object} request
 * @param {object} context
 * @returns {object}
 */
export function buildNurtureState(prompt, request, context = {}) {
  const utm = buildBookingUtms(prompt, request);
  const lead = context?.lead || {};

  const cta_type = prompt?.cta_type || 'soft_booking_offer';
  const has_ps = String(prompt?.has_ps === true);

  // Trigger link is the preferred URL source. Normalize handles both
  // bare-id and wrapped-merge-tag inputs (GHL API returns the latter).
  const mergeTag = normalizeTriggerLinkMergeTag(prompt?.trigger_link_field_key);

  let booking_url;
  let url_mode;
  if (mergeTag) {
    booking_url = mergeTag;
    url_mode = 'trigger_link';
  } else {
    booking_url = buildBookingUrl(utm, lead);
    url_mode = 'direct';
  }

  return {
    booking_url,
    url_mode,
    cta_type,
    has_ps,
    utm_campaign: utm.campaign,
    utm_content: utm.content,
    utm_source: utm.source,
    utm_medium: utm.medium,
  };
}
