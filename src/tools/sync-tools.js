import supabase from '../supabase.js';
import { getCircuitStatus } from '../lp-client.js';
import { incrementalSync } from '../sync-engine.js';

export function registerSyncTools(server) {

  // Tool: sync_all_entities — on-demand sync trigger (parity with HL MCP).
  // Kicks off an incremental sync in the background and returns immediately.
  // The dashboard "Sync now" button calls this; an inline await would risk the
  // client's 10s timeout, so we fire-and-forget. incrementalSync() self-guards
  // against concurrent runs (returns early when one is already in progress) and
  // falls back to a full sync when no prior sync exists.
  server.tool(
    'sync_all_entities',
    'Trigger an on-demand sync of LP leads/jobs/milestones into Supabase. Runs in the background; poll get_sync_health for progress. Use after a change in LP that should reflect in the dashboard.',
    {},
    async () => {
      let started = true;
      try {
        // Fire-and-forget: do not await. Surface async failures in server logs.
        Promise.resolve()
          .then(() => incrementalSync())
          .catch((err) => console.error('[sync_all_entities] background sync failed:', err));
      } catch (err) {
        started = false;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: false, status: 'failed', error: err.message }),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            status: 'started',
            message: 'Incremental sync started. Poll get_sync_health for progress.',
          }),
        }],
      };
    }
  );

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

      // Unmapped sources count — the raw review queue. Cheap and DB-only, so
      // it stays here; the authoritative gap (LP's catalog diffed against
      // lp_source_mapping) needs an LP API call and lives in
      // get_source_catalog_health instead. After the 2026-09-04 queue repair
      // this should read in single digits; hundreds means the repair did not
      // apply. Note it counts rows with no source at all (source_subdetail and
      // source_raw both NULL), which are not mapping work.
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
            unmapped_sources_note: 'Raw review-queue rows. For the real gap against LP\'s source catalog, run get_source_catalog_health.',
            unfired_milestone_triggers: unfiredMilestones || 0,
            day15_untriggered_leads: day15Untriggered || 0,
            circuit_breaker: circuit,
          }, null, 2),
        }],
      };
    }
  );
}
