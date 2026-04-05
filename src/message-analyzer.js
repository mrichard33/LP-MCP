/**
 * Message Analyzer — src/message-analyzer.js
 * 
 * Layer 3 core intelligence. When a lead replies via SMS or email,
 * this module analyzes the message content using Claude to infer:
 * 
 *   - Buyer Journey Stage (1-5 per Antifragile Sales System)
 *   - Objection Classification (price, timing, spouse, trust, competitor, diy)
 *   - Buying Signals (fast-track eligibility per DS#6)
 *   - Emotional State (determines which Story Arc to deploy)
 *   - Engagement Quality (meaningful vs trivial vs DNC)
 * 
 * Output: Structured assessment written to lead_intelligence table
 *         + ai.analysis_completed event emitted for Decision Engine.
 * 
 * Cost controls:
 *   - Skip messages < 3 words (handled by behavioral-emitter)
 *   - Rate limit: ANALYSIS_RATE_LIMIT per hour (default 100)
 *   - Cache: Don't re-analyze same contact within ANALYSIS_CACHE_TTL_MS
 *   - Model: claude-sonnet-4-20250514 (cost-effective)
 */

import { buildLeadContext, upsertLeadIntelligence } from './context-builder.js';
import { emitEvent } from './event-emitter.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANALYSIS_RATE_LIMIT = parseInt(process.env.ANALYSIS_RATE_LIMIT || '100', 10);
const ANALYSIS_CACHE_TTL_MS = parseInt(process.env.ANALYSIS_CACHE_TTL_MS || '3600000', 10);
const MODEL = 'claude-sonnet-4-20250514';

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════

let analysisCount = 0;
let windowStart = Date.now();

function checkRateLimit() {
  const now = Date.now();
  if (now - windowStart > 3600000) {
    analysisCount = 0;
    windowStart = now;
  }
  if (analysisCount >= ANALYSIS_RATE_LIMIT) return false;
  analysisCount++;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// ANALYSIS CACHE
// ═══════════════════════════════════════════════════════════════════

const analysisCache = new Map();

function wasRecentlyAnalyzed(contactId) {
  const last = analysisCache.get(contactId);
  if (!last) return false;
  return (Date.now() - last) < ANALYSIS_CACHE_TTL_MS;
}

function markAnalyzed(contactId) {
  analysisCache.set(contactId, Date.now());
  if (analysisCache.size > 1000) {
    const cutoff = Date.now() - ANALYSIS_CACHE_TTL_MS;
    for (const [key, val] of analysisCache) {
      if (val < cutoff) analysisCache.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// AI SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Antifragile Sales System intelligence engine for Reece Windows & Doors, a hurricane impact window and door company in South Florida.

You analyze inbound lead messages to determine their position in the buyer journey and recommend the optimal next action. You also have access to LeadPerfection CRM data including rep notes, call history, and appointment status — use this to inform your analysis.

RETURN ONLY a valid JSON object — no markdown, no backticks, no explanation outside the JSON.

Required JSON structure:
{
  "buyer_stage": <1-5>,
  "buyer_stage_confidence": <0.0-1.0>,
  "objection_type": <null | "price" | "timing" | "spouse" | "trust" | "competitor" | "diy" | "not-interested">,
  "objection_confidence": <0.0-1.0>,
  "buying_signals": [<string array of detected signals>],
  "emotional_state": <"fear" | "frustration" | "skepticism" | "hope" | "urgency" | "neutral" | "anger">,
  "engagement_quality": <"meaningful" | "neutral" | "disengagement" | "dnc">,
  "fast_track_eligible": <boolean>,
  "recommended_story_arc": <null | "SA1" | "SA2" | "SA3" | "SA4" | "SA5">,
  "recommended_action": <"advance_stage" | "deploy_objection_handler" | "fast_track_booking" | "continue_current" | "escalate_to_rep" | "suppress">,
  "reasoning": "<1-2 sentence explanation>"
}

BUYER JOURNEY STAGES (Antifragile Sales System):
Stage 1 (Indifferent) — Unaware of problem severity. Needs SA1/SA2/SA4.
Stage 2 (Curious) — Aware, exploring. Asks "what" and "how" questions. Needs indoctrination.
Stage 3 (Comparing) — Evaluating options. Asks "how much", compares competitors, requests specifics.
Stage 4 (Negotiating) — Decided but uncommitted. Raises specific objections.
Stage 5 (Committed) — Ready to buy or customer. Asks about scheduling, next steps.

OBJECTION MAPPING:
Price — "too expensive", "can't afford", "cheaper options" → Deploy SA3
Timing — "not now", "next year", "busy season" → Deploy SA4 urgency
Spouse — "need to talk to wife/husband/partner" → Two-decision-maker sequence
Trust — "how do I know", "never heard of you" → Deploy SA2
Competitor — "getting other quotes", "already have someone" → Positioning needed
DIY — "doing it myself", "YouTube", "handyman" → Deploy SA2+SA3

LP DISPOSITION CONTEXT (if available):
Rep notes are critical intelligence — they tell you WHY the lead is at its current status.
Example: "Not ready for rehash or taking a decision" = timing objection, Stage 4
Example: "HC 04/03 6:00PM" = appointment confirmation notation
Example: "Customer called to cancel, going with competitor" = competitor objection

FAST-TRACK SIGNALS (DS#6):
"How soon can you come out?", "Ready to schedule", "Do you do financing?",
"My neighbor used you", specific quantity + pricing questions, high urgency

STORY ARC RECOMMENDATIONS:
SA1 (Hurricane Damage) — fear/vulnerability awareness
SA2 (Code Compliance) — legitimacy/rules/standards questions
SA3 (Cheap Window Regret) — price fixation/cheapest option
SA4 (Insurance Disaster) — insurance/claims/coverage
SA5 (Home Value Increase) — investment/ROI/resale thinking`;

// ═══════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════

async function callClaude(messageText, context) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const contextSummary = buildContextSummary(context);
  const userPrompt = `LEAD CONTEXT:\n${contextSummary}\n\nINBOUND MESSAGE:\n"${messageText}"\n\nAnalyze this message and return the JSON assessment.`;

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
    signal: AbortSignal.timeout(30000),
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

/**
 * Build a concise context summary for the AI prompt.
 * Includes LP CRM data (notes, calls, rep info) for richer analysis.
 */
function buildContextSummary(context) {
  const parts = [];

  if (context.lead) {
    parts.push(`Name: ${context.lead.name}`);
    parts.push(`Entry Source: ${context.lead.entry_source || 'unknown'}`);
    parts.push(`Current Stage Tag: ${context.lead.current_stage_tag || 'none'}`);
    parts.push(`Buyer Journey Tag: ${context.lead.current_bj_tag || 'none'}`);
    parts.push(`Lead Score: ${context.lead.lead_score}`);
    if (context.lead.objection_tags?.length) {
      parts.push(`Known Objections: ${context.lead.objection_tags.join(', ')}`);
    }
  }

  // ─── LeadPerfection CRM Data ───────────────────────────────
  if (context.lp?.matched) {
    parts.push(`\nLP CRM DATA:`);
    parts.push(`LP Disposition: ${context.lp.disposition || 'none'}${context.lp.disposition_label ? ' (' + context.lp.disposition_label + ')' : ''}`);
    if (context.lp.rep_name) parts.push(`Sales Rep: ${context.lp.rep_name}`);
    if (context.lp.promoter_name) parts.push(`Promoter/Canvasser: ${context.lp.promoter_name}`);
    parts.push(`Lead Source: ${context.lp.source || 'unknown'}${context.lp.source_detail ? ' / ' + context.lp.source_detail : ''}`);
    parts.push(`Demo Completed: ${context.lp.demo_completed ? 'YES' : 'no'}`);
    parts.push(`Appointment Set: ${context.lp.appointment_set ? 'YES' : 'no'}${context.lp.appointment_date ? ' — ' + context.lp.appointment_date : ''}`);
    if (context.lp.closed_won) parts.push(`CLOSED WON — Job Value: $${context.lp.job_value || 0}`);
    if (context.lp.call_count) parts.push(`Call Count: ${context.lp.call_count}`);

    // Rep notes — critical intelligence for buyer stage classification
    if (context.lp.notes?.length) {
      const noteLines = context.lp.notes.slice(0, 3).map(n =>
        `  [${n.entered_by}] ${n.text.slice(0, 150)}`
      ).join('\n');
      parts.push(`Rep/System Notes:\n${noteLines}`);
    }

    // Recent call results
    if (context.lp.recent_calls?.length) {
      const callLines = context.lp.recent_calls.slice(0, 3).map(c =>
        `${c.type}: ${c.result} (${c.agent})`
      ).join(', ');
      parts.push(`Recent Calls: ${callLines}`);
    }
  }

  if (context.pipeline) {
    parts.push(`Days in Current Stage: ${context.pipeline.days_in_stage}`);
    parts.push(`Pipeline Status: ${context.pipeline.status || 'unknown'}`);
  }

  if (context.engagement) {
    parts.push(`Emails Opened: ${context.engagement.emails_opened}`);
    parts.push(`Links Clicked: ${context.engagement.links_clicked}`);
    parts.push(`VSL Watched: ${context.engagement.vsl_watched ? 'yes' : 'no'}`);
    parts.push(`Previous Replies: ${context.engagement.replies_count}`);
  }

  if (context.intelligence?.buyer_stage) {
    parts.push(`Previous AI Analysis: Stage ${context.intelligence.buyer_stage} (confidence: ${context.intelligence.buyer_stage_confidence})`);
    if (context.intelligence.objection_type) {
      parts.push(`Previous Objection: ${context.intelligence.objection_type}`);
    }
  }

  if (context.conversation_recent?.length) {
    const recent = context.conversation_recent.slice(-3);
    const convo = recent.map(m => `[${m.direction}] ${m.text?.slice(0, 100) || '(empty)'}`).join('\n');
    parts.push(`\nRecent Conversation:\n${convo}`);
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

function validateAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  return {
    buyer_stage: Math.max(1, Math.min(5, parseInt(analysis.buyer_stage) || 2)),
    buyer_stage_confidence: Math.max(0, Math.min(1, parseFloat(analysis.buyer_stage_confidence) || 0.5)),
    objection_type: ['price', 'timing', 'spouse', 'trust', 'competitor', 'diy', 'not-interested'].includes(analysis.objection_type) ? analysis.objection_type : null,
    objection_confidence: Math.max(0, Math.min(1, parseFloat(analysis.objection_confidence) || 0)),
    buying_signals: Array.isArray(analysis.buying_signals) ? analysis.buying_signals.slice(0, 5) : [],
    emotional_state: ['fear', 'frustration', 'skepticism', 'hope', 'urgency', 'neutral', 'anger'].includes(analysis.emotional_state) ? analysis.emotional_state : 'neutral',
    engagement_quality: ['meaningful', 'neutral', 'disengagement', 'dnc'].includes(analysis.engagement_quality) ? analysis.engagement_quality : 'neutral',
    fast_track_eligible: analysis.fast_track_eligible === true,
    recommended_story_arc: ['SA1', 'SA2', 'SA3', 'SA4', 'SA5'].includes(analysis.recommended_story_arc) ? analysis.recommended_story_arc : null,
    recommended_action: ['advance_stage', 'deploy_objection_handler', 'fast_track_booking', 'continue_current', 'escalate_to_rep', 'suppress'].includes(analysis.recommended_action) ? analysis.recommended_action : 'continue_current',
    reasoning: String(analysis.reasoning || '').slice(0, 500),
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export async function analyzeMessage(ghlContactId, messageText, eventId = null) {
  if (!checkRateLimit()) {
    console.warn(`[MessageAnalyzer] Rate limit reached (${ANALYSIS_RATE_LIMIT}/hr). Skipping ${ghlContactId}`);
    return null;
  }
  if (wasRecentlyAnalyzed(ghlContactId)) {
    console.log(`[MessageAnalyzer] Skipping ${ghlContactId} — analyzed within cache TTL`);
    return null;
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('[MessageAnalyzer] ANTHROPIC_API_KEY not configured — cannot analyze');
    return null;
  }

  const startTime = Date.now();

  try {
    const context = await buildLeadContext(ghlContactId, { includeConversation: true, skipCache: false });
    const rawAnalysis = await callClaude(messageText, context);
    const analysis = validateAnalysis(rawAnalysis);
    if (!analysis) {
      console.error(`[MessageAnalyzer] Invalid analysis response for ${ghlContactId}`);
      return null;
    }

    const historyEntry = {
      timestamp: new Date().toISOString(),
      message_preview: messageText.slice(0, 100),
      buyer_stage: analysis.buyer_stage,
      objection_type: analysis.objection_type,
      engagement_quality: analysis.engagement_quality,
    };

    const existingIntel = context.intelligence;

    await upsertLeadIntelligence(ghlContactId, {
      buyer_stage: analysis.buyer_stage,
      buyer_stage_confidence: analysis.buyer_stage_confidence,
      objection_type: analysis.objection_type,
      objection_confidence: analysis.objection_confidence,
      buying_signals: JSON.stringify(analysis.buying_signals),
      emotional_state: analysis.emotional_state,
      engagement_quality: analysis.engagement_quality,
      fast_track_eligible: analysis.fast_track_eligible,
      recommended_story_arc: analysis.recommended_story_arc,
      recommended_action: analysis.recommended_action,
      ai_reasoning: analysis.reasoning,
      replies_count: (existingIntel?.replies_count || 0) + 1,
      last_reply_at: new Date().toISOString(),
      last_engagement_at: new Date().toISOString(),
      analysis_count: (existingIntel?.analysis_count || 0) + 1,
      last_analysis_at: new Date().toISOString(),
      analysis_history: JSON.stringify(
        [historyEntry, ...(existingIntel?.analysis_history || [])].slice(0, 5)
      ),
      entry_source: context.lead?.entry_source || null,
      current_stage_tag: context.lead?.current_stage_tag || null,
      current_buyer_tag: context.lead?.current_buyer_tag || null,
      lead_score: context.engagement?.lead_score || 0,
      stage_entered_at: context.pipeline?.last_status_change || null,
      days_in_current_stage: context.pipeline?.days_in_stage || 0,
    });

    await emitEvent({
      event_type: 'ai.analysis_completed',
      event_subtype: `stage_${analysis.buyer_stage}`,
      source: 'message_analyzer',
      entity_type: 'contact',
      entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: {
        ...analysis,
        message_preview: messageText.slice(0, 100),
        analysis_duration_ms: Date.now() - startTime,
      },
      priority: analysis.fast_track_eligible ? 'critical' :
                analysis.engagement_quality === 'dnc' ? 'critical' :
                analysis.objection_type ? 'high' : 'normal',
      idempotency_key: `ai_analysis_${ghlContactId}_${Date.now()}`,
    });

    markAnalyzed(ghlContactId);

    const elapsed = Date.now() - startTime;
    console.log(`[MessageAnalyzer] ✅ ${ghlContactId}: Stage ${analysis.buyer_stage} (${analysis.buyer_stage_confidence}), ` +
      `${analysis.objection_type || 'no objection'}, ${analysis.engagement_quality}, ` +
      `fast_track=${analysis.fast_track_eligible} (${elapsed}ms)`);

    return analysis;

  } catch (err) {
    console.error(`[MessageAnalyzer] ❌ Failed for ${ghlContactId}:`, err.message);
    await emitEvent({
      event_type: 'ai.analysis_failed',
      source: 'message_analyzer',
      entity_type: 'contact',
      entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: { error: err.message, message_preview: messageText?.slice(0, 50) },
      priority: 'low',
      idempotency_key: `ai_fail_${ghlContactId}_${Date.now()}`,
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// BATCH ANALYZER
// ═══════════════════════════════════════════════════════════════════

export async function analyzePendingReplies({ limit = 10 } = {}) {
  const { data: events, error } = await (await import('./supabase.js')).default
    .from('system_events')
    .select('*')
    .eq('event_type', 'ghl.reply_received')
    .eq('processed', false)
    .in('event_subtype', ['pending_analysis'])
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error || !events?.length) return { analyzed: 0, skipped: 0, failed: 0 };

  let analyzed = 0, skipped = 0, failed = 0;

  for (const event of events) {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';
    if (!contactId || !messageText) { skipped++; continue; }

    const result = await analyzeMessage(contactId, messageText, event.id);
    if (result) { analyzed++; }
    else if (wasRecentlyAnalyzed(contactId)) { skipped++; }
    else { failed++; }

    await (await import('./supabase.js')).default
      .from('system_events')
      .update({
        processed: true,
        processed_by: 'message_analyzer',
        processed_at: new Date().toISOString(),
        action_taken: result
          ? `ai_analyzed: stage_${result.buyer_stage}, ${result.objection_type || 'no_objection'}`
          : 'skipped_or_failed',
      })
      .eq('id', event.id);
  }

  console.log(`[MessageAnalyzer] Batch complete: ${analyzed} analyzed, ${skipped} skipped, ${failed} failed`);
  return { analyzed, skipped, failed };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerMessageAnalyzerRoutes(app) {
  app.post('/n8n/analyze-pending-replies', async (req, res) => {
    try {
      const limit = req.body?.limit || 10;
      const result = await analyzePendingReplies({ limit });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[MessageAnalyzer] /analyze-pending-replies error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/n8n/analyze-message', async (req, res) => {
    const { contactId, message } = req.body || {};
    if (!contactId || !message) return res.status(400).json({ error: 'contactId and message required' });
    try {
      const result = await analyzeMessage(contactId, message);
      res.json({ success: !!result, analysis: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/n8n/analyzer-status', (req, res) => {
    res.json({
      analyses_this_hour: analysisCount,
      rate_limit: ANALYSIS_RATE_LIMIT,
      remaining: Math.max(0, ANALYSIS_RATE_LIMIT - analysisCount),
      cache_size: analysisCache.size,
      api_key_configured: !!ANTHROPIC_API_KEY,
    });
  });
}
