/**
 * KB Retriever — src/knowledge/kb-retriever.js
 *
 * Orchestrates structured KB lookups (Tier 1) for the response generator.
 *
 * v1.5 — 2026-04-28. GHL TRIGGER LINK TAGS for per-click attribution.
 *   Per Mark: "When the trigger link is clicked, the GHL account tracks
 *   the clicks. It is pretty important if possible if we can send the
 *   actual trigger link for this reason."
 *
 *   Big shift: booking_url now returns the GHL trigger link MERGE TAG
 *   (e.g. `{{trigger_link.QqvhMNyB7YQzHqSNOXHm}}`), not a resolved URL.
 *   GHL renders the merge tag at delivery, generating a unique tracked
 *   URL per recipient. This gives Mark per-message, per-contact click
 *   attribution that resolved URLs can't match — even when the resolved
 *   URL goes through link.reecewindows.com.
 *
 *   The trigger link's URL is configured in GHL (see Mark's spec) with
 *   utm_source=ghl, utm_medium=sms, utm_campaign=agentic_bot,
 *   utm_content=<calendar-specific>, and {{contact.*}} merge tags for
 *   pre-fill. GHL substitutes contact data + click tracking automatically.
 *
 *   Two dynamic UTM additions (appended after the merge tag):
 *     - utm_term=<policy_slug> — encodes which booking policy fired
 *       (phone_primary | mv | confirm | in_home_first), enabling
 *       attribution analysis by user-preference path
 *     - utm_medium=email — only appended when channel='email'; the
 *       trigger link's static utm_medium is 'sms'. GA4/Meta take the
 *       last value of duplicate params, so this overrides correctly.
 *
 *   Trigger Link IDs (configured in GHL by Mark):
 *     CONFIRMATION_CALL  → sfQAvcOczlOGQX1LE0Ht  (book call)
 *     WINDOW_ESTIMATE    → QqvhMNyB7YQzHqSNOXHm
 *     MV                 → SPQHJKSLbwhJ1bhg2dIy  (book measurement verification)
 *     ESTIMATE_CALCULATOR → aS10ZzuBDRI2GUpzQh1v
 *
 *   utm_content slugs (per Mark's updated spec):
 *     CONFIRMATION_CALL  → book_call_link
 *     WINDOW_ESTIMATE    → book_window_estimate_link
 *     MV                 → book_measurement_verification_link  (was book_mv_link)
 *     ESTIMATE_CALCULATOR → estimate_calculator_pricing_link   (was universal_pricing_link)
 *
 *   Backward-compatible additions:
 *     - booking_url_resolved exposed alongside booking_url for diagnostics
 *       and any consumer that needs the static URL form
 *     - buildBookingUrl() retained for resolved-URL use cases (calculator
 *       links sent outside conversation API context, debugging, etc.)
 *     - New exports: buildTriggerLinkUrl, getEstimateCalculatorTriggerLink
 *
 * v1.3 — Context-aware calendar selection (4-policy decision tree).
 * v1.2 — In-home-first booking policy (superseded by v1.3).
 * v1.1 — Calendar awareness: resolveBookingContext + activeEntryTag.
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';

// ═══════════════════════════════════════════════════════════════════
// CALENDAR + TRIGGER LINK CONSTANTS
// ═══════════════════════════════════════════════════════════════════

export const CALENDAR_IDS = {
  CONFIRMATION_CALL: 'gFWoSQrlKIdfRbAPV842',  // 1-2min phone confirmation
  WINDOW_ESTIMATE:   'aJj14ONxh1oFyDcQ706O',  // 90-min in-home Window Protection Estimate
  MV:                'zEdPmkNccR2ovo3rQAd3',  // Window Measurement Verification
};

// v1.5: GHL trigger link IDs — Mark's "Agentic Bot Trigger - *" links.
// These are the source of truth for per-click attribution. The bot writes
// the merge tag form ({{trigger_link.<ID>}}) into outbound messages and
// GHL renders it server-side at delivery, generating a unique tracked URL
// per recipient.
export const TRIGGER_LINK_IDS = {
  CONFIRMATION_CALL:   process.env.REECE_TRIGGER_CALL          || 'sfQAvcOczlOGQX1LE0Ht',
  WINDOW_ESTIMATE:     process.env.REECE_TRIGGER_WE            || 'QqvhMNyB7YQzHqSNOXHm',
  MV:                  process.env.REECE_TRIGGER_MV            || 'SPQHJKSLbwhJ1bhg2dIy',
  ESTIMATE_CALCULATOR: process.env.REECE_TRIGGER_CALCULATOR    || 'aS10ZzuBDRI2GUpzQh1v',
};

// utm_content slugs per Mark's updated spec (one per calendar so click
// attribution can distinguish which calendar was clicked). Kept here for
// the resolved-URL fallback path (buildBookingUrl).
const BOOKING_SPECS = {
  CONFIRMATION_CALL: {
    base:        process.env.REECE_CALL_BOOKING_URL || `https://link.reecewindows.com/widget/booking/${CALENDAR_IDS.CONFIRMATION_CALL}`,
    utm_content: 'book_call_link',
    extra_params: {},
  },
  WINDOW_ESTIMATE: {
    base:        process.env.REECE_WE_BOOKING_URL || 'https://landing.reecewindows.com/window-estimate-page',
    utm_content: 'book_window_estimate_link',
    extra_params: {},
  },
  MV: {
    base:        process.env.REECE_MV_BOOKING_URL || 'https://landing.reecewindows.com/measurement-verification',
    utm_content: 'book_measurement_verification_link',
    extra_params: {},
  },
  ESTIMATE_CALCULATOR: {
    base:        process.env.REECE_CALCULATOR_URL || 'https://landing.reecewindows.com/instant-window-pricing-page',
    utm_content: 'estimate_calculator_pricing_link',
    // LP integration markers — pre-attribute calculator clicks to the
    // chatbot pro/source so LP can route them on creation.
    extra_params: { pro_id: '3269', lp_source_id: '842' },
  },
};

// Short policy slugs for utm_term — keeps attribution URLs readable.
const POLICY_TO_UTM_TERM = {
  phone_primary_in_home_fallback: 'phone_primary',
  mv_only:                        'mv',
  confirm_existing_appt:          'confirm',
  in_home_first_call_fallback:    'in_home_first',
};

// ═══════════════════════════════════════════════════════════════════
// URL BUILDERS (v1.5)
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the trigger-link-form booking URL for use in outbound messages.
 *
 * Returns a string of the form:
 *   {{trigger_link.<ID>}}                                (no overrides)
 *   {{trigger_link.<ID>}}&utm_term=<slug>                (policy only)
 *   {{trigger_link.<ID>}}&utm_term=<slug>&utm_medium=email   (email channel)
 *
 * GHL renders the {{trigger_link.<ID>}} portion at delivery time. The
 * appended &param=value chain is glued onto the rendered URL — duplicate
 * utm_medium values are resolved by analytics last-wins behavior.
 *
 * @param {keyof TRIGGER_LINK_IDS} triggerKey
 * @param {Object} opts
 * @param {string} opts.channel — 'sms' | 'email'
 * @param {string} [opts.policy] — Active booking policy
 * @returns {string|null}
 */
export function buildTriggerLinkUrl(triggerKey, opts = {}) {
  const id = TRIGGER_LINK_IDS[triggerKey];
  if (!id) return null;
  const { channel = 'sms', policy = null } = opts;

  let url = `{{trigger_link.${id}}}`;

  const overrides = [];
  if (policy && POLICY_TO_UTM_TERM[policy]) {
    overrides.push(`utm_term=${POLICY_TO_UTM_TERM[policy]}`);
  }
  if (channel === 'email') {
    // Trigger link is configured with utm_medium=sms; this overrides
    // for email sends. Most analytics tools (GA4, Meta) take the last
    // value of duplicate params.
    overrides.push('utm_medium=email');
  }
  if (overrides.length > 0) {
    url += '&' + overrides.join('&');
  }

  return url;
}

/**
 * Build a fully-resolved booking URL with UTMs and contact pre-fill.
 *
 * Used when:
 *   - The bot needs a real URL outside GHL conversation context
 *     (e.g., diagnostic logging, LP MCP tools)
 *   - As a fallback if GHL trigger-link rendering ever fails
 *
 * For outbound messages sent via the GHL conversation API, prefer
 * buildTriggerLinkUrl() — that gets per-click attribution from GHL.
 *
 * @param {Object} spec — { base, utm_content, extra_params }
 * @param {Object} opts
 * @returns {string|null}
 */
export function buildBookingUrl(spec, opts = {}) {
  if (!spec || !spec.base) return null;
  const { channel = 'sms', policy = null, contactData = {} } = opts;

  const params = new URLSearchParams();

  params.set('utm_source',   'ghl');
  params.set('utm_medium',   channel === 'email' ? 'email' : 'sms');
  params.set('utm_campaign', 'agentic_bot');
  params.set('utm_content',  spec.utm_content);
  if (policy && POLICY_TO_UTM_TERM[policy]) {
    params.set('utm_term', POLICY_TO_UTM_TERM[policy]);
  }

  for (const [k, v] of Object.entries(spec.extra_params || {})) {
    if (v !== null && v !== undefined && v !== '') {
      params.set(k, String(v));
    }
  }

  const cd = contactData || {};
  const prefill = {
    fullName:      cd.fullName       || cd.name || cd.full_name || null,
    streetAddress: cd.streetAddress  || cd.address1 || cd.street_address || null,
    city:          cd.city           || null,
    state:         cd.state          || null,
    postalCode:    cd.postalCode     || cd.postal_code || cd.zip || null,
    phone:         cd.phone          || null,
  };
  for (const [k, v] of Object.entries(prefill)) {
    if (v && typeof v === 'string' && v.trim().length > 0) {
      params.set(k, v.trim());
    }
  }

  return `${spec.base}?${params.toString()}`;
}

// Convenience export for tripwire / value-ladder use cases.
export function getEstimateCalculatorTriggerLink(opts = {}) {
  return buildTriggerLinkUrl('ESTIMATE_CALCULATOR', opts);
}
export function getEstimateCalculatorUrl(opts = {}) {
  return buildBookingUrl(BOOKING_SPECS.ESTIMATE_CALCULATOR, opts);
}

// ═══════════════════════════════════════════════════════════════════
// CALENDAR DEFINITION FACTORIES (v1.5 — opts-aware, trigger-link form)
// ═══════════════════════════════════════════════════════════════════

function windowEstimateCalendar(opts) {
  return {
    type:                 'in_home',
    visit_type:           'in_home',
    calendar_id:          CALENDAR_IDS.WINDOW_ESTIMATE,
    calendar_name:        'Window Estimate',
    duration_minutes:     90,
    booking_url:          buildTriggerLinkUrl('WINDOW_ESTIMATE', opts),                  // merge tag (used in messages)
    booking_url_resolved: buildBookingUrl(BOOKING_SPECS.WINDOW_ESTIMATE, opts),         // resolved (debug/fallback)
    description:          'Standard in-home Window Protection Estimate — about an hour and a half. Specialist measures to Florida code and provides exact pricing valid for 1 year. Both homeowners should be present.',
  };
}

function mvCalendar(opts) {
  return {
    type:                 'in_home',
    visit_type:           'in_home',
    calendar_id:          CALENDAR_IDS.MV,
    calendar_name:        'Window Measurement Verification',
    duration_minutes:     90,
    booking_url:          buildTriggerLinkUrl('MV', opts),
    booking_url_resolved: buildBookingUrl(BOOKING_SPECS.MV, opts),
    description:          'In-home measurement verification — about 90 minutes — for leads who came through the online estimate calculator. Specialist verifies measurements and finalizes penny-accurate pricing. Both homeowners should be present.',
  };
}

function confirmationCallCalendar(opts) {
  return {
    type:                 'phone_call',
    visit_type:           'phone',
    calendar_id:          CALENDAR_IDS.CONFIRMATION_CALL,
    calendar_name:        'Confirmation Call',
    duration_minutes:     15,
    booking_url:          buildTriggerLinkUrl('CONFIRMATION_CALL', opts),
    booking_url_resolved: buildBookingUrl(BOOKING_SPECS.CONFIRMATION_CALL, opts),
    description:          '1-2 minute phone call. Used for: (a) leads who explicitly request a phone conversation, (b) confirming details for an existing appointment, (c) brief callback when an in-home is logistically impossible.',
  };
}

function pickInHomeCalendar({ activeEntryTag }, opts) {
  const isEstimateCalculator = typeof activeEntryTag === 'string'
    && activeEntryTag === 'active-entry:estimate-calculator';
  return isEstimateCalculator ? mvCalendar(opts) : windowEstimateCalendar(opts);
}

// ═══════════════════════════════════════════════════════════════════
// USER BOOKING PREFERENCE DETECTION (v1.3 — unchanged)
// ═══════════════════════════════════════════════════════════════════

const PHONE_PREFERENCE_KEYWORDS = [
  'call me', 'phone call', 'give me a ring', 'phone instead',
  'just a call', 'quick call', 'phone first', 'over the phone',
  'rather call', 'just a quick call', 'can we talk', 'on the phone',
  'phone is better', 'easier to call', 'call would be',
  'rather just talk', 'rather just call', 'prefer a call',
  'prefer to call', 'prefer to talk', 'just call', 'phone would',
];

const IN_HOME_PREFERENCE_KEYWORDS = [
  'come out', 'in home', 'in-home', 'come to my house', 'come to the house',
  'come look', 'come see', 'come and look', 'come and see',
  'in person', 'on site', 'on-site', 'see the windows',
  'send someone out', 'have someone come', 'visit',
  'site visit', 'home visit',
];

const MEASUREMENT_KEYWORDS = [
  'measurement verification', 'verify measurements', 'measurement verification visit',
  'measurement appointment', 'verify the measurements', 'mv appointment',
  'verify my measurements', 'come measure', 'come and measure',
  'remeasure', 're-measure', 'come do measurements',
];

const APPT_CONFIRMATION_KEYWORDS = [
  'my appointment', 'my appt', 'when is my', 'what time is my',
  'is my appointment', 'is my appt', 'still on for', 'still good for',
  'confirm my', 'confirm the time', 'confirm my appointment',
  'confirm the appointment', 'time of my appointment', 'time for my',
];

function containsAny(text, keywords) {
  for (const kw of keywords) {
    if (text.includes(kw)) return kw;
  }
  return null;
}

export function detectUserBookingPreference(messageText) {
  if (!messageText || typeof messageText !== 'string') return null;
  const lc = messageText.toLowerCase();

  if (containsAny(lc, MEASUREMENT_KEYWORDS))      return 'mv';
  if (containsAny(lc, APPT_CONFIRMATION_KEYWORDS)) return 'confirm_existing';
  if (containsAny(lc, PHONE_PREFERENCE_KEYWORDS))  return 'phone';
  if (containsAny(lc, IN_HOME_PREFERENCE_KEYWORDS)) return 'in_home';
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// BOOKING CONTEXT RESOLVER (v1.5 — passes channel + policy to URL builders)
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the right booking calendar based on user preference + context.
 *
 * @param {Object} args
 * @param {string} args.intentClass
 * @param {string} [args.activeEntryTag]
 * @param {string} [args.userPreference]
 * @param {boolean} [args.hasExistingAppt]
 * @param {string} [args.lpDisposition]
 * @param {string} [args.channel='sms']  — v1.5: drives utm_medium override
 * @returns {Object} BookingContext with primary, fallback, policy, guidance
 */
export function resolveBookingContext({
  intentClass,
  activeEntryTag,
  userPreference = null,
  hasExistingAppt = false,
  lpDisposition = null,
  channel = 'sms',
} = {}) {
  // Determine policy first so we can bake it into utm_term.
  let policy;
  const isCallbackIntent = intentClass === 'CALLBACK' || intentClass === 'CALLBACK_CALM';
  const isEstimateCalculator = activeEntryTag === 'active-entry:estimate-calculator';

  if (userPreference === 'phone' || isCallbackIntent) {
    policy = 'phone_primary_in_home_fallback';
  } else if (userPreference === 'mv' || isEstimateCalculator) {
    policy = 'mv_only';
  } else if (userPreference === 'confirm_existing' || hasExistingAppt) {
    policy = 'confirm_existing_appt';
  } else {
    policy = 'in_home_first_call_fallback';
  }

  const opts = { channel, policy };
  const inHome = pickInHomeCalendar({ activeEntryTag }, opts);
  const phone  = confirmationCallCalendar(opts);
  const mv     = mvCalendar(opts);

  // ─── CASE A: User asked for a phone call ────────────────────────
  if (policy === 'phone_primary_in_home_fallback') {
    return {
      ...phone,
      primary:  phone,
      fallback: inHome,
      policy,
      guidance: [
        'The lead asked for a phone call. Honor that — offer the 15-min Confirmation Call slot first, not the in-home.',
        'If during that call we discover they want the full in-home estimate, the in-home Window Estimate is the natural next step (it\'s in the fallback).',
        'Do NOT push the in-home as primary when the lead explicitly asked for a call. Match their preference.',
      ].join(' '),
    };
  }

  // ─── CASE B: Measurement Verification ────────────────────────────
  if (policy === 'mv_only') {
    return {
      ...mv,
      primary:  mv,
      fallback: null,
      policy,
      guidance: [
        'This lead came through the online Estimate Calculator (or asked for MV directly).',
        'The next step is a Window Measurement Verification — about 90 minutes, in-home.',
        'A specialist verifies the measurements they entered online and finalizes penny-accurate pricing.',
        'Both homeowners should be present so any questions can be answered on the spot. Do NOT pitch this as a sales appointment — frame it as a verification visit.',
      ].join(' '),
    };
  }

  // ─── CASE C: Existing appointment — confirmation only ────────────
  if (policy === 'confirm_existing_appt') {
    return {
      ...phone,
      primary:  phone,
      fallback: null,
      policy,
      guidance: [
        'Lead has an existing appointment. The right calendar here is the Confirmation Call — used to confirm time, address, who will be present, etc.',
        'Do NOT re-book the in-home appointment. Do NOT offer additional appointment slots.',
        'If the lead wants to RESCHEDULE (not confirm), use the appropriate in-home calendar instead — but lead with empathy and don\'t make them feel bad about needing to move it.',
        lpDisposition ? `LP disposition: ${lpDisposition} — let that color your tone.` : '',
      ].filter(Boolean).join(' '),
    };
  }

  // ─── CASE D (default): In-home first, call as fallback ───────────
  return {
    ...inHome,
    primary:  inHome,
    fallback: phone,
    policy,
    guidance: [
      `Default Reece policy: the in-home ${inHome.calendar_name} is the primary offering — about 90 minutes, both homeowners present.`,
      'If the lead doesn\'t push back, offer two specific in-home slots without asking permission.',
      'If they decline the in-home OR insist on a phone-first conversation, the 15-min Confirmation Call is your fallback. Don\'t lead with the call though — only offer it if pushed.',
    ].join(' '),
  };
}

const BUYING_SIGNAL_INTENTS = new Set([
  'BOOK',
  'BOOK_NEXTSTEP',
  'BOOK_QUOTE_READY',
  'FAST_TRACK_FRUSTRATED',
]);

const CALLBACK_INTENTS = new Set(['CALLBACK', 'CALLBACK_CALM']);

const APPT_STATUS_INTENTS = new Set(['APPT_STATUS']);

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function selectFromActive(table, query) {
  return supabase.from(table).select(query).eq('active', true);
}

async function safeFetch(promise, label) {
  try {
    const { data, error } = await promise;
    if (error) {
      console.warn(`[KBRetriever] ${label} error:`, error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn(`[KBRetriever] ${label} threw:`, err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// TABLE-LEVEL LOOKUPS (unchanged from v1.3)
// ═══════════════════════════════════════════════════════════════════

export async function getStoryArc(arcId) {
  if (!arcId) return null;
  const rows = await safeFetch(
    selectFromActive('kb_story_arcs', '*').eq('arc_id', arcId).limit(1),
    `getStoryArc(${arcId})`
  );
  return rows[0] || null;
}

export async function getStoryArcsForStage(buyerStage) {
  if (!buyerStage) return [];
  return safeFetch(
    selectFromActive('kb_story_arcs', 'arc_id, arc_name, core_belief, best_for_buyer_stages, best_for_objections')
      .contains('best_for_buyer_stages', [buyerStage]),
    'getStoryArcsForStage'
  );
}

export async function getObjectionScript(objectionType, buyerStage, channel = 'sms') {
  if (!objectionType) return null;
  let rows = await safeFetch(
    selectFromActive('kb_objection_scripts', '*')
      .eq('objection_type', objectionType)
      .eq('buyer_stage', buyerStage || 0)
      .in('channel', [channel, 'both'])
      .order('priority', { ascending: false })
      .limit(1),
    'getObjectionScript exact'
  );
  if (rows[0]) return rows[0];

  rows = await safeFetch(
    selectFromActive('kb_objection_scripts', '*')
      .eq('objection_type', objectionType)
      .in('channel', [channel, 'both'])
      .order('priority', { ascending: false })
      .limit(1),
    'getObjectionScript fallback'
  );
  return rows[0] || null;
}

export async function getPricingAnchor(windowCount) {
  if (!windowCount || windowCount < 1) {
    const rows = await safeFetch(
      selectFromActive('kb_pricing_anchors', '*')
        .order('window_count_min', { ascending: true })
        .limit(1),
      'getPricingAnchor generic'
    );
    return rows[0] || null;
  }
  const rows = await safeFetch(
    selectFromActive('kb_pricing_anchors', '*')
      .lte('window_count_min', windowCount)
      .gte('window_count_max', windowCount)
      .limit(1),
    'getPricingAnchor specific'
  );
  return rows[0] || null;
}

export async function getCompetitorIntel(competitorName) {
  if (!competitorName) return null;
  const lc = competitorName.toLowerCase();
  const rows = await safeFetch(
    selectFromActive('kb_competitor_intel', '*')
      .ilike('competitor_name', `%${lc}%`)
      .limit(1),
    'getCompetitorIntel'
  );
  return rows[0] || null;
}

export async function getProofPoints(category, arcId, limit = 3) {
  let q = selectFromActive('kb_proof_points', 'claim, evidence, source_url, tier').limit(limit);
  if (category) q = q.eq('category', category);
  if (arcId) q = q.contains('use_for_arcs', [arcId]);
  return safeFetch(q, 'getProofPoints');
}

export async function searchFaqs(messageText, channel = 'sms', limit = 3) {
  if (!messageText) return [];
  const tsQuery = String(messageText)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6)
    .join(' & ');

  if (!tsQuery) return [];

  try {
    const { data, error } = await supabase
      .from('kb_faqs')
      .select('question_pattern, canonical_answer, answer_short, story_arc, channel, tier')
      .eq('active', true)
      .in('channel', [channel, 'both'])
      .textSearch('question_pattern', tsQuery, { type: 'websearch', config: 'english' })
      .limit(limit);

    if (error) {
      console.warn('[KBRetriever] searchFaqs textSearch error:', error.message);
      return await safeFetch(
        selectFromActive('kb_faqs', 'question_pattern, canonical_answer, answer_short, story_arc, channel, tier')
          .in('channel', [channel, 'both'])
          .ilike('question_pattern', `%${messageText.slice(0, 100)}%`)
          .limit(limit),
        'searchFaqs ilike fallback'
      );
    }
    return data || [];
  } catch (err) {
    console.warn('[KBRetriever] searchFaqs threw:', err.message);
    return [];
  }
}

export async function getTechniquesForStage(buyerStage, limit = 3) {
  if (!buyerStage) return [];
  return safeFetch(
    selectFromActive('kb_techniques', 'technique_number, technique_name, when_to_use, template')
      .contains('buyer_stages', [buyerStage])
      .limit(limit),
    'getTechniquesForStage'
  );
}

export async function getProductSpec(productLine, attribute) {
  if (!productLine) return null;
  let q = selectFromActive('kb_product_specs', 'product_line, attribute, value, comparison_context, source_url')
    .ilike('product_line', `%${productLine}%`);
  if (attribute) q = q.eq('attribute', attribute);
  const rows = await safeFetch(q.limit(5), 'getProductSpec');
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-LEVEL ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════

const COMPETITOR_KEYWORDS = [
  'andersen', 'pgt direct', 'window world', 'home depot', 'lowes', "lowe's",
  'simonton', 'milgard', 'eze-breeze', 'cgi', 'wincore', 'all weather',
];

function detectCompetitorMention(messageText) {
  if (!messageText) return null;
  const lc = messageText.toLowerCase();
  for (const c of COMPETITOR_KEYWORDS) {
    if (lc.includes(c)) return c;
  }
  return null;
}

const OBJECTION_KEYWORDS = {
  price:      ['too expensive', 'expensive', "can't afford", 'budget', 'cost too much', 'pricey', 'cheaper'],
  timing:     ['not now', 'later', 'next year', 'wait', 'busy', 'in a few months', 'after', 'before',
               'good time', 'bad time', 'just had a baby', 'newborn', 'family emergency',
               'medical', 'surgery', 'recovering'],
  spouse:     ['spouse', 'husband', 'wife', 'partner', 'talk to', 'discuss with'],
  trust:      ['been burned', 'scam', 'don\'t trust', 'reviews', 'reputation', 'bbb'],
  competitor: ['other quote', 'another company', 'comparing', 'shopping around', 'other estimate'],
  diy:        ['myself', 'install myself', 'do it myself', 'handy'],
};

function detectObjection(messageText) {
  if (!messageText) return null;
  const lc = messageText.toLowerCase();
  for (const [type, kws] of Object.entries(OBJECTION_KEYWORDS)) {
    for (const kw of kws) {
      if (lc.includes(kw)) return type;
    }
  }
  return null;
}

/**
 * Build the full KB pack for a response generation call.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function buildKbPack(params) {
  const {
    intentClass = 'UNCLEAR',
    messageText = '',
    channel = 'sms',
    buyerStage = null,
    objectionTags = [],
    recommendedArc = null,
    windowCount = null,
    activeEntryTag = null,
    hasExistingAppt = false,
    lpDisposition = null,
  } = params;

  const detectedCompetitor = detectCompetitorMention(messageText);
  const detectedObjection = detectObjection(messageText)
    || (objectionTags.length > 0 ? objectionTags[0] : null);
  const userBookingPreference = detectUserBookingPreference(messageText);

  const result = {
    intent_class: intentClass,
    primary_arc: null,
    arc_options: [],
    objection_script: null,
    pricing_anchor: null,
    booking_context: null,
    faqs: [],
    proof_points: [],
    techniques: [],
    competitor_intel: null,
    detected_signals: {
      competitor: detectedCompetitor,
      objection: detectedObjection,
      active_entry: activeEntryTag,
      user_booking_preference: userBookingPreference,
      has_existing_appt: hasExistingAppt,
    },
  };

  if (buyerStage) {
    result.techniques = await getTechniquesForStage(buyerStage);
  }

  if (buyerStage) {
    result.arc_options = await getStoryArcsForStage(buyerStage);
  }

  if (recommendedArc) {
    result.primary_arc = await getStoryArc(recommendedArc);
  } else if (result.arc_options.length > 0) {
    result.primary_arc = await getStoryArc(result.arc_options[0].arc_id);
  }

  // v1.5: pass channel through for utm_medium override
  const bookingCtxArgs = {
    intentClass,
    activeEntryTag,
    userPreference: userBookingPreference,
    hasExistingAppt,
    lpDisposition,
    channel,
  };

  switch (intentClass) {
    case 'OBJECTION':
      if (detectedObjection) {
        result.objection_script = await getObjectionScript(detectedObjection, buyerStage, channel);
        if (result.objection_script?.story_arc) {
          result.primary_arc = await getStoryArc(result.objection_script.story_arc);
        }
      }
      if (detectedObjection === 'timing') {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    case 'PRICING':
      result.pricing_anchor = await getPricingAnchor(windowCount);
      break;

    case 'QUESTION':
      result.faqs = await searchFaqs(messageText, channel, 3);
      if (userBookingPreference) {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    case 'BOOK':
    case 'BOOK_NEXTSTEP':
    case 'BOOK_QUOTE_READY':
    case 'FAST_TRACK_FRUSTRATED':
    case 'CALLBACK':
    case 'CALLBACK_CALM':
      result.booking_context = resolveBookingContext(bookingCtxArgs);
      break;

    case 'APPT_STATUS':
      result.booking_context = resolveBookingContext(bookingCtxArgs);
      break;

    case 'RECONNECT':
    case 'NOT_INTERESTED':
    case 'SEND_INFO':
    case 'UNCLEAR':
      if (userBookingPreference) {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    default:
      break;
  }

  if (detectedCompetitor) {
    result.competitor_intel = await getCompetitorIntel(detectedCompetitor);
  }

  if (result.primary_arc?.arc_id) {
    result.proof_points = await getProofPoints(null, result.primary_arc.arc_id, 4);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT FORMATTER (v1.5 — explains merge tag form)
// ═══════════════════════════════════════════════════════════════════

export function formatKbPackForPrompt(pack) {
  if (!pack) return '';
  const lines = [];

  if (pack.primary_arc) {
    lines.push('PRIMARY STORY ARC:');
    lines.push(`  ${pack.primary_arc.arc_id} — ${pack.primary_arc.arc_name}`);
    lines.push(`  Core belief: ${pack.primary_arc.core_belief}`);
    if (pack.primary_arc.problem_named) {
      lines.push(`  Problem: ${pack.primary_arc.problem_named}`);
    }
    if (Array.isArray(pack.primary_arc.openers) && pack.primary_arc.openers.length > 0) {
      lines.push(`  Approved openers: ${JSON.stringify(pack.primary_arc.openers).slice(0, 400)}`);
    }
    if (Array.isArray(pack.primary_arc.do_not_say) && pack.primary_arc.do_not_say.length > 0) {
      lines.push(`  DO NOT SAY: ${JSON.stringify(pack.primary_arc.do_not_say).slice(0, 300)}`);
    }
    lines.push('');
  }

  // ─── BOOKING CONTEXT — v1.5 (trigger link merge tags) ─────────────────
  if (pack.booking_context) {
    const b = pack.booking_context;
    const policy = b.policy || 'in_home_first_call_fallback';
    const isBuyingSignal     = BUYING_SIGNAL_INTENTS.has(pack.intent_class);
    const isCallback         = CALLBACK_INTENTS.has(pack.intent_class);
    const isApptStatus       = APPT_STATUS_INTENTS.has(pack.intent_class);
    const isTimingObjection  = pack.intent_class === 'OBJECTION'
      && pack.detected_signals?.objection === 'timing';

    lines.push('BOOKING CONTEXT (v1.5 — GHL trigger link merge tags):');
    lines.push(`  Policy: ${policy}`);
    if (pack.detected_signals?.user_booking_preference) {
      lines.push(`  User explicitly asked for: ${pack.detected_signals.user_booking_preference}`);
    }
    if (pack.detected_signals?.has_existing_appt) {
      lines.push(`  Lead has existing appointment in LP.`);
    }

    const primary = b.primary || b;
    lines.push(`  PRIMARY: ${primary.calendar_name} — ${primary.duration_minutes}min ${primary.visit_type}`);
    lines.push(`    Calendar ID: ${primary.calendar_id}`);
    lines.push(`    Booking URL (use VERBATIM as merge tag): ${primary.booking_url}`);
    lines.push(`    Description: ${primary.description}`);

    if (b.fallback) {
      lines.push(`  FALLBACK (only if lead pushes back on primary): ${b.fallback.calendar_name} — ${b.fallback.duration_minutes}min ${b.fallback.visit_type}`);
      lines.push(`    Calendar ID: ${b.fallback.calendar_id}`);
      lines.push(`    Booking URL (use VERBATIM as merge tag): ${b.fallback.booking_url}`);
    }

    lines.push(`  Guidance: ${b.guidance}`);

    if (policy === 'phone_primary_in_home_fallback') {
      lines.push(`  ☎️ PHONE-PRIMARY HANDLING: The user asked for a call. Offer the 15-min Confirmation Call slot — that is the right calendar here. Do NOT push them toward the in-home estimate against their stated preference.`);
    } else if (policy === 'mv_only') {
      lines.push(`  📐 MV HANDLING: Frame this as a verification visit, not a sales appointment. Specialist verifies measurements they entered online and finalizes pricing. Both homeowners present.`);
    } else if (policy === 'confirm_existing_appt') {
      lines.push(`  ✅ CONFIRM-EXISTING HANDLING: They already have an appointment. The Confirmation Call is the right calendar — short, just to confirm details. Do NOT re-book the in-home. Do NOT offer additional slots.`);
    } else if (policy === 'in_home_first_call_fallback') {
      if (isBuyingSignal) {
        lines.push(`  ⚡ BUYING-SIGNAL HANDLING: Skip discovery, skip re-pitching value, skip mentioning financing. Acknowledge intent in ONE short line, then offer two specific in-home slots from PRIMARY. Match urgency.`);
      } else {
        lines.push(`  🏠 IN-HOME-FIRST HANDLING: Default Reece policy. Lead with two specific in-home slots from PRIMARY. Only offer the FALLBACK Confirmation Call if the lead explicitly declines the in-home or insists on phone-first.`);
      }
    }

    if (isTimingObjection) {
      lines.push(`  ⏳ TIMING OBJECTION OVERRIDE: For LIFE-EVENT timing objections (new baby, surgery, family emergency, recent loss): DO NOT include a booking link in the message. Empathy + offer to circle back in 4-8 weeks. For LOGISTICAL timing (busy/traveling), normal booking handling applies.`);
    } else if (isApptStatus) {
      lines.push(`  📅 APPT_STATUS HANDLING: Lead is asking about an existing appointment. Confirm the details if known. If they want to reschedule, route to the appropriate in-home calendar (NOT this Confirmation Call). If they want to cancel, treat with empathy and offer to circle back later.`);
    }
    lines.push('');
  }

  if (pack.objection_script) {
    lines.push('OBJECTION SCRIPT (canonical):');
    if (pack.objection_script.opener) lines.push(`  Opener: ${pack.objection_script.opener}`);
    if (pack.objection_script.body_template) lines.push(`  Body: ${pack.objection_script.body_template}`);
    if (pack.objection_script.soft_next_step) lines.push(`  Next step: ${pack.objection_script.soft_next_step}`);
    if (Array.isArray(pack.objection_script.do_not_use)) {
      lines.push(`  Avoid: ${JSON.stringify(pack.objection_script.do_not_use).slice(0, 200)}`);
    }
    lines.push('');
  }

  if (pack.pricing_anchor) {
    lines.push('PRICING ANCHOR (NEVER quote a specific number):');
    if (pack.pricing_anchor.anchoring_message) lines.push(`  Frame: ${pack.pricing_anchor.anchoring_message}`);
    if (pack.pricing_anchor.roi_framing)       lines.push(`  ROI: ${pack.pricing_anchor.roi_framing}`);
    if (pack.pricing_anchor.payment_framing)   lines.push(`  Payment: ${pack.pricing_anchor.payment_framing}`);
    lines.push('');
  }

  if (pack.faqs && pack.faqs.length > 0) {
    lines.push('FAQ MATCHES (use canonical_answer when relevant):');
    for (const f of pack.faqs.slice(0, 3)) {
      lines.push(`  Q: ${f.question_pattern}`);
      const ans = f.answer_short || f.canonical_answer;
      lines.push(`  A: ${(ans || '').slice(0, 300)}`);
    }
    lines.push('');
  }

  if (pack.competitor_intel) {
    lines.push('COMPETITOR INTEL:');
    lines.push(`  Competitor: ${pack.competitor_intel.competitor_name}`);
    if (pack.competitor_intel.talking_point) lines.push(`  Talking point: ${pack.competitor_intel.talking_point}`);
    if (pack.competitor_intel.reece_advantage) lines.push(`  Reece advantage: ${pack.competitor_intel.reece_advantage}`);
    if (Array.isArray(pack.competitor_intel.do_not_attack)) {
      lines.push(`  DO NOT attack: ${JSON.stringify(pack.competitor_intel.do_not_attack).slice(0, 200)}`);
    }
    lines.push('');
  }

  if (pack.proof_points && pack.proof_points.length > 0) {
    lines.push('PROOF POINTS (only cite these — do not invent stats):');
    for (const p of pack.proof_points.slice(0, 4)) {
      lines.push(`  • ${p.claim}${p.evidence ? ` — ${p.evidence}` : ''} [${p.tier}]`);
    }
    lines.push('');
  }

  if (pack.techniques && pack.techniques.length > 0) {
    lines.push('TECHNIQUES TO PAIR (apply where natural):');
    for (const t of pack.techniques.slice(0, 3)) {
      lines.push(`  T${t.technique_number} ${t.technique_name}: ${t.when_to_use || ''}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
