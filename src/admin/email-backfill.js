// src/admin/email-backfill.js
// One-time email enrichment backfill for existing GHL contacts
//
// Run via: POST /admin/email-backfill
// Query param: ?dryRun=true for preview (no updates)
// Query param: ?limit=500 to cap batch size

import supabase from '../supabase.js';
import { findBestEmailForProspect } from '../email-scorer.js';
import { emitEvent } from '../event-emitter.js';

export async function runEmailBackfill({ dryRun = true, limit = 500 } = {}) {
  console.log(`[EmailBackfill] Starting ${dryRun ? 'DRY RUN' : 'LIVE RUN'} (limit: ${limit})`);

  // Get all LP leads that have a GHL contact match
  const { data: matchedLeads, error } = await supabase
    .from('lp_leads')
    .select('ghl_contact_id, lp_prospect_id, first_name, last_name')
    .not('ghl_contact_id', 'is', null)
    .not('lp_prospect_id', 'is', null)
    .order('synced_at', { ascending: false });

  if (error) throw new Error(`Query failed: ${error.message}`);

  // Deduplicate by ghl_contact_id (take the newest)
  const contactMap = new Map();
  for (const lead of matchedLeads || []) {
    if (!contactMap.has(lead.ghl_contact_id)) {
      contactMap.set(lead.ghl_contact_id, lead);
    }
  }

  const contacts = Array.from(contactMap.values()).slice(0, limit);
  console.log(`[EmailBackfill] Processing ${contacts.length} unique GHL contacts`);

  const results = { processed: 0, enriched: 0, skipped: 0, errors: 0, details: [] };

  for (const contact of contacts) {
    try {
      const best = await findBestEmailForProspect(contact.lp_prospect_id, {
        firstName: contact.first_name,
        lastName: contact.last_name,
      });

      results.processed++;

      if (!best || best.score < 75) {
        results.skipped++;
        continue;
      }

      if (dryRun) {
        results.enriched++;
        results.details.push({
          ghl_contact_id: contact.ghl_contact_id,
          prospect_id: contact.lp_prospect_id,
          name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
          candidate_email: best.email,
          confidence: best.score,
          reasons: best.reasons,
          source_lead: best.sourceLeadId,
        });
      } else {
        // Emit event for Decision Engine to process
        await emitEvent({
          event_type: 'email.enrichment_available',
          event_subtype: best.score >= 85 ? 'high_confidence' : 'medium_confidence',
          source: 'backfill',
          entity_type: 'contact',
          entity_id: contact.ghl_contact_id,
          ghl_contact_id: contact.ghl_contact_id,
          lp_prospect_id: contact.lp_prospect_id,
          payload: {
            candidate_email: best.email,
            confidence_score: best.score,
            scoring_reasons: best.reasons,
            source_lead_id: best.sourceLeadId,
            prospect_first_name: contact.first_name,
            prospect_last_name: contact.last_name,
          },
          priority: 'low',
          idempotency_key: `backfill_email_${contact.ghl_contact_id}_${best.email}`,
        });
        results.enriched++;
      }
    } catch (err) {
      results.errors++;
      console.error(`[EmailBackfill] Error for ${contact.ghl_contact_id}: ${err.message}`);
    }

    // Throttle to avoid Supabase/GHL rate limits
    if (results.processed % 50 === 0) {
      console.log(`[EmailBackfill] Progress: ${results.processed}/${contacts.length}`);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[EmailBackfill] Complete: ${results.enriched} enriched, ${results.skipped} skipped, ${results.errors} errors`);
  return results;
}
