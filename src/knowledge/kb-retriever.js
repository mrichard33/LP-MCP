/**
 * KB Retriever — src/knowledge/kb-retriever.js
 *
 * Orchestrates structured KB lookups (Tier 1) for the response generator.
 *
 * v1.8 — 2026-04-30. ALIGN MV calendar_name with action-handler CALENDAR_MAP.
 *   PROBLEM: mvCalendar() returned calendar_name: "Window Measurement
 *   Verification" but src/actions/constants.js CALENDAR_MAP keys this
 *   calendar as plain "Measurement Verification". When the AI emitted a
 *   companion_action with the prefixed name (per v2.7.6 auto-book on hard
 *   confirmation), the book_appointment handler validated against
 *   CALENDAR_MAP, didn't find a match, and threw:
 *     "Unknown calendar name: Window Measurement Verification.
 *      Valid: Review Session, Measurement Verification, Window Estimate,
 *      Home Protection Assessment, Confirmation Call"
 *
 *   Surfaced 2026-04-30 with contact 4uaY9wDO6Zz8hjA1DjXd: bot ran the full
 *   booking conversation correctly (mv_only policy, ASK-FIRST with two
 *   specific times, hard-confirmation auto-book per response-generator
 *   v2.7.6) but action 30399 failed silently — verbal confirmation
 *   "Monday at 2 PM is locked in" went out, the calendar entry never
 *   actually got created in GHL.
 *
 *   FIX: calendar_name aligned to "Measurement Verification" — exactly
 *   matching the CALENDAR_MAP key. calendar_id (zEdPmkNccR2ovo3rQAd3)
 *   and policy ('mv_only') were already correct; this is a pure label
 *   alignment fix. The MV description is also updated to drop the
 *   redundant "Window" prefix in casual prose so the AI doesn't echo
 *   the wrong phrase back into messages.
 *
 * v1.7 — 2026-04-29. SCHEDULING-SIGNAL FALLBACK.
 *   PROBLEM: Even with the BOOK classifier fixes, the keyword scan can still
 *   misroute when the inbound has no specific BOOK trigger keyword AND the
 *   semantic classifier (Haiku) doesn't pick up on conversation continuity.
 *   Surfaced on action #28186 ("Saturday doesn't work. Do you have anything
 *   on Sunday or Monday?") which routed to QUESTION because Layer 1 matched
 *   "do you" — without booking_context attached, the calendar lookup was
 *   skipped and the bot proposed day-only slots with no specific times.
 *
 *   FIX: Add a defensive scheduling-signal detector that looks for explicit
 *   scheduling cues in the message text:
 *     - Day-of-week names (monday, tuesday, ..., sunday, weekend)
 *     - Availability questions ("anything on", "what about", "do you have")
 *     - Reschedule signals ("doesn't work", "different time/day", "another time")
 *     - Time-of-day cues ("morning", "afternoon", "evening")
 *
 *   When detected on intent classes that don't normally attach booking_context
 *   (QUESTION, UNCLEAR, RECONNECT, NOT_INTERESTED, SEND_INFO), this fallback
 *   forces booking_context attachment so the calendar lookup fires and the
 *   bot has real availability to propose specific times from. This is
 *   belt-and-suspenders alongside the classifier improvements (better BOOK
 *   description + stronger continuation keywords on 2026-04-29).
 *
 *   The detected_signals.scheduling_signal field is also exposed in the
 *   prompt so the model knows the lead is in scheduling mode even if the
 *   intent_class header says QUESTION.
 *
 * v1.6 — 2026-04-28. BARE MERGE TAG — drop dynamic UTM suffix.
 *   Field test (action #27812) showed v1.5's form produced a malformed
 *   rendered URL: GHL renders {{trigger_link.X}} to a bare short URL
 *   with NO query string (e.g. https://link.reecewindows.com/l/4RXyuG_sJP).
 *   Appending `&utm_term=mv` after that yields an invalid URL — the `&`
 *   should have been `?` since there is no preceding query string. Result:
 *   the link 404'd because the short-code lookup saw `4RXyuG_sJP&utm_term=mv`
 *   instead of `4RXyuG_sJP`.
 *
 *   Decision: drop the dynamic UTM append entirely. The trigger link's
 *   GHL static config (utm_source=ghl, utm_medium=sms, utm_campaign=
 *   agentic_bot, utm_content=<calendar-specific>) provides per-link
 *   attribution. Per-policy granularity (utm_term=mv vs phone_primary)
 *   is sacrificed for reliability; the calendar choice ITSELF still
 *   encodes policy (MV calendar vs Confirmation Call vs Window Estimate).
 *
 *   buildTriggerLinkUrl now returns just `{{trigger_link.<ID>}}`. The
 *   opts argument is retained for backward compatibility with callers
 *   that still pass channel/policy, but those values are now ignored.
 *
 *   buildBookingUrl (the resolved-URL fallback) is unchanged — it still
 *   bakes utm_term + utm_medium into proper query string params for
 *   diagnostic and non-merge-tag use cases.
 *
 * v1.5 — GHL trigger link merge tags + dynamic UTM suffix (REVERTED in v1.6).
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
  CONFIRMATION_CALL: 'gFWoSQrlKIdfRbAPV842',
  WINDOW_ESTIMATE:   'aJj14ONxh1oFyDcQ706O',
  MV:                'zEdPmkNccR2ovo3rQAd3',
};

export const TRIGGER_LINK_IDS = {
  CONFIRMATION_CALL:   process.env.REECE_TRIGGER_CALL          || 'sfQAvcOczlOGQX1LE0Ht',
  WINDOW_ESTIMATE:     process.env.REECE_TRIGGER_WE            || 'QqvhMNyB7YQzHqSNOXHm',
  MV:                  process.env.REECE_TRIGGER_MV            || 'SPQHJKSLbwhJ1bhg2dIy',
  ESTIMATE_CALCULATOR: process.env.REECE_TRIGGER_CALCULATOR    || 'aS10ZzuBDRI2GUpzQh1v',
};

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
    extra_params: { pro_id: '3269', lp_source_id: '842' },
  },
};

const POLICY_TO_UTM_TERM = {
  phone_primary_in_home_fallback: 'phone_primary',
  mv_only:                        'mv',
  confirm_existing_appt:          'confirm',
  in_home_first_call_fallback:    'in_home_first',
};

// ═══════════════════════════════════════════════════════════════════
// URL BUILDERS (v1.6 — bare merge tag, no UTM suffix)
// ═══════════════════════════════════════════════════════════════════

export function buildTriggerLinkUrl(triggerKey, opts = {}) {
  const id = TRIGGER_LINK_IDS[triggerKey];
  if (!id) return null;
  return `{{trigger_link.${id}}}`;
}

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
    if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
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
    if (v && typeof v === 'string' && v.trim().length > 0) params.set(k, v.trim());
  }

  return `${spec.base}?${params.toString()}`;
}

export function getEstimateCalculatorTriggerLink(opts = {}) {
  return buildTriggerLinkUrl('ESTIMATE_CALCULATOR', opts);
}
export function getEstimateCalculatorUrl(opts = {}) {
  return buildBookingUrl(BOOKING_SPECS.ESTIMATE_CALCULATOR, opts);
}

// ═══════════════════════════════════════════════════════════════════
// CALENDAR DEFINITION FACTORIES
// ═══════════════════════════════════════════════════════════════════

function windowEstimateCalendar(opts) {
  return {
    type: 'in_home', visit_type: 'in_home',
    calendar_id: CALENDAR_IDS.WINDOW_ESTIMATE,
    calendar_name: 'Window Estimate',
    duration_minutes: 90,
    booking_url: buildTriggerLinkUrl('WINDOW_ESTIMATE', opts),
    booking_url_resolved: buildBookingUrl(BOOKING_SPECS.WINDOW_ESTIMATE, opts),
    description: 'Standard in-home Window Protection Estimate — about an hour and a half. Specialist measures to Florida code and provides exact pricing valid for 1 year. Both homeowners should be present.',
  };
}

function mvCalendar(opts) {
  return {
    type: 'in_home', visit_type: 'in_home',
    calendar_id: CALENDAR_IDS.MV,
    // v1.8: must match CALENDAR_MAP key in src/actions/constants.js exactly
    // (the book_appointment handler validates calendar_name against that map).
    calendar_name: 'Measurement Verification',
    duration_minutes: 90,
    booking_url: buildTriggerLinkUrl('MV', opts),
    booking_url_resolved: buildBookingUrl(BOOKING_SPECS.MV, opts),
    description: 'In-home measurement verification — about 90 minutes — for leads who came through the online estimate calculator. Specialist verifies the measurements they entered online and finalizes penny-accurate pricing. Both homeowners should be present.',
  };
}

function confirmationCallCalendar(opts) {
  return {
    type: 'phone_call', visit_type: 'phone',
    calendar_id: CALENDAR_IDS.CONFIRMATION_CALL,
    calendar_name: 'Confirmation Call',
    duration_minutes: 15,
    booking_url: buildTriggerLinkUrl('CONFIRMATION_CALL', opts),
    booking_url_resolved: buildBookingUrl(BOOKING_SPECS.CONFIRMATION_CALL, opts),
    description: '1-2 minute phone call. Used for: (a) leads who explicitly request a phone conversation, (b) confirming details for an existing appointment, (c) brief callback when an in-home is logistically impossible.',
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

// ═══════════════════════════════════════════════════════════════════
// v1.7 — SCHEDULING-SIGNAL DETECTION (defensive fallback)
// ═══════════════════════════════════════════════════════════════════

const SCHEDULING_SIGNAL_KEYWORDS = [
  // Day-of-week names — strong continuation signal when conversation is mid-booking
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'weekend', 'this weekend', 'next weekend', 'weekday', 'next week',
  // Time-of-day references in scheduling context
  'morning', 'afternoon', 'evening', 'tonight',
  // Availability questions
  'anything on', 'anything available', 'any time', 'open slot',
  'open time', 'availability', 'what times', 'what time',
  'any other times', 'any other days',
  // Reschedule signals
  "doesn't work", 'doesnt work', "doesn t work", 'cant do', "can't do",
  'reschedule', 'different time', 'different day', 'another time',
  'another day', 'change the time', 'change the day', 'move it',
  // Confirmation cues (lead picking from offered slots)
  'works for me', 'works better', 'that works', 'that one',
  // Direct asks
  'what about', 'how about', 'how about sunday', 'how about monday',
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

/**
 * v1.7 — Detect scheduling continuation signals. Returns the matched
 * keyword if found, null otherwise. Used as a defensive fallback to
 * attach booking_context when intent classifies as QUESTION/UNCLEAR/
 * RECONNECT/NOT_INTERESTED/SEND_INFO but the lead is clearly engaged
 * in a scheduling conversation.
 */
export function detectSchedulingSignal(messageText) {
  if (!messageText || typeof messageText !== 'string') return null;
  const lc = messageText.toLowerCase();
  return containsAny(lc, SCHEDULING_SIGNAL_KEYWORDS);
}

// ═══════════════════════════════════════════════════════════════════
// BOOKING CONTEXT RESOLVER (v1.6 — channel/policy passed but unused by URL builder)
// ═══════════════════════════════════════════════════════════════════

export function resolveBookingContext({
  intentClass,
  activeEntryTag,
  userPreference = null,
  hasExistingAppt = false,
  lpDisposition = null,
  channel = 'sms',
} = {}) {
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

  if (policy === 'phone_primary_in_home_fallback') {
    return {
      ...phone, primary: phone, fallback: inHome, policy,
      guidance: [
        'The lead asked for a phone call. Honor that — offer the 15-min Confirmation Call slot first, not the in-home.',
        'If during that call we discover they want the full in-home estimate, the in-home Window Estimate is the natural next step (it\'s in the fallback).',
        'Do NOT push the in-home as primary when the lead explicitly asked for a call. Match their preference.',
      ].join(' '),
    };
  }

  if (policy === 'mv_only') {
    return {
      ...mv, primary: mv, fallback: null, policy,
      guidance: [
        'This lead came through the online Estimate Calculator (or asked for MV directly).',
        'The next step is a Measurement Verification visit — about 90 minutes, in-home.',
        'A specialist verifies the measurements they entered online and finalizes penny-accurate pricing.',
        'Both homeowners should be present so any questions can be answered on the spot. Do NOT pitch this as a sales appointment — frame it as a verification visit.',
      ].join(' '),
    };
  }

  if (policy === 'confirm_existing_appt') {
    return {
      ...phone, primary: phone, fallback: null, policy,
      guidance: [
        'Lead has an existing appointment. The right calendar here is the Confirmation Call — used to confirm time, address, who will be present, etc.',
        'Do NOT re-book the in-home appointment. Do NOT offer additional appointment slots.',
        'If the lead wants to RESCHEDULE (not confirm), use the appropriate in-home calendar instead — but lead with empathy and don\'t make them feel bad about needing to move it.',
        lpDisposition ? `LP disposition: ${lpDisposition} — let that color your tone.` : '',
      ].filter(Boolean).join(' '),
    };
  }

  return {
    ...inHome, primary: inHome, fallback: phone, policy,
    guidance: [
      `Default Reece policy: the in-home ${inHome.calendar_name} is the primary offering — about 90 minutes, both homeowners present.`,
      'If the lead doesn\'t push back, offer two specific in-home slots without asking permission.',
      'If they decline the in-home OR insist on a phone-first conversation, the 15-min Confirmation Call is your fallback. Don\'t lead with the call though — only offer it if pushed.',
    ].join(' '),
  };
}

const BUYING_SIGNAL_INTENTS = new Set([
  'BOOK', 'BOOK_NEXTSTEP', 'BOOK_QUOTE_READY', 'FAST_TRACK_FRUSTRATED',
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
  const terms = String(messageText)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6);

  if (terms.length === 0) return [];

  const runSearch = async (tsQuery, label) => {
    const { data, error } = await supabase
      .from('kb_faqs')
      .select('question_pattern, canonical_answer, answer_short, story_arc, channel, tier')
      .eq('active', true)
      .in('channel', [channel, 'both'])
      .textSearch('question_pattern', tsQuery, { type: 'websearch', config: 'english' })
      .limit(limit);
    if (error) {
      console.warn(`[KBRetriever] searchFaqs ${label} error:`, error.message);
      return null;
    }
    return data || [];
  };

  try {
    // AND pass first (precise), then OR the same terms when it comes back
    // empty: one colloquial extra word ("guys", "y'all") must not zero out
    // an exact-topic FAQ — with no FAQ in the pack the model is free to
    // invent product claims, which is the worse failure.
    let data = await runSearch(terms.join(' & '), 'AND pass');
    if (data && data.length === 0 && terms.length > 1) {
      data = await runSearch(terms.join(' OR '), 'OR fallback');
    }
    if (data !== null) return data;

    return await safeFetch(
      selectFromActive('kb_faqs', 'question_pattern, canonical_answer, answer_short, story_arc, channel, tier')
        .in('channel', [channel, 'both'])
        .ilike('question_pattern', `%${messageText.slice(0, 100)}%`)
        .limit(limit),
      'searchFaqs ilike fallback'
    );
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

// ── Concierge belief stack (Bot 2 migration) ─────────────────────────────────
// Canon-locked source docs (data/kb/concierge/*.md, ingested into kb_embeddings)
// pulled on objection/pricing turns so the responder can quote the Big Domino +
// Three Secrets VERBATIM. Deterministic source_doc lookup (whole doc, ordered) —
// these are tiny locked docs; we want the exact text, not a semantic top-k.
const CONCIERGE_BELIEF_SOURCES = {
  OBJECTION: ['reece_belief_stack', 'reece_objection_playbook'],
  PRICING:   ['reece_belief_stack', 'reece_pricing_policy', 'reece_objection_playbook'],
};

async function getConciergeBeliefDocs(intentClass) {
  const sources = CONCIERGE_BELIEF_SOURCES[intentClass];
  if (!sources) return null;
  try {
    const { data, error } = await supabase
      .from('kb_embeddings')
      .select('source_doc, chunk_text, id')
      .in('source_doc', sources)
      .eq('active', true)
      .order('id', { ascending: true });
    if (error || !data || data.length === 0) return null;
    const byDoc = new Map();
    for (const row of data) {
      if (!byDoc.has(row.source_doc)) byDoc.set(row.source_doc, []);
      byDoc.get(row.source_doc).push(row.chunk_text);
    }
    // Preserve the canonical source order (belief stack first).
    return sources
      .filter((s) => byDoc.has(s))
      .map((s) => ({ source_doc: s, text: byDoc.get(s).join('\n') }));
  } catch {
    return null; // additive context; never block a reply
  }
}

/**
 * Build the full KB pack for a response generation call.
 *
 * v1.7 — Now also detects scheduling continuation signals (day names,
 * "doesn't work", "anything on", reschedule cues). When detected on
 * intent classes that don't normally attach booking_context (QUESTION,
 * UNCLEAR, RECONNECT, NOT_INTERESTED, SEND_INFO), forces booking_context
 * attachment so the calendar lookup fires. Belt-and-suspenders alongside
 * classifier-side fixes.
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
    contactTags = [],
  } = params;

  const detectedCompetitor = detectCompetitorMention(messageText);
  const detectedObjection = detectObjection(messageText)
    || (objectionTags.length > 0 ? objectionTags[0] : null);
  const userBookingPreference = detectUserBookingPreference(messageText);
  // v1.7: scheduling-signal detection for defensive booking_context attachment
  const schedulingSignal = detectSchedulingSignal(messageText);

  const result = {
    intent_class: intentClass,
    primary_arc: null,
    arc_options: [],
    objection_script: null,
    belief_stack: null,
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
      scheduling_signal: schedulingSignal,  // v1.7
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
      // v1.7: also attach booking_context when scheduling signal present
      // (e.g. "I want to reschedule, Saturday doesn't work" — timing objection
      // PLUS scheduling continuation)
      if (detectedObjection === 'timing' || schedulingSignal) {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    case 'PRICING':
      result.pricing_anchor = await getPricingAnchor(windowCount);
      // v1.7: rare but possible — "I want to know the price for the Sunday slot"
      if (schedulingSignal) {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    case 'QUESTION':
      result.faqs = await searchFaqs(messageText, channel, 3);
      // v1.7: attach booking_context if user preference OR scheduling signal
      // detected — this catches misclassified continuations like "Saturday
      // doesn't work, anything Sunday?" that Layer 1 keyword scan routes to
      // QUESTION when it shouldn't.
      if (userBookingPreference || schedulingSignal) {
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
      // v1.7: same defensive attachment as QUESTION
      if (userBookingPreference || schedulingSignal) {
        result.booking_context = resolveBookingContext(bookingCtxArgs);
      }
      break;

    default:
      break;
  }

  // Mid-booking backstop: if the contact is already in the booking flow (tags set
  // by the resolver / buyer-journey), attach booking_context regardless of intent.
  // Without this, an ack/status turn ("Hello?", "is that scheduled already?") with
  // no scheduling-signal keywords attaches nothing, the calendar resolver is
  // skipped, and the model can emit a raw, mis-routed companion. Attaching it lets
  // the resolver pick the right calendar (risk-report→PPR, estimate-calc→MV,
  // default→Window Estimate) and keeps the decision-maker/address gate live.
  const inBookingFlow = Array.isArray(contactTags) && contactTags.some(
    (t) => t === 'booking:active' || t === 'booking:dm-pending' || t === 'bj:stage-5-committed',
  );
  if (inBookingFlow && !result.booking_context) {
    result.booking_context = resolveBookingContext(bookingCtxArgs);
  }

  // Concierge belief stack (Bot 2 migration): on objection/pricing turns, attach
  // the canon-locked belief stack + playbook (+ pricing policy for PRICING) so the
  // responder can quote the Big Domino and the Three Secrets verbatim and route to
  // the Protection Profile Review. Additive context; never blocks a reply.
  if (intentClass === 'OBJECTION' || intentClass === 'PRICING') {
    result.belief_stack = await getConciergeBeliefDocs(intentClass);
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
// PROMPT FORMATTER
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

  if (Array.isArray(pack.belief_stack) && pack.belief_stack.length > 0) {
    lines.push('LOCKED BELIEF STACK (Big Domino + Three Secrets — quote these lines VERBATIM, em-dashes included; never paraphrase):');
    for (const d of pack.belief_stack) {
      lines.push(`  [${d.source_doc}]`);
      for (const ln of String(d.text).split('\n')) {
        if (ln.trim()) lines.push(`  ${ln}`);
      }
    }
    lines.push('');
  }

  if (pack.booking_context) {
    const b = pack.booking_context;
    const policy = b.policy || 'in_home_first_call_fallback';
    const isBuyingSignal     = BUYING_SIGNAL_INTENTS.has(pack.intent_class);
    const isCallback         = CALLBACK_INTENTS.has(pack.intent_class);
    const isApptStatus       = APPT_STATUS_INTENTS.has(pack.intent_class);
    const isTimingObjection  = pack.intent_class === 'OBJECTION'
      && pack.detected_signals?.objection === 'timing';
    const schedulingSignal   = pack.detected_signals?.scheduling_signal;

    lines.push('BOOKING CONTEXT (v1.7):');
    lines.push(`  Policy: ${policy}`);
    if (pack.detected_signals?.user_booking_preference) {
      lines.push(`  User explicitly asked for: ${pack.detected_signals.user_booking_preference}`);
    }
    if (schedulingSignal) {
      lines.push(`  Scheduling signal detected in inbound: "${schedulingSignal}" — lead is engaged in a scheduling exchange. Apply BOOKING — ASK-FIRST PROTOCOL with TWO specific time options from CALENDAR AVAILABILITY (not day-only proposals).`);
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
