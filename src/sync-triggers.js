// ─── Sync Triggers — src/sync-triggers.js ─────────────────────────
//
// Day 15 handoff checks and lead-level GHL tag triggers.
// Run after sync completes to fire tags for qualifying leads.

import supabase from './supabase.js';
import { applyGHLTag } from './ghl.js';
import { REACTIVATION_CUTOFF } from './sync-utils.js';

// ─── Day 15 Handoff Check (single lead) ──────────────────────────
export async function checkDay15Handoff(lpLeadId, ghlContactId, entryDate, disposition) {
  if (!entryDate || !ghlContactId) return;
  if (new Date(entryDate).getTime() < new Date(REACTIVATION_CUTOFF).getTime()) return;
  const daysSinceEntry = (Date.now() - new Date(entryDate).getTime()) / 86400000;
  if (daysSinceEntry < 15) return;
  const closedDispositions = ['sold', 'won', 'closed'];
  if (disposition && closedDispositions.some(d => disposition.toLowerCase().includes(d))) return;

  const success = await applyGHLTag(ghlContactId, 'lp-day15-handoff');
  if (success) {
    await supabase.from('lp_leads')
      .update({ lp_day15_triggered: true }).eq('lp_lead_id', lpLeadId);
    console.log(`[Sync] Day 15 handoff fired for lead ${lpLeadId}`);
  }
}

// ─── Bulk Day 15 Handoff Check ───────────────────────────────────
export async function checkDay15Handoffs() {
  try {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86400000).toISOString();
    const { data: eligibleLeads, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, created_at_lp, last_contact_date')
      .eq('lp_day15_triggered', false).eq('closed_won', false)
      .not('ghl_contact_id', 'is', null)
      .lt('created_at_lp', fifteenDaysAgo)
      .gte('created_at_lp', REACTIVATION_CUTOFF);
    if (error) { console.error('[Sync] Day 15 query failed:', error.message); return; }

    let triggered = 0;
    for (const lead of (eligibleLeads || [])) {
      if (lead.last_contact_date) {
        const lastContact = new Date(lead.last_contact_date);
        if (lastContact.getTime() > Date.now() - 14 * 86400000) continue;
      }
      const success = await applyGHLTag(lead.ghl_contact_id, 'lp-day15-handoff');
      if (success) {
        await supabase.from('lp_leads')
          .update({ lp_day15_triggered: true }).eq('lp_lead_id', lead.lp_lead_id);
        triggered++;
      }
    }
    if (triggered > 0) console.log(`[Sync] Day 15 handoff: ${triggered} leads triggered`);
  } catch (err) {
    console.error('[Sync] Day 15 check failed:', err.message);
  }
}

// ─── Lead-Level Trigger Checks ───────────────────────────────────
export async function checkLeadTriggers() {
  try {
    const { data: demoLeads } = await supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id')
      .eq('demo_completed', true).not('ghl_contact_id', 'is', null)
      .not('raw_lp_data->demo_tag_fired', 'eq', true);
    const { data: wonLeads } = await supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id')
      .eq('closed_won', true).not('ghl_contact_id', 'is', null)
      .not('raw_lp_data->won_tag_fired', 'eq', true);
    for (const lead of (demoLeads || [])) {
      await applyGHLTag(lead.ghl_contact_id, 'lp-demo-completed');
    }
    for (const lead of (wonLeads || [])) {
      await applyGHLTag(lead.ghl_contact_id, 'deal-won');
    }
  } catch (err) {
    console.warn('[Sync] Lead trigger checks failed:', err.message);
  }
}
