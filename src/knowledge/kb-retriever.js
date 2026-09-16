/**
 * KB Retriever — src/knowledge/kb-retriever.js
 *
 * Orchestrates structured KB lookups (Tier 1) for the response generator,
 * plus the Tier 2 vector search over kb_embeddings (v1.9, gated).
 *
 * v1.13 — 2026-09-10. ESTIMATE PDF LINK.
 *   Contact ECFITedNfAG0NVljENBx asked "Did not get estimate"; the bot promised
 *   "a direct link to your estimate PDF" and sent none (agent_actions 441204).
 *   The pack had booking links only. Now every estimate-completed lead
 *   (estimator-completed / completed:wec) carries pack.estimate_link =
 *   {{trigger_link.uyGlZ6ydYUmAqeWysREJ}} (redirects to the contact's own PDF),
 *   rendered as an ESTIMATE LINK prompt block; requests are flagged as MUST
 *   include. Pure helpers + send-time guard live in estimate-link.js.
 *
 * v1.12 — 2026-09-03. CALL MOMENTS (KB_CALL_MOMENTS_MODE).
 *   4,462 CI transcripts since 2026-08-24 hold homeowner objections and
 *   questions in their own words, plus the agent's answer — and no speaker
 *   labels. ci-moments.js runs one JSON extraction per eligible call and
 *   stores the moments (homeowner side embedded). buildKbPack() retrieves
 *   the closest moments where the point was resolved or the call booked,
 *   AFTER Tier 1 and BEFORE Tier 2, on every conversational intent, reusing
 *   the per-turn query embedding. off (default) / shadow (log only,
 *   tier='ci_moments') / live (FROM REAL CALLS block injected). Also feeds
 *   the v1.10 objection classifier (tier1-semantic.js) with real objections
 *   once ≥3 neighbours exist. Independent of v1.11 (text-side exemplars);
 *   both may be present.
 *
 * v1.11 — 2026-09-03. PAST-WIN EXEMPLARS (KB_EXEMPLAR_MODE).
 *   PROBLEM: Tiers 1 and 2 tell the model what is true; nothing tells it what
 *   has worked. Every lead message and reply since 2025-09 sits in the HL
 *   warehouse and appointments.raw_json->>'dateAdded' says whether a booking
 *   followed (177 of 1,603 answered inbounds since 2026-06-01).
 *   FIX: exemplars.js builds kb_exemplars (lead said → we replied → outcome,
 *   PII-scrubbed, lead side embedded). buildKbPack() retrieves the closest
 *   exchanges that led to a booking, AFTER Tier 1 and BEFORE Tier 2, on every
 *   conversational intent (EXEMPLAR_SKIP_INTENTS excluded), reusing the
 *   per-turn query embedding. Gated by KB_EXEMPLAR_MODE: off (default) /
 *   shadow (log only, tier='kb_exemplars') / live (PAST WINS block injected).
 *
 * v1.10 — 2026-09-03. SEMANTIC TIER 1 (KB_FAQ_SEMANTIC_MODE).
 *   PROBLEM: searchFaqs() is Postgres full-text on kb_faqs.question_pattern —
 *   it hits only when the lead's words overlap the pattern's words. "Will
 *   these hold up in a Cat 4?" does not match "hurricane rated"; the pack is
 *   empty and the model is free to invent product claims. detectObjection()
 *   is a fixed keyword list with the same blind spot.
 *
 *   FIX (three parts, one flag):
 *     1. searchFaqs() is semantic-first. kb_faqs gets an embedding column
 *        (sql/077) kept fresh by tier1-semantic.js embedFaqsSweep(); the
 *        match_kb_faqs RPC returns rows by cosine similarity. Keyword path is
 *        retained byte-for-byte as searchFaqsKeyword() and is the fallback.
 *     2. On OBJECTION turns where keywords + tags found no type, six embedded
 *        type descriptions are compared in memory to pick objection_type.
 *     3. One query embedding per turn (makeQueryEmbedder, memoised) is shared
 *        by Tier 1 semantic, objection typing, and Tier 2 — never two OpenAI
 *        calls for the same message.
 *   Gated by KB_FAQ_SEMANTIC_MODE: off (default) = pre-v1.10 behaviour;
 *   shadow = keyword answers, semantic runs and is logged to kb_vector_queries
 *   (tier='kb_faqs' / 'objection_type', keyword_match_count alongside);
 *   live = semantic first.
 *
 * v1.9 — 2026-09-02. TIER 2 VECTOR SEARCH WIRED (KB_VECTOR_MODE).
 *   PROBLEM: src/knowledge/vector-search.js existed since 2026-04 but was
 *   imported by nothing. idx_kb_embeddings_vec had 0 lifetime scans on
 *   2026-09-02 with 3,289 chunks / 18 source docs loaded. The only reader of
 *   kb_embeddings was getConciergeBeliefDocs() — a whole-doc fetch by name.
 *   The KB was embedded; the bot never searched it by meaning.
 *
 *   FIX: after Tier 1 resolves, buildKbPack() runs searchKnowledge() on the
 *   inbound text for QUESTION/OBJECTION (only when Tier 1 missed) and
 *   PRICING/SEND_INFO/UNCLEAR (always). Gated by KB_VECTOR_MODE:
 *     off    (default) — never runs
 *     shadow — runs, logs to console + kb_vector_queries, NOT in the prompt
 *     live   — also injected by formatKbPackForPrompt() as background context
 *   Time-boxed (KB_VECTOR_TIMEOUT_MS) so an OpenAI stall can never hold a
 *   reply. Gating logic lives in vector-gate.js (pure, unit-tested).
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
import { searchKnowledge, formatMatchesForPrompt } from './vector-search.js';
import {
  getKbVectorMode,
  shouldRunVectorSearch,
  dedupeVectorMatches,
} from './vector-gate.js';
import { getKbFaqSemanticMode } from './tier1-semantic-core.js';
import {
  makeQueryEmbedder,
  matchFaqsProbed,
  classifyObjectionSemantic,
  logKbQuery,
} from './tier1-semantic.js';
import { getKbCallMomentsMode, shouldRunCallMoments, formatCallMomentsForPrompt } from './ci-moments-core.js';
import { runCallMomentsTier } from './ci-moments.js';

const KB_CALL_MOMENTS_MAX_CHARS = parseInt(process.env.KB_CALL_MOMENTS_MAX_CHARS || '1200', 10);
import { getKbExemplarMode, shouldRunExemplars, formatExemplarsForPrompt } from './exemplars-core.js';
import { runExemplarTier } from './exemplars.js';
import {
  ESTIMATE_PDF_TRIGGER_ID,
  getEstimatePdfMergeTag,
  hasCompletedEstimate,
  detectEstimateLinkRequest,
  ensureEstimateLink,
} from './estimate-link.js';

export { getEstimatePdfMergeTag, hasCompletedEstimate, detectEstimateLinkRequest, ensureEstimateLink };

const KB_EXEMPLAR_MAX_CHARS = parseInt(process.env.KB_EXEMPLAR_MAX_CHARS || '1200', 10);

// ═══════════════════════════════════════════════════════════════════
// v1.9 — TIER 2 VECTOR SEARCH RUNNER
// ═══════════════════════════════════════════════════════════════════

const KB_VECTOR_TIMEOUT_MS = parseInt(process.env.KB_VECTOR_TIMEOUT_MS || '1500', 10);
const KB_VECTOR_MAX_CHARS  = parseInt(process.env.KB_VECTOR_MAX_CHARS  || '1500', 10);
const KB_VECTOR_LIMIT      = parseInt(process.env.KB_VECTOR_MATCH_COUNT || '4', 10);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run the vector tier for one turn. Never throws; never blocks a reply past
 * KB_VECTOR_TIMEOUT_MS. Writes one audit row to kb_vector_queries (fire and
 * forget) — that table is the evidence for the shadow → live decision.
 */
async function runVectorTier(messageText, pack, mode, getQueryEmbedding = null) {
  const started = Date.now();
  let matches = [];
  let error = null;
  try {
    // v1.10: reuse the per-turn query embedding when the caller has one, so a
    // QUESTION turn that already embedded for Tier 1 does not embed again.
    const res = await withTimeout(
      (async () => {
        const queryEmbedding = getQueryEmbedding ? await getQueryEmbedding() : null;
        return searchKnowledge(messageText, { limit: KB_VECTOR_LIMIT, queryEmbedding });
      })(),
      KB_VECTOR_TIMEOUT_MS,
      'kb vector search',
    );
    matches = dedupeVectorMatches(res.matches, pack);
    if (res.error) error = res.error;
  } catch (err) {
    error = err.message;
  }
  const latency = Date.now() - started;
  const top = typeof matches[0]?.similarity === 'number' ? matches[0].similarity : null;

  console.log(
    `[KBRetriever] vector ${mode}: intent=${pack.intent_class} matches=${matches.length}` +
    ` top_sim=${top === null ? 'n/a' : top.toFixed(3)} latency=${latency}ms` +
    (error ? ` error=${error}` : ''),
  );

  try {
    supabase
      .from('kb_vector_queries')
      .insert({
        intent_class: pack.intent_class,
        mode,
        query_text: String(messageText).slice(0, 500),
        match_count: matches.length,
        top_similarity: top,
        sources: matches.map((m) => ({
          source_doc: m.source_doc,
          section: m.source_section || null,
          similarity: m.similarity,
        })),
        latency_ms: latency,
        error,
      })
      .then(({ error: insErr }) => {
        if (insErr) console.warn('[KBRetriever] kb_vector_queries insert failed:', insErr.message);
      })
      .catch(() => {});
  } catch {
    // audit row is best-effort; never affects the reply
  }

  return matches;
}

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
  ESTIMATE_PDF:        ESTIMATE_PDF_TRIGGER_ID, // v1.13 — "View Calculator Estimate" → contact's own PDF
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

// v1.10 — the pre-v1.10 keyword path, unchanged. Fallback for the semantic
// path and the whole answer when KB_FAQ_SEMANTIC_MODE=off.
async function searchFaqsKeyword(messageText, channel = 'sms', limit = 3) {
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

/**
 * v1.10 — Tier 1 FAQ lookup.
 *   off    → keyword path only (identical to pre-v1.10)
 *   shadow → keyword path is the answer; semantic runs alongside, both logged
 *   live   → semantic first; keyword path only when semantic returns nothing
 * opts.getQueryEmbedding: memoised per-turn embedder from buildKbPack.
 */
export async function searchFaqs(messageText, channel = 'sms', limit = 3, opts = {}) {
  const mode = getKbFaqSemanticMode();
  if (mode === 'off' || !messageText) {
    return searchFaqsKeyword(messageText, channel, limit);
  }

  const started = Date.now();
  const getQueryEmbedding = opts.getQueryEmbedding || makeQueryEmbedder(messageText);
  let semantic = [];
  let topSim = null;
  let error = null;
  try {
    // v1.13 — shadow probes below the floor so a miss records how close it got.
    const probed = await withTimeout(
      (async () => matchFaqsProbed(await getQueryEmbedding(), channel, limit, { probe: mode === 'shadow' }))(),
      KB_VECTOR_TIMEOUT_MS,
      'kb faq semantic',
    );
    semantic = probed.matches;
    topSim = probed.top;
  } catch (err) {
    error = err.message;
  }

  let keyword = null;
  if (mode === 'shadow' || semantic.length === 0) {
    keyword = await searchFaqsKeyword(messageText, channel, limit);
  }

  const top = topSim;
  console.log(
    `[KBRetriever] faq ${mode}: semantic=${semantic.length} keyword=${keyword === null ? 'skipped' : keyword.length}` +
    ` top_sim=${top === null ? 'n/a' : top.toFixed(3)} latency=${Date.now() - started}ms` +
    (error ? ` error=${error}` : ''),
  );
  logKbQuery({
    tier: 'kb_faqs',
    intent_class: opts.intentClass || 'QUESTION',
    mode,
    query_text: String(messageText).slice(0, 500),
    match_count: semantic.length,
    keyword_match_count: keyword === null ? null : keyword.length,
    top_similarity: top,
    sources: semantic.map((f) => ({
      faq_id: f.id,
      question_pattern: String(f.question_pattern || '').slice(0, 120),
      similarity: f.similarity,
    })),
    latency_ms: Date.now() - started,
    error,
  });

  if (mode === 'live' && semantic.length > 0) return semantic;
  return keyword || [];
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
 * v1.13 — 2026-09-16. Start the per-turn query embedding EARLY.
 *
 * Every semantic tier shares one memoised embedding and then runs a pgvector
 * RPC, with both steps inside one KB_VECTOR_TIMEOUT_MS (1500ms) box. Measured
 * over 13 days of production audit rows: the embed is ~770ms and the RPC ~270ms
 * (Tier 2 runs last, always attaches to a warm embedding, and its 268ms p50 is
 * therefore RPC-only). The embed was eating three quarters of a budget it was
 * never sized for, and 41 of 217 lookups died as 1500ms timeouts — 23% of the
 * exemplar tier and 4% of Tier 2, which is live.
 *
 * Starting it at the top of generateResponse overlaps it with buildLeadContext
 * and classifyInbound — the latter is a whole LLM round trip — so by the time
 * any tier asks, the promise is already resolved and the box covers the RPC
 * alone. One kickoff fixes every tier at once.
 *
 * Returns null when the text is empty or every semantic mode is off, which
 * preserves the guarantee that all-flags-off is byte-identical to before.
 *
 * This is deliberately SPECULATIVE: the intent class is not known until
 * classifyInbound has run, which is the very work being overlapped, so a turn
 * that ends up needing no tier still embeds once. At text-embedding-3-small
 * that is ~$0.00001 against ~13 turns/day — immaterial next to the 41 lookups
 * the serial version was losing.
 *
 * @returns {(() => Promise<Object|null>)|null} memoised getter for buildKbPack
 */
export function prewarmQueryEmbedding(messageText) {
  if (!messageText || typeof messageText !== 'string' || !messageText.trim()) return null;
  const anySemanticOn = getKbFaqSemanticMode() !== 'off'
    || getKbVectorMode() !== 'off'
    || getKbExemplarMode() !== 'off'
    || getKbCallMomentsMode() !== 'off';
  if (!anySemanticOn) return null;

  const getQueryEmbedding = makeQueryEmbedder(messageText);
  const started = Date.now();
  // Fire now, resolve later. The catch is required, not decorative: the memo
  // rejects on failure and clears itself, and without a handler attached at
  // kickoff that rejection is unhandled before any tier gets a chance to await.
  // A failed prewarm is not fatal — the cleared memo means the first tier to
  // ask simply embeds again, which is exactly the pre-v1.13 behaviour.
  getQueryEmbedding()
    .then(() => console.log(`[KBEmbed] prewarm ready in ${Date.now() - started}ms`))
    .catch((err) => console.warn(`[KBEmbed] prewarm failed in ${Date.now() - started}ms (tiers re-embed): ${err.message}`));
  return getQueryEmbedding;
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

  // v1.10 — one query embedding per turn, computed lazily on first use and
  // shared by Tier 1 semantic FAQ, objection typing, and Tier 2.
  // v1.13 — reuse the embedding the reply path already started (see
  // prewarmQueryEmbedding). Falling back to a fresh lazy embedder keeps every
  // other caller of buildKbPack working unchanged.
  const getQueryEmbedding = params.getQueryEmbedding || makeQueryEmbedder(messageText);
  const faqSemanticMode = getKbFaqSemanticMode();

  const detectedCompetitor = detectCompetitorMention(messageText);
  let detectedObjection = detectObjection(messageText)
    || (objectionTags.length > 0 ? objectionTags[0] : null);
  let objectionDetectedBy = detectedObjection ? 'keyword' : null;

  // v1.10 — semantic objection typing. Only on an OBJECTION turn where the
  // keyword list and objection tags both found nothing. shadow logs the pick;
  // live uses it. Never blocks the reply.
  if (!detectedObjection && intentClass === 'OBJECTION' && messageText && faqSemanticMode !== 'off') {
    const started = Date.now();
    let pick = null;
    let scores = {};
    let error = null;
    try {
      ({ pick, scores } = await withTimeout(
        (async () => classifyObjectionSemantic(await getQueryEmbedding()))(),
        KB_VECTOR_TIMEOUT_MS,
        'objection semantic',
      ));
    } catch (err) {
      error = err.message;
    }
    console.log(
      `[KBRetriever] objection ${faqSemanticMode}: pick=${pick ? `${pick.type}@${pick.similarity.toFixed(3)}` : 'none'}` +
      ` latency=${Date.now() - started}ms` + (error ? ` error=${error}` : ''),
    );
    logKbQuery({
      tier: 'objection_type',
      intent_class: intentClass,
      mode: faqSemanticMode,
      query_text: String(messageText).slice(0, 500),
      match_count: pick ? 1 : 0,
      keyword_match_count: 0,
      top_similarity: pick ? pick.similarity : null,
      sources: Object.entries(scores).map(([type, similarity]) => ({ type, similarity })),
      latency_ms: Date.now() - started,
      error,
    });
    if (pick && faqSemanticMode === 'live') {
      detectedObjection = pick.type;
      objectionDetectedBy = 'semantic';
    }
  }

  const userBookingPreference = detectUserBookingPreference(messageText);
  // v1.7: scheduling-signal detection for defensive booking_context attachment
  const schedulingSignal = detectSchedulingSignal(messageText);
  // v1.13: estimate PDF link — every estimate-completed lead carries it
  const estimateEligible = hasCompletedEstimate(contactTags);
  const estimateRequested = detectEstimateLinkRequest(messageText);

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
    vector_context: [],   // v1.9 — Tier 2 matches; injected only when vector_mode === 'live'
    vector_mode: 'off',   // v1.9 — resolved KB_VECTOR_MODE for this turn
    call_moments: [],         // v1.12 — real-call moments; injected only when call_moments_mode === 'live'
    call_moments_mode: 'off', // v1.12 — resolved KB_CALL_MOMENTS_MODE for this turn
    exemplars: [],        // v1.11 — past-win exchanges; injected only when exemplar_mode === 'live'
    exemplar_mode: 'off', // v1.11 — resolved KB_EXEMPLAR_MODE for this turn
    estimate_link: estimateEligible // v1.13
      ? { url: getEstimatePdfMergeTag(), requested: estimateRequested }
      : null,
    detected_signals: {
      estimate_link_requested: estimateRequested, // v1.13
      competitor: detectedCompetitor,
      objection: detectedObjection,
      objection_detected_by: objectionDetectedBy,  // v1.10 — 'keyword' | 'semantic' | null
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
      result.faqs = await searchFaqs(messageText, channel, 3, { getQueryEmbedding, intentClass });
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

  // v1.11 — Past-win exemplars. AFTER Tier 1 (so a canonical FAQ/script is
  // already in the pack and wins on facts), BEFORE Tier 2 (approach beats
  // background). Shares the per-turn query embedding. Never blocks a reply.
  const exemplarMode = getKbExemplarMode();
  result.exemplar_mode = exemplarMode;
  if (exemplarMode !== 'off' && shouldRunExemplars(intentClass, messageText)) {
    result.exemplars = await runExemplarTier(messageText, result, exemplarMode, getQueryEmbedding);
  }

  // v1.12 — Call moments. AFTER Tier 1 (facts win), BEFORE Tier 2 (approach
  // beats background). Shares the per-turn query embedding. Never blocks.
  const callMomentsMode = getKbCallMomentsMode();
  result.call_moments_mode = callMomentsMode;
  if (callMomentsMode !== 'off' && shouldRunCallMoments(intentClass, messageText)) {
    result.call_moments = await runCallMomentsTier(messageText, result, callMomentsMode, getQueryEmbedding);
  }

  // v1.9 — Tier 2 vector search over kb_embeddings. Runs AFTER Tier 1 so the
  // 'miss' policy can see whether faqs / objection_script came back empty, and
  // after belief_stack so dedupeVectorMatches() can drop what is already
  // attached verbatim. Additive context; a failure or timeout never blocks.
  const vectorMode = getKbVectorMode();
  result.vector_mode = vectorMode;
  if (vectorMode !== 'off' && messageText && shouldRunVectorSearch(intentClass, result)) {
    result.vector_context = await runVectorTier(messageText, result, vectorMode, getQueryEmbedding);
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

  // v1.13 — ESTIMATE PDF LINK
  if (pack.estimate_link?.url) {
    lines.push('ESTIMATE LINK (this lead completed the online estimate — their PDF is on file):');
    lines.push(`  Estimate link (use VERBATIM as merge tag): ${pack.estimate_link.url}`);
    lines.push('  Whenever your message mentions, offers, resends, or points the lead to their estimate or estimate PDF, put this merge tag on its own line. Never write "here is the link" (or similar) without the merge tag. Never use any other URL for the estimate.');
    if (pack.estimate_link.requested) {
      lines.push('  ⚠️ The lead is asking for their estimate. This message MUST include the estimate link merge tag above.');
    }
    lines.push('');
  } else if (pack.detected_signals?.estimate_link_requested) {
    lines.push('ESTIMATE LINK: The lead is asking about an estimate, but no online estimate is on file for them. Do NOT promise, mention, or invent a link. Say a team member will get it over to them.');
    lines.push('');
  }

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

  // v1.11 — Past wins, live mode only. Placed after PROOF POINTS (facts win)
  // and before Tier 2 excerpts (approach beats background).
  if (pack.exemplar_mode === 'live' && Array.isArray(pack.exemplars) && pack.exemplars.length > 0) {
    const block = formatExemplarsForPrompt(pack.exemplars, { maxChars: KB_EXEMPLAR_MAX_CHARS });
    if (block) {
      lines.push(block);
      lines.push('');
    }
  }

  // v1.12 — Real-call moments, live mode only. After PROOF POINTS (and after
  // PAST WINS if v1.11 is present), before Tier 2 excerpts.
  if (pack.call_moments_mode === 'live' && Array.isArray(pack.call_moments) && pack.call_moments.length > 0) {
    const block = formatCallMomentsForPrompt(pack.call_moments, { maxChars: KB_CALL_MOMENTS_MAX_CHARS });
    if (block) {
      lines.push(block);
      lines.push('');
    }
  }

  // v1.9 — Tier 2 excerpts, live mode only. Background context, never a source
  // of new claims: PROOF POINTS and FAQ MATCHES remain the only citable facts.
  if (pack.vector_mode === 'live' && Array.isArray(pack.vector_context) && pack.vector_context.length > 0) {
    const block = formatMatchesForPrompt(pack.vector_context, { maxChars: KB_VECTOR_MAX_CHARS });
    if (block) {
      lines.push(block);
      lines.push('  (Use these excerpts only to inform framing and tone. Do NOT quote them, do NOT mention any book, author, or document name to the lead, and do NOT introduce stats, prices, or product claims that are not in PROOF POINTS or FAQ MATCHES.)');
      lines.push('');
    }
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
