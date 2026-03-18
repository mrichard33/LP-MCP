import supabase from '../supabase.js';
import { getCircuitStatus } from '../lp-client.js';

export function registerSyncTools(server) {

  // Tool 9: get_sync_health
  server.tool(
    'get_sync_health',
    'Last sync time, error rate, unmapped source count, circuit breaker status. Ops monitoring.',
    {},
    async () => {
      // Last completed sync per entity (most recent)
      const { data: lastSyncs } = await supabase
        .from('lp_sync_log')
        .select('*')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(20);

      // Deduplicate to one per entity_type
      const lastByEntity = {};
      for (const row of (lastSyncs || [])) {
        if (!lastByEntity[row.entity_type]) {
          lastByEntity[row.entity_type] = row;
        }
      }

      // Currently running syncs
      const { data: running } = await supabase
        .from('lp_sync_log')
        .select('entity_type, sync_type, records_synced, started_at')
        .eq('status', 'running');

      // Recent sync totals (last 24h)
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      const { data: recentSyncs } = await supabase
        .from('lp_sync_log')
        .select('entity_type, records_synced, status')
        .gte('started_at', oneDayAgo);

      const totalSynced = (recentSyncs || []).reduce((s, r) => s + (r.records_synced || 0), 0);
      const totalFailed = (recentSyncs || []).filter(r => r.status === 'failed').length;

      // Unmapped sources count
      const { count: unmappedCount } = await supabase
        .from('lp_unmapped_sources')
        .select('*', { count: 'exact', head: true })
        .eq('reviewed', false);

      // Unfired milestones
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
            last_sync_by_entity: lastByEntity,
            currently_running: running || [],
            last_24h: {
              syncs_run: recentSyncs?.length || 0,
              records_synced: totalSynced,
              failed_syncs: totalFailed,
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
