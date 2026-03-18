import supabase from '../supabase.js';
import { getCircuitStatus } from '../lp-client.js';

export function registerSyncTools(server) {

  // Tool 9: get_sync_health
  server.tool(
    'get_sync_health',
    'Last sync time, error rate, unmapped source count, circuit breaker status. Ops monitoring.',
    {},
    async () => {
      // Last sync
      const { data: lastSync } = await supabase
        .from('lp_sync_log')
        .select('*')
        .order('completed_at', { ascending: false })
        .limit(1)
        .single();

      // Recent sync errors (last 24h)
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      const { data: recentSyncs } = await supabase
        .from('lp_sync_log')
        .select('records_processed, records_failed, error_details')
        .gte('started_at', oneDayAgo);

      const totalProcessed = (recentSyncs || []).reduce((s, r) => s + (r.records_processed || 0), 0);
      const totalFailed = (recentSyncs || []).reduce((s, r) => s + (r.records_failed || 0), 0);

      // Unmapped sources count
      const { count: unmappedCount } = await supabase
        .from('lp_unmapped_sources')
        .select('*', { count: 'exact', head: true })
        .eq('reviewed', false);

      // Unfired milestones (act_date set but tag not fired)
      const { count: unfiredMilestones } = await supabase
        .from('lp_job_milestones')
        .select('*', { count: 'exact', head: true })
        .not('act_date', 'is', null)
        .eq('ghl_tag_fired', false);

      // Day 15 leads not triggered
      const { count: day15Untriggered } = await supabase
        .from('lp_leads')
        .select('*', { count: 'exact', head: true })
        .eq('closed_won', false)
        .eq('lp_day15_triggered', false)
        .lte('created_at_lp', new Date(Date.now() - 15 * 86400000).toISOString());

      // Circuit breaker
      const circuit = getCircuitStatus();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            last_sync: lastSync || null,
            last_24h: {
              syncs_run: recentSyncs?.length || 0,
              records_processed: totalProcessed,
              records_failed: totalFailed,
              error_rate: totalProcessed > 0
                ? `${((totalFailed / totalProcessed) * 100).toFixed(1)}%`
                : 'N/A',
            },
            unmapped_sources: unmappedCount || 0,
            unfired_milestone_triggers: unfiredMilestones || 0,
            day15_untriggered_leads: day15Untriggered || 0,
            circuit_breaker: circuit,
          }, null, 2),
        }],
      };
    }
  );
}
