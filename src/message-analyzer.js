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
const ANALYSIS_CACHE_TTL_MS = parseInt(process.env.ANALYSIS_CACHE_TTL_MS || '3600000', 10); // 1 hour
const MODEL = 'claude-sonnet-4-20250514';

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════

let analysisCount = 0;
let windowStart = Date.now();

function checkRateLimit() {
  const now = Date.now();
  if (now - windowStart > 3600000) { // Reset every hour
    analysisCount = 0;
    windowStart = now;
  }
  if (analysisCount >= ANALYSIS_RATE_LIMIT) {
    return false;
  }
  analysisCount++;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// ANALYSIS CACHE (prevent re-analyzing same contact too frequently)
// ═══════════════════════════════════════════════════════════════════

const analysisCache = new Map();

function wasRecentlyAnalyzed(contactId) {
  const last = analysisCache.get(contactId);
  if (!last) return false;
  return (Date.now() - last) < ANALYSIS_CACHE_TTL_MS;
}

function markAnalyzed(contactId) {
  analysisCache.set(contactId, Date.now());
  // Evict old entries
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

You analyze inbound lead messages to determine their position in the buyer journey and recommend the optimal next action.

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
Stage 1 (Indifferent) — Unaware of problem severity. Asks vague questions or doesn't engage with problem framing. Needs SA1/SA2/SA4.
Stage 2 (Curious) — Aware, exploring. Asks "what" and "how" questions about solutions. Needs indoctrination (secrets, mistakes, alternatives).
Stage 3 (Comparing) — Evaluating options. Asks "how much", "how long", compares to competitors, requests specifics. Needs positioning.
Stage 4 (Negotiating) — Decided but uncommitted. Raises specific objections (price, timing, spouse). Needs objection handling.
Stage 5 (Committed) — Ready to buy or already a customer. Asks about scheduling, next steps, installation.

OBJECTION MAPPING (each = specific trust gap):
Price — "too expensive", "can't afford", "cheaper options" → Trust Level L3 gap → Deploy SA3
Timing — "not now", "next year", "busy season" → Trust Level L4 gap → Deploy SA4 urgency
Spouse — "need to talk to wife/husband/partner", "both need to decide" → Trust Level L4×2 gap
Trust — "how do I know", "never heard of you", "are you legit" → Trust Level L2 gap → Deploy SA2
Competitor — "getting other quotes", "already have someone", names a competitor → Trust Level L3 gap
DIY — "doing it myself", "YouTube", "handyman" → Trust Level L2 gap → Deploy SA2+SA3

FAST-TRACK SIGNALS (DS#6 Hyperactive Buyer — skip to booking):
"How soon can you come out?", "When can someone visit?", "Ready to schedule"
"Do you do financing?", "What payment options?"
"My neighbor used you", "Was referred by..."
Specific quantity + pricing questions: "How much for 8 windows?"
High urgency: "Storm coming", "Insurance deadline", "Need this done ASAP"

DISENGAGEMENT SIGNALS:
"Not interested", "Leave me alone", "Wrong number"
One-word negative replies without context
Hostile/aggressive tone without buying intent

STORY ARC RECOMMENDATIONS:
SA1 (Hurricane Damage) — When lead shows fear/vulnerability awareness
SA2 (Code Compliance) — When lead questions legitimacy/rules/standards
SA3 (Cheap Window Regret) — When lead fixates on price/cheapest option
SA4 (Insurance Disaster) — When lead mentions insurance/claims/coverage
SA5 (Home Value Increase) — When lead thinks about investment/ROI/resale`;

// ═══════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════

async function callClaude(messageText, context) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  // Build the user prompt with lead context
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

  // Parse JSON — strip any markdown fencing
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
}

/**
 * Build a concise context summary for the AI prompt.
 * Keep it short to minimize token usage.
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

  if (context.lp?.disposition) {
    parts.push(`LP Disposition: ${context.lp.disposition}`);
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

  // Include last 3 conversation messages for context
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

  // Ensure required fields have valid values
  const valid = {
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

  return valid;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

/**
 * Analyze an inbound message for a given contact.
 * Called by the Decision Engine when processing ghl.reply_received events.
 * 
 * @param {string} ghlContactId — GHL contact ID
 * @param {string} messageText — The inbound message text
 * @param {number} [eventId] — The triggering system event ID
 * @returns {Object} The analysis result, or null on failure
 */
export async function analyzeMessage(ghlContactId, messageText, eventId = null) {
  // ─── Guard: rate limit ─────────────────────────────────
  if (!checkRateLimit()) {
    console.warn(`[MessageAnalyzer] Rate limit reached (${ANALYSIS_RATE_LIMIT}/hr). Skipping ${ghlContactId}`);
    return null;
  }

  // ─── Guard: recently analyzed ──────────────────────────
  if (wasRecentlyAnalyzed(ghlContactId)) {
    console.log(`[MessageAnalyzer] Skipping ${ghlContactId} — analyzed within cache TTL`);
    return null;
  }

  // ─── Guard: API key ────────────────────────────────────
  if (!ANTHROPIC_API_KEY) {
    console.error('[MessageAnalyzer] ANTHROPIC_API_KEY not configured — cannot analyze');
    return null;
  }

  const startTime = Date.now();

  try {
    // 1. Build full lead context
    const context = await buildLeadContext(ghlContactId, { includeConversation: true, skipCache: false });

    // 2. Call Claude API
    const rawAnalysis = await callClaude(messageText, context);

    // 3. Validate the response
    const analysis = validateAnalysis(rawAnalysis);
    if (!analysis) {
      console.error(`[MessageAnalyzer] Invalid analysis response for ${ghlContactId}`);
      return null;
    }

    // 4. Build analysis history entry
    const historyEntry = {
      timestamp: new Date().toISOString(),
      message_preview: messageText.slice(0, 100),
      buyer_stage: analysis.buyer_stage,
      objection_type: analysis.objection_type,
      engagement_quality: analysis.engagement_quality,
    };

    // 5. UPSERT to lead_intelligence
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
      // Keep last 5 analysis history entries
      analysis_history: JSON.stringify(
        [historyEntry, ...(existingIntel?.analysis_history || [])].slice(0, 5)
      ),
      // Mirror current tags from context
      entry_source: context.lead?.entry_source || null,
      current_stage_tag: context.lead?.current_stage_tag || null,
      current_buyer_tag: context.lead?.current_buyer_tag || null,
      // Mirror pipeline + score context (fixes blank fields in lead_intelligence)
      lead_score: context.engagement?.lead_score || 0,
      stage_entered_at: context.pipeline?.last_status_change || null,
      days_in_current_stage: context.pipeline?.days_in_stage || 0,
    });

    // 6. Emit ai.analysis_completed event for Decision Engine
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

    // 7. Mark as recently analyzed
    markAnalyzed(ghlContactId);

    const elapsed = Date.now() - startTime;
    console.log(`[MessageAnalyzer] ✅ ${ghlContactId}: Stage ${analysis.buyer_stage} (${analysis.buyer_stage_confidence}), ` +
      `${analysis.objection_type || 'no objection'}, ${analysis.engagement_quality}, ` +
      `fast_track=${analysis.fast_track_eligible} (${elapsed}ms)`);

    return analysis;

  } catch (err) {
    console.error(`[MessageAnalyzer] ❌ Failed for ${ghlContactId}:`, err.message);

    // Emit failure event so we can track error rates
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
// BATCH ANALYZER (for processing queued pending_analysis events)
// ═══════════════════════════════════════════════════════════════════

/**
 * Process all pending ghl.reply_received events that need AI analysis.
 * Called by n8n heartbeat or manual trigger.
 */
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

  if (error || !events?.length) {
    return { analyzed: 0, skipped: 0, failed: 0 };
  }

  let analyzed = 0, skipped = 0, failed = 0;

  for (const event of events) {
    const contactId = event.ghl_contact_id;
    const messageText = event.payload?.message_text || '';

    if (!contactId || !messageText) {
      skipped++;
      continue;
    }

    const result = await analyzeMessage(contactId, messageText, event.id);

    if (result) {
      analyzed++;
    } else {
      if (wasRecentlyAnalyzed(contactId)) {
        skipped++;
      } else {
        failed++;
      }
    }

    // Mark the reply event as processed (analysis event is separate)
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
  // Process pending reply events
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

  // Manual analysis of a specific message (for testing)
  app.post('/n8n/analyze-message', async (req, res) => {
    const { contactId, message } = req.body || {};
    if (!contactId || !message) {
      return res.status(400).json({ error: 'contactId and message required' });
    }

    try {
      const result = await analyzeMessage(contactId, message);
      res.json({ success: !!result, analysis: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rate limit status
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
