/**
 * Enrichment — src/actions/enrichment.js
 *
 * GroupMe approval/notification enrichment builders. Pulls decision context
 * from the event payload, lp_leads, lead_intelligence, the GHL contact
 * snapshot, and the service-market tables so cards are self-sufficient and
 * reviewers can act without opening GHL/LP.
 *
 * v5.1 (2026-09-14) — the Prospect line's absent value is now the shared
 * PROSPECT_UNASSIGNED constant ("Not yet assigned") rather than a second
 * hardcoded "NONE". Same doctrine, same words as the classified card.
 *
 * v5.0 (2026-06-11) — REQUIRED-FIELD ENRICHMENT (Mark's directive:
 * "every message includes Contact Name, Prospect ID, GHL Contact ID,
 * Phone, Market, LP Source, LP Subsource" + dates always show date AND
 * time + calculator completions carry the measurements).
 *
 *   1. MARKET — resolved in priority order:
 *        a. GHL custom field z0MV6mXi0w9WwdCOFThh (LP branch code:
 *           STPET, FTMYR, …) → service_markets.market_name
 *        b. zip (GHL postalCode, else lp_leads.zip) →
 *           service_area_zips.market_code → service_markets.market_name
 *        c. city (GHL city, else lp_leads.city) as a labeled fallback
 *      service_markets is tiny (10 rows) and cached in-process for 1h.
 *
 *   2. LP SOURCE / SUBSOURCE — lp_leads.lead_source/_detail as before,
 *      with a NEW fallback to the GHL custom fields LP Source
 *      (IvSDubMH0FmZmlCDy5C2) and LP Subsource (o8h88WeFST8euBUq3Av6)
 *      for contacts whose lp_leads linkage is missing (~99% of cache
 *      rows lack ghl_contact_id — same gap resolvers v3.10 closed for
 *      prospect IDs).
 *
 *   3. LOSS REASON — parsed from the contact's loss-reason:* tag and
 *      humanized ("loss-reason:dnc" → "DNC", "loss-reason:mobile-home"
 *      → "Mobile Home"). Surfaced so DISQUALIFIED cards can show WHY —
 *      previously the narrative was static and the reason (always
 *      present on the contact: 179/179 hard-disqualified contacts carry
 *      a loss-reason tag) never reached GroupMe.
 *
 *   4. APPOINTMENT DATE+TIME — GHL appointment events send startDate
 *      ("2026-06-24") and start_time ("2:00 PM") as SEPARATE fields.
 *      The old code read only start_time, producing "📅 2:00 PM" with
 *      no date. Both are now captured and rendered together.
 *
 *   5. CALCULATOR FIELDS — Window Count (h9FJTUbmUHIuD6JKmpXv), Door
 *      Count (j7l1KWmDgoJqy7SINjQs), Estimate Amount
 *      (PqUYMgBojosjSGMBEUqX), Estimate PDF (WwmVP3sAjdqYQbZyITZT)
 *      read from the GHL contact snapshot so calculator-completion
 *      notifications can show the measurements.
 *
 * v4.2 (2026-05-01) — ALWAYS-RENDER PROSPECT LINE (absence is signal,
 *   per Mark's directive).
 * v4.1 (2026-05-01) — Optional headerEmoji on buildRichNotification.
 * v4.0 (2026-05-01) — LP SOURCE / SUB-SOURCE SPLIT ("Src: parent > sub").
 * v3.9 + v4.2 — message_preview fallback for ai.analysis_completed events.
 */

import supabase from '../supabase.js';
import { formatPhone, formatDateTime, formatLpSource } from '../format-helpers.js';
import { PROSPECT_UNASSIGNED } from './notification-classifier.js';
import { isLPLeadId } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// GHL CUSTOM FIELD IDS used by notification enrichment (v5.0).
// Canonical registry: src/ghl-field-decoder.js + the architecture doc.
// ═══════════════════════════════════════════════════════════════════
const CF = {
  MARKET_CODE: 'z0MV6mXi0w9WwdCOFThh',     // LP branch/market code (STPET, FTMYR, …)
  LP_SOURCE: 'IvSDubMH0FmZmlCDy5C2',       // LP Source (parent channel)
  LP_SUBSOURCE: 'o8h88WeFST8euBUq3Av6',    // LP Subsource (specific origin)
  WINDOW_COUNT: 'h9FJTUbmUHIuD6JKmpXv',    // Calculator: window count
  DOOR_COUNT: 'j7l1KWmDgoJqy7SINjQs',      // Calculator/Bot 4: door count
  ESTIMATE_AMOUNT: 'PqUYMgBojosjSGMBEUqX', // Calculator: estimate dollar amount
  ESTIMATE_PDF: 'WwmVP3sAjdqYQbZyITZT',    // Calculator: generated PDF URL
};

function readCF(ghlContact, fieldId) {
  const arr = ghlContact?.customFields || [];
  const f = arr.find(x => x.id === fieldId);
  if (!f) return null;
  const raw = f.value;
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ═══════════════════════════════════════════════════════════════════
// SERVICE MARKET RESOLUTION (v5.0) — in-process cache, 1h TTL
// ═══════════════════════════════════════════════════════════════════

let _marketCache = null;   // Map<market_code, market_name>
let _marketCacheAt = 0;
const MARKET_CACHE_TTL_MS = 60 * 60 * 1000;

async function getMarketMap() {
  const now = Date.now();
  if (_marketCache && now - _marketCacheAt < MARKET_CACHE_TTL_MS) return _marketCache;
  try {
    const { data } = await supabase.from('service_markets').select('market_code, market_name');
    if (Array.isArray(data) && data.length > 0) {
      _marketCache = new Map(data.map(r => [String(r.market_code).toUpperCase(), r.market_name]));
      _marketCacheAt = now;
    }
  } catch (err) {
    console.warn(`[Enrichment] service_markets load failed: ${err.message}`);
  }
  return _marketCache || new Map();
}

/**
 * Resolve the human market name for a contact.
 *   1. GHL market-code custom field → service_markets
 *   2. zip → service_area_zips → service_markets
 *   3. city as a last-resort label
 * Returns null when nothing resolves (renderers show "Unknown").
 *
 * `city` may be passed explicitly (2026-09-14) for callers that hold an
 * address but no fetched GHL contact or lp_leads row — the canvassing
 * intake being the one that matters. Without it those callers fell
 * straight past step 3 and resolved null on any zip missing from
 * service_area_zips, which is how a canvass card came to print a market
 * that was not a market at all.
 */
export async function resolveMarket({ ghlContact = null, lpLead = null, zip: zipArg = null, city: cityArg = null } = {}) {
  const markets = await getMarketMap();

  // 1. LP branch/market code on the GHL contact
  const code = readCF(ghlContact, CF.MARKET_CODE);
  if (code) {
    const name = markets.get(String(code).toUpperCase());
    if (name) return name;
    // Unrecognized code — still better than nothing
    return String(code).toUpperCase();
  }

  // 2. zip → service_area_zips.
  //
  // An explicit zip wins over both record lookups: callers that have the zip in
  // hand and no fetched contact (the canvassing intake, whose payload carries
  // the address the homeowner just gave at the door) would otherwise resolve
  // nothing and card a hardcoded market. Order is deliberate — a caller passing
  // a zip is asserting it, and the two record fields stay as the fallbacks they
  // have always been for every existing caller.
  const zip = (zipArg || ghlContact?.postalCode || lpLead?.zip || '').toString().trim().slice(0, 5);
  if (/^\d{5}$/.test(zip)) {
    try {
      const { data } = await supabase.from('service_area_zips')
        .select('market_code')
        .eq('zip', zip)
        .maybeSingle();
      if (data?.market_code) {
        const name = markets.get(String(data.market_code).toUpperCase());
        if (name) return name;
      }
    } catch (err) {
      console.warn(`[Enrichment] service_area_zips lookup failed for ${zip}: ${err.message}`);
    }
  }

  // 3. city fallback
  const city = cityArg || ghlContact?.city || lpLead?.city || null;
  return city ? String(city) : null;
}

/**
 * Parse and humanize the loss-reason:* tag from a contact's tag set.
 *   "loss-reason:dnc"          → "DNC"
 *   "loss-reason:mobile-home"  → "Mobile Home"
 *   "loss-reason:out-of-area"  → "Out Of Area"
 * Returns null when no loss-reason tag is present.
 */
const REASON_UPPER = new Set(['dnc', 'dq', 'hoa']);
export function parseLossReason(tags) {
  if (!Array.isArray(tags)) return null;
  const tag = tags.find(t => typeof t === 'string' && t.toLowerCase().startsWith('loss-reason:'));
  if (!tag) return null;
  const raw = tag.slice('loss-reason:'.length).trim();
  if (!raw) return null;
  return raw.split('-').map(w => REASON_UPPER.has(w.toLowerCase())
    ? w.toUpperCase()
    : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION ENRICHMENT BUILDER
// ═══════════════════════════════════════════════════════════════════

export async function buildNotificationEnrichment(contactId, context = {}, { lpLead = null, prospectId = null, ghlContactId = null, ghlContact = null } = {}) {
  // v5.0 — GHL appointment events deliver date and time as SEPARATE
  // fields. Capture both; the renderers combine them so the 📅 line
  // always shows date AND time. A start_time that already contains a
  // date (full ISO / "MM/DD/YYYY hh:mm") is treated as the date value.
  const ctxTime = context.start_time || context.appointment_time || null;
  const ctxDate = context.startDate || context.start_date || context.appointment_date || null;
  const timeHasDate = ctxTime && /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/.test(String(ctxTime));

  const enrichment = {
    // v4.2 — accept message_preview as a fallback. It is the field on
    // ai.analysis_completed events, which is what AGENTIC_* rules fire on.
    messageText: context.message_text || context.messageText || context.body || context.message_preview || null,
    messageType: context.message_type || context.messageType || null,

    // v4.0 — parent source AND sub-source captured separately.
    lpSource: null,        // lead_source        — channel of origin (e.g. "Reece ChatBot", "Canvass")
    lpSourceDetail: null,  // lead_source_detail — specific subtype  (e.g. "Window Estimate Calculator")

    repName: null,
    disposition: null,
    prospectId: prospectId && prospectId !== 'Not in LP' ? prospectId : null,
    score: context.score || context.intent_score || null,
    tier: context.tier || context.intent_tier || null,
    barrier: context.barrier || context.psychological_barrier || null,
    briefing: context.briefing || context.rep_briefing || null,
    aiSummary: context.ai_summary || context.ai_reasoning || null,
    objection: context.objection_type || null,
    appointmentDate: timeHasDate ? ctxTime : (ctxDate || null),
    appointmentTime: timeHasDate ? null : (ctxTime || null),
    calendarName: context.calendar_name || null,

    // v5.0 additions
    market: null,
    lossReason: parseLossReason(ghlContact?.tags),
    calcWindows: readCF(ghlContact, CF.WINDOW_COUNT),
    calcDoors: readCF(ghlContact, CF.DOOR_COUNT),
    calcEstimate: readCF(ghlContact, CF.ESTIMATE_AMOUNT),
    calcPdf: readCF(ghlContact, CF.ESTIMATE_PDF),
  };

  if (lpLead) {
    if (!enrichment.lpSource) enrichment.lpSource = lpLead.lead_source || null;
    if (!enrichment.lpSourceDetail) enrichment.lpSourceDetail = lpLead.lead_source_detail || null;
    if (!enrichment.repName) enrichment.repName = lpLead.rep_name || null;
    if (!enrichment.disposition) enrichment.disposition = lpLead.disposition_label || lpLead.disposition_code || null;
    if (!enrichment.appointmentDate && !enrichment.appointmentTime) enrichment.appointmentDate = lpLead.appointment_date || null;
  }

  // v5.0 — LP source fallback from GHL custom fields. Closes the gap
  // for the ~99% of contacts whose lp_leads row lacks ghl_contact_id
  // linkage (the row exists in LP, the join just misses).
  if (!enrichment.lpSource) enrichment.lpSource = readCF(ghlContact, CF.LP_SOURCE);
  if (!enrichment.lpSourceDetail) enrichment.lpSourceDetail = readCF(ghlContact, CF.LP_SUBSOURCE);

  // v5.0 — market resolution (cached lookup; at most one zip query)
  try {
    enrichment.market = await resolveMarket({ ghlContact, lpLead });
  } catch (err) {
    console.warn(`[Enrichment] market resolution failed for ${contactId}: ${err.message}`);
  }

  const intelKey = ghlContactId || (lpLead?.ghl_contact_id) || (isLPLeadId(contactId) ? null : contactId);
  if (intelKey) {
    try {
      const { data: intel } = await supabase.from('lead_intelligence')
        .select('intent_score, intent_tier, objection_type, psychological_barrier, rep_briefing, ai_reasoning')
        .eq('ghl_contact_id', intelKey)
        .maybeSingle();
      if (intel) {
        if (!enrichment.score) enrichment.score = intel.intent_score || null;
        if (!enrichment.tier) enrichment.tier = intel.intent_tier || null;
        if (!enrichment.barrier) enrichment.barrier = intel.psychological_barrier || null;
        if (!enrichment.briefing) enrichment.briefing = intel.rep_briefing || null;
        if (!enrichment.aiSummary) enrichment.aiSummary = intel.ai_reasoning || null;
        if (!enrichment.objection) enrichment.objection = intel.objection_type || null;
      }
    } catch {}
  }

  return enrichment;
}

/**
 * v5.0 — format the calculator measurement summary for display.
 *   { calcWindows: "7", calcEstimate: "18585.09" }
 *     → "7 windows · est. $18,585"
 *   { calcWindows: "7", calcDoors: "2" }
 *     → "7 windows · 2 doors"
 * Returns null when no calculator data is present.
 */
export function formatCalcSummary(enrichment = {}) {
  const parts = [];
  const w = enrichment.calcWindows != null ? parseInt(enrichment.calcWindows, 10) : NaN;
  const d = enrichment.calcDoors != null ? parseInt(enrichment.calcDoors, 10) : NaN;
  if (!Number.isNaN(w) && w > 0) parts.push(`${w} window${w === 1 ? '' : 's'}`);
  if (!Number.isNaN(d) && d > 0) parts.push(`${d} door${d === 1 ? '' : 's'}`);
  if (enrichment.calcEstimate) {
    const amt = Number(String(enrichment.calcEstimate).replace(/[^0-9.]/g, ''));
    if (!Number.isNaN(amt) && amt > 0) {
      parts.push(`est. $${Math.round(amt).toLocaleString('en-US')}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ═══════════════════════════════════════════════════════════════════
// RICH NOTIFICATION FORMATTER — used by send_notification, create_task,
// and (v3.6+) send_message handlers
// ═══════════════════════════════════════════════════════════════════

export function buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment = {}, headerEmoji = '🤖' }) {
  const lines = [];
  // v4.1: headerEmoji defaults to 🤖 for backward compat. Channel-specific
  // notifications (send-message-handler v3.6) pass 📱/📧.
  lines.push(`${headerEmoji} ${baseMessage}`);
  const displayPhone = formatPhone(phone);
  const nameLine = `👤 ${name || 'Unknown'}${displayPhone ? ` ${displayPhone}` : ''}`;
  lines.push(nameLine);
  const idLabel = isLPLeadId(contactId) ? 'LP Lead ID' : 'Contact ID';
  const idParts = [`${idLabel}: ${contactId}`];
  // v4.2 (2026-05-01): always render the Prospect line. Per Mark's directive,
  // absence-of-Prospect-ID is itself signal. v5.1 (2026-09-14): the absent
  // value is the shared constant, so this card and the classified card can
  // never disagree on the words.
  const prospectClean = (prospectId && String(prospectId).trim() && prospectId !== 'Not in LP')
    ? String(prospectId)
    : PROSPECT_UNASSIGNED;
  idParts.push(`Prospect: ${prospectClean}`);
  lines.push(`   ${idParts.join(' | ')}`);

  // v5.0 — Market is a required field on every card. "Unknown" when
  // unresolvable, consistent with the absence-is-signal doctrine.
  lines.push(`🌍 Market: ${enrichment.market || 'Unknown'}`);

  if (enrichment.messageText) {
    const msg = String(enrichment.messageText).slice(0, 120);
    const suffix = enrichment.messageType ? ` [${enrichment.messageType}]` : '';
    lines.push(`💬 "${msg}"${suffix}`);
  }

  // v5.0 — Src is a required field on every card; renders "Unknown"
  // when neither lp_leads nor the GHL custom fields have it.
  const lpParts = [];
  const src = formatLpSource(enrichment.lpSource, enrichment.lpSourceDetail);
  lpParts.push(`Src: ${src || 'Unknown'}`);
  if (enrichment.repName) lpParts.push(`Rep: ${enrichment.repName}`);
  if (enrichment.disposition) lpParts.push(`Disp: ${enrichment.disposition}`);
  lines.push(`📋 ${lpParts.join(' | ')}`);

  // v5.0 — loss reason surfaced when present (DISQUALIFIED / loss cards)
  if (enrichment.lossReason) {
    lines.push(`🚫 Reason: ${enrichment.lossReason}`);
  }

  if (enrichment.score || enrichment.tier || enrichment.barrier) {
    const intentParts = [];
    if (enrichment.score) intentParts.push(`Score: ${enrichment.score}`);
    if (enrichment.tier) intentParts.push(`Tier: ${enrichment.tier}`);
    if (enrichment.barrier) intentParts.push(`Barrier: ${enrichment.barrier}`);
    lines.push(`📊 ${intentParts.join(' | ')}`);
  }
  if (enrichment.appointmentDate || enrichment.appointmentTime) {
    const prefix = enrichment.calendarName ? `${enrichment.calendarName}: ` : '';
    // v5.0 — combine date + time so the 📅 line always shows both.
    const displayDate = formatDateTime(enrichment.appointmentDate || enrichment.appointmentTime, enrichment.appointmentDate ? enrichment.appointmentTime : null)
      || enrichment.appointmentDate || enrichment.appointmentTime;
    lines.push(`📅 ${prefix}${displayDate}`);
  }
  return lines.join('\n');
}
