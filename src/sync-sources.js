// ─── Source Mapping — src/sync-sources.js ─────────────────────────
//
// LP source → GHL intent bucket resolution.
// Seeds default mappings, discovers new sources from lead data,
// and resolves per-lead source to entry tag + intent bucket.

import supabase from './supabase.js';

// Known source → bucket mappings. Add new entries here as Mark classifies them.
//
// 2026-05-23 reclassification (aggregators + direct-digital):
//   The 9 aggregator sources below (Modernize, Lead Gurus, HomeBuddy, Porch,
//   Thinxmg, Fave Marketing, Socius Marketing, GeoTarget, Contractor
//   Appointment) were previously mapped to bucket=estimate-calculator. They
//   are NOT the Reece on-site Estimate Calculator — they are lead-reseller
//   middleware that buys/aggregates homeowner data from various web sources
//   and resells to Reece. These leads have never touched a Reece property,
//   so they get the slow-lane E.5 treatment (entry:other) with credibility-
//   first messaging instead of E.2 calculator-aware messaging.
//
//   Google PPC Windows and Reecewindows.com are direct-Reece digital traffic
//   — these clicked a Reece-owned property before LP saw them. They route
//   through E.7 (entry:high-intent-digital) for the abbreviated fast track.
export const DEFAULT_SOURCE_MAPPINGS = {
  'Canvass':            { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'Home Show':          { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'RV Show':            { bucket: 'canvassing',          tag: 'entry:canvassing' },
  'Tampa Home Show':    { bucket: 'canvassing',          tag: 'entry:canvassing' },
  // ── AGGREGATORS / LEAD RESELLERS → entry:other (E.5) ─────────────
  // These sell aggregated homeowner data to Reece. Lead never touched a
  // Reece property. Credibility-first messaging via E.5 is required —
  // calculator-aware messaging would be a trust-burning lie.
  'Modernize':          { bucket: 'other',               tag: 'entry:other' },
  'Lead Gurus':         { bucket: 'other',               tag: 'entry:other' },
  'HomeBuddy':          { bucket: 'other',               tag: 'entry:other' },
  'Socius Marketing':   { bucket: 'other',               tag: 'entry:other' },
  'GeoTarget':          { bucket: 'other',               tag: 'entry:other' },
  'Thinxmg':            { bucket: 'other',               tag: 'entry:other' },
  'Fave Marketing':     { bucket: 'other',               tag: 'entry:other' },
  'Porch':              { bucket: 'other',               tag: 'entry:other' },
  'Contractor Appointment': { bucket: 'other',           tag: 'entry:other' },
  // ── DIRECT-REECE DIGITAL → entry:high-intent-digital (E.7) ───────
  // Lead clicked a Reece-owned property before LP captured the data.
  // Eligible for E.7 abbreviated indoctrination + faster booking.
  'Google PPC Windows': { bucket: 'high-intent-digital', tag: 'entry:high-intent-digital' },
  'Reecewindows.com':   { bucket: 'high-intent-digital', tag: 'entry:high-intent-digital' },
  // ── REFERRAL ─────────────────────────────────────────────────────
  'Priceless':          { bucket: 'referral',            tag: 'entry:referral' },
  'Employee Referral':  { bucket: 'referral',            tag: 'entry:referral' },
  'Previous Customer':  { bucket: 'referral',            tag: 'entry:referral' },
  'Self Generated':     { bucket: 'referral',            tag: 'entry:referral' },
  'GetTheReferral.Com': { bucket: 'referral',            tag: 'entry:referral' },
  'Job Sign':           { bucket: 'referral',            tag: 'entry:referral' },
  'Customer Referral':  { bucket: 'referral',            tag: 'entry:referral' },
  // ── OTHER (E.5) ──────────────────────────────────────────────────
  'Old Sub Source':     { bucket: 'other',               tag: 'entry:other' },
  'Old Source':         { bucket: 'other',               tag: 'entry:other' },
  'Radio':              { bucket: 'other',               tag: 'entry:other' },
  '92.5':               { bucket: 'other',               tag: 'entry:other' },
  'Peacock':            { bucket: 'other',               tag: 'entry:other' },
  'Direct':             { bucket: 'other',               tag: 'entry:other' },
  'Resource Living':    { bucket: 'other',               tag: 'entry:other' },
  // ── CHATBOT (E.3) ────────────────────────────────────────────────
  'Reece ChatBot':      { bucket: 'chatbot',             tag: 'entry:chatbot' },
  // ── CANVASSING (E.4) — locality variants ─────────────────────────
  'Canvasser, Old Ft Myers': { bucket: 'canvassing',     tag: 'entry:canvassing' },
  'Canvasser, Old St Pete':  { bucket: 'canvassing',     tag: 'entry:canvassing' },
  // ── ESTIMATE CALCULATOR (E.2) — REECE-OWNED ONLY ─────────────────
  // 2026-04-27: The on-site Reece Estimate Calculator form. The "Window
  // Estimator" GHL source on contact_created events corresponds to this
  // subdetail on the LP side. 71 leads since launch (Feb 28 2026).
  // Routes through the estimate-calculator bucket and the W3.1 Estimate
  // Calculator Bridge workflow.
  //
  // NOT in this bucket (intentionally, per 2026-05-23 reclassification):
  //  - Aggregators (Modernize, Lead Gurus, HomeBuddy, Porch, Thinxmg,
  //    Fave Marketing, Socius Marketing, GeoTarget, Contractor Appointment)
  //    — middleware traffic, never touched the Reece calculator.
  //    Routes to entry:other (E.5).
  //  - Reecewindows.com — domain catch-all (rep-entered web leads, Contact
  //    Us forms, callers citing the URL). 2,172 leads, 99.4% no GHL link.
  //    Routes to entry:high-intent-digital (E.7) as direct-Reece traffic.
  //  - Estimate Calculator (Direct Mail) — only a single test lead
  //    ("Mark Test 4", Feb 17 2026, disposition=Data). No real campaign
  //    exists yet. Add here if/when Direct Mail launches a real vanity
  //    URL → calculator funnel.
  'Website Estimate Calculator': { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' },
  // ── 2026-06-24 SOURCE-MAPPING AUDIT ──────────────────────────────
  // A manual 2026-06-17 table edit swept ~131 aggregator/affiliate/media
  // sources onto the wrong track: bucket=paid-internet/entry:high-intent-
  // digital (E.7 fast lane) or bucket=media/entry:estimate-calculator (a
  // tag/bucket contradiction). Neither `paid-internet` nor `media` is a
  // real bucket — no E.0 router branch consumes them; both are RETIRED.
  // Governing rule: only Reece-OWNED property touches earn high-intent /
  // calculator / risk-report. Everyone below is reseller middleware or
  // offline media → credibility-first E.5 (entry:other). Seeding them
  // here makes populateSourceMapping() self-heal so the table can't
  // re-drift to the dead buckets.
  //
  // Two carve-outs are Reece-owned funnels, not reseller/media:
  'HomeRiskReport':      { bucket: 'risk-report',         tag: 'entry:risk-report' },         // E.1 — Reece risk-report funnel
  'Estimate Calculator': { bucket: 'estimate-calculator', tag: 'entry:estimate-calculator' }, // E.2 — Reece on-site calculator
  // ── Aggregators / lead resellers / affiliates → entry:other (E.5) ──
  'ADM':                              { bucket: 'other', tag: 'entry:other' },
  'Adopt A Contractor':               { bucket: 'other', tag: 'entry:other' },
  'Andy\'s Provisions':               { bucket: 'other', tag: 'entry:other' },
  'Astoria Company':                  { bucket: 'other', tag: 'entry:other' },
  'BC Marketing':                     { bucket: 'other', tag: 'entry:other' },
  'Bid Huddle':                       { bucket: 'other', tag: 'entry:other' },
  'Bing Organic':                     { bucket: 'other', tag: 'entry:other' },
  'Bing PPC':                         { bucket: 'other', tag: 'entry:other' },
  'BlueFireLeads':                    { bucket: 'other', tag: 'entry:other' },
  'BuyerLink':                        { bucket: 'other', tag: 'entry:other' },
  'Centah':                           { bucket: 'other', tag: 'entry:other' },
  'Clever':                           { bucket: 'other', tag: 'entry:other' },
  'Cognitive Contractor':             { bucket: 'other', tag: 'entry:other' },
  'Concrete Digital':                 { bucket: 'other', tag: 'entry:other' },
  'Contractor Appointment Rev Share': { bucket: 'other', tag: 'entry:other' },
  'Contractor Appointment-East':      { bucket: 'other', tag: 'entry:other' },
  'Contractor Appointment-West':      { bucket: 'other', tag: 'entry:other' },
  'Contractor Clicks':                { bucket: 'other', tag: 'entry:other' },
  'CraftJack':                        { bucket: 'other', tag: 'entry:other' },
  'CreativeClicks':                   { bucket: 'other', tag: 'entry:other' },
  'Discovery PPC-Email':              { bucket: 'other', tag: 'entry:other' },
  'DT Marketing':                     { bucket: 'other', tag: 'entry:other' },
  'E Local':                          { bucket: 'other', tag: 'entry:other' },
  'Elite Marketing':                  { bucket: 'other', tag: 'entry:other' },
  'Facebook':                         { bucket: 'other', tag: 'entry:other' },
  'Facebook Organic':                 { bucket: 'other', tag: 'entry:other' },
  'Fortifi':                          { bucket: 'other', tag: 'entry:other' },
  'FullThrottleAI':                   { bucket: 'other', tag: 'entry:other' },
  'Fused Leads':                      { bucket: 'other', tag: 'entry:other' },
  'Google PPC PMAX':                  { bucket: 'other', tag: 'entry:other' },
  'Google PPC Roofs':                 { bucket: 'other', tag: 'entry:other' },
  'Google Service Ads':               { bucket: 'other', tag: 'entry:other' },
  'Hello Project':                    { bucket: 'other', tag: 'entry:other' },
  'HercuLeads':                       { bucket: 'other', tag: 'entry:other' },
  'HH Marketing':                     { bucket: 'other', tag: 'entry:other' },
  'Home Advisor':                     { bucket: 'other', tag: 'entry:other' },
  'Home Solutions':                   { bucket: 'other', tag: 'entry:other' },
  'Home4Quotes':                      { bucket: 'other', tag: 'entry:other' },
  'HomeYou':                          { bucket: 'other', tag: 'entry:other' },
  'HR Data Leads':                    { bucket: 'other', tag: 'entry:other' },
  'HR Leads':                         { bucket: 'other', tag: 'entry:other' },
  'Hurricane Prep Download':          { bucket: 'other', tag: 'entry:other' },
  'Instagram Organic':                { bucket: 'other', tag: 'entry:other' },
  'J&J Marketing':                    { bucket: 'other', tag: 'entry:other' },
  'LeadPilot':                        { bucket: 'other', tag: 'entry:other' },
  'LeadPilotData':                    { bucket: 'other', tag: 'entry:other' },
  'MVP Marketing':                    { bucket: 'other', tag: 'entry:other' },
  'My Base Guide':                    { bucket: 'other', tag: 'entry:other' },
  'MyHomePros':                       { bucket: 'other', tag: 'entry:other' },
  'Networx':                          { bucket: 'other', tag: 'entry:other' },
  'PJ Marketing':                     { bucket: 'other', tag: 'entry:other' },
  'Porch101':                         { bucket: 'other', tag: 'entry:other' },
  'Prolific Marketing':               { bucket: 'other', tag: 'entry:other' },
  'ProRemodel':                       { bucket: 'other', tag: 'entry:other' },
  'Quality Products':                 { bucket: 'other', tag: 'entry:other' },
  'Quinstreet':                       { bucket: 'other', tag: 'entry:other' },
  'Remodel Well':                     { bucket: 'other', tag: 'entry:other' },
  'Remodeling.com':                   { bucket: 'other', tag: 'entry:other' },
  'Renew':                            { bucket: 'other', tag: 'entry:other' },
  'RGR Marketing':                    { bucket: 'other', tag: 'entry:other' },
  'RMP-Facebook':                     { bucket: 'other', tag: 'entry:other' },
  'RMP-Google':                       { bucket: 'other', tag: 'entry:other' },
  'RoofMarketingProsFCBK':            { bucket: 'other', tag: 'entry:other' },
  'RoofMarketingProsGOOG':            { bucket: 'other', tag: 'entry:other' },
  'Seabreeze':                        { bucket: 'other', tag: 'entry:other' },
  'Stone Canyon AI':                  { bucket: 'other', tag: 'entry:other' },
  'TD! Marketing':                    { bucket: 'other', tag: 'entry:other' },
  'USATodayFlashSale':                { bucket: 'other', tag: 'entry:other' },
  'USMarketingGroup':                 { bucket: 'other', tag: 'entry:other' },
  'YouTube Organic':                  { bucket: 'other', tag: 'entry:other' },
  'Zone 1 Remodeling':                { bucket: 'other', tag: 'entry:other' },
  // ── Offline media (TV / radio / magazine / mail / newspaper) → E.5 ──
  // Problem/solution-aware but NOT Reece-product-aware; never touched the
  // calculator. High close rates are a selection effect, not temperature.
  '5 Star':                           { bucket: 'other', tag: 'entry:other' },
  'ABC W.C. TV Ad':                   { bucket: 'other', tag: 'entry:other' },
  'ASVN-TV: ABC':                     { bucket: 'other', tag: 'entry:other' },
  'Best Pick':                        { bucket: 'other', tag: 'entry:other' },
  'BestDealBooks':                    { bucket: 'other', tag: 'entry:other' },
  'BestProMag':                       { bucket: 'other', tag: 'entry:other' },
  'Car Dash':                         { bucket: 'other', tag: 'entry:other' },
  'CLiPP':                            { bucket: 'other', tag: 'entry:other' },
  'Digital Audio-Rain':               { bucket: 'other', tag: 'entry:other' },
  'FB 25k':                           { bucket: 'other', tag: 'entry:other' },
  'Fox - Tampa':                      { bucket: 'other', tag: 'entry:other' },
  'HomeConcepts':                     { bucket: 'other', tag: 'entry:other' },
  'IHeart TV Spot':                   { bucket: 'other', tag: 'entry:other' },
  'Lifestyle Magazine':               { bucket: 'other', tag: 'entry:other' },
  'N2 PubMag':                        { bucket: 'other', tag: 'entry:other' },
  'NBC - Peacock OTT 2023':           { bucket: 'other', tag: 'entry:other' },
  'NBC WFLA OTT - East':              { bucket: 'other', tag: 'entry:other' },
  'NBC WFLA OTT - West':              { bucket: 'other', tag: 'entry:other' },
  'Our City Mag':                     { bucket: 'other', tag: 'entry:other' },
  'Peacock TV':                       { bucket: 'other', tag: 'entry:other' },
  'PodCast':                          { bucket: 'other', tag: 'entry:other' },
  'Radio Call In':                    { bucket: 'other', tag: 'entry:other' },
  'Sarasota News Network':            { bucket: 'other', tag: 'entry:other' },
  'Simpletext':                       { bucket: 'other', tag: 'entry:other' },
  'SNN':                              { bucket: 'other', tag: 'entry:other' },
  'Spectrum BayNews9':                { bucket: 'other', tag: 'entry:other' },
  'TheHomeMag':                       { bucket: 'other', tag: 'entry:other' },
  'USA E-Edition':                    { bucket: 'other', tag: 'entry:other' },
  'USA Today NewsPaper':              { bucket: 'other', tag: 'entry:other' },
  'USA Today-DirectMail':             { bucket: 'other', tag: 'entry:other' },
  'USA Today-Hurricane Mailer':       { bucket: 'other', tag: 'entry:other' },
  'USA Today-PC Letter':              { bucket: 'other', tag: 'entry:other' },
  'WBGG-Save':                        { bucket: 'other', tag: 'entry:other' },
  'WFEZ- glass':                      { bucket: 'other', tag: 'entry:other' },
  'WHQT-safe':                        { bucket: 'other', tag: 'entry:other' },
  'WinkHurricaneGuide':               { bucket: 'other', tag: 'entry:other' },
  'WIRK-now':                         { bucket: 'other', tag: 'entry:other' },
  'WKGR-home':                        { bucket: 'other', tag: 'entry:other' },
  'WMXJ-wind':                        { bucket: 'other', tag: 'entry:other' },
  'WPEC-TV: LOCK':                    { bucket: 'other', tag: 'entry:other' },
  'WPLG-News':                        { bucket: 'other', tag: 'entry:other' },
  'WPTV-Map':                         { bucket: 'other', tag: 'entry:other' },
  'WRMF: WAVE':                       { bucket: 'other', tag: 'entry:other' },
  'WSVN-TV: FOX':                     { bucket: 'other', tag: 'entry:other' },
  'YGrene Win15k':                    { bucket: 'other', tag: 'entry:other' },
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

// The queue records EXISTENCE of an unmapped source and one sample lead.
// Nothing more.
//
// 2026-09-04 — the counter is gone. The old body incremented lead_count on
// every resolution attempt, which is once per lead PER SYNC PASS, not once per
// lead. It accumulated passes forever: "Contractor Appointment Rev Share" read
// 211,656 against 28,345 actual lp_leads rows and 179 leads in 90 days — a
// figure larger than the entire lp_leads table. Ranking mapping work by it sent
// you to dead sources first. Real volume now comes from v_source_volume_90d.
//
// The read that drove that update was broken too: it matched on
// `sourceSubdetail || ''` — empty string — while the insert wrote `null`, so it
// never found its own rows and inserted duplicates instead.
//
// insert-if-absent (ignoreDuplicates) is deliberate. It costs one write per NEW
// source instead of one per lead, and it cannot overwrite a row a human has
// already marked reviewed. Correctness depends on idx_unmapped_src being
// NULLS NOT DISTINCT — see sql/migrations/2026-09-04_source_queue_repair.sql.
async function logUnmappedSource(sourceSubdetail, sourceRaw, lpLeadId) {
  try {
    if (!sourceSubdetail && !sourceRaw) return;
    const key = `${sourceSubdetail || ''}|${sourceRaw || ''}`;
    if (!loggedUnmappedSources.has(key)) {
      loggedUnmappedSources.add(key);
      console.log(`[Sync] Unmapped source: subdetail="${sourceSubdetail}", raw="${sourceRaw}"`);
    }
    await supabase.from('lp_unmapped_sources').upsert({
      source_subdetail:  sourceSubdetail || null,
      source_raw:        sourceRaw || null,
      sample_lp_lead_id: lpLeadId || null,
    }, { onConflict: 'source_subdetail,source_raw', ignoreDuplicates: true });
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
