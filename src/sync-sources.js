// ─── Source Mapping — src/sync-sources.js ─────────────────────────
//
// LP source → GHL intent bucket resolution.
// Seeds default mappings, discovers new sources from lead data,
// and resolves per-lead source to entry tag + intent bucket.

import supabase from './supabase.js';

// Known source → bucket mappings. Add new entries here as Ryan classifies them.
export const DEFAULT_SOURCE_MAPPINGS = {
  'Canvass':            { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'Home Show':          { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'RV Show':            { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'Tampa Home Show':    { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'Modernize':          { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Lead Gurus':         { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Priceless':          { bucket: 'referral',            tag: 'entry:referral' },
  'Employee Referral':  { bucket: 'referral',            tag: 'entry:referral' },
  'Previous Customer':  { bucket: 'referral',            tag: 'entry:referral' },
  'Self Generated':     { bucket: 'referral',            tag: 'entry:referral' },
  'Old Sub Source':     { bucket: 'other',               tag: 'entry:other' },
  'Old Source':         { bucket: 'other',               tag: 'entry:other' },
  'Reece ChatBot':      { bucket: 'chatbot',             tag: 'entry:chatbot' },
  'HomeBuddy':          { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Socius Marketing':   { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'GeoTarget':          { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Thinxmg':            { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Fave Marketing':     { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Porch':              { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Contractor Appointment': { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  // 2026-04-27: The on-site Estimate Calculator form ("Window Estimator"
  // GHL source). 71 leads to date with the canonical "Website Estimate
  // Calculator" subdetail label, plus 1 Direct Mail vanity-URL lead with
  // the "Estimate Calculator" subdetail. NOT included: Reecewindows.com —
  // that's a generic "came through the website domain" catch-all (rep-
  // entered web leads, Contact Us forms, callers citing the URL) and
  // routes to entry:other.
  'Website Estimate Calculator': { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'Estimate Calculator':         { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  'GetTheReferral.Com': { bucket: 'referral',            tag: 'entry:referral' },
  'Job Sign':           { bucket: 'referral',            tag: 'entry:referral' },
  'Customer Referral':  { bucket: 'referral',            tag: 'entry:referral' },
  'Canvasser, Old Ft Myers': { bucket: 'canvassing',     tag: 'entry:canvassing' },
  'Canvasser, Old St Pete':  { bucket: 'canvassing',     tag: 'entry:canvassing' },
  'Radio':              { bucket: 'other',               tag: 'entry:other' },
  '92.5':               { bucket: 'other',               tag: 'entry:other' },
  'Peacock':            { bucket: 'other',               tag: 'entry:other' },
  'Direct':             { bucket: 'other',               tag: 'entry:other' },
  'Resource Living':    { bucket: 'other',               tag: 'entry:other' },
};

export async function populateSourceMapping() {
  try {
    let defaultsSeeded = 0;
    for (const [sourceKey, mapping] of Object.entries(DEFAULT_SOURCE_MAPPINGS)) {
      const { data: existing } = await supabase.from('lp_source_mapping')
        .select('id').eq('lp_source_subdetail', sourceKey).maybeSingle();
      if (existing) {
        await supabase.from('lp_source_mapping')
          .update({ ghl_intent_bucket: mapping.bucket, ghl_entry_tag: mapping.tag, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
        defaultsSeeded++;
      } else {
        const { error } = await supabase.from('lp_source_mapping').insert({
          lp_source_subdetail: sourceKey, lp_source_raw: null,
          ghl_intent_bucket: mapping.bucket, ghl_entry_tag: mapping.tag,
        });
        if (!error) defaultsSeeded++;
        else console.warn(`[Sync] Failed to seed default mapping "${sourceKey}":`, error.message);
      }
    }
    let rawFallbacks = 0;
    for (const [sourceKey, mapping] of Object.entries(DEFAULT_SOURCE_MAPPINGS)) {
      const { data: existingRaw } = await supabase.from('lp_source_mapping')
        .select('id').eq('lp_source_raw', sourceKey).is('lp_source_subdetail', null).maybeSingle();
      if (!existingRaw) {
        const { error } = await supabase.from('lp_source_mapping').insert({
          lp_source_subdetail: null, lp_source_raw: sourceKey,
          ghl_intent_bucket: mapping.bucket, ghl_entry_tag: mapping.tag,
        });
        if (!error) rawFallbacks++;
      }
    }
    console.log(`[Sync] Source mapping: ${defaultsSeeded}/${Object.keys(DEFAULT_SOURCE_MAPPINGS).length} defaults seeded, ${rawFallbacks} raw fallbacks added`);
    return defaultsSeeded + rawFallbacks;
  } catch (err) {
    console.warn('[Sync] Source enumeration failed:', err.message);
    return 0;
  }
}

export async function backfillSourceMappingsFromLeads() {
  try {
    const allSources = new Map();
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data } = await supabase.from('lp_leads')
        .select('lead_source_detail, lead_source')
        .not('lead_source_detail', 'is', null)
        .range(offset, offset + pageSize - 1);
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (r.lead_source_detail && !allSources.has(r.lead_source_detail)) {
          allSources.set(r.lead_source_detail, r.lead_source);
        }
      }
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    if (allSources.size === 0) {
      console.log('[Sync] Source backfill: no source data found in lp_leads');
      return 0;
    }
    let added = 0;
    for (const [subdetail, raw] of allSources) {
      const { data: existing } = await supabase.from('lp_source_mapping')
        .select('id, ghl_intent_bucket').eq('lp_source_subdetail', subdetail).maybeSingle();
      if (!existing) {
        const { error } = await supabase.from('lp_source_mapping').insert({
          lp_source_subdetail: subdetail, lp_source_raw: raw,
          ghl_intent_bucket: 'unmapped', ghl_entry_tag: 'entry:unmapped',
          notes: 'Auto-discovered from lead data — needs classification',
        });
        if (!error) added++;
      }
    }
    console.log(`[Sync] Source backfill: ${added} new mappings from ${allSources.size} distinct sources in lp_leads`);
    return added;
  } catch (err) {
    console.warn('[Sync] Source backfill from leads failed:', err.message);
    return 0;
  }
}

// Track already-logged unmapped sources to avoid log spam
const loggedUnmappedSources = new Set();

async function logUnmappedSource(sourceSubdetail, sourceRaw, lpLeadId) {
  try {
    if (!sourceSubdetail && !sourceRaw) return;
    const key = `${sourceSubdetail || ''}|${sourceRaw || ''}`;
    if (!loggedUnmappedSources.has(key)) {
      loggedUnmappedSources.add(key);
      console.log(`[Sync] Unmapped source: subdetail="${sourceSubdetail}", raw="${sourceRaw}"`);
    }
    const { data: existing } = await supabase.from('lp_unmapped_sources')
      .select('id, lead_count')
      .eq('source_subdetail', sourceSubdetail || '')
      .eq('source_raw', sourceRaw || '')
      .maybeSingle();
    if (existing) {
      await supabase.from('lp_unmapped_sources')
        .update({ lead_count: (existing.lead_count || 0) + 1, sample_lp_lead_id: lpLeadId || existing.sample_lp_lead_id })
        .eq('id', existing.id);
    } else {
      await supabase.from('lp_unmapped_sources').insert({
        source_subdetail: sourceSubdetail || null, source_raw: sourceRaw || null,
        lead_count: 1, sample_lp_lead_id: lpLeadId || null,
      });
    }
  } catch (err) {
    // Non-critical — don't break sync for mapping analytics
  }
}

export async function resolveSourceBucket(sourcesubdescr, source, lpLeadId) {
  if (sourcesubdescr) {
    const { data, error } = await supabase.from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_subdetail', sourcesubdescr).maybeSingle();
    if (error) console.warn(`[Sync] Source lookup error for subdetail="${sourcesubdescr}":`, error.message);
    if (data && data.ghl_intent_bucket !== 'unmapped') {
      return { bucket: data.ghl_intent_bucket, tag: data.ghl_entry_tag };
    }
  }
  if (source) {
    const { data, error } = await supabase.from('lp_source_mapping')
      .select('ghl_intent_bucket, ghl_entry_tag')
      .eq('lp_source_raw', source).is('lp_source_subdetail', null).maybeSingle();
    if (error) console.warn(`[Sync] Source lookup error for raw="${source}":`, error.message);
    if (data && data.ghl_intent_bucket !== 'unmapped') {
      return { bucket: data.ghl_intent_bucket, tag: data.ghl_entry_tag };
    }
  }
  await logUnmappedSource(sourcesubdescr, source, lpLeadId);
  return { bucket: 'other', tag: 'entry:other' };
}
