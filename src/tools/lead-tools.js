import { z } from 'zod';
import supabase from '../supabase.js';

// Tool 1: get_lead_summary
export function registerLeadTools(server) {

  server.tool(
    'get_lead_summary',
    'Full LP record + calls + notes + activities for one lead. Use for rep briefing before calls.',
    {
      lead_id: z.string().optional().describe('LP lead ID'),
      search: z.string().optional().describe('Search by name, phone, or email instead of ID'),
    },
    async ({ lead_id, search }) => {
      let lead;

      if (lead_id) {
        const { data } = await supabase
          .from('lp_leads')
          .select('*')
          .eq('lp_lead_id', lead_id)
          .single();
        lead = data;
      } else if (search) {
        const { data } = await supabase
          .from('lp_leads')
          .select('*')
          .or(`phone.eq.${search},email.ilike.${search},first_name.ilike.%${search}%,last_name.ilike.%${search}%`)
          .limit(1)
          .single();
        lead = data;
      }

      if (!lead) {
        return { content: [{ type: 'text', text: 'Lead not found.' }] };
      }

      // Fetch related data in parallel
      const [calls, notes, activities, jobs] = await Promise.all([
        supabase.from('lp_call_logs').select('*').eq('lp_lead_id', lead.lp_lead_id).order('call_date', { ascending: false }),
        supabase.from('lp_notes').select('*').eq('lp_lead_id', lead.lp_lead_id).order('created_at_lp', { ascending: false }),
        supabase.from('lp_activities').select('*').eq('lp_lead_id', lead.lp_lead_id).order('activity_date', { ascending: false }),
        supabase.from('lp_jobs').select('*').eq('lp_lead_id', lead.lp_lead_id),
      ]);

      // Fetch milestones for any jobs
      let milestones = [];
      if (jobs.data?.length) {
        const jobIds = jobs.data.map(j => j.lp_job_id);
        const { data: ms } = await supabase
          .from('lp_job_milestones')
          .select('*')
          .in('lp_job_id', jobIds)
          .order('entered_on', { ascending: true });
        milestones = ms || [];
      }

      const summary = {
        lead,
        call_history: calls.data || [],
        notes: notes.data || [],
        activities: activities.data || [],
        jobs: jobs.data || [],
        milestones,
        stats: {
          total_calls: calls.data?.length || 0,
          total_notes: notes.data?.length || 0,
          total_activities: activities.data?.length || 0,
          total_jobs: jobs.data?.length || 0,
          milestones_completed: milestones.filter(m => m.act_date).length,
        },
      };

      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // Tool 2: get_abandoned_leads
  server.tool(
    'get_abandoned_leads',
    'Leads with no LP activity after N days. Core targeting for W11.0/W11.1 reactivation.',
    {
      days_inactive: z.number().optional().describe('Minimum days since last contact (default 15)'),
      limit: z.number().optional().describe('Max results (default 100)'),
      disposition_filter: z.string().optional().describe('Filter by disposition code'),
      source_filter: z.string().optional().describe('Filter by intent bucket'),
    },
    async ({ days_inactive = 15, limit = 100, disposition_filter, source_filter }) => {
      let query = supabase
        .from('lp_leads')
        .select('lp_lead_id, first_name, last_name, phone, email, lead_source, lead_source_detail, ghl_intent_bucket, disposition_code, disposition_label, rep_name, call_count, last_contact_date, created_at_lp, job_value, demo_completed, appointment_set, lp_day15_triggered')
        .eq('closed_won', false)
        .lte('created_at_lp', new Date(Date.now() - days_inactive * 86400000).toISOString())
        .order('created_at_lp', { ascending: false })
        .limit(limit);

      if (disposition_filter) {
        query = query.eq('disposition_code', disposition_filter);
      }
      if (source_filter) {
        query = query.eq('ghl_intent_bucket', source_filter);
      }

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: data.length,
            days_inactive_threshold: days_inactive,
            leads: data,
          }, null, 2),
        }],
      };
    }
  );

  // Tool 3: get_leads_by_disposition
  server.tool(
    'get_leads_by_disposition',
    'All leads matching a disposition code. Use for segment analysis.',
    {
      disposition_code: z.string().describe('LP disposition code to filter by'),
      limit: z.number().optional().describe('Max results (default 100)'),
    },
    async ({ disposition_code, limit = 100 }) => {
      const { data, error } = await supabase
        .from('lp_leads')
        .select('lp_lead_id, first_name, last_name, phone, email, lead_source_detail, ghl_intent_bucket, disposition_code, disposition_label, rep_name, call_count, last_contact_date, created_at_lp, job_value, closed_won')
        .eq('disposition_code', disposition_code)
        .order('created_at_lp', { ascending: false })
        .limit(limit);

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ disposition_code, total: data.length, leads: data }, null, 2),
        }],
      };
    }
  );

  // Tool 6: search_leads
  server.tool(
    'search_leads',
    'Full-text search across LP records by name, phone, email, or address.',
    {
      query: z.string().describe('Search term'),
      limit: z.number().optional().describe('Max results (default 25)'),
    },
    async ({ query, limit = 25 }) => {
      const searchTerm = `%${query}%`;
      const { data, error } = await supabase
        .from('lp_leads')
        .select('lp_lead_id, first_name, last_name, phone, email, address, city, state, zip, lead_source_detail, ghl_intent_bucket, disposition_code, disposition_label, rep_name, created_at_lp, closed_won, job_value')
        .or(`first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},email.ilike.${searchTerm},phone.ilike.${searchTerm},address.ilike.${searchTerm}`)
        .order('created_at_lp', { ascending: false })
        .limit(limit);

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ search_term: query, total: data.length, results: data }, null, 2),
        }],
      };
    }
  );

  // Tool 8: get_call_history
  server.tool(
    'get_call_history',
    'All call logs for a lead. Use for contact intelligence before outreach.',
    {
      lead_id: z.string().describe('LP lead ID'),
    },
    async ({ lead_id }) => {
      const { data, error } = await supabase
        .from('lp_call_logs')
        .select('*')
        .eq('lp_lead_id', lead_id)
        .order('call_date', { ascending: false });

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ lead_id, total_calls: data.length, calls: data }, null, 2),
        }],
      };
    }
  );
}
