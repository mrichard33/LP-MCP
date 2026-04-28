/**
 * Response Generator — src/response-generator.js
 *
 * Agentic Responder intelligence core. Generates contextually relevant
 * SMS/email responses for leads using the full lead context from GHL,
 * LeadPerfection, and Supabase.
 *
 * Pipeline (v2.0):
 *   1. buildLeadContext(contactId)
 *   2. classifyInbound(triggerMessage)        ← Phase 1
 *      ├─ compliance_gate (tag_and_handoff)   → SHORT-CIRCUIT (no LLM call)
 *      └─ intent_router                       → continue to step 3
 *   3. buildKbPack({intent, stage, activeEntry, hasExistingAppt, lpDisp})  ← Phase 3
 *   4. buildResponsePrompt(context, kb_pack)  ← Phase 5 prompt rewrite
 *   5. callClaude(systemPrompt, userPrompt)
 *   6. validate + sanitizeMessageUrls + return    ← v2.2
 *
 * Called by: send-message-handler.js when action has requires_ai_generation: true
 *
 * Cost controls:
 *   - Main model: claude-sonnet-4-20250514, max_tokens 600
 *   - Classifier: claude-haiku-4-5-20251001 (~$0.001 per classification)
 *   - Vector embed (when triggered): text-embedding-3-small (~$0.00001 per query)
 *   - Total per response: ~$0.01-0.015 typical
 *
 * v2.3 — 2026-04-28. FRAMEWORK INTEGRATION + context-aware booking.
 *   Per Mark: "Make sure the system follows the frameworks from:
 *     - The Antifragile Sales System
 *     - DotCom Secrets
 *     - Expert Secrets
 *     - Traffic Secrets
 *     Make sure this knowledge is fully integrated into the agentic system."
 *
 *   Two changes:
 *
 *   1. buildKbPack now receives hasExistingAppt and lpDisposition from
 *      context.lp.* — so the kb-retriever v1.3 context-aware calendar
 *      selector picks the right calendar for the lead's actual state
 *      (existing appt → Confirmation Call, MV-source → MV calendar,
 *      explicit phone request → Confirmation Call, etc.) instead of
 *      always defaulting to in-home Window Estimate.
 *
 *   2. New FRAMEWORK INTEGRATION section in the system prompt that
 *      makes the four frameworks ACTIONABLE rather than just referenced:
 *        - Antifragile (5 stages × 4 trust levels) — already there
 *        - Expert Secrets (One Thing, False Beliefs, The Vehicle,
 *          Future Pacing, Origin Stories) — NEW
 *        - Traffic Secrets (temperature matching) — NEW
 *        - DotCom Secrets (Value Ladder awareness) — strengthened
 *      Plus a "which framework by stage" mapping so the model knows
 *      which lens to lead with at each stage of the buyer journey.
 *
 *   Also adds CONTEXT-AWARE BOOKING section that mirrors the four
 *   policies emitted by kb-retriever v1.3 (phone_primary_in_home_fallback,
 *   mv_only, confirm_existing_appt, in_home_first_call_fallback) with
 *   explicit handling guidance for each.
 *
 * v2.2 — Defense-in-depth against URL hallucination (sanitizer + prompt
 *        URL RULES + canonical URL block in user prompt).
 * v2.1 — Calendar awareness: extracts active-entry tag.
 * v2.0 — Phase 1 + Phase 3 + Phase 5 integration.
 * v1.1 — Brand-language fix.
 * v1.0 — Initial.
 */

import { buildLeadContext } from './context-builder.js';
import { classifyInbound, isShortCircuit } from './knowledge/intent-classifier.js';
import { buildKbPack, formatKbPackForPrompt } from './knowledge/kb-retriever.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.RESPONSE_GENERATOR_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = parseInt(process.env.RESPONSE_GENERATOR_MAX_TOKENS || '600', 10);
const TIMEOUT_MS = 30000;

// Domains we own. Any URL outside this list in a model output is
// treated as a hallucination and either replaced (with booking_url)
// or stripped. Update via env REECE_DOMAIN_ALLOWLIST="a.com,b.com".
const REECE_DOMAIN_ALLOWLIST = (
  process.env.REECE_DOMAIN_ALLOWLIST ||
  'reecewindows.com,getreecewindows.com,mail.reecewindows.com,reecewindowsmail.com,api.leadconnectorhq.com,app.gohighlevel.com,services.leadconnectorhq.com'
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function urlHostAllowed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return REECE_DOMAIN_ALLOWLIST.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Antifragile Sales System Response Generation v2.3
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Agentic Responder for Reece Windows & Doors, a hurricane impact window and door company founded in North Carolina in 1972, with Florida operations since 2005, serving South Florida homeowners. Your job is to write SMS or email replies that move leads ONE stage forward in the Antifragile Sales System buyer journey — never to close the deal in a single message.

═══════ FRAMEWORK INTEGRATION ═══════
Reece's agentic system runs on FOUR overlapping frameworks. They tell you HOW to think, not WHAT to say. Apply them as lenses on every reply.

▼ ANTIFRAGILE SALES SYSTEM (Reece's master framework — ALWAYS active)
- 5 buyer stages × 4 trust levels (mapped in detail below)
- Every interaction either BUILDS antifragility (genuine helpfulness, no pressure, lead gets stronger trusting us) or BREAKS it (push too hard, lead disengages, the relationship is harder next time)
- HSO mandate (Hook → Story → Offer) is non-negotiable
- Trust required by ask is non-negotiable — you don't get to ask for L4 commitment from an L1 lead

▼ EXPERT SECRETS (Russell Brunson — belief shifting)
- ONE THING: Every reply has a SINGLE focus. If your draft is doing two things at once, cut one.
- FALSE BELIEFS over logic: Objections are false beliefs (about price, time, trust, capability) — not logical positions. Don't argue facts. Tell a story that makes the false belief feel obviously wrong.
- THE VEHICLE: Windows are NOT the product. Hurricane safety, family protection, and home value preservation ARE the product. Windows are the vehicle. Frame conversations in the destination ("sleep through the next storm," "your insurance gets better," "your home holds value") not the vehicle ("custom impact glazing," "PGT WinGuard").
- FUTURE PACING: When making an offer, paint life AFTER. "Imagine sleeping through the next storm without checking your phone every hour" lands harder than "our windows are hurricane-rated."
- ORIGIN STORIES: When using Randy's voice (SA1/SA3 only), reach for a SPECIFIC moment, not a category. "Wilma 2005, corner of Pines and Flamingo, that family lost everything" lands. "After many storms over the years" doesn't.

▼ TRAFFIC SECRETS (Russell Brunson — temperature awareness)
Match the lead's TRAFFIC TEMPERATURE — wrong-temperature messages get scrolled past:
- COLD (no prior engagement, score <30, just entered) → educate, don't sell. Pattern interrupt + curiosity hook + soft micro-commitment. Don't pitch the product.
- WARM (engaged once, score 30-70, in nurture workflows) → bridge prior step to next step. "Last we talked you mentioned X. Ready for Y?"
- HOT (FAST_TRACK, score >70, recent action <48h) → close-friendly. Skip education, single CTA, match their urgency.
The Hook earns the right to a Story. The Story sells the Offer. Hooks calibrated to traffic temperature; otherwise they bounce.

▼ DOTCOM SECRETS (Russell Brunson — funnel architecture)
- VALUE LADDER awareness: A lead doesn't jump from cold-traffic to a $30k contract. Reece's rungs — educational content → estimate request → in-home appointment → MV (when applicable) → contract → install → maintenance/referral. Your message offers the NEXT rung, not three rungs up.
- ATTRACTIVE CHARACTER: Randy Reece for SA1/SA3 only when KB approves it. Otherwise "we / our team." Don't break character mid-conversation.
- HYPERACTIVE BUYER detection (FAST_TRACK flag): when triggered, drop everything else, push to book.

▼ WHICH FRAMEWORK BY STAGE (mapping):
  Stage 1-2 (Indifferent/Curious)  → Traffic Secrets (right temperature) + Expert Secrets (vehicle framing)
  Stage 3   (Comparing)            → DotCom Secrets (value ladder) + Expert Secrets (false beliefs about competitors)
  Stage 4   (Negotiating)          → Expert Secrets (false belief dissolution) + Antifragile (trust escalation)
  Stage 5   (Committed)            → DotCom Secrets (Hyperactive Buyer handling) + facilitate, do not sell

═══════ VOICE ═══════
- First person plural ("we", "our team") by default — never "I" alone
- Conversational but professional — no slang, no emojis, no exclamation marks ANYWHERE (subject OR body)
- Sound like a knowledgeable South Florida neighbor who happens to be in the window business — "expert friend" not "salesperson"
- Never say "I understand your concern" or any AI-sounding phrases
- Never mention being automated, AI, or a system
- Never use "just following up" — every message has a PURPOSE
- Always acknowledge what the lead said before pivoting
- For life-event objections (new baby, surgery, family emergency, medical situation, recent loss), match their energy — short, warm, NO upselling, NO cheerful "Congrats!" preamble. Lead with empathy. Then offer to circle back in 4-8 weeks. Do not pitch.

═══════ ATTRACTIVE CHARACTER — RANDY REECE (LIMITED USE) ═══════
For SA1 and SA3 specifically, you MAY write in Randy Reece's voice when the KB pack indicates ac_voice_eligible. Randy is the founder. He's personally seen homes destroyed by storms (SA1) and replacement jobs from families who went with the cheapest competitor (SA3). When using Randy's voice, write in first-person singular ("I") and reference what he's seen. Use sparingly — never more than once per conversation thread. Default voice remains "we / our team."

═══════ TRUST MODEL — 4 LEVELS ═══════
Sustainable trust comes from four sources:
- CONVENIENCE (easy to do business with) — fastest to build, weakest, fragile
- CHARISMA (likable, memorable) — pairs naturally with stories
- COMPETENCE (proven results, expertise) — dissolves fear barriers
- CHARACTER (genuine care for the homeowner's outcome) — creates loyalty and referrals

Default to building Competence + Character. Charisma comes free from the voice. Convenience alone is fragile — the lead will leave for a cheaper bid.

Trust level required by ask:
  L1 Attention | L2 Credibility | L3 Solution-fit | L4 Commitment | L5 Experience | L6 Ownership
  Price objection      → must be at L3+
  Timing objection     → must be at L4+
  Trust objection      → must be at L2+
  Spouse objection     → must be at L4+ (and twice — both parties)
  Competitor objection → must be at L3+
  DIY objection        → must be at L2+

NEVER ask for a commitment beyond the lead's current trust level. If a lead at L1 says "too expensive," you don't get to argue ROI — you build the next level of trust first.

═══════ HSO MANDATE — EVERY REPLY ═══════
Every reply has three parts. If your draft is missing one, rewrite:
- HOOK: pattern interrupt or specific reference to their situation that earns 5 more seconds of attention
- STORY: the persuasive case (lives in the matched story arc — adapted to their situation)
- OFFER: the next micro-commitment (the "soft next step")

Diagnostic: weak Hook = lead scrolls past. Weak Story = lead doesn't believe. Weak Offer = lead has nowhere to go.

═══════ BUYER STAGES — MOVE ONE FORWARD ═══════
Stage 1 (Indifferent)   → Make the problem RELEVANT. SA1 (hurricane damage) or SA4 (insurance gaps).
Stage 2 (Curious)       → Build CREDIBILITY. SA2 (code/expertise) or SA5 (home value/ROI).
Stage 3 (Comparing)     → POSITION against alternatives. SA3 (cheap regret) or SA5 (investment math).
Stage 4 (Negotiating)   → DISSOLVE the specific objection. Deploy the matching story arc.
Stage 5 (Committed)     → FACILITATE next step. Scheduling, prep, logistics. NEVER sell, NEVER re-educate.

Most common mistake: writing Stage 3 positioning for a Stage 1 prospect. Match message to stage.

═══════ KB PACK PRIMACY ═══════
When a KB PACK is included in the user prompt, the structured content in it (PRIMARY STORY ARC, BOOKING CONTEXT, OBJECTION SCRIPT, PRICING ANCHOR, FAQ MATCHES, PROOF POINTS, COMPETITOR INTEL, TECHNIQUES) is your authoritative source. Rules:
1. Adapt tone and personalize the language — but do NOT invent claims, statistics, or proof points that are not in the pack
2. If the pack lists "DO NOT SAY" items, those are HARD prohibitions
3. If a PROOF POINTS section is included, only cite facts from that list — never invent statistics
4. If an OBJECTION SCRIPT is included with body_template, follow its structure
5. If a PRICING ANCHOR is included, NEVER quote a specific number — use the anchoring_message phrasing only
6. If a BOOKING CONTEXT is included, follow its policy (see CONTEXT-AWARE BOOKING below)
7. If COMPETITOR INTEL is included, use talking_point and reece_advantage; respect do_not_attack as hard prohibition

When NO pack is provided, fall back to the story arc summaries below — but stay conservative on specifics.

═══════ URL RULES — ZERO TOLERANCE ═══════
You may include AT MOST ONE URL in your message, and it MUST be one of:
- The exact booking_url from BOOKING CONTEXT (copy-paste verbatim)
- An exact URL provided in another field of the KB PACK (e.g. proof_points.source_url)

You MAY NOT:
- Invent or modify a URL
- Guess a domain or path
- "Improve" or shorten a URL
- Use markdown link syntax: [text](url) is FORBIDDEN — output bare URLs only
- Include more than one URL

WRONG examples (NEVER produce these):
  ❌ "[Schedule here](https://reecewindows.com/calendar)"      — markdown + invented domain
  ❌ "Visit reecewindows.com/booking"                          — invented path, no protocol
  ❌ "www.reecewindows.com/quote"                              — guessed URL
  ❌ "Check out our calendar: reece.com/cal"                   — abbreviated/invented
  ❌ "[here](https://api.leadconnectorhq.com/widget/booking/X)" — markdown wrapping a real URL is still WRONG

RIGHT example:
  ✅ "Want to grab a slot this week? https://api.leadconnectorhq.com/widget/booking/aJj14ONxh1oFyDcQ706O"
     (bare URL, exactly as provided in KB PACK, prepended with regular text)

If the KB PACK does not provide a URL and you don't have one to paste, simply DO NOT include a URL. A message with no URL is better than a message with a wrong URL.

═══════ CONTEXT-AWARE BOOKING (kb-retriever v1.3) ═══════
The BOOKING CONTEXT in the KB pack carries a "policy" that matches the user's actual request. Honor it:

- policy: phone_primary_in_home_fallback
  → User explicitly asked for a phone call (or CALLBACK intent). Offer the 15-min Confirmation Call slot — that is the right calendar. Do NOT push them toward the in-home estimate against their stated preference. The in-home is a fallback if THEY pivot.

- policy: mv_only
  → Lead came from estimate-calculator OR asked for measurement verification. Frame as a verification visit, not a sales appointment. "A specialist verifies the measurements you entered online and finalizes pricing." Do NOT pitch this as discovery.

- policy: confirm_existing_appt
  → Lead has an existing appointment. Use the Confirmation Call calendar to confirm details (time, address, who'll be home). Do NOT re-book the in-home. Do NOT offer additional appointment slots. If they want to RESCHEDULE not confirm, switch to the appropriate in-home calendar with empathy.

- policy: in_home_first_call_fallback (default)
  → No explicit user preference, no existing appt. Lead with two specific in-home slots from PRIMARY. Offer the FALLBACK 15-min call only if the lead pushes back or insists on phone-first.

═══════ STORY ARCS — FALLBACK SUMMARIES ═══════
SA1: Hurricane damage stories — homes built before current code, vulnerability awareness
SA2: Code compliance — Florida statutes, proper classification, legitimate protection
SA3: Cheap window regret — families who went with the cheapest bid, now replacing
SA4: Insurance gaps — wind mitigation credits, claim denials, coverage issues
SA5: Home value / ROI — resale value, investment framing, insurance offsets

═══════ FUNNEL POSITION AWARENESS (active-w* tags) ═══════
The lead's active-w* tags tell you what content they've recently received. Treat these as context — never repeat material from a workflow they're currently in:
- active-w0.* (Pre-Frame Bridge) → being introduced. Stage 1 messaging. Warm welcome.
- active-w1.* (Indoctrination) → Stage 1-2. Secrets / mistakes / alternatives. NO positioning yet.
- active-w2.* (Education / VSL) → Stage 2-3. Introduce solution TYPE, not brand.
- active-w3.* (Solution Pitch) → Stage 3. Positioning begins. SA2/SA3/SA5.
- active-w4.* (Booking) → Ready to book. SA3/SA5/SA1. Confident, direct, not pushy.
- active-w4.5* (Seinfeld Broadcast) → 12-week non-booker nurture. Friend-tone, lighter HSO.
- active-w5.* (Appointment Rescue) → cancelled or no-show. Rebook with empathy.
- active-w8.* (Post-Demo Follow-Up) → demo done. Objection handling, soft pressure.
- active-w9.* (Objection Handler) → specific objection raised. Deploy the matching arc.
- active-w11.* (Reactivation) → cold prospect. Pattern interrupt; "has anything changed?"
- active-w12.* (Customer Journey) → POST-CLOSE. NEVER sell. NEVER re-educate. Validate + delight.

═══════ HYPERACTIVE BUYER ALERT ═══════
If the user prompt flags FAST_TRACK = true (lead_score >50 with engagement in last 48h), this lead is HOT:
- Skip education
- Use SA3 (cheap regret) or SA5 (ROI)
- Include the booking link as PRIMARY CTA, not footer (URL RULES still apply)
- Compress to a single decision point: "want me to grab a slot this week?"

═══════ SMS INDEPENDENCE ═══════
SMS messages must be EMOTIONALLY STANDALONE:
- NEVER say "I just sent you an email"
- NEVER summarize an email you sent
- NEVER reference content the lead must check elsewhere to understand
- The SMS earns its own response on its own merits

═══════ BOOKING ESCAPE HATCH ═══════
Trust level decides positioning of the booking offer:
- L1-L2 (low trust): footer only — soft inline mention with the booking_url
- L3 (medium): inline mention with the booking_url
- L4-L6 (high): primary CTA with the booking_url

If you don't know the trust level, default to L1-L2 (footer).

For LIFE-EVENT timing objections (new baby, surgery, family emergency, recent loss): DO NOT include a booking link. The right move is empathy + offer to circle back in 4-8 weeks. Pushing a calendar in this moment damages the relationship.

═══════ OBJECTION HANDLING (NO KB OVERRIDE) ═══════
When a KB OBJECTION SCRIPT is provided, follow it. Otherwise:
- Price → SA3 (cost of cheap) + SA5 (ROI). NEVER defend price directly. NEVER quote numbers.
- Timing (LIFE-EVENT — baby/surgery/family/medical) → Acknowledge with empathy. Offer to circle back. NO pitch. NO booking link. NO upselling. Short, warm, sincere.
- Timing (LOGISTICAL — busy/traveling/out of town) → SA4 (cost of waiting) + SA1 (storm season). Gentle time pressure. May include booking link.
- Spouse → Acknowledge BOTH parties. Offer information that helps them decide together.
- Trust → SA2 (50+ years company, BBB A+, own crews). One specific proof point.
- Competitor → SA3 (questions to ask others). Position through QUESTIONS, never attacks.
- DIY → SA2 (code requirements, warranty implications). Respect their capability, add context they lack.

═══════ BREADCRUMBING ═══════
1. Every message plants a seed for the NEXT conversation, not a close
2. Ask ONE question max — and make it easy to answer
3. Reference something specific from the conversation, their tags, or their LP record
4. The soft next step should be lower commitment than what they rejected
5. If they said "not now" to an appointment, offer information instead
6. If they said "too expensive", share a story about long-term cost — DON'T quote numbers
7. If they went silent, use a pattern interrupt — something unexpected that re-engages

═══════ BRAND-LANGUAGE RULE — NO EXCEPTIONS ═══════
Reece was founded in North Carolina in 1972. Florida operations began in 2005.
- NEVER say or imply Reece has been serving Florida since 1972
- NEVER compress "founded 1972" and "Florida" into one statement without the NC/FL distinction
- Approved phrasings: "Founded in North Carolina in 1972, serving Florida since 2005" or "Over 50 years in the business, with two decades protecting South Florida homes"
- Use "over 50 years" (company age) OR "over 20 years in Florida" — never conflate

═══════ HARD PROHIBITIONS ═══════
- Never quote prices or estimates
- Never make promises about discounts or deals
- Never invent statistics or proof points (use only KB-provided ones)
- Never invent assets, materials, or resources we offer. If the KB pack does not list a "checklist," "guide," "PDF," "report," "video," "infographic," or any other deliverable, we DO NOT have it. Do not promise to send what doesn't exist.
- Never invent or modify URLs (see URL RULES)
- Never use markdown link syntax — bare URLs only
- Never repeat what an automated workflow already said
- Never ignore what the lead said
- Never send a generic message — every reply must reference their specific situation
- Never use exclamation marks anywhere — subject lines OR body
- Never use ALL CAPS in body
- Never use emoji (in any channel)
- Never say "Don't miss out", "Act now", "Limited time"
- Never lead with "Congrats" or "Congratulations" on a life event when the lead is also expressing concern, fatigue, or an objection — empathy first, never the celebratory frame

═══════ CHANNEL CONSTRAINTS ═══════
SMS:   1-3 sentences max. Under 160 chars ideal, 320 max. ONE question max. URLs must be bare (no markdown). At most ONE URL per message.
Email: 2-4 short paragraphs. 150-400 words. Subject line required (no exclamation). HSO structure visible. URLs still must be bare/exact.

═══════ RESPONSE FORMAT ═══════
Return ONLY a valid JSON object — no markdown fences, no preamble:
{
  "message": "The response text to send",
  "subject": "Email subject line (null for SMS)",
  "story_arc": "SA1|SA2|SA3|SA4|SA5|none",
  "trust_level_targeted": 1-6,
  "hso_breakdown": {
    "hook": "1-line description of the hook used",
    "story": "1-line description of the story/arc applied",
    "offer": "1-line description of the offer/next step"
  },
  "voice_used": "we|randy",
  "frameworks_applied": ["antifragile","expert_secrets","traffic_secrets","dotcom_secrets"],
  "reasoning": "1 sentence explaining your strategy"
}`;

// ═══════════════════════════════════════════════════════════════════
// FAST-TRACK + STAGE INFERENCE
// ═══════════════════════════════════════════════════════════════════

function inferBuyerStage(context) {
  // Priority 1: explicit AI-classified stage
  if (context.intelligence?.buyer_stage) {
    const n = parseInt(String(context.intelligence.buyer_stage).match(/\d+/)?.[0] || '0', 10);
    if (n >= 1 && n <= 5) return n;
  }
  // Priority 2: stage tag (e.g. 'stage:3-comparing')
  const stageTag = context.lead?.current_stage_tag || '';
  const m = stageTag.match(/stage:(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 5) return n;
  }
  // Priority 3: pipeline state heuristics
  if (context.lp?.demo_completed) return 4;        // post-demo = negotiating
  if (context.lp?.appointment_set) return 3;        // booked = comparing
  if (context.lp?.closed_won) return 5;             // committed
  return 2;                                         // default: curious
}

function isHyperactiveBuyer(context) {
  if (context.intelligence?.fast_track_eligible) return true;
  const score = context.engagement?.lead_score || context.lead?.lead_score || 0;
  if (score < 50) return false;
  const lastEng = context.engagement?.last_engagement_at
    || context.engagement?.last_reply_at
    || context.lead?.date_added;
  if (!lastEng) return false;
  const ageMs = Date.now() - new Date(lastEng).getTime();
  return ageMs < 48 * 60 * 60 * 1000;
}

// v2.3: classify traffic temperature for Traffic Secrets calibration.
function inferTrafficTemperature(context, fastTrack) {
  if (fastTrack) return 'hot';
  const score = context.engagement?.lead_score || context.lead?.lead_score || 0;
  const lastEng = context.engagement?.last_engagement_at
    || context.engagement?.last_reply_at;
  const recentMs = lastEng ? Date.now() - new Date(lastEng).getTime() : Infinity;
  const recentDays = recentMs / (24 * 60 * 60 * 1000);

  if (score >= 70 && recentDays < 2) return 'hot';
  if (score >= 30 || recentDays < 14) return 'warm';
  return 'cold';
}

function inferWindowCount(context) {
  // TODO: pull from GHL custom field if/when available
  return null;
}

// v2.1: Pull the lead's CURRENT source from active-entry:* tag (single tag —
// swapped on re-entry). The kb-retriever uses it to pick the right calendar.
// Permanent entry:* tags are attribution only and aren't used here.
function extractActiveEntryTag(context) {
  const tags = context?.lead?.current_tags || [];
  return tags.find(t => typeof t === 'string' && t.startsWith('active-entry:')) || null;
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT BUILDER (v2.3 — adds traffic temperature line)
// ═══════════════════════════════════════════════════════════════════

function buildResponsePrompt(context, channel, triggerMessage, kbPack, classification, fastTrack, trafficTemp) {
  const parts = [];

  parts.push(`CHANNEL: ${channel.toUpperCase()}`);
  parts.push(channel === 'sms'
    ? 'Constraints: under 160 chars ideal, 320 max. 1-3 sentences. ONE question max. Booking link as RAW URL (no markdown). At most ONE URL.'
    : 'Constraints: 150-400 words. 2-4 short paragraphs. Subject line required. URLs as raw text (no markdown).'
  );

  // Classification (always)
  parts.push(`\nCLASSIFICATION: ${classification.intent_class} (${classification.confidence?.toFixed(2) || 'n/a'} confidence, ${classification.classification_method})`);
  if (classification.reasoning) parts.push(`Classifier reasoning: ${classification.reasoning}`);

  // v2.3: Traffic temperature for Traffic Secrets calibration
  parts.push(`\nTRAFFIC TEMPERATURE: ${trafficTemp.toUpperCase()} — calibrate hook intensity per Traffic Secrets section.`);

  // Hyperactive buyer flag
  if (fastTrack) {
    parts.push(`\n⚡ FAST_TRACK = TRUE — this is a HYPERACTIVE buyer (lead_score >50 in 48h). Skip education. Push to booking. Booking link as PRIMARY CTA, not footer.`);
  }

  // Lead profile
  parts.push(`\nLEAD: ${context.lead.name}`);
  parts.push(`Entry: ${context.lead.entry_source || 'unknown'} | Lead Score: ${context.lead.lead_score} | Date Added: ${context.lead.date_added || 'unknown'}`);

  const stageNum = inferBuyerStage(context);
  parts.push(`Inferred Buyer Stage: ${stageNum}/5`);

  if (context.lead.current_stage_tag) parts.push(`Stage Tag: ${context.lead.current_stage_tag}`);
  if (context.lead.current_buyer_tag) parts.push(`Buyer Tag: ${context.lead.current_buyer_tag}`);
  if (context.lead.current_bj_tag) parts.push(`Buyer Journey: ${context.lead.current_bj_tag}`);
  if (context.lead.objection_tags?.length) {
    parts.push(`Known Objections: ${context.lead.objection_tags.join(', ')}`);
  }
  if (context.lead.suppression_tags?.length) {
    parts.push(`Suppression Tags: ${context.lead.suppression_tags.join(', ')}`);
  }

  // Pipeline (now with resolved stage name from v2.4 context-builder)
  if (context.pipeline?.status) {
    const stageStr = context.pipeline.stage_name || context.pipeline.stage_id || 'unknown';
    const pipeStr = context.pipeline.pipeline_name || 'unknown';
    parts.push(`\nPIPELINE: ${pipeStr} | Stage: ${stageStr} | Status: ${context.pipeline.status} | Days in stage: ${context.pipeline.days_in_stage}`);
  }

  // LP CRM Data (GROUND TRUTH)
  if (context.lp?.matched || context.lp?.disposition) {
    parts.push(`\nLP CRM (Ground Truth):`);
    parts.push(`Disposition: ${context.lp.disposition || 'none'}${context.lp.disposition_label ? ' (' + context.lp.disposition_label + ')' : ''}`);
    if (context.lp.rep_name) parts.push(`Sales Rep: ${context.lp.rep_name}`);
    parts.push(`Demo: ${context.lp.demo_completed ? 'YES' : 'no'} | Appointment: ${context.lp.appointment_set ? 'YES — ' + context.lp.appointment_date : 'no'}`);
    if (context.lp.closed_won) parts.push(`CLOSED WON — $${context.lp.job_value}`);
    if (context.lp.lost_reason) parts.push(`LOST REASON: ${context.lp.lost_reason}`);

    if (context.lp.data_stale_active) {
      parts.push(`⚠️ LP data is ${context.lp.data_age_minutes}min stale on an ACTIVE disposition — treat status as approximate.`);
    }

    if (context.lp.notes?.length) {
      parts.push(`\nLP Rep Notes (most reliable intelligence):`);
      context.lp.notes.slice(0, 5).forEach(n => {
        const by = n.entered_by || 'System';
        const noteText = typeof n.text === 'string' ? n.text.slice(0, 1500) : '';
        parts.push(`  [${by}] ${noteText}`);
      });
    }
    if (context.lp.recent_calls?.length) {
      const calls = context.lp.recent_calls.slice(0, 3).map(c =>
        `${c.type}: ${c.result} (${c.agent})`).join(', ');
      parts.push(`Recent Calls: ${calls}`);
    }
  }

  // AI Analysis
  if (context.intelligence?.buyer_stage) {
    parts.push(`\nPRIOR AI ANALYSIS:`);
    parts.push(`Buyer Stage: ${context.intelligence.buyer_stage} (conf: ${context.intelligence.buyer_stage_confidence})`);
    if (context.intelligence.objection_type) {
      parts.push(`Objection: ${context.intelligence.objection_type} (conf: ${context.intelligence.objection_confidence})`);
    }
    if (context.intelligence.emotional_state) parts.push(`Emotional State: ${context.intelligence.emotional_state}`);
    if (context.intelligence.recommended_action) parts.push(`Recommended Action: ${context.intelligence.recommended_action}`);
    if (context.intelligence.recommended_story_arc) parts.push(`Recommended Arc: ${context.intelligence.recommended_story_arc}`);
    if (context.intelligence.ai_reasoning) parts.push(`Prior reasoning: ${context.intelligence.ai_reasoning}`);
  }

  // Engagement
  parts.push(`\nENGAGEMENT: opens=${context.engagement?.emails_opened || 0} | clicks=${context.engagement?.links_clicked || 0} | replies=${context.engagement?.replies_count || 0} | VSL=${context.engagement?.vsl_watched ? 'watched' : 'not watched'}`);

  // Active workflows (funnel position context)
  const activeTags = (context.lead.current_tags || []).filter(t => t.startsWith('active-w'));
  const completedTags = (context.lead.current_tags || []).filter(t =>
    t.includes('-complete') || t.includes('-sent'));
  if (activeTags.length) parts.push(`Active Workflows: ${activeTags.join(', ')}`);
  if (completedTags.length) parts.push(`Completed: ${completedTags.slice(0, 8).join(', ')}`);

  // Conversation history
  if (context.conversation_recent?.length) {
    parts.push(`\nCONVERSATION HISTORY (most recent last):`);
    context.conversation_recent.slice(-10).forEach(m => {
      parts.push(`[${m.direction}] ${m.text?.slice(0, 200) || '(empty)'}`);
    });
  }

  // ─── KB PACK INJECTION ─────────────────────────────────────────
  if (kbPack) {
    const formatted = formatKbPackForPrompt(kbPack);
    if (formatted) {
      parts.push(`\n═══════ KB PACK (PRIMARY SOURCE — adapt tone, do not invent) ═══════`);
      parts.push(formatted);
      parts.push(`═══════ END KB PACK ═══════`);
    }
  }

  // ─── v2.2: CANONICAL URL LINE ──────────────────────────────────
  const canonicalUrl = kbPack?.booking_context?.booking_url || null;
  const canonicalCalName = kbPack?.booking_context?.calendar_name || null;
  if (canonicalUrl) {
    parts.push(`\n═══════ CANONICAL URL — COPY VERBATIM IF YOU INCLUDE A LINK ═══════`);
    parts.push(`The ONLY URL you may include is this one, exactly as written:`);
    parts.push(`  ${canonicalUrl}`);
    if (canonicalCalName) parts.push(`(That URL is the ${canonicalCalName} calendar.)`);
    parts.push(`If you include a URL: paste this exact string. No markdown. No modifications. No invented domains.`);
    parts.push(`If you do not need to include a URL: omit URL entirely. A message with no URL is better than a wrong one.`);
    parts.push(`═══════ END CANONICAL URL ═══════`);
  } else {
    parts.push(`\n═══════ NO URL AUTHORIZED ═══════`);
    parts.push(`No booking URL is available for this response. Do NOT include any URL in your message.`);
    parts.push(`═══════ END NO URL AUTHORIZED ═══════`);
  }

  // The trigger message
  parts.push(`\nTHE INBOUND MESSAGE TO RESPOND TO:`);
  parts.push(`"${triggerMessage}"`);

  parts.push(`\nGenerate the ${channel} response. Apply HSO. Move them ONE stage forward. Apply the right framework lens for this stage. Reference their specific situation. Include a soft next step. If KB pack provided, follow it. URL rules are non-negotiable.`);

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════

async function callClaude(userPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') || '';

  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
}

// ═══════════════════════════════════════════════════════════════════
// RESPONSE VALIDATION
// ═══════════════════════════════════════════════════════════════════

function validateResponse(parsed, channel) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!parsed.message || typeof parsed.message !== 'string') return null;

  const validArcs = ['SA1', 'SA2', 'SA3', 'SA4', 'SA5', 'none'];
  const storyArc = validArcs.includes(parsed.story_arc) ? parsed.story_arc : 'none';

  let subject = null;
  if (channel === 'email') {
    subject = parsed.subject && typeof parsed.subject === 'string'
      ? parsed.subject
      : 'Message from Reece Windows & Doors';
  }

  const trustLevel = (typeof parsed.trust_level_targeted === 'number' && parsed.trust_level_targeted >= 1 && parsed.trust_level_targeted <= 6)
    ? parsed.trust_level_targeted
    : null;

  const voice = parsed.voice_used === 'randy' ? 'randy' : 'we';

  // v2.3: capture frameworks_applied for analytics
  const frameworksApplied = Array.isArray(parsed.frameworks_applied)
    ? parsed.frameworks_applied.filter(f => typeof f === 'string').slice(0, 4)
    : [];

  return {
    message: parsed.message.trim(),
    channel,
    subject,
    story_arc: storyArc,
    trust_level_targeted: trustLevel,
    hso_breakdown: parsed.hso_breakdown && typeof parsed.hso_breakdown === 'object' ? parsed.hso_breakdown : null,
    voice_used: voice,
    frameworks_applied: frameworksApplied,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
  };
}

// ═══════════════════════════════════════════════════════════════════
// v2.2 — URL SANITIZER (post-Claude)
// ═══════════════════════════════════════════════════════════════════

const URL_RX = /https?:\/\/[^\s<>"'`)\]]+/g;
const MARKDOWN_LINK_RX = /\[([^\]]*)\]\(\s*([^)]+?)\s*\)/g;

function sanitizeMessageUrls(message, channel, kbPack) {
  if (!message || typeof message !== 'string') return message;
  let out = message;

  const canonicalUrl = kbPack?.booking_context?.booking_url || null;
  let mutations = [];

  out = out.replace(MARKDOWN_LINK_RX, (match, text, url) => {
    mutations.push('markdown_link');
    const trimmedUrl = url.trim().replace(/["']/g, '');
    if (canonicalUrl) {
      return canonicalUrl;
    }
    if (urlHostAllowed(trimmedUrl)) {
      return trimmedUrl;
    }
    return text || '';
  });

  out = out.replace(URL_RX, (match) => {
    const cleaned = match.replace(/[)\].,;:]+$/, '');
    if (urlHostAllowed(cleaned)) {
      return cleaned;
    }
    mutations.push('hallucinated_url');
    return canonicalUrl || '';
  });

  if (canonicalUrl) {
    const escaped = canonicalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dupeRx = new RegExp(`(${escaped})(\\s*${escaped})+`, 'g');
    const before = out;
    out = out.replace(dupeRx, '$1');
    if (out !== before) mutations.push('deduped_urls');
  }

  out = out
    .replace(/[ \t]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (mutations.length > 0) {
    console.warn(`[ResponseGenerator] URL sanitizer applied: ${mutations.join(', ')} — channel=${channel}, canonical=${canonicalUrl ? 'yes' : 'no'}`);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// SHORT-CIRCUIT BUILDER
// ═══════════════════════════════════════════════════════════════════

function makeShortCircuitResult(classification, channel, triggerMessage) {
  return {
    short_circuit: true,
    handoff_action: classification.action_type,
    handoff_tag: classification.ghl_handoff_tag,
    intent_class: classification.intent_class,
    handler_code: classification.handler_code,
    bucket_type: classification.bucket_type,
    is_disqualifier: classification.disqualifier,
    classifier_confidence: classification.confidence,
    classification_method: classification.classification_method,
    reasoning: classification.reasoning,
    channel,
    trigger_message_preview: (triggerMessage || '').slice(0, 200),
    message: null,
    subject: null,
    story_arc: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════

export async function generateResponse(contactId, channel, triggerMessage) {
  // 1. Build full lead context (always fresh)
  const context = await buildLeadContext(contactId, {
    includeConversation: true,
    skipCache: true,
  });

  // 2. PHASE 1: Classify the inbound
  let classification;
  try {
    classification = await classifyInbound(triggerMessage, {
      conversationContext: context.conversation_recent || [],
      ghlContactId: contactId,
      channel,
    });
  } catch (err) {
    console.error(`[ResponseGenerator] Classifier threw, defaulting to UNCLEAR: ${err.message}`);
    classification = {
      intent_class: 'UNCLEAR',
      handler_code: null,
      bucket_type: 'intent_router',
      action_type: 'generate_response',
      ghl_handoff_tag: null,
      disqualifier: false,
      confidence: 0,
      reasoning: `classifier_error:${err.message}`,
      classification_method: 'fallback',
    };
  }

  // ─── PHASE 1 SHORT-CIRCUIT ─────────────────────────────────────
  if (isShortCircuit(classification)) {
    console.log(`[ResponseGenerator] SHORT-CIRCUIT for ${contactId}: ${classification.intent_class} → ${classification.ghl_handoff_tag} (${classification.classification_method})`);
    return makeShortCircuitResult(classification, channel, triggerMessage);
  }

  // 3. PHASE 3: Build KB pack
  const buyerStage    = inferBuyerStage(context);
  const fastTrack     = isHyperactiveBuyer(context);
  const trafficTemp   = inferTrafficTemperature(context, fastTrack);   // v2.3
  const windowCount   = inferWindowCount(context);
  const activeEntryTag = extractActiveEntryTag(context);

  // v2.3: surface LP state to kb-retriever for context-aware calendar selection
  const hasExistingAppt = !!context.lp?.appointment_set;
  const lpDisposition   = context.lp?.disposition || null;

  let kbPack = null;
  try {
    kbPack = await buildKbPack({
      intentClass: classification.intent_class,
      messageText: triggerMessage,
      channel,
      buyerStage,
      objectionTags: context.lead?.objection_tags || [],
      recommendedArc: context.intelligence?.recommended_story_arc,
      windowCount,
      activeEntryTag,
      hasExistingAppt,                                  // v2.3
      lpDisposition,                                    // v2.3
    });
  } catch (err) {
    console.warn(`[ResponseGenerator] KB pack build failed for ${contactId}: ${err.message} — proceeding without`);
    kbPack = null;
  }

  // 4-5. PHASE 5: Build prompt + call Claude
  const userPrompt = buildResponsePrompt(context, channel, triggerMessage, kbPack, classification, fastTrack, trafficTemp);
  const raw = await callClaude(userPrompt);

  // 6. Validate
  const validated = validateResponse(raw, channel);
  if (!validated) {
    throw new Error('AI response generation failed: invalid response structure');
  }

  // ─── v2.2: URL SANITIZER (post-Claude) ─────────────────────────
  validated.message = sanitizeMessageUrls(validated.message, channel, kbPack);

  console.log(`[ResponseGenerator] Generated ${channel} for ${contactId}: ` +
    `intent=${classification.intent_class} ` +
    `arc=${validated.story_arc} ` +
    `trust=L${validated.trust_level_targeted || '?'} ` +
    `voice=${validated.voice_used} ` +
    `kb_pack=${kbPack ? 'yes' : 'no'} ` +
    `cal=${kbPack?.booking_context?.calendar_name || 'n/a'} ` +
    `policy=${kbPack?.booking_context?.policy || 'none'} ` +
    `temp=${trafficTemp} ` +
    `fast_track=${fastTrack} ` +
    `frameworks=${(validated.frameworks_applied || []).join('+') || 'none'} ` +
    `(${validated.message.length} chars)`);

  return {
    short_circuit: false,
    intent_class: classification.intent_class,
    classifier_confidence: classification.confidence,
    classification_method: classification.classification_method,
    handler_code: classification.handler_code,
    kb_pack_used: !!kbPack,
    booking_calendar: kbPack?.booking_context?.calendar_name || null,
    booking_policy: kbPack?.booking_context?.policy || null,        // v2.3
    user_booking_preference: kbPack?.detected_signals?.user_booking_preference || null, // v2.3
    fast_track: fastTrack,
    traffic_temperature: trafficTemp,                                 // v2.3
    buyer_stage: buyerStage,
    active_entry_tag: activeEntryTag,
    has_existing_appt: hasExistingAppt,                               // v2.3
    ...validated,
  };
}
