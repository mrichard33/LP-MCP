/**
 * Context Builder — src/context-builder.js
 * 
 * Layer 3 foundation. Assembles the full lead context that the AI Message
 * Analyzer and Contextual Decision Engine need to make strategic decisions.
 * 
 * Queries across:
 *   - GHL API (contact data, tags, lead score, conversations)
 *   - Supabase lead_intelligence (AI analysis history, engagement tracking)
 *   - Supabase lp_leads (LP disposition, prospect ID, appointment data)
 * 
 * Returns a structured context object ready for AI analysis or rule evaluation.
 * 
 * Caching: Per-contact context cached for 5 minutes to avoid hammering GHL API
 * during burst processing (e.g. 1,500 lead release through W0.0).
 */

import supabase from './supabase.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const CONTEXT_CACHE_TTL_MS = parseInt(process.env.CONTEXT_CACHE_TTL_MS || '300000', 10); // 5 min default

// ═══════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE
// ═══════════════════════════════════════════════════════════════════

const contextCache = new Map();

function getCached(contactId) {
  const entry = contextCache.get(contactId);
  if (!entry) return null;
  if (Date.now() - entry.time > CONTEXT_CACHE_TTL_MS) {
    contextCache.delete(contactId);
    return null;
  }
  return entry.data;
}

function setCache(contactId, data) {
  contextCache.set(contactId, { data, time: Date.now() });
  // Evict old entries if cache grows too large (> 500 contacts)
  if (contextCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of contextCache) {
      if (now - val.time > CONTEXT_CACHE_TTL_MS) contextCache.delete(key);
    }
  }
}

/** Force-clear cache for a contact (after a state change) */
export function invalidateContext(contactId) {
  contextCache.delete(contactId);
}

// ═══════════════════════════════════════════════════════════════════
// GHL API HELPERS (native fetch — matches action-executor pattern)
// ═══════════════════════════════════════════════════════════════════

async function ghlFetch(method, path) {
  if (!GHL_API_KEY) return null;
  const url = `https://services.leadconnectorhq.com${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return res.json();
    return null;
  } catch (err) {
    console.error(`[ContextBuilder] GHL ${method} ${path} failed:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch GHL contact by ID — returns name, tags, lead score, custom fields.
 */
async function fetchGHLContact(contactId) {
  const data = await ghlFetch('GET', `/contacts/${contactId}`);
  if (!data?.contact) return null;
  const c = data.contact;
  return {
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || 'Unknown',
    email: c.email || null,
    phone: c.phone || null,
    tags: c.tags || [],
    leadScore: c.leadScore || c.lead_score || 0,
    customFields: c.customFields || c.customField || [],
    dateAdded: c.dateAdded || c.createdAt || null,
  };
}

/**
 * Extract messages array from GHL Conversations API response.
 * The API returns different shapes depending on version/endpoint:
 *   - { messages: [ ... ] }              ← direct array
 *   - { messages: { messages: [ ... ] } } ← nested with pagination
 *   - [ ... ]                             ← raw array
 */
function extractMessages(msgData) {
  if (!msgData) return [];

  // Shape 1: Direct array at top level
  if (Array.isArray(msgData)) return msgData;

  // Shape 2: { messages: [ ... ] } — direct array
  if (Array.isArray(msgData.messages)) return msgData.messages;

  // Shape 3: { messages: { messages: [ ... ] } } — nested with pagination metadata
  if (msgData.messages && typeof msgData.messages === 'object') {
    if (Array.isArray(msgData.messages.messages)) return msgData.messages.messages;
    // Try iterating values — some GHL versions use different key names
    const values = Object.values(msgData.messages);
    const arr = values.find(v => Array.isArray(v));
    if (arr) return arr;
  }

  // Shape 4: { data: [ ... ] }
  if (Array.isArray(msgData.data)) return msgData.data;

  console.warn('[ContextBuilder] Could not extract messages array from GHL response:', JSON.stringify(msgData).slice(0, 200));
  return [];
}

/**
 * Fetch recent conversation messages from GHL Conversations API.
 * Returns last N messages (both inbound and outbound).
 * 
 * Wrapped in try-catch — conversation context is supplementary.
 * If it fails, analysis proceeds without conversation history.
 */
async function fetchConversation(contactId, limit = 10) {
  try {
    // Step 1: Find conversation for this contact
    const searchData = await ghlFetch('GET',
      `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);

    // GHL Conversations API returns array directly or { conversations: [...] }
    const conversations = Array.isArray(searchData) ? searchData : (searchData?.conversations || []);
    if (!conversations.length) return [];

    const conversationId = conversations[0].id;

    // Step 2: Get messages from the conversation
    const msgData = await ghlFetch('GET',
      `/conversations/${conversationId}/messages?limit=${limit}`);

    const messages = extractMessages(msgData);

    return messages.map(m => ({
      direction: m.direction === 1 || m.direction === 'inbound' ? 'inbound' : 'outbound',
      text: m.body || m.message || '',
      type: m.contentType || m.type || 'text',
      timestamp: m.dateAdded || m.createdAt || null,
    })).reverse(); // Oldest first
  } catch (err) {
    console.error(`[ContextBuilder] fetchConversation failed for ${contactId}:`, err.message);
    return []; // Non-fatal — analysis proceeds without conversation history
  }
}

/**
 * Fetch or create lead_intelligence row from Supabase.
 */
async function fetchLeadIntelligence(contactId) {
  const { data, error } = await supabase
    .from('lead_intelligence')
    .select('*')
    .eq('ghl_contact_id', contactId)
    .maybeSingle();

  if (error) {
    console.error(`[ContextBuilder] lead_intelligence fetch error:`, error.message);
    return null;
  }

  return data; // null if no row exists yet — that's fine
}

/**
 * Fetch LP lead data from lp_leads (if GHL contact is matched).
 */
async function fetchLPLead(contactId) {
  const { data, error } = await supabase
    .from('lp_leads')
    .select('id, lead_name, disposition, disposition_date, appointment_date, promoter_name, source_description, created_at_lp, lp_prospect_id')
    .eq('ghl_contact_id', contactId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[ContextBuilder] lp_leads fetch error:`, error.message);
    return null;
  }
  return data;
}

/**
 * Fetch pipeline opportunity data for this contact.
 */
async function fetchOpportunity(contactId) {
  const data = await ghlFetch('GET',
    `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}`);
  const opps = data?.opportunities || [];
  if (!opps.length) return null;

  // Return the most recently updated opportunity
  const sorted = opps.sort((a, b) =>
    new Date(b.updatedAt || b.lastStatusChangeAt || 0) - new Date(a.updatedAt || a.lastStatusChangeAt || 0));

  const opp = sorted[0];
  return {
    id: opp.id,
    pipelineId: opp.pipelineId,
    pipelineStageName: opp.pipelineStageId,
    status: opp.status,
    value: opp.monetaryValue || 0,
    lastStatusChangeAt: opp.lastStatusChangeAt || opp.updatedAt || null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// TAG PARSERS
// ═══════════════════════════════════════════════════════════════════

function parseEntrySource(tags) {
  const entryTag = tags.find(t => t.startsWith('entry:'));
  return entryTag ? entryTag.replace('entry:', '') : null;
}

function parseStageTag(tags) {
  return tags.find(t => t.startsWith('stage:')) || null;
}

function parseBuyerTag(tags) {
  return tags.find(t => t.startsWith('buyer:')) || null;
}

function parseBuyerJourneyTag(tags) {
  return tags.find(t => t.startsWith('bj:')) || null;
}

function parseObjectionTags(tags) {
  return tags
    .filter(t => t.startsWith('objection:') || t.startsWith('objection-confirmed-') || t.startsWith('pre-demo-concern:'))
    .map(t => t.replace('objection:', '').replace('objection-confirmed-', '').replace('pre-demo-concern:', ''));
}

function parseSuppressionTags(tags) {
  return tags.filter(t => t.startsWith('suppress:') || t.startsWith('hold:'));
}

// ═══════════════════════════════════════════════════════════════════
// DAYS IN STAGE CALCULATOR
// ═══════════════════════════════════════════════════════════════════

function calculateDaysInStage(opportunity) {
  if (!opportunity?.lastStatusChangeAt) return 0;
  const changed = new Date(opportunity.lastStatusChangeAt);
  const now = new Date();
  return Math.floor((now - changed) / (1000 * 60 * 60 * 24));
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the full lead context for a given GHL contact ID.
 * Used by:
 *   - message-analyzer.js (AI analysis input)
 *   - decision-engine.js (contextual rule evaluation)
 * 
 * @param {string} ghlContactId
 * @param {Object} [options]
 * @param {boolean} [options.includeConversation=true] — fetch recent messages
 * @param {boolean} [options.skipCache=false] — bypass context cache
 * @returns {Object} Structured context object
 */
export async function buildLeadContext(ghlContactId, options = {}) {
  const { includeConversation = true, skipCache = false } = options;

  // Check cache first
  if (!skipCache) {
    const cached = getCached(ghlContactId);
    if (cached) return cached;
  }

  // Parallel fetch all data sources
  const [ghlContact, intelligence, lpLead, opportunity] = await Promise.all([
    fetchGHLContact(ghlContactId),
    fetchLeadIntelligence(ghlContactId),
    fetchLPLead(ghlContactId),
    fetchOpportunity(ghlContactId),
  ]);

  // Conversation fetch is optional (and slower)
  let conversation = [];
  if (includeConversation && ghlContact) {
    conversation = await fetchConversation(ghlContactId, 10);
  }

  const tags = ghlContact?.tags || [];
  const daysInStage = calculateDaysInStage(opportunity);

  const context = {
    // ─── Lead Identity ───────────────────────────────────────
    lead: {
      ghl_contact_id: ghlContactId,
      name: ghlContact?.name || lpLead?.lead_name || 'Unknown',
      email: ghlContact?.email || null,
      phone: ghlContact?.phone || null,
      entry_source: parseEntrySource(tags) || intelligence?.entry_source || null,
      current_tags: tags,
      current_stage_tag: parseStageTag(tags),
      current_buyer_tag: parseBuyerTag(tags),
      current_bj_tag: parseBuyerJourneyTag(tags),
      objection_tags: parseObjectionTags(tags),
      suppression_tags: parseSuppressionTags(tags),
      lead_score: ghlContact?.leadScore || 0,
      date_added: ghlContact?.dateAdded || null,
    },

    // ─── Pipeline Position ───────────────────────────────────
    pipeline: {
      opportunity_id: opportunity?.id || null,
      pipeline_id: opportunity?.pipelineId || null,
      stage_id: opportunity?.pipelineStageName || null,
      status: opportunity?.status || null,
      value: opportunity?.value || 0,
      days_in_stage: daysInStage,
      last_status_change: opportunity?.lastStatusChangeAt || null,
    },

    // ─── LP Data ─────────────────────────────────────────────
    lp: {
      matched: !!lpLead,
      lead_id: lpLead?.id || null,
      prospect_id: lpLead?.lp_prospect_id || null,
      disposition: lpLead?.disposition || null,
      disposition_date: lpLead?.disposition_date || null,
      appointment_date: lpLead?.appointment_date || null,
      promoter_name: lpLead?.promoter_name || null,
      source_description: lpLead?.source_description || null,
    },

    // ─── Intelligence (AI analysis + engagement) ─────────────
    intelligence: {
      buyer_stage: intelligence?.buyer_stage || null,
      buyer_stage_confidence: intelligence?.buyer_stage_confidence || null,
      objection_type: intelligence?.objection_type || null,
      objection_confidence: intelligence?.objection_confidence || null,
      buying_signals: intelligence?.buying_signals || [],
      emotional_state: intelligence?.emotional_state || null,
      engagement_quality: intelligence?.engagement_quality || null,
      fast_track_eligible: intelligence?.fast_track_eligible || false,
      recommended_story_arc: intelligence?.recommended_story_arc || null,
      recommended_action: intelligence?.recommended_action || null,
      ai_reasoning: intelligence?.ai_reasoning || null,
      analysis_count: intelligence?.analysis_count || 0,
      last_analysis_at: intelligence?.last_analysis_at || null,
    },

    // ─── Engagement Metrics ──────────────────────────────────
    engagement: {
      emails_opened: intelligence?.emails_opened || 0,
      links_clicked: intelligence?.links_clicked || 0,
      vsl_watched: intelligence?.vsl_watched || false,
      vsl_watch_percent: intelligence?.vsl_watch_percent || 0,
      replies_count: intelligence?.replies_count || 0,
      last_reply_at: intelligence?.last_reply_at || null,
      last_engagement_at: intelligence?.last_engagement_at || null,
      lead_score: ghlContact?.leadScore || intelligence?.lead_score || 0,
      lead_score_velocity: intelligence?.lead_score_velocity || 0,
    },

    // ─── Recent Conversation ─────────────────────────────────
    conversation_recent: conversation,

    // ─── Meta ────────────────────────────────────────────────
    meta: {
      context_built_at: new Date().toISOString(),
      data_sources: {
        ghl_contact: !!ghlContact,
        lead_intelligence: !!intelligence,
        lp_lead: !!lpLead,
        opportunity: !!opportunity,
        conversation: conversation.length > 0,
      },
    },
  };

  // Cache the assembled context
  setCache(ghlContactId, context);

  return context;
}

/**
 * UPSERT a lead_intelligence row. Used by message-analyzer.js after AI analysis
 * and by behavioral-emitter.js for engagement signal updates.
 * 
 * @param {string} ghlContactId
 * @param {Object} updates — fields to set/update
 * @returns {Object|null} The upserted row
 */
export async function upsertLeadIntelligence(ghlContactId, updates) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('lead_intelligence')
    .upsert({
      ghl_contact_id: ghlContactId,
      ...updates,
      updated_at: now,
    }, {
      onConflict: 'ghl_contact_id',
    })
    .select()
    .single();

  if (error) {
    console.error(`[ContextBuilder] lead_intelligence upsert error:`, error.message);
    return null;
  }

  // Invalidate context cache after intelligence update
  invalidateContext(ghlContactId);

  return data;
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES (for testing/debugging via API)
// ═══════════════════════════════════════════════════════════════════

export function registerContextBuilderRoutes(app) {
  // Get full lead context — used for debugging and manual inspection
  app.get('/n8n/lead-intelligence/context', async (req, res) => {
    const contactId = req.query.contactId;
    if (!contactId) return res.status(400).json({ error: 'contactId query param required' });

    try {
      const context = await buildLeadContext(contactId, { skipCache: true });
      res.json(context);
    } catch (err) {
      console.error('[ContextBuilder] /context error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Get lead intelligence only (cached Supabase data, no GHL calls)
  app.get('/n8n/lead-intelligence/intelligence', async (req, res) => {
    const contactId = req.query.contactId;
    if (!contactId) return res.status(400).json({ error: 'contactId query param required' });

    try {
      const intel = await fetchLeadIntelligence(contactId);
      res.json(intel || { ghl_contact_id: contactId, status: 'no_intelligence_data' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cache stats
  app.get('/n8n/lead-intelligence/cache-stats', (req, res) => {
    res.json({
      cached_contacts: contextCache.size,
      ttl_ms: CONTEXT_CACHE_TTL_MS,
    });
  });
}
