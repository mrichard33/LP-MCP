import supabase from '../supabase.js';
import { getCircuitStatus } from '../lp-client.js';
import { incrementalSync } from '../sync-engine.js';
import { getIdentityHealth } from '../identity-health.js';

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

      // WO-6 (A2.3): three terminal counts, reported separately.
      //
      // `failed_syncs` used to count every row with status='failed', and the
      // SIGTERM handler wrote container kills into that status. Over the 48h
      // to 2026-09-04 that made 192 of 198 "failures" infrastructure events
      // — a 23% failure rate that was really a deploy count. The key is kept
      // for backward compatibility with dashboards and saved queries, but it
      // now counts ONLY real record-level failures. Alert on `failed`.
      // `interrupted` is informational: a spike there means deploy or restart
      // churn, never a data defect.
      const totalCompleted   = (recentSyncs || []).filter(r => r.status === 'completed').length;
      const totalFailed      = (recentSyncs || []).filter(r => r.status === 'failed').length;
      const totalInterrupted = (recentSyncs || []).filter(r => r.status === 'interrupted').length;

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
              completed: totalCompleted,
              failed: totalFailed,
              interrupted: totalInterrupted,
              // Back-compat key. Same number as `failed` — real record-level
              // failures only, no container kills.
              failed_syncs: totalFailed,
            },
            sync_status_note: 'failed = real record-level failures, or a sweep that died outright (its entities are marked failed even when the other sweep succeeded — a half-dead run must not read as completed). interrupted = the container was killed mid-sweep (Railway deploy/restart) — infrastructure, not a data defect. Alert on failed; read interrupted as deploy churn.',
            // Same job as sync_status_note, for the paging columns: say what an
            // empty value means, so a reader does not have to guess whether a
            // blank is a fact about the entity or a gap in the instrumentation.
            paging_mode_note: "normal | deep = the paging branch the sweep actually took. n/a = this entity does not page — milestones arrive embedded in the job payloads the jobs sweep already paged for, so sweep_api_calls and rows_scanned are NULL beside it because there is no independent measurement to report. NULL paging_mode means uninstrumented (full syncs write no telemetry at all), not inapplicable.",
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

  // Tool: get_identity_health (2026-09-24) — people, not rows. Read-only.
  // Beside get_sync_health because it answers the same kind of question: is
  // the data we report on trustworthy? get_sync_health asks whether the copy
  // is current; this asks whether its rows are the people they claim to be.
  // Reads the sql/125 views; src/identity-health.js has the why.
  server.tool(
    'get_identity_health',
    'LP↔GHL identity health (read-only, no arguments). Returns: lp_to_ghl_link_pct by lead age (last_30d / d31_90 / d91_365, windowed on created_at_lp); outcomes_linked_90d as [linked, total] for sets and closed_won; people_vs_rows (distinct GHL contacts vs linked LP rows, overcount_pct = share of rows that repeat a person already counted); link_mismatches (GHL ids whose LP rows disagree on phone or last name — suspected bad links, see v_identity_link_mismatches); five9_events_with_lp_key_pct_30d; unmatched_callers_30d_by_campaign (Five9 callers matching no LP phone, from v_unmatched_inbound_callers_30d); appt_set_without_lp_record_30d; leads_missing_source_90d. A percentage is null when its window is empty. A failed read errors rather than reporting zeros.',
    {},
    async () => {
      const report = await getIdentityHealth();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(report, null, 2),
        }],
      };
    }
  );
}
