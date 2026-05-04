/**
 * Resolvers — src/actions/resolvers.js
 *
 * Contact name/phone resolution, LP prospect ID resolution, event context
 * retrieval. Extracted from action-executor.js v4.2 refactor.
 *
 * Resolution fallback chains are preserved exactly as v3.5–v3.9:
 *   resolveContactInfo: LP Lead (numeric) → GHL → LP cache → payload name
 *   resolveLPProspectId: LP Lead → LP API live → cached prospect_id
 *
 * v3.10 (2026-05-04) — GHL CUSTOM FIELD FALLBACK in resolveLPProspectId.
 *   PROBLEM: lp_leads cache has 100% prospect_id coverage (204K rows) but
 *   only 1.03% (2,100 rows) have ghl_contact_id populated. Calling
 *   resolveLPProspectId with a GHL contact ID short-circuited to
 *   'Not in LP' for 99% of contacts because the
 *     SELECT FROM lp_leads WHERE ghl_contact_id = ?
 *   lookup missed, leaving lpLeadId null and skipping the LP API path
 *   entirely. End result: GroupMe notifications rendered "Prospect: NONE"
 *   for nearly every contact, even when GHL had the prospect ID right
 *   there in custom field ZRQAVrzhtzApzLlHmT87.
 *
 *   FIX: When the cache + LP API paths produce nothing AND the contactId
 *   is a GHL ID (not numeric LP lead ID), GET the GHL contact and read
 *   the LP Prospect ID custom field directly. The custom field is written
 *   by Bot 4, W0.x inbound webhook, and LP↔GHL sync paths so it's a
 *   reliable source-of-truth that doesn't depend on the cache having the
 *   ghl_contact_id linkage.
 *
 *   Pattern mirrors lp-dnc.js readCF — already-shipped precedent for this
 *   exact lookup.
 *
 *   Cost: ~1 extra GHL fetch per notification when cache misses. Today
 *   that's ~99% of notifications, but volume is low (<1K/day) and
 *   acquireToken rate-limits the calls. Self-healing of lp_leads
 *   ghl_contact_id linkage is intentionally NOT done here — separate
 *   concern, separate change.
 */

import supabase from '../supabase.js';
import { getLeadByLdsId } from '../lp-client.js';
import { isLPLeadId, ghlFetch } from './helpers.js';

const LP_LEAD_COLUMNS =
  'lp_lead_id, lp_prospect_id, ghl_contact_id, first_name, last_name, phone, ' +
  'lead_source, lead_source_detail, disposition_code, disposition_label, rep_name, ' +
  'appointment_set, appointment_date, demo_completed';

// v3.10 — GHL custom field IDs used in the prospect-ID fallback. Mirrors
// lp-dnc.js. Single source of truth for the field ID lives in the project's
// architecture doc; if GHL ever rotates the field, update both files.
const FIELD_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87';

// ═══════════════════════════════════════════════════════════════════
// CONTACT + LP PROSPECT RESOLVER — with guaranteed fallback chain
// ═══════════════════════════════════════════════════════════════════

export async function resolveContactInfo(contactId, eventContext = {}) {
  if (!contactId) return { name: 'Unknown', phone: null, ghlContactId: null, lpLead: null };

  if (isLPLeadId(contactId)) {
    let lpLeadRow = null;
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select(LP_LEAD_COLUMNS)
        .eq('lp_lead_id', contactId)
        .maybeSingle();
      if (lpLead) {
        lpLeadRow = lpLead;
        const name = [lpLead.first_name, lpLead.last_name].filter(Boolean).join(' ') || null;
        if (name) return { name, phone: lpLead.phone || null, ghlContactId: lpLead.ghl_contact_id || null, lpLead: lpLeadRow };
      }
    } catch {}
    try {
      const result = await getLeadByLdsId(contactId);
      const prospects = Array.isArray(result) ? result : [result];
      for (const p of prospects) {
        if (!p) continue;
        const name = [p.FirstName || p.firstname, p.LastName || p.lastname].filter(Boolean).join(' ') || null;
        if (name) return { name, phone: p.Phone || p.phone || null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow };
      }
    } catch {}
    const payloadName = eventContext.contactName || eventContext.contact_name || eventContext.lead_name || eventContext.leadName || null;
    if (payloadName) return { name: payloadName, phone: null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow };
    return { name: `LP Lead ${contactId}`, phone: null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow };
  }

  let lpLeadRow = null;
  try {
    const { data: lpLead } = await supabase.from('lp_leads')
      .select(LP_LEAD_COLUMNS)
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    if (lpLead) lpLeadRow = lpLead;
  } catch {}

  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const c = ghlRes?.contact || {};
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null;
    const phone = c.phone || null;
    if (name) return { name, phone, ghlContactId: contactId, lpLead: lpLeadRow };
  } catch {}

  if (lpLeadRow) {
    const name = [lpLeadRow.first_name, lpLeadRow.last_name].filter(Boolean).join(' ') || null;
    if (name) return { name, phone: lpLeadRow.phone || null, ghlContactId: contactId, lpLead: lpLeadRow };
  }

  const payloadName = eventContext.contactName || eventContext.contact_name || eventContext.lead_name || eventContext.leadName || null;
  if (payloadName && payloadName !== contactId) {
    return { name: payloadName, phone: null, ghlContactId: contactId, lpLead: lpLeadRow };
  }

  return { name: contactId, phone: null, ghlContactId: contactId, lpLead: lpLeadRow };
}

// v3.10 — extract the LP Prospect ID from a GHL contact's customFields
// array. Defensive: empty values, sentinel strings, and non-string types
// all collapse to null so callers can treat null === "not present".
function readProspectIdFromGhlCustomFields(contact) {
  const arr = contact?.customFields || [];
  const f = arr.find(x => x.id === FIELD_LP_PROSPECT_ID);
  if (!f) return null;
  const raw = f.value;
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

export async function resolveLPProspectId(contactId) {
  if (!contactId) return 'Not in LP';

  let lpLeadId = null;
  let cachedProspectId = null;

  if (isLPLeadId(contactId)) {
    lpLeadId = contactId;
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select('lp_prospect_id')
        .eq('lp_lead_id', contactId)
        .maybeSingle();
      cachedProspectId = lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null;
    } catch {}
  } else {
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select('lp_lead_id, lp_prospect_id')
        .eq('ghl_contact_id', contactId)
        .order('synced_at', { ascending: false })
        .limit(1).maybeSingle();
      lpLeadId = lpLead?.lp_lead_id || null;
      cachedProspectId = lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null;
    } catch {}
  }

  // 1. LP API live — most authoritative when we have an LP lead ID
  if (lpLeadId) {
    try {
      const result = await getLeadByLdsId(lpLeadId);
      const prospects = Array.isArray(result) ? result : [result];
      for (const prospect of prospects) {
        if (!prospect) continue;
        const pid = prospect.ProspectID || prospect.prospectid || prospect.CstID
          || prospect.cst_id || prospect.prospectId || null;
        if (pid) {
          console.log(`[ActionExecutor] LP API resolved prospect ID: ${pid} for lead ${lpLeadId}`);
          return String(pid);
        }
      }
    } catch (err) {
      console.warn(`[ActionExecutor] LP API prospect lookup failed for lead ${lpLeadId}: ${err.message}`);
    }
  }

  // 2. Cached prospect ID from lp_leads
  if (cachedProspectId) {
    console.log(`[ActionExecutor] Using cached prospect ID: ${cachedProspectId} for ${isLPLeadId(contactId) ? `lead ${contactId}` : `contact ${contactId}`}`);
    return cachedProspectId;
  }

  // 3. v3.10 — GHL custom field fallback. Closes the gap where lp_leads
  // has the prospect ID but no ghl_contact_id linkage (~99% of rows).
  // Only meaningful for GHL contact IDs — for LP lead IDs we don't have
  // a GHL contact to fetch.
  if (!isLPLeadId(contactId)) {
    try {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      const fromGhl = readProspectIdFromGhlCustomFields(ghlRes?.contact);
      if (fromGhl) {
        console.log(`[ActionExecutor] Resolved prospect ID from GHL custom field: ${fromGhl} for contact ${contactId}`);
        return fromGhl;
      }
    } catch (err) {
      console.warn(`[ActionExecutor] GHL custom field prospect lookup failed for ${contactId}: ${err.message}`);
    }
  }

  return 'Not in LP';
}

// ═══════════════════════════════════════════════════════════════════
// EVENT CONTEXT — fetch and parse system_events.payload for an action
// ═══════════════════════════════════════════════════════════════════

export async function getEventContext(action) {
  if (!action.event_id) return {};
  try {
    const { data: evt } = await supabase
      .from('system_events')
      .select('payload, event_type, event_subtype')
      .eq('id', action.event_id)
      .maybeSingle();
    if (!evt?.payload) return {};
    const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
    return { ...payload };
  } catch (err) {
    console.error(`[ActionExecutor] Failed to fetch event context for action ${action.id}:`, err.message);
    return {};
  }
}
