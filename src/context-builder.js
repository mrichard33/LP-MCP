/**
 * Context Builder — src/context-builder.js
 * 
 * v2.3 — PROSPECT ID AS PRIMARY LP LOOKUP
 * LP Prospect ID is the most reliable identifier — stable, never changes,
 * not affected by the in1_id/lds_id confusion. Now used as the PRIMARY
 * LP lookup path, with ghl_contact_id and lp_lead_id as fallbacks.
 * 
 * LP Lead Resolution Chain:
 *   1. LP Prospect ID from GHL custom field → lp_leads.lp_prospect_id (PRIMARY)
 *   2. lp_leads.ghl_contact_id (fast when linkage exists)
 *   3. LP Lead ID from GHL custom field → lp_leads.lp_lead_id (may have in1_id)
 *   4. LP Disposition from GHL custom field → direct injection (minimal)
 * All successful lookups backfill ghl_contact_id for self-healing.
 * 
 * v2.0 — Notes/calls from normalized lp_notes + lp_call_logs tables.
 */

import supabase from './supabase.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const CONTEXT_CACHE_TTL_MS = parseInt(process.env.CONTEXT_CACHE_TTL_MS || '300000', 10);

// GHL Custom Field IDs
const CF_LP_LEAD_ID = 'GmAVmW6V9sekD7pVONKr';       // May contain in1_id — tertiary fallback
const CF_LP_INBOUND_ID = '3YMxheIlPyhACB8zyc3W';     // LP Inbound Lead ID (temporary, queue only — never use for lookups)
const CF_LP_DISPOSITION = 'ZZCpHTthFMaVc3g5vMAS';     // LP Disposition code
const CF_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87';    // LP Prospect ID — PRIMARY identifier

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
  if (contextCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of contextCache) {
      if (now - val.time > CONTEXT_CACHE_TTL_MS) contextCache.delete(key);
    }
  }
}

export function invalidateContext(contactId) {
  contextCache.delete(contactId);
}

// ═══════════════════════════════════════════════════════════════════
// GHL API HELPERS
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

function getCustomFieldValue(customFields, fieldId) {
  if (!Array.isArray(customFields)) return null;
  const field = customFields.find(f => f.id === fieldId);
  return field?.value || null;
}

// ═══════════════════════════════════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════════════════════════════════

function extractLeadScore(contact) {
  const scoringObj = contact.scoring;
  if (scoringObj && typeof scoringObj === 'object') {
    const scores = Object.values(scoringObj).filter(v => typeof v === 'number');
    if (scores.length > 0) return Math.max(...scores);
  }
  return parseInt(contact.leadScore || contact.lead_score || 0, 10) || 0;
}

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
    leadScore: extractLeadScore(c),
    customFields: c.customFields || c.customField || [],
    dateAdded: c.dateAdded || c.createdAt || null,
  };
}

function extractMessages(msgData) {
  if (!msgData) return [];
  if (Array.isArray(msgData)) return msgData;
  if (Array.isArray(msgData.messages)) return msgData.messages;
  if (msgData.messages && typeof msgData.messages === 'object') {
    if (Array.isArray(msgData.messages.messages)) return msgData.messages.messages;
    const values = Object.values(msgData.messages);
    const arr = values.find(v => Array.isArray(v));
    if (arr) return arr;
  }
  if (Array.isArray(msgData.data)) return msgData.data;
  console.warn('[ContextBuilder] Could not extract messages array:', JSON.stringify(msgData).slice(0, 200));
  return [];
}

async function fetchConversation(contactId, limit = 10) {
  try {
    const searchData = await ghlFetch('GET',
      `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`);
    const conversations = Array.isArray(searchData) ? searchData : (searchData?.conversations || []);
    if (!conversations.length) return [];
    const conversationId = conversations[0].id;
    const msgData = await ghlFetch('GET',
      `/conversations/${conversationId}/messages?limit=${limit}`);
    const messages = extractMessages(msgData);
    return messages.map(m => ({
      direction: m.direction === 1 || m.direction === 'inbound' ? 'inbound' : 'outbound',
      text: m.body || m.message || '',
      type: m.contentType || m.type || 'text',
      timestamp: m.dateAdded || m.createdAt || null,
    })).reverse();
  } catch (err) {
    console.error(`[ContextBuilder] fetchConversation failed for ${contactId}:`, err.message);
    return [];
  }
}

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
  return data;
}

const LP_LEAD_COLUMNS = 'id, lp_lead_id, lp_prospect_id, first_name, last_name, disposition_code, disposition_label, rep_name, promoter_name, lead_source, lead_source_detail, call_count, last_call_date, appointment_set, appointment_date, demo_completed, demo_date, days_to_demo, closed_won, job_value, created_at_lp, ghl_contact_id';

/**
 * Backfill ghl_contact_id on an LP lead row (fire-and-forget).
 * Self-healing: future lookups via ghl_contact_id will work without fallback.
 */
function backfillGhlContactId(lpLeadRow, ghlContactId) {
  if (!lpLeadRow || !ghlContactId || lpLeadRow.ghl_contact_id) return;
  supabase.from('lp_leads')
    .update({ ghl_contact_id: ghlContactId })
    .eq('id', lpLeadRow.id)
    .then(({ error }) => {
      if (error) console.warn(`[ContextBuilder] Backfill failed for LP lead ${lpLeadRow.lp_lead_id}:`, error.message);
      else console.log(`[ContextBuilder] ✅ Backfilled ghl_contact_id ${ghlContactId} → LP lead ${lpLeadRow.lp_lead_id} (prospect ${lpLeadRow.lp_prospect_id})`);
    });
}

/**
 * PRIMARY: LP lead lookup via Prospect ID.
 * Most reliable — Prospect ID is stable, never changes, not affected by in1_id bug.
 * One prospect can have multiple leads — we take the most recently synced one.
 */
async function fetchLPLeadByProspectId(prospectId) {
  if (!prospectId) return null;
  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select(LP_LEAD_COLUMNS)
      .eq('lp_prospect_id', String(prospectId))
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (err) {
    console.error(`[ContextBuilder] lp_leads prospect lookup error:`, err.message);
    return null;
  }
}

/**
 * SECONDARY: LP lead lookup via ghl_contact_id direct linkage.
 * Fast when set correctly, but linkage is often broken (null).
 */
async function fetchLPLeadByGhlContactId(contactId) {
  const { data, error } = await supabase
    .from('lp_leads')
    .select(LP_LEAD_COLUMNS)
    .eq('ghl_contact_id', contactId)
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[ContextBuilder] lp_leads ghl_contact_id lookup error:`, error.message);
    return null;
  }
  return data;
}

/**
 * TERTIARY: LP lead lookup via lp_lead_id from GHL custom field.
 * WARNING: This field may contain an in1_id (inbound queue ID) instead of lds_id.
 */
async function fetchLPLeadByLdsId(lpLeadId) {
  if (!lpLeadId) return null;
  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select(LP_LEAD_COLUMNS)
      .eq('lp_lead_id', String(lpLeadId))
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (err) {
    console.error(`[ContextBuilder] lp_leads lp_lead_id lookup error:`, err.message);
    return null;
  }
}

async function fetchLPNotes(lpLeadId, limit = 8) {
  if (!lpLeadId) return [];
  try {
    const { data, error } = await supabase
      .from('lp_notes')
      .select('note_body, note_category, created_by_rep_name, created_at_lp')
      .eq('lp_lead_id', lpLeadId)
      .not('note_body', 'is', null)
      .order('created_at_lp', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data
      .map(n => ({
        text: (n.note_body || '').trim(),
        category: n.note_category || 'General',
        entered_by: n.created_by_rep_name || '',
        date: n.created_at_lp || '',
      }))
      .filter(n => n.text.length > 0);
  } catch (err) {
    console.warn(`[ContextBuilder] lp_notes fetch failed for ${lpLeadId}:`, err.message);
    return [];
  }
}

async function fetchLPCalls(lpLeadId, limit = 5) {
  if (!lpLeadId) return [];
  try {
    const { data, error } = await supabase
      .from('lp_call_logs')
      .select('call_result, call_direction, rep_name, call_date, lp_lead_id')
      .eq('lp_lead_id', lpLeadId)
      .order('call_date', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.map(c => ({
      result: c.call_result || '',
      type: c.call_direction || '',
      agent: c.rep_name || '',
      date: c.call_date || '',
      phone: '',
    }));
  } catch (err) {
    console.warn(`[ContextBuilder] lp_call_logs fetch failed for ${lpLeadId}:`, err.message);
    return [];
  }
}

async function fetchOpportunity(contactId) {
  const data = await ghlFetch('GET',
    `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}`);
  const opps = data?.opportunities || [];
  if (!opps.length) return null;
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
function parseStageTag(tags) { return tags.find(t => t.startsWith('stage:')) || null; }
function parseBuyerTag(tags) { return tags.find(t => t.startsWith('buyer:')) || null; }
function parseBuyerJourneyTag(tags) { return tags.find(t => t.startsWith('bj:')) || null; }
function parseObjectionTags(tags) {
  return tags
    .filter(t => t.startsWith('objection:') || t.startsWith('objection-confirmed-') || t.startsWith('pre-demo-concern:'))
    .map(t => t.replace('objection:', '').replace('objection-confirmed-', '').replace('pre-demo-concern:', ''));
}
function parseSuppressionTags(tags) { return tags.filter(t => t.startsWith('suppress:') || t.startsWith('hold:')); }

function calculateDaysInStage(opportunity) {
  if (!opportunity?.lastStatusChangeAt) return 0;
  return Math.floor((new Date() - new Date(opportunity.lastStatusChangeAt)) / (1000 * 60 * 60 * 24));
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export async function buildLeadContext(ghlContactId, options = {}) {
  const { includeConversation = true, skipCache = false } = options;

  if (!skipCache) {
    const cached = getCached(ghlContactId);
    if (cached) return cached;
  }

  // Step 1: Fetch GHL contact + intelligence + opportunity in parallel
  const [ghlContact, intelligence, opportunity] = await Promise.all([
    fetchGHLContact(ghlContactId),
    fetchLeadIntelligence(ghlContactId),
    fetchOpportunity(ghlContactId),
  ]);

  // ─── Step 2: LP Lead Resolution Chain ──────────────────────────
  // Priority 1: Prospect ID (most reliable, from GHL custom field)
  // Priority 2: ghl_contact_id direct linkage (fast when set)
  // Priority 3: LP Lead ID from GHL custom field (may be in1_id)
  // Priority 4: Disposition from GHL custom field (minimal)
  
  let lpLead = null;
  let lpResolveMethod = null;
  let ghlCustomFieldDisposition = null;
  
  const cfProspectId = ghlContact?.customFields
    ? getCustomFieldValue(ghlContact.customFields, CF_LP_PROSPECT_ID)
    : null;

  // Priority 1: Prospect ID
  if (cfProspectId) {
    lpLead = await fetchLPLeadByProspectId(cfProspectId);
    if (lpLead) {
      lpResolveMethod = 'prospect_id';
      backfillGhlContactId(lpLead, ghlContactId);
      console.log(`[ContextBuilder] LP resolved via prospect_id=${cfProspectId}: ${lpLead.first_name} ${lpLead.last_name} (${lpLead.disposition_code})`);
    }
  }

  // Priority 2: ghl_contact_id
  if (!lpLead) {
    lpLead = await fetchLPLeadByGhlContactId(ghlContactId);
    if (lpLead) {
      lpResolveMethod = 'ghl_contact_id';
      console.log(`[ContextBuilder] LP resolved via ghl_contact_id: ${lpLead.first_name} ${lpLead.last_name} (${lpLead.disposition_code})`);
    }
  }

  // Priority 3: LP Lead ID from GHL custom field
  if (!lpLead && ghlContact?.customFields) {
    const cfLpLeadId = getCustomFieldValue(ghlContact.customFields, CF_LP_LEAD_ID);
    if (cfLpLeadId) {
      console.log(`[ContextBuilder] LP fallback: trying lp_lead_id=${cfLpLeadId} (may be in1_id)`);
      lpLead = await fetchLPLeadByLdsId(cfLpLeadId);
      if (lpLead) {
        lpResolveMethod = 'lp_lead_id';
        backfillGhlContactId(lpLead, ghlContactId);
        console.log(`[ContextBuilder] LP resolved via lp_lead_id: ${lpLead.first_name} ${lpLead.last_name} (${lpLead.disposition_code})`);
      }
    }
  }

  // Priority 4: Disposition from GHL custom field (minimal — no LP row)
  if (!lpLead && ghlContact?.customFields) {
    ghlCustomFieldDisposition = getCustomFieldValue(ghlContact.customFields, CF_LP_DISPOSITION);
    if (ghlCustomFieldDisposition) {
      lpResolveMethod = 'ghl_custom_field_only';
      console.log(`[ContextBuilder] LP minimal: disposition=${ghlCustomFieldDisposition} from GHL custom field (no Supabase row)`);
    }
  }

  if (!lpLead && !ghlCustomFieldDisposition) {
    console.log(`[ContextBuilder] No LP data found for ${ghlContactId}`);
  }

  // ─── Step 3: Fetch LP notes, calls, and conversation in parallel ───
  const lpLeadId = lpLead?.lp_lead_id || null;
  const [conversation, lpNotes, lpCalls] = await Promise.all([
    (includeConversation && ghlContact) ? fetchConversation(ghlContactId, 10) : [],
    fetchLPNotes(lpLeadId),
    fetchLPCalls(lpLeadId),
  ]);

  const tags = ghlContact?.tags || [];
  const daysInStage = calculateDaysInStage(opportunity);
  const lpName = lpLead ? [lpLead.first_name, lpLead.last_name].filter(Boolean).join(' ') : null;

  const context = {
    lead: {
      ghl_contact_id: ghlContactId,
      name: ghlContact?.name || lpName || 'Unknown',
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

    pipeline: {
      opportunity_id: opportunity?.id || null,
      pipeline_id: opportunity?.pipelineId || null,
      stage_id: opportunity?.pipelineStageName || null,
      status: opportunity?.status || null,
      value: opportunity?.value || 0,
      days_in_stage: daysInStage,
      last_status_change: opportunity?.lastStatusChangeAt || null,
    },

    lp: {
      matched: !!lpLead,
      lead_id: lpLead?.lp_lead_id || null,
      prospect_id: lpLead?.lp_prospect_id || cfProspectId || null,
      disposition: lpLead?.disposition_code || ghlCustomFieldDisposition || null,
      disposition_label: lpLead?.disposition_label || null,
      rep_name: lpLead?.rep_name || null,
      promoter_name: lpLead?.promoter_name || null,
      source: lpLead?.lead_source || null,
      source_detail: lpLead?.lead_source_detail || null,
      appointment_set: lpLead?.appointment_set || false,
      appointment_date: lpLead?.appointment_date || null,
      demo_completed: lpLead?.demo_completed || false,
      demo_date: lpLead?.demo_date || null,
      days_to_demo: lpLead?.days_to_demo || null,
      closed_won: lpLead?.closed_won || false,
      job_value: lpLead?.job_value || null,
      call_count: lpLead?.call_count || 0,
      last_call_date: lpLead?.last_call_date || null,
      notes: lpNotes,
      recent_calls: lpCalls,
      _resolve_method: lpResolveMethod,
      _ghl_custom_field_disposition: ghlCustomFieldDisposition,
    },

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

    conversation_recent: conversation,

    meta: {
      context_built_at: new Date().toISOString(),
      data_sources: {
        ghl_contact: !!ghlContact,
        lead_intelligence: !!intelligence,
        lp_lead: !!lpLead,
        lp_resolve_method: lpResolveMethod,
        lp_notes: lpNotes.length > 0,
        lp_notes_count: lpNotes.length,
        lp_calls: lpCalls.length > 0,
        opportunity: !!opportunity,
        conversation: conversation.length > 0,
      },
    },
  };

  setCache(ghlContactId, context);
  return context;
}

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
  invalidateContext(ghlContactId);
  return data;
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerContextBuilderRoutes(app) {
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

  app.get('/n8n/lead-intelligence/cache-stats', (req, res) => {
    res.json({ cached_contacts: contextCache.size, ttl_ms: CONTEXT_CACHE_TTL_MS });
  });
}
