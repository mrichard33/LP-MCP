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
 * v1.2 (2026-04-24) — Cache keyed by message content hash, not contactId.
 *   PROBLEM: v1.1 cached by contactId alone with a 1-hour TTL. Result: if
 *   a contact replied twice within an hour, the second reply was silently
 *   skipped — no re-analysis, no ai.analysis_completed event, and downstream
 *   rules like AGENTIC_RESPOND_POST_CHATBOT never fired. Reply-to-reply
 *   agentic conversation was structurally broken.
 *
 *   FIX: Cache key is now `${contactId}:${sha256(messageText).slice(0,16)}`.
 *   Same exact message within TTL = skipped (webhook retry protection).
 *   Different message anytime = analyzed. TTL shortened from 1h → 2min
 *   because content-hashing made the long window unnecessary and kept
 *   contacts locked out of re-engagement for too long.
 *
 *   Override TTL with env var ANALYSIS_CACHE_TTL_MS if needed.
 * 
 * v1.1 — ACCURACY ENHANCEMENT:
 *   - Enhanced system prompt with explicit instructions to weigh LP notes heavily
 *   - Added CRITICAL ACCURACY RULES to prevent common misclassifications
 *   - Increased LP notes from 3→5 in context summary (8 fetched by context-builder)
 *   - Increased conversation context from 3→5 recent messages
 *   - Added LP disposition context even when LP lead row is missing (GHL custom field fallback)
 *   - Added explicit instructions about distinguishing trust break vs spouse objection
 *   - Added instruction not to classify simple questions as objections
 * 
 * Cost controls:
 *   - Skip messages < 3 words (handled by behavioral-emitter)
 *   - Rate limit: ANALYSIS_RATE_LIMIT per hour (default 100)
 *   - Cache: Don't re-analyze same (contact, message) pair within ANALYSIS_CACHE_TTL_MS
 *   - Model: claude-sonnet-4-20250514 (cost-effective)
 */

import crypto from 'node:crypto';
import { buildLeadContext, upsertLeadIntelligence } from './context-builder.js';
import { emitEvent } from './event-emitter.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANALYSIS_RATE_LIMIT = parseInt(process.env.ANALYSIS_RATE_LIMIT || '100', 10);
// v1.2: default shortened from 3600000 (1h) → 120000 (2min). Content-hash
// keying means the only reason to cache is webhook retry suppression, and
// 2 minutes is more than enough for that. If a customer legitimately sends
// the same identical string twice within 2 min, we still skip (likely retry).
const ANALYSIS_CACHE_TTL_MS = parseInt(process.env.ANALYSIS_CACHE_TTL_MS || '120000', 10);
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
// ANALYSIS CACHE — v1.2: keyed by (contactId, messageHash)
// ═══════════════════════════════════════════════════════════════════

const analysisCache = new Map();

/**
 * Build a cache key that reflects BOTH contact and message content.
 * Hashing the message means:
 *   - duplicate webhook deliveries of the same message → cache hit, skipped
 *   - new message from same contact → different key, always analyzed
 * Takes first 16 hex chars of sha256 — plenty of collision resistance
 * for short-TTL in-memory caching.
 */
function buildCacheKey(contactId, messageText) {
  const msgHash = crypto
    .createHash('sha256')
    .update(String(messageText || ''))
    .digest('hex')
    .slice(0, 16);
  return `${contactId}:${msgHash}`;
}

function wasRecentlyAnalyzed(contactId, messageText) {
  const key = buildCacheKey(contactId, messageText);
  const last = analysisCache.get(key);
  if (!last) return false;
  return (Date.now() - last) < ANALYSIS_CACHE_TTL_MS;
}

function markAnalyzed(contactId, messageText) {
  const key = buildCacheKey(contactId, messageText);
  analysisCache.set(key, Date.now());
  // Periodic cleanup: drop entries older than TTL when the cache grows.
  // Keyed cleanup because entries are now per-(contact, message) rather
  // than per-contact, so the map can grow faster with active conversations.
  if (analysisCache.size > 1000) {
    const cutoff = Date.now() - ANALYSIS_CACHE_TTL_MS;
    for (const [k, v] of analysisCache) {
      if (v < cutoff) analysisCache.delete(k);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// AI SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the Antifragile Sales System intelligence engine for Reece Windows & Doors, a hurricane impact window and door company in South Florida.

You analyze inbound lead messages to determine their position in the buyer journey and recommend the optimal next action.

CRITICAL: You have access to LeadPerfection (LP) CRM data including rep notes, call history, disposition codes, and appointment status. LP NOTES AND DISPOSITION ARE YOUR MOST RELIABLE DATA SOURCE — they come from real sales reps who interacted with the lead in person. Always weigh LP data MORE heavily than the inbound message alone when they conflict.

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
Spouse — "need to talk to wife/husband/partner", ONLY when the lead explicitly says they need their partner to decide. 1Leg LP disposition = demo happened with only one spouse present. This is different from a spouse objection — 1Leg means the demo already ran.
Trust — "how do I know", "never heard of you", company broke a promise, rep didn't follow through → Deploy SA2
Competitor — "getting other quotes", "already have someone", "going with another company" → Positioning needed
DIY — "doing it myself", "YouTube", "handyman" → Deploy SA2+SA3

CRITICAL ACCURACY RULES:
1. DO NOT classify a simple identity question (e.g. "Are you the owner?", "Who is this?") as a trust objection. These are curiosity/verification questions, not expressions of distrust.
2. DO NOT classify a lead as "spouse objection" just because LP shows 1Leg disposition. 1Leg means only one spouse was at the demo — the REAL objection may be price, trust, timing, or something else entirely. Read the rep notes to find the actual reason.
3. When rep notes describe a broken promise (e.g. "promised numbers but never sent"), the objection is TRUST, not spouse, even if the lead mentions their partner.
4. If a lead says "not interested" or "not a fit", check rep notes for WHY before classifying. A trust break (broken promise) masked as "not interested" should be classified as trust.
5. When LP disposition is OPPFDN (Full Demo No Sale) and the lead is in W8.0 (post-demo sequence), classify the objection ONLY if the message explicitly states one. Do not infer objections from short messages — let the post-demo sequence do its job.
6. Set objection_confidence to 0.9+ ONLY when the message explicitly states the objection. For inferred objections, use 0.5-0.7.

LP DISPOSITION CONTEXT:
FDNS = Full Demo, No Sale (demo ran, they said no)
OPPFDN = Full Demo, No Sale (same as FDNS — post-demo state)
BO = Be Back/Follow Up (demo never ran)
1Leg = One spouse present, demo ran but decision deferred
Issue = Lead issued to sales rep (good — means it's being worked)
Set = Appointment scheduled
Cnf = Appointment confirmed
CXL = Appointment cancelled
CCC = Customer called to cancel
NoHome = Rep went to home, nobody there
NoRehash = Rep-requested 7-day hold (believes deal is closing)
DNC = Do Not Contact
Sale = Deal closed
PM = Post-sale/production

LP REP NOTE INTERPRETATION:
Rep notes are the GROUND TRUTH of what happened with the lead. Common patterns:
- "HC [date] [time]" = Homeowner Confirmed for appointment
- "Not ready for rehash" = timing objection, lead needs cooling period
- "Going with competitor" or "getting other quotes" = competitor objection
- "Promised numbers but never sent" or "rep didn't follow through" = TRUST BREAK (not spouse!)
- "Spoke to Ms/Mr and confirmed" = appointment confirmation
- "Both parties present" = spouse objection is NOT relevant
- "Only one party home" = 1Leg situation but read further for the REAL objection

FAST-TRACK SIGNALS (DS#6):
"How soon can you come out?", "Ready to schedule", "Do you do financing?",
"My neighbor used you", specific quantity + pricing questions, high urgency

STORY ARC RECOMMENDATIONS:
SA1 (Hurricane Damage) — fear/vulnerability awareness
SA2 (Code Compliance) — legitimacy/rules/standards/authority questions
SA3 (Cheap Window Regret) — price fixation/cheapest option
SA4 (Insurance Disaster) — insurance/claims/coverage/timing pressure
SA5 (Home Value Increase) — investment/ROI/resale thinking`;

// ═══════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════

async function callClaude(messageText, context) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const contextSummary = buildContextSummary(context);
  const userPrompt = `LEAD CONTEXT:\n${contextSummary}\n\nINBOUND MESSAGE:\n"${messageText}"\n\nAnalyze this message and return the JSON assessment. Remember: LP rep notes and disposition are your most reliable data — weigh them heavily.`;

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
 * v1.1: Enhanced with more LP notes (5), more conversation context (5),
 * and LP disposition fallback from GHL custom fields.
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
    // v1.1: Include suppression tags — they indicate DNC or hold status
    if (context.lead.suppression_tags?.length) {
      parts.push(`Suppression/Hold: ${context.lead.suppression_tags.join(', ')}`);
    }
  }

  // ─── LeadPerfection CRM Data ───────────────────────────────
  if (context.lp?.matched || context.lp?.disposition) {
    parts.push(`\nLP CRM DATA:`);
    parts.push(`LP Disposition: ${context.lp.disposition || 'none'}${context.lp.disposition_label ? ' (' + context.lp.disposition_label + ')' : ''}`);
    if (context.lp.rep_name) parts.push(`Sales Rep: ${context.lp.rep_name}`);
    if (context.lp.promoter_name) parts.push(`Promoter/Canvasser: ${context.lp.promoter_name}`);
    if (context.lp.source) parts.push(`Lead Source: ${context.lp.source}${context.lp.source_detail ? ' / ' + context.lp.source_detail : ''}`);
    parts.push(`Demo Completed: ${context.lp.demo_completed ? 'YES' : 'no'}`);
    parts.push(`Appointment Set: ${context.lp.appointment_set ? 'YES' : 'no'}${context.lp.appointment_date ? ' — ' + context.lp.appointment_date : ''}`);
    if (context.lp.closed_won) parts.push(`CLOSED WON — Job Value: $${context.lp.job_value || 0}`);
    if (context.lp.call_count) parts.push(`Call Count: ${context.lp.call_count}`);

    // v1.1: Show up to 5 LP notes (increased from 3) with full 200-char text
    if (context.lp.notes?.length) {
      parts.push(`\nLP REP/SYSTEM NOTES (read these carefully — they are ground truth):`);
      const noteLines = context.lp.notes.slice(0, 5).map(n => {
        const byLine = n.entered_by ? `[${n.entered_by}]` : '[System]';
        const dateLine = n.date ? ` (${new Date(n.date).toLocaleDateString()})` : '';
        return `  ${byLine}${dateLine} ${n.text.slice(0, 200)}`;
      }).join('\n');
      parts.push(noteLines);
    }

    // Recent call results
    if (context.lp.recent_calls?.length) {
      const callLines = context.lp.recent_calls.slice(0, 5).map(c =>
        `${c.type}: ${c.result} (${c.agent})`
      ).join(', ');
      parts.push(`Recent Calls: ${callLines}`);
    }

    // v2.1 fallback indicator
    if (context.lp._fallback_used) {
      parts.push(`(LP data retrieved via GHL custom field fallback — ghl_contact_id linkage was broken)`);
    }
  } else if (context.lp?._ghl_custom_field_disposition) {
    // v2.1: Minimal LP context from GHL custom fields when LP lead row is completely missing
    parts.push(`\nLP CRM DATA (minimal — from GHL custom fields only):`);
    parts.push(`LP Disposition: ${context.lp._ghl_custom_field_disposition}`);
    parts.push(`(Full LP lead record not available in Supabase — limited context)`);
  }

  if (context.pipeline) {
    parts.push(`\nPIPELINE:`);
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
    if (context.intelligence.ai_reasoning) {
      parts.push(`Previous Reasoning: ${context.intelligence.ai_reasoning.slice(0, 150)}`);
    }
  }

  // v1.1: Show 5 recent conversation messages (increased from 3) with more text
  if (context.conversation_recent?.length) {
    const recent = context.conversation_recent.slice(-5);
    const convo = recent.map(m => `[${m.direction}] ${m.text?.slice(0, 150) || '(empty)'}`).join('\n');
    parts.push(`\nRecent Conversation (most recent last):\n${convo}`);
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
  // v1.2: cache check is now (contact, messageHash) — so a genuinely new
  // reply from the same contact passes even when a prior reply was
  // analyzed recently. Only exact duplicates (webhook retries or copy-
  // pastes) within the short TTL are skipped.
  if (wasRecentlyAnalyzed(ghlContactId, messageText)) {
    console.log(`[MessageAnalyzer] Skipping ${ghlContactId} — identical message already analyzed within ${Math.round(ANALYSIS_CACHE_TTL_MS / 1000)}s (likely retry)`);
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
        lp_data_available: context.lp?.matched || false,
        lp_fallback_used: context.lp?._fallback_used || false,
      },
      priority: analysis.fast_track_eligible ? 'critical' :
                analysis.engagement_quality === 'dnc' ? 'critical' :
                analysis.objection_type ? 'high' : 'normal',
      idempotency_key: `ai_analysis_${ghlContactId}_${Date.now()}`,
    });

    markAnalyzed(ghlContactId, messageText);

    const elapsed = Date.now() - startTime;
    const lpNote = context.lp?.matched ? '(LP✓)' : context.lp?._fallback_used ? '(LP-fallback✓)' : '(no LP)';
    console.log(`[MessageAnalyzer] ✅ ${ghlContactId}: Stage ${analysis.buyer_stage} (${analysis.buyer_stage_confidence}), ` +
      `${analysis.objection_type || 'no objection'}, ${analysis.engagement_quality}, ` +
      `fast_track=${analysis.fast_track_eligible} ${lpNote} (${elapsed}ms)`);

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
    // v1.2: pass messageText to match the new (contact, message) cache key
    else if (wasRecentlyAnalyzed(contactId, messageText)) { skipped++; }
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
      cache_ttl_ms: ANALYSIS_CACHE_TTL_MS,
      api_key_configured: !!ANTHROPIC_API_KEY,
    });
  });
}
