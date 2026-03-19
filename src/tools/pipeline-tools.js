import { z } from 'zod';
import supabase from '../supabase.js';

export function registerPipelineTools(server) {

  // Tool 4: get_rep_performance
  server.tool(
    'get_rep_performance',
    'Call/set/close rates by rep for a date range. Sales analytics.',
    {
      start_date: z.string().describe('Start date (ISO 8601)'),
      end_date: z.string().describe('End date (ISO 8601)'),
    },
    async ({ start_date, end_date }) => {
      const { data, error } = await supabase.rpc('get_rep_performance', {
        p_start_date: start_date,
        p_end_date: end_date,
      });

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            date_range: { start: start_date, end: end_date },
            reps: data,
          }, null, 2),
        }],
      };
    }
  );

  // Tool 5: get_pipeline_summary
  server.tool(
    'get_pipeline_summary',
    'Count and value at each disposition stage. Dashboard overview.',
    {},
    async () => {
      const { data, error } = await supabase.rpc('get_pipeline_summary');

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      const totalLeads = data.reduce((sum, d) => sum + parseInt(d.lead_count), 0);
      const totalValue = data.reduce((sum, d) => sum + parseFloat(d.total_value || 0), 0);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total_leads: totalLeads,
            total_pipeline_value: totalValue,
            stages: data,
          }, null, 2),
        }],
      };
    }
  );

  // Tool 11: get_revenue_by_source
  server.tool(
    'get_revenue_by_source',
    'Revenue and close rate by source and intent bucket. Marketing ROI analysis.',
    {
      min_leads: z.number().optional().describe('Minimum lead count to include (default 5)'),
    },
    async ({ min_leads = 5 }) => {
      const { data, error } = await supabase.rpc('get_close_rate_by_source');

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      const filtered = (data || []).filter(d => parseInt(d.total_leads) >= min_leads);

      // Aggregate by bucket
      const bucketSummary = {};
      for (const row of filtered) {
        const bucket = row.ghl_bucket || 'unmapped';
        if (!bucketSummary[bucket]) {
          bucketSummary[bucket] = { total_leads: 0, closed_won: 0, total_revenue: 0 };
        }
        bucketSummary[bucket].total_leads += parseInt(row.total_leads);
        bucketSummary[bucket].closed_won += parseInt(row.closed_won_count);
        bucketSummary[bucket].total_revenue += parseFloat(row.total_revenue || 0);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            by_source: filtered,
            by_bucket: bucketSummary,
          }, null, 2),
        }],
      };
    }
  );
}
