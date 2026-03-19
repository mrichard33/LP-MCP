import { z } from 'zod';
import supabase from '../supabase.js';

export function registerSourceTools(server) {

  // Tool 12: get_leads_needing_mapping
  server.tool(
    'get_leads_needing_mapping',
    'sourcesubdescr/source values not yet in the mapping table. Data maintenance.',
    {
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async ({ limit = 50 }) => {
      const { data, error } = await supabase
        .from('lp_unmapped_sources')
        .select('*')
        .eq('reviewed', false)
        .order('lead_count', { ascending: false })
        .limit(limit);

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total_unmapped: data.length,
            sources: data,
            action: 'Map each source to a GHL intent bucket in lp_source_mapping table',
          }, null, 2),
        }],
      };
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

      const totalLeads = (data || []).reduce((sum, d) => sum + parseInt(d.lead_count), 0);
      const noDisp = data?.find(d => d.disposition_code === 'NO_DISPOSITION');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            days_threshold: days_inactive_min,
            total_abandoned_leads: totalLeads,
            no_disposition_count: noDisp ? parseInt(noDisp.lead_count) : 0,
            no_disposition_pct: noDisp ? noDisp.pct_of_total : 0,
            breakdown: data,
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
