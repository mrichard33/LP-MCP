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
 *                     → BOOKING CONTEXT (Confirmation Call calendar)
 *   - RECONNECT / NOT_INTERESTED / SEND_INFO / UNCLEAR
 *                     → kb_story_arcs (chosen by buyer_stage)
 *
 * Always pulls (when relevant context provided):
 *   - kb_techniques relevant to current buyer_stage
 *   - kb_competitor_intel if a competitor name is detected in message
 *
 * v1.1 — 2026-04-28. Calendar awareness:
 *   - Adds resolveBookingContext({intentClass, activeEntryTag})
 *   - Surfaces correct calendar ID per intent + lead source:
 *     · CALLBACK_CALM / CALLBACK   → Confirmation Call (gFWoSQrlKIdfRbAPV842)
 *     · estimate-calculator entry  → Window Measurement Verification (zEdPmkNccR2ovo3rQAd3)
 *     · default in-home            → Window Estimate (aJj14ONxh1oFyDcQ706O)
 *   - Adds booking_context to kb_pack with calendar_id, visit_type, duration,
 *     guidance ("skip discovery, go to scheduling"), and a booking_url
 *     (pattern overridable via GHL_BOOKING_URL_BASE env var).
 *
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';

// ═══════════════════════════════════════════════════════════════════
// CALENDAR CONSTANTS — Reece booking calendars
// ═══════════════════════════════════════════════════════════════════

export const CALENDAR_IDS = {
  CONFIRMATION_CALL: 'gFWoSQrlKIdfRbAPV842',  // 1-2min call to confirm details before in-home
  WINDOW_ESTIMATE:   'aJj14ONxh1oFyDcQ706O',  // Standard 90-min in-home Window Protection Estimate
  MV:                'zEdPmkNccR2ovo3rQAd3',  // Window Measurement Verification — for estimate calculator leads
};

// Override via env so Mark can swap to a custom domain later
const BOOKING_URL_BASE = (process.env.GHL_BOOKING_URL_BASE || 'https://api.leadconnectorhq.com/widget/booking').replace(/\/+$/, '');

const calendarUrl = (id) => `${BOOKING_URL_BASE}/${id}`;

/**
 * Resolve the right booking calendar based on intent + lead source.
 *
 * @param {Object} args
 * @param {string} args.intentClass — Classifier output (e.g. 'BOOK_QUOTE_READY')
 * @param {string} [args.activeEntryTag] — Current lead source tag (e.g. 'active-entry:estimate-calculator')
 * @returns {Object|null} BookingContext, or null when not a booking-relevant intent
 */
export function resolveBookingContext({ intentClass, activeEntryTag } = {}) {
  // Phone callback intents → Confirmation Call calendar (15min phone slot)
  if (intentClass === 'CALLBACK' || intentClass === 'CALLBACK_CALM') {
    return {
      type:             'phone_call',
      visit_type:       'phone',
      calendar_id:      CALENDAR_IDS.CONFIRMATION_CALL,
      calendar_name:    'Confirmation Call',
      duration_minutes: 15,
      booking_url:      calendarUrl(CALENDAR_IDS.CONFIRMATION_CALL),
      description:      '1-2 minute phone call to confirm details before any in-home estimate',
      guidance:         'Confirm phone number, offer the call slot. Do NOT pitch in-home yet — that comes after the call.',
    };
  }

  // Estimate calculator leads → MV calendar (web-form completers ready for measurement)
  if (typeof activeEntryTag === 'string' && activeEntryTag === 'active-entry:estimate-calculator') {
    return {
      type:             'in_home',
      visit_type:       'in_home',
      calendar_id:      CALENDAR_IDS.MV,
      calendar_name:    'Window Measurement Verification',
      duration_minutes: 90,
      booking_url:      calendarUrl(CALENDAR_IDS.MV),
      description:      'In-home measurement verification — about an hour and a half — for online estimate calculator leads',
      guidance:         'They already used the online calculator. The in-home is to verify measurements and finalize penny-accurate pricing. Move directly to scheduling — skip discovery.',
    };
  }

  // Default in-home: standard Window Estimate
  return {
    type:             'in_home',
    visit_type:       'in_home',
    calendar_id:      CALENDAR_IDS.WINDOW_ESTIMATE,
    calendar_name:    'Window Estimate',
    duration_minutes: 90,
    booking_url:      calendarUrl(CALENDAR_IDS.WINDOW_ESTIMATE),
    description:      'Standard in-home Window Protection Estimate — about an hour and a half. Specialist measures to Florida code and provides exact pricing valid for 1 year.',
    guidance:         'Both homeowners should be present. No pressure to decide on the spot. Penny-accurate pricing.',
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
  timing:     ['not now', 'later', 'next year', 'wait', 'busy', 'in a few months', 'after', 'before'],
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
      break;

    case 'PRICING':
      // "how much does it cost?" — pivot to discovery, no booking yet.
      result.pricing_anchor = await getPricingAnchor(windowCount);
      break;

    case 'QUESTION':
      result.faqs = await searchFaqs(messageText, channel, 3);
      break;

    // ─── v1.1: Buying-signal intents — surface booking context ──────
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

  // ─── BOOKING CONTEXT — appears only for buying-signal/callback intents ──
  if (pack.booking_context) {
    const b = pack.booking_context;
    const isBuyingSignal = BUYING_SIGNAL_INTENTS.has(pack.intent_class);
    const isCallback = CALLBACK_INTENTS.has(pack.intent_class);

    lines.push('BOOKING CONTEXT (use this calendar in the response):');
    lines.push(`  Calendar: ${b.calendar_name} (${b.duration_minutes}min, ${b.visit_type})`);
    lines.push(`  Calendar ID: ${b.calendar_id}`);
    lines.push(`  Booking URL: ${b.booking_url}`);
    lines.push(`  Description: ${b.description}`);
    lines.push(`  Guidance: ${b.guidance}`);
    if (isBuyingSignal) {
      lines.push(`  ⚡ BUYING-SIGNAL HANDLING: Skip discovery questions. Skip re-pitching value. Skip mentioning financing or pricing. Acknowledge their intent in ONE short line, then offer two specific calendar slots from this calendar. Match urgency.`);
    } else if (isCallback) {
      lines.push(`  ☎️ CALLBACK HANDLING: Confirm the lead's phone number, offer one specific call slot, do not try to keep them in text. Hand off after confirming.`);
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
