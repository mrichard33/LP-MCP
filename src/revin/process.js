/**
 * Process one stored Revin event — src/revin/process.js (2026-10-19)
 *
 * revin_events_raw row → normalize → match the contact (read-only) →
 * contact_messages. Runs after the webhook has answered (trackBackground),
 * and again from the revin-relink job for a row a deploy cut off.
 *
 * Matching, in order, all READ-ONLY (never creates a GHL contact or LP lead):
 *   1. an LP lead id in the payload → lp_leads.ghl_contact_id (resolveContactIdForLead)
 *   2. the phone → the HL contacts mirror (findContactIdByPhone), then, on the
 *      first pass only, a live GHL search (resolveOrCreateContact with create:false)
 *   3. nothing → ghl_contact_id stays null and the event is 'unmatched'; the
 *      relink job tries again (mirror + lp_leads only, so it spends no GHL token).
 * The lead id is filled from the contact's newest lp_leads row when the
 * payload did not carry one.
 *
 * Never throws: a failure is process_status 'error' with the message.
 */
import supabaseDefault from '../supabase.js';
import { resolveContactIdForLead } from '../event-emitter.js';
import { findContactIdByPhone } from '../services/ghl-contact-mirror.js';
import { resolveOrCreateContact } from '../services/ghl-contact-resolve.js';
import { normalizeRevinPayload } from './normalize.js';

export const MAX_ATTEMPTS = 3;

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/** The newest lp_leads row for a phone (phone or phone_alt), or null. */
async function leadByPhone(supabase, phone) {
  const p10 = last10(phone);
  if (!p10) return null;
  for (const col of ['phone', 'phone_alt']) {
    const { data, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id')
      .eq(col, p10)
      .not('ghl_contact_id', 'is', null)
      .order('synced_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`lp_leads by ${col}: ${error.message}`);
    if (data?.[0]) return data[0];
  }
  return null;
}

/** Production deps. Each returns null for "not found"; a thrown error is "could not tell". */
export function defaultDeps(supabase = supabaseDefault) {
  return {
    supabase,
    contactForLead: (leadId) => resolveContactIdForLead(leadId),
    contactForPhone: async (phone, { live = false } = {}) => {
      const mirrored = await findContactIdByPhone(phone);
      if (mirrored) return mirrored;
      const lead = await leadByPhone(supabase, phone);
      if (lead?.ghl_contact_id) return lead.ghl_contact_id;
      if (!live) return null;
      const r = await resolveOrCreateContact({ phone }, { create: false });
      return r?.contactId || null;
    },
    leadForContact: async (contactId) => {
      const { data, error } = await supabase.from('lp_leads')
        .select('lp_lead_id')
        .eq('ghl_contact_id', contactId)
        .order('synced_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(`lp_leads by contact: ${error.message}`);
      return data?.[0]?.lp_lead_id ? String(data[0].lp_lead_id) : null;
    },
  };
}

/** { ghl_contact_id, lp_lead_id } for one normalized row. live = may search GHL. */
export async function matchContact(row, deps, { live = false } = {}) {
  let contact = null;
  let lead = row.lp_lead_id || null;
  if (lead) contact = await deps.contactForLead(lead);
  if (!contact && row.phone_e164) contact = await deps.contactForPhone(row.phone_e164, { live });
  if (contact && !lead) lead = await deps.leadForContact(contact);
  return { ghl_contact_id: contact || null, lp_lead_id: lead || null };
}

/**
 * Process one raw row by id. Returns { status, rows, unmapped_keys, error? }.
 */
export async function processRevinEvent(rawId, { deps = null, live = true, now = () => new Date() } = {}) {
  const d = deps || defaultDeps();
  const db = d.supabase;
  let raw;
  try {
    const { data, error } = await db.from('revin_events_raw').select('*').eq('id', rawId).maybeSingle();
    if (error) throw new Error(error.message);
    raw = data;
  } catch (err) {
    console.warn(`[Revin] read raw ${rawId} failed: ${err.message}`);
    return { status: 'error', rows: 0, error: err.message };
  }
  if (!raw) return { status: 'error', rows: 0, error: 'raw_not_found' };

  const attempts = (raw.attempts || 0) + 1;
  try {
    const { rows, unmapped_keys } = normalizeRevinPayload(raw.payload, { receivedAt: raw.received_at });
    let unmatched = 0;
    const out = [];
    for (const r of rows) {
      const m = await matchContact(r, d, { live });
      if (!m.ghl_contact_id) unmatched += 1;
      out.push({ ...r, ...m, raw_event_id: raw.id });
    }
    if (out.length) {
      const { error } = await db.from('contact_messages')
        .upsert(out, { onConflict: 'source,dedupe_key', ignoreDuplicates: true });
      if (error) throw new Error(`contact_messages: ${error.message}`);
    }
    const status = unmatched ? 'unmatched' : 'ok';
    await db.from('revin_events_raw').update({
      process_status: status, process_error: null, processed_at: now().toISOString(), attempts,
    }).eq('id', raw.id);
    if (unmapped_keys.length) console.log(`[Revin] ${raw.id}: unmapped keys ${unmapped_keys.join(',')}`);
    return { status, rows: out.length, unmapped_keys };
  } catch (err) {
    console.warn(`[Revin] process ${raw.id} failed: ${err.message}`);
    try {
      await db.from('revin_events_raw').update({
        process_status: 'error', process_error: String(err.message).slice(0, 500), processed_at: now().toISOString(), attempts,
      }).eq('id', raw.id);
    } catch { /* the relink job retries a row still pending */ }
    return { status: 'error', rows: 0, error: err.message };
  }
}
