import { z } from 'zod';
import supabase from '../supabase.js';
import { MDT_TAG_MAP, MDT_LABELS } from '../milestones.js';

export function registerJobTools(server) {

  // Tool 7: get_job_status
  server.tool(
    'get_job_status',
    'Full job + milestone status for a contact. Post-sale project tracking.',
    {
      lead_id: z.string().optional().describe('LP lead ID'),
      job_id: z.string().optional().describe('LP job ID (optional — if omitted, returns all jobs for the lead)'),
    },
    async ({ lead_id, job_id }) => {
      let jobQuery = supabase.from('lp_jobs').select('*');

      if (job_id) {
        jobQuery = jobQuery.eq('lp_job_id', job_id);
      } else if (lead_id) {
        jobQuery = jobQuery.eq('lp_lead_id', lead_id);
      } else {
        return { content: [{ type: 'text', text: 'Provide either lead_id or job_id.' }] };
      }

      const { data: jobs, error } = await jobQuery;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      if (!jobs?.length) return { content: [{ type: 'text', text: 'No jobs found.' }] };

      // Fetch milestones for all matched jobs
      const jobIds = jobs.map(j => j.lp_job_id);
      const { data: milestones } = await supabase
        .from('lp_job_milestones')
        .select('*')
        .in('lp_job_id', jobIds)
        .order('entered_on', { ascending: true });

      // Enrich milestones with human-readable labels and GHL tag info
      const enrichedMilestones = (milestones || []).map(m => ({
        ...m,
        label: MDT_LABELS[m.mdt_id] || m.datetype || m.mdt_id,
        ghl_tag: MDT_TAG_MAP[m.mdt_id] || null,
        status: m.act_date ? 'completed' : (m.est_date ? 'scheduled' : 'pending'),
      }));

      // Group milestones by job
      const milestonesByJob = {};
      for (const m of enrichedMilestones) {
        if (!milestonesByJob[m.lp_job_id]) milestonesByJob[m.lp_job_id] = [];
        milestonesByJob[m.lp_job_id].push(m);
      }

      const result = jobs.map(job => ({
        ...job,
        milestones: milestonesByJob[job.lp_job_id] || [],
        milestone_summary: {
          total: (milestonesByJob[job.lp_job_id] || []).length,
          completed: (milestonesByJob[job.lp_job_id] || []).filter(m => m.status === 'completed').length,
          scheduled: (milestonesByJob[job.lp_job_id] || []).filter(m => m.status === 'scheduled').length,
          pending: (milestonesByJob[job.lp_job_id] || []).filter(m => m.status === 'pending').length,
        },
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ jobs: result }, null, 2),
        }],
      };
    }
  );
}
