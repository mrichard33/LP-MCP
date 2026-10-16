// ─── Sync Triggers — src/sync-triggers.js ─────────────────────────
//
// Day 15 handoff checks and lead-level GHL tag triggers.
// Run after sync completes to fire tags for qualifying leads.
//
// 2026-10-11 — Day 15 fires for a contact's CURRENT LP lead only.
// Frances Overton (wkUjSVicxP6918ll9nHc) filled in the calculator (LP lead
// 582736); LP sync linked her nine older leads to the same contact, and this
// file tagged lp-day15-handoff from 447061 / 386011 — 15+ days old each — on a
// contact whose live lead was hours old. Six more contacts were tagged the same
// way. Each lead is now judged against the contact's current lead
// (pickCurrentLead in src/current-lead.js, the one definition the decision
// engine's older_lead guard and field sync use). A superseded lead is marked
// lp_day15_triggered=true so it is not re-read every pass, and the reason is an
// lp_trigger_log row (event 'day15_handoff', status 'suppressed'). Not
// raw_lp_data: sync-leads.js rewrites that column from LP on every upsert, so a
// marker kept there would vanish on the lead's next change.

import supabase from './supabase.js';
import { applyGHLTag } from './ghl.js';
import { REACTIVATION_CUTOFF } from './sync-utils.js';
import { pickCurrentLead, fetchCurrentLead } from './current-lead.js';

export const DAY15_TAG = 'lp-day15-handoff';
export const DAY15_SUPERSEDED = 'superseded_by_newer_lead';

const SIBLING_SELECT = 'lp_lead_id, ghl_contact_id, disposition_code, appointment_date, created_at_lp, updated_at_lp, lp_deleted_at';
// PostgREST answers at most 1,000 rows. 25 contacts keeps a chunk well under it;
// a chunk that comes back full is treated as unreadable rather than trusted.
const CONTACT_CHUNK = 25;
const PAGE_CAP = 1000;

/**
 * Pure: should this lead fire Day 15, given every lp_leads row on its contact?
 * 'suppress' when another lead is the contact's current lead.
 */
export function day15Verdict(lead, contactLeads) {
  const rows = Array.isArray(contactLeads) ? [...contactLeads] : [];
  if (!rows.some(r => String(r.lp_lead_id) === String(lead.lp_lead_id))) rows.push(lead);
  const current = pickCurrentLead(rows.filter(r => !r.lp_deleted_at));
  if (current && String(current.lp_lead_id) !== String(lead.lp_lead_id)) {
    return { action: 'suppress', currentLeadId: String(current.lp_lead_id) };
  }
  return { action: 'fire' };
}

async function logTrigger(db, row) {
  try {
    await db.from('lp_trigger_log').insert({ event: 'day15_handoff', tag_fired: DAY15_TAG, ...row });
  } catch (err) {
    console.warn(`[Sync] Day 15 log write failed for lead ${row.lp_lead_id}: ${err.message}`);
  }
}

async function markDay15Suppressed(db, lpLeadId, ghlContactId, currentLeadId) {
  await db.from('lp_leads').update({ lp_day15_triggered: true }).eq('lp_lead_id', lpLeadId);
  await logTrigger(db, {
    lp_lead_id: String(lpLeadId), ghl_contact_id: ghlContactId, tag_fired: null,
    // lead-id-ok: error_detail on a trigger row, not a card
    status: 'suppressed', error_detail: `${DAY15_SUPERSEDED}: current lead ${currentLeadId}`,
  });
  console.log(`[Sync] Day 15 suppressed for lead ${lpLeadId} — newer lead ${currentLeadId} is current for ${ghlContactId}`);
}

/**
 * Every lp_leads row for these contacts, as Map<contactId, rows[]>. A contact
 * whose chunk could not be read is ABSENT from the map: the caller skips it
 * (fail closed — an unreadable contact is never tagged).
 */
export async function readContactLeads(db, contactIds) {
  const out = new Map();
  const ids = [...new Set(contactIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += CONTACT_CHUNK) {
    const chunk = ids.slice(i, i + CONTACT_CHUNK);
    const { data, error } = await db.from('lp_leads')
      .select(SIBLING_SELECT).in('ghl_contact_id', chunk).limit(PAGE_CAP);
    if (error || !Array.isArray(data) || data.length >= PAGE_CAP) {
      console.warn(`[Sync] Day 15 sibling read skipped ${chunk.length} contacts: ${error?.message || 'page full'}`);
      continue;
    }
    for (const id of chunk) out.set(id, []);
    for (const row of data) out.get(String(row.ghl_contact_id))?.push(row);
  }
  return out;
}

// ─── Day 15 Handoff Check (single lead) ──────────────────────────
// Callers pass LP's entry date and disposition; the contact's current lead
// from lp_leads decides first (sync-children.js passes the prospect's FIRST
// lead's values, which need not be this lead's).
export async function checkDay15Handoff(lpLeadId, ghlContactId, entryDate, disposition, deps = {}) {
  if (!ghlContactId) return;
  const db = deps.supabase !== undefined ? deps.supabase : supabase;
  const tag = deps.applyGHLTag || applyGHLTag;
  let current = null;
  try {
    current = await (deps.fetchCurrentLead || fetchCurrentLead)(ghlContactId, db);
  } catch (err) {
    console.warn(`[Sync] Day 15 skipped for lead ${lpLeadId}: current-lead read failed: ${err.message}`);
    return;
  }
  if (current && String(current.lp_lead_id) !== String(lpLeadId)) {
    await markDay15Suppressed(db, lpLeadId, ghlContactId, current.lp_lead_id);
    return;
  }
  const entry = current?.created_at_lp || entryDate;
  const disp = current?.disposition_code ?? disposition;
  if (!entry) return;
  if (new Date(entry).getTime() < new Date(REACTIVATION_CUTOFF).getTime()) return;
  const daysSinceEntry = ((deps.nowMs ?? Date.now()) - new Date(entry).getTime()) / 86400000;
  if (daysSinceEntry < 15) return;
  const closedDispositions = ['sold', 'won', 'closed'];
  if (disp && closedDispositions.some(d => disp.toLowerCase().includes(d))) return;

  const success = await tag(ghlContactId, DAY15_TAG);
  if (success) {
    await db.from('lp_leads')
      .update({ lp_day15_triggered: true }).eq('lp_lead_id', lpLeadId);
    await logTrigger(db, { lp_lead_id: String(lpLeadId), ghl_contact_id: ghlContactId, status: 'success' });
    console.log(`[Sync] Day 15 handoff fired for lead ${lpLeadId}`);
  }
}

// ─── Bulk Day 15 Handoff Check ───────────────────────────────────
export async function checkDay15Handoffs(deps = {}) {
  const db = deps.supabase !== undefined ? deps.supabase : supabase;
  const tag = deps.applyGHLTag || applyGHLTag;
  const nowMs = deps.nowMs ?? Date.now();
  const stats = { triggered: 0, suppressed: 0, unreadable: 0 };
  try {
    const fifteenDaysAgo = new Date(nowMs - 15 * 86400000).toISOString();
    const { data: eligibleLeads, error } = await db.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, created_at_lp, last_contact_date')
      .eq('lp_day15_triggered', false).eq('closed_won', false)
      .not('ghl_contact_id', 'is', null)
      .lt('created_at_lp', fifteenDaysAgo)
      .gte('created_at_lp', REACTIVATION_CUTOFF);
    if (error) { console.error('[Sync] Day 15 query failed:', error.message); return stats; }

    const due = (eligibleLeads || []).filter(lead =>
      !(lead.last_contact_date && new Date(lead.last_contact_date).getTime() > nowMs - 14 * 86400000));
    if (due.length === 0) return stats;

    // One batched read of every lead on these contacts, not one per lead.
    const byContact = await readContactLeads(db, due.map(l => l.ghl_contact_id));

    for (const lead of due) {
      const siblings = byContact.get(String(lead.ghl_contact_id));
      if (!siblings) { stats.unreadable++; continue; }
      const verdict = day15Verdict(lead, siblings);
      if (verdict.action === 'suppress') {
        await markDay15Suppressed(db, lead.lp_lead_id, lead.ghl_contact_id, verdict.currentLeadId);
        stats.suppressed++;
        continue;
      }
      const success = await tag(lead.ghl_contact_id, DAY15_TAG);
      if (success) {
        await db.from('lp_leads')
          .update({ lp_day15_triggered: true }).eq('lp_lead_id', lead.lp_lead_id);
        await logTrigger(db, { lp_lead_id: String(lead.lp_lead_id), ghl_contact_id: lead.ghl_contact_id, status: 'success' });
        console.log(`[Sync] Day 15 handoff fired for lead ${lead.lp_lead_id}`);
        stats.triggered++;
      }
    }
    if (stats.triggered || stats.suppressed || stats.unreadable) {
      console.log(`[Sync] Day 15 handoff: ${stats.triggered} triggered, ${stats.suppressed} suppressed (newer lead), ${stats.unreadable} unreadable`);
    }
  } catch (err) {
    console.error('[Sync] Day 15 check failed:', err.message);
  }
  return stats;
}

// ─── Lead-Level Trigger Checks ───────────────────────────────────
export async function checkLeadTriggers() {
  // 2026-10-11 — the `lp-demo-completed` half of this function is GONE too.
  // It filtered on NOT (raw_lp_data->demo_tag_fired = true), and a missing key
  // makes that NULL, not true: it matched 0 of 7,836 demo_completed leads and
  // never tagged anyone. The tag on Frances Overton came from field sync
  // (maybeStampDemoTag in src/ghl-field-sync.js, DEMO_TAG_SYNC_MODE=live), which
  // now stamps only the CURRENT sales cycle's demo (demoInCurrentCycle in
  // src/demo-truth.js). Do NOT revive this one either: it keyed on LP's sat flag
  // (which counts NOC, not a demo), its raw_lp_data marker is rewritten by every
  // lead upsert, and a working filter would add the tag to thousands of
  // contacts at once.
  //
  // 2026-10-03 — the `deal-won` half of this function is GONE. It filtered on
  // raw_lp_data->won_tag_fired, a key no lp_leads row has ever carried, so it
  // matched 0 of 3,377 won leads and never tagged anyone: `deal-won` came only
  // from GHL I.LP-IN, and when LP's webhook stopped on 2026-09-24 the P2 cards
  // stopped with it. Do NOT "fix" the filter: it would tag every historical
  // won lead and start C.0 customer onboarding for years-old sales. Recent
  // sales are covered by src/p2-sale-backstop.js (bounded lookback, grace,
  // per-pass cap, live GHL check).
}
