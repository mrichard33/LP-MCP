import { z } from 'zod';
import supabase from '../supabase.js';
import { runSourceReconcile } from '../jobs/source-reconcile.js';

// Helper: fetch disposition labels + categories from lp_dispositions table
async function getDispositionMap() {
  const { data } = await supabase
    .from('lp_dispositions')
    .select('disposition_code, disposition_label, category, is_recoverable');
  const map = {};
  for (const d of (data || [])) {
    map[d.disposition_code] = { label: d.disposition_label, category: d.category, is_recoverable: d.is_recoverable };
  }
  return map;
}

export function registerSourceTools(server) {

  // Tool 12: get_leads_needing_mapping
  //
  // 2026-09-04 — reads the RECONCILED gap (LP's own source catalog diffed
  // against lp_source_mapping), not the raw lp_unmapped_sources queue.
  //
  // The queue was wrong 547 times out of 552: 372 of its rows were already
  // mapped, 175 were duplicate NULL rows from a unique index that treated NULLs
  // as distinct, and 5 were real. Ranking was worse than the list — it ordered
  // by lead_count, which counted sync cycles rather than leads, so the top of
  // the list was whichever dead source had been re-synced most. Both are fixed:
  // the gap comes from the reconciler and the ranking from v_source_volume_90d.
  server.tool(
    'get_leads_needing_mapping',
    'LP sources with no lp_source_mapping entry, ranked by real 90-day lead volume. Data maintenance.',
    {
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async ({ limit = 50 }) => {
      try {
        // alert:false — a read must never emit an event.
        const report = await runSourceReconcile({}, { alert: false });
        if (report.skipped) {
          return { content: [{ type: 'text', text: `Error: ${report.reason}` }] };
        }
        const sources = report.unmapped.slice(0, limit);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total_unmapped: report.unmapped.length,
              lp_catalog_size: report.catalog_count,
              ranked_by: 'leads_90d (v_source_volume_90d) — NOT the retired lp_unmapped_sources.lead_count',
              sources,
              action: 'Map each source to a GHL intent bucket in lp_source_mapping. Unmapped sources route to entry:other.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // Tool 12b: get_source_catalog_health
  server.tool(
    'get_source_catalog_health',
    'Diffs LP\'s authoritative source catalog against lp_source_mapping: unmapped, orphaned and dormant sources, ranked by real 90-day volume. Read-only — never creates a mapping.',
    {
      limit: z.number().optional().describe('Max rows per diff (default 25)'),
      include_dormant: z.boolean().optional().describe('Include mapped sources with zero leads in 90 days (default true)'),
    },
    async ({ limit = 25, include_dormant = true }) => {
      try {
        const report = await runSourceReconcile({}, { alert: false });
        if (report.skipped) {
          return { content: [{ type: 'text', text: `Error: ${report.reason}` }] };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ran_at: report.ran_at,
              lp_catalog_size: report.catalog_count,
              mapping_rows: report.mapping_count,
              counts: {
                unmapped: report.unmapped.length,
                orphaned: report.orphaned.length,
                dormant: report.dormant.length,
                suspected_non_source: (report.suspected_non_source || []).length,
              },
              // In LP's catalog, no lp_source_mapping row. These leads route to
              // entry:other today. This is the number that replaces the old 552.
              unmapped: report.unmapped.slice(0, limit),
              // Mapped, but LP no longer publishes the source. Report-only.
              orphaned: report.orphaned.slice(0, limit),
              // Mapped and live in LP, but zero leads in 90 days.
              dormant: include_dormant ? report.dormant.slice(0, limit) : [],
              // Flagged by migration 083 as not lead sources at all — market
              // codes and placeholders sitting in lp_source_mapping pointed at
              // entry:other. A subset of `orphaned`, broken out because the
              // remedy is different. NOTHING was deleted and no bucket or tag
              // was changed; deletion is a separate ruling.
              suspected_non_source: (report.suspected_non_source || []).slice(0, limit),
              suspected_non_source_note: 'Flagged, not removed. mapping_status=suspected_non_source is a label only — these rows still map exactly as they did before.',
              alerting: `lp.source_mapping_gap fires at most once per source per ISO week, and only above ${report.threshold_30d} leads in 30 days — or ${report.threshold_30d_events} for event-class sources (lp_source_raw matching "Events …" or containing "Show"), which are too low-volume to ever clear the standard floor. Orphaned and dormant never alert.`,
              action: 'Classify unmapped sources in lp_source_mapping by hand — bucket and entry tag are a human decision.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // Tool 13: get_source_distribution (Priority Query #1)
  server.tool(
    'get_source_distribution',
    'Top lead sources by volume with sourcesubdescr and source shown separately. FIRST QUERY TO RUN on connection.',
    {
      limit: z.number().optional().describe('Number of sources to return (default 50)'),
      show_unmapped_only: z.boolean().optional().describe('Only show sources without a GHL bucket mapping (default false)'),
    },
    async ({ limit = 50, show_unmapped_only = false }) => {
      const { data, error } = await supabase.rpc('get_source_distribution', {
        p_limit: limit,
        p_unmapped_only: show_unmapped_only,
      });

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      const unmappedCount = (data || []).filter(d => d.needs_mapping).length;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total_sources: data.length,
            unmapped_count: unmappedCount,
            sources: data,
            note: 'Top 50 by volume must be manually classified before sync goes live. Sources without a mapping default to "other".',
          }, null, 2),
        }],
      };
    }
  );

  // Tool 14: get_time_to_demo_by_source (Priority Query #2)
  server.tool(
    'get_time_to_demo_by_source',
    'Average days from lead creation to demo by source. Calibrates GHL indoctrination sequence timing.',
    {},
    async () => {
      const { data, error } = await supabase.rpc('get_time_to_demo_by_source');

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sources: data,
            insight: 'Faster-converting sources need shorter sequences. Slower sources need more touchpoints. Check for bimodal distributions.',
          }, null, 2),
        }],
      };
    }
  );

  // Tool 15: get_day15_disposition_breakdown (Priority Query #3)
  server.tool(
    'get_day15_disposition_breakdown',
    'Disposition distribution for Day 15+ leads. Drives W11.1 reactivation strategy.',
    {
      days_inactive_min: z.number().optional().describe('Minimum days since lead creation (default 15)'),
    },
    async ({ days_inactive_min = 15 }) => {
      const { data, error } = await supabase.rpc('get_day15_disposition_breakdown', {
        p_days_inactive_min: days_inactive_min,
      });

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      // Overlay correct labels from lp_dispositions table
      const dispMap = await getDispositionMap();
      const breakdown = (data || []).map(d => {
        const disp = dispMap[d.disposition_code];
        return {
          ...d,
          disposition_label: disp?.label || d.disposition_label || d.disposition_code || 'Unknown',
          category: disp?.category || 'unknown',
          is_recoverable: disp?.is_recoverable ?? true,
        };
      });

      const totalLeads = breakdown.reduce((sum, d) => sum + parseInt(d.lead_count), 0);
      const noDisp = breakdown.find(d => d.disposition_code === 'NO_DISPOSITION');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            days_threshold: days_inactive_min,
            total_abandoned_leads: totalLeads,
            no_disposition_count: noDisp ? parseInt(noDisp.lead_count) : 0,
            no_disposition_pct: noDisp ? noDisp.pct_of_total : 0,
            breakdown,
            insight: 'Leads with no disposition have the highest reactivation potential. Leads with demo set but not completed are warm re-engagements.',
          }, null, 2),
        }],
      };
    }
  );

  // Tool 16: get_close_rate_by_source (Priority Query #4)
  server.tool(
    'get_close_rate_by_source',
    'Close rate by source and intent bucket. Calibrates content pitch intensity per W3.x track.',
    {},
    async () => {
      const { data, error } = await supabase.rpc('get_close_rate_by_source');

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sources: data,
            insight: 'High close-rate sources need less persuasion. Low close-rate sources need stronger belief-shift content. Check demo-to-close vs lead-to-demo rates separately.',
          }, null, 2),
        }],
      };
    }
  );
}
