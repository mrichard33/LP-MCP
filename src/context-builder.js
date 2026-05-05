/**
 * Context Builder — src/context-builder.js
 *
 * v2.6 — 2026-05-05. EXPOSE ESTIMATE TOTAL + WINDOW COUNT for authoritative
 *   money block in AI prompt.
 *
 *   PROBLEM: On contact 7jl9cVfry8OyQF6oI2V5, the agentic responder cited
 *   "$36,000 estimate in their hand" but the actual GHL custom field
 *   `Estimate Total` was $15,775.17. Mark surfaced this as a hallucination
 *   risk: the bot is using data from the prompt to ground replies (good)
 *   but the data it's seeing isn't accurate (bad).
 *
 *   ROOT CAUSE: Only 5 custom fields were extracted into context (LP Lead
 *   ID, LP Inbound ID, LP Disposition, LP Prospect ID, LP Lost Reason).
 *   `Estimate Total` and `Window Count` were never pulled. The AI never
 *   saw the real numbers — it synthesized $36k from an LP rep note that
 *   happened to mention a ballpark figure (lp_notes are dropped verbatim
 *   into the prompt under the "LP Rep Notes (most reliable intelligence)"
 *   header — that label invites the AI to trust them as authoritative).
 *
 *   FIX: Two new custom field constants and a new top-level `estimate`
 *   block on the context object exposing { total, window_count, has_data }.
 *   Both fields are numerically coerced (parseFloat with $/,/whitespace
 *   stripping for total; parseInt for count) and fall back to null on
 *   bad data so we never inject NaN / "undefined" into the AI prompt.
 *
 *   PAIRS WITH:
 *     - response-generator.js v2.7.10 — renders context.estimate as the
 *       "CUSTOMER'S ACTUAL ESTIMATE (AUTHORITATIVE)" block ABOVE LP rep
 *       notes, with explicit usage rules ("use ONLY these numbers if
 *       quoting; default remains do not quote").
 *
 *   No schema changes, no env vars, no rule changes. data_sources audit
 *   gains two booleans (estimate_total_present, window_count_present)
 *   so we can verify the field is actually populated on test contacts
 *   without re-pulling the GHL contact.
 *
 * v2.5 — 2026-04-28. EXPOSE CONTACT ADDRESS FIELDS for booking URL pre-fill.
 *   Per Mark: agentic bot must send GHL trigger links with UTMs AND
 *   pre-filled contact data (fullName, streetAddress, city, state,
 *   postalCode, phone). The bot sends via conversation API where GHL
 *   merge tags do NOT render, so we substitute server-side.
 *
 *   Changes:
 *   - fetchGHLContact() now captures address1, city, state, postalCode
 *     from the GHL contact API response
 *   - context.lead exposes: address1, city, state, postal_code
 *     (snake_case to match other lead fields)
 *
 * v2.4 — Phase 6 freshness hardening (cache TTL, LP staleness, pipeline
 *        stage name resolution, lost reason, untruncated notes).
 * v2.3 — Prospect ID as primary LP lookup.
 * v2.0 — Notes/calls from normalized lp_notes + lp_call_logs tables.
 */

import supabase from './supabase.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const CONTEXT_CACHE_TTL_MS = parseInt(process.env.CONTEXT_CACHE_TTL_MS || '60000', 10);
const LP_DATA_STALE_THRESHOLD_MIN = parseInt(process.env.LP_DATA_STALE_THRESHOLD_MIN || '15', 10);
const PIPELINE_CACHE_TTL_MS = parseInt(process.env.PIPELINE_CACHE_TTL_MS || '900000', 10); // 15 min — pipelines change rarely

// GHL Custom Field IDs
const CF_LP_LEAD_ID = 'GmAVmW6V9sekD7pVONKr';
const CF_LP_INBOUND_ID = '3YMxheIlPyhACB8zyc3W';
const CF_LP_DISPOSITION = 'ZZCpHTthFMaVc3g5vMAS';
const CF_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87';
const CF_LP_LOST_REASON = 'I9CbRV0dKMfwaSlge9uU';

// v2.6: Estimate fields used to build authoritative money block in the
// AI prompt. Without these, the AI inferred dollar amounts from rep
// notes (which are dropped verbatim into the prompt) — causing it to
// quote stale or incorrect figures (e.g. $36,000 from a rep ballpark
// when the actual estimate was $15,775.17). The AI is doing what we
// asked — using the most authoritative-looking signal in context — but
// the actual estimate must outrank rep notes.
const CF_ESTIMATE_TOTAL = 'PqUYMgBojosjSGMBEUqX';   // dollar amount, e.g. "15775.17"
const CF_WINDOW_COUNT   = 'h9FJTUbmUHIuD6JKmpXv';   // integer count, e.g. "12"

// LP dispositions where stale data is high-risk (active deals).
const LP_ACTIVE_DISPOSITIONS = new Set([
  'Issue', 'Data', 'BO', '1Leg', 'NIS', 'NIS2', 'NoHome',
  'CXL', 'PNQ', 'NoRehash', 'FDNS', 'OPPFDN',
]);

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

export function bumpContactCache(contactId) {
  if (!contactId) return;
  contextCache.delete(contactId);
}

// ═══════════════════════════════════════════════════════════════════
// PIPELINE STAGE NAME CACHE
// ═══════════════════════════════════════════════════════════════════

let pipelineCache = null;
let pipelineCacheTime = 0;

async function loadPipelineStages() {
  const now = Date.now();
  if (pipelineCache && (now - pipelineCacheTime) < PIPELINE_CACHE_TTL_MS) {
    return pipelineCache;
  }

  const data = await ghlFetch('GET', `/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
  const pipelines = data?.pipelines || [];
  const stageMap = new Map();
  for (const pipe of pipelines) {
    for (const stage of (pipe.stages || [])) {
      stageMap.set(stage.id, {
        stage_id: stage.id,
        stage_name: stage.name,
        pipeline_id: pipe.id,
        pipeline_name: pipe.name,
      });
    }
  }
  pipelineCache = stageMap;
  pipelineCacheTime = now;
  return stageMap;
}

async function resolvePipelineStage(stageId) {
  if (!stageId) return null;
  const map = await loadPipelineStages();
  return map.get(stageId) || null;
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

// v2.6: numeric coercion helpers for money / count fields. GHL stores
// custom field values as strings (sometimes with $/,/whitespace). Bad
// data → null so we never inject NaN or "undefined" into the AI prompt.
function coerceMoney(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function coerceCount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/[^0-9.-]/g, '');
  const num = parseInt(cleaned, 10);
  return Number.isFinite(num) && num >= 0 ? num : null;
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
    firstName: c.firstName || null,
    lastName: c.lastName || null,
    email: c.email || null,
    phone: c.phone || null,
    // v2.5: address fields for booking URL pre-fill
    address1: c.address1 || null,
    city: c.city || null,
    state: c.state || null,
    postalCode: c.postalCode || c.postal_code || null,
    country: c.country || null,
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

const LP_LEAD_COLUMNS = 'id, lp_lead_id, lp_prospect_id, first_name, last_name, disposition_code, disposition_label, rep_name, promoter_name, lead_source, lead_source_detail, call_count, last_call_date, appointment_set, appointment_date, demo_completed, demo_date, days_to_demo, closed_won, job_value, created_at_lp, ghl_contact_id, synced_at';

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
    pipelineStageId: opp.pipelineStageId,
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

function calcLpStaleness(lpLead) {
  if (!lpLead?.synced_at) {
    return { ageMinutes: null, isStale: false, isStaleActive: false };
  }
  const ageMs = Date.now() - new Date(lpLead.synced_at).getTime();
  const ageMin = Math.floor(ageMs / 60000);
  const stale = ageMin >= LP_DATA_STALE_THRESHOLD_MIN;
  const stalActive = stale && LP_ACTIVE_DISPOSITIONS.has(lpLead.disposition_code);
  return { ageMinutes: ageMin, isStale: stale, isStaleActive: stalActive };
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

  const [ghlContact, intelligence, opportunity] = await Promise.all([
    fetchGHLContact(ghlContactId),
    fetchLeadIntelligence(ghlContactId),
    fetchOpportunity(ghlContactId),
  ]);

  // ─── Step 2: LP Lead Resolution Chain ──────────────────────────
  let lpLead = null;
  let lpResolveMethod = null;
  let ghlCustomFieldDisposition = null;
  let ghlCustomFieldLostReason = null;

  const cfProspectId = ghlContact?.customFields
    ? getCustomFieldValue(ghlContact.customFields, CF_LP_PROSPECT_ID)
    : null;

  if (ghlContact?.customFields) {
    ghlCustomFieldLostReason = getCustomFieldValue(ghlContact.customFields, CF_LP_LOST_REASON);
  }

  // v2.6: Estimate fields. Pulled here so they're available to both the
  // context return AND any future synthetic-note injection paths. coerceMoney
  // / coerceCount handle GHL's string-typed custom fields and bad data.
  const cfEstimateTotalRaw = ghlContact?.customFields
    ? getCustomFieldValue(ghlContact.customFields, CF_ESTIMATE_TOTAL)
    : null;
  const cfWindowCountRaw = ghlContact?.customFields
    ? getCustomFieldValue(ghlContact.customFields, CF_WINDOW_COUNT)
    : null;
  const estimateTotal = coerceMoney(cfEstimateTotalRaw);
  const windowCount = coerceCount(cfWindowCountRaw);

  if (cfProspectId) {
    lpLead = await fetchLPLeadByProspectId(cfProspectId);
    if (lpLead) {
      lpResolveMethod = 'prospect_id';
      backfillGhlContactId(lpLead, ghlContactId);
      console.log(`[ContextBuilder] LP resolved via prospect_id=${cfProspectId}: ${lpLead.first_name} ${lpLead.last_name} (${lpLead.disposition_code})`);
    }
  }

  if (!lpLead) {
    lpLead = await fetchLPLeadByGhlContactId(ghlContactId);
    if (lpLead) {
      lpResolveMethod = 'ghl_contact_id';
      console.log(`[ContextBuilder] LP resolved via ghl_contact_id: ${lpLead.first_name} ${lpLead.last_name} (${lpLead.disposition_code})`);
    }
  }

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

  const lpLeadId = lpLead?.lp_lead_id || null;
  const [conversation, lpNotes, lpCalls, pipelineStageInfo] = await Promise.all([
    (includeConversation && ghlContact) ? fetchConversation(ghlContactId, 10) : [],
    fetchLPNotes(lpLeadId),
    fetchLPCalls(lpLeadId),
    opportunity?.pipelineStageId ? resolvePipelineStage(opportunity.pipelineStageId) : null,
  ]);

  const tags = ghlContact?.tags || [];
  const daysInStage = calculateDaysInStage(opportunity);
  const lpName = lpLead ? [lpLead.first_name, lpLead.last_name].filter(Boolean).join(' ') : null;
  const staleness = calcLpStaleness(lpLead);

  const context = {
    lead: {
      ghl_contact_id: ghlContactId,
      name: ghlContact?.name || lpName || 'Unknown',
      first_name: ghlContact?.firstName || lpLead?.first_name || null,    // v2.5
      last_name: ghlContact?.lastName || lpLead?.last_name || null,        // v2.5
      email: ghlContact?.email || null,
      phone: ghlContact?.phone || null,
      // v2.5: address fields for booking URL pre-fill
      address1: ghlContact?.address1 || null,
      city: ghlContact?.city || null,
      state: ghlContact?.state || null,
      postal_code: ghlContact?.postalCode || null,
      country: ghlContact?.country || null,
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
      pipeline_name: pipelineStageInfo?.pipeline_name || null,
      stage_id: opportunity?.pipelineStageId || null,
      stage_name: pipelineStageInfo?.stage_name || null,
      status: opportunity?.status || null,
      value: opportunity?.value || 0,
      days_in_stage: daysInStage,
      last_status_change: opportunity?.lastStatusChangeAt || null,
    },

    // v2.6: New top-level estimate block. Contains ONLY the customer's
    // actual estimate as recorded in GHL custom fields. Distinct from
    // pipeline.value (opp monetaryValue) and lp.job_value (LP closed-won
    // amount) — those represent different concepts and are the wrong
    // signals to use as a "what we quoted" reference.
    //
    // has_data: true when at least one field has a valid numeric value.
    // The response-generator uses this to decide whether to render the
    // AUTHORITATIVE block.
    estimate: {
      total: estimateTotal,
      window_count: windowCount,
      has_data: estimateTotal !== null || windowCount !== null,
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
      lost_reason: ghlCustomFieldLostReason || null,
      notes: lpNotes,
      recent_calls: lpCalls,
      synced_at: lpLead?.synced_at || null,
      data_age_minutes: staleness.ageMinutes,
      data_stale: staleness.isStale,
      data_stale_active: staleness.isStaleActive,
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
      context_builder_version: '2.6',
      cache_ttl_ms: CONTEXT_CACHE_TTL_MS,
      data_sources: {
        ghl_contact: !!ghlContact,
        lead_intelligence: !!intelligence,
        lp_lead: !!lpLead,
        lp_resolve_method: lpResolveMethod,
        lp_notes: lpNotes.length > 0,
        lp_notes_count: lpNotes.length,
        lp_calls: lpCalls.length > 0,
        opportunity: !!opportunity,
        pipeline_stage_resolved: !!pipelineStageInfo,
        conversation: conversation.length > 0,
        contact_address_present: !!(ghlContact?.address1),    // v2.5
        // v2.6: visibility into estimate field population. Used by the
        // response-generator's prompt builder to decide whether to render
        // the AUTHORITATIVE money block, and surfaced here so audits can
        // confirm the field was actually populated on a given test contact.
        estimate_total_present: estimateTotal !== null,
        window_count_present: windowCount !== null,
      },
      warnings: [
        ...(staleness.isStaleActive ? [`lp_data_stale_active:${staleness.ageMinutes}min`] : []),
        ...(opportunity?.pipelineStageId && !pipelineStageInfo ? ['pipeline_stage_unresolved'] : []),
      ],
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
    res.json({
      cached_contacts: contextCache.size,
      ttl_ms: CONTEXT_CACHE_TTL_MS,
      pipeline_cache_loaded: !!pipelineCache,
      pipeline_cache_size: pipelineCache?.size || 0,
    });
  });

  app.post('/n8n/lead-intelligence/bump-cache', async (req, res) => {
    const contactId = req.body?.contactId || req.query?.contactId;
    if (!contactId) return res.status(400).json({ error: 'contactId required' });
    bumpContactCache(contactId);
    res.json({ ok: true, contactId });
  });
}
