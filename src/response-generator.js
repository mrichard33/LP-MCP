/**
 * Response Generator — src/response-generator.js
 *
 * Agentic Responder intelligence core. Generates contextually relevant
 * SMS/email responses for leads using the full lead context from GHL,
 * LeadPerfection, and Supabase.
 *
 * Uses Claude API to craft messages following the Antifragile Sales System
 * framework — breadcrumbing leads one stage forward in the buyer journey.
 *
 * Architecture:
 *   buildLeadContext(contactId)  →  build response prompt  →  Claude API  →  validate  →  return
 *
 * Called by: send-message-handler.js when action has requires_ai_generation: true
 *
 * Cost controls:
 *   - Model: claude-sonnet-4-20250514 (cost-effective, fast)
 *   - Max tokens: 500 (structured JSON response)
 *   - Rate limiting handled by send-message-handler.js (2h per contact)
 *   - ~500 tokens per response, ~2-4 seconds latency
 *
 * v1.0 — Initial response generation with Antifragile Sales System prompt.
 * v1.1 — Brand-language fix: NC 1972 / FL 2005 distinction enforced.
 */

import { buildLeadContext } from './context-builder.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-4-20250514';
const TIMEOUT_MS = 30000;

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Antifragile Sales System Response Generation
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Agentic Responder for Reece Windows & Doors, a hurricane impact window and door company founded in North Carolina in 1972, with Florida operations since 2005, serving South Florida homeowners.

You write as the company — warm, expert, human. NOT as an AI. NOT as a chatbot. You sound like a knowledgeable neighbor who happens to be in the window business. Think "expert friend" not "salesperson."

VOICE RULES:
- First person plural ("we", "our team") — never "I" alone
- Conversational but professional — no slang, no emojis, no exclamation marks
- Never say "I understand your concern" or any AI-sounding phrases
- Never mention being automated, AI, or a system
- Never use "just following up" — every message has a PURPOSE
- Short for SMS (1-3 sentences max, under 160 chars ideal). Longer for email (2-4 short paragraphs).
- ALWAYS include a soft next step — never leave the lead with nowhere to go

STRATEGIC FRAMEWORK — Antifragile Sales System:
You breadcrumb leads along a 5-stage buyer journey. Your job is to move them ONE stage forward, not to close the deal.

Stage 1 (Indifferent) → Make the problem RELEVANT. Use SA1 (hurricane damage) or SA4 (insurance gaps).
Stage 2 (Curious) → Build CREDIBILITY. Use SA2 (code compliance, expertise) or SA5 (home value/ROI).
Stage 3 (Comparing) → POSITION against alternatives. Use SA3 (cheap window regret) or SA5 (investment math).
Stage 4 (Negotiating) → DISSOLVE the specific objection. Deploy the matching story arc.
Stage 5 (Committed) → FACILITATE the next step. Scheduling, prep, logistics.

STORY ARCS (use ONE per message — the one that matches):
SA1: Hurricane damage stories — "homes built before current code", vulnerability awareness
SA2: Code compliance — Florida statutes, proper classification, legitimate protection
SA3: Cheap window regret — families who went with the cheapest bid, now replacing
SA4: Insurance gaps — wind mitigation credits, claim denials, coverage issues
SA5: Home value increase — ROI, resale value, investment framing

OBJECTION HANDLING:
- Price → SA3 (cost of cheap) + SA5 (investment/ROI). Never defend price directly.
- Timing → SA4 (cost of waiting) + SA1 (hurricane season urgency). Create gentle time pressure.
- Spouse → Acknowledge both parties. Offer information that helps them decide together.
- Trust → SA2 (50+ years, BBB A+, own crews). Share a specific credibility proof point.
- Competitor → SA3 (what to ask other companies). Position through questions, not attacks.
- DIY → SA2 (code requirements, warranty implications). Respect their capability, add context they lack.

BREADCRUMBING RULES:
1. Every message plants a seed for the NEXT conversation, not a close
2. Ask ONE question max — and make it easy to answer
3. Reference something specific from the conversation or their situation
4. The soft next step should be lower commitment than what they rejected
5. If they said "not now" to an appointment, offer information instead
6. If they said "too expensive", share a story about long-term cost, don't quote numbers
7. If they went silent, use a pattern interrupt — something unexpected that re-engages

CRITICAL — BRAND-LANGUAGE RULE (NO EXCEPTIONS):
Reece was founded in North Carolina in 1972. Florida operations began in 2005.
- NEVER say or imply Reece has been serving Florida since 1972
- NEVER compress "founded 1972" and "Florida" into one statement without the NC/FL distinction
- Approved phrasings: "Founded in North Carolina in 1972, serving Florida since 2005" or "Over 50 years in the business, with two decades protecting South Florida homes"
- If referencing company longevity, use "over 50 years" (company age) or "over 20 years in Florida" (FL-specific) — never conflate the two
- This is a character-trust protection rule. Factual precision is part of the sale.

CRITICAL — What NOT to do:
- Never quote prices or estimates in messages
- Never make promises about discounts or deals
- Never be pushy or create false urgency
- Never repeat what an automated sequence already said
- Never ignore what the lead said — ALWAYS acknowledge their message first
- Never send a generic message — every response must reference their specific situation

RESPONSE FORMAT:
Return ONLY a valid JSON object:
{
  "message": "The response text to send",
  "subject": "Email subject line (null for SMS)",
  "story_arc": "SA1|SA2|SA3|SA4|SA5|none",
  "reasoning": "1 sentence explaining your strategy"
}`;

// ═══════════════════════════════════════════════════════════════════
// RESPONSE PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════

function buildResponsePrompt(context, channel, triggerMessage) {
  const parts = [];

  parts.push(`CHANNEL: ${channel.toUpperCase()}`);
  parts.push(`${channel === 'sms' ? 'Keep under 160 characters. 1-3 sentences max.' : 'Short email. 2-4 paragraphs. Include subject line.'}`);

  // Lead profile
  parts.push(`\nLEAD: ${context.lead.name}`);
  parts.push(`Entry Source: ${context.lead.entry_source || 'unknown'}`);
  parts.push(`Lead Score: ${context.lead.lead_score}`);
  parts.push(`Date Added: ${context.lead.date_added || 'unknown'}`);
  parts.push(`Current Stage: ${context.lead.current_stage_tag || 'none'}`);
  parts.push(`Buyer Journey: ${context.lead.current_bj_tag || 'none'}`);
  if (context.lead.objection_tags?.length) {
    parts.push(`Known Objections: ${context.lead.objection_tags.join(', ')}`);
  }

  // Pipeline
  if (context.pipeline?.status) {
    parts.push(`\nPIPELINE: ${context.pipeline.status} | Days in stage: ${context.pipeline.days_in_stage}`);
  }

  // LP CRM Data (GROUND TRUTH)
  if (context.lp?.matched || context.lp?.disposition) {
    parts.push(`\nLP CRM (Ground Truth):`);
    parts.push(`Disposition: ${context.lp.disposition || 'none'}${context.lp.disposition_label ? ' (' + context.lp.disposition_label + ')' : ''}`);
    if (context.lp.rep_name) parts.push(`Sales Rep: ${context.lp.rep_name}`);
    parts.push(`Demo: ${context.lp.demo_completed ? 'YES' : 'no'} | Appointment: ${context.lp.appointment_set ? 'YES — ' + context.lp.appointment_date : 'no'}`);
    if (context.lp.closed_won) parts.push(`CLOSED WON — $${context.lp.job_value}`);

    // LP notes are critical intelligence
    if (context.lp.notes?.length) {
      parts.push(`\nLP Rep Notes (most reliable intelligence):`);
      context.lp.notes.slice(0, 5).forEach(n => {
        const by = n.entered_by || 'System';
        parts.push(`  [${by}] ${n.text.slice(0, 250)}`);
      });
    }
    if (context.lp.recent_calls?.length) {
      const calls = context.lp.recent_calls.slice(0, 3).map(c =>
        `${c.type}: ${c.result} (${c.agent})`).join(', ');
      parts.push(`Recent Calls: ${calls}`);
    }
  }

  // AI Analysis (previous classification)
  if (context.intelligence?.buyer_stage) {
    parts.push(`\nAI ANALYSIS:`);
    parts.push(`Buyer Stage: ${context.intelligence.buyer_stage} (confidence: ${context.intelligence.buyer_stage_confidence})`);
    if (context.intelligence.objection_type) {
      parts.push(`Objection: ${context.intelligence.objection_type} (confidence: ${context.intelligence.objection_confidence})`);
    }
    parts.push(`Emotional State: ${context.intelligence.emotional_state || 'unknown'}`);
    parts.push(`Recommended Action: ${context.intelligence.recommended_action || 'none'}`);
    parts.push(`Recommended Story Arc: ${context.intelligence.recommended_story_arc || 'none'}`);
    if (context.intelligence.ai_reasoning) {
      parts.push(`Analysis Reasoning: ${context.intelligence.ai_reasoning}`);
    }
  }

  // Engagement metrics
  parts.push(`\nENGAGEMENT: Emails opened: ${context.engagement?.emails_opened || 0} | Links clicked: ${context.engagement?.links_clicked || 0} | Replies: ${context.engagement?.replies_count || 0} | VSL: ${context.engagement?.vsl_watched ? 'watched' : 'not watched'}`);

  // Active workflows (what content they've already received)
  const activeTags = (context.lead.current_tags || []).filter(t => t.startsWith('active-w'));
  const completedTags = (context.lead.current_tags || []).filter(t =>
    t.includes('-complete') || t.includes('-sent') || t.includes('education-complete') || t.includes('solution-pitch-complete'));
  if (activeTags.length) parts.push(`Active Workflows: ${activeTags.join(', ')}`);
  if (completedTags.length) parts.push(`Completed: ${completedTags.join(', ')}`);

  // Full conversation history
  if (context.conversation_recent?.length) {
    parts.push(`\nCONVERSATION HISTORY (most recent last):`);
    context.conversation_recent.slice(-10).forEach(m => {
      parts.push(`[${m.direction}] ${m.text?.slice(0, 200) || '(empty)'}`);
    });
  }

  // The trigger message
  parts.push(`\nTHE MESSAGE TO RESPOND TO:`);
  parts.push(`"${triggerMessage}"`);

  parts.push(`\nGenerate the ${channel} response. Remember: breadcrumb one stage forward, reference their specific situation, include a soft next step.`);

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
      max_tokens: 500,
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

  return {
    message: parsed.message.trim(),
    channel,
    subject,
    story_arc: storyArc,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a contextually relevant response for a lead.
 *
 * @param {string} contactId — GHL contact ID
 * @param {string} channel — 'sms' or 'email'
 * @param {string} triggerMessage — the inbound message to respond to
 * @returns {Promise<{message: string, channel: string, subject: string|null, story_arc: string, reasoning: string}>}
 */
export async function generateResponse(contactId, channel, triggerMessage) {
  // 1. Build full lead context (reuse existing context-builder.js)
  const context = await buildLeadContext(contactId, {
    includeConversation: true,
    skipCache: true,  // Always fresh for response generation
  });

  // 2. Build the response generation prompt
  const prompt = buildResponsePrompt(context, channel, triggerMessage);

  // 3. Call Claude API
  const raw = await callClaude(prompt);

  // 4. Validate and return
  const validated = validateResponse(raw, channel);
  if (!validated) {
    throw new Error('AI response generation failed: invalid response structure');
  }

  console.log(`[ResponseGenerator] Generated ${channel} response for ${contactId}: arc=${validated.story_arc}, ${validated.message.length} chars`);

  return validated;
}
