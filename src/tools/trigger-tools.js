import { z } from 'zod';
import supabase from '../supabase.js';
import { applyGHLTag } from '../ghl.js';

export function registerTriggerTools(server) {

  // Tool 10: trigger_day15_handoff
  server.tool(
    'trigger_day15_handoff',
    'Manually fire Day 15 GHL handoff for a specific lead. Applies lp-day15-handoff tag.',
    {
      lead_id: z.string().describe('LP lead ID to trigger handoff for'),
    },
    async ({ lead_id }) => {
      // Fetch lead
      const { data: lead, error } = await supabase
        .from('lp_leads')
        .select('lp_lead_id, ghl_contact_id, lp_day15_triggered, closed_won, first_name, last_name')
        .eq('lp_lead_id', lead_id)
        .single();

      if (error || !lead) {
        return { content: [{ type: 'text', text: `Lead ${lead_id} not found.` }] };
      }

      if (lead.closed_won) {
        return { content: [{ type: 'text', text: `Lead ${lead_id} is already closed/won. Handoff not applicable.` }] };
      }

      if (lead.lp_day15_triggered) {
        return { content: [{ type: 'text', text: `Lead ${lead_id} already had Day 15 handoff triggered. Skipping duplicate.` }] };
      }

      if (!lead.ghl_contact_id) {
        return { content: [{ type: 'text', text: `Lead ${lead_id} has no matched GHL contact. Cannot apply tag.` }] };
      }

      // Apply the tag
      const success = await applyGHLTag(lead.ghl_contact_id, 'lp-day15-handoff');

      if (success) {
        // Mark as triggered
        await supabase.from('lp_leads')
          .update({ lp_day15_triggered: true })
          .eq('lp_lead_id', lead_id);

        // Log
        await supabase.from('lp_trigger_log').insert({
          lp_lead_id: lead_id,
          ghl_contact_id: lead.ghl_contact_id,
          event: 'day15_handoff_manual',
          tag_fired: 'lp-day15-handoff',
          status: 'success',
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              lead_id,
              name: `${lead.first_name} ${lead.last_name}`,
              ghl_contact_id: lead.ghl_contact_id,
              tag_applied: 'lp-day15-handoff',
              message: 'Day 15 handoff triggered. Lead will be enrolled in W11.0.',
            }, null, 2),
          }],
        };
      } else {
        // Log failure
        await supabase.from('lp_trigger_log').insert({
          lp_lead_id: lead_id,
          ghl_contact_id: lead.ghl_contact_id,
          event: 'day15_handoff_manual',
          tag_fired: 'lp-day15-handoff',
          status: 'failed',
          error_detail: 'GHL tag application failed',
        });

        return {
          content: [{
            type: 'text',
            text: `Failed to apply Day 15 handoff tag for lead ${lead_id}. Check GHL API key and contact ID.`,
          }],
        };
      }
    }
  );
}
