/**
 * Resolvers — src/actions/resolvers.js
 *
 * Contact name/phone resolution, LP prospect ID resolution, event context
 * retrieval. Extracted from action-executor.js v4.2 refactor.
 *
 * Resolution fallback chains are preserved exactly as v3.5–v3.9:
 *   resolveContactInfo: LP Lead (numeric) → GHL → LP cache → payload name
 *   resolveLPProspectId: LP Lead → LP API live → cached prospect_id
 */

import supabase from '../supabase.js';
import { getLeadByLdsId } from '../lp-client.js';
import { isLPLeadId, ghlFetch } from './helpers.js';

const LP_LEAD_COLUMNS =
  'lp_lead_id, lp_prospect_id, ghl_contact_id, first_name, last_name, phone, ' +
  'lead_source, lead_source_detail, disposition_code, disposition_label, rep_name, ' +
  'appointment_set, appointment_date, demo_completed';

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

  if (!lpLeadId) return 'Not in LP';

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

  if (cachedProspectId) {
    console.log(`[ActionExecutor] Using cached prospect ID: ${cachedProspectId} for lead ${lpLeadId}`);
    return cachedProspectId;
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
