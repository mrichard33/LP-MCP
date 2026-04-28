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
 *   3. buildKbPack({intent, stage, activeEntry, ...})  ← Phase 3
 *   4. buildResponsePrompt(context, kb_pack)  ← Phase 5 prompt rewrite
 *   5. callClaude(systemPrompt, userPrompt)
 *   6. validate + return
 *
 * Called by: send-message-handler.js when action has requires_ai_generation: true
 *
 * Cost controls:
 *   - Main model: claude-sonnet-4-20250514, max_tokens 600 (slight bump for KB-richer prompts)
 *   - Classifier: claude-haiku-4-5-20251001 (~$0.001 per classification)
 *   - Vector embed (when triggered): text-embedding-3-small (~$0.00001 per query)
 *   - Total per response: ~$0.01-0.015 typical
 *
 * v2.1 — 2026-04-28. Calendar awareness:
 *        Extracts the lead's `active-entry:*` tag from context and passes
 *        it to buildKbPack as activeEntryTag. The kb pack uses this to
 *        pick the right Reece calendar (estimate-calculator → MV calendar,
 *        callbacks → Confirmation Call calendar, default → Window Estimate).
 *        Pairs with kb-retriever v1.1.
 *
 * v2.0 — Phase 1 (compliance gates) + Phase 3 (KB injection) + Phase 5
 *        (Antifragile-hardened SYSTEM_PROMPT) integrated.
 *        Returns either {short_circuit: true, ...handoff} or {short_circuit: false, ...response}.
 *
 * v1.1 — Brand-language fix: NC 1972 / FL 2005 distinction enforced.
 * v1.0 — Initial response generation with Antifragile Sales System prompt.
 */

import { buildLeadContext } from './context-builder.js';
import { classifyInbound, isShortCircuit } from './knowledge/intent-classifier.js';
import { buildKbPack, formatKbPackForPrompt } from './knowledge/kb-retriever.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.RESPONSE_GENERATOR_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = parseInt(process.env.RESPONSE_GENERATOR_MAX_TOKENS || '600', 10);
const TIMEOUT_MS = 30000;

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Antifragile Sales System Response Generation v2.0
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Agentic Responder for Reece Windows & Doors, a hurricane impact window and door company founded in North Carolina in 1972, with Florida operations since 2005, serving South Florida homeowners. Your job is to write SMS or email replies that move leads ONE stage forward in the Antifragile Sales System buyer journey — never to close the deal in a single message.

═══════ VOICE ═══════
- First person plural ("we", "our team") by default — never "I" alone
- Conversational but professional — no slang, no emojis, no exclamation marks
- Sound like a knowledgeable South Florida neighbor who happens to be in the window business — "expert friend" not "salesperson"
- Never say "I understand your concern" or any AI-sounding phrases
- Never mention being automated, AI, or a system
- Never use "just following up" — every message has a PURPOSE
- Always acknowledge what the lead said before pivoting

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
6. If a BOOKING CONTEXT is included, use ITS calendar (the booking_url provided), not a guessed link, and follow its handling guidance ("Skip discovery..." / "Confirm phone...")
7. If COMPETITOR INTEL is included, use talking_point and reece_advantage; respect do_not_attack as hard prohibition

When NO pack is provided, fall back to the story arc summaries below — but stay conservative on specifics.

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
- Include the booking link as PRIMARY CTA, not footer
- Compress to a single decision point: "want me to grab a slot this week?"

═══════ SMS INDEPENDENCE ═══════
SMS messages must be EMOTIONALLY STANDALONE:
- NEVER say "I just sent you an email"
- NEVER summarize an email you sent
- NEVER reference content the lead must check elsewhere to understand
- The SMS earns its own response on its own merits

═══════ BOOKING ESCAPE HATCH ═══════
Every message contains a booking path. Trust level decides positioning:
- L1-L2 (low trust): footer only — "Ready now? Skip ahead: [link]"
- L3 (medium): inline mention — "If you'd rather just see the numbers, here's the calendar: [link]"
- L4-L6 (high): primary CTA — "Want me to grab a time this week?"

If you don't know the trust level, default to L1-L2 (footer).

When a BOOKING CONTEXT is provided in the KB pack, use ITS booking_url (do not invent a different one). The calendar selection is already done for you — just paste the URL.

═══════ OBJECTION HANDLING (NO KB OVERRIDE) ═══════
When a KB OBJECTION SCRIPT is provided, follow it. Otherwise:
- Price → SA3 (cost of cheap) + SA5 (ROI). NEVER defend price directly. NEVER quote numbers.
- Timing → SA4 (cost of waiting) + SA1 (storm season). Gentle time pressure.
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
- Never repeat what an automated workflow already said
- Never ignore what the lead said
- Never send a generic message — every reply must reference their specific situation
- Never use exclamation marks in subject lines
- Never use ALL CAPS in body
- Never use emoji (in any channel)
- Never say "Don't miss out!", "Act now!", "Limited time!"

═══════ CHANNEL CONSTRAINTS ═══════
SMS:   1-3 sentences max. Under 160 chars ideal, 320 max. ONE question max. Booking link as raw URL when included.
Email: 2-4 short paragraphs. 150-400 words. Subject line required (no exclamation). HSO structure visible.

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
// PROMPT BUILDER (v2.0 — KB-aware)
// ═══════════════════════════════════════════════════════════════════

function buildResponsePrompt(context, channel, triggerMessage, kbPack, classification, fastTrack) {
  const parts = [];

  parts.push(`CHANNEL: ${channel.toUpperCase()}`);
  parts.push(channel === 'sms'
    ? 'Constraints: under 160 chars ideal, 320 max. 1-3 sentences. ONE question max. Booking link as raw URL if included.'
    : 'Constraints: 150-400 words. 2-4 short paragraphs. Subject line required.'
  );

  // Classification (always)
  parts.push(`\nCLASSIFICATION: ${classification.intent_class} (${classification.confidence?.toFixed(2) || 'n/a'} confidence, ${classification.classification_method})`);
  if (classification.reasoning) parts.push(`Classifier reasoning: ${classification.reasoning}`);

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

    // v2.4: surface staleness so model can hedge if needed
    if (context.lp.data_stale_active) {
      parts.push(`⚠️ LP data is ${context.lp.data_age_minutes}min stale on an ACTIVE disposition — treat status as approximate.`);
    }

    // v2.0: extended notes (was truncated 250, now 1500)
    if (context.lp.notes?.length) {
      parts.push(`\nLP Rep Notes (most reliable intelligence):`);
      context.lp.notes.slice(0, 5).forEach(n => {
        const by = n.entered_by || 'System';
        parts.push(`  [${by}] ${n.text.slice(0, 1500)}`);
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
  // Phase 3: structured KB pack from kb-retriever takes precedence
  // over fallback story arc summaries in the system prompt.
  if (kbPack) {
    const formatted = formatKbPackForPrompt(kbPack);
    if (formatted) {
      parts.push(`\n═══════ KB PACK (PRIMARY SOURCE — adapt tone, do not invent) ═══════`);
      parts.push(formatted);
      parts.push(`═══════ END KB PACK ═══════`);
    }
  }

  // The trigger message
  parts.push(`\nTHE INBOUND MESSAGE TO RESPOND TO:`);
  parts.push(`"${triggerMessage}"`);

  parts.push(`\nGenerate the ${channel} response. Apply HSO. Move them ONE stage forward. Reference their specific situation. Include a soft next step. If KB pack provided, follow it.`);

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

  return {
    message: parsed.message.trim(),
    channel,
    subject,
    story_arc: storyArc,
    trust_level_targeted: trustLevel,
    hso_breakdown: parsed.hso_breakdown && typeof parsed.hso_breakdown === 'object' ? parsed.hso_breakdown : null,
    voice_used: voice,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
  };
}

// ═══════════════════════════════════════════════════════════════════
// SHORT-CIRCUIT BUILDER
// ═══════════════════════════════════════════════════════════════════

function makeShortCircuitResult(classification, channel, triggerMessage) {
  return {
    short_circuit: true,
    handoff_action: classification.action_type,           // 'tag_and_handoff'
    handoff_tag: classification.ghl_handoff_tag,          // e.g. 'hdl:stop'
    intent_class: classification.intent_class,
    handler_code: classification.handler_code,
    bucket_type: classification.bucket_type,
    is_disqualifier: classification.disqualifier,
    classifier_confidence: classification.confidence,
    classification_method: classification.classification_method,
    reasoning: classification.reasoning,
    channel,
    trigger_message_preview: (triggerMessage || '').slice(0, 200),
    // Empty fields so downstream code that destructures still works:
    message: null,
    subject: null,
    story_arc: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a contextually relevant response for a lead, OR return a
 * short-circuit instruction if the inbound matches a compliance gate.
 *
 * @param {string} contactId — GHL contact ID
 * @param {string} channel — 'sms' or 'email'
 * @param {string} triggerMessage — the inbound message to respond to
 * @returns {Promise<Object>} Response or short-circuit handoff
 */
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
  const buyerStage = inferBuyerStage(context);
  const fastTrack = isHyperactiveBuyer(context);
  const windowCount = inferWindowCount(context);
  const activeEntryTag = extractActiveEntryTag(context);  // v2.1

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
      activeEntryTag,                                       // v2.1: drives calendar selection
    });
  } catch (err) {
    console.warn(`[ResponseGenerator] KB pack build failed for ${contactId}: ${err.message} — proceeding without`);
    kbPack = null;
  }

  // 4-5. PHASE 5: Build prompt + call Claude
  const userPrompt = buildResponsePrompt(context, channel, triggerMessage, kbPack, classification, fastTrack);
  const raw = await callClaude(userPrompt);

  // 6. Validate
  const validated = validateResponse(raw, channel);
  if (!validated) {
    throw new Error('AI response generation failed: invalid response structure');
  }

  console.log(`[ResponseGenerator] Generated ${channel} for ${contactId}: ` +
    `intent=${classification.intent_class} ` +
    `arc=${validated.story_arc} ` +
    `trust=L${validated.trust_level_targeted || '?'} ` +
    `voice=${validated.voice_used} ` +
    `kb_pack=${kbPack ? 'yes' : 'no'} ` +
    `cal=${kbPack?.booking_context?.calendar_name || 'n/a'} ` +
    `fast_track=${fastTrack} ` +
    `(${validated.message.length} chars)`);

  return {
    short_circuit: false,
    intent_class: classification.intent_class,
    classifier_confidence: classification.confidence,
    classification_method: classification.classification_method,
    handler_code: classification.handler_code,
    kb_pack_used: !!kbPack,
    booking_calendar: kbPack?.booking_context?.calendar_name || null,
    fast_track: fastTrack,
    buyer_stage: buyerStage,
    active_entry_tag: activeEntryTag,
    ...validated,
  };
}
