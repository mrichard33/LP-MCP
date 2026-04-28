/**
 * KB Retriever — src/knowledge/kb-retriever.js
 *
 * Orchestrates structured KB lookups (Tier 1) for the response generator.
 * Pulls matching rows from the kb_* tables BEFORE the Claude API call,
 * so the model gets concrete playbooks instead of inventing answers.
 *
 * Called by: src/response-generator.js (Phase 3 wiring)
 *
 * Lookup order (when an intent is classified):
 *   - OBJECTION       → kb_objection_scripts + supporting kb_story_arcs + kb_proof_points
 *   - PRICING         → kb_pricing_anchors (by window count if known)
 *   - QUESTION        → kb_faqs (keyword/pattern match) + kb_story_arcs
 *   - BOOK / BOOK_NEXTSTEP / BOOK_QUOTE_READY / FAST_TRACK_FRUSTRATED
 *                     → BOOKING CONTEXT injected; skip objection/pricing pulls
 *   - CALLBACK / CALLBACK_CALM
 *                     → BOOKING CONTEXT — phone primary IF user explicitly
 *                       asked for a call, otherwise in-home primary
 *   - APPT_STATUS     → BOOKING CONTEXT — Confirmation Call (existing appt)
 *   - RECONNECT / NOT_INTERESTED / SEND_INFO / UNCLEAR
 *                     → kb_story_arcs (chosen by buyer_stage)
 *
 * Always pulls (when relevant context provided):
 *   - kb_techniques relevant to current buyer_stage
 *   - kb_competitor_intel if a competitor name is detected in message
 *
 * v1.3 — 2026-04-28. CONTEXT-AWARE CALENDAR SELECTION.
 *   Per Mark: "for measurement verification and calls, the system should
 *   not always default to a confirmation call. The call type should match
 *   the user's request. The bot should not only send the window estimate
 *   link. It needs to dynamically decide what to send and how to frame
 *   the call based on context."
 *
 *   Replaces the v1.2 "always-in-home-first" policy with a context-aware
 *   selector that picks the right calendar based on:
 *     1. What the user EXPLICITLY asked for in the message
 *        ("call me", "come measure", "estimate", etc.)
 *     2. Whether they have an existing appointment in LP
 *     3. Their entry source (estimate-calculator → MV)
 *     4. Their LP disposition state
 *
 *   New: detectUserBookingPreference(messageText) returns 'phone' |
 *   'in_home' | 'mv' | 'confirm_existing' | null based on keyword match.
 *
 *   resolveBookingContext now takes 5 inputs (intentClass, activeEntryTag,
 *   userPreference, hasExistingAppt, lpDisposition) and emits one of 4
 *   policies: phone_primary_in_home_fallback | mv_only |
 *   confirm_existing_appt | in_home_first_call_fallback.
 *
 *   buildKbPack accepts new params: hasExistingAppt, lpDisposition.
 *
 * v1.2 — IN-HOME-FIRST BOOKING POLICY (superseded by v1.3 context-aware).
 * v1.1 — Calendar awareness: resolveBookingContext + activeEntryTag.
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';

// ═══════════════════════════════════════════════════════════════════
// CALENDAR CONSTANTS — Reece booking calendars
// ═══════════════════════════════════════════════════════════════════

export const CALENDAR_IDS = {
  CONFIRMATION_CALL: 'gFWoSQrlKIdfRbAPV842',  // 1-2min phone confirmation
  WINDOW_ESTIMATE:   'aJj14ONxh1oFyDcQ706O',  // 90-min in-home Window Protection Estimate
  MV:                'zEdPmkNccR2ovo3rQAd3',  // Window Measurement Verification (estimate-calculator leads)
};

// Override via env so Mark can swap to a custom domain later
const BOOKING_URL_BASE = (process.env.GHL_BOOKING_URL_BASE || 'https://api.leadconnectorhq.com/widget/booking').replace(/\/+$/, '');

const calendarUrl = (id) => `${BOOKING_URL_BASE}/${id}`;

// ─── Calendar definitions ────────────────────────────────────────

function windowEstimateCalendar() {
  return {
    type:             'in_home',
    visit_type:       'in_home',
    calendar_id:      CALENDAR_IDS.WINDOW_ESTIMATE,
    calendar_name:    'Window Estimate',
    duration_minutes: 90,
    booking_url:      calendarUrl(CALENDAR_IDS.WINDOW_ESTIMATE),
    description:      'Standard in-home Window Protection Estimate — about an hour and a half. Specialist measures to Florida code and provides exact pricing valid for 1 year. Both homeowners should be present.',
  };
}

function mvCalendar() {
  return {
    type:             'in_home',
    visit_type:       'in_home',
    calendar_id:      CALENDAR_IDS.MV,
    calendar_name:    'Window Measurement Verification',
    duration_minutes: 90,
    booking_url:      calendarUrl(CALENDAR_IDS.MV),
    description:      'In-home measurement verification — about 90 minutes — for leads who came through the online estimate calculator. Specialist verifies measurements and finalizes penny-accurate pricing. Both homeowners should be present.',
  };
}

function confirmationCallCalendar() {
  return {
    type:             'phone_call',
    visit_type:       'phone',
    calendar_id:      CALENDAR_IDS.CONFIRMATION_CALL,
    calendar_name:    'Confirmation Call',
    duration_minutes: 15,
    booking_url:      calendarUrl(CALENDAR_IDS.CONFIRMATION_CALL),
    description:      '1-2 minute phone call. Used for: (a) leads who explicitly request a phone conversation, (b) confirming details for an existing appointment, (c) brief callback when an in-home is logistically impossible.',
  };
}

// Pick the right in-home calendar for this lead's source
function pickInHomeCalendar({ activeEntryTag }) {
  const isEstimateCalculator = typeof activeEntryTag === 'string'
    && activeEntryTag === 'active-entry:estimate-calculator';
  return isEstimateCalculator ? mvCalendar() : windowEstimateCalendar();
}

// ═══════════════════════════════════════════════════════════════════
// USER BOOKING PREFERENCE DETECTION (v1.3)
// ═══════════════════════════════════════════════════════════════════
//
// Reads the inbound message and infers what the user actually asked
// for. Used by resolveBookingContext to honor the user's preference
// instead of always defaulting to in-home or always defaulting to call.
//
// Returns one of:
//   'phone'             — user explicitly wants a phone call
//   'in_home'           — user explicitly wants someone to come out
//   'mv'                — user asked for measurement verification specifically
//   'confirm_existing'  — user is asking about/confirming an existing appt
//   null                — no clear signal, fall back to context heuristics

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

  // Order: most specific signals first, so "come measure" wins over "come out"
  if (containsAny(lc, MEASUREMENT_KEYWORDS))      return 'mv';
  if (containsAny(lc, APPT_CONFIRMATION_KEYWORDS)) return 'confirm_existing';
  if (containsAny(lc, PHONE_PREFERENCE_KEYWORDS))  return 'phone';
  if (containsAny(lc, IN_HOME_PREFERENCE_KEYWORDS)) return 'in_home';
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// BOOKING CONTEXT RESOLVER (v1.3 — context-aware)
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the right booking calendar based on user preference + context.
 *
 * Decision order (first match wins):
 *
 *   Case A: User explicitly asked for a phone call (or CALLBACK intent)
 *           → CONFIRMATION CALL primary, in-home fallback
 *           Policy: phone_primary_in_home_fallback
 *
 *   Case B: User asked for measurement verification, or came in via
 *           estimate-calculator
 *           → MV calendar only
 *           Policy: mv_only
 *
 *   Case C: User has existing appointment OR is asking about an
 *           existing appointment
 *           → CONFIRMATION CALL (to confirm details, not re-book)
 *           Policy: confirm_existing_appt
 *
 *   Case D (default): No explicit preference, no existing appt
 *           → Window Estimate primary, Confirmation Call as fallback
 *           Policy: in_home_first_call_fallback
 *
 * @param {Object} args
 * @param {string} args.intentClass — From classifier (CALLBACK, BOOK, etc.)
 * @param {string} [args.activeEntryTag] — Current lead source tag
 * @param {string} [args.userPreference] — From detectUserBookingPreference
 * @param {boolean} [args.hasExistingAppt] — From LP context
 * @param {string} [args.lpDisposition] — From LP context (for nuance)
 * @returns {Object} BookingContext with primary, fallback, policy, guidance
 */
export function resolveBookingContext({
  intentClass,
  activeEntryTag,
  userPreference = null,
  hasExistingAppt = false,
  lpDisposition = null,
} = {}) {
  const inHome = pickInHomeCalendar({ activeEntryTag });
  const phone  = confirmationCallCalendar();
  const mv     = mvCalendar();

  // ─── CASE A: User asked for a phone call ────────────────────────
  // Honor the request — don't fight what they asked for.
  // CALLBACK / CALLBACK_CALM intents also route here.
  const isCallbackIntent = intentClass === 'CALLBACK' || intentClass === 'CALLBACK_CALM';
  if (userPreference === 'phone' || isCallbackIntent) {
    return {
      ...phone,
      primary:  phone,
      fallback: inHome,
      policy:   'phone_primary_in_home_fallback',
      guidance: [
        'The lead asked for a phone call. Honor that — offer the 15-min Confirmation Call slot first, not the in-home.',
        'If during that call we discover they want the full in-home estimate, the in-home Window Estimate is the natural next step (it\'s in the fallback).',
        'Do NOT push the in-home as primary when the lead explicitly asked for a call. Match their preference.',
      ].join(' '),
    };
  }

  // ─── CASE B: Measurement Verification ────────────────────────────
  // User asked for MV specifically, or came in via estimate-calculator.
  const isEstimateCalculator = activeEntryTag === 'active-entry:estimate-calculator';
  if (userPreference === 'mv' || isEstimateCalculator) {
    return {
      ...mv,
      primary:  mv,
      fallback: null,
      policy:   'mv_only',
      guidance: [
        'This lead came through the online Estimate Calculator (or asked for MV directly).',
        'The next step is a Window Measurement Verification — about 90 minutes, in-home.',
        'A specialist verifies the measurements they entered online and finalizes penny-accurate pricing.',
        'Both homeowners should be present so any questions can be answered on the spot. Do NOT pitch this as a sales appointment — frame it as a verification visit.',
      ].join(' '),
    };
  }

  // ─── CASE C: Existing appointment — confirmation only ────────────
  // Lead has an appointment booked OR is asking about one.
  // Right move is the Confirmation Call (don't re-book).
  if (userPreference === 'confirm_existing' || hasExistingAppt) {
    return {
      ...phone,
      primary:  phone,
      fallback: null,
      policy:   'confirm_existing_appt',
      guidance: [
        'Lead has an existing appointment. The right calendar here is the Confirmation Call — used to confirm time, address, who will be present, etc.',
        'Do NOT re-book the in-home appointment. Do NOT offer additional appointment slots.',
        'If the lead wants to RESCHEDULE (not confirm), use the appropriate in-home calendar instead — but lead with empathy and don\'t make them feel bad about needing to move it.',
        lpDisposition ? `LP disposition: ${lpDisposition} — let that color your tone.` : '',
      ].filter(Boolean).join(' '),
    };
  }

  // ─── CASE D (default): In-home first, call as fallback ───────────
  // No explicit preference and no existing appt — Reece's standard
  // policy is to push for the in-home, with the 15-min call available
  // if the lead pushes back.
  return {
    ...inHome,
    primary:  inHome,
    fallback: phone,
    policy:   'in_home_first_call_fallback',
    guidance: [
      `Default Reece policy: the in-home ${inHome.calendar_name} is the primary offering — about 90 minutes, both homeowners present.`,
      'If the lead doesn\'t push back, offer two specific in-home slots without asking permission.',
      'If they decline the in-home OR insist on a phone-first conversation, the 15-min Confirmation Call is your fallback. Don\'t lead with the call though — only offer it if pushed.',
    ].join(' '),
  };
}

// Buying-signal intents — kb pack should skip discovery/pricing/objection
// and instead surface the BOOKING CONTEXT with "go straight to scheduling"
// guidance. Keeps the prompt deterministic about what these signals mean.
const BUYING_SIGNAL_INTENTS = new Set([
  'BOOK',                    // generic book intent
  'BOOK_NEXTSTEP',           // "what's next"
  'BOOK_QUOTE_READY',        // "I want a quote" — distinct from PRICING ("how much?")
  'FAST_TRACK_FRUSTRATED',   // "just schedule me"
]);

const CALLBACK_INTENTS = new Set(['CALLBACK', 'CALLBACK_CALM']);

const APPT_STATUS_INTENTS = new Set(['APPT_STATUS']);

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function selectFromActive(table, query) {
  // tiny convenience: every kb_* table has active flag
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
// TABLE-LEVEL LOOKUPS
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
  // Try exact match first
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

  // Fall back to any stage with matching channel
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
    // Return generic anchor (any matching range)
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
  // Postgres full-text search on question_pattern (gin index exists)
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
      // Fall back to keyword ilike
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
 * @param {string} params.intentClass — From intent classifier
 * @param {string} params.messageText — The inbound message
 * @param {string} [params.channel='sms']
 * @param {number} [params.buyerStage] — 1-5
 * @param {string[]} [params.objectionTags] — From contact tags
 * @param {string} [params.recommendedArc] — From lead_intelligence
 * @param {number} [params.windowCount] — From contact custom field if known
 * @param {string} [params.activeEntryTag] — v1.1
 * @param {boolean} [params.hasExistingAppt] — v1.3: from LP context
 * @param {string} [params.lpDisposition] — v1.3: from LP context
 * @returns {Promise<Object>} — Structured KB context for the prompt
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
    hasExistingAppt = false,                     // v1.3
    lpDisposition = null,                         // v1.3
  } = params;

  // Detect signals from message
  const detectedCompetitor = detectCompetitorMention(messageText);
  const detectedObjection = detectObjection(messageText)
    || (objectionTags.length > 0 ? objectionTags[0] : null);
  const userBookingPreference = detectUserBookingPreference(messageText);  // v1.3

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
      user_booking_preference: userBookingPreference,  // v1.3
      has_existing_appt: hasExistingAppt,               // v1.3
    },
  };

  // Always: techniques for the stage
  if (buyerStage) {
    result.techniques = await getTechniquesForStage(buyerStage);
  }

  // Always: arc options for the stage
  if (buyerStage) {
    result.arc_options = await getStoryArcsForStage(buyerStage);
  }

  // Primary arc
  if (recommendedArc) {
    result.primary_arc = await getStoryArc(recommendedArc);
  } else if (result.arc_options.length > 0) {
    // First match by stage
    result.primary_arc = await getStoryArc(result.arc_options[0].arc_id);
  }

  // ─── Branch by intent class ───────────────────────────────────────
  // v1.3: booking_context resolution now considers user preference,
  // existing appointments, and LP disposition — not just intent class.
  const bookingCtxArgs = {
    intentClass,
    activeEntryTag,
    userPreference: userBookingPreference,
    hasExistingAppt,
    lpDisposition,
  };

  switch (intentClass) {
    case 'OBJECTION':
      if (detectedObjection) {
        result.objection_script = await getObjectionScript(detectedObjection, buyerStage, channel);
        if (result.objection_script?.story_arc) {
          result.primary_arc = await getStoryArc(result.objection_script.story_arc);
        }
      }
      // For pre-demo timing objections (e.g. "just had a baby"), still
      // surface booking context so the model can offer a softer reschedule.
      // v1.3 NOTE: For LIFE-EVENT timing objections, the response generator
      // will suppress the link entirely (per system prompt). booking_context
      // is provided here so that policy decision happens at the prompt
      // layer, not the retrieval layer.
      if (detectedObjection === 'timing') {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    case 'PRICING':
      // "how much does it cost?" — pivot to discovery, no booking yet.
      result.pricing_anchor = await getPricingAnchor(windowCount);
      break;

    case 'QUESTION':
      result.faqs = await searchFaqs(messageText, channel, 3);
      // v1.3: If the user is asking a question that hints at booking
      // ("can someone come measure?"), still attach booking_context.
      if (userBookingPreference) {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    // Buying-signal + callback intents — surface booking context
    case 'BOOK':
    case 'BOOK_NEXTSTEP':
    case 'BOOK_QUOTE_READY':
    case 'FAST_TRACK_FRUSTRATED':
    case 'CALLBACK':
    case 'CALLBACK_CALM':
      result.booking_context = resolveBookingContext(bookingCtxArgs);
      break;

    // v1.3: APPT_STATUS — lead is asking about an existing appointment
    case 'APPT_STATUS':
      result.booking_context = resolveBookingContext(bookingCtxArgs);
      break;

    case 'RECONNECT':
    case 'NOT_INTERESTED':
    case 'SEND_INFO':
    case 'UNCLEAR':
      // primary_arc + techniques already covered.
      // v1.3: If user expressed booking preference even on these intents,
      // surface it — the model can decide whether to offer it.
      if (userBookingPreference) {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    default:
      // Unknown intents fall through with arc + techniques only.
      break;
  }

  // Competitor mention enriches any branch
  if (detectedCompetitor) {
    result.competitor_intel = await getCompetitorIntel(detectedCompetitor);
  }

  // Pull proof points for the chosen arc
  if (result.primary_arc?.arc_id) {
    result.proof_points = await getProofPoints(null, result.primary_arc.arc_id, 4);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT FORMATTER
// ═══════════════════════════════════════════════════════════════════

/**
 * Render a KB pack as a plain-text block for injection into the
 * response generator's user prompt. Keeps token usage compact.
 */
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

  // ─── BOOKING CONTEXT — v1.3 context-aware policy ──────────────────────
  if (pack.booking_context) {
    const b = pack.booking_context;
    const policy = b.policy || 'in_home_first_call_fallback';
    const isBuyingSignal     = BUYING_SIGNAL_INTENTS.has(pack.intent_class);
    const isCallback         = CALLBACK_INTENTS.has(pack.intent_class);
    const isApptStatus       = APPT_STATUS_INTENTS.has(pack.intent_class);
    const isTimingObjection  = pack.intent_class === 'OBJECTION'
      && pack.detected_signals?.objection === 'timing';

    lines.push('BOOKING CONTEXT (context-aware — v1.3):');
    lines.push(`  Policy: ${policy}`);
    if (pack.detected_signals?.user_booking_preference) {
      lines.push(`  User explicitly asked for: ${pack.detected_signals.user_booking_preference}`);
    }
    if (pack.detected_signals?.has_existing_appt) {
      lines.push(`  Lead has existing appointment in LP.`);
    }

    // Primary calendar
    const primary = b.primary || b;
    lines.push(`  PRIMARY: ${primary.calendar_name} — ${primary.duration_minutes}min ${primary.visit_type}`);
    lines.push(`    Calendar ID: ${primary.calendar_id}`);
    lines.push(`    Booking URL: ${primary.booking_url}`);
    lines.push(`    Description: ${primary.description}`);

    // Fallback calendar (if present)
    if (b.fallback) {
      lines.push(`  FALLBACK (only if lead pushes back on primary): ${b.fallback.calendar_name} — ${b.fallback.duration_minutes}min ${b.fallback.visit_type}`);
      lines.push(`    Calendar ID: ${b.fallback.calendar_id}`);
      lines.push(`    Booking URL: ${b.fallback.booking_url}`);
    }

    lines.push(`  Guidance: ${b.guidance}`);

    // Policy-specific extra guidance
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
      lines.push(`  ⏳ TIMING OBJECTION OVERRIDE: For LIFE-EVENT timing objections (new baby, surgery, family emergency, recent loss): DO NOT include a booking link in the message. Empathy + offer to circle back in 4-8 weeks. The booking_context is provided so you know what's available — but don't paste it. For LOGISTICAL timing (busy/traveling), normal booking handling applies.`);
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
