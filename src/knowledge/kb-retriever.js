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
 *                     → BOOKING CONTEXT with IN-HOME as primary, Confirmation
 *                       Call as fallback only (per Mark's in-home-first policy)
 *   - RECONNECT / NOT_INTERESTED / SEND_INFO / UNCLEAR
 *                     → kb_story_arcs (chosen by buyer_stage)
 *
 * Always pulls (when relevant context provided):
 *   - kb_techniques relevant to current buyer_stage
 *   - kb_competitor_intel if a competitor name is detected in message
 *
 * v1.2 — 2026-04-28. IN-HOME-FIRST BOOKING POLICY.
 *   Per Mark's instruction: always try to schedule the Window Estimate
 *   (or MV for estimate-calculator leads) FIRST. The 15-min Confirmation
 *   Call is a SECONDARY fallback, only offered after the lead explicitly
 *   declines the in-home appointment.
 *
 *   Changes:
 *   - resolveBookingContext now ALWAYS returns the in-home calendar as
 *     primary, including for CALLBACK / CALLBACK_CALM intents.
 *   - For CALLBACK intents, a `fallback` block is also included with
 *     the Confirmation Call calendar — but it's marked as fallback-only
 *     and the guidance text directs the model to lead with in-home.
 *   - Top-level booking_context fields (calendar_id, etc.) still point
 *     to the in-home calendar so existing consumers that read those
 *     fields keep working.
 *   - formatKbPackForPrompt renders both primary AND fallback when
 *     present, with explicit hierarchy ("PRIMARY: ..., FALLBACK ONLY: ...").
 *
 * v1.1 — Calendar awareness:
 *   - Adds resolveBookingContext({intentClass, activeEntryTag})
 *   - Surfaces correct calendar ID per intent + lead source
 *
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';

// ═══════════════════════════════════════════════════════════════════
// CALENDAR CONSTANTS — Reece booking calendars
// ═══════════════════════════════════════════════════════════════════

export const CALENDAR_IDS = {
  CONFIRMATION_CALL: 'gFWoSQrlKIdfRbAPV842',  // 1-2min call to confirm details — FALLBACK ONLY
  WINDOW_ESTIMATE:   'aJj14ONxh1oFyDcQ706O',  // 90-min in-home Window Protection Estimate (DEFAULT)
  MV:                'zEdPmkNccR2ovo3rQAd3',  // Window Measurement Verification (estimate-calculator leads)
};

// Override via env so Mark can swap to a custom domain later
const BOOKING_URL_BASE = (process.env.GHL_BOOKING_URL_BASE || 'https://api.leadconnectorhq.com/widget/booking').replace(/\/+$/, '');

const calendarUrl = (id) => `${BOOKING_URL_BASE}/${id}`;

// ─── Calendar definitions ────────────────────────────────────────

function inHomeCalendar({ activeEntryTag }) {
  const isEstimateCalculator = typeof activeEntryTag === 'string'
    && activeEntryTag === 'active-entry:estimate-calculator';

  if (isEstimateCalculator) {
    return {
      type:             'in_home',
      visit_type:       'in_home',
      calendar_id:      CALENDAR_IDS.MV,
      calendar_name:    'Window Measurement Verification',
      duration_minutes: 90,
      booking_url:      calendarUrl(CALENDAR_IDS.MV),
      description:      'In-home measurement verification — about an hour and a half — for online estimate calculator leads. Specialist verifies measurements and finalizes penny-accurate pricing.',
    };
  }

  return {
    type:             'in_home',
    visit_type:       'in_home',
    calendar_id:      CALENDAR_IDS.WINDOW_ESTIMATE,
    calendar_name:    'Window Estimate',
    duration_minutes: 90,
    booking_url:      calendarUrl(CALENDAR_IDS.WINDOW_ESTIMATE),
    description:      'Standard in-home Window Protection Estimate — about an hour and a half. Specialist measures to Florida code and provides exact pricing valid for 1 year.',
  };
}

const confirmationCallCalendar = {
  type:             'phone_call',
  visit_type:       'phone',
  calendar_id:      CALENDAR_IDS.CONFIRMATION_CALL,
  calendar_name:    'Confirmation Call',
  duration_minutes: 15,
  booking_url:      calendarUrl(CALENDAR_IDS.CONFIRMATION_CALL),
  description:      '1-2 minute phone call to confirm details. Used as a fallback when a lead explicitly declines the in-home estimate.',
};

/**
 * Resolve the right booking calendar based on intent + lead source.
 *
 * IN-HOME-FIRST POLICY (per Mark): The in-home Window Estimate (or MV
 * for estimate-calculator leads) is ALWAYS the primary offering. The
 * 15-min Confirmation Call is a SECONDARY fallback and is only offered
 * after the lead explicitly declines the in-home appointment.
 *
 * Returns booking_context with:
 *   - Top-level fields (calendar_id, calendar_name, etc.) → primary in-home
 *   - primary: { ...in-home calendar }
 *   - fallback: { ...confirmation-call calendar } — only present for
 *               CALLBACK intents; null otherwise
 *   - policy: 'in_home_only' | 'in_home_first_call_fallback'
 *   - guidance: instruction text for the model
 *
 * @param {Object} args
 * @param {string} args.intentClass — Classifier output (e.g. 'BOOK_QUOTE_READY')
 * @param {string} [args.activeEntryTag] — Current lead source tag (e.g. 'active-entry:estimate-calculator')
 * @returns {Object|null} BookingContext, or null when not a booking-relevant intent
 */
export function resolveBookingContext({ intentClass, activeEntryTag } = {}) {
  const inHome = inHomeCalendar({ activeEntryTag });
  const isCallback = intentClass === 'CALLBACK' || intentClass === 'CALLBACK_CALM';

  // Common base — top-level fields point to the IN-HOME calendar so
  // existing readers of booking_context.calendar_id etc. keep working.
  const base = {
    ...inHome,
    primary: inHome,
  };

  if (isCallback) {
    return {
      ...base,
      policy:   'in_home_first_call_fallback',
      fallback: confirmationCallCalendar,
      guidance: [
        'The lead asked for a phone call. Per Reece policy, the in-home estimate is our PRIMARY offering and the 15-min phone call is a SECONDARY fallback.',
        'FIRST: Acknowledge their preference for a call, then OFFER THE IN-HOME APPOINTMENT — give two specific in-home slots.',
        'Frame the in-home as the better option: specialist measures to Florida code on-site, you get penny-accurate pricing valid for 1 year, both homeowners can see the actual product.',
        'ONLY mention the 15-min Confirmation Call as a fallback option if the lead explicitly declines the in-home OR insists on a phone-first approach. Do NOT lead with the call.',
      ].join(' '),
    };
  }

  // BOOK / BOOK_NEXTSTEP / BOOK_QUOTE_READY / FAST_TRACK_FRUSTRATED — in-home only
  return {
    ...base,
    policy:   'in_home_only',
    fallback: null,
    guidance: 'Move directly to scheduling — skip discovery, skip re-pitching value, skip mentioning financing or specific pricing. Acknowledge intent in ONE short line, then offer two specific in-home slots. Both homeowners should be present. No pressure to decide on the spot.',
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
 * @param {string} [params.activeEntryTag] — v1.1: lead's current source tag
 *                                           (e.g. 'active-entry:estimate-calculator')
 *                                           Used to pick the right calendar.
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
  } = params;

  // Detect signals from message
  const detectedCompetitor = detectCompetitorMention(messageText);
  const detectedObjection = detectObjection(messageText)
    || (objectionTags.length > 0 ? objectionTags[0] : null);

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

  // Branch by intent class
  switch (intentClass) {
    case 'OBJECTION':
      if (detectedObjection) {
        result.objection_script = await getObjectionScript(detectedObjection, buyerStage, channel);
        if (result.objection_script?.story_arc) {
          result.primary_arc = await getStoryArc(result.objection_script.story_arc);
        }
      }
      // v1.2: For pre-demo timing objections (e.g. "just had a baby"), still
      // surface booking context so the model can offer a softer reschedule.
      // This is critical because pre-demo timing objections SHOULD route to
      // W5.2 Appointment Rescue, NOT W9.0 Objection Handler. Including
      // booking_context here gives the model the calendar it needs to gently
      // reschedule rather than capitulate.
      if (detectedObjection === 'timing') {
        result.booking_context = resolveBookingContext({ intentClass, activeEntryTag });
      }
      break;

    case 'PRICING':
      // "how much does it cost?" — pivot to discovery, no booking yet.
      result.pricing_anchor = await getPricingAnchor(windowCount);
      break;

    case 'QUESTION':
      result.faqs = await searchFaqs(messageText, channel, 3);
      break;

    // ─── v1.1: Buying-signal + callback intents — surface booking context ──
    case 'BOOK':
    case 'BOOK_NEXTSTEP':
    case 'BOOK_QUOTE_READY':
    case 'FAST_TRACK_FRUSTRATED':
    case 'CALLBACK':
    case 'CALLBACK_CALM':
      result.booking_context = resolveBookingContext({ intentClass, activeEntryTag });
      break;

    case 'RECONNECT':
    case 'NOT_INTERESTED':
    case 'SEND_INFO':
    case 'UNCLEAR':
      // primary_arc + techniques already covered
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

  // ─── BOOKING CONTEXT — IN-HOME-FIRST policy (v1.2) ────────────────────
  if (pack.booking_context) {
    const b = pack.booking_context;
    const isBuyingSignal = BUYING_SIGNAL_INTENTS.has(pack.intent_class);
    const isCallback = CALLBACK_INTENTS.has(pack.intent_class);
    const isTimingObjection = pack.intent_class === 'OBJECTION'
      && pack.detected_signals?.objection === 'timing';

    lines.push('BOOKING CONTEXT — IN-HOME-FIRST POLICY:');
    lines.push(`  Policy: ${b.policy || 'in_home_only'}`);

    // Primary (always in-home)
    const primary = b.primary || b;
    lines.push(`  PRIMARY (default offering): ${primary.calendar_name} — ${primary.duration_minutes}min ${primary.visit_type}`);
    lines.push(`    Calendar ID: ${primary.calendar_id}`);
    lines.push(`    Booking URL: ${primary.booking_url}`);
    lines.push(`    Description: ${primary.description}`);

    // Fallback (only present for CALLBACK)
    if (b.fallback) {
      lines.push(`  FALLBACK ONLY (use only if lead explicitly declines in-home): ${b.fallback.calendar_name} — ${b.fallback.duration_minutes}min ${b.fallback.visit_type}`);
      lines.push(`    Calendar ID: ${b.fallback.calendar_id}`);
      lines.push(`    Booking URL: ${b.fallback.booking_url}`);
    }

    lines.push(`  Guidance: ${b.guidance}`);

    if (isBuyingSignal) {
      lines.push(`  ⚡ BUYING-SIGNAL HANDLING: Skip discovery, skip re-pitching value, skip mentioning financing. Acknowledge their intent in ONE short line, then offer two specific in-home slots from the PRIMARY calendar. Match their urgency.`);
    } else if (isCallback) {
      lines.push(`  ☎️ CALLBACK HANDLING: The lead asked for a phone call. Per Reece policy, the in-home Window Estimate is our PRIMARY offering — try to schedule THAT first. Acknowledge the call request, then offer two specific in-home slots. Only offer the 15-min Confirmation Call as a fallback if they explicitly decline the in-home or insist on a phone-first approach. Do NOT lead with the call.`);
    } else if (isTimingObjection) {
      lines.push(`  ⏳ TIMING OBJECTION HANDLING (PRE-DEMO): Lead has a real life situation (new baby, surgery, family emergency, etc.). Do NOT push hard. Acknowledge with empathy. Offer to reschedule to a future date that works better for them — keep it open-ended ("when would be a better time in the next month or two?"). Do NOT route to W9.0 (post-demo objection sequence) — this is a pre-demo reschedule, not a closing objection.`);
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
