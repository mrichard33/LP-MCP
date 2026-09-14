/**
 * Context Builder — src/context-builder.js
 *
 * v2.9 — 2026-09-07. CUSTOMER RELATIONSHIP for the message analyzer
 *   (Shawn Friend incident, contact 19zXvwBKo8RISXbafGHC, event 3460420).
 *
 *   PROBLEM: the analyzer prompt only stated customer status when
 *   lp.closed_won was true. A prospect and a customer rendered
 *   identically, so a prospect's scheduling complaint was classified
 *   existing_customer_service. And because this builder resolves ONE
 *   lp_leads row per contact, a returning customer (bought before, new
 *   sales lead open now — 92 CXL-with-appointment cases in the last 180
 *   days) could not be told apart from a warranty caller.
 *
 *   FIX: fetchLPProspectHistory() reads every lp_leads row on the
 *   prospect (mirrors ghl-field-sync's everClosedWon aggregation).
 *   deriveCustomerRelationship() folds that history + isCustomerP2()
 *   tag/pipeline signals into three fields on context.lp:
 *     has_prior_sale        — any sale on record, ever (person-level)
 *     open_sales_lead       — the LATEST lead is a sales-side record
 *                             (not closed_won, not Sale/SW/PM/P2)
 *     customer_relationship — 'prospect' | 'returning_customer' |
 *                             'service_customer'
 *   Customer status comes from the whole history; the conversation's
 *   nature comes from the latest lead. Reuses isCustomerP2 rather than
 *   adding a fourth definition of "customer" to the codebase.
 *
 *   PAIRS WITH: message-analyzer.js v1.12 (prompt block + gate).
 *   No schema changes, no env vars, no rule changes.
 *
 * v2.7 — 2026-05-11. ADD NURTURE HISTORY BLOCK for the outbound nurture
 *   message generator (src/nurture/*).
 *
 *   Adds a top-level `nurture` block containing:
 *     stories_already_deployed — last 8 story arcs (chronological)
 *     subjects_already_used    — last 10 subjects (most-recent first)
 *     sequence_position        — max seq_pos for the requested workflow_code
 *
 *   Used by:
 *     - nurture-prompt-selector.js to hard-exclude repeated story arcs
 *     - nurture-hard-blockers.js to reject duplicate subject lines
 *     - nurture-orchestrator.js to track cycle position
 *
 *   buildLeadContext now accepts options.workflow_code; when present,
 *   sequence_position is computed against that workflow's rows. When
 *   absent, sequence_position is 0.
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
import { appointmentDelta, appointmentPhase, formatDateHuman, formatTimeHuman, APPOINTMENT_TZ } from './appointment-dates.js';
import { stripQuotedEmail } from './email-thread.js';
import { channelOfMessage } from './agentic/reply-sender.js';
// v2.9: the canonical five-signal "is this person a customer" test. Reused
// here so customer_relationship never disagrees with the suppression shapes.
import { isCustomerP2 } from './agentic/lead-state/signals/context-reader.js';
import { withGhlToken } from './ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const CONTEXT_CACHE_TTL_MS = parseInt(process.env.CONTEXT_CACHE_TTL_MS || '60000', 10);
const LP_DATA_STALE_THRESHOLD_MIN = parseInt(process.env.LP_DATA_STALE_THRESHOLD_MIN || '15', 10);
const PIPELINE_CACHE_TTL_MS = parseInt(process.env.PIPELINE_CACHE_TTL_MS || '900000', 10); // 15 min — pipelines change rarely

// v2.8 (2026-06-02) — Per-call ceiling on Supabase reads. The JS client has no
// abort support; a hung query (lock/pool contention — e.g. lp_leads during a
// FORCE_FULL_SYNC) would otherwise stall buildLeadContext forever. Each fetcher
// races its query against this timeout and degrades to its safe fallback
// (null / []) so a slow data source yields partial context instead of a hang.
const CONTEXT_SB_TIMEOUT_MS = parseInt(process.env.CONTEXT_SB_TIMEOUT_MS || '6000', 10);

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
const CF_DECISION_MAKERS_PRESENT = 'GH1QGGOseMKmJAMqajiN'; // select: Yes|No|Solo Owner|Uncertain
// 2026-07-06 (Bot 2/3/4 consolidation) — Trust Level Score. Bot 2's pricing,
// discovery, and value-first scripts branch on this (low 1-2 / neutral 3 /
// high 4-5). Read-only here; the responder emits its own trust_level_targeted.
const CF_TRUST_LEVEL_SCORE = 'zrghbp0ZLrOyTWc9x6Ai';
// 2026-07-29 (Kelly Callahan incident) — the CONTACT'S OWN rep name. The email
// handoff bridge used to interpolate {{custom_values.rep_name}}, a single
// location-level global that reads "Mark" for every contact in the location, so
// a reply to a Mark-signed nurture email opened "Mark here — Mark asked me to
// reach out." These two per-contact fields (plus lp.rep_name from the LP lead
// row) are the only sources that can ever name the ACTUAL rep. Read-only here;
// response-generator.js resolveReplySenderName() owns the priority order.
const CF_REP_DISPLAY_NAME = 'yxOTDIT7Um0JxkOPUbPo'; // "Rep Display Name"
const CF_LP_REP_NAME      = 'ML9jAe1P5eq1uSwYTV3o'; // "LP Rep Name", e.g. "Dorsett, Beverly"

// LP dispositions where stale data is high-risk (active deals).
const LP_ACTIVE_DISPOSITIONS = new Set([
  'Issue', 'Data', 'BO', '1Leg', 'NIS', 'NIS2', 'NoHome',
  'CXL', 'PNQ', 'NoRehash', 'FDNS', 'OPPFDN',
]);

// 2026-07-06: dispositions meaning the LP-recorded appointment was
// cancelled. lp_leads.appointment_set is only ever written true (LP
// ingest); no cancel path resets it, so a CXL lead otherwise reads as
// having an upcoming appointment and the responder references the
// cancelled visit as still on the calendar (Mark Test "your visit
// Wednesday" incident). Effective-appointment derivation lives where
// the lp context block is assembled.
const LP_CANCELLED_APPT_DISPOSITIONS = new Set(['CXL']);

// v2.9: dispositions that mark an lp_leads row as POST-SALE / service-side.
// Any other non-closed_won row is a sales-side record (Data, Set, Cnf, Issue,
// Verif, 1Leg, CXL, CCC, No Demo, NoHome, OPPFDN, Reset …). Upper-cased on
// compare. Sale/SW are closed_won in sync-dispositions.js; PM/P2 are the
// post-sale production codes.
export const SERVICE_SIDE_DISPOSITIONS = new Set(['SALE', 'SW', 'PM', 'P2']);

function dispositionUpper(row) {
  return String(row?.disposition_code || '').trim().toUpperCase();
}

function isServiceSideRow(row) {
  return row?.closed_won === true || SERVICE_SIDE_DISPOSITIONS.has(dispositionUpper(row));
}

/**
 * v2.9 — Resolve the customer relationship from the prospect's FULL lead
 * history plus the tag/pipeline signals isCustomerP2 already trusts.
 *
 * Two independent questions, answered from two different places:
 *   has_prior_sale   — PERSON-level. Any sale-side row in history, or any
 *                      isCustomerP2 signal (P2 pipeline, p2-stage:*,
 *                      lp-milestone-completion, won opp + demo verified).
 *   open_sales_lead  — CONVERSATION-level. Is the LATEST lead (by
 *                      created_at_lp) a sales-side record? A returning
 *                      customer with a new inquiry has a NEWER sales row than
 *                      their Sale row; a warranty caller's latest row IS the
 *                      Sale row.
 *
 *   prospect           — no prior sale. existing_customer_service is impossible.
 *   returning_customer — prior sale AND open sales lead. This is a SALES
 *                        conversation unless the message is about the work
 *                        already done.
 *   service_customer   — prior sale, no open sales lead. Genuine service.
 *
 * Pure. Exported for scripts/test-customer-relationship-gate.js.
 *
 * @param {object}   args
 * @param {object[]} args.history  lp_leads rows for the prospect (any order)
 * @param {object}   args.lpLead   the single resolved row (fallback when history is empty)
 * @param {string[]} args.tags     GHL tags
 * @param {object}   args.pipeline { pipeline_id, status } shim for isCustomerP2
 */
export function deriveCustomerRelationship({ history = [], lpLead = null, tags = [], pipeline = null } = {}) {
  const rows = (Array.isArray(history) && history.length) ? history : (lpLead ? [lpLead] : []);
  const saleRows = rows.filter(isServiceSideRow);

  const priorSaleFromLp = saleRows.length > 0;
  const priorSaleFromSignals = isCustomerP2({
    lead: { current_tags: Array.isArray(tags) ? tags : [] },
    pipeline: pipeline || {},
    lp: { closed_won: lpLead?.closed_won === true },
  });
  const has_prior_sale = priorSaleFromLp || priorSaleFromSignals;

  const latest = [...rows]
    .sort((a, b) => String(b?.created_at_lp || '').localeCompare(String(a?.created_at_lp || '')))[0] || null;
  const open_sales_lead = !!latest && !isServiceSideRow(latest);

  const prior_sale_date = saleRows
    .map(r => r?.created_at_lp)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;

  const customer_relationship = !has_prior_sale
    ? 'prospect'
    : (open_sales_lead ? 'returning_customer' : 'service_customer');

  return {
    has_prior_sale,
    open_sales_lead,
    customer_relationship,
    prior_sale_date,
    latest_lead_created_at_lp: latest?.created_at_lp || null,
    latest_lead_disposition: latest?.disposition_code || null,
    lead_history_count: rows.length,
  };
}

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
    const res = await withGhlToken(() => fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    }));
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

// v2.8 — Promise timeout wrapper for Supabase reads. Rejects with a labeled
// error if the query hasn't settled within CONTEXT_SB_TIMEOUT_MS; callers catch
// and fall back to their safe default so one slow source never stalls the build.
function withTimeout(promise, label, ms = CONTEXT_SB_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
      // 2026-07-29 (Kelly Callahan incident): email turns arrive from the
      // conversations API with the full quoted thread, HTML markup, signature,
      // and broadcast footer attached. behavioral-emitter strips the inbound
      // WEBHOOK body, but these turns are re-read from GHL and were raw — so
      // identity extraction matched a "phone" (+15346485266) out of the digits
      // in an unsubscribe URL's time_stamp, and the generation prompt saw our
      // own "Mark / Reece Windows & Doors" sign-off quoted back at us. Strip
      // email turns only; SMS and live-chat bodies are already the bare text.
      // 2026-09-11: the channel this turn came in on, carried forward so the
      // generation prompt can label each history line [inbound/sms] vs
      // [outbound/email]. Nothing downstream could previously tell them apart.
      channel: channelOfMessage(m) || null,
      text: channelOfMessage(m) === 'email'
        ? stripQuotedEmail(m.body || m.message || '')
        : (m.body || m.message || ''),
      type: m.contentType || m.type || 'text',
      timestamp: m.dateAdded || m.createdAt || null,
    })).reverse();
  } catch (err) {
    console.error(`[ContextBuilder] fetchConversation failed for ${contactId}:`, err.message);
    return [];
  }
}

async function fetchLeadIntelligence(contactId) {
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('lead_intelligence')
        .select('*')
        .eq('ghl_contact_id', contactId)
        .maybeSingle(),
      'fetchLeadIntelligence',
    );
    if (error) {
      console.error(`[ContextBuilder] lead_intelligence fetch error:`, error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[ContextBuilder] fetchLeadIntelligence timed out/failed for ${contactId}: ${err.message}`);
    return null;
  }
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
    const { data, error } = await withTimeout(
      supabase
        .from('lp_leads')
        .select(LP_LEAD_COLUMNS)
        .eq('lp_prospect_id', String(prospectId))
        .order('synced_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'fetchLPLeadByProspectId',
    );
    if (error || !data) return null;
    return data;
  } catch (err) {
    console.error(`[ContextBuilder] lp_leads prospect lookup error:`, err.message);
    return null;
  }
}

async function fetchLPLeadByGhlContactId(contactId) {
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('lp_leads')
        .select(LP_LEAD_COLUMNS)
        .eq('ghl_contact_id', contactId)
        .order('synced_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'fetchLPLeadByGhlContactId',
    );
    if (error) {
      console.error(`[ContextBuilder] lp_leads ghl_contact_id lookup error:`, error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[ContextBuilder] fetchLPLeadByGhlContactId timed out/failed for ${contactId}: ${err.message}`);
    return null;
  }
}

async function fetchLPLeadByLdsId(lpLeadId) {
  if (!lpLeadId) return null;
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('lp_leads')
        .select(LP_LEAD_COLUMNS)
        .eq('lp_lead_id', String(lpLeadId))
        .maybeSingle(),
      'fetchLPLeadByLdsId',
    );
    if (error || !data) return null;
    return data;
  } catch (err) {
    console.error(`[ContextBuilder] lp_leads lp_lead_id lookup error:`, err.message);
    return null;
  }
}

// v2.9 — every lp_leads row on the prospect, newest first. This is the read
// the single-row resolvers above cannot make: "has this person EVER bought,
// and is the newest thing on record a fresh sales lead?" Mirrors the
// everClosedWon aggregation in ghl-field-sync.js. Fail-soft → [].
async function fetchLPProspectHistory(prospectId, limit = 25) {
  if (!prospectId) return [];
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('lp_leads')
        .select('lp_lead_id, closed_won, disposition_code, created_at_lp, appointment_set, appointment_date, demo_completed, job_value')
        .eq('lp_prospect_id', String(prospectId))
        .order('created_at_lp', { ascending: false })
        .limit(limit),
      'fetchLPProspectHistory',
    );
    if (error || !data) return [];
    return data;
  } catch (err) {
    console.warn(`[ContextBuilder] fetchLPProspectHistory timed out/failed for prospect ${prospectId}: ${err.message}`);
    return [];
  }
}

async function fetchLPNotes(lpLeadId, limit = 8) {
  if (!lpLeadId) return [];
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('lp_notes')
        .select('note_body, note_category, created_by_rep_name, created_at_lp')
        .eq('lp_lead_id', lpLeadId)
        .not('note_body', 'is', null)
        .order('created_at_lp', { ascending: false })
        .limit(limit),
      'fetchLPNotes',
    );
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

/**
 * 2026-07-07 (owner requirement — trust through personalization): the GHL
 * contact-record notes are the richest per-lead intel we have (canvassing
 * observations, rep call notes, the agentic escalation summaries this
 * system writes via add_note). Until now the responder never read them —
 * only LP notes reached the prompt. Fetch the most recent notes so every
 * generated reply can personalize from what the team actually knows about
 * this person. Fail-soft: any error returns [] and generation proceeds.
 */
async function fetchGHLNotes(ghlContactId, limit = 6) {
  if (!ghlContactId) return [];
  try {
    const data = await ghlFetch('GET', `/contacts/${ghlContactId}/notes`);
    const notes = Array.isArray(data?.notes) ? data.notes : [];
    return notes
      .map(n => ({
        text: String(n.body || '').trim().slice(0, 600),
        date: n.dateAdded || n.date_added || '',
      }))
      .filter(n => n.text.length > 0)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, limit);
  } catch (err) {
    console.warn(`[ContextBuilder] GHL notes fetch failed for ${ghlContactId}:`, err.message);
    return [];
  }
}

async function fetchLPCalls(lpLeadId, limit = 5) {
  if (!lpLeadId) return [];
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('lp_call_logs')
        .select('call_result, call_direction, rep_name, call_date, lp_lead_id')
        .eq('lp_lead_id', lpLeadId)
        .order('call_date', { ascending: false })
        .limit(limit),
      'fetchLPCalls',
    );
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

// v2.7: Pull recent nurture history for the outbound message engine.
// Returns the last N story arcs, the last 10 subjects, and the highest
// 2026-07-06 (Bot 2/3/4 consolidation) — the contact's OPEN objection state,
// if any (one-open-row invariant: exited_at IS NULL). Bot 2's Mistrust /
// Spouse / Budget plays are TWO-TURN state machines: the responder selects
// the turn-1 (listen/categorize) vs turn-2 (respond) script from this state,
// advanced by the transition_objection_state action. Fail-soft: an
// unreadable state degrades to null (single-turn behavior), never a hang.
async function fetchOpenObjectionState(ghlContactId) {
  if (!ghlContactId) return null;
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('contact_objection_states')
        .select('state_code, parent_state, entered_at, recovery_attempt_number')
        .eq('contact_id', ghlContactId)
        .is('exited_at', null)
        .maybeSingle(),
      'fetchOpenObjectionState',
    );
    if (error || !data) return null;
    return {
      state_code: data.state_code,
      parent_state: data.parent_state || null,
      entered_at: data.entered_at || null,
      attempt_number: data.recovery_attempt_number ?? null,
    };
  } catch (err) {
    console.warn(`[ContextBuilder] open objection state read failed for ${ghlContactId}: ${err.message}`);
    return null;
  }
}

// sequence_position observed for the requested workflow_code. Used by
// the prompt selector (to exclude recently-used arcs) and the hard
// blockers (to reject repeated subject lines).
async function fetchNurtureHistory(ghlContactId, workflowCode) {
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('agentic_messages')
        .select('generated_meta, generated_subject, workflow_code, sequence_position')
        .eq('ghl_contact_id', ghlContactId)
        .in('send_status', ['generated_ready', 'ghl_sent_confirmed'])
        .order('generated_at', { ascending: false })
        .limit(20),
      'fetchNurtureHistory',
    );

    if (error || !data) {
      return { stories_already_deployed: [], subjects_already_used: [], sequence_position: 0 };
    }

    // Last 8 deployed story arcs, in chronological order (oldest → newest).
    // Selector / blockers slice from the END to get the most recent.
    const stories = data
      .slice(0, 8)
      .reverse()
      .map(r => r.generated_meta?.story_arc_used)
      .filter(Boolean);

    // Last 10 subjects, most-recent first.
    const subjects = data
      .slice(0, 10)
      .map(r => r.generated_subject)
      .filter(Boolean);

    let seqPos = 0;
    if (workflowCode) {
      const workflowRows = data.filter(r => r.workflow_code === workflowCode);
      if (workflowRows.length > 0) {
        seqPos = Math.max(...workflowRows.map(r => r.sequence_position || 0));
      }
    }

    return {
      stories_already_deployed: stories,
      subjects_already_used: subjects,
      sequence_position: seqPos,
    };
  } catch (err) {
    console.warn(`[ContextBuilder] fetchNurtureHistory failed for ${ghlContactId}: ${err.message}`);
    return { stories_already_deployed: [], subjects_already_used: [], sequence_position: 0 };
  }
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
  const { includeConversation = true, skipCache = false, workflow_code = null } = options;

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
  // Decision-maker presence (for the in-home booking gate). Raw select value:
  // 'Yes' | 'No' | 'Solo Owner' | 'Uncertain' | null.
  const decisionMakersPresent = ghlContact?.customFields
    ? getCustomFieldValue(ghlContact.customFields, CF_DECISION_MAKERS_PRESENT)
    : null;
  // 2026-07-06: Trust Level Score (1-5) for trust-adaptive scripts. Null when
  // unset — the prompt treats unknown trust as neutral.
  const trustLevelScore = coerceCount(
    ghlContact?.customFields
      ? getCustomFieldValue(ghlContact.customFields, CF_TRUST_LEVEL_SCORE)
      : null
  );
  // 2026-07-29: the contact's OWN rep name, for the email handoff bridge.
  const repDisplayName = ghlContact?.customFields
    ? getCustomFieldValue(ghlContact.customFields, CF_REP_DISPLAY_NAME)
    : null;
  const lpRepNameField = ghlContact?.customFields
    ? getCustomFieldValue(ghlContact.customFields, CF_LP_REP_NAME)
    : null;

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
  const [conversation, lpNotes, lpCalls, pipelineStageInfo, nurtureHistory, openObjectionState, ghlNotes, lpProspectHistory] = await Promise.all([
    (includeConversation && ghlContact) ? fetchConversation(ghlContactId, 10) : [],
    fetchLPNotes(lpLeadId),
    fetchLPCalls(lpLeadId),
    opportunity?.pipelineStageId ? resolvePipelineStage(opportunity.pipelineStageId) : null,
    fetchNurtureHistory(ghlContactId, workflow_code),
    fetchOpenObjectionState(ghlContactId),
    fetchGHLNotes(ghlContactId),
    // v2.9: whole-prospect history for customer_relationship.
    fetchLPProspectHistory(lpLead?.lp_prospect_id || cfProspectId || null),
  ]);

  const tags = ghlContact?.tags || [];
  const daysInStage = calculateDaysInStage(opportunity);
  const lpName = lpLead ? [lpLead.first_name, lpLead.last_name].filter(Boolean).join(' ') : null;
  const staleness = calcLpStaleness(lpLead);
  // Date awareness: current ET date + past/future labeling for the LP
  // appointment so the prompt never calls a past appointment "upcoming".
  const nowInstant = new Date();
  const apptDelta = appointmentDelta(lpLead?.appointment_date, nowInstant);
  // 2026-08-29 (Myron Thorner): minute-grain phase. appointmentDelta is day
  // grain and reported "not past" 37 minutes after the appointment started.
  const apptPhase = appointmentPhase(lpLead?.appointment_date, nowInstant);

  // 2026-07-06: effective appointment state. The snapshot flag is stale
  // after a cancellation (never reset by any cancel path), so treat the
  // appointment as cancelled when the LP disposition says so OR the GHL
  // cancel flow tagged the contact — unless a fresh booking is active
  // (booking:active), which always wins.
  const apptCancelled = !tags.includes('booking:active') && (
    (!!lpLead?.appointment_set && LP_CANCELLED_APPT_DISPOSITIONS.has(lpLead?.disposition_code))
    || tags.includes('appt-cancelled')
  );

  // v2.9: customer relationship — person-level (has_prior_sale) and
  // conversation-level (open_sales_lead) resolved separately. See
  // deriveCustomerRelationship for the four quadrants.
  const relationship = deriveCustomerRelationship({
    history: lpProspectHistory,
    lpLead,
    tags,
    pipeline: { pipeline_id: opportunity?.pipelineId || null, status: opportunity?.status || null },
  });

  const context = {
    now: {
      iso: nowInstant.toISOString(),
      date_human: formatDateHuman(nowInstant),
      // 2026-08-29: the current WALL CLOCK, not just the date. Without this
      // the prompt could reason about days but never about hours, and the
      // responder offered callback windows that had already passed.
      time_human: formatTimeHuman(nowInstant),
      tz: APPOINTMENT_TZ,
    },
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
      // Decision-maker presence for the in-home booking gate (raw GHL select).
      decision_makers_present: decisionMakersPresent,
      // 2026-07-06: Trust Level Score (1-5, null = unknown/neutral) for
      // Bot 2's trust-adaptive pricing / value-first / bridge scripts.
      trust_level_score: trustLevelScore,
      // 2026-07-29 (Kelly Callahan incident): per-contact rep identity. Feeds
      // resolveReplySenderName() so the email handoff bridge can never fall
      // back to the location-global {{custom_values.rep_name}} ("Mark").
      rep_display_name: repDisplayName,
      lp_rep_name: lpRepNameField,
      current_tags: tags,
      current_stage_tag: parseStageTag(tags),
      current_buyer_tag: parseBuyerTag(tags),
      current_bj_tag: parseBuyerJourneyTag(tags),
      objection_tags: parseObjectionTags(tags),
      suppression_tags: parseSuppressionTags(tags),
      lead_score: ghlContact?.leadScore || 0,
      date_added: ghlContact?.dateAdded || null,
      // 2026-07-07 (trust through personalization): most recent GHL
      // contact-record notes — canvassing observations, rep call notes,
      // agentic escalation summaries. Rendered into the generation prompt
      // as internal intel for personalizing replies.
      contact_notes: ghlNotes,
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

    // 2026-07-06 (Bot 2/3/4 consolidation): the contact's open objection
    // state, or null. Drives turn-1 vs turn-2 script selection for the
    // two-turn objection plays (Mistrust / Spouse / Budget).
    objection_state: openObjectionState,

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
      // Effective appointment state (see apptCancelled above): a cancelled
      // appointment reads as NO appointment, with the old date preserved in
      // last_appointment_date so prompts can say "your appointment on X was
      // cancelled" instead of treating it as upcoming.
      appointment_set: apptCancelled ? false : (lpLead?.appointment_set || false),
      appointment_cancelled: apptCancelled,
      appointment_date: apptCancelled ? null : (lpLead?.appointment_date || null),
      last_appointment_date: apptCancelled ? (lpLead?.appointment_date || null) : null,
      // Signed whole-day delta from today (ET); negative = past. null when no appt.
      appointment_is_past: apptCancelled ? null : (apptDelta ? apptDelta.is_past : null),
      appointment_days_delta: apptCancelled ? null : (apptDelta ? apptDelta.days_delta : null),
      // Minute-grain phase: scheduled | imminent | in_window | past |
      // today_time_unknown. Null when cancelled or no appointment.
      appointment_phase: apptCancelled ? null : (apptPhase ? apptPhase.phase : null),
      appointment_minutes_delta: apptCancelled ? null : (apptPhase ? apptPhase.minutes_delta : null),
      appointment_time_human: apptCancelled ? null : (apptPhase ? apptPhase.appointment_time_human : null),
      appointment_time_known: apptCancelled ? null : (apptPhase ? apptPhase.time_known : null),
      demo_completed: lpLead?.demo_completed || false,
      demo_date: lpLead?.demo_date || null,
      days_to_demo: lpLead?.days_to_demo || null,
      closed_won: lpLead?.closed_won || false,
      job_value: lpLead?.job_value || null,
      call_count: lpLead?.call_count || 0,
      last_call_date: lpLead?.last_call_date || null,
      lost_reason: ghlCustomFieldLostReason || null,
      // v2.9: customer relationship. has_prior_sale is PERSON-level (whole
      // prospect history + isCustomerP2 signals); open_sales_lead is
      // CONVERSATION-level (the newest lead is a sales-side record).
      has_prior_sale: relationship.has_prior_sale,
      open_sales_lead: relationship.open_sales_lead,
      customer_relationship: relationship.customer_relationship,
      prior_sale_date: relationship.prior_sale_date,
      latest_lead_created_at_lp: relationship.latest_lead_created_at_lp,
      latest_lead_disposition: relationship.latest_lead_disposition,
      lead_history_count: relationship.lead_history_count,
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

    // v2.7: Nurture history block. Populated by fetchNurtureHistory() from
    // agentic_messages rows in 'generated_ready' or 'ghl_sent_confirmed'
    // status. Empty arrays / 0 when no prior nurture activity. Used by the
    // outbound message engine; safe to ignore in other contexts.
    nurture: nurtureHistory,

    meta: {
      context_built_at: new Date().toISOString(),
      context_builder_version: '2.9',
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
        // v2.9
        lp_prospect_history_rows: lpProspectHistory.length,
        customer_relationship: relationship.customer_relationship,
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
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('lead_intelligence')
        .upsert({
          ghl_contact_id: ghlContactId,
          ...updates,
          updated_at: now,
        }, {
          onConflict: 'ghl_contact_id',
        })
        .select()
        .single(),
      'upsertLeadIntelligence',
    );
    if (error) {
      console.error(`[ContextBuilder] lead_intelligence upsert error:`, error.message);
      return null;
    }
    invalidateContext(ghlContactId);
    return data;
  } catch (err) {
    console.warn(`[ContextBuilder] upsertLeadIntelligence timed out/failed for ${ghlContactId}: ${err.message}`);
    return null;
  }
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
