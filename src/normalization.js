import supabase from './supabase.js';
import { applyGHLTag } from './ghl.js';

// Source normalization protocol — v3 (sourcesubdescr primary, source fallback)
export async function normalizeSourceAndTag(lpLead, ghlContactId) {
  let mapping = null;

  // Step 1: Try sourcesubdescr first (primary intent signal)
  if (lpLead.sourcesubdescr) {
    const { data } = await supabase
      .from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_subdetail', lpLead.sourcesubdescr)
      .single();
    mapping = data;
  }

  // Step 2: Fallback to source parent field if no subdetail match
  if (!mapping && lpLead.source) {
    const { data } = await supabase
      .from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_raw', lpLead.source)
      .is('lp_source_subdetail', null)
      .single();
    mapping = data;
  }

  // Step 3: Default to 'other' if still no match
  const bucket = mapping?.ghl_intent_bucket || 'other';
  const tag = mapping?.ghl_entry_tag || 'entry:other';

  // Step 4: Write resolved bucket and tag to Supabase
  await supabase.from('lp_leads').update({
    ghl_intent_bucket: bucket,
    ghl_entry_tag: tag,
  }).eq('lp_lead_id', lpLead.lp_lead_id);

  // Step 5: Apply tag in GHL if contact matched and tag not yet applied
  if (ghlContactId && !lpLead.ghl_tag_applied) {
    const success = await applyGHLTag(ghlContactId, tag);
    if (success) {
      await supabase.from('lp_leads')
        .update({ ghl_tag_applied: true })
        .eq('lp_lead_id', lpLead.lp_lead_id);
    }
  }

  // Step 6: Log unmapped sources for weekly review
  if (!mapping) {
    await logUnmappedSource(lpLead.sourcesubdescr, lpLead.source, lpLead.lp_lead_id);
  }

  return { bucket, tag, mapped: !!mapping };
}

async function logUnmappedSource(sourceSubdetail, sourceRaw, sampleLeadId) {
  try {
    await supabase.from('lp_unmapped_sources').upsert({
      source_subdetail: sourceSubdetail || null,
      source_raw: sourceRaw || null,
      sample_lp_lead_id: sampleLeadId,
    }, { onConflict: 'source_subdetail,source_raw' });
  } catch (err) {
    console.error('[Normalization] Failed to log unmapped source:', err.message);
  }
}
